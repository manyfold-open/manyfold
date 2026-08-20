import {
    LarkAppRegistrationSummary,
    StartLarkRegistrationBody,
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
import { and, count, eq, gt, isNull, lt, lte } from 'drizzle-orm'
import {
    agents,
    larkAppRegistrations,
    type Database,
    type LarkAppRegistrationRow,
    type NewLarkAppRegistrationRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CliAuthRateLimitService } from '@/modules/auth/cli-auth-rate-limit.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ChannelsService } from './channels.service'
import {
    beginAppRegistration,
    buildQrUrl,
    initAppRegistration,
    pollAppRegistrationOnce,
    type LarkAppRegistrationPollResult
} from './providers/lark-app-registration'

const MAX_PENDING_PER_USER = 3
const CREATING_TIMEOUT_MS = 60_000
// Channel creation may legitimately spend the full configured websocket
// handshake timeout in progress. Keep the lease fresh so 60s means the owner
// disappeared, not merely that Lark was slow.
const CREATING_HEARTBEAT_MS = 15_000
const CLEANUP_INTERVAL_MS = 60_000
const CLEANUP_RETENTION_MS = 60 * 60_000

export interface LarkRegistrationOwner {
    userId: string
    boundAgentId?: string
}

@Injectable()
export class LarkRegistrationService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(LarkRegistrationService.name)
    private cleanupTimer: NodeJS.Timeout | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly channels: ChannelsService,
        private readonly rateLimit: CliAuthRateLimitService
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
        body: StartLarkRegistrationBody
    ): Promise<LarkAppRegistrationSummary> {
        await this.assertAgentOwned(userId, body.agentId)
        await this.runtimeAccess.reserveChannelSlot(userId)
        const now = new Date()
        const [pending] = await this.db
            .select({ value: count() })
            .from(larkAppRegistrations)
            .where(
                and(
                    eq(larkAppRegistrations.userId, userId),
                    eq(larkAppRegistrations.status, 'pending'),
                    gt(larkAppRegistrations.expiresAt, now)
                )
            )
        if (Number(pending?.value ?? 0) >= MAX_PENDING_PER_USER)
            throw new ConflictException({
                code: 'too_many_pending_registrations',
                message: 'too many pending Lark app registrations'
            })

        let registration: Awaited<ReturnType<typeof beginAppRegistration>>
        let qrUrl: string
        try {
            await initAppRegistration()
            registration = await beginAppRegistration()
            qrUrl = buildQrUrl(
                registration.verificationUriComplete,
                body.botName
            )
        } catch (err) {
            this.log.warn(
                `Lark app registration start failed: ${(err as Error).message}`
            )
            throw new BadGatewayException({
                code: 'lark_registration_unavailable',
                message: 'Lark app registration is temporarily unavailable'
            })
        }

        const encrypted = this.crypto.encrypt(registration.deviceCode)
        const [row] = await this.db
            .insert(larkAppRegistrations)
            .values({
                id: createObjectId('larkAppRegistration'),
                userId,
                agentId: body.agentId,
                label: body.label.trim(),
                botName: body.botName.trim(),
                appRegion: body.appRegion,
                pollRegion: 'feishu',
                deviceCodeCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion,
                qrUrl,
                userCode: registration.userCode,
                intervalSec: registration.intervalSec,
                expiresAt: new Date(
                    now.getTime() + registration.expireInSec * 1000
                ),
                createdAt: now,
                updatedAt: now
            })
            .returning()
        return this.toSummary(row)
    }

    async getAndAdvance(
        owner: LarkRegistrationOwner,
        id: string
    ): Promise<LarkAppRegistrationSummary> {
        let row = await this.loadOwned(owner, id)
        const now = new Date()
        if (row.status === 'creating') {
            if (row.updatedAt.getTime() > now.getTime() - CREATING_TIMEOUT_MS)
                return this.toSummary(row)
            const [failed] = await this.db
                .update(larkAppRegistrations)
                .set({
                    status: 'failed',
                    errorCode: 'channel_create_failed',
                    errorMessage: 'channel creation timed out',
                    updatedAt: now
                })
                .where(
                    and(
                        eq(larkAppRegistrations.id, row.id),
                        eq(larkAppRegistrations.status, 'creating'),
                        lte(
                            larkAppRegistrations.updatedAt,
                            new Date(now.getTime() - CREATING_TIMEOUT_MS)
                        )
                    )
                )
                .returning()
            return failed
                ? this.toSummary(failed)
                : this.reloadSummary(owner, id)
        }
        if (row.status !== 'pending') return this.toSummary(row)

        if (row.expiresAt <= now) {
            const [expired] = await this.db
                .update(larkAppRegistrations)
                .set({ status: 'expired', updatedAt: now })
                .where(
                    and(
                        eq(larkAppRegistrations.id, row.id),
                        eq(larkAppRegistrations.status, 'pending')
                    )
                )
                .returning()
            return expired
                ? this.toSummary(expired)
                : this.reloadSummary(owner, id)
        }

        if (
            row.lastPolledAt &&
            row.lastPolledAt.getTime() + row.intervalSec * 1000 > now.getTime()
        )
            return this.toSummary(row)

        const [locked] = await this.db
            .update(larkAppRegistrations)
            .set({ lastPolledAt: now, updatedAt: now })
            .where(
                and(
                    eq(larkAppRegistrations.id, row.id),
                    eq(larkAppRegistrations.status, 'pending'),
                    row.lastPolledAt
                        ? eq(
                              larkAppRegistrations.lastPolledAt,
                              row.lastPolledAt
                          )
                        : isNull(larkAppRegistrations.lastPolledAt)
                )
            )
            .returning()
        if (!locked) return this.reloadSummary(owner, id)
        row = locked

        const deviceCode = this.crypto.decrypt({
            ciphertext: row.deviceCodeCiphertext,
            keyVersion: row.keyVersion
        })
        try {
            const result = await pollAppRegistrationOnce(
                row.pollRegion,
                deviceCode
            )
            return await this.applyPollResult(owner, row, deviceCode, result)
        } catch (err) {
            this.log.warn(
                `Lark app registration poll failed id=${row.id}: ${(err as Error).message}`
            )
            return this.reloadSummary(owner, id)
        }
    }

    async cancel(owner: LarkRegistrationOwner, id: string): Promise<void> {
        const row = await this.loadOwned(owner, id)
        if (row.status !== 'pending') return
        await this.db
            .update(larkAppRegistrations)
            .set({ status: 'cancelled', updatedAt: new Date() })
            .where(
                and(
                    eq(larkAppRegistrations.id, row.id),
                    eq(larkAppRegistrations.status, 'pending')
                )
            )
    }

    async cleanupExpiredRegistrations(now: Date = new Date()): Promise<number> {
        const deleted = await this.db
            .delete(larkAppRegistrations)
            .where(
                lt(
                    larkAppRegistrations.expiresAt,
                    new Date(now.getTime() - CLEANUP_RETENTION_MS)
                )
            )
            .returning({ id: larkAppRegistrations.id })
        return deleted.length
    }

    private async applyPollResult(
        owner: LarkRegistrationOwner,
        row: LarkAppRegistrationRow,
        deviceCode: string,
        result: LarkAppRegistrationPollResult
    ): Promise<LarkAppRegistrationSummary> {
        switch (result.status) {
            case 'pending':
                return this.toSummary(row)
            case 'slow_down':
                return this.transitionPending(owner, row.id, {
                    intervalSec: row.intervalSec + 5,
                    updatedAt: new Date()
                })
            case 'switch_domain': {
                const [switched] = await this.db
                    .update(larkAppRegistrations)
                    .set({ pollRegion: 'lark', updatedAt: new Date() })
                    .where(
                        and(
                            eq(larkAppRegistrations.id, row.id),
                            eq(larkAppRegistrations.status, 'pending'),
                            eq(larkAppRegistrations.pollRegion, 'feishu')
                        )
                    )
                    .returning()
                if (!switched) return this.reloadSummary(owner, row.id)
                const retried = await pollAppRegistrationOnce(
                    'lark',
                    deviceCode
                )
                if (retried.status === 'switch_domain')
                    return this.transitionPending(owner, row.id, {
                        status: 'failed',
                        errorCode: 'upstream_error',
                        errorMessage: 'unexpected repeated domain switch',
                        updatedAt: new Date()
                    })
                return this.applyPollResult(
                    owner,
                    switched,
                    deviceCode,
                    retried
                )
            }
            case 'denied':
                return this.transitionPending(owner, row.id, {
                    status: 'failed',
                    errorCode: 'access_denied',
                    errorMessage: 'authorization was denied',
                    updatedAt: new Date()
                })
            case 'expired':
                return this.transitionPending(owner, row.id, {
                    status: 'expired',
                    updatedAt: new Date()
                })
            case 'error':
                return this.transitionPending(owner, row.id, {
                    status: 'failed',
                    errorCode: 'upstream_error',
                    errorMessage: result.message,
                    updatedAt: new Date()
                })
            case 'success':
                return this.createChannel(owner, row, result)
        }
    }

    private async createChannel(
        owner: LarkRegistrationOwner,
        row: LarkAppRegistrationRow,
        result: Extract<LarkAppRegistrationPollResult, { status: 'success' }>
    ): Promise<LarkAppRegistrationSummary> {
        const [locked] = await this.db
            .update(larkAppRegistrations)
            .set({ status: 'creating', updatedAt: new Date() })
            .where(
                and(
                    eq(larkAppRegistrations.id, row.id),
                    eq(larkAppRegistrations.status, 'pending')
                )
            )
            .returning()
        if (!locked) return this.reloadSummary(owner, row.id)

        const stopHeartbeat = this.startCreatingHeartbeat(row.id)
        try {
            const channel = await this.channels.create(row.userId, {
                agentId: row.agentId,
                provider: 'lark',
                label: row.label,
                config: {
                    appId: result.appId,
                    appRegion: result.tenantBrand ?? row.pollRegion,
                    subscriptionMode: 'websocket',
                    verificationToken: null,
                    encryptKey: null,
                    mentionOnly: true,
                    shareSessionInChannel: false,
                    threadIsolation: false,
                    progressMode: 'preview',
                    botName: row.botName,
                    allowedUserIds: [],
                    operatorUserIds: result.openId ? [result.openId] : []
                },
                credentials: { appSecret: result.appSecret }
            })
            const [succeeded] = await this.db
                .update(larkAppRegistrations)
                .set({
                    status: 'succeeded',
                    channelId: channel.id,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(larkAppRegistrations.id, row.id),
                        eq(larkAppRegistrations.status, 'creating')
                    )
                )
                .returning()
            return succeeded
                ? this.toSummary(succeeded)
                : this.reloadSummary(owner, row.id)
        } catch (err) {
            const [failed] = await this.db
                .update(larkAppRegistrations)
                .set({
                    status: 'failed',
                    errorCode: 'channel_create_failed',
                    errorMessage: (err as Error).message,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(larkAppRegistrations.id, row.id),
                        eq(larkAppRegistrations.status, 'creating')
                    )
                )
                .returning()
            return failed
                ? this.toSummary(failed)
                : this.reloadSummary(owner, row.id)
        } finally {
            stopHeartbeat()
        }
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
                .update(larkAppRegistrations)
                .set({ updatedAt: new Date() })
                .where(
                    and(
                        eq(larkAppRegistrations.id, id),
                        eq(larkAppRegistrations.status, 'creating')
                    )
                )
        } catch (err) {
            this.log.warn(
                `Lark registration heartbeat failed id=${id}: ${(err as Error).message}`
            )
        }
    }

    private async transitionPending(
        owner: LarkRegistrationOwner,
        id: string,
        patch: Partial<NewLarkAppRegistrationRow>
    ): Promise<LarkAppRegistrationSummary> {
        const [updated] = await this.db
            .update(larkAppRegistrations)
            .set(patch)
            .where(
                and(
                    eq(larkAppRegistrations.id, id),
                    eq(larkAppRegistrations.status, 'pending')
                )
            )
            .returning()
        return updated
            ? this.toSummary(updated)
            : this.reloadSummary(owner, id)
    }

    private async loadOwned(
        owner: LarkRegistrationOwner,
        id: string
    ): Promise<LarkAppRegistrationRow> {
        const [row] = await this.db
            .select()
            .from(larkAppRegistrations)
            .where(
                and(
                    eq(larkAppRegistrations.id, id),
                    eq(larkAppRegistrations.userId, owner.userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('Lark app registration not found')
        if (owner.boundAgentId && row.agentId !== owner.boundAgentId)
            throw new ForbiddenException(
                'Lark app registration belongs to another agent'
            )
        return row
    }

    private async reloadSummary(
        owner: LarkRegistrationOwner,
        id: string
    ): Promise<LarkAppRegistrationSummary> {
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

    private toSummary(
        row: LarkAppRegistrationRow
    ): LarkAppRegistrationSummary {
        return {
            id: row.id,
            agentId: row.agentId,
            status: row.status,
            qrUrl: row.status === 'pending' ? row.qrUrl : null,
            userCode: row.userCode,
            intervalSec: row.intervalSec,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            channelId: row.channelId,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    private async maintenanceTick(): Promise<void> {
        this.rateLimit.sweep()
        try {
            const deleted = await this.cleanupExpiredRegistrations()
            if (deleted > 0)
                this.log.log(
                    `Lark registration cleanup deleted ${deleted} session(s)`
                )
        } catch (err) {
            if ((err as { code?: string } | null)?.code === '42P01') {
                this.log.warn(
                    'Lark app registrations table is missing; skipping cleanup until migrations run'
                )
                return
            }
            this.log.warn(
                `Lark registration cleanup failed: ${(err as Error).message}`
            )
        }
    }
}
