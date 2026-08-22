import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ModuleRef } from '@nestjs/core'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm'
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
import { DEFAULT_WEB_BASE_URL } from '@/common/brand'
import { configString } from '@/common/config-alias'
import { EmailService } from '@/modules/email/email.service'
import {
    SUPPORT_EMAIL
} from '@/modules/email/templates/email-content'
import { renderEmail } from '@/modules/email/templates/render-email'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { K8sProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-provisioner'
import { ChannelsService } from '@/modules/channels/channels.service'
import { DeletionTokenService } from './deletion-token.service'

const DEFAULT_GRACE_DAYS = 30
const SWEEP_INTERVAL_MS = 15 * 60 * 1000
const CLAIM_STALE_MS = 30 * 60 * 1000
// Self-serve requests must be confirmed via the emailed link within this
// window; afterwards the row expires silently — no T0 ran, nothing to undo.
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000

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

export interface MeDeletionAwaiting {
    id: string
    status: 'awaiting_confirmation'
    requestedAt: Date
    expiresAt: Date
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
        private readonly tokens: DeletionTokenService,
        private readonly config: ConfigService,
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
            // An unconfirmed self-serve request is superseded, not kept: one
            // active deletion flow per user, and the admin action already
            // carries the stronger intent (T0 right now).
            await tx
                .update(userDeletions)
                .set({ status: 'expired' })
                .where(
                    and(
                        eq(userDeletions.userId, args.userId),
                        eq(userDeletions.status, 'awaiting_confirmation')
                    )
                )
            await tx.insert(userDeletions).values({
                id,
                userId: args.userId,
                requestedBy: args.requestedBy,
                reason: args.reason ?? null,
                requestedAt: now,
                scheduledAt
            })
            await this.applyT0(tx, args.userId, now)
        })
        await this.runDeactivateHook(id, args.userId)
        await this.audit(
            args.requestedBy,
            auditAction.USER_DELETION_REQUESTED,
            args.userId,
            { deletionId: id, scheduledAt: scheduledAt.toISOString() }
        )
        await this.sendScheduledEmail(user.email, id, scheduledAt)
        return (await this.status(args.userId))!
    }

    // The T0 side effects shared by the admin request and the self-serve
    // confirm (ADR-0023 §9.1 reuses v1's T0 wholesale): deactivate, stop the
    // unattended activity sources durably, and kill every live session.
    private async applyT0(
        tx: Pick<Database, 'update'>,
        userId: string,
        now: Date
    ): Promise<void> {
        await tx
            .update(users)
            .set({ deactivatedAt: now, updatedAt: now })
            .where(eq(users.id, userId))
        // Unattended activity sources stop with the flag; these two are
        // flipped durably so a restore does not silently resurrect them.
        await tx
            .update(agentRuntimes)
            .set({ keepAliveEnabled: false })
            .where(eq(agentRuntimes.userId, userId))
        await tx
            .update(automations)
            .set({ status: 'paused' })
            .where(
                and(
                    eq(automations.userId, userId),
                    eq(automations.status, 'active')
                )
            )
        await tx
            .update(userSessions)
            .set({ revokedAt: now })
            .where(
                and(
                    eq(userSessions.userId, userId),
                    isNull(userSessions.revokedAt)
                )
            )
    }

    // Self-serve entry (ADR-0023 §9.1): records intent and emails a signed
    // confirmation link — NO side effects until that link is clicked. A prior
    // unconfirmed request is superseded (the email-verification house
    // pattern), which doubles as "resend the email".
    async selfRequest(userId: string): Promise<MeDeletionAwaiting> {
        const [user] = await this.db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        if (!user) throw new NotFoundException(`user ${userId} not found`)
        if (await this.pendingRow(userId))
            throw new ConflictException('deletion already pending for user')

        const now = new Date()
        const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS)
        const id = createObjectId('userDeletion')
        await this.db.transaction(async (tx) => {
            await tx
                .update(userDeletions)
                .set({ status: 'expired' })
                .where(
                    and(
                        eq(userDeletions.userId, userId),
                        eq(userDeletions.status, 'awaiting_confirmation')
                    )
                )
            await tx.insert(userDeletions).values({
                id,
                userId,
                // Explicit on purpose: the column DEFAULT is 'pending', and a
                // self request that landed there would schedule a deletion
                // nobody confirmed.
                status: 'awaiting_confirmation',
                requestedBy: userId,
                requestedAt: now,
                // NOT NULL wants a value; the honest one before confirmation
                // is "grace from now". selfConfirm recomputes it from the
                // actual T0 moment.
                scheduledAt: new Date(now.getTime() + this.graceMs())
            })
        })
        await this.audit(
            userId,
            auditAction.USER_DELETION_SELF_REQUESTED,
            userId,
            { deletionId: id, expiresAt: expiresAt.toISOString() }
        )
        const token = this.tokens.mint('confirm', id, expiresAt)
        await this.sendConfirmEmail(user.email, token, expiresAt)
        return { id, status: 'awaiting_confirmation', requestedAt: now, expiresAt }
    }

    // The emailed link comes back here. The token proves possession of the
    // inbox; the session (checked by the controller against row.userId)
    // proves the account. Promotion to pending IS v1's T0 — same transaction
    // body, same hook, same audit trail shape, same scheduled email.
    async selfConfirm(
        userId: string,
        token: string
    ): Promise<UserDeletionStatus> {
        const row = await this.rowForToken('confirm', token)
        if (row.userId !== userId)
            throw new BadRequestException('invalid or expired token')
        if (row.status !== 'awaiting_confirmation')
            throw new BadRequestException('invalid or expired token')
        // An admin T0'd the account while this confirmation sat unread; that
        // deletion is already underway and this request has nothing to add.
        if (await this.pendingRow(userId))
            throw new ConflictException('deletion already pending for user')

        const now = new Date()
        const scheduledAt = new Date(now.getTime() + this.graceMs())
        await this.db.transaction(async (tx) => {
            const promoted = await tx
                .update(userDeletions)
                .set({ status: 'pending', scheduledAt })
                .where(
                    and(
                        eq(userDeletions.id, row.id),
                        eq(
                            userDeletions.status,
                            'awaiting_confirmation'
                        )
                    )
                )
                .returning({ id: userDeletions.id })
            // Lost the race with the sweep's expiry pass or a concurrent
            // confirm: abort before any side effect.
            if (promoted.length === 0)
                throw new BadRequestException('invalid or expired token')
            await this.applyT0(tx, userId, now)
        })
        await this.runDeactivateHook(row.id, userId)
        await this.audit(
            userId,
            auditAction.USER_DELETION_SELF_CONFIRMED,
            userId,
            { deletionId: row.id, scheduledAt: scheduledAt.toISOString() }
        )
        const [user] = await this.db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        if (user)
            await this.sendScheduledEmail(user.email, row.id, scheduledAt)
        return (await this.status(userId))!
    }

    // Session-less by design: after T0 every session is revoked, so the
    // grace-period escape hatch is the signed link in the T0 email. The row
    // state (pending, and only pending) is what makes the token single-use.
    async restoreByToken(token: string): Promise<UserDeletionStatus> {
        const row = await this.rowForToken('restore', token)
        if (row.status !== 'pending')
            throw new BadRequestException('invalid or expired token')
        return this.restore({
            userId: row.userId,
            requestedBy: row.userId,
            action: auditAction.USER_DELETION_SELF_RESTORED
        })
    }

    // The settings UI's view: only a live awaiting row answers. Terminal
    // states (and rows the sweep has not expired yet) read as "no active
    // deletion" — post-T0 the user cannot reach this endpoint anyway.
    async meStatus(userId: string): Promise<MeDeletionAwaiting | null> {
        const cutoff = new Date(Date.now() - CONFIRM_TTL_MS)
        const [row] = await this.db
            .select()
            .from(userDeletions)
            .where(
                and(
                    eq(userDeletions.userId, userId),
                    eq(userDeletions.status, 'awaiting_confirmation'),
                    gt(userDeletions.requestedAt, cutoff)
                )
            )
            .orderBy(desc(userDeletions.requestedAt))
            .limit(1)
        if (!row) return null
        return {
            id: row.id,
            status: 'awaiting_confirmation',
            requestedAt: row.requestedAt,
            expiresAt: new Date(row.requestedAt.getTime() + CONFIRM_TTL_MS)
        }
    }

    private async rowForToken(
        purpose: 'confirm' | 'restore',
        token: string
    ): Promise<UserDeletionRow> {
        const deletionId = this.tokens.verify(purpose, token)
        if (!deletionId)
            throw new BadRequestException('invalid or expired token')
        const [row] = await this.db
            .select()
            .from(userDeletions)
            .where(eq(userDeletions.id, deletionId))
            .limit(1)
        if (!row) throw new BadRequestException('invalid or expired token')
        return row
    }

    async restore(args: {
        userId: string
        requestedBy: string
        // The self-serve magic link records its own audit action; the admin
        // path keeps the v1 one.
        action?: string
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
            args.action ?? auditAction.USER_DELETION_RESTORED,
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
            // Unconfirmed self-serve requests past their 24h window are
            // MARKED expired rather than deleted: nothing to undo (no T0
            // ran), and this table's design premise is that deletion records
            // survive — an admin can still see the abandoned request. One
            // cheap statement; the executor below never touches them because
            // it selects status='pending' only.
            await this.db
                .update(userDeletions)
                .set({ status: 'expired' })
                .where(
                    and(
                        eq(
                            userDeletions.status,
                            'awaiting_confirmation'
                        ),
                        lte(
                            userDeletions.requestedAt,
                            new Date(Date.now() - CONFIRM_TTL_MS)
                        )
                    )
                )
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

    private webUrl(): string {
        return (
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        ).replace(/\/+$/, '')
    }

    private async sendConfirmEmail(
        to: string,
        token: string,
        expiresAt: Date
    ): Promise<void> {
        const url = `${this.webUrl()}/account/deletion/confirm?token=${encodeURIComponent(token)}`
        try {
            await this.email.send({
                to,
                subject: 'Confirm your account deletion request',
                tag: 'user.deletion.confirm',
                ...renderEmail({
                    preheader:
                        'Nothing happens unless you confirm within 24 hours.',
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: 'You asked to delete your Manyfold account. To continue, confirm the request — your account is then deactivated immediately and permanently deleted after the grace period.'
                        },
                        { kind: 'button', label: 'Confirm deletion', url },
                        {
                            kind: 'note',
                            text: `This link works once and expires on ${expiresAt.toISOString().slice(0, 10)}. If you did not ask for this, ignore this email — nothing happens without it.`
                        }
                    ],
                    footerNote: `Questions? Email ${SUPPORT_EMAIL}.`
                })
            })
        } catch (err) {
            this.log.warn(
                `deletion-confirm email to ${to} failed: ${(err as Error).message}`
            )
        }
    }

    // The T0 email. Since v2 it carries the signed restore link (valid for
    // the whole grace window) — the user has no session anymore, so this
    // magic link IS the self-serve way back; support remains the fallback.
    private async sendScheduledEmail(
        to: string,
        deletionId: string,
        scheduledAt: Date
    ): Promise<void> {
        try {
            const date = scheduledAt.toISOString().slice(0, 10)
            const restoreToken = this.tokens.mint(
                'restore',
                deletionId,
                scheduledAt
            )
            const restoreUrl = `${this.webUrl()}/account/deletion/restore?token=${encodeURIComponent(restoreToken)}`
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
                            kind: 'paragraph',
                            text: 'Changed your mind? Restore your account with this link any time before that date:'
                        },
                        {
                            kind: 'button',
                            label: 'Restore my account',
                            url: restoreUrl
                        },
                        {
                            kind: 'note',
                            text: 'If this was not requested by you, use the link above now, or contact support and the account can be fully restored.'
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
