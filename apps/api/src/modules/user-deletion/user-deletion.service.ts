import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
    Optional
} from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, lte, or } from 'drizzle-orm'
import { auditAction, createObjectId } from '@manyfold/shared'
import {
    agentRuntimes,
    auditLogs,
    automations,
    channels,
    userDeletions,
    userSessions,
    users,
    type Database,
    type UserDeletionRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    USER_LIFECYCLE_PORT,
    noopUserLifecyclePort,
    type UserLifecyclePort
} from '@/common/ports/user-lifecycle.ports'
import { EmailService } from '@/modules/email/email.service'
import {
    SUPPORT_EMAIL
} from '@/modules/email/templates/email-content'
import { renderEmail } from '@/modules/email/templates/render-email'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { K8sProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-provisioner'
import { ChannelsService } from '@/modules/channels/channels.service'

const DEFAULT_GRACE_DAYS = 30
const SWEEP_INTERVAL_MS = 15 * 60 * 1000
const CLAIM_STALE_MS = 30 * 60 * 1000

export interface UserDeletionStatus {
    id: string
    status: UserDeletionRow['status']
    requestedAt: Date
    scheduledAt: Date
    executedAt: Date | null
    restoredAt: Date | null
    reason: string | null
    lastError: UserDeletionRow['lastError']
}

// Account deletion (ADR-0023): request = immediate deactivation (T0), then a
// grace window, then a sweep-driven idempotent hard delete. DB cascade is
// the primary mechanism (every core FK to users is ON DELETE cascade —
// verified against the baseline); this service owns what cascade cannot
// reach: external resources, the lifecycle port, and the audit trail.
@Injectable()
export class UserDeletionService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(UserDeletionService.name)
    private timer: NodeJS.Timeout | null = null
    private sweeping = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly email: EmailService,
        // Lazy resolution for the teardown collaborators: their modules sit
        // deep in the agents/channels graphs, and a hard constructor edge
        // from a module this early in the graph closes instance-level cycles
        // Nest spins on silently (the #879 lesson).
        private readonly moduleRef: ModuleRef,
        @Optional()
        @Inject(USER_LIFECYCLE_PORT)
        private readonly lifecycle: UserLifecyclePort = noopUserLifecyclePort
    ) {}

    onModuleInit(): void {
        if (process.env.NODE_ENV === 'test') return
        this.timer = setInterval(() => {
            void this.sweep()
        }, SWEEP_INTERVAL_MS)
        this.timer.unref?.()
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

    private graceMs(): number {
        const raw = Number(process.env.MF_DELETION_GRACE_DAYS)
        const days =
            Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_DAYS
        return days * 86_400_000
    }

    async status(userId: string): Promise<UserDeletionStatus | null> {
        const [row] = await this.db
            .select()
            .from(userDeletions)
            .where(eq(userDeletions.userId, userId))
            .orderBy(desc(userDeletions.requestedAt))
            .limit(1)
        if (!row) return null
        return {
            id: row.id,
            status: row.status,
            requestedAt: row.requestedAt,
            scheduledAt: row.scheduledAt,
            executedAt: row.executedAt,
            restoredAt: row.restoredAt,
            reason: row.reason,
            lastError: row.lastError ?? null
        }
    }

    async request(args: {
        userId: string
        requestedBy: string
        reason?: string
    }): Promise<UserDeletionStatus> {
        const [user] = await this.db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.id, args.userId))
            .limit(1)
        if (!user) throw new NotFoundException(`user ${args.userId} not found`)
        const existing = await this.pendingRow(args.userId)
        if (existing)
            throw new ConflictException('deletion already pending for user')

        const now = new Date()
        const scheduledAt = new Date(now.getTime() + this.graceMs())
        const id = createObjectId('userDeletion')
        await this.db.transaction(async (tx) => {
            await tx.insert(userDeletions).values({
                id,
                userId: args.userId,
                requestedBy: args.requestedBy,
                reason: args.reason ?? null,
                requestedAt: now,
                scheduledAt
            })
            await tx
                .update(users)
                .set({ deactivatedAt: now, updatedAt: now })
                .where(eq(users.id, args.userId))
            // Unattended activity sources stop with the flag; these two are
            // flipped durably so a restore does not silently resurrect them.
            await tx
                .update(agentRuntimes)
                .set({ keepAliveEnabled: false })
                .where(eq(agentRuntimes.userId, args.userId))
            await tx
                .update(automations)
                .set({ status: 'paused' })
                .where(
                    and(
                        eq(automations.userId, args.userId),
                        eq(automations.status, 'active')
                    )
                )
            await tx
                .update(userSessions)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(userSessions.userId, args.userId),
                        isNull(userSessions.revokedAt)
                    )
                )
        })
        await this.runDeactivateHook(id, args.userId)
        await this.audit(
            args.requestedBy,
            auditAction.USER_DELETION_REQUESTED,
            args.userId,
            { deletionId: id, scheduledAt: scheduledAt.toISOString() }
        )
        await this.sendScheduledEmail(user.email, scheduledAt)
        return (await this.status(args.userId))!
    }

    async restore(args: {
        userId: string
        requestedBy: string
    }): Promise<UserDeletionStatus> {
        const row = await this.pendingRow(args.userId)
        if (!row) throw new NotFoundException('no pending deletion for user')
        const now = new Date()
        await this.db.transaction(async (tx) => {
            await tx
                .update(userDeletions)
                .set({ status: 'restored', restoredAt: now })
                .where(eq(userDeletions.id, row.id))
            await tx
                .update(users)
                .set({ deactivatedAt: null, updatedAt: now })
                .where(eq(users.id, args.userId))
        })
        try {
            await this.lifecycle.onUserReactivated(args.userId)
        } catch (err) {
            this.log.warn(
                `onUserReactivated failed for ${args.userId}: ${(err as Error).message}`
            )
        }
        await this.audit(
            args.requestedBy,
            auditAction.USER_DELETION_RESTORED,
            args.userId,
            { deletionId: row.id }
        )
        const [user] = await this.db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, args.userId))
            .limit(1)
        if (user) await this.sendRestoredEmail(user.email)
        return (await this.status(args.userId))!
    }

    async executeNow(args: {
        userId: string
        requestedBy: string
    }): Promise<UserDeletionStatus | null> {
        const row = await this.pendingRow(args.userId)
        if (!row) throw new NotFoundException('no pending deletion for user')
        await this.db
            .update(userDeletions)
            .set({ scheduledAt: new Date() })
            .where(eq(userDeletions.id, row.id))
        await this.sweep()
        return this.status(args.userId)
    }

    // Multi-instance safe without a leader: a due row is claimed by
    // updating claimed_at (stale claims from a crashed instance re-open
    // after CLAIM_STALE_MS), the slow external teardown runs OUTSIDE any
    // transaction, and every step is idempotent — a crash mid-way leaves a
    // pending row the next tick picks up again.
    async sweep(): Promise<void> {
        if (this.sweeping) return
        this.sweeping = true
        try {
            const due = await this.db
                .select({ id: userDeletions.id })
                .from(userDeletions)
                .where(
                    and(
                        eq(userDeletions.status, 'pending'),
                        lte(userDeletions.scheduledAt, new Date())
                    )
                )
            for (const { id } of due) await this.executeOne(id)
        } finally {
            this.sweeping = false
        }
    }

    private async executeOne(deletionId: string): Promise<void> {
        const now = new Date()
        const stale = new Date(now.getTime() - CLAIM_STALE_MS)
        const claimed = await this.db
            .update(userDeletions)
            .set({ claimedAt: now })
            .where(
                and(
                    eq(userDeletions.id, deletionId),
                    eq(userDeletions.status, 'pending'),
                    lte(userDeletions.scheduledAt, now),
                    or(
                        isNull(userDeletions.claimedAt),
                        lte(userDeletions.claimedAt, stale)
                    )
                )
            )
            .returning()
        const row = claimed[0]
        if (!row) return

        let step = 'runtimes'
        try {
            await this.teardownRuntimes(row.userId)
            step = 'channels'
            await this.teardownChannels(row.userId)
            step = 'lifecycle'
            // Must succeed before the DELETE: failing open would leak rows
            // no FK ties to the user (editions §4.1 governance).
            await this.lifecycle.beforeUserHardDelete(row.userId)
            step = 'delete'
            await this.db.transaction(async (tx) => {
                await tx.delete(users).where(eq(users.id, row.userId))
                await tx
                    .update(userDeletions)
                    .set({
                        status: 'executed',
                        executedAt: new Date(),
                        lastError: null
                    })
                    .where(eq(userDeletions.id, row.id))
            })
        } catch (err) {
            const message = (err as Error).message
            this.log.error(`deletion ${row.id} failed at ${step}: ${message}`)
            await this.db
                .update(userDeletions)
                .set({
                    claimedAt: null,
                    lastError: {
                        step,
                        message,
                        at: new Date().toISOString()
                    }
                })
                .where(eq(userDeletions.id, row.id))
            return
        }
        await this.audit(
            'system',
            auditAction.USER_DELETION_EXECUTED,
            row.userId,
            { deletionId: row.id }
        )
    }

    // The same teardown recipe the explicit runtime-delete endpoint uses:
    // sprites drop the VM when it empties, k8s tears the namespace down by
    // RUNTIME id, daemon rows are derived state that cascades with the user
    // (the machine is the user's own — only the tokens die).
    private async teardownRuntimes(userId: string): Promise<void> {
        const rows = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.userId, userId))
        for (const row of rows) {
            if (row.kind === 'sprites') {
                const sprites = this.moduleRef.get(SpritesProvisioner, {
                    strict: false
                })
                await sprites.teardownRuntime(row, {
                    reapImmediatelyIfEmpty: true
                })
            } else if (row.kind === 'k8s') {
                const k8s = this.moduleRef.get(K8sProvisioner, {
                    strict: false
                })
                await k8s.teardownRuntime(row, row.id)
            }
        }
    }

    private async teardownChannels(userId: string): Promise<void> {
        const rows = await this.db
            .select({ id: channels.id })
            .from(channels)
            .where(eq(channels.userId, userId))
        if (rows.length === 0) return
        const service = this.moduleRef.get(ChannelsService, { strict: false })
        for (const { id } of rows) {
            await service.delete(userId, id, true)
        }
    }

    private async pendingRow(userId: string): Promise<UserDeletionRow | null> {
        const [row] = await this.db
            .select()
            .from(userDeletions)
            .where(
                and(
                    eq(userDeletions.userId, userId),
                    eq(userDeletions.status, 'pending')
                )
            )
            .limit(1)
        return row ?? null
    }

    private async runDeactivateHook(
        deletionId: string,
        userId: string
    ): Promise<void> {
        try {
            await this.lifecycle.onUserDeactivated(userId)
        } catch (err) {
            // The request itself must not fail on a billing hiccup; the
            // error is recorded so operators see it and retry via restore +
            // re-request or manually. Subscriptions are also swept up by the
            // hard delete's lifecycle hook.
            const message = (err as Error).message
            this.log.error(
                `onUserDeactivated failed for ${userId}: ${message}`
            )
            await this.db
                .update(userDeletions)
                .set({
                    lastError: {
                        step: 'deactivate',
                        message,
                        at: new Date().toISOString()
                    }
                })
                .where(eq(userDeletions.id, deletionId))
        }
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch {}
    }

    private async sendScheduledEmail(
        to: string,
        scheduledAt: Date
    ): Promise<void> {
        try {
            const date = scheduledAt.toISOString().slice(0, 10)
            await this.email.send({
                to,
                subject: 'Your account is scheduled for deletion',
                tag: 'user.deletion.scheduled',
                ...renderEmail({
                    preheader: `Permanent deletion on ${date}.`,
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: `Your account has been deactivated and is scheduled for permanent deletion on ${date}. Signing in is disabled and any subscriptions have been canceled.`
                        },
                        {
                            kind: 'note',
                            text: 'If this was not requested by you, or you change your mind, contact support before that date and the account can be fully restored.'
                        }
                    ],
                    footerNote: `Questions? Email ${SUPPORT_EMAIL}.`
                })
            })
        } catch (err) {
            this.log.warn(
                `deletion-scheduled email to ${to} failed: ${(err as Error).message}`
            )
        }
    }

    private async sendRestoredEmail(to: string): Promise<void> {
        try {
            await this.email.send({
                to,
                subject: 'Your account has been restored',
                tag: 'user.deletion.restored',
                ...renderEmail({
                    preheader: 'The scheduled deletion was canceled.',
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: 'The scheduled deletion of your account was canceled and you can sign in again. Paused automations and canceled subscriptions stay off until you re-enable them.'
                        }
                    ],
                    footerNote: `Questions? Email ${SUPPORT_EMAIL}.`
                })
            })
        } catch (err) {
            this.log.warn(
                `deletion-restored email to ${to} failed: ${(err as Error).message}`
            )
        }
    }
}
