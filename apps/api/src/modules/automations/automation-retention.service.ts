import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { and, count, inArray, isNotNull, lt } from 'drizzle-orm'
import { automations, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000
const LEASE_NAME = 'automation-retention-sweep'
const LEASE_TTL_MS = 10 * 60 * 1000
// Each automation cascades its automation_runs rows, so the physical rows per
// batch are a multiple of this — keep batches small to bound lock time.
const BATCH_SIZE = 100
const BATCH_PAUSE_MS = 200
const DEFAULT_MAX_DELETES_PER_RUN = 10_000

export interface AutomationRetentionSweepResult {
    scanned: number
    purged: number
    failed: number
    capped: boolean
    retentionDays: number
    dryRun: boolean
}

export const automationRetentionCutoff = (
    now: Date,
    retentionDays: number
): Date => new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

// Hard-deletes automations tombstoned longer than the configured retention
// window (#588). The window is read from admin settings on every run, so a
// changed value applies to existing tombstones on the next sweep. Runs are
// removed by the automation_runs FK cascade only here, never in the request
// path.
@Injectable()
export class AutomationRetentionService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(AutomationRetentionService.name)
    private timer: NodeJS.Timeout | null = null
    private running = false
    private readonly leaseHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly settings: AdminSettingsService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    onModuleInit(): void {
        if (this.config.get('AUTOMATION_RETENTION_ENABLED') === 'false') return
        const intervalMs = Math.max(
            5 * 60 * 1000,
            Number(
                this.config.get('AUTOMATION_RETENTION_INTERVAL_MS') ??
                    DEFAULT_INTERVAL_MS
            )
        )
        this.timer = setInterval(() => {
            void this.runOnce().catch((err) =>
                this.log.warn(
                    `automation retention sweep failed: ${(err as Error).message}`
                )
            )
        }, intervalMs)
        this.timer.unref?.()
        // Staggered from the chat-retention boot sweep (60s) so the two
        // startup sweeps do not compete for the pool at the same instant.
        setTimeout(() => {
            void this.runOnce().catch(() => {})
        }, 90_000).unref?.()
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

    async runOnce(): Promise<AutomationRetentionSweepResult> {
        const result: AutomationRetentionSweepResult = {
            scanned: 0,
            purged: 0,
            failed: 0,
            capped: false,
            retentionDays: 0,
            dryRun: false
        }
        if (this.running) return result
        this.running = true
        const startedAt = Date.now()
        try {
            if (!(await this.renewLease())) return result
            result.dryRun =
                this.config.get('AUTOMATION_RETENTION_DRY_RUN') === '1'
            const { retentionDays } =
                await this.settings.getAutomationRetention()
            result.retentionDays = retentionDays
            const maxPerRun = Math.max(
                BATCH_SIZE,
                Number(
                    this.config.get(
                        'AUTOMATION_RETENTION_MAX_DELETES_PER_RUN'
                    ) ?? DEFAULT_MAX_DELETES_PER_RUN
                )
            )
            const cutoff = automationRetentionCutoff(new Date(), retentionDays)
            if (result.dryRun) {
                result.scanned = await this.countExpired(cutoff)
                if (result.scanned > 0)
                    this.log.log(
                        `automation retention dry-run: would purge ${result.scanned} automations tombstoned before ${cutoff.toISOString()} (retention ${retentionDays}d)`
                    )
                return result
            }
            while (result.purged < maxPerRun) {
                // Losing the lease mid-run means another replica took over.
                if (!(await this.renewLease())) break
                const limit = Math.min(BATCH_SIZE, maxPerRun - result.purged)
                const expired = await this.db
                    .select({ id: automations.id })
                    .from(automations)
                    .where(
                        and(
                            isNotNull(automations.deletedAt),
                            lt(automations.deletedAt, cutoff)
                        )
                    )
                    .orderBy(automations.deletedAt)
                    .limit(limit)
                if (expired.length === 0) break
                result.scanned += expired.length
                try {
                    await this.db.delete(automations).where(
                        inArray(
                            automations.id,
                            expired.map((row) => row.id)
                        )
                    )
                } catch (err) {
                    result.failed += expired.length
                    this.telemetry?.error(
                        'automation.retention.batch_failed',
                        err as Error,
                        { batchSize: expired.length }
                    )
                    this.log.warn(
                        `automation retention batch failed (${expired.length} rows, retried next run): ${(err as Error).message}`
                    )
                    break
                }
                result.purged += expired.length
                if (expired.length < limit) break
                await pause(BATCH_PAUSE_MS)
            }
            if (result.purged >= maxPerRun) {
                result.capped = true
                this.log.warn(
                    'automation retention run cap reached — remaining backlog drains on subsequent runs'
                )
            }
            if (result.purged > 0)
                this.log.log(
                    `automation retention: purged ${result.purged} automations tombstoned before ${cutoff.toISOString()} (retention ${retentionDays}d)`
                )
            return result
        } finally {
            this.telemetry?.event('automation.retention.sweep', {
                scanned: result.scanned,
                purged: result.purged,
                failed: result.failed,
                capped: result.capped,
                retentionDays: result.retentionDays,
                dryRun: result.dryRun,
                durationMs: Date.now() - startedAt
            })
            this.running = false
        }
    }

    private async countExpired(cutoff: Date): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(automations)
            .where(
                and(
                    isNotNull(automations.deletedAt),
                    lt(automations.deletedAt, cutoff)
                )
            )
        return Number(row?.value ?? 0)
    }

    private async renewLease(): Promise<boolean> {
        if (!this.serviceLeases) return true
        try {
            return await this.serviceLeases.tryAcquireOrRenew(
                LEASE_NAME,
                this.leaseHolderId,
                LEASE_TTL_MS
            )
        } catch (err) {
            // Fail closed: a skipped sweep only delays the purge, while every
            // replica deleting concurrently would contend on the same rows.
            this.log.warn(
                `automation retention lease check failed: ${(err as Error).message}`
            )
            return false
        }
    }
}

const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))
