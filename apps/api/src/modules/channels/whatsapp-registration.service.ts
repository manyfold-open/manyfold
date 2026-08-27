import { randomUUID } from 'node:crypto'
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
import { ConfigService } from '@nestjs/config'
import { and, count, eq, gt, inArray, lt } from 'drizzle-orm'
import type { AuthenticationState, WASocket } from 'baileys'
import {
    agents,
    whatsappRegistrations,
    type Database,
    type NewWhatsappRegistrationRow,
    type WhatsappRegistrationRow
} from '@manyfold/db'
import {
    createObjectId,
    type StartWhatsappRegistrationBody,
    type WhatsappRegistrationSummary
} from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ChannelsService } from './channels.service'
import { ChannelsRepository } from './channels.repository'
import {
    createWaSocket,
    createWhatsappAuthStore,
    serializeWhatsappAuth,
    waCloseCode,
    WA_RESTART_REQUIRED,
    type WhatsappAuthSnapshot
} from './providers/whatsapp-baileys'
import type { WhatsappProviderState } from './providers/whatsapp.provider'

const MAX_PENDING_PER_USER = 3
// WhatsApp rotates the QR roughly every 20s and closes the pairing socket
// after a handful of unscanned rotations; a fresh socket is opened this many
// times before the registration is declared expired.
const MAX_QR_REFRESH = 3
const REGISTRATION_TTL_MS = 8 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
const CLEANUP_RETENTION_MS = 60 * 60_000
// Backstop for a pair-success that is never followed by the reconnect close.
const PAIRING_SETTLE_FALLBACK_MS = 5_000

interface PairingSession {
    socket: WASocket
    flush: () => Promise<void>
    stopStore: () => void
    closed: boolean
    // Set once the phone accepts the code, so the close that follows is read
    // as a handover rather than an unscanned drop.
    paired: boolean
    settleTimer: NodeJS.Timeout | null
}

export interface WhatsappRegistrationOwner {
    userId: string
    boundAgentId?: string
}

@Injectable()
export class WhatsappRegistrationService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(WhatsappRegistrationService.name)
    private cleanupTimer: NodeJS.Timeout | null = null
    // Pairing sockets live in memory on the instance that started them, so a
    // registration is only ever advanced there. Other instances serve reads.
    private readonly sessions = new Map<string, PairingSession>()
    private readonly holderId: string

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly channels: ChannelsService,
        private readonly repo: ChannelsRepository,
        config: ConfigService
    ) {
        this.holderId = config.get('FLY_MACHINE_ID') ?? randomUUID()
    }

    onModuleInit(): void {
        this.cleanupTimer = setInterval(() => {
            void this.maintenanceTick()
        }, CLEANUP_INTERVAL_MS)
        this.cleanupTimer.unref?.()
        void this.maintenanceTick()
    }

    async onModuleDestroy(): Promise<void> {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        for (const id of [...this.sessions.keys()]) this.closeSession(id)
    }

    async start(
        userId: string,
        body: StartWhatsappRegistrationBody
    ): Promise<WhatsappRegistrationSummary> {
        await this.assertAgentOwned(userId, body.agentId)
        await this.runtimeAccess.reserveChannelSlot(userId)
        const now = new Date()
        const [pending] = await this.db
            .select({ value: count() })
            .from(whatsappRegistrations)
            .where(
                and(
                    eq(whatsappRegistrations.userId, userId),
                    eq(whatsappRegistrations.status, 'pending'),
                    gt(whatsappRegistrations.expiresAt, now)
                )
            )
        if (Number(pending?.value ?? 0) >= MAX_PENDING_PER_USER)
            throw new ConflictException({
                code: 'too_many_pending_registrations',
                message: 'too many pending WhatsApp registrations'
            })

        const [row] = await this.db
            .insert(whatsappRegistrations)
            .values({
                id: createObjectId('whatsappRegistration'),
                userId,
                agentId: body.agentId,
                label: body.label.trim(),
                holderId: this.holderId,
                expiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS),
                createdAt: now,
                updatedAt: now
            })
            .returning()

        // The row exists before the socket does, so a failure here would
        // otherwise leave it pending: nothing polls a registration whose
        // start threw, and the sweeper only deletes rows an hour past expiry.
        // Three of those in a row used to exhaust the cap and report the
        // wrong problem back to the user.
        try {
            await this.openPairingSocket(row)
        } catch (err) {
            this.log.warn(
                `WhatsApp registration start failed id=${row.id}: ${(err as Error).message}`
            )
            await this.fail(row.id, 'upstream_error', (err as Error).message)
            throw new BadGatewayException({
                code: 'whatsapp_registration_unavailable',
                message: 'WhatsApp registration is temporarily unavailable'
            })
        }
        return this.reloadSummary({ userId }, row.id)
    }

    async get(
        owner: WhatsappRegistrationOwner,
        id: string
    ): Promise<WhatsappRegistrationSummary> {
        const row = await this.loadOwned(owner, id)
        // Nothing to poll upstream: the pairing socket pushes QR rotations and
        // the pairing result straight into the row. Reads only need to notice
        // that a registration nobody scanned has run out of time.
        if (row.status === 'pending' && row.expiresAt <= new Date()) {
            this.closeSession(row.id)
            return this.transition(owner, row.id, ['pending'], {
                status: 'expired',
                qrContent: null,
                updatedAt: new Date()
            })
        }
        return this.toSummary(row)
    }

    async cancel(owner: WhatsappRegistrationOwner, id: string): Promise<void> {
        const row = await this.loadOwned(owner, id)
        if (row.status !== 'pending') return
        this.closeSession(row.id)
        await this.db
            .update(whatsappRegistrations)
            .set({
                status: 'cancelled',
                qrContent: null,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(whatsappRegistrations.id, row.id),
                    eq(whatsappRegistrations.status, 'pending')
                )
            )
    }

    async cleanupExpiredRegistrations(now: Date = new Date()): Promise<number> {
        const deleted = await this.db
            .delete(whatsappRegistrations)
            .where(
                lt(
                    whatsappRegistrations.expiresAt,
                    new Date(now.getTime() - CLEANUP_RETENTION_MS)
                )
            )
            .returning({ id: whatsappRegistrations.id })
        for (const row of deleted) this.closeSession(row.id)
        return deleted.length
    }

    // The single point where this service reaches WhatsApp. Overridable so the
    // pairing state machine can be driven against a scripted socket.
    protected createPairingSocket(state: AuthenticationState): Promise<WASocket> {
        return createWaSocket({ state })
    }

    // One pairing attempt: a socket with throwaway in-memory auth that only
    // becomes durable once WhatsApp confirms the link.
    private async openPairingSocket(
        row: WhatsappRegistrationRow
    ): Promise<void> {
        const snapshot: { current: WhatsappAuthSnapshot | null } = {
            current: null
        }
        const store = await createWhatsappAuthStore({
            load: async () => null,
            save: async (next) => {
                snapshot.current = next
            }
        })
        const socket = await this.createPairingSocket(store.state)
        const session: PairingSession = {
            socket,
            flush: store.flush,
            stopStore: store.stop,
            closed: false,
            paired: false,
            settleTimer: null
        }
        this.sessions.set(row.id, session)

        socket.ev.on('creds.update', () => {
            store.touch()
        })

        const settle = async (): Promise<void> => {
            if (session.closed) return
            await store.flush()
            const snap = snapshot.current
            // flush() forces the pending write, so a null here means the
            // snapshot was never populated. Persisting the creds with no Signal
            // keys would mint a channel that can never decrypt a message, so
            // fail the registration loudly instead.
            if (!snap) {
                this.log.error(
                    `WhatsApp pairing produced no auth snapshot id=${row.id}`
                )
                this.closeSession(row.id)
                await this.fail(
                    row.id,
                    'upstream_error',
                    'pairing produced no session state'
                )
                return
            }
            await this.completePairing(row.id, snap)
        }

        socket.ev.on('connection.update', (update) => {
            void (async () => {
                if (session.closed) return
                if (update.qr) {
                    await this.recordQr(row.id, update.qr)
                    return
                }
                // The phone accepted the code. `creds.me` is now set and
                // WhatsApp asks for a reconnect (code 515). Do NOT gate on
                // `creds.registered`: Baileys only ever sets that on the
                // phone-number pairing-code flow, never on the QR flow, so
                // requiring it strands every scan in 'pending'.
                if (update.isNewLogin) {
                    session.paired = true
                    this.log.log(`WhatsApp pairing accepted id=${row.id}`)
                    // The close normally arrives within a second and is the
                    // cleaner handover point (it proves Baileys finished
                    // replying to the pair-success stanza). This is only the
                    // backstop for a close that never comes.
                    session.settleTimer = setTimeout(() => {
                        void settle().catch((err) =>
                            this.log.warn(
                                `WhatsApp pairing settle failed id=${row.id}: ${(err as Error).message}`
                            )
                        )
                    }, PAIRING_SETTLE_FALLBACK_MS)
                    session.settleTimer.unref?.()
                    return
                }
                if (update.connection === 'close') {
                    const code = waCloseCode(update.lastDisconnect?.error)
                    if (session.paired || store.state.creds?.me?.id) {
                        await settle()
                        return
                    }
                    if (code === WA_RESTART_REQUIRED) return
                    this.log.log(
                        `WhatsApp pairing socket closed unscanned id=${row.id} code=${code ?? 'none'}`
                    )
                    await this.refreshOrExpire(row.id)
                }
            })().catch((err) =>
                this.log.warn(
                    `WhatsApp pairing update failed id=${row.id}: ${(err as Error).message}`
                )
            )
        })
    }

    private async recordQr(id: string, qr: string): Promise<void> {
        await this.db
            .update(whatsappRegistrations)
            .set({ qrContent: qr, updatedAt: new Date() })
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    eq(whatsappRegistrations.status, 'pending')
                )
            )
    }

    private async refreshOrExpire(id: string): Promise<void> {
        this.closeSession(id)
        const [row] = await this.db
            .select()
            .from(whatsappRegistrations)
            .where(eq(whatsappRegistrations.id, id))
            .limit(1)
        if (!row || row.status !== 'pending') return
        if (row.refreshCount >= MAX_QR_REFRESH || row.expiresAt <= new Date()) {
            await this.db
                .update(whatsappRegistrations)
                .set({
                    status: 'expired',
                    qrContent: null,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(whatsappRegistrations.id, id),
                        eq(whatsappRegistrations.status, 'pending')
                    )
                )
            return
        }
        const [bumped] = await this.db
            .update(whatsappRegistrations)
            .set({
                refreshCount: row.refreshCount + 1,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    eq(whatsappRegistrations.status, 'pending'),
                    eq(whatsappRegistrations.refreshCount, row.refreshCount)
                )
            )
            .returning()
        if (!bumped) return
        // Same reasoning as start(): a row whose socket cannot be reopened is
        // not pending any more, it has failed. Leaving it pending would hold a
        // cap slot with nothing behind it.
        try {
            await this.openPairingSocket(bumped)
        } catch (err) {
            this.log.warn(
                `WhatsApp QR refresh failed id=${id}: ${(err as Error).message}`
            )
            await this.fail(id, 'upstream_error', (err as Error).message)
        }
    }

    private async completePairing(
        id: string,
        snapshot: WhatsappAuthSnapshot
    ): Promise<void> {
        this.closeSession(id)
        const [locked] = await this.db
            .update(whatsappRegistrations)
            .set({
                status: 'creating',
                qrContent: null,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    eq(whatsappRegistrations.status, 'pending')
                )
            )
            .returning()
        if (!locked) return

        const botJid = snapshot.creds?.me?.id ?? null
        const botName = snapshot.creds?.me?.name ?? null
        if (!botJid) {
            await this.fail(id, 'upstream_error', 'pairing produced no identity')
            return
        }
        // The linked number is the external identity: the partial unique index
        // on (provider, external_id) is what keeps one number bound to one
        // channel. Normalized so a device suffix (:12@…) cannot smuggle a
        // second binding for the same phone past that index.
        const externalId = normalizeSelfJid(botJid)

        try {
            const channel = await this.channels.create(
                locked.userId,
                {
                    agentId: locked.agentId,
                    provider: 'whatsapp',
                    label: locked.label,
                    config: {
                        botJid: externalId,
                        botName,
                        allowedUserIds: [],
                        operatorUserIds: [],
                        allowedChatIds: [],
                        mentionOnly: true,
                        shareSessionInChannel: false,
                        progressMode: 'final',
                        outboundFiles: true,
                        contextProjection: true
                    },
                    credentials: null
                },
                { externalId }
            )
            // Auth must be durable before the channel goes active, or the
            // manager starts a socket with no session to resume.
            await this.persistAuth(channel.id, snapshot, externalId)
            await this.channels.update(locked.userId, channel.id, {
                status: 'active'
            })
            await this.settleCreated(id, channel.id)
        } catch (err) {
            const alreadyBound =
                err instanceof ConflictException &&
                (err.getResponse() as { code?: string } | null)?.code ===
                    'external_account_already_bound'
            await this.fail(
                id,
                alreadyBound ? 'already_bound' : 'channel_create_failed',
                alreadyBound
                    ? 'this WhatsApp number is already connected to a channel'
                    : (err as Error).message
            )
        }
    }

    private async persistAuth(
        channelId: string,
        snapshot: WhatsappAuthSnapshot,
        botJid: string
    ): Promise<void> {
        const encrypted = this.crypto.encrypt(
            await serializeWhatsappAuth(snapshot)
        )
        const now = new Date()
        await this.repo.upsertProviderState({
            channelId,
            stateJson: {
                v: 1,
                authCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion,
                botJid
            } satisfies WhatsappProviderState,
            createdAt: now,
            updatedAt: now
        })
    }

    private async settleCreated(id: string, channelId: string): Promise<void> {
        await this.db
            .update(whatsappRegistrations)
            .set({ status: 'succeeded', channelId, updatedAt: new Date() })
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    eq(whatsappRegistrations.status, 'creating')
                )
            )
    }

    private async fail(
        id: string,
        errorCode: WhatsappRegistrationRow['errorCode'],
        errorMessage: string
    ): Promise<void> {
        await this.db
            .update(whatsappRegistrations)
            .set({
                status: 'failed',
                errorCode,
                errorMessage,
                qrContent: null,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    inArray(whatsappRegistrations.status, ['pending', 'creating'])
                )
            )
    }

    private closeSession(id: string): void {
        const session = this.sessions.get(id)
        if (!session) return
        session.closed = true
        this.sessions.delete(id)
        if (session.settleTimer) clearTimeout(session.settleTimer)
        session.stopStore()
        try {
            session.socket.end(undefined)
        } catch {
            // Already torn down.
        }
    }

    private async transition(
        owner: WhatsappRegistrationOwner,
        id: string,
        fromStatuses: WhatsappRegistrationRow['status'][],
        patch: Partial<NewWhatsappRegistrationRow>
    ): Promise<WhatsappRegistrationSummary> {
        const [updated] = await this.db
            .update(whatsappRegistrations)
            .set(patch)
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    fromStatuses.length === 1
                        ? eq(whatsappRegistrations.status, fromStatuses[0])
                        : inArray(whatsappRegistrations.status, fromStatuses)
                )
            )
            .returning()
        return updated ? this.toSummary(updated) : this.reloadSummary(owner, id)
    }

    private async loadOwned(
        owner: WhatsappRegistrationOwner,
        id: string
    ): Promise<WhatsappRegistrationRow> {
        const [row] = await this.db
            .select()
            .from(whatsappRegistrations)
            .where(
                and(
                    eq(whatsappRegistrations.id, id),
                    eq(whatsappRegistrations.userId, owner.userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('WhatsApp registration not found')
        if (owner.boundAgentId && row.agentId !== owner.boundAgentId)
            throw new ForbiddenException(
                'WhatsApp registration belongs to another agent'
            )
        return row
    }

    private async reloadSummary(
        owner: WhatsappRegistrationOwner,
        id: string
    ): Promise<WhatsappRegistrationSummary> {
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
        row: WhatsappRegistrationRow
    ): WhatsappRegistrationSummary {
        return {
            id: row.id,
            agentId: row.agentId,
            status: row.status,
            qrContent: row.status === 'pending' ? row.qrContent : null,
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
                    `WhatsApp registration cleanup deleted ${deleted} session(s)`
                )
        } catch (err) {
            if ((err as { code?: string } | null)?.code === '42P01') {
                this.log.warn(
                    'WhatsApp registrations table is missing; skipping cleanup until migrations run'
                )
                return
            }
            this.log.warn(
                `WhatsApp registration cleanup failed: ${(err as Error).message}`
            )
        }
    }
}

// Baileys reports the linked identity with a device suffix
// (15551234567:12@s.whatsapp.net); the binding identity is the bare number.
export const normalizeSelfJid = (jid: string): string => {
    const [user, domain] = jid.split('@')
    const bare = user?.split(':')[0] ?? ''
    return domain ? `${bare}@${domain}` : bare
}
