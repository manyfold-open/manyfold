import type { ChatContentBlock } from '@manyfold/shared'
import type { Logger } from '@nestjs/common'
import type { TelemetryService } from '@/common/telemetry/telemetry.service'
import type { AssistantContentSnapshot } from '@/modules/chat/assistant-blocks'

// #749. A turn's best-effort content checkpoint, moved off the loop that reads
// the runtime transport.
//
// Seen on staging [2026-08-11]: one checkpoint UPDATE waited 30.327s for a
// PgBouncer connection that was already gone, then failed. The catch that
// makes a failed checkpoint harmless cannot run until the promise settles, so
// for those 30 seconds the adapter loop read no events, wrote no rows and
// delivered nothing — a cache write stalling the product. The turn finished
// correctly; it just stopped moving.
//
// Detaching it is only sound under the constraints the row itself imposes, and
// each is one of the pieces below:
//
//  - content_blocks_json and content_checkpoint_event_id are ONE fact, so the
//    content and the cursor must be sampled at the same instant. The caller
//    passes an immutable snapshot and the cursor taken with it; nothing here
//    ever reads the live buffer.
//  - one carrier has one ordered writer per turn. A snapshot taken while a
//    write is in flight replaces the one waiting behind it — a newer snapshot
//    strictly covers an older one, so the local backlog is one snapshot deep
//    by construction, not by policy. ChatRepository separately serializes the
//    message row across carriers.
//  - the terminal content write is last. fence() drops what is queued and
//    waits out what is in flight locally; the repository refuses a checkpoint
//    that reaches its cross-process lock after the terminal. There is no
//    deadline here on purpose: without real query cancellation, abandoning a
//    slow UPDATE could leave ownership unresolved while terminalization runs.
//  - a write that did not land retires nothing. The bytes stay owed on the
//    buffer, along with the forced flag a `replace` set, so the next
//    checkpoint carries them.
export interface ContentCheckpointer {
    // Sample-time inputs, no wait. Ordering, coalescing and failure are this
    // object's problem from here on, never the caller's.
    enqueue: (
        snapshot: AssistantContentSnapshot,
        cursor: Promise<bigint | null>
    ) => void
    // When the last attempt failed, so the caller's cadence rule can back off
    // a database that is evidently unwell. Null once one has succeeded.
    readonly lastFailureAt: number | null
    // Write out what is owed and wait for it — for a turn this process stops
    // writing without a terminal (suspend), where nothing else is coming.
    drain: () => Promise<void>
    // Drop what is owed and wait out what is in flight — for a turn about to
    // write terminal content, which supersedes every pending snapshot.
    fence: () => Promise<void>
}

// Why a snapshot never became a row. `newer_snapshot` is the healthy case (the
// write behind it covers strictly more); the other two say a stalled or failed
// write ate a checkpoint the cadence had asked for.
type DropReason = 'newer_snapshot' | 'after_failure' | 'terminal_fence'

interface CheckpointJob {
    snapshot: AssistantContentSnapshot
    cursor: Promise<bigint | null>
    queuedAt: number
}

export const createContentCheckpointer = (args: {
    logger: Logger
    telemetry: TelemetryService
    sessionId: string
    messageId: string
    write: (blocks: ChatContentBlock[], cursor: bigint | null) => Promise<void>
    // Retire the debt of a write that landed, and only of one that landed.
    retire: (snapshot: AssistantContentSnapshot) => void
}): ContentCheckpointer => {
    const { logger, telemetry, sessionId, messageId, write, retire } = args
    let inflight: Promise<void> | null = null
    // The whole backlog: one snapshot, latest wins.
    let pending: CheckpointJob | null = null
    let fenced = false
    let lastFailureAt: number | null = null

    const emit = (
        outcome: 'written' | 'failed' | 'dropped',
        job: CheckpointJob,
        attrs: {
            durationMs?: number
            cursored?: boolean
            reason?: DropReason
            error?: string
        }
    ): void =>
        telemetry.event('chat.content.checkpoint', {
            sessionId,
            assistantMessageId: messageId,
            outcome,
            // Sizes and counts, never content. `queuedMs` is what detaching
            // bought: the loop was free for that long, and a run of large
            // values is the stall this exists to make visible.
            blocks: job.snapshot.blocks.length,
            pendingChars: job.snapshot.pendingChars,
            queuedMs: Date.now() - job.queuedAt,
            ...attrs
        })

    const drop = (reason: DropReason): void => {
        if (!pending) return
        emit('dropped', pending, { reason })
        pending = null
    }

    const run = async (job: CheckpointJob): Promise<void> => {
        // The cursor is sampled with the snapshot but RESOLVES here: it is a
        // place in the broadcaster's write chain, so waiting for it is waiting
        // for rows this content already holds. Same trade as the write itself
        // — a sampling that cannot be completed costs a reader one full
        // replay, so it degrades to a cursor-less checkpoint rather than
        // skipping a write that was already due.
        const cursor = await job.cursor
        const startedAt = Date.now()
        try {
            await write(job.snapshot.blocks, cursor)
            retire(job.snapshot)
            lastFailureAt = null
            emit('written', job, {
                cursored: cursor !== null,
                durationMs: Date.now() - startedAt
            })
        } catch (err) {
            lastFailureAt = Date.now()
            // Still a warn as well as an event: this is the line the incident
            // was found on, and a best-effort cache write must not mark the
            // turn's span as an error or page anyone.
            logger.warn(
                `content checkpoint failed for message=${messageId}: ${(err as Error).message}`
            )
            emit('failed', job, {
                cursored: cursor !== null,
                durationMs: Date.now() - startedAt,
                error: (err as Error).message
            })
            // Whatever is waiting was sampled before this failure could be
            // known, so running it now is the retry the backoff exists to
            // refuse. Its bytes are still owed on the buffer, so the next
            // event past the backoff re-samples them — fresher than this.
            drop('after_failure')
        }
    }

    const pump = (): void => {
        if (inflight || !pending) return
        const job = pending
        pending = null
        // The catch is unreachable (run() handles its own write) and stays
        // anyway: nothing about a best-effort checkpoint may be able to
        // reject into a drain() the turn's terminal is waiting on.
        inflight = run(job)
            .catch(() => undefined)
            .finally(() => {
                inflight = null
                pump()
            })
    }

    return {
        enqueue: (snapshot, cursor): void => {
            // Past the fence the terminal content is the row's last word, and
            // a checkpoint accepted here could only land on top of it.
            if (fenced) return
            drop('newer_snapshot')
            pending = {
                snapshot,
                // Neutralised now, not at write time: a superseded job is
                // never awaited, and an unobserved rejection takes the
                // process down. A cursor that cannot be sampled is a
                // cursor-less checkpoint, which is always safe.
                cursor: cursor.catch(() => null),
                queuedAt: Date.now()
            }
            pump()
        },
        get lastFailureAt() {
            return lastFailureAt
        },
        drain: async (): Promise<void> => {
            while (inflight || pending) {
                pump()
                await inflight
            }
        },
        fence: async (): Promise<void> => {
            fenced = true
            drop('terminal_fence')
            while (inflight) await inflight
        }
    }
}
