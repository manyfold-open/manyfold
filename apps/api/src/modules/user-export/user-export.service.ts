import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { ConfigService } from '@nestjs/config'
import { and, desc, eq, inArray, lte, or } from 'drizzle-orm'
import { auditAction, createObjectId } from '@manyfold/shared'
import {
    auditLogs,
    userExports,
    users,
    type Database,
    type UserExportRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    USER_LIFECYCLE_PORT,
    noopUserLifecyclePort,
    type UserLifecyclePort
} from '@/common/ports/user-lifecycle.ports'
import { DEFAULT_API_BASE_URL } from '@/common/brand'
import { configString } from '@/common/config-alias'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { EmailService } from '@/modules/email/email.service'
import { SUPPORT_EMAIL } from '@/modules/email/templates/email-content'
import { renderEmail } from '@/modules/email/templates/render-email'
import { writeUserExportBundle } from './export-collectors'
import { ExportTokenService } from './export-token.service'
import { UserExportStorageService } from './export-storage.service'

const SWEEP_INTERVAL_MS = 15 * 60 * 1000
const CLAIM_STALE_MS = 30 * 60 * 1000
// §9.2: the stored bundle lives seven days, then the sweep deletes it — the
// row flips to expired and the signed links die with it.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
// Links minted for the in-app status view. The "export ready" email carries a
// token valid until the object itself expires instead — post-deletion-T0
// users have no session to come back and re-mint with (the admin-triggered
// support path), so for them the emailed link IS the download.
const STATUS_LINK_TTL_MS = 60 * 60 * 1000

export interface UserExportStatus {
    id: string
    status: UserExportRow['status']
    createdAt: Date
    expiresAt: Date | null
    downloadUrl: string | null
    lastError: UserExportRow['lastError']
}

// GDPR takeout (ADR-0023 §9.2, V2-B): POST queues a row, the sweep does the
// slow work — per-domain collectors stream into a zip, the bundle lands in
// object storage under takeout/, the user gets an email with a signed
// download link. The user-deletion sweep recipe is reused wholesale: claim by
// conditional UPDATE (stale claims from a crashed instance re-open), and NO
// transaction is ever held around the collect/zip/upload work.
@Injectable()
export class UserExportService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(UserExportService.name)
    private timer: NodeJS.Timeout | null = null
    private sweeping = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly email: EmailService,
        private readonly tokens: ExportTokenService,
        private readonly storage: UserExportStorageService,
        private readonly config: ConfigService,
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

    // Queue an export. Serves both the self endpoint (requestedBy = the user)
    // and the admin support fallback — which deliberately works for
    // grace-period (deactivated) users: §9.1 sends people to export BEFORE
    // confirming deletion, but the ones who didn't cannot sign in anymore,
    // and support covers them through this same path.
    async request(args: {
        userId: string
        requestedBy: string
    }): Promise<UserExportStatus> {
        this.storage.assertConfigured()
        const [user] = await this.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, args.userId))
            .limit(1)
        // A hard-deleted account has nothing left to export (V-7): 404.
        if (!user) throw new NotFoundException(`user ${args.userId} not found`)
        const [active] = await this.db
            .select({ id: userExports.id })
            .from(userExports)
            .where(
                and(
                    eq(userExports.userId, args.userId),
                    inArray(userExports.status, ['queued', 'running'])
                )
            )
            .limit(1)
        if (active)
            throw new ConflictException('an export is already in progress')

        const id = createObjectId('userExport')
        await this.db.insert(userExports).values({ id, userId: args.userId })
        await this.audit(
            args.requestedBy,
            auditAction.USER_EXPORT_REQUESTED,
            args.userId,
            { exportId: id, requestedBy: args.requestedBy }
        )
        return (await this.status(args.userId))!
    }

    async status(userId: string): Promise<UserExportStatus | null> {
        const [row] = await this.db
            .select()
            .from(userExports)
            .where(eq(userExports.userId, userId))
            .orderBy(desc(userExports.createdAt), desc(userExports.id))
            .limit(1)
        if (!row) return null
        return this.view(row)
    }

    // Token-only by design (the presigned-GET model): the emailed link must
    // work for grace-period users with no session. Every failure mode is the
    // same 404 — a guessed token learns nothing about what exists.
    async download(
        token: string
    ): Promise<{ stream: AsyncIterable<Uint8Array>; filename: string }> {
        const exportId = this.tokens.verify(token)
        if (!exportId) throw new NotFoundException('export not found')
        const [row] = await this.db
            .select()
            .from(userExports)
            .where(eq(userExports.id, exportId))
            .limit(1)
        if (
            !row ||
            row.status !== 'ready' ||
            !row.objectKey ||
            !row.expiresAt ||
            row.expiresAt.getTime() <= Date.now()
        )
            throw new NotFoundException('export not found')
        const stream = await this.storage.read(row.objectKey)
        const date = row.createdAt.toISOString().slice(0, 10)
        return { stream, filename: `manyfold-export-${date}.zip` }
    }

    // One pass: run due export jobs, then delete bundles past retention.
    // Reentrancy-guarded like the deletion sweep; every step is idempotent
    // and a crash mid-run leaves a claimed row the staleness window re-opens.
    async sweep(): Promise<void> {
        if (this.sweeping) return
        this.sweeping = true
        try {
            const stale = new Date(Date.now() - CLAIM_STALE_MS)
            const due = await this.db
                .select({ id: userExports.id })
                .from(userExports)
                .where(
                    or(
                        eq(userExports.status, 'queued'),
                        and(
                            eq(userExports.status, 'running'),
                            lte(userExports.claimedAt, stale)
                        )
                    )
                )
            for (const { id } of due) await this.runOne(id)
            await this.sweepExpired()
        } finally {
            this.sweeping = false
        }
    }

    private async runOne(exportId: string): Promise<void> {
        const now = new Date()
        const stale = new Date(now.getTime() - CLAIM_STALE_MS)
        const claimed = await this.db
            .update(userExports)
            .set({ status: 'running', claimedAt: now, updatedAt: now })
            .where(
                and(
                    eq(userExports.id, exportId),
                    or(
                        eq(userExports.status, 'queued'),
                        and(
                            eq(userExports.status, 'running'),
                            lte(userExports.claimedAt, stale)
                        )
                    )
                )
            )
            .returning()
        const row = claimed[0]
        if (!row) return

        const [user] = await this.db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, row.userId))
            .limit(1)
        // Account hard-deleted while queued: the FK cascade already removed
        // (or is about to remove) this row; there is nobody to export for.
        if (!user) return

        const temp = join(
            tmpdir(),
            `manyfold-export-${row.id}-${randomUUID()}.zip`
        )
        let step = 'collect'
        try {
            await writeUserExportBundle({
                db: this.db,
                userId: row.userId,
                exportId: row.id,
                port: this.lifecycle,
                out: createWriteStream(temp)
            })
            step = 'upload'
            const objectKey = this.storage.objectKey(row.userId, row.id)
            await this.storage.putFile(objectKey, temp)
            step = 'finalize'
            const expiresAt = new Date(Date.now() + RETENTION_MS)
            await this.db
                .update(userExports)
                .set({
                    status: 'ready',
                    objectKey,
                    expiresAt,
                    lastError: null,
                    updatedAt: new Date()
                })
                .where(eq(userExports.id, row.id))
            await this.audit(
                'system',
                auditAction.USER_EXPORT_READY,
                row.userId,
                { exportId: row.id }
            )
            await this.sendReadyEmail(user.email, row.id, expiresAt)
        } catch (err) {
            const message = (err as Error).message
            this.log.error(`export ${row.id} failed at ${step}: ${message}`)
            // failed is terminal: re-requesting is the retry path. A poisoned
            // collector retried forever would burn the sweep; a transient
            // failure costs the user one more click.
            await this.db
                .update(userExports)
                .set({
                    status: 'failed',
                    claimedAt: null,
                    lastError: {
                        step,
                        message,
                        at: new Date().toISOString()
                    },
                    updatedAt: new Date()
                })
                .where(eq(userExports.id, row.id))
            await this.audit(
                'system',
                auditAction.USER_EXPORT_FAILED,
                row.userId,
                { exportId: row.id, step }
            )
        } finally {
            await rm(temp, { force: true })
        }
    }

    private async sweepExpired(): Promise<void> {
        const dueRows = await this.db
            .select()
            .from(userExports)
            .where(
                and(
                    eq(userExports.status, 'ready'),
                    lte(userExports.expiresAt, new Date())
                )
            )
        for (const row of dueRows) {
            try {
                if (row.objectKey) await this.storage.delete(row.objectKey)
                await this.db
                    .update(userExports)
                    .set({
                        status: 'expired',
                        objectKey: null,
                        updatedAt: new Date()
                    })
                    .where(eq(userExports.id, row.id))
            } catch (err) {
                // Still ready, still due: next sweep retries the delete. The
                // row must NOT flip to expired while the object may exist.
                this.log.error(
                    `export ${row.id} retention delete failed: ${(err as Error).message}`
                )
            }
        }
    }

    private view(row: UserExportRow): UserExportStatus {
        let downloadUrl: string | null = null
        if (
            row.status === 'ready' &&
            row.objectKey &&
            row.expiresAt &&
            row.expiresAt.getTime() > Date.now()
        ) {
            const linkExpiry = new Date(
                Math.min(
                    Date.now() + STATUS_LINK_TTL_MS,
                    row.expiresAt.getTime()
                )
            )
            downloadUrl = this.downloadUrl(row.id, linkExpiry)
        }
        return {
            id: row.id,
            status: row.status,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            downloadUrl,
            lastError: row.lastError ?? null
        }
    }

    private downloadUrl(exportId: string, expiresAt: Date): string {
        const token = this.tokens.mint(exportId, expiresAt)
        return `${this.apiUrl()}/me/export/download?token=${encodeURIComponent(token)}`
    }

    private apiUrl(): string {
        const base =
            configString(this.config, ['PUBLIC_API_BASE_URL', 'MF_API_URL']) ??
            DEFAULT_API_BASE_URL
        return publicApiUrlWithApiPrefix(base)
    }

    private async sendReadyEmail(
        to: string,
        exportId: string,
        expiresAt: Date
    ): Promise<void> {
        const date = expiresAt.toISOString().slice(0, 10)
        const url = this.downloadUrl(exportId, expiresAt)
        try {
            await this.email.send({
                to,
                subject: 'Your data export is ready',
                tag: 'user.export.ready',
                ...renderEmail({
                    preheader: `Download link valid until ${date}.`,
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: 'The export of your Manyfold account data is ready: a zip of machine-readable JSON/NDJSON files covering your profile, agents and their configuration, chat history, skills, automations, channel settings, usage and connected identities. Credentials and API keys are never included.'
                        },
                        { kind: 'button', label: 'Download your data', url },
                        {
                            kind: 'note',
                            text: `The bundle and this link expire on ${date}. Workspace files are not part of the bundle — while your account is active, download them with the file browser or a backup.`
                        }
                    ],
                    footerNote: `Questions? Email ${SUPPORT_EMAIL}.`
                })
            })
        } catch (err) {
            this.log.warn(
                `export-ready email to ${to} failed: ${(err as Error).message}`
            )
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
}
