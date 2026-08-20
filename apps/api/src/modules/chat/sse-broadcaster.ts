import type {
    ChatStreamEvent,
    ChatStreamEventType
} from '@manyfold/shared'
import {
    Injectable,
    Logger,
    Optional,
    type OnApplicationShutdown,
    type OnModuleDestroy
} from '@nestjs/common'
import { sanitizeForJsonb } from '@/common/jsonb-sanitize'
import {
    ChatRepository,
    type TerminalStreamContent
} from '@/modules/chat/chat.repository'
import { ChatStreamBus } from '@/modules/chat/chat-stream-bus'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    TurnFenceLostError,
    type TurnExecutionFence
} from '@/modules/chat/turn-fence'

export type PersistedStreamEventType =
    | Exclude<ChatStreamEventType, 'usage'>
    | 'suspended'

export interface EmittedStreamEvent {
    type: PersistedStreamEventType
    payload: Record<string, unknown>
    sourceEventKey?: string | null
    sourceEventOrdinal?: number | null
    // Transport seq through which EVERYTHING has already been emitted as an
    // earlier row — never the seq of the line being emitted right now. A
    // producer advances it only when a NEW raw_source line arrives, because
    // that is the moment the previous line's derived events are all out, so a
    // row stamped with it truthfully claims "everything through here precedes
    // me". Claiming the current line's seq would claim content still being
    // emitted. See chat_stream_events.runner_seq.
    runnerSeq?: number | null
}

export interface BroadcastSubscriber {
    send: (event: ChatStreamEvent) => void
    close: () => void
}

interface PendingTokenBuffer {
    kind: 'token' | 'thinking'
    text: string
    seq: number
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
    runnerSeq: number | null
    createdAt: Date
    startedAt: number
}

interface ActiveStream {
    sessionId: string
    messageId: string
    seq: number
    ended: boolean
    // The turn ownership this stream's writes are conditional on, if the turn
    // has a durable execution row. Every row, checkpoint and terminal carries
    // it into the statement that writes it, so a carrier that lost the turn
    // stops at the database rather than at whatever it next thinks to check.
    fence: TurnExecutionFence | null
    // Latched the first time a write comes back fence-rejected. Distinct from
    // `failed` (which it also sets) because the reaction differs: a turn this
    // process no longer owns must not be terminalized, released or cancelled
    // by it — every one of those would damage the new owner's turn.
    fenceLost: boolean
    // All DB writes for this stream run through the chain so the trailing
    // flush timer can never interleave with an emit() in flight; ids therefore
    // commit in seq order per stream.
    chain: Promise<void>
    // Settle signals for the chain tasks that have not finished yet, oldest
    // first, and the number of ROWS they will write between them — a
    // non-buffered task writes two when it carries a pending token buffer.
    // emitDetached waits on the HEAD rather than the tail so the queue falls
    // back to the cap instead of to zero; draining to zero would park the
    // producer for a whole queue's worth of commits, which is the opposite of
    // what detaching is for.
    queued: Promise<void>[]
    queuedRows: number
    // First write on this stream to reject, if any. Everything non-terminal
    // queued behind it is abandoned and the next detached emit rethrows it.
    // chat_stream_events.runner_seq claims that everything preceding a
    // durable row is itself durable, and exactResumeSeqForMessage() is
    // max(runner_seq) — so one row failing while the rows behind it land
    // would make a runner resume skip content that never reached the table.
    // Awaiting each write used to make that impossible by stopping the turn;
    // this restores the same guarantee without the await.
    failed: Error | null
    terminalClosed: boolean
    // Id of the last CONTENT-BEARING row this stream has committed, and the
    // only thing settle() is allowed to report. Terminals, `suspended` and
    // `turn_status` deliberately do not advance it: the checkpoint cursor
    // means "everything up to here is already in content_blocks_json", so a
    // cursor that covered a row the content cannot contain would make an
    // attaching subscriber skip it — for a terminal, forever (a UI stuck on
    // a turn that finished).
    lastContentRowId: bigint | null
    // Latched when a row is written whose text starts or ends on half a
    // surrogate pair — the signature of a pair the transport split across two
    // rows. From then on the log and the turn's content blocks disagree by
    // construction and no cursor can pair them: each ROW is sanitised on its
    // own, so the two halves land as two U+FFFD, while the block buffer holds
    // the first half back and rejoins it into the character the model
    // actually emitted. Both are defensible; they are not equal, so the turn
    // gives up the cursor and its readers take the full replay.
    //
    // First and last code unit is the exact test, not an approximation: a
    // lone surrogate in the MIDDLE of a row is lone in the buffer too and
    // both sanitise it identically. O(1) on the hot write path.
    contentDiverged: boolean
    buffer: PendingTokenBuffer | null
    flushTimer: ReturnType<typeof setTimeout> | null
    lastFlushAt: number
}

const sameFence = (
    left: TurnExecutionFence | null,
    right: TurnExecutionFence
): boolean =>
    left?.messageId === right.messageId &&
    left.ownerId === right.ownerId &&
    left.generation === right.generation

// The event types whose payload is folded into the turn's content blocks.
// Everything else is transport or status, and is delivered rather than
// accumulated. See ActiveStream.lastContentRowId.
const CONTENT_ROW_TYPES = new Set<PersistedStreamEventType>([
    'token',
    'thinking',
    'tool_call',
    'tool_result',
    'replace'
])

const isHighSurrogate = (code: number): boolean =>
    code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean =>
    code >= 0xdc00 && code <= 0xdfff

// Every event type whose text the block buffer runs through the STREAMING
// sanitiser (sanitizeStreamDelta), rather than the one-shot one the row gets.
// `replace` belongs here as much as token and thinking do: replaceAnswer()
// installs its text through appendText, so it can leave a carry behind just
// like a token can.
const CARRYING_ROW_TYPES = new Set<PersistedStreamEventType>([
    'token',
    'thinking',
    'replace'
])

// Whether this row's text ends, or begins, mid surrogate pair — the one thing
// the two sanitisers disagree about. See ActiveStream.contentDiverged.
//
// The boundary is found PAST any NULs, not at the raw first and last code
// unit, because both sanitisers strip NUL before either looks at surrogates.
// A row whose text is a high surrogate followed by a NUL ENDS on the NUL,
// yet still leaves the buffer holding half a pair, and reading the raw last
// unit would miss it. Normally one step; only an all-NUL run walks far.
const splitsSurrogatePair = (text: string): boolean => {
    let end = text.length - 1
    while (end >= 0 && text.charCodeAt(end) === 0) end -= 1
    if (end < 0) return false
    if (isHighSurrogate(text.charCodeAt(end))) return true
    // The other half of the same hazard. Redundant while every high half is
    // caught above, and kept anyway: it is the direct signature of a row that
    // opens mid-character, so it still holds if a half ever reaches the table
    // by a path the check above does not see.
    let start = 0
    while (text.charCodeAt(start) === 0) start += 1
    return isLowSurrogate(text.charCodeAt(start))
}

// Whether writing this row puts the durable log permanently out of step with
// the turn's in-memory content blocks.
const divergesFromBuffer = (row: {
    eventType: PersistedStreamEventType
    payload: Record<string, unknown>
}): boolean => {
    if (!CARRYING_ROW_TYPES.has(row.eventType)) return false
    const text = row.payload.text
    if (typeof text !== 'string' || text.length === 0) return false
    return splitsSurrogatePair(text)
}

interface PumpSubscriber {
    subscriber: BroadcastSubscriber
    cursor: bigint
}

interface SessionPump {
    sessionId: string
    subs: Set<PumpSubscriber>
    running: boolean
    dirty: boolean
    // Safety re-poll bookkeeping: NOTIFY is best-effort (a notify sent while
    // the emitter's pool hiccups is warn-and-dropped, one lost in a LISTEN
    // reconnect gap is gone), so subscribed pumps re-poll on a slow tick.
    lastActivityAt: number
    safetyOriginated: boolean
}

const PUMP_BATCH_LIMIT = 200
const PUMP_RETRY_MS = 1000
// Hot pumps (delivered within the window) re-poll every tick — a lost mid-turn
// or terminal NOTIFY costs at most ~2.5s; cold pumps every 6th tick (~15s)
// catches a turn started remotely whose first NOTIFY was lost.
const SAFETY_TICK_MS = 2500
const SAFETY_HOT_WINDOW_MS = 120_000
const SAFETY_COLD_EVERY_TICKS = 6
// A subscriber whose socket has this much unflushed data is not reading;
// disconnect it — the client reconnects with Last-Event-ID and resumes.
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024
// Contiguous token/thinking emits with the same source key coalesce into one
// chat_stream_events row within this window (0 = legacy per-event rows, the
// rollback lever). Same-key-only merging keeps the (messageId, sourceEventKey,
// sourceEventOrdinal) resume-dedup invariant intact — a merged row carries its
// first constituent's key and ordinal. A stream idle longer than the window
// gets a leading-edge immediate write, so first-token latency is unaffected.
const STREAM_FLUSH_WINDOW_MS = (() => {
    const raw = Number(process.env.MF_CHAT_STREAM_FLUSH_MS ?? 120)
    return Number.isFinite(raw) && raw >= 0 ? raw : 120
})()
const STREAM_FLUSH_MAX_CHARS = 8 * 1024
// How many ROWS a stream may have queued but uncommitted before emitDetached
// makes its caller wait. Detaching removes the one-commit-per-event brake on
// the producer, so without a cap a database slower than the sandbox transport
// would grow a backlog for the whole turn.
//
// Counted in rows, not tasks: a non-buffered task also writes the pending
// token buffer it displaced, so a task-based cap would be worth double this
// on a token+tool stream. It governs the detached producer only — a timer
// flush and an awaited emit from another call stack can each add one task on
// top, which is bounded (one buffer, one timer per stream) but is not zero.
//
// 32 is sized against the staleness this stream already accepts: the token
// merge window above deliberately holds content back for 120ms, so a tool row
// arriving inside that same window costs a reader nothing it was not already
// paying. Measured on local pg 16.13 [2026-08-10]: a non-terminal row costs
// 1.08ms end to end (302 rows written serially in 325ms), so a saturated
// stream runs ~35ms ahead of the table, and the cap only starts to bind above
// ~4ms per commit — at which point binding is the point. The queue itself is
// not free (a closure and two promises per task), but the payloads in it are
// already retained by the turn's block buffer.
export const STREAM_MAX_PENDING_ROWS = 32

const bufferRow = (
    buf: PendingTokenBuffer
): {
    seq: number
    eventType: PersistedStreamEventType
    payload: Record<string, unknown>
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
    runnerSeq: number | null
    createdAt: Date
} => ({
    seq: buf.seq,
    eventType: buf.kind,
    payload: { type: buf.kind, text: buf.text },
    sourceEventKey: buf.sourceEventKey,
    sourceEventOrdinal: buf.sourceEventOrdinal,
    // The MAX across the merged run, not the first: the claim is about content
    // emitted before each constituent, and this row contains all of them, so the
    // latest constituent's claim is the strongest one this row can carry. Taking
    // the first would under-claim and force a re-send of content this very row
    // already holds — which is precisely what a delta stream cannot survive.
    runnerSeq: buf.runnerSeq,
    createdAt: buf.createdAt
})

// Delivery is decoupled from emission so it works across API instances:
// emit() persists the event and signals the bus; every instance with local
// subscribers pumps new rows from the DB to them, ordered by event id.
@Injectable()
export class ChatSseBroadcaster
    implements OnApplicationShutdown, OnModuleDestroy
{
    private readonly logger = new Logger(ChatSseBroadcaster.name)
    private readonly pumps = new Map<string, SessionPump>()
    private readonly streams = new Map<string, ActiveStream>()
    private readonly safetyTimer: ReturnType<typeof setInterval>
    private safetyTickCount = 0

    constructor(
        private readonly repo: ChatRepository,
        private readonly bus: ChatStreamBus,
        @Optional() private readonly telemetry?: TelemetryService
    ) {
        this.bus.onMessage((sessionId) => this.kick(sessionId))
        this.bus.onListenEstablished(() => {
            for (const sessionId of [...this.pumps.keys()]) this.kick(sessionId)
        })
        this.safetyTimer = setInterval(() => this.safetyTick(), SAFETY_TICK_MS)
        if (typeof this.safetyTimer.unref === 'function')
            this.safetyTimer.unref()
    }

    onModuleDestroy(): void {
        this.closeSubscribers()
    }

    onApplicationShutdown(): void {
        this.closeSubscribers()
    }

    private closeSubscribers(): void {
        clearInterval(this.safetyTimer)
        for (const pump of this.pumps.values()) {
            for (const sub of pump.subs) {
                try {
                    sub.subscriber.close()
                } catch {}
            }
            pump.subs.clear()
        }
        this.pumps.clear()
    }

    private safetyTick(): void {
        this.safetyTickCount += 1
        const cold = this.safetyTickCount % SAFETY_COLD_EVERY_TICKS === 0
        const now = Date.now()
        for (const pump of this.pumps.values()) {
            if (pump.subs.size === 0) continue
            const hot = now - pump.lastActivityAt < SAFETY_HOT_WINDOW_MS
            if (hot || cold) this.kick(pump.sessionId, 'safety')
        }
    }

    beginStream(
        sessionId: string,
        messageId: string,
        startingSeq = 0,
        fence: TurnExecutionFence | null = null
    ): void {
        this.streams.set(messageId, {
            sessionId,
            messageId,
            seq: startingSeq,
            ended: false,
            fence,
            fenceLost: false,
            chain: Promise.resolve(),
            queued: [],
            queuedRows: 0,
            failed: null,
            terminalClosed: false,
            lastContentRowId: null,
            contentDiverged: false,
            buffer: null,
            flushTimer: null,
            lastFlushAt: 0
        })
    }

    async beginResumeStream(
        sessionId: string,
        messageId: string,
        fence: TurnExecutionFence | null = null
    ): Promise<void> {
        const startingSeq = await this.repo.maxStreamEventSeq(messageId)
        this.beginStream(sessionId, messageId, startingSeq, fence)
    }

    // The dispatch path opens its stream before the runtime is resolved, so the
    // execution row — and with it the generation to write under — does not
    // exist yet. Resume claims refuse a missing row, so nothing else can own
    // the turn in that window; from the stamp on, every write is fenced.
    setStreamFence(messageId: string, fence: TurnExecutionFence): void {
        const stream = this.streams.get(messageId)
        if (stream) stream.fence = fence
    }

    endStream(messageId: string, fence?: TurnExecutionFence): void {
        const stream = this.streams.get(messageId)
        if (fence && (!stream || !sameFence(stream.fence, fence))) return
        if (stream) this.scheduleBufferWrite(stream)
        if (stream) this.deleteStream(stream)
    }

    hasStream(messageId: string): boolean {
        return this.streams.has(messageId)
    }

    // Bring the durable log level with what the caller has already consumed,
    // and report the row id that level reached. The content checkpoint pairs
    // the turn's in-memory blocks with this id, so it has to be sampled at an
    // instant when the two provably describe the same set of events.
    //
    // That instant does not otherwise exist. The in-memory blocks are always
    // AHEAD of the table by construction: token and thinking text sits in the
    // 120ms merge buffer, and non-terminal rows are handed to the write chain
    // without being awaited. Reading max(id) without settling first would
    // yield a cursor that under-covers the content, and an attaching
    // subscriber would then be replayed the overlap on top of content that
    // already holds it — visible as duplicated text, or for a `replace` as
    // the answer being deleted a second time.
    //
    // So: flush the buffer, take a place in the chain as it stands NOW (a task
    // another call stack appends afterwards is not ours to cover), and report
    // the last content row from THERE. Costs one chain drain per checkpoint,
    // which is rare by design — the growth rule fires at +10% of content,
    // never per event — and the checkpoint was already paying for an UPDATE
    // of the whole row.
    async settle(messageId: string): Promise<bigint | null> {
        const stream = this.streams.get(messageId)
        // No stream means the turn already terminalized (emit deletes it on
        // a terminal) or is running on another instance. Either way this
        // process cannot vouch for the pairing.
        if (!stream) return null
        this.scheduleBufferWrite(stream)
        // A zero-row marker on the chain rather than `await stream.chain`
        // then read. The two were the same answer only while the caller
        // blocked its producer until this resolved; since #749 it does not,
        // so rows admitted while this is outstanding queue up BEHIND the
        // marker, and reading after the wait would report them too — a cursor
        // covering events the sampled content cannot contain, which makes an
        // attaching subscriber skip them. Reading at the marker is the same
        // wait for the caller and the exact prefix for the pairing.
        return this.enqueue(stream, 'settle', 0, async () =>
            // A latched failure means rows behind it are being abandoned, so
            // the log has a hole the content does not — no id can describe it.
            stream.terminalClosed
                ? Promise.reject(
                      stream.failed ??
                          new Error(
                              `terminal already persisted for message=${stream.messageId}`
                          )
                  )
                : stream.failed || stream.contentDiverged
                  ? null
                  : stream.lastContentRowId
        )
    }

    // `persisted` reports whether this event's own row reached the table, so a
    // caller can tell a real terminal write from one insertStreamEvent deduped
    // away on sourceEventKey. Only meaningful for non-buffered events: a
    // buffered token reports true on acceptance because its row is written
    // later on the chain. Terminals never buffer.
    //
    // `fenceLost` separates the one not-persisted reason that is not about
    // this event at all: the turn has a new owner and this process must stop.
    async emit(
        messageId: string,
        event: EmittedStreamEvent,
        terminalContent?: TerminalStreamContent
    ): Promise<{ persisted: boolean; fenceLost: boolean }> {
        const stream = this.streams.get(messageId)
        if (!stream) {
            this.logger.warn(
                `dropping event type=${event.type} for messageId=${messageId} (stream not started)`
            )
            return { persisted: false, fenceLost: false }
        }
        if (stream.ended) {
            this.logger.warn(
                `dropping event type=${event.type} for messageId=${messageId} (stream already ended)`
            )
            return { persisted: false, fenceLost: stream.fenceLost }
        }
        if (
            STREAM_FLUSH_WINDOW_MS > 0 &&
            (event.type === 'token' || event.type === 'thinking')
        ) {
            const text = event.payload.text
            if (typeof text === 'string') {
                this.bufferTokenEvent(stream, event.type, text, event)
                return { persisted: true, fenceLost: false }
            }
        }
        // Non-buffered path: everything else (tool events, terminals) first
        // flushes any pending buffer so row order matches emit order, then
        // writes its own row. Terminals keep their dedicated single-row
        // transaction — that is where the inflight turn lock is released.
        const terminal = event.type === 'done' || event.type === 'error'
        // Admission closes HERE, before the first await, not after the
        // terminal's row commits. A producer that is still running during
        // that await — a live adapter racing an offline cancel — would
        // otherwise find a stream that is neither ended nor gone, draw a seq
        // and append its task BEHIND the terminal, and the durable log would
        // end `done, tool_call`. The SSE pump delivers that row and the web
        // client then turns a finished turn live again (#701).
        //
        // Only the flag is set here. The map entry stays until the write
        // settles, so hasStream() keeps reporting true for the whole pending
        // window: the recovery paths that call beginStream() when it reports
        // false would otherwise reopen this message at a fresh seq and write
        // a SECOND terminal — the same divergence from the other side.
        if (terminal) stream.ended = true
        // The buffer snapshot is detached NOW: a later emit may replace
        // stream.buffer before the chain task runs.
        const pending = this.detachBuffer(stream)
        const seq = ++stream.seq
        stream.lastFlushAt = Date.now()
        try {
            const inserted = await this.enqueue(
                stream,
                event.type,
                pending ? 2 : 1,
                async () => {
                    if (pending) await this.writeRow(stream, bufferRow(pending))
                    return this.writeRow(
                        stream,
                        {
                            seq,
                            eventType: event.type,
                            payload: event.payload,
                            sourceEventKey: event.sourceEventKey ?? null,
                            sourceEventOrdinal:
                                event.sourceEventOrdinal ?? null,
                            runnerSeq: event.runnerSeq ?? null,
                            createdAt: new Date()
                        },
                        terminal ? terminalContent : undefined
                    )
                }
            )
            return {
                persisted: inserted.id !== null,
                fenceLost: stream.fenceLost
            }
        } finally {
            // Released on rejection too. A terminal whose write threw leaves
            // no durable terminal, so the turn still needs one: dropping the
            // entry lets a recovery path see hasStream() === false, re-begin
            // the stream past the seqs this attempt burned and try again.
            // Keeping it would refuse every terminal for this message for as
            // long as the process lives.
            if (terminal) this.deleteStream(stream)
        }
    }

    // Hand a NON-TERMINAL event to the stream's write chain and return
    // without waiting for its row to commit, so a producer keeps reading its
    // transport instead of absorbing one commit latency per event. Row order
    // is unaffected: seq is drawn and the chain task appended synchronously
    // inside emit(), exactly as before, and the chain still runs one task at
    // a time. What the caller gives up is knowing WHETHER the row landed, so
    // anything that reads `persisted` — terminals, turn_status — must keep
    // using emit().
    //
    // Giving that up is not the same as the failure being ignored: this call
    // stops observing its own row; the stream does not. The first rejection
    // is latched (see ActiveStream.failed), every non-terminal row queued
    // behind it is abandoned instead of landing over the hole it left, and
    // the next detached admission rethrows it so the producer stops. That
    // stop lands later than the old await's — the rows admitted in between
    // are exactly the ones the abandon discards — and that is why not
    // waiting here costs no durability: the resume cursor is max(runner_seq)
    // over the rows that actually landed, so it can never pass a failed one.
    // Terminals are exempt: a terminal's write releases the session's
    // inflight claim, and a turn that reached a terminal is never a resume
    // cursor's input.
    async emitDetached(
        messageId: string,
        event: EmittedStreamEvent
    ): Promise<boolean> {
        const stream = this.streams.get(messageId)
        // A write already failed on this stream, so the rows behind it are
        // being abandoned and the producer has to stop — exactly what the
        // await used to do for it. See ActiveStream.failed.
        if (stream?.failed) throw stream.failed
        // Admission is SYNCHRONOUS and comes first. emit() draws seq and
        // appends its chain task before its own first await, so this row's
        // place in the order is fixed here — ahead of anything another call
        // stack (an offline cancel's terminal) queues while this call waits
        // for capacity below. Waiting first would let that terminal slot in
        // between, and this row would commit AFTER the turn had ended.
        //
        // enqueue() already logged any rejection; this catch exists only so
        // the detached promise is not an unhandled rejection.
        void this.emit(messageId, event).catch(() => undefined)
        if (!stream) return false
        // Refused rather than admitted — the stream ended, which includes a
        // terminal that closed admission inside the synchronous prefix of the
        // emit above. Nothing was queued, so there is nothing to wait behind,
        // and waiting anyway would park the producer at a cap it no longer
        // contributes to until the whole queue drains.
        if (stream.ended) return false
        // Over capacity: wait on the OLDEST queued write, not the tail, so
        // the depth settles back to the cap and the producer resumes after
        // one commit rather than after the whole queue.
        while (
            stream.queuedRows > STREAM_MAX_PENDING_ROWS &&
            stream.queued.length > 0
        )
            await stream.queued[0]
        if (stream.failed) throw stream.failed
        return true
    }

    private bufferTokenEvent(
        stream: ActiveStream,
        kind: 'token' | 'thinking',
        text: string,
        event: EmittedStreamEvent
    ): void {
        const key = event.sourceEventKey ?? null
        const existing = stream.buffer
        if (
            existing &&
            existing.kind === kind &&
            existing.sourceEventKey === key
        ) {
            existing.text += text
            if (
                typeof event.runnerSeq === 'number' &&
                event.runnerSeq > (existing.runnerSeq ?? 0)
            )
                existing.runnerSeq = event.runnerSeq
        } else {
            // Different kind/key: schedule the previous run's write first so
            // row order matches emit order, then start a fresh run.
            if (existing) this.scheduleBufferWrite(stream)
            stream.buffer = {
                kind,
                text,
                seq: ++stream.seq,
                sourceEventKey: key,
                sourceEventOrdinal: event.sourceEventOrdinal ?? null,
                runnerSeq: event.runnerSeq ?? null,
                createdAt: new Date(),
                startedAt: Date.now()
            }
        }
        const current = stream.buffer
        if (!current) return
        const idle = Date.now() - stream.lastFlushAt >= STREAM_FLUSH_WINDOW_MS
        if (
            current.text.length >= STREAM_FLUSH_MAX_CHARS ||
            (idle && current.text === text)
        ) {
            // Size cap, or leading edge: the stream was quiet, so this event
            // paints immediately instead of waiting out the window.
            this.scheduleBufferWrite(stream)
            return
        }
        if (!stream.flushTimer) {
            const remaining = Math.max(
                10,
                STREAM_FLUSH_WINDOW_MS - (Date.now() - current.startedAt)
            )
            stream.flushTimer = setTimeout(() => {
                stream.flushTimer = null
                this.scheduleBufferWrite(stream)
            }, remaining)
            if (typeof stream.flushTimer.unref === 'function')
                stream.flushTimer.unref()
        }
    }

    // Detach the pending buffer synchronously and queue its write on the
    // stream's chain. Detaching at schedule time (not execution time) is what
    // makes replacing stream.buffer immediately afterwards safe.
    private scheduleBufferWrite(stream: ActiveStream): void {
        const buf = this.detachBuffer(stream)
        if (!buf) return
        // Mark at schedule time (not write completion) so the leading-edge
        // check sees the stream as busy the moment a write is queued.
        stream.lastFlushAt = Date.now()
        void this.enqueue(stream, buf.kind, 1, () =>
            this.writeRow(stream, bufferRow(buf))
        )
    }

    private detachBuffer(stream: ActiveStream): PendingTokenBuffer | null {
        const buf = stream.buffer
        stream.buffer = null
        if (stream.flushTimer) {
            clearTimeout(stream.flushTimer)
            stream.flushTimer = null
        }
        return buf
    }

    private async writeRow(
        stream: ActiveStream,
        row: {
            seq: number
            eventType: PersistedStreamEventType
            payload: Record<string, unknown>
            sourceEventKey: string | null
            sourceEventOrdinal: number | null
            runnerSeq: number | null
            createdAt: Date
        },
        terminalContent?: TerminalStreamContent
    ): Promise<{ id: bigint | null }> {
        // Abandon anything non-terminal queued behind a failed write: see
        // ActiveStream.failed for why a later row landing over an earlier
        // hole is worse than not landing at all. Terminals are exempt —
        // their write is what releases the session's inflight claim, and a
        // turn that reached a terminal is never a resume cursor's input.
        if (
            stream.failed &&
            row.eventType !== 'done' &&
            row.eventType !== 'error'
        )
            return { id: null }
        if (!stream.contentDiverged && divergesFromBuffer(row))
            stream.contentDiverged = true
        const inserted = await this.repo.insertStreamEvent(
            {
                sessionId: stream.sessionId,
                messageId: stream.messageId,
                seq: row.seq,
                eventType: row.eventType,
                payloadJson: sanitizeForJsonb(row.payload),
                sourceEventKey: row.sourceEventKey,
                sourceEventOrdinal: row.sourceEventOrdinal,
                runnerSeq: row.runnerSeq,
                createdAt: row.createdAt
            },
            terminalContent,
            stream.fence ?? undefined
        )
        stream.lastFlushAt = Date.now()
        if (inserted.fenceLost) {
            // Someone else owns the turn now. Latch and stop admitting: the
            // rows behind this one are abandoned like any other failure, and
            // the caller must not convert the stop into a terminal, a released
            // inflight claim or a cancel — all three would land on the new
            // owner's live turn. Dropping the map entry is safe here in a way
            // it is not for a plain failure: a recovery path that re-begins
            // this message writes under the same superseded generation and is
            // rejected again, so the fence, not the map, is the guarantee.
            stream.ended = true
            stream.fenceLost = true
            stream.failed ??= new TurnFenceLostError(stream.messageId)
            this.deleteStream(stream)
            this.telemetry?.event('chat.turn.fence_lost', {
                messageId: stream.messageId,
                sessionId: stream.sessionId,
                eventType: row.eventType
            })
            this.logger.warn(
                `stream write fenced out for message=${stream.messageId} (turn ownership lost); stopping this carrier`
            )
            return inserted
        }
        if (inserted.id === null) {
            if (
                row.eventType !== 'done' &&
                row.eventType !== 'error' &&
                (await this.repo.findTerminalStreamEvent?.(stream.messageId))
            ) {
                stream.terminalClosed = true
                stream.ended = true
                stream.failed ??= new Error(
                    `terminal already persisted for message=${stream.messageId}`
                )
                this.deleteStream(stream)
                return inserted
            }
            // Deduped on (message, sourceEventKey, sourceEventOrdinal). The
            // row was already written by an earlier delivery of this same
            // event — but the turn's block buffer folded it AGAIN, because
            // it folds every event it consumes and cannot see the conflict.
            // So the content now holds the event twice while the log holds
            // it once, and no id describes that: a cursor at the original
            // row under-covers content that is one application ahead, and
            // the tail would land on top of it. Permanent, so it latches.
            if (CONTENT_ROW_TYPES.has(row.eventType))
                stream.contentDiverged = true
            return inserted
        }
        if (CONTENT_ROW_TYPES.has(row.eventType))
            stream.lastContentRowId = inserted.id
        this.bus.notify(stream.sessionId)
        this.kick(stream.sessionId)
        return inserted
    }

    // The chain's own handler latches the first failure, retires the queue
    // slot and swallows the rejection, which is what lets a detached caller
    // walk away: `next` is never an unhandled rejection, and the terminal
    // still runs and still reports its own fate. Tasks settle in chain order,
    // so the queue is a true FIFO and shifting its head is correct.
    private enqueue<T>(
        stream: ActiveStream,
        label: string,
        rows: number,
        task: () => Promise<T>
    ): Promise<T> {
        const next = stream.chain.then(task, task)
        const settled = next.then(
            () => undefined,
            (err: Error) => {
                stream.failed ??= err
                this.logger.warn(
                    `stream ${label} write failed for message=${stream.messageId}: ${err.message}`
                )
            }
        )
        stream.chain = settled
        stream.queued.push(settled)
        stream.queuedRows += rows
        void settled.then(() => {
            stream.queued.shift()
            stream.queuedRows -= rows
        })
        return next
    }

    private deleteStream(stream: ActiveStream): void {
        if (this.streams.get(stream.messageId) === stream)
            this.streams.delete(stream.messageId)
    }

    async subscribe(
        sessionId: string,
        subscriber: BroadcastSubscriber,
        lastEventId: string | null,
        replayMessageId: string | null = null
    ): Promise<() => void> {
        const cursor = await this.initialCursor(
            sessionId,
            lastEventId,
            replayMessageId
        )
        let pump = this.pumps.get(sessionId)
        if (!pump) {
            pump = {
                sessionId,
                subs: new Set(),
                running: false,
                dirty: false,
                lastActivityAt: Date.now(),
                safetyOriginated: false
            }
            this.pumps.set(sessionId, pump)
        }
        const entry: PumpSubscriber = { subscriber, cursor }
        pump.subs.add(entry)
        this.kick(sessionId)
        return (): void => {
            const current = this.pumps.get(sessionId)
            if (!current) return
            current.subs.delete(entry)
            if (current.subs.size === 0 && !current.running)
                this.pumps.delete(sessionId)
        }
    }

    private async initialCursor(
        sessionId: string,
        lastEventId: string | null,
        replayMessageId: string | null
    ): Promise<bigint> {
        if (lastEventId !== null && lastEventId !== '') {
            try {
                return BigInt(lastEventId)
            } catch {
                /* invalid client cursor; fall through to fresh attach */
            }
        }
        // Cold-reload replay: the client names the turn it wants replayed from
        // the start, so a turn that finished between the message-page fetch and
        // this subscribe still delivers its terminal event (no stuck UI).
        if (replayMessageId)
            return this.repo.streamReplayCursor(sessionId, replayMessageId)
        // One statement snapshot makes the fallback safe in both directions:
        // a later turn is after maxEventId, while a seen inflight identity
        // remains safe to replay even if it terminalizes before the next read.
        const anchor = await this.repo.streamAttachAnchor(sessionId)
        if (anchor.inflightMessageId) {
            const firstId = await this.repo.minStreamEventId(
                anchor.inflightMessageId
            )
            if (firstId !== null) return firstId - 1n
        }
        return anchor.maxEventId
    }

    private kick(
        sessionId: string,
        source: 'normal' | 'safety' = 'normal'
    ): void {
        const pump = this.pumps.get(sessionId)
        if (!pump || pump.subs.size === 0) return
        if (source === 'normal') pump.safetyOriginated = false
        if (pump.running) {
            pump.dirty = true
            return
        }
        pump.safetyOriginated = source === 'safety'
        pump.running = true
        void this.runPump(pump)
    }

    private async runPump(pump: SessionPump): Promise<void> {
        try {
            let again = true
            while (again && pump.subs.size > 0) {
                pump.dirty = false
                let minCursor: bigint | null = null
                for (const sub of pump.subs)
                    if (minCursor === null || sub.cursor < minCursor)
                        minCursor = sub.cursor
                if (minCursor === null) break
                const rows = await this.repo.listSessionStreamEventsSince(
                    pump.sessionId,
                    minCursor,
                    PUMP_BATCH_LIMIT
                )
                if (rows.length > 0) {
                    pump.lastActivityAt = Date.now()
                    if (pump.safetyOriginated) {
                        pump.safetyOriginated = false
                        // Proof of a lost NOTIFY in prod: delivery happened on
                        // the re-poll, not on a bus wakeup.
                        this.logger.warn(
                            `safety re-poll recovered ${rows.length} events for session=${pump.sessionId}`
                        )
                        this.telemetry?.event(
                            'chat.sse.safety_kick_recovered',
                            {
                                sessionId: pump.sessionId,
                                rows: rows.length
                            }
                        )
                    }
                }
                for (const row of rows) {
                    const event = this.materialize(
                        {
                            type: row.eventType as PersistedStreamEventType,
                            payload: row.payloadJson as Record<string, unknown>
                        },
                        row.id,
                        row.sessionId,
                        row.messageId,
                        row.seq,
                        row.createdAt.toISOString()
                    )
                    for (const sub of [...pump.subs]) {
                        if (sub.cursor >= row.id) continue
                        try {
                            sub.subscriber.send(event)
                            sub.cursor = row.id
                        } catch (err) {
                            // A send that throws means the socket is gone or
                            // wedged; keeping the subscriber would deliver to
                            // it forever. Drop it — the client resumes via
                            // Last-Event-ID on reconnect.
                            this.logger.warn(
                                `subscriber send failed, dropping subscriber: ${(err as Error).message}`
                            )
                            pump.subs.delete(sub)
                            try {
                                sub.subscriber.close()
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                }
                again = pump.dirty || rows.length === PUMP_BATCH_LIMIT
            }
        } catch (err) {
            this.logger.warn(
                `stream pump failed for session=${pump.sessionId}: ${(err as Error).message}`
            )
            if (pump.subs.size > 0)
                setTimeout(
                    () => this.kick(pump.sessionId),
                    PUMP_RETRY_MS
                ).unref()
        } finally {
            pump.running = false
            if (pump.subs.size === 0) this.pumps.delete(pump.sessionId)
            else if (pump.dirty) this.kick(pump.sessionId)
        }
    }

    private materialize(
        event: EmittedStreamEvent,
        eventIdBig: bigint,
        sessionId: string,
        messageId: string,
        seq: number,
        createdAt: string
    ): ChatStreamEvent {
        const base = {
            eventId: String(eventIdBig),
            sessionId,
            messageId,
            seq,
            createdAt
        }
        return {
            ...(event.payload as object),
            ...base,
            type: event.type
        } as ChatStreamEvent
    }
}
