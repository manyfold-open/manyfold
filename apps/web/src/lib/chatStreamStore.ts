import {
    ChatContentBlock,
    ChatStreamEvent,
    ChatTurnStatusPhase,
    apiPaths
} from '@manyfold/shared'
import { create } from 'zustand'
import {
    appendStreamingBlock,
    contentBlocksToStreamingBlocks,
    type StreamError,
    type StreamingBlock
} from '@/components/chat/utils/streamingBlocks'
import { createTextSmoother, type TextSmoother } from '@/lib/textSmoother'

export type StreamStatus =
    | 'idle'
    | 'connecting'
    | 'streaming'
    | 'suspended'
    | 'cancelling'
    | 'error'
    | 'cancelled'

export type CancelAttempt = symbol

export interface StreamSnapshot {
    streamingAssistantId: string | null
    streamingBlocks: StreamingBlock[]
    streamErrors: StreamError[]
    status: StreamStatus
    error: string | null
    streamStartedAt: number | null
    suspendedReason: string | null
    stalled: boolean
    // #674. A hint, not a status: the server said it is rebuilding this turn.
    // Deliberately outside StreamStatus so the resume ladder, the stall watch
    // and isResumableTurn keep reading exactly the states they always did —
    // recovery only changes the label the user sees. Every event clears it
    // except usage (no user-visible progress) and another turn_status —
    // including suspended, which replaces the label with a truer one.
    //
    // Load-bearing for the presentation (see recoveryLabelKey): because ONLY a
    // turn_status sets this and EVERY suspended clears it, a non-null phase
    // alongside status 'suspended' can only mean the recovery was announced
    // after the device dropped. That ordering is what lets the label outrank a
    // suspension without the reader having to track event order itself.
    recoveryPhase: ChatTurnStatusPhase | null
}

// What the message page already knew about a turn that was still running when
// it was fetched: the checkpointed content, and the stream-event id that
// content is the fold of. The two are one fact and must come from one
// response — a cursor paired with any other snapshot of the content either
// loses the gap between them or renders it twice.
export interface ReplayCheckpoint {
    messageId: string
    eventId: string
    blocks: ChatContentBlock[]
}

export interface StartStreamParams {
    agentId: string
    sessionId: string
    baseUrl: string
    getToken: () => Promise<string>
    onFallback?: () => void
    replayMessageId?: string | null
    replayCheckpoint?: ReplayCheckpoint | null
    initialLastEventId?: string | null
}

interface RuntimeEntry {
    key: string
    agentId: string
    sessionId: string
    baseUrl: string
    getToken: () => Promise<string>
    onFallback?: () => void
    lastEventId: string | null
    replayMessageId: string | null
    replayCheckpoint: ReplayCheckpoint | null
    controller: AbortController | null
    readerActive: boolean
    lastActivityAt: number
    // Drives the stall clock, unlike lastActivityAt which drives LRU eviction
    // and is bumped by a bare attach. Written only by refreshStallWatch — see
    // there for exactly what restarts the silence clock.
    lastDataAt: number
    stallTimer: ReturnType<typeof setTimeout> | null
    reconnectAttempt: number
    reconnectTimer: ReturnType<typeof setTimeout> | null
    terminalSeenForTurn: boolean
    // Every turn this runtime has watched finish, not just the newest. Only
    // adoptReplayTarget reads it, to refuse re-seeding a turn that is over.
    completedMessageIds: Set<string>
    gcTimer: ReturnType<typeof setTimeout> | null
    // Telemetry-only bookkeeping for the current outage, kept separate from
    // reconnectAttempt because that counter is reset by markReconnectFailed
    // while the outage — and the operator's "how long has this tab been
    // stuck" question — continues across the slow-retry ladder.
    disconnectedAt: number | null
    disconnectAttempts: number
    // Stop becomes retryable while an earlier POST may still be in flight. A
    // set preserves every unresolved attempt so one stale failure cannot undo
    // another request that is still pending or has already been accepted.
    cancelAttempts: Set<CancelAttempt>
    cancelAccepted: boolean
}

type ChatStreamDisconnectReason = 'reader_exception' | 'http_status' | 'eof'

type ChatStreamTelemetryContext = {
    agentId: string
    sessionId: string
    messageId: string | null
}

type ChatStreamTelemetryBody =
    | {
          name: 'chat.sse.disconnected'
          reason: ChatStreamDisconnectReason
          status: number | null
          resuming: boolean
          attempt: number
      }
    | { name: 'chat.sse.reconnected'; attempts: number; elapsedMs: number }
    | { name: 'chat.sse.reconnect_failed'; attempts: number; elapsedMs: number }
    | { name: 'chat.sse.stalled'; silentMs: number }

// Mirrors the server-side `chat.sse.*` namespace so a frozen tab (#640) can be
// lined up with the turn the API adopted. Deliberately carries only opaque
// ids — never prompt/response text, titles or user identity — and goes to the
// operational logger, not the consent-gated analytics data layer (ADR-0020).
export type ChatStreamTelemetryEvent = ChatStreamTelemetryContext &
    ChatStreamTelemetryBody

export type ChatStreamTelemetrySink = (event: ChatStreamTelemetryEvent) => void

interface ChatStreamState {
    snapshots: Record<string, StreamSnapshot>
}

const TERMINAL_GC_MS = 10 * 60 * 1000
const MAX_CONCURRENT = 4
// The fast ladder must survive a rolling API deploy (~30-60s of bounced
// connections); after it is exhausted we refetch and keep retrying slowly
// instead of dead-ending the stream.
const MAX_RECONNECT_ATTEMPTS = 8
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
const SLOW_RETRY_MS = 30_000
// A live turn can legitimately be silent for minutes while a tool runs, and the
// server's keepalive comments carry no data, so they cannot vouch for progress
// either. Hint only once the silence is longer than any plausible tool call.
const STALL_HINT_MS = 180_000
const CANCELLED_BY_USER_CODE = 'cancelled_by_user'

const EMPTY_SNAPSHOT: StreamSnapshot = Object.freeze({
    streamingAssistantId: null,
    streamingBlocks: [],
    streamErrors: [],
    status: 'idle' as StreamStatus,
    error: null,
    streamStartedAt: null,
    suspendedReason: null,
    stalled: false,
    recoveryPhase: null
}) as StreamSnapshot

const useChatStreamState = create<ChatStreamState>(() => ({
    snapshots: {}
}))

const runtimes = new Map<string, RuntimeEntry>()

const noTelemetry: ChatStreamTelemetrySink = () => undefined

// Injected rather than imported: the app wires the Axiom logger in at boot,
// while the store itself stays importable from the tsx test runner, where the
// logger's import.meta.env read does not exist.
let telemetrySink: ChatStreamTelemetrySink = noTelemetry

const setTelemetry = (sink: ChatStreamTelemetrySink | null): void => {
    telemetrySink = sink ?? noTelemetry
}

const emitTelemetry = (
    entry: RuntimeEntry,
    body: ChatStreamTelemetryBody
): void => {
    try {
        telemetrySink({
            ...body,
            agentId: entry.agentId,
            sessionId: entry.sessionId,
            messageId: readSnapshot(entry.key).streamingAssistantId
        })
    } catch {
        // Observation must never break the ladder it observes.
    }
}

const resetDisconnectWindow = (entry: RuntimeEntry): void => {
    entry.disconnectedAt = null
    entry.disconnectAttempts = 0
}

const recordDisconnect = (
    entry: RuntimeEntry,
    reason: ChatStreamDisconnectReason,
    status: number | null
): void => {
    if (entry.disconnectedAt === null) entry.disconnectedAt = Date.now()
    entry.disconnectAttempts += 1
    emitTelemetry(entry, {
        name: 'chat.sse.disconnected',
        reason,
        status,
        // Presence only: the cursor value itself adds cardinality without
        // telling an operator anything the seq in the server log does not.
        resuming: entry.lastEventId !== null,
        attempt: entry.disconnectAttempts
    })
}

const keyOf = (agentId: string, sessionId: string): string =>
    `${agentId}:${sessionId}`

const readSnapshot = (key: string): StreamSnapshot =>
    useChatStreamState.getState().snapshots[key] ?? EMPTY_SNAPSHOT

const writeSnapshot = (key: string, next: StreamSnapshot): void => {
    useChatStreamState.setState((state) => ({
        snapshots: { ...state.snapshots, [key]: next }
    }))
}

const patchSnapshot = (
    key: string,
    patch: Partial<StreamSnapshot>
): StreamSnapshot => {
    const next = { ...readSnapshot(key), ...patch }
    writeSnapshot(key, next)
    return next
}

const dropSnapshot = (key: string): void => {
    useChatStreamState.setState((state) => {
        if (!(key in state.snapshots)) return state
        const next = { ...state.snapshots }
        delete next[key]
        return { snapshots: next }
    })
}

const smoothers = new Map<string, TextSmoother>()

const revealTokenText = (key: string, delta: string): void => {
    if (!delta) return
    const snapshot = readSnapshot(key)
    if (
        snapshot.status === 'idle' ||
        snapshot.status === 'error' ||
        snapshot.status === 'cancelled'
    )
        return
    writeSnapshot(key, {
        ...snapshot,
        streamingBlocks: appendStreamingBlock(snapshot.streamingBlocks, {
            kind: 'token',
            text: delta
        })
    })
}

const smootherFor = (key: string): TextSmoother => {
    let smoother = smoothers.get(key)
    if (!smoother) {
        smoother = createTextSmoother((delta) => revealTokenText(key, delta))
        smoothers.set(key, smoother)
    }
    return smoother
}

const resetSmoother = (key: string): void => {
    smoothers.get(key)?.reset()
}

const disposeSmoother = (key: string): void => {
    const smoother = smoothers.get(key)
    if (!smoother) return
    smoother.reset()
    smoothers.delete(key)
}

export const useStreamSnapshot = (key: string | null): StreamSnapshot =>
    useChatStreamState((state) =>
        key ? (state.snapshots[key] ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT
    )

export const useIsAgentStreaming = (agentId: string): boolean =>
    useChatStreamState((state) => {
        const prefix = `${agentId}:`
        for (const key in state.snapshots) {
            if (!key.startsWith(prefix)) continue
            const status = state.snapshots[key].status
            if (
                status === 'connecting' ||
                status === 'streaming' ||
                status === 'suspended' ||
                status === 'cancelling'
            )
                return true
        }
        return false
    })

const ensureRuntime = (
    key: string,
    params: StartStreamParams
): RuntimeEntry => {
    let entry = runtimes.get(key)
    if (!entry) {
        entry = {
            key,
            agentId: params.agentId,
            sessionId: params.sessionId,
            baseUrl: params.baseUrl,
            getToken: params.getToken,
            onFallback: params.onFallback,
            lastEventId: params.replayMessageId
                ? null
                : (params.initialLastEventId ?? null),
            replayMessageId: params.replayMessageId ?? null,
            replayCheckpoint: params.replayCheckpoint ?? null,
            controller: null,
            readerActive: false,
            lastActivityAt: Date.now(),
            lastDataAt: Date.now(),
            stallTimer: null,
            reconnectAttempt: 0,
            reconnectTimer: null,
            terminalSeenForTurn: false,
            completedMessageIds: new Set(),
            gcTimer: null,
            disconnectedAt: null,
            disconnectAttempts: 0,
            cancelAttempts: new Set(),
            cancelAccepted: false
        }
        runtimes.set(key, entry)
    } else {
        entry.getToken = params.getToken
        entry.onFallback = params.onFallback
        entry.baseUrl = params.baseUrl
        adoptReplayTarget(entry, params)
    }
    return entry
}

// A runtime outlives the component that seeded it. LRU eviction aborts the
// reader but deliberately KEEPS the entry, and leaving a session leaves it in
// the map too — so the replay target captured at creation goes stale, and a
// cold revisit to a session whose turn started somewhere else attaches with
// neither a cursor nor a replay id. That is one of the exact cursorless cold
// attaches the checkpoint exists to make cheap, and the server would replay
// the whole turn into it.
//
// Only an entry with nothing in flight may be re-pointed. A live reader, a
// pending reconnect or an established lastEventId each mean this runtime
// already holds a position in the stream, and a page-scoped snapshot must not
// leave a stale replay target sitting on it.
//
// That first clause is defence in depth, not the thing that saves us today:
// getOrStart refuses a live entry before it ever gets here, hydrate refuses
// once lastEventId is set, and runReader refuses a second connection — so no
// test can redden it. It is kept because installing a target that contradicts
// the entry's own position is wrong on its face, and the next caller to reach
// ensureRuntime by another route should not have to rediscover that.
//
// Both checks below are load-bearing, and each has a test.
//
// The in-flight check is what keeps a target from being PLANTED under a live
// reader. getOrStart refuses to act on such an entry, but it reaches here
// first, so without this a page result arriving mid-turn would be stored and
// then hydrated later, after the turn it names has already ended — the
// terminal check cannot undo that, because it declines to overwrite rather
// than clearing, and by then nothing distinguishes the planted target from a
// legitimate one.
//
// The terminal check is the ordering guard. A page clears its inflight state
// one effect AFTER the store sees the terminal, so a re-render inside that
// window arrives carrying a checkpoint for a turn that has just finished, and
// this entry is idle by then — every other condition here would allow it, and
// re-seeding would flash a completed answer back into a live bubble. It reads
// the whole completed SET, not the newest terminal: a delayed page result can
// surface a checkpoint for a turn that finished several turns ago, and one
// slot would have been overwritten by everything since.
const adoptReplayTarget = (
    entry: RuntimeEntry,
    params: StartStreamParams
): void => {
    if (entry.readerActive || entry.reconnectTimer || entry.lastEventId) return
    const messageId = params.replayMessageId ?? null
    if (messageId !== null && entry.completedMessageIds.has(messageId)) return
    entry.replayMessageId = messageId
    entry.replayCheckpoint = params.replayCheckpoint ?? null
    entry.lastEventId = messageId ? null : (params.initialLastEventId ?? null)
}

// Bounded so a long-lived tab cannot grow the set without limit. Sets iterate
// in insertion order, so the oldest id goes first. The cap only ever costs
// what the guard prevents — a flash — and only for a page result older than
// this many completed turns in one session, which no real fetch is.
const COMPLETED_TURN_MEMORY = 64

const rememberCompletedTurn = (
    entry: RuntimeEntry,
    messageId: string
): void => {
    entry.completedMessageIds.add(messageId)
    if (entry.completedMessageIds.size <= COMPLETED_TURN_MEMORY) return
    const oldest = entry.completedMessageIds.values().next().value
    if (oldest !== undefined) entry.completedMessageIds.delete(oldest)
}

// Cold-reload attach: show the working indicator for a turn the message page
// reported as inflight, before the first replayed token lands. Idempotent — if
// replayed events already populated the snapshot, leave them untouched.
//
// When that page also carried a checkpoint for the same turn, the indicator
// starts full rather than empty: the checkpointed blocks become the live
// blocks and the checkpoint's event id becomes the cursor, so runReader
// resumes from it and the connection carries only the tail. The transcript is
// the same either way — the server pairs the two so that the fold of the
// events this skips is exactly the blocks seeded here — but the whole turn no
// longer has to be re-read, re-sent and re-applied on every cold load, and
// the bubble stops being blank until it has been.
//
// Anything unpaired falls back to the replay. Both halves have to be present
// and both have to name THIS turn: a checkpoint for a different message is a
// page and an inflight id that disagree, and seeding from it would show one
// turn's content under another turn's stream.
const hydrateInflightIndicator = (key: string, entry: RuntimeEntry): void => {
    if (!entry.replayMessageId || entry.lastEventId) return
    const snapshot = readSnapshot(key)
    if (snapshot.status !== 'idle' || snapshot.streamingAssistantId !== null)
        return
    // Taking a target here is this runtime's turn boundary — the page-driven
    // twin of beginAssistantTurn, which clears the same flag. adoptReplayTarget
    // only ever stores an id this runtime has not watched finish, and the
    // checks above prove the previous turn has let go of the bubble, so the
    // terminal that ended that turn is spent with it. A runtime outlives its
    // reader, so left standing the flag outlives its own turn: the first drop
    // before THIS turn's first frame — and the tail of a turn inside a long
    // tool call is empty, which is exactly the window a rolling deploy bounces
    // connections through — would read it in isResumableTurn and refuse the
    // ladder outright, stranding the bubble on the seeded content.
    // completedMessageIds is untouched: that set is what refuses a finished
    // turn's checkpoint, and this line only runs on one it has accepted.
    entry.terminalSeenForTurn = false
    const checkpoint =
        entry.replayCheckpoint?.messageId === entry.replayMessageId
            ? entry.replayCheckpoint
            : null
    const blocks = checkpoint
        ? contentBlocksToStreamingBlocks(checkpoint.blocks)
        : []
    // The cursor is load-bearing even when moderation replaced the answer with
    // nothing. The working indicator can represent the empty fold; replaying
    // from event one would briefly render the superseded answer before its
    // replace row arrived.
    if (checkpoint) entry.lastEventId = checkpoint.eventId
    patchSnapshot(key, {
        streamingAssistantId: entry.replayMessageId,
        streamingBlocks: checkpoint ? blocks : snapshot.streamingBlocks,
        // Seeded content is proof the turn is producing, so it reports as
        // streaming without waiting for a frame. The replay path reaches the
        // same state one event later; on a checkpoint attach that event may
        // be minutes away, because the tail of a turn sitting in a long tool
        // call is empty — and "connecting" for the length of a tool call
        // would be a worse answer than the one the same page already had.
        status: blocks.length > 0 ? 'streaming' : 'connecting',
        error: null
    })
    refreshStallWatch(entry)
}

const getOrStart = (params: StartStreamParams): void => {
    const key = keyOf(params.agentId, params.sessionId)
    const entry = ensureRuntime(key, params)
    entry.lastActivityAt = Date.now()
    if (entry.gcTimer) {
        clearTimeout(entry.gcTimer)
        entry.gcTimer = null
    }
    if (entry.readerActive) return
    if (entry.reconnectTimer) return
    const status = readSnapshot(key).status
    if (status === 'error' || status === 'cancelled') return
    hydrateInflightIndicator(key, entry)
    evictLruIfOver(key)
    void runReader(entry)
}

const runReader = async (entry: RuntimeEntry): Promise<void> => {
    if (entry.readerActive) return
    entry.readerActive = true
    // One-shot: only the first cold-load connection forces a replay; once any
    // event sets lastEventId, reconnects resume from it instead.
    const replayMessageId = entry.lastEventId ? null : entry.replayMessageId
    entry.replayMessageId = null
    // Consumed with it. hydrateInflightIndicator has either already turned it
    // into blocks plus a cursor or decided not to; either way a later
    // connection has moved past the point where a stale snapshot of the
    // content could be seeded under live blocks.
    entry.replayCheckpoint = null
    const controller = new AbortController()
    entry.controller = controller
    try {
        const token = await entry.getToken()
        const url = new URL(
            entry.baseUrl +
                apiPaths.AGENT_SESSION_STREAM(entry.agentId, entry.sessionId),
            globalThis.location?.origin
        )
        if (entry.lastEventId)
            url.searchParams.set('lastEventId', entry.lastEventId)
        else if (replayMessageId)
            url.searchParams.set('replayMessageId', replayMessageId)
        const headers: Record<string, string> = token
            ? {
                  Authorization: `Bearer ${token}`,
                  Accept: 'text/event-stream'
              }
            : { Accept: 'text/event-stream' }
        if (entry.lastEventId) headers['Last-Event-ID'] = entry.lastEventId
        const res = await fetch(url.toString(), {
            method: 'GET',
            headers,
            signal: controller.signal
        })
        if (!res.ok || !res.body) {
            handleStreamFailure(
                entry,
                `SSE connection failed: ${res.status}`,
                res.ok || isRetryableHttpStatus(res.status),
                res.status
            )
            return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let boundary = buffer.indexOf('\n\n')
            while (boundary !== -1) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                ingestFrame(entry, frame)
                boundary = buffer.indexOf('\n\n')
            }
        }
        if (!controller.signal.aborted) {
            handleNonTerminalEof(entry)
        }
    } catch (err) {
        if (controller.signal.aborted) return
        if ((err as Error).name === 'AbortError') return
        handleStreamFailure(entry, (err as Error).message, true, null)
    } finally {
        entry.readerActive = false
        if (entry.controller === controller) entry.controller = null
    }
}

const ingestFrame = (entry: RuntimeEntry, frame: string): void => {
    const parsed = parseSseFrame(frame)
    if (!parsed) return
    const event = parsed.event
    entry.lastActivityAt = Date.now()
    // Any frame after a drop — including the terminal one — proves the turn
    // reached this tab again, which is the outcome #640 could not observe.
    if (entry.disconnectedAt !== null) {
        emitTelemetry(entry, {
            name: 'chat.sse.reconnected',
            attempts: entry.disconnectAttempts,
            elapsedMs: Date.now() - entry.disconnectedAt
        })
        resetDisconnectWindow(entry)
    }
    const isTerminal = event.type === 'done' || event.type === 'error'
    if (isTerminal) {
        resetCancelState(entry)
        entry.lastEventId = null
        entry.reconnectAttempt = 0
        entry.terminalSeenForTurn = true
        rememberCompletedTurn(entry, event.messageId)
    } else {
        entry.lastEventId = event.eventId
        entry.reconnectAttempt = 0
        entry.terminalSeenForTurn = false
    }
    let next: StreamSnapshot
    if (event.type === 'token') {
        // Commit metadata now so the responding indicator stays real-time,
        // but defer the visible block text to the smoother so it types out at
        // an even, frame-paced cadence instead of in raw bursts.
        const snapshot = readSnapshot(entry.key)
        next = {
            ...snapshot,
            streamingAssistantId: event.messageId,
            status:
                snapshot.status === 'cancelling' ? 'cancelling' : 'streaming',
            suspendedReason: null,
            recoveryPhase: null
        }
        writeSnapshot(entry.key, next)
        smootherFor(entry.key).push(event.text)
    } else {
        // Reveal any buffered token text before this structural/terminal block
        // so streaming block order matches the wire order.
        smoothers.get(entry.key)?.flush()
        next = applyEventToSnapshot(readSnapshot(entry.key), event)
        writeSnapshot(entry.key, next)
        if (isTerminal) resetSmoother(entry.key)
    }
    if (next.status !== 'error' && entry.gcTimer) {
        clearTimeout(entry.gcTimer)
        entry.gcTimer = null
    }
    refreshStallWatch(entry)
    if (next.status === 'error') scheduleTerminalGc(entry)
}

// A suspended turn is not a stalled one: the user already knows the agent's
// device dropped, so the silence is explained and only the reconnect matters.
const isStallWatchable = (snapshot: StreamSnapshot): boolean =>
    snapshot.streamingAssistantId !== null &&
    (snapshot.status === 'streaming' || snapshot.status === 'connecting')

const clearStallTimer = (entry: RuntimeEntry): void => {
    if (!entry.stallTimer) return
    clearTimeout(entry.stallTimer)
    entry.stallTimer = null
}

// Restarts the silence clock: called at every turn boundary and on every frame
// that carried data, so the armed deadline always measures time since the last
// thing the user could actually see.
const refreshStallWatch = (entry: RuntimeEntry): void => {
    clearStallTimer(entry)
    entry.lastDataAt = Date.now()
    const snapshot = readSnapshot(entry.key)
    if (snapshot.stalled) patchSnapshot(entry.key, { stalled: false })
    if (!isStallWatchable(snapshot)) return
    entry.stallTimer = setTimeout(() => {
        entry.stallTimer = null
        if (!isStallWatchable(readSnapshot(entry.key))) return
        patchSnapshot(entry.key, { stalled: true })
        emitTelemetry(entry, {
            name: 'chat.sse.stalled',
            silentMs: Date.now() - entry.lastDataAt
        })
    }, STALL_HINT_MS)
}

const isResumableTurn = (entry: RuntimeEntry): boolean => {
    if (entry.terminalSeenForTurn) return false
    const snapshot = readSnapshot(entry.key)
    if (snapshot.status === 'error' || snapshot.status === 'cancelled')
        return false
    return (
        snapshot.status === 'connecting' ||
        snapshot.status === 'streaming' ||
        snapshot.status === 'suspended' ||
        snapshot.status === 'cancelling' ||
        snapshot.streamingAssistantId !== null ||
        entry.lastEventId !== null
    )
}

const handleNonTerminalEof = (entry: RuntimeEntry): void => {
    if (!isResumableTurn(entry)) return
    recordDisconnect(entry, 'eof', null)
    scheduleReconnect(entry)
}

// A transport failure mid-turn is indistinguishable from a rolling API deploy
// bouncing the connection: the backend can still adopt and finish the turn, so
// it must enter the same ladder as a clean non-terminal EOF instead of
// terminalizing the runtime after a single fallback that may race the adoption.
const handleStreamFailure = (
    entry: RuntimeEntry,
    message: string,
    retryable: boolean,
    status: number | null
): void => {
    if (retryable && isResumableTurn(entry)) {
        recordDisconnect(
            entry,
            status === null ? 'reader_exception' : 'http_status',
            status
        )
        scheduleReconnect(entry)
        return
    }
    smoothers.get(entry.key)?.flush()
    resetCancelState(entry)
    patchSnapshot(entry.key, { status: 'error', error: message })
    scheduleTerminalGc(entry)
    entry.onFallback?.()
}

// Auth, routing and payload rejections describe the request, not the transport;
// retrying them just burns the ladder against a server that will never answer.
const isRetryableHttpStatus = (status: number): boolean =>
    status >= 500 || status === 408 || status === 425 || status === 429

const reconnectDelayMs = (attempt: number): number =>
    Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)

// A reconnect only re-establishes this tab's transport. It says nothing about
// a cancel the server already accepted, nor about a daemon that is still
// offline — and the resumed stream starts after the suspended event, so that
// state would never be re-sent. Both outlive the reconnect.
const reconnectingStatus = (status: StreamStatus): StreamStatus =>
    status === 'cancelling' || status === 'suspended' ? status : 'connecting'

const scheduleReconnect = (entry: RuntimeEntry): void => {
    if (entry.reconnectTimer) return
    if (entry.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        markReconnectFailed(entry)
        return
    }
    const delay = reconnectDelayMs(entry.reconnectAttempt)
    entry.reconnectAttempt += 1
    const current = readSnapshot(entry.key)
    patchSnapshot(entry.key, {
        status: reconnectingStatus(current.status),
        error: null
    })
    entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null
        const snapshot = readSnapshot(entry.key)
        if (snapshot.status === 'error' || snapshot.status === 'cancelled')
            return
        if (entry.readerActive) return
        evictLruIfOver(entry.key)
        void runReader(entry)
    }, delay)
}

const markReconnectFailed = (entry: RuntimeEntry): void => {
    clearReconnectTimer(entry)
    // The outage window deliberately survives this transition: the slow retry
    // keeps running, so a second reconnect_failed reports cumulative elapsed
    // rather than restarting the clock on a tab that is still stuck.
    if (entry.disconnectedAt !== null)
        emitTelemetry(entry, {
            name: 'chat.sse.reconnect_failed',
            attempts: entry.disconnectAttempts,
            elapsedMs: Date.now() - entry.disconnectedAt
        })
    // The fast ladder is exhausted. The turn may well have finished while we
    // were disconnected, so refetch from the server (a completed turn resolves
    // via acknowledgePersistedMessage, which also cancels the retry below) and
    // keep retrying slowly instead of dead-ending the stream in an error state.
    entry.onFallback?.()
    entry.reconnectAttempt = 0
    const current = readSnapshot(entry.key)
    if (current.status === 'error' || current.status === 'cancelled') return
    patchSnapshot(entry.key, {
        status: reconnectingStatus(current.status),
        error: null
    })
    entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null
        const snapshot = readSnapshot(entry.key)
        if (snapshot.status === 'error' || snapshot.status === 'cancelled')
            return
        if (entry.readerActive) return
        evictLruIfOver(entry.key)
        void runReader(entry)
    }, SLOW_RETRY_MS)
}

const applyEventToSnapshot = (
    snapshot: StreamSnapshot,
    event: ChatStreamEvent
): StreamSnapshot => {
    const activeStatus =
        snapshot.status === 'cancelling' ? 'cancelling' : 'streaming'
    if (event.type === 'token')
        return {
            ...snapshot,
            streamingAssistantId: event.messageId,
            streamingBlocks: appendStreamingBlock(snapshot.streamingBlocks, {
                kind: 'token',
                text: event.text
            }),
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    if (event.type === 'thinking')
        return {
            ...snapshot,
            streamingAssistantId: event.messageId,
            streamingBlocks: appendStreamingBlock(snapshot.streamingBlocks, {
                kind: 'thinking',
                text: event.text
            }),
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    // Output moderation supersedes the answer streamed so far. Drop the token
    // blocks already shown; thinking and tool blocks describe how the turn ran
    // and are not what was moderated.
    if (event.type === 'replace')
        return {
            ...snapshot,
            streamingAssistantId: event.messageId,
            streamingBlocks: [
                ...snapshot.streamingBlocks.filter(
                    (block) => block.kind !== 'token'
                ),
                ...(event.text
                    ? [{ kind: 'token' as const, text: event.text }]
                    : [])
            ],
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    if (event.type === 'tool_call')
        return {
            ...snapshot,
            streamingAssistantId: event.messageId,
            streamingBlocks: [
                ...snapshot.streamingBlocks,
                {
                    kind: 'tool_call',
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: event.args,
                    elapsedMs: event.elapsedMs
                }
            ],
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    if (event.type === 'tool_result')
        return {
            ...snapshot,
            streamingBlocks: [
                ...snapshot.streamingBlocks,
                {
                    kind: 'tool_result',
                    toolCallId: event.toolCallId,
                    result: event.result,
                    elapsedMs: event.elapsedMs
                }
            ],
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    if (event.type === 'permission_request')
        return {
            ...snapshot,
            streamingBlocks: [
                ...snapshot.streamingBlocks,
                {
                    kind: 'permission_request',
                    requestId: event.requestId,
                    toolCallId: event.toolCallId,
                    title: event.title,
                    detail: event.detail,
                    options: event.options
                }
            ],
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    if (event.type === 'permission_resolution')
        return {
            ...snapshot,
            streamingBlocks: [
                ...snapshot.streamingBlocks,
                {
                    kind: 'permission_resolution',
                    requestId: event.requestId,
                    outcome: event.outcome,
                    optionId: event.optionId
                }
            ],
            status: activeStatus,
            suspendedReason: null,
            recoveryPhase: null
        }
    // The turn is alive: the API keeps the row and a resumed or adopted exec
    // appends to the same messageId, so hold every block and wait rather than
    // terminalising the stream or refetching over a turn still in flight.
    if (event.type === 'suspended')
        return {
            ...snapshot,
            status:
                snapshot.status === 'cancelling' ? 'cancelling' : 'suspended',
            suspendedReason: event.reason,
            recoveryPhase: null
        }
    // #674. Informational: the server is rebuilding this turn. It is NOT a
    // terminal and NOT a status change — the turn is still the turn it was, so
    // the reconnect ladder and the composer lock keep seeing whatever state
    // they were already in. It does restart the stall clock like any other
    // frame: a recovery heartbeat is real evidence the turn is still alive.
    if (event.type === 'turn_status')
        return { ...snapshot, recoveryPhase: event.phase }
    if (event.type === 'error') {
        if (event.error.code === CANCELLED_BY_USER_CODE)
            return {
                ...snapshot,
                streamingAssistantId: event.messageId,
                status: 'cancelled',
                error: null,
                suspendedReason: null,
                recoveryPhase: null
            }
        return {
            ...snapshot,
            streamErrors: [
                ...snapshot.streamErrors,
                {
                    id: event.eventId,
                    error: event.error,
                    messageId: event.messageId
                }
            ],
            streamingAssistantId: null,
            streamingBlocks: [],
            status: 'error',
            suspendedReason: null,
            recoveryPhase: null
        }
    }
    if (event.type === 'done')
        return {
            ...snapshot,
            streamingAssistantId: null,
            streamingBlocks: [],
            status: 'idle',
            suspendedReason: null,
            recoveryPhase: null
        }
    return snapshot
}

const parseSseFrame = (
    frame: string
): { event: ChatStreamEvent; eventId: string | null } | null => {
    const dataLines: string[] = []
    let idLine: string | null = null
    for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        if (line.startsWith('id:')) idLine = line.slice(3).trim()
    }
    const body = dataLines.join('\n').trim()
    if (!body) return null
    try {
        const event = JSON.parse(body) as ChatStreamEvent
        return { event, eventId: idLine }
    } catch {
        return null
    }
}

const resetCancelState = (entry: RuntimeEntry): void => {
    entry.cancelAttempts.clear()
    entry.cancelAccepted = false
}

const cancel = (key: string): CancelAttempt | null => {
    const entry = runtimes.get(key)
    if (!entry) return null
    const snapshot = readSnapshot(key)
    if (snapshot.status === 'cancelled' || snapshot.status === 'error')
        return null
    const attempt = Symbol()
    entry.cancelAttempts.add(attempt)
    clearReconnectTimer(entry)
    entry.reconnectAttempt = 0
    entry.terminalSeenForTurn = false
    resetDisconnectWindow(entry)
    if (entry.gcTimer) {
        clearTimeout(entry.gcTimer)
        entry.gcTimer = null
    }
    patchSnapshot(key, {
        status: 'cancelling',
        error: null
    })
    refreshStallWatch(entry)
    if (!entry.readerActive) {
        evictLruIfOver(key)
        void runReader(entry)
    }
    return attempt
}

const cancelMatchingTurn = (
    key: string,
    messageId: string
): CancelAttempt | null => {
    if (readSnapshot(key).streamingAssistantId !== messageId) return null
    return cancel(key)
}

const markTurnPending = (key: string, params: StartStreamParams): void => {
    const entry = ensureRuntime(key, params)
    entry.lastActivityAt = Date.now()
    entry.replayMessageId = null
    entry.replayCheckpoint = null
    clearReconnectTimer(entry)
    entry.reconnectAttempt = 0
    entry.terminalSeenForTurn = false
    resetCancelState(entry)
    resetDisconnectWindow(entry)
    if (entry.gcTimer) {
        clearTimeout(entry.gcTimer)
        entry.gcTimer = null
    }
    patchSnapshot(key, {
        status: 'connecting',
        error: null,
        streamStartedAt: Date.now(),
        suspendedReason: null,
        recoveryPhase: null
    })
    refreshStallWatch(entry)
    resetSmoother(key)
    if (!entry.readerActive) {
        evictLruIfOver(key)
        void runReader(entry)
    }
}

const beginAssistantTurn = (
    key: string,
    params: StartStreamParams,
    messageId: string
): void => {
    const entry = ensureRuntime(key, params)
    entry.lastActivityAt = Date.now()
    entry.replayMessageId = null
    entry.replayCheckpoint = null
    clearReconnectTimer(entry)
    entry.reconnectAttempt = 0
    entry.terminalSeenForTurn = false
    resetCancelState(entry)
    resetDisconnectWindow(entry)
    if (entry.gcTimer) {
        clearTimeout(entry.gcTimer)
        entry.gcTimer = null
    }
    const current = readSnapshot(key)
    const turnActive =
        current.status === 'connecting' ||
        current.status === 'streaming' ||
        current.status === 'suspended' ||
        current.status === 'cancelling'
    patchSnapshot(key, {
        streamingAssistantId: messageId,
        streamingBlocks: [],
        streamErrors: [],
        status: 'connecting',
        error: null,
        streamStartedAt:
            turnActive && current.streamStartedAt != null
                ? current.streamStartedAt
                : Date.now(),
        suspendedReason: null,
        recoveryPhase: null
    })
    refreshStallWatch(entry)
    resetSmoother(key)
    if (!entry.readerActive) {
        evictLruIfOver(key)
        void runReader(entry)
    }
}

const acknowledgePersistedMessage = (key: string, messageId: string): void => {
    const snapshot = readSnapshot(key)
    if (snapshot.streamingAssistantId !== messageId) return
    patchSnapshot(key, {
        streamingAssistantId: null,
        streamingBlocks: [],
        status: 'idle',
        error: null,
        suspendedReason: null,
        recoveryPhase: null,
        stalled: false
    })
    disposeSmoother(key)
    const entry = runtimes.get(key)
    if (!entry) return
    resetCancelState(entry)
    clearStallTimer(entry)
    // The refetch converged the turn, so the outage is over even though no
    // further SSE frame arrived; do not attribute it to the next turn.
    resetDisconnectWindow(entry)
    scheduleTerminalGc(entry)
}

// No assistant message id ever came back, so nothing will arrive on the stream
// to clear this: undo the optimistic pending state instead of leaving the
// composer locked behind a reconnect ladder chasing a message id it never got.
// The reader stays up because it doubles as this session's idle listener.
const abandonPendingTurn = (key: string): void => {
    const snapshot = readSnapshot(key)
    if (snapshot.status !== 'connecting') return
    if (snapshot.streamingAssistantId !== null) return
    patchSnapshot(key, {
        status: 'idle',
        error: null,
        streamStartedAt: null,
        suspendedReason: null,
        recoveryPhase: null,
        stalled: false
    })
    resetSmoother(key)
    const entry = runtimes.get(key)
    if (!entry) return
    resetCancelState(entry)
    clearStallTimer(entry)
    clearReconnectTimer(entry)
    entry.reconnectAttempt = 0
    resetDisconnectWindow(entry)
}

// A non-null suspendedReason is an exact record of the turn being suspended:
// only the suspended event sets it, every live and terminal event clears it,
// and cancel() leaves it alone — so it still describes the turn when the cancel
// comes back rejected. Reporting 'streaming' there would claim Working for a
// turn no device is carrying, and a resume starts after the suspended event, so
// nothing re-sends that state to correct it.
const rolledBackStatus = (snapshot: StreamSnapshot): StreamStatus =>
    snapshot.streamingAssistantId === null
        ? 'idle'
        : snapshot.suspendedReason === null
          ? 'streaming'
          : 'suspended'

// Without an accepted cancel there is no durable cancel_requested_at to
// converge on, so 'cancelling' would never resolve; drop back to the state the
// turn is actually in and let the user fire again.
const cancelRequestSucceeded = (
    key: string,
    attempt: CancelAttempt
): boolean => {
    const entry = runtimes.get(key)
    if (!entry || !entry.cancelAttempts.has(attempt)) return false
    if (readSnapshot(key).status !== 'cancelling') {
        entry.cancelAttempts.delete(attempt)
        return false
    }
    entry.cancelAttempts.clear()
    entry.cancelAccepted = true
    return true
}

const cancelRequestFailed = (key: string, attempt: CancelAttempt): boolean => {
    const entry = runtimes.get(key)
    if (!entry || !entry.cancelAttempts.delete(attempt)) return false
    if (entry.cancelAccepted || entry.cancelAttempts.size > 0) return false
    const snapshot = readSnapshot(key)
    if (snapshot.status !== 'cancelling') return false
    patchSnapshot(key, {
        status: rolledBackStatus(snapshot)
    })
    refreshStallWatch(entry)
    return true
}

const scheduleTerminalGc = (entry: RuntimeEntry): void => {
    clearReconnectTimer(entry)
    clearStallTimer(entry)
    if (entry.gcTimer) clearTimeout(entry.gcTimer)
    entry.gcTimer = setTimeout(() => {
        const current = runtimes.get(entry.key)
        if (!current) return
        if (current.readerActive) return
        runtimes.delete(entry.key)
        dropSnapshot(entry.key)
        disposeSmoother(entry.key)
    }, TERMINAL_GC_MS)
}

const evictLruIfOver = (incomingKey: string): void => {
    let alive = 0
    for (const e of runtimes.values()) {
        if (e.readerActive || e.controller) alive += 1
    }
    if (alive < MAX_CONCURRENT) return
    let oldest: RuntimeEntry | null = null
    for (const e of runtimes.values()) {
        if (e.key === incomingKey) continue
        if (!(e.readerActive || e.controller)) continue
        if (!oldest || e.lastActivityAt < oldest.lastActivityAt) oldest = e
    }
    if (!oldest) return
    oldest.controller?.abort()
    oldest.controller = null
    oldest.readerActive = false
    resetSmoother(oldest.key)
}

const clear = (): void => {
    for (const entry of runtimes.values()) {
        entry.controller?.abort()
        clearReconnectTimer(entry)
        clearStallTimer(entry)
        if (entry.gcTimer) clearTimeout(entry.gcTimer)
    }
    runtimes.clear()
    for (const smoother of smoothers.values()) smoother.reset()
    smoothers.clear()
    useChatStreamState.setState({ snapshots: {} })
}

const clearReconnectTimer = (entry: RuntimeEntry): void => {
    if (!entry.reconnectTimer) return
    clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
}

export const chatStreamStore = {
    keyOf,
    getSnapshot: readSnapshot,
    getOrStart,
    cancel,
    cancelMatchingTurn,
    cancelRequestSucceeded,
    cancelRequestFailed,
    abandonPendingTurn,
    acknowledgePersistedMessage,
    markTurnPending,
    beginAssistantTurn,
    clear,
    setTelemetry
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        for (const entry of runtimes.values()) {
            entry.controller?.abort()
            clearReconnectTimer(entry)
            clearStallTimer(entry)
            if (entry.gcTimer) clearTimeout(entry.gcTimer)
            if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
        }
        for (const smoother of smoothers.values()) smoother.reset()
        smoothers.clear()
        runtimes.clear()
    })
}
