import type {
    AgentFramework,
    AgentModelConfig,
    AgentRuntime,
    ChannelProviderName,
    ChatCapabilities,
    ChatError,
    ChatMessage,
    ChatUsage,
    ClaudeCodePermissionMode,
    CodexPermissionMode,
    HermesPermissionMode,
    RuntimeLocalTuning
} from '@manyfold/shared'
import { eq } from 'drizzle-orm'
import { DaemonRpcResponseError } from '@/modules/daemon/daemon-registry.service'
import { runtimeHosts, type Database } from '@manyfold/db'
import type { Agent } from '@manyfold/db'
import type { ManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import type { TurnExecutionFence } from '@/modules/chat/turn-fence'

// Whether the daemon's CLI advertised a capability in its last heartbeat
// (runtime_hosts.client_features). Gates per-daemon transport choices — a
// turn.start sent to a CLI that predates it would fail the turn with
// `not_implemented`, so the caller must fall back when this is false. Throws
// are the CALLER's problem: a broken lookup must not silently read as
// "feature absent" (that shape of failure hid a non-working resume once).
export const daemonAdvertisesFeature = async (
    db: Database,
    daemonId: string,
    feature: string
): Promise<boolean> => {
    const [row] = await db
        .select({ clientFeatures: runtimeHosts.clientFeatures })
        .from(runtimeHosts)
        .where(eq(runtimeHosts.id, daemonId))
        .limit(1)
    return ((row?.clientFeatures as string[] | null) ?? []).includes(feature)
}

// Filled in by adapters as the turn progresses; runAdapter folds the spans
// into the per-turn terminal telemetry. All values are Date.now() timestamps
// except setupMs. Optional everywhere so non-exec adapters can ignore it.
export interface ChatTurnTimings {
    // credential/admission/env assembly (forAgent) duration
    setupMs?: number
    // when the exec was dispatched to the runtime (driver.stream call)
    execDispatchedAt?: number
    // first stdout chunk from the agent process — dispatch→here covers WS
    // connect + VM resume + CLI boot + first line
    firstStdoutAt?: number
}

// Structured source of a channel-driven inbound turn. Present only when the
// channel opted into agentManagedReply: the narranexus adapter maps it into
// channel_provider/channel_context so the agent replies through its own
// channel tools instead of Manyfold posting the text back. Carries the
// Manyfold provider id; the NarraNexus name mapping lives in the adapter.
export interface ChannelSource {
    provider: ChannelProviderName
    chatId: string
    chatType: 'private' | 'group'
    senderId: string
    senderName?: string | null
    messageId?: string | null
    threadId?: string | null
    replyToMessageId?: string | null
    isMention?: boolean
    // wechat only: the iLink context_token that wechat_send needs to address
    // this peer. A reply credential, not an identifier — only ever set for a
    // channel that already opted into agentManagedReply.
    replyToken?: string | null
    // This channel row mirrors a NarraNexus binding (channels.origin), which is
    // what makes a matrix row mean narramessenger rather than a user's own
    // Matrix connector.
    mirrored?: boolean
}

export interface ApiChatAdapterContext {
    userId: string
    agentId: string
    runtimeId: string | null
    sessionId: string
    messageId: string
    framework: AgentFramework
    runtimeKind: AgentRuntime
    model: string | null
    modelOverride: string | null
    // The provider row serving this turn and its built-in catalog id, when
    // known. Optional so test fixtures stay small; adapters forward them into
    // cost computation so per-provider price scopes apply to the live number.
    modelProviderId?: string | null
    modelProviderBuiltInId?: string | null
    modelConfig: AgentModelConfig | null
    // Runtime-local turns keep modelConfig null (adapters read a set
    // modelConfig as "inject platform credentials"), so the CLI flags that
    // carry no credential arrive here instead.
    runtimeLocalTuning?: RuntimeLocalTuning | null
    claudeCodePermissionMode: ClaudeCodePermissionMode | null
    codexPermissionMode: CodexPermissionMode | null
    hermesPermissionMode: HermesPermissionMode | null
    frameworkSessionRef: string | null
    history: ChatMessage[]
    abortSignal?: AbortSignal
    turnFence?: TurnExecutionFence
    // Row already loaded by the turn pipeline; adapters pass it to
    // ExecDriverFactory.forAgent to skip a duplicate agents read.
    agent?: Agent
    channelSource?: ChannelSource | null
    timings?: ChatTurnTimings
    // Sprite runtime only: fired once with the exec session id so the turn
    // pipeline can persist it (turn_executions) for cross-instance adoption.
    onExecSession?: (execSessionId: string) => void
    // External runtime twin of onExecSession: fired as soon as the upstream
    // stream reveals the handles that name this turn's work (Dify task/message
    // id, A2A task id), so a peer instance can ask the upstream how the turn
    // ended after a deploy kills the relay. Fires more than once when the
    // halves arrive on different chunks; the sink merges.
    //
    // A DURABILITY BARRIER, not a notification: the adapter awaits this before
    // it consumes the next provider event, so the returned promise must settle
    // only once the merge write is durable. A sink that resolved early (the
    // fire-and-forget it replaces) let the next token, the terminal, the
    // shutdown handoff and even a peer's adoption all overtake the write, and a
    // peer claiming the turn then found a null ref and could only write
    // `server_restart` — the exact window this ref exists to close. Calls are
    // serialized by that await, so a sink never sees two writes in flight.
    // Abort may end the wait without consuming another provider event. The sink
    // must never reject: losing the recovery handle is not a reason to lose a
    // turn whose answer is still streaming.
    onUpstreamRef?: (ref: {
        taskId?: string | null
        upstreamMessageId?: string | null
    }) => void | Promise<void>
    // When set, this turn runs through the sprite's own runner over the daemon
    // transport rather than a direct sprite exec. The turn is already stamped
    // with daemon_id/daemon_exec_ref by then, so it is resumable.
    runnerDaemonId?: string | null
}

export type EmittedTokenEvent = { type: 'token'; text: string }
export type EmittedToolCallEvent = {
    type: 'tool_call'
    toolCallId: string
    toolName: string
    args: unknown
    elapsedMs?: number
}
export type EmittedToolResultEvent = {
    type: 'tool_result'
    toolCallId: string
    result: unknown
    elapsedMs?: number
}
export type EmittedThinkingEvent = { type: 'thinking'; text: string }
// Supersedes every answer token so far this turn (Dify output moderation).
export type EmittedReplaceEvent = {
    type: 'replace'
    text: string
    reason: string
}
export type EmittedUsageEvent = { type: 'usage'; usage: ChatUsage }
// Context-window pressure ({used} of {size} tokens), not billing. Adapter-
// internal: runAdapter folds the last one into the message metadata instead
// of persisting it as a stream event.
export type EmittedContextUsageEvent = {
    type: 'context_usage'
    context: { size: number; used: number }
}
// A hermes ask surfaced to the user (interactive permission modes), and its
// settlement. Both persist as stream events AND fold into content blocks, so
// the card survives reconnects and history exactly like tool_call/tool_result.
export type EmittedPermissionRequestEvent = {
    type: 'permission_request'
    requestId: string
    toolCallId: string | null
    title: string
    detail: string | null
    options: Array<{ optionId: string; name: string; kind: string }>
}
export type EmittedPermissionResolutionEvent = {
    type: 'permission_resolution'
    requestId: string
    outcome: 'selected' | 'timeout' | 'cancelled'
    optionId: string | null
}
export type { ManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
export type EmittedErrorEvent = {
    type: 'error'
    error: ChatError
    managedChannelFailure?: ManagedChannelFailureSignal
}
export type EmittedDoneEvent = { type: 'done'; finalMessageId: string }
export type RawMessageSourceFormat = 'jsonl' | 'json' | 'sqlite_row'
export interface RawMessageSourcePayload {
    sourceRef?: string | null
    sourceFile?: string | null
    sourceSeq: number
    externalId?: string | null
    parentExternalId?: string | null
    rawFormat: RawMessageSourceFormat
    rawText?: string | null
    rawJson?: unknown
    parserName: string
    parserVersion: string
}
export type EmittedRawSourceEvent = {
    type: 'raw_source'
    source: RawMessageSourcePayload
    // Transport sequence of the runner event that carried this raw line, when
    // the transport has one (daemon/runner exec streams). Deliberately OUTSIDE
    // `source`: it is not part of the raw payload, so it can never perturb
    // rawSha256 / sourceEventKey and therefore never breaks replay dedup.
    runnerSeq?: number
}
export type EmittedSuspendedEvent = {
    type: 'suspended'
    daemonId: string
    daemonExecRef: string
    reason: string
}

export type EmittedChatEvent =
    | EmittedTokenEvent
    | EmittedToolCallEvent
    | EmittedToolResultEvent
    | EmittedThinkingEvent
    | EmittedReplaceEvent
    | EmittedUsageEvent
    | EmittedContextUsageEvent
    | EmittedPermissionRequestEvent
    | EmittedPermissionResolutionEvent
    | EmittedErrorEvent
    | EmittedDoneEvent
    | EmittedRawSourceEvent
    | EmittedSuspendedEvent

export interface ApiChatResumeContext extends ApiChatAdapterContext {
    daemonExecRef: string
    daemonId: string
    fromSeq: number
}

// What an adopted external turn knows about itself. Deliberately not an
// ApiChatAdapterContext: nothing is re-sent upstream, so the model, history and
// permission modes of the original turn are all irrelevant — only the handles
// that identify the work already running there.
export interface ApiChatConvergeContext {
    userId: string
    agentId: string
    sessionId: string
    messageId: string
    frameworkSessionRef: string | null
    upstreamTaskId: string | null
    upstreamMessageId: string | null
    abortSignal: AbortSignal
}

export interface ApiChatAdapter {
    readonly framework: AgentFramework
    getCapabilities(): ChatCapabilities
    sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent>
    resumeMessage?(ctx: ApiChatResumeContext): AsyncIterable<EmittedChatEvent>
    // Finish a turn this instance never started, by polling the upstream for
    // its outcome. Returns null when this turn cannot honestly be converged
    // (framework has no query API, or the refs were never captured) so the
    // caller falls back to the retryable server_restart terminal instead of
    // holding a turn open on a recovery that can never land.
    convergeTurn?(
        ctx: ApiChatConvergeContext
    ): AsyncIterable<EmittedChatEvent> | null
}

// "The socket carrying this exec is gone, but the daemon may well still be
// running the work and will report the stream in its next hello." Every one of
// these must SUSPEND a daemon-carried turn, never terminalize it: a terminal
// makes the turn unfindable by the resume path, so the daemon finishes the
// answer and has nowhere to hand it back.
//
// `connection replaced` is the reconnect itself — the daemon re-registering
// fails the pending RPCs on the socket it just superseded. It read as a hard
// error, so a mid-turn reconnect (the exact thing an api restart causes, and
// what a flaky user daemon does routinely) failed the turn one second before
// the recovery path would have picked it up. Seen on staging 2026-07-26:
// restart → `claude_exec_failed: connection replaced` → dead turn.
type DaemonErrorInput = string | Error

const daemonErrorMessage = (error: DaemonErrorInput): string =>
    typeof error === 'string' ? error : error.message

export const isDaemonOfflineTransportError = (
    error: DaemonErrorInput
): boolean => {
    if (error instanceof DaemonRpcResponseError) return false
    const message = daemonErrorMessage(error)
    const m = message.toLowerCase()
    return (
        m.includes('connection replaced') ||
        m.includes('connection closed') ||
        m.includes('daemon disconnected') ||
        // The cross-instance rpc broker rejects its pending requests with this
        // when ITS process is shutting down — the daemon and the work are fine,
        // only the relay died. Seen on staging 2026-07-29: a rolling restart
        // killed a hermes turn whose exec socket lived on the peer instance.
        m.includes('rpc broker shutting down')
    )
}

// The opposite half: the rpc never reached the daemon at all. All three are
// thrown by the *lookup*, before any frame goes on the wire — the connection
// map had no socket (streamRpcLocal / rpcLocal), or the rpc lease named an
// instance that turned out not to hold one (resolveRemoteInbox). Nothing
// started on the runner, so there is no stream for a later hello to report and
// the resume path can never match this turn.
//
// These used to sit in the list above, which parked such a turn as `suspended`
// waiting for a resume that could not exist.
// Seen on staging 2026-08-03: an instance died on an unhandled rejection, its
// rpc lease kept naming it, and two codex turns dispatched seconds later got
// `daemon dh_… is not connected` from the restarted (socket-less) owner. Both
// were suspended having emitted zero
// tokens, and only terminalized five minutes later when the unmatched-turn
// sweep aged them past its 60s floor. Failing retryably instead lets the caller
// re-send at once — and it is safe to re-send precisely because nothing ran.
export const isDaemonNotDispatchedError = (
    error: DaemonErrorInput
): boolean => {
    if (error instanceof DaemonRpcResponseError) return false
    const message = daemonErrorMessage(error)
    // Ambiguity favours suspend: a mid-stream loss must never be downgraded to
    // a failure, because that discards output the daemon may still hand back.
    if (isDaemonOfflineTransportError(message)) return false
    const m = message.toLowerCase()
    return (
        m.includes('is offline; no active websocket') ||
        m.includes('is not connected') ||
        m.includes('websocket lease is stale')
    )
}

// A resume attach reverses the burden of proof. The lookup errors above mean
// "never dispatched" ONLY for the initial send; on a resume the daemon's hello
// has ALREADY reported the stream and the DB holds its runner frames, so a
// lookup that finds no usable socket means the connection died between hello
// and attach. The buffer is still on the daemon and the next hello will report
// it again — suspend and wait. Terminalizing here writes a permanent failure
// over work that provably ran.
// Seen on staging 2026-08-05: a pong timeout landed while a queued resume
// waited behind a long-lived peer, the attach hit the dead socket's
// `offline; no active websocket` and the turn was terminalized at exact
// runner cursor 56 (#570).
export const isDaemonResumeSuspendError = (error: DaemonErrorInput): boolean =>
    isDaemonOfflineTransportError(error) || isDaemonNotDispatchedError(error)
