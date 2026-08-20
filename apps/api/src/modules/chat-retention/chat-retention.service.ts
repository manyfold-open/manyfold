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
import { and, count, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import {
    chatMessages,
    chatSessions,
    plans,
    users,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    compactionCutoff,
    readStreamLogCompactBatch,
    resolveCompactAfterDays,
    STREAM_LOG_COMPACT_BATCH_PAUSE_MS,
    STREAM_LOG_COMPACT_BATCH_SIZE,
    STREAM_LOG_COMPACT_MAX_MESSAGES_PER_RUN,
    STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN,
    streamLogCandidateQuery,
    streamLogCompactStatement,
    streamLogSizeQuery
} from './stream-log-compaction'
import {
    countClearableSourceRaw,
    INITIAL_RAW_CLEAR_CURSOR,
    planRetentionFloorQuery,
    rawClearCutoff,
    rawClearStatement,
    readRawClearBatch,
    resolveEffectiveRawClearDays,
    resolveRawClearWindow,
    SOURCE_RAW_CLEAR_BATCH_PAUSE_MS,
    SOURCE_RAW_CLEAR_BATCH_SIZE,
    SOURCE_RAW_CLEAR_MAX_ROWS_PER_RUN,
    type RawClearCursor
} from './source-raw-retention'
import { isRepresentableWindowDays } from './retention-window'

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000
const LEASE_NAME = 'chat-retention-sweep'
// Long enough to survive slow batches between renewals; the lease is
// re-acquired before every user so a wedged sweep loses it within one TTL.
const LEASE_TTL_MS = 10 * 60 * 1000
// Messages per delete batch. Each message cascades into chat_stream_events
// (per-token rows), so the real row count per batch is orders of magnitude
// larger — keep batches small to avoid long locks on hot tables.
const BATCH_SIZE = 200
const BATCH_PAUSE_MS = 200
const DEFAULT_MAX_DELETES_PER_RUN = 50_000

export interface StreamLogCompactionResult {
    messagesCompacted: number
    rowsDeleted: number
    capped: boolean
    dryRun: boolean
}

export interface SourceRawClearResult {
    rowsCleared: number
    capped: boolean
    dryRun: boolean
    // The window actually used, after widening to the live plan floor. 0 =
    // the sweep did not run.
    afterDays: number
}

export interface RetentionSweepResult {
    usersProcessed: number
    messagesDeleted: number
    sourcesCleared: number
    capped: boolean
    streamLog: StreamLogCompactionResult
    sourceRaw: SourceRawClearResult
}

export const retentionCutoff = (now: Date, retentionDays: number): Date =>
    new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

// Prunes chat history past the plan's message_history_retention_days window
// (plans joined live each run, so an upgrade widens the window immediately;
// NULL = keep forever). Messages are deleted outright; chat_message_sources
// rows are kept — sourceEventKey is the dedup anchor that stops sprite-disk
// recovery from re-importing pruned history — but their raw payloads are
// cleared via the schema's rawClearedAt mechanism so deleted content doesn't
// outlive the deletion.
@Injectable()
export class ChatRetentionService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(ChatRetentionService.name)
    private timer: NodeJS.Timeout | null = null
    private running = false
    private readonly leaseHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()
    // The compaction sweep's shape knobs in one place. Grouped rather than read
    // from the module constants inline so a test can drive a cap path without
    // paying a hundred real inter-batch pauses to reach it.
    private readonly compaction = {
        batchSize: STREAM_LOG_COMPACT_BATCH_SIZE,
        pauseMs: STREAM_LOG_COMPACT_BATCH_PAUSE_MS,
        maxRows: STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN,
        maxMessages: STREAM_LOG_COMPACT_MAX_MESSAGES_PER_RUN
    }
    private readonly rawClear = {
        batchSize: SOURCE_RAW_CLEAR_BATCH_SIZE,
        pauseMs: SOURCE_RAW_CLEAR_BATCH_PAUSE_MS,
        maxRows: SOURCE_RAW_CLEAR_MAX_ROWS_PER_RUN
    }

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    onModuleInit(): void {
        if (this.config.get('CHAT_RETENTION_ENABLED') === 'false') return
        const intervalMs = Math.max(
            5 * 60 * 1000,
            Number(
                this.config.get('CHAT_RETENTION_INTERVAL_MS') ??
                    DEFAULT_INTERVAL_MS
            )
        )
        this.timer = setInterval(() => {
            void this.runOnce().catch((err) =>
                this.log.warn(
                    `chat retention sweep failed: ${(err as Error).message}`
                )
            )
        }, intervalMs)
        this.timer.unref?.()
        setTimeout(() => {
            void this.runOnce().catch(() => {})
        }, 60_000).unref?.()
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

    async runOnce(): Promise<RetentionSweepResult> {
        const result: RetentionSweepResult = {
            usersProcessed: 0,
            messagesDeleted: 0,
            sourcesCleared: 0,
            capped: false,
            streamLog: {
                messagesCompacted: 0,
                rowsDeleted: 0,
                capped: false,
                dryRun: false
            },
            sourceRaw: {
                rowsCleared: 0,
                capped: false,
                dryRun: false,
                afterDays: 0
            }
        }
        if (this.running) return result
        this.running = true
        try {
            if (!(await this.renewLease())) return result
            // Unconditional, and first: it is the one number that says whether
            // any of the pruning below is keeping up, so it must be emitted
            // even on a run where nothing is prunable or compaction is off.
            await this.emitStreamLogSize()
            await this.sweepRetention(result)
            await this.clearAgedSourceRaw(result.sourceRaw)
            await this.compactStreamLog(result.streamLog)
            return result
        } finally {
            this.running = false
        }
    }

    private async sweepRetention(result: RetentionSweepResult): Promise<void> {
        const dryRun = this.config.get('CHAT_RETENTION_DRY_RUN') === '1'
        const maxPerRun = Math.max(
            BATCH_SIZE,
            Number(
                this.config.get('CHAT_RETENTION_MAX_DELETES_PER_RUN') ??
                    DEFAULT_MAX_DELETES_PER_RUN
            )
        )
        const now = new Date()
        const candidates = await this.db
            .select({
                userId: users.id,
                retentionDays: plans.messageHistoryRetentionDays
            })
            .from(users)
            .innerJoin(plans, eq(plans.id, users.planId))
            .where(
                and(
                    isNotNull(plans.messageHistoryRetentionDays),
                    gt(plans.messageHistoryRetentionDays, 0)
                )
            )
        for (const row of candidates) {
            if (result.messagesDeleted + result.sourcesCleared >= maxPerRun) {
                result.capped = true
                break
            }
            // A full backlog drain can outlive one TTL; losing the lease
            // mid-run means another instance took over — stop here.
            if (!(await this.renewLease())) break
            const retentionDays = row.retentionDays ?? 0
            // message_history_retention_days is a Postgres integer, so a
            // single fat-fingered plan row can hold 2147483647 — which makes
            // an Invalid Date whose toISOString() throws inside the driver,
            // taking the run down with it. Skip the plan, keep sweeping.
            if (!isRepresentableWindowDays(retentionDays)) {
                this.log.warn(
                    `chat retention skipping user=${row.userId}: plan retention of ${retentionDays}d is out of range`
                )
                continue
            }
            const cutoff = retentionCutoff(now, retentionDays)
            if (dryRun) {
                const pending = await this.countUser(row.userId, cutoff)
                if (pending.messages > 0 || pending.sources > 0) {
                    result.usersProcessed += 1
                    this.log.log(
                        `chat retention dry-run user=${row.userId} retention=${retentionDays}d would delete ${pending.messages} messages, clear up to ${pending.sources} sources (rows a live writer holds are deferred to a later run, not exempt)`
                    )
                }
                continue
            }
            const budget =
                maxPerRun - result.messagesDeleted - result.sourcesCleared
            const swept = await this.sweepUser(row.userId, cutoff, budget)
            result.messagesDeleted += swept.messagesDeleted
            result.sourcesCleared += swept.sourcesCleared
            if (swept.messagesDeleted > 0 || swept.sourcesCleared > 0) {
                result.usersProcessed += 1
                this.log.log(
                    `chat retention user=${row.userId} retention=${retentionDays}d deleted ${swept.messagesDeleted} messages, cleared ${swept.sourcesCleared} sources`
                )
            }
        }
        if (result.messagesDeleted + result.sourcesCleared >= maxPerRun)
            result.capped = true
        if (result.messagesDeleted > 0 || result.sourcesCleared > 0)
            this.log.log(
                `chat retention sweep: ${result.messagesDeleted} messages deleted, ${result.sourcesCleared} sources cleared across ${result.usersProcessed} users${result.capped ? ' (run cap hit, backlog continues next run)' : ''}`
            )
        if (result.capped)
            this.log.warn(
                'chat retention run cap reached — remaining backlog drains on subsequent runs'
            )
    }

    // Two catalog numbers, once a day, for the whole fleet. #672 opened because
    // nobody could answer "how fast is chat_stream_events growing?" without
    // running a count(*) nobody wants to run on the biggest table in the schema.
    private async emitStreamLogSize(): Promise<void> {
        try {
            const rows = (await this.db.execute(
                streamLogSizeQuery()
            )) as Array<{
                estimated_rows: number | string | null
                total_bytes: number | string | null
            }>
            const estimatedRows = Number(rows[0]?.estimated_rows ?? -1)
            const totalBytes = Number(rows[0]?.total_bytes ?? 0)
            this.telemetry?.event('chat.stream_log.size', {
                estimatedRows,
                totalBytes
            })
            this.log.log(
                `chat stream log: ~${Math.round(estimatedRows)} rows, ${totalBytes} bytes`
            )
        } catch (err) {
            // An observability probe must never be able to stop the pruning it
            // exists to observe.
            this.log.warn(
                `chat stream log size probe failed: ${(err as Error).message}`
            )
        }
    }

    // Plan-based retention only reaches users whose plan carries a finite
    // message_history_retention_days, so on an unlimited plan the raw JSONL
    // accumulates forever — and it is the largest of the three copies a turn
    // leaves behind. Measured on the production database [2026-08-09]: for
    // the same 584 messages, chat_message_sources holds 7,073 kB of stored
    // raw against 2,992 kB of canonical transcript in chat_messages, a 2.36x
    // duplicate. This clears it by age for everyone, producing exactly the
    // rawClearedAt state plan-based retention already produces today.
    private async clearAgedSourceRaw(
        result: SourceRawClearResult
    ): Promise<void> {
        const window = resolveRawClearWindow(
            process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS
        )
        if (window.invalid)
            this.log.error(
                `MF_SOURCE_RAW_CLEAR_AFTER_DAYS=${JSON.stringify(process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS)} is not a number — the raw-clear sweep is disabled until it is fixed or removed`
            )
        const planFloorDays = await this.planRetentionFloorDays()
        if (planFloorDays === null) return
        const afterDays = resolveEffectiveRawClearDays(
            window.days,
            planFloorDays
        )
        result.afterDays = afterDays
        if (afterDays === 0) return
        result.dryRun = this.config.get('CHAT_RETENTION_DRY_RUN') === '1'
        const cutoff = rawClearCutoff(new Date(), afterDays)
        const { batchSize, pauseMs, maxRows } = this.rawClear
        let after: RawClearCursor = INITIAL_RAW_CLEAR_CURSOR
        let drained = false
        while (result.rowsCleared < maxRows) {
            // Same reasoning as the sweeps either side: losing the lease
            // mid-drain means another instance owns this work now.
            if (!(await this.renewLease())) break
            const limit = Math.min(batchSize, maxRows - result.rowsCleared)
            // A dry run runs the identical statement minus the update CTE, so
            // the figure it reports is the exact count a real run would clear
            // rather than an estimate from a fleet-wide count(*).
            const batch = readRawClearBatch(
                await this.db.execute(
                    rawClearStatement(
                        { kind: 'age', cutoff, after },
                        limit,
                        !result.dryRun
                    )
                )
            )
            if (batch.scanned === 0 || !batch.cursor) {
                drained = true
                break
            }
            // The cursor comes from the candidate set, never from the rows
            // the update wrote: a row the re-check or SKIP LOCKED held back
            // must not stall the keyset behind it.
            after = batch.cursor
            result.rowsCleared += result.dryRun ? batch.scanned : batch.cleared
            if (batch.scanned < limit) {
                drained = true
                break
            }
            await pause(pauseMs)
        }
        result.capped = !drained && result.rowsCleared >= maxRows
        this.telemetry?.event('chat.message_sources.raw_cleared', {
            afterDays,
            rowsCleared: result.rowsCleared,
            capped: result.capped,
            dryRun: result.dryRun
        })
        if (result.rowsCleared > 0)
            this.log.log(
                `chat source raw ${result.dryRun ? 'dry-run: would clear up to' : 'cleared:'} ${result.rowsCleared} payloads older than ${afterDays}d${result.dryRun ? ' (rows a live writer holds are deferred to a later run, not exempt)' : ''}${result.capped ? ' (run cap hit, backlog continues next run)' : ''}`
            )
    }

    // Read once per run, not per batch: it only moves when an operator edits
    // a plan, and a sweep that changed its own window mid-drain would clear
    // the head of the table on one rule and the tail on another.
    // null = could not be read, and the caller skips the sweep entirely.
    private async planRetentionFloorDays(): Promise<number | null> {
        try {
            const rows = (await this.db.execute(
                planRetentionFloorQuery()
            )) as Array<{ days: number | string | null }>
            const days = Number(rows[0]?.days ?? 0)
            // Out of range widens the window into an Invalid Date whose
            // toISOString() throws — and this reads EVERY plan, so a hostile
            // or fat-fingered row nobody is subscribed to would otherwise
            // reject the run. Same shape as the env knob's invalid handling:
            // report it, skip the raw sweep, leave the rest of the run alone.
            if (!isRepresentableWindowDays(days)) {
                this.log.error(
                    `plan retention floor of ${String(rows[0]?.days)} is out of range — the raw-clear sweep is disabled until that plan is fixed`
                )
                return null
            }
            return days
        } catch (err) {
            // Fail closed: without knowing the widest plan window this sweep
            // cannot prove it is not clearing inside one.
            this.log.warn(
                `plan retention floor probe failed, skipping raw clear: ${(err as Error).message}`
            )
            return null
        }
    }

    // Post-terminal token/thinking rows are the bulk of chat_stream_events and
    // nothing reads them once the turn is finished and re-read from
    // content_blocks_json. Default OFF: with no env set this makes zero
    // statements, so the growth metric above can ship and be watched first.
    // Still off by default, but previewable — it honours CHAT_RETENTION_DRY_RUN
    // — and the row cap is now enforced by the deleting statement itself, so
    // neither one oversized turn nor a full batch can overshoot it. The value
    // to set when enabling is 7, the floor, and it belongs in deployment config
    // rather than in this default.
    private async compactStreamLog(
        result: StreamLogCompactionResult
    ): Promise<void> {
        const afterDays = resolveCompactAfterDays(
            process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
        )
        if (afterDays === 0) return
        result.dryRun = this.config.get('CHAT_RETENTION_DRY_RUN') === '1'
        const cutoff = compactionCutoff(new Date(), afterDays)
        // Keyset over chat_messages.id, carried across batches: a compacted
        // message stops matching the candidate predicate, so without the cursor
        // every batch would re-walk the rows the previous batches just cleared.
        const { batchSize, pauseMs, maxRows, maxMessages } = this.compaction
        let afterId = ''
        let drained = false
        let messagesScanned = 0
        while (result.rowsDeleted < maxRows && messagesScanned < maxMessages) {
            // Same reasoning as the retention sweep: losing the lease mid-drain
            // means another instance owns this work now.
            if (!(await this.renewLease())) break
            const limit = Math.min(batchSize, maxMessages - messagesScanned)
            const rows = (await this.db.execute(
                streamLogCandidateQuery(cutoff, afterId, limit)
            )) as Array<{ id: string }>
            if (rows.length === 0) {
                drained = true
                break
            }
            messagesScanned += rows.length
            const ids = rows.map((row) => row.id)
            afterId = ids[ids.length - 1]
            // What is left of the run's row budget, handed to the statement
            // that does the deleting. Counting afterwards is what #672 was:
            // by then the rows are already gone.
            const batch = readStreamLogCompactBatch(
                (await this.db.execute(
                    streamLogCompactStatement(
                        ids,
                        maxRows - result.rowsDeleted,
                        !result.dryRun
                    )
                )) as unknown[]
            )
            // Both figures come from the statement's own RETURNING rather than
            // from the candidate count: under a truncating budget only a prefix
            // of the batch is compacted, and claiming the rest would report
            // turns as compacted that still hold every row they had.
            result.messagesCompacted += batch.messagesCompacted
            result.rowsDeleted += batch.rowsDeleted
            if (
                !result.dryRun &&
                batch.messagesStamped !== batch.messagesCompacted
            )
                this.log.warn(
                    `chat stream log compaction deleted rows for ${batch.messagesCompacted} messages but recorded evidence on ${batch.messagesStamped}`
                )
            // Budget spent. Not `drained`, even when this batch was short:
            // a batch that exactly consumed the budget cannot prove it had
            // nothing left, and reporting a capped run as drained is the one
            // error that would stop the backlog being picked up tomorrow.
            if (result.rowsDeleted >= maxRows) break
            if (rows.length < limit) {
                drained = true
                break
            }
            await pause(pauseMs)
        }
        result.capped =
            !drained &&
            (result.rowsDeleted >= maxRows || messagesScanned >= maxMessages)
        this.telemetry?.event('chat.stream_log.compacted', {
            afterDays,
            messagesCompacted: result.messagesCompacted,
            rowsDeleted: result.rowsDeleted,
            capped: result.capped,
            dryRun: result.dryRun
        })
        if (result.messagesCompacted > 0)
            this.log.log(
                `chat stream log compaction${result.dryRun ? ' dry-run' : ''}: ${result.rowsDeleted} token/thinking rows ${result.dryRun ? 'would be deleted' : 'deleted'} across ${result.messagesCompacted} terminal messages older than ${afterDays}d${result.capped ? ' (run cap hit, backlog continues next run)' : ''}`
            )
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
            // Fail closed: a skipped sweep only delays pruning, while every
            // instance deleting concurrently would contend on the same rows.
            this.log.warn(
                `chat retention lease check failed: ${(err as Error).message}`
            )
            return false
        }
    }

    private async sweepUser(
        userId: string,
        cutoff: Date,
        budget: number
    ): Promise<{ messagesDeleted: number; sourcesCleared: number }> {
        let messagesDeleted = 0
        let sourcesCleared = 0
        while (messagesDeleted < budget) {
            const limit = Math.min(BATCH_SIZE, budget - messagesDeleted)
            const deleted = await this.deleteMessageBatch(
                userId,
                cutoff,
                limit
            )
            messagesDeleted += deleted
            if (deleted < limit) break
            await pause(BATCH_PAUSE_MS)
        }
        while (messagesDeleted + sourcesCleared < budget) {
            const limit = Math.min(
                BATCH_SIZE,
                budget - messagesDeleted - sourcesCleared
            )
            const cleared = await this.clearSourceBatch(userId, cutoff, limit)
            sourcesCleared += cleared
            if (cleared < limit) break
            await pause(BATCH_PAUSE_MS)
        }
        return { messagesDeleted, sourcesCleared }
    }

    private async deleteMessageBatch(
        userId: string,
        cutoff: Date,
        limit: number
    ): Promise<number> {
        const rows = await this.db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.sessionId))
            .where(
                and(
                    eq(chatSessions.userId, userId),
                    lt(chatMessages.createdAt, cutoff),
                    // Never delete a message an inflight turn lock points at:
                    // its stream events are still being inserted against it.
                    sql`${chatMessages.id} is distinct from ${chatSessions.inflightMessageId}`
                )
            )
            .limit(limit)
        if (rows.length === 0) return 0
        await this.db.delete(chatMessages).where(
            inArray(
                chatMessages.id,
                rows.map((r) => r.id)
            )
        )
        return rows.length
    }

    // Same statement, same exemptions as the age-based sweep — only the scope
    // differs. Before this shared the predicate, plan-based retention cleared
    // a payload the age-based sweep would have refused: a turn orphaned while
    // holding chat_sessions.inflight_message_id keeps its message past the
    // plan cutoff (deleteMessageBatch exempts it) and then lost the raw lines
    // its adoption needs.
    private async clearSourceBatch(
        userId: string,
        cutoff: Date,
        limit: number
    ): Promise<number> {
        const batch = readRawClearBatch(
            await this.db.execute(
                rawClearStatement({ kind: 'plan', cutoff, userId }, limit, true)
            )
        )
        return batch.cleared
    }

    private async countUser(
        userId: string,
        cutoff: Date
    ): Promise<{ messages: number; sources: number }> {
        const [msgRow] = await this.db
            .select({ value: count() })
            .from(chatMessages)
            .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.sessionId))
            .where(
                and(
                    eq(chatSessions.userId, userId),
                    lt(chatMessages.createdAt, cutoff),
                    sql`${chatMessages.id} is distinct from ${chatSessions.inflightMessageId}`
                )
            )
        // Counted through the shared predicate so a dry run cannot promise to
        // clear rows the real run would exempt.
        const srcRows = (await this.db.execute(
            countClearableSourceRaw({ kind: 'plan', cutoff, userId })
        )) as Array<{ value: number | string | null }>
        return {
            messages: Number(msgRow?.value ?? 0),
            sources: Number(srcRows[0]?.value ?? 0)
        }
    }
}

const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))
