import {
    StartWeixinRegistrationBody,
    WeixinRegistrationSummary,
    createObjectId
} from '@manyfold/shared'
import {
    BadGatewayException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { and, count, eq, gt, inArray, isNull, lt } from 'drizzle-orm'
import {
    agents,
    weixinRegistrations,
    type Database,
    type NewWeixinRegistrationRow,
    type WeixinRegistrationRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ChannelsService } from './channels.service'
import {
    WEIXIN_DEFAULT_BASE_URL,
    weixinFetchQrCode,
    weixinPollQrStatus,
    type WeixinQrStatusResponse
} from './providers/weixin-ilink'

const MAX_PENDING_PER_USER = 3
const MAX_QR_REFRESH = 3
const REGISTRATION_TTL_MS = 8 * 60_000
const POLL_INTERVAL_MS = 1_500
const CREATING_TIMEOUT_MS = 60_000
const CREATING_HEARTBEAT_MS = 15_000
const CLEANUP_INTERVAL_MS = 60_000
const CLEANUP_RETENTION_MS = 60 * 60_000

export interface WeixinRegistrationOwner {
    userId: string
    boundAgentId?: string
}

@Injectable()
export class WeixinRegistrationService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(WeixinRegistrationService.name)
    private cleanupTimer: NodeJS.Timeout | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly channels: ChannelsService
    ) {}

    onModuleInit(): void {
        this.cleanupTimer = setInterval(() => {
            void this.maintenanceTick()
        }, CLEANUP_INTERVAL_MS)
        this.cleanupTimer.unref?.()
        void this.maintenanceTick()
    }

    onModuleDestroy(): void {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    }

    async start(
        userId: string,
        body: StartWeixinRegistrationBody
    ): Promise<WeixinRegistrationSummary> {
        await this.assertAgentOwned(userId, body.agentId)
        await this.runtimeAccess.reserveChannelSlot(userId)
        const now = new Date()
        const [pending] = await this.db
            .select({ value: count() })
            .from(weixinRegistrations)
            .where(
                and(
                    eq(weixinRegistrations.userId, userId),
                    eq(weixinRegistrations.status, 'pending'),
                    gt(weixinRegistrations.expiresAt, now)
                )
            )
        if (Number(pending?.value ?? 0) >= MAX_PENDING_PER_USER)
            throw new ConflictException({
                code: 'too_many_pending_registrations',
                message: 'too many pending WeChat registrations'
            })

        let qrcode: string
        let qrcodeContent: string
        try {
            const qr = await weixinFetchQrCode(WEIXIN_DEFAULT_BASE_URL)
            if (!qr.qrcode || !qr.qrcode_img_content)
                throw new Error('gateway returned no QR code')
            qrcode = qr.qrcode
            qrcodeContent = qr.qrcode_img_content
        } catch (err) {
            this.log.warn(
                `WeChat registration start failed: ${(err as Error).message}`
            )
            throw new BadGatewayException({
                code: 'weixin_registration_unavailable',
                message: 'WeChat registration is temporarily unavailable'
            })
        }

        const encrypted = this.crypto.encrypt(qrcode)
        const [row] = await this.db
            .insert(weixinRegistrations)
            .values({
                id: createObjectId('weixinRegistration'),
                userId,
                agentId: body.agentId,
                label: body.label.trim(),
                qrcodeCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion,
                qrcodeContent,
                pollBaseUrl: WEIXIN_DEFAULT_BASE_URL,
                expiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS),
                createdAt: now,
                updatedAt: now
            })
            .returning()
        return this.toSummary(row)
    }

    async getAndAdvance(
        owner: WeixinRegistrationOwner,
        id: string
    ): Promise<WeixinRegistrationSummary> {
        let row = await this.loadOwned(owner, id)
        const now = new Date()

        if (row.status === 'creating') {
            if (row.updatedAt.getTime() > now.getTime() - CREATING_TIMEOUT_MS)
                return this.toSummary(row)
            return this.transition(owner, row.id, ['creating'], {
                status: 'failed',
                errorCode: 'channel_create_failed',
                errorMessage: 'channel creation timed out',
                updatedAt: now
            })
        }
        // need_verify_code parks the flow until the user submits the pairing
        // number; do not poll until then.
        if (row.status === 'need_verify_code') return this.toSummary(row)
        if (row.status !== 'pending') return this.toSummary(row)

        if (row.expiresAt <= now)
            return this.transition(owner, row.id, ['pending'], {
                status: 'expired',
                updatedAt: now
            })

        if (
            row.lastPolledAt &&
            row.lastPolledAt.getTime() + POLL_INTERVAL_MS > now.getTime()
        )
            return this.toSummary(row)

        const [locked] = await this.db
            .update(weixinRegistrations)
            .set({ lastPolledAt: now, updatedAt: now })
            .where(
                and(
                    eq(weixinRegistrations.id, row.id),
                    eq(weixinRegistrations.status, 'pending'),
                    row.lastPolledAt
                        ? eq(weixinRegistrations.lastPolledAt, row.lastPolledAt)
                        : isNull(weixinRegistrations.lastPolledAt)
                )
            )
            .returning()
        if (!locked) return this.reloadSummary(owner, id)
        row = locked

        const qrcode = this.crypto.decrypt({
            ciphertext: row.qrcodeCiphertext,
            keyVersion: row.keyVersion
        })
        const verifyCode =
            row.verifyCodeCiphertext && row.verifyKeyVersion != null
                ? this.crypto.decrypt({
                      ciphertext: row.verifyCodeCiphertext,
                      keyVersion: row.verifyKeyVersion
                  })
                : null

        let result: WeixinQrStatusResponse
        try {
            result = await weixinPollQrStatus(
                row.pollBaseUrl,
                qrcode,
                verifyCode
            )
        } catch (err) {
            this.log.warn(
                `WeChat registration poll failed id=${row.id}: ${(err as Error).message}`
            )
            return this.reloadSummary(owner, id)
        }
        return this.applyPollResult(owner, row, verifyCode != null, result)
    }

    async submitVerifyCode(
        owner: WeixinRegistrationOwner,
        id: string,
        code: string
    ): Promise<WeixinRegistrationSummary> {
        const row = await this.loadOwned(owner, id)
        if (row.status !== 'need_verify_code' && row.status !== 'pending')
            throw new ConflictException({
                code: 'verify_code_not_expected',
                message: 'this registration is not awaiting a pairing code'
            })
        const encrypted = this.crypto.encrypt(code.trim())
        // Flip back to pending so the next poll carries the code, and clear
        // lastPolledAt so it polls immediately.
        return this.transition(
            owner,
            row.id,
            ['need_verify_code', 'pending'],
            {
                status: 'pending',
                verifyCodeCiphertext: encrypted.ciphertext,
                verifyKeyVersion: encrypted.keyVersion,
                lastPolledAt: null,
                updatedAt: new Date()
            }
        )
    }

    async cancel(owner: WeixinRegistrationOwner, id: string): Promise<void> {
        const row = await this.loadOwned(owner, id)
        if (row.status !== 'pending' && row.status !== 'need_verify_code') return
        await this.db
            .update(weixinRegistrations)
            .set({ status: 'cancelled', updatedAt: new Date() })
            .where(
                and(
                    eq(weixinRegistrations.id, row.id),
                    inArray(weixinRegistrations.status, [
                        'pending',
                        'need_verify_code'
                    ])
                )
            )
    }

    async cleanupExpiredRegistrations(now: Date = new Date()): Promise<number> {
        const deleted = await this.db
            .delete(weixinRegistrations)
            .where(
                lt(
                    weixinRegistrations.expiresAt,
                    new Date(now.getTime() - CLEANUP_RETENTION_MS)
                )
            )
            .returning({ id: weixinRegistrations.id })
        return deleted.length
    }

    private async applyPollResult(
        owner: WeixinRegistrationOwner,
        row: WeixinRegistrationRow,
        hadVerifyCode: boolean,
        result: WeixinQrStatusResponse
    ): Promise<WeixinRegistrationSummary> {
        const clearVerify = hadVerifyCode
            ? { verifyCodeCiphertext: null, verifyKeyVersion: null }
            : {}
        switch (result.status) {
            case 'wait':
            case 'scaned':
                if (hadVerifyCode)
                    return this.transition(owner, row.id, ['pending'], {
                        ...clearVerify,
                        updatedAt: new Date()
                    })
                return this.toSummary(row)
            case 'scaned_but_redirect': {
                const patch: Partial<NewWeixinRegistrationRow> = {
                    ...clearVerify,
                    updatedAt: new Date()
                }
                if (result.redirect_host)
                    patch.pollBaseUrl = `https://${result.redirect_host}`
                return this.transition(owner, row.id, ['pending'], patch)
            }
            case 'need_verifycode':
                return this.transition(owner, row.id, ['pending'], {
                    status: 'need_verify_code',
                    ...clearVerify,
                    updatedAt: new Date()
                })
            case 'verify_code_blocked':
                return this.transition(owner, row.id, ['pending'], {
                    status: 'failed',
                    errorCode: 'access_denied',
                    errorMessage:
                        'too many incorrect pairing codes; start over',
                    ...clearVerify,
                    updatedAt: new Date()
                })
            case 'binded_redirect':
                return this.transition(owner, row.id, ['pending'], {
                    status: 'failed',
                    errorCode: 'already_bound',
                    errorMessage: 'this WeChat bot is already connected',
                    ...clearVerify,
                    updatedAt: new Date()
                })
            case 'expired':
                return this.refreshOrExpire(owner, row)
            case 'confirmed':
                return this.createChannel(owner, row, result)
            default:
                return this.toSummary(row)
        }
    }

    private async refreshOrExpire(
        owner: WeixinRegistrationOwner,
        row: WeixinRegistrationRow
    ): Promise<WeixinRegistrationSummary> {
        if (row.refreshCount >= MAX_QR_REFRESH)
            return this.transition(owner, row.id, ['pending'], {
                status: 'expired',
                updatedAt: new Date()
            })
        try {
            const qr = await weixinFetchQrCode(WEIXIN_DEFAULT_BASE_URL)
            if (!qr.qrcode || !qr.qrcode_img_content)
                throw new Error('gateway returned no QR code')
            const encrypted = this.crypto.encrypt(qr.qrcode)
            return this.transition(owner, row.id, ['pending'], {
                qrcodeCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion,
                qrcodeContent: qr.qrcode_img_content,
                pollBaseUrl: WEIXIN_DEFAULT_BASE_URL,
                refreshCount: row.refreshCount + 1,
                verifyCodeCiphertext: null,
                verifyKeyVersion: null,
                updatedAt: new Date()
            })
        } catch (err) {
            this.log.warn(
                `WeChat QR refresh failed id=${row.id}: ${(err as Error).message}`
            )
            return this.transition(owner, row.id, ['pending'], {
                status: 'failed',
                errorCode: 'upstream_error',
                errorMessage: 'failed to refresh the QR code',
                updatedAt: new Date()
            })
        }
    }

    private async createChannel(
        owner: WeixinRegistrationOwner,
        row: WeixinRegistrationRow,
        result: WeixinQrStatusResponse
    ): Promise<WeixinRegistrationSummary> {
        if (!result.bot_token || !result.ilink_bot_id)
            return this.transition(owner, row.id, ['pending'], {
                status: 'failed',
                errorCode: 'upstream_error',
                errorMessage: 'gateway confirmed without a bot token',
                updatedAt: new Date()
            })

        const [locked] = await this.db
            .update(weixinRegistrations)
            .set({ status: 'creating', updatedAt: new Date() })
            .where(
                and(
                    eq(weixinRegistrations.id, row.id),
                    eq(weixinRegistrations.status, 'pending')
                )
            )
            .returning()
        if (!locked) return this.reloadSummary(owner, row.id)

        const owns = result.ilink_user_id ? [result.ilink_user_id] : []
        const stopHeartbeat = this.startCreatingHeartbeat(row.id)
        try {
            const channel = await this.channels.create(
                row.userId,
                {
                    agentId: row.agentId,
                    provider: 'weixin',
                    label: row.label,
                    config: {
                        botId: result.ilink_bot_id,
                        allowedUserIds: owns,
                        operatorUserIds: owns,
                        progressMode: 'final',
                        outboundFiles: true,
                        contextProjection: true
                    },
                    credentials: {
                        botToken: result.bot_token,
                        baseUrl: result.baseurl ?? null
                    }
                },
                { externalId: result.ilink_bot_id }
            )
            return this.settleCreated(owner, row.id, channel.id)
        } catch (err) {
            const alreadyBound =
                err instanceof ConflictException &&
                (err.getResponse() as { code?: string } | null)?.code ===
                    'external_account_already_bound'
            return this.transition(owner, row.id, ['creating'], {
                status: 'failed',
                errorCode: alreadyBound ? 'already_bound' : 'channel_create_failed',
                errorMessage: alreadyBound
                    ? 'this WeChat bot is already connected to a channel'
                    : (err as Error).message,
                updatedAt: new Date()
            })
        } finally {
            stopHeartbeat()
        }
    }

    private async settleCreated(
        owner: WeixinRegistrationOwner,
        id: string,
        channelId: string
    ): Promise<WeixinRegistrationSummary> {
        const [succeeded] = await this.db
            .update(weixinRegistrations)
            .set({ status: 'succeeded', channelId, updatedAt: new Date() })
            .where(
                and(
                    eq(weixinRegistrations.id, id),
                    eq(weixinRegistrations.status, 'creating')
                )
            )
            .returning()
        return succeeded ? this.toSummary(succeeded) : this.reloadSummary(owner, id)
    }

    private startCreatingHeartbeat(id: string): () => void {
        let refreshing = false
        const timer = setInterval(() => {
            if (refreshing) return
            refreshing = true
            void this.refreshCreatingLease(id).finally(() => {
                refreshing = false
            })
        }, CREATING_HEARTBEAT_MS)
        timer.unref?.()
        return () => clearInterval(timer)
    }

    private async refreshCreatingLease(id: string): Promise<void> {
        try {
            await this.db
                .update(weixinRegistrations)
                .set({ updatedAt: new Date() })
                .where(
                    and(
                        eq(weixinRegistrations.id, id),
                        eq(weixinRegistrations.status, 'creating')
                    )
                )
        } catch (err) {
            this.log.warn(
                `WeChat registration heartbeat failed id=${id}: ${(err as Error).message}`
            )
        }
    }

    private async transition(
        owner: WeixinRegistrationOwner,
        id: string,
        fromStatuses: WeixinRegistrationRow['status'][],
        patch: Partial<NewWeixinRegistrationRow>
    ): Promise<WeixinRegistrationSummary> {
        const [updated] = await this.db
            .update(weixinRegistrations)
            .set(patch)
            .where(
                and(
                    eq(weixinRegistrations.id, id),
                    fromStatuses.length === 1
                        ? eq(weixinRegistrations.status, fromStatuses[0])
                        : inArray(weixinRegistrations.status, fromStatuses)
                )
            )
            .returning()
        return updated
            ? this.toSummary(updated)
            : this.reloadSummary(owner, id)
    }

    private async loadOwned(
        owner: WeixinRegistrationOwner,
        id: string
    ): Promise<WeixinRegistrationRow> {
        const [row] = await this.db
            .select()
            .from(weixinRegistrations)
            .where(
                and(
                    eq(weixinRegistrations.id, id),
                    eq(weixinRegistrations.userId, owner.userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('WeChat registration not found')
        if (owner.boundAgentId && row.agentId !== owner.boundAgentId)
            throw new ForbiddenException(
                'WeChat registration belongs to another agent'
            )
        return row
    }

    private async reloadSummary(
        owner: WeixinRegistrationOwner,
        id: string
    ): Promise<WeixinRegistrationSummary> {
        return this.toSummary(await this.loadOwned(owner, id))
    }

    private async assertAgentOwned(
        userId: string,
        agentId: string
    ): Promise<void> {
        const [row] = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        if (!row) throw new NotFoundException('agent not found')
    }

    private toSummary(row: WeixinRegistrationRow): WeixinRegistrationSummary {
        const showQr = row.status === 'pending' || row.status === 'need_verify_code'
        return {
            id: row.id,
            agentId: row.agentId,
            status: row.status,
            qrcodeContent: showQr ? row.qrcodeContent : null,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            channelId: row.channelId,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    private async maintenanceTick(): Promise<void> {
        try {
            const deleted = await this.cleanupExpiredRegistrations()
            if (deleted > 0)
                this.log.log(
                    `WeChat registration cleanup deleted ${deleted} session(s)`
                )
        } catch (err) {
            if ((err as { code?: string } | null)?.code === '42P01') {
                this.log.warn(
                    'WeChat registrations table is missing; skipping cleanup until migrations run'
                )
                return
            }
            this.log.warn(
                `WeChat registration cleanup failed: ${(err as Error).message}`
            )
        }
    }
}
