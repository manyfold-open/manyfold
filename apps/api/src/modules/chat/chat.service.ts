import {
    CHAT_ATTACHMENT_MAX_COUNT,
    CHAT_ATTACHMENT_MAX_FILE_BYTES,
    CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
    CHAT_UPLOAD_MAX_COUNT,
    CHAT_UPLOAD_MAX_FILE_BYTES,
    CHAT_UPLOAD_MAX_TOTAL_BYTES,
    DAEMON_FEATURE_TURN_HERMES,
    DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    DEFAULT_CODEX_PERMISSION_MODE,
    createObjectId,
    isObjectId
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentModelConfig,
    AgentModelConfigSource,
    AgentRuntime,
    ChatAttachmentBlock,
    ChatContentBlock,
    ChatContextRefBlock,
    ChatError,
    ChatMessage,
    ChatMessagesPage,
    ChatRole,
    ChatSessionChannelSummary,
    ChatSessionSummary,
    ChatTurnStatusPhase,
    ChatUploadBlock,
    ChatUsage,
    ClaudeCodePermissionMode,
    CodexPermissionMode,
    CreateMessageAttachmentInput,
    CreateMessageContextRefInput,
    CreateMessageUploadInput,
    InferenceProtocol,
    RegenerateMessageResponse,
    RuntimeLocalTuning,
    UserModelProvider,
    UserModelProviderSource
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
    type OnApplicationBootstrap,
    type OnModuleDestroy
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { Inject } from '@nestjs/common'
import {
    agents,
    chatMessages as chatMessagesTable,
    userModelProviders,
    type Agent,
    type AgentUsageEventRow,
    type ChatMessage as DbChatMessage,
    type ChatSession as DbChatSession,
    type Database,
    type TurnExecutionRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    decodeMessageCursor,
    encodeMessageCursor,
    modelFromMessageMetadata,
    normalizeMessageModel,
    normalizeMessagePageLimit
} from '@/modules/chat/message-page'
import {
    ChatRepository,
    type MessageCursor,
    type TerminalStreamContent
} from '@/modules/chat/chat.repository'
import {
    ChatSseBroadcaster,
    type EmittedStreamEvent,
    type PersistedStreamEventType
} from '@/modules/chat/sse-broadcaster'
import { ChatAdapterRegistry } from '@/modules/chat/adapters/adapter-registry.service'
import { daemonAdvertisesFeature } from '@/modules/chat/chat-adapter'
import type {
    ChannelSource,
    ChatTurnTimings,
    EmittedChatEvent,
    EmittedErrorEvent,
    ManagedChannelFailureSignal
} from '@/modules/chat/chat-adapter'
import { UsageService } from '@/modules/usage/usage.service'
import {
    FilesContextBuilder,
    resolveSafePath
} from '@/modules/agents/files/files-context'
import { SpriteStatusSyncService } from '@/modules/agents/sprite-status/sprite-status-sync.service'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    CHAT_STREAM_ERROR_EVENT,
    UNKNOWN_RUNTIME_KIND,
    type ChatFailureRuntimeKind,
    type ChatTurnPhase
} from '@/common/telemetry/chat-failure-taxonomy'
import {
    classifyChatFailureCause,
    explainChatFailureCause
} from '@/modules/chat/chat-failure-cause'
import {
    MANAGED_CHANNEL_GUARD_PORT,
    MANAGED_CHANNEL_UNAVAILABLE_CODE,
    type ManagedChannelAdmission,
    type ManagedChannelGuardPort
} from '@/common/ports/managed-models.ports'
import { AppEventsService } from '@/common/events/app-events.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import {
    DaemonExecResumeService,
    type DaemonResumeOutcome
} from '@/modules/daemon/daemon-exec-resume.service'
import {
    TurnAdoptionService,
    TURN_LEASE_SECONDS,
    TURN_LEASE_RENEW_MS
} from '@/modules/chat/turn-adoption.service'
import {
    RunnerManagerService,
    classifyExecEndpointFailure,
    type RunnerExecFailure,
    type SpriteAwakeHold,
    type SpriteExecFn
} from '@/modules/chat/runner/runner-manager.service'
import {
    SpriteExecHealthService,
    spriteExecHealthConfig,
    type SpriteExecFailureClass
} from '@/modules/agents/sprite-exec-health/sprite-exec-health.service'
import {
    sandboxExecUnavailableStream,
    SPRITE_EXEC_TERMINAL_EVENT,
    type SpriteExecTerminal
} from '@/modules/chat/sprite-exec-terminal'
import { ChatCancelBus } from '@/modules/chat/chat-cancel-bus'
import {
    recoverTurnFromClaudeJsonl,
    type TurnRecoveryVerdict,
    type TurnSeenState
} from '@/modules/chat/recovery/turn-jsonl-recovery'
import { buildSeenStateFromPersisted } from '@/modules/chat/recovery/adoption-seen-state'
import { execSprite, SpritesError } from '@manyfold/sprites'
import {
    createAdoptionInterceptor,
    deliveredBaselineFromStreamEvents,
    type DeliveredBaseline
} from '@/modules/chat/recovery/adoption-interceptor'
import {
    recoverTurnFromCodexRollout,
    type CodexTurnVerdict
} from '@/modules/chat/recovery/turn-codex-rollout-recovery'
import {
    recoverTurnFromGeminiSession,
    type GeminiTurnVerdict
} from '@/modules/chat/recovery/turn-gemini-session-recovery'
import { messageToPromptText } from '@/modules/chat/adapters/message-content'
import type { RecoveryFs } from '@/modules/chat/recovery/recovery-fs'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { buildChatMessageSourceRow } from './raw-message-source'
import { ChatUploadStorageService } from '@/modules/chat/uploads/chat-upload-storage.service'
import {
    resolveTurnBudgets,
    turnBudgetErrorEvent,
    TurnBudgetExceededError,
    withTurnBudgets,
    type TurnBudgets
} from '@/modules/chat/turn-budgets'
import {
    createProcessLoadSampler,
    TURN_CONCURRENCY_GAUGE_MS,
    type ProcessLoadSampler,
    type TurnOrigin
} from '@/modules/chat/turn-concurrency'
import {
    createAssistantBlockBuffer,
    type DurableContentEvent
} from '@/modules/chat/assistant-blocks'
import { createContentCheckpointer } from '@/modules/chat/content-checkpointer'
import { sanitizeForJsonb } from '@/common/jsonb-sanitize'
import {
    TurnFenceLostError,
    TurnOwnershipUnavailableError,
    type TurnExecutionFence
} from '@/modules/chat/turn-fence'

export type ChatTurnObserver = (event: EmittedChatEvent) => void

const durableErrorEvent = (event: EmittedErrorEvent): EmittedErrorEvent => ({
    type: 'error',
    error: event.error
})

export type ChatTurnOutcome =
    | { state: 'missing' }
    | { state: 'running' }
    | { state: 'done'; text: string }
    | { state: 'error'; errorMessage: string; cancelled: boolean }

export interface TurnShutdownResult {
    drainOutcome: 'idle' | 'drained' | 'timeout'
    activeTurnsAtStart: number
    activeTurnsRemaining: number
    handedOffTurns: number
    handoffOutcome:
        | 'not_needed'
        | 'handed_off'
        | 'no_adoptable_turns'
        | 'disabled'
        | 'failed'
}

const CANCELLED_BY_USER_CODE = 'cancelled_by_user'
const CANCELLED_BY_USER_MESSAGE = 'cancelled by user'
const OPENCLAW_REPLAY_FRAMEWORKS = new Set<AgentFramework>([
    'openclaw',
    'narranexus'
])
// The provider-row facts every turn carries. The built-in id scopes prices; the
// managed triple is what the channel breaker and its telemetry key on, and it
// rides on the same read the turn already does.
interface ProviderTurnFacts {
    modelProviderBuiltInId: string | null
    modelProviderSource: UserModelProviderSource | null
    managedBrand: UserModelProvider | null
    inferenceProtocol: InferenceProtocol | null
}
const EMPTY_PROVIDER_FACTS: ProviderTurnFacts = Object.freeze({
    modelProviderBuiltInId: null,
    modelProviderSource: null,
    managedBrand: null,
    inferenceProtocol: null
})
// The `chat.turn.terminal` funnel's closed outcome set, and where the terminal
// was written from. Every durable done/error row has exactly one of these
// events, so the funnel reconciles 1:1 against chat_stream_events (#544).
type TurnTerminalOutcome = 'done' | 'error' | 'cancelled'
type TurnTerminalVia =
    | 'resume'
    | 'adoption'
    | 'resume_unsupported'
    | 'offline_cancel'
    | 'restart_terminal'
// Stable dedup key for the synthetic interrupted terminal: the per-session
// advisory lock plus this key let concurrent subscribes (multi-tab, multiple
// API instances) race to terminalize the same dead turn without inserting two
// error rows — the loser's insert no-ops on chat_stream_events_source_dedup.
const SERVER_RESTART_SOURCE_EVENT_KEY = '__server_restart__'
// Dedup identity for the informational turn_status row (#674), one key per
// phase. Same race protection as the key above — concurrent writers for the
// same recovery attempt collapse onto one row — but keyed per PHASE rather
// than per turn, so a `resuming` can never occupy the slot a later
// `recovering` needs and be silently dropped by the dedup index.
const turnStatusSourceEventKey = (phase: ChatTurnStatusPhase): string =>
    `__turn_status_${phase}__`
// Ordinal for a `resuming` row: a bounded durable transition number. A
// suspension newer than the latest persisted resuming status advances it once;
// otherwise the current value is reused. Instances observing the same state
// derive the same value, so concurrent resumes collapse onto one row, while
// adjacent duplicate suspension rows do not impersonate several attempts. This
// is not an ownership counter: stale cross-replica writers remain #570's fence
// scope.
//
// Capped rather than free-running: a flapping daemon can re-dial without bound,
// and unbounded informational rows are exactly the stream-log growth #672
// measures. Past the cap the phase degrades to the old behaviour — dedup keeps
// the last reachable ordinal — which loses a label, never content.
// `recovering` uses turn_executions.adopt_count instead, which is bounded by
// MAX_ADOPT_ATTEMPTS and starts at 1 (claimTurnForAdoption bumps before the
// adopter ever sees the row) — so each adoption attempt is separately visible.
const MAX_TURN_STATUS_RESUMING_ROWS = 5
// How long after a daemon was last seen we still assume it may re-dial and
// resume its turn. Deliberately much longer than the online threshold: right
// after an api restart nothing is online yet, which is exactly when this
// question gets asked.
const DAEMON_RECONNECT_GRACE_MS = 10 * 60_000
// How long a matched daemon resume waits for the adoption carrier it just
// fenced to let go of the in-process turn slot. Only a bound on a wait that is
// otherwise event-driven: the loser is already fenced out of the database by
// the claim, so overrunning this costs the resume, not correctness — the lease
// it took lapses and the sweep retries.
const PREEMPT_SLOT_RELEASE_TIMEOUT_MS = 10_000
// Periodic (not just bootstrap) so a turn lock left dangling by a crash in the
// brief claim→assistant-insert window recovers without waiting for a restart.
const STALE_INFLIGHT_CLAIM_SWEEP_INTERVAL_MS = 10 * 60 * 1000
// Partial assistant content is checkpointed to the message row while a turn
// streams. The row is a CACHE: chat_stream_events is the authoritative log and
// a recovery rebuilds content by replaying it through the block buffer, so the
// cadence only decides how much of the tail a cold mid-turn reader has to
// replay — never whether content survives.
//
// This used to be a 2s timer, which makes total checkpoint volume grow with
// the turn's DURATION: a turn producing C bytes over D seconds rewrote the
// whole row D/2 times, ~C·D/4 bytes (a 30-minute turn: ~900 rewrites, ~900
// dead row versions). Growth triggers make it grow with the turn's SIZE
// instead — checkpointing every +10% caps the total at ~11·C whatever D is.
const CONTENT_CHECKPOINT_GROWTH_DIVISOR = 10
// Floor under the growth rule: 10% of a few hundred bytes is a few dozen, so
// without it a short turn would checkpoint on nearly every token.
const CONTENT_CHECKPOINT_MIN_CHARS = 8 * 1024
// A tool result is a meaningful durable point, so a tool boundary lowers that
// floor — but NOT the 10% ratio, and never more often than the interval
// below. Lowering the ratio would put the quadratic straight back: a turn
// with hundreds of tool calls would rewrite the whole row hundreds of times,
// which is the cost this replaces.
const CONTENT_CHECKPOINT_TOOL_MIN_CHARS = 1024
const CONTENT_CHECKPOINT_TOOL_MIN_INTERVAL_MS = 5_000
// Slow-content ceiling so a turn that trickles a few bytes for many minutes
// still reaches the row. It is the only rule that can rewrite the row without
// the content having grown, so a flat interval would put a duration-bound
// term back into the total: a 2-hour turn would take D/60s writes of the
// whole row whatever its size. Scaling the interval with content instead
// makes the ceiling's cost flat — one row's worth of bytes per SCALE_CHARS
// held for MAX_INTERVAL_MS, i.e. at most 32 KiB per minute of turn duration
// at any turn size. 60s up to 32 KiB of content, ~6 minutes at 200 kB,
// ~30 minutes at 1 MB — and the tail a reader has to replay is bounded by
// the growth rule regardless, never by how long the ceiling waits.
const CONTENT_CHECKPOINT_MAX_INTERVAL_MS = 60_000
const CONTENT_CHECKPOINT_CEILING_SCALE_CHARS = 32 * 1024
// A checkpoint write that failed leaves its bytes still owed, so the pending
// count and the forced flag survive it — which on their own would retry on
// every subsequent event against a database that is evidently unwell. The
// growth rule cannot throttle that (it is byte-based, and the bytes are
// already past the bar), so a failure gets its own time gate. 2s is what the
// old wall-clock checkpoint retried at, so this is no more traffic than the
// cadence a failing write already used to see.
const CONTENT_CHECKPOINT_RETRY_BACKOFF_MS = 2_000

// The stream events that take the broadcaster's non-buffered path, i.e. the
// ones whose row the adapter loop used to wait on. token and thinking are
// deliberately absent: they merge into the 120ms window and emit() already
// returns without touching the write chain, so detaching them would buy no
// database wait at all and would put an extra promise on the highest-rate
// path in the system.
const DETACHED_STREAM_EVENT_TYPES = new Set<string>([
    'tool_call',
    'tool_result',
    'replace'
])

// The event types whose payload lands in the turn's content blocks, i.e. the
// ones after which a checkpoint has something new to write. Must stay equal
// to CONTENT_ROW_TYPES in the broadcaster: that set decides which rows the
// checkpoint cursor is allowed to cover, and this one decides when the cursor
// is sampled. A type in one and not the other is a pairing that lies.
const CHECKPOINTED_STREAM_EVENT_TYPES = new Set<string>([
    'token',
    'thinking',
    'tool_call',
    'tool_result',
    'replace'
])

export const shouldCheckpointContent = (args: {
    pendingChars: number
    contentChars: number
    sinceCheckpointMs: number
    // null when the last write succeeded or none has been attempted.
    sinceFailureMs: number | null
    toolBoundary: boolean
    forced: boolean
}): boolean => {
    if (
        args.sinceFailureMs !== null &&
        args.sinceFailureMs < CONTENT_CHECKPOINT_RETRY_BACKOFF_MS
    )
        return false
    // Ahead of the pending-bytes check: a replace can REMOVE text without
    // adding any, and that is exactly the case the row must not keep.
    if (args.forced) return true
    // Nothing new since the last write: the row already holds these bytes.
    if (args.pendingChars === 0) return false
    const floor =
        args.toolBoundary &&
        args.sinceCheckpointMs >= CONTENT_CHECKPOINT_TOOL_MIN_INTERVAL_MS
            ? CONTENT_CHECKPOINT_TOOL_MIN_CHARS
            : CONTENT_CHECKPOINT_MIN_CHARS
    const required = Math.max(
        floor,
        Math.ceil(args.contentChars / CONTENT_CHECKPOINT_GROWTH_DIVISOR)
    )
    if (args.pendingChars >= required) return true
    const ceilingMs =
        CONTENT_CHECKPOINT_MAX_INTERVAL_MS *
        Math.max(1, args.contentChars / CONTENT_CHECKPOINT_CEILING_SCALE_CHARS)
    return args.sinceCheckpointMs >= ceilingMs
}
// Owner-side convergence for a cancel whose NOTIFY never landed (bus publish
// rejected, LISTEN not yet established, connection dropped). Mirrors the
// broadcaster's safety re-poll cadence, and costs one primary-key lookup per
// tick only while this instance actually runs turns — so a lost notification
// converges to cancelled_by_user within one tick instead of never. The content
// checkpoint cannot carry this: it only fires when the adapter yields, and a
// turn worth cancelling is usually the one that has gone quiet.
const CANCEL_CONVERGENCE_TICK_MS = 2500
// A composer-focus prewarm holds per agent for this long; the ~1s VM resume
// finishing anywhere inside typing time is all it needs to accomplish.
const PREWARM_DEBOUNCE_MS = 45_000
// Turn adoption re-poll: a turn that was still generating when it was adopted
// has a non-terminal transcript. Rather than closing it out with a retryable
// error, the adopter holds the lease and re-reads the transcript until it goes
// terminal — so a turn that will finish DOES finish under its original id. The
// stall detector gives up early if the transcript stops growing (the agent
// really died mid-turn); the budget bounds a pathologically long turn.
const ADOPT_REPOLL_INTERVAL_MS = 5_000
// Consecutive polls with no transcript growth ⇒ the turn is not progressing.
const ADOPT_REPOLL_STALL_LIMIT = 4
// Consecutive transcript-read failures (e.g. file missing) ⇒ unrecoverable.
const ADOPT_REPOLL_FAILED_LIMIT = 6
const ADOPT_REPOLL_MAX_MS = (() => {
    const raw = Number(process.env.MF_TURN_ADOPT_REPOLL_MS ?? 600_000)
    return Number.isFinite(raw) && raw >= 0 ? raw : 600_000
})()
// Resume a runner stream from the last durably-recorded transport seq instead
// of replaying the whole turn. Default OFF: it changes the one runtime whose
// mid-turn recovery is already seamless (daemon), so it flips on only after a
// real daemon restart drill. See resumeFromSeq().
const RESUME_FROM_CURSOR = ['1', 'true', 'yes'].includes(
    (process.env.MF_TURN_RESUME_CURSOR ?? '').toLowerCase()
)
// Runner rollout: agent ids that dispatch their sprite turns through the
// sprite's own runner instead of a direct sprite exec. An explicit allowlist
// rather than a boolean — this changes how a turn executes, so it opts in one
// agent at a time and an empty value means nothing changes for anyone. The
// single value '*' is the full-rollout switch: every sprite agent opts in.
// Read per call rather than at module load: the rollout list is operational
// state, and freezing it at import time also makes it untestable.
const spriteRunnerEnabledFor = (agentId: string): boolean => {
    const raw = (process.env.MF_SPRITE_RUNNER_AGENTS ?? '').trim()
    if (raw === '*') return true
    return raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .includes(agentId)
}

// hermes turns are ACP-only and the runner-owned client is the resumable
// variant, so the attempt is always worth making: the allowlist does not
// apply. Dispatch policy, deliberately not a frameworkCapabilities field —
// the same layering argument ADR-0021 makes for the exec-env surfaces.
const spriteRunnerAttemptedFor = (
    framework: AgentFramework,
    agentId: string
): boolean => framework === 'hermes' || spriteRunnerEnabledFor(agentId)

// Thrown when a turn cannot start because the session already has one running.
// Extends ConflictException so HTTP callers get a 409; the channel bridge catches
// it by type and queues the inbound for replay instead of failing the turn.
export class InflightTurnConflictError extends ConflictException {
    constructor() {
        super('session has an active assistant turn')
    }
}

interface ChatTurnConfig {
    model: string | null
    modelConfig: AgentModelConfig | null
    runtimeLocalTuning?: RuntimeLocalTuning
}

// Highest already-persisted source-event ordinal per dedup key. An adopted
// continuation can emit NEW events under a key the dead relay already used
// (the boundary raw line whose deltas were partially delivered); starting its
// ordinals at 0 again would collide with the persisted rows and the
// onConflictDoNothing dedup would silently DROP the new events. Seeding the
// counter past the persisted maximum keeps the (key, ordinal) pairs unique.
const maxOrdinalByKey = (
    events: Array<{
        sourceEventKey: string | null
        sourceEventOrdinal: number | null
    }>
): Map<string, number> => {
    const map = new Map<string, number>()
    for (const ev of events) {
        if (ev.sourceEventKey === null || ev.sourceEventOrdinal === null)
            continue
        const prev = map.get(ev.sourceEventKey)
        if (prev === undefined || ev.sourceEventOrdinal > prev)
            map.set(ev.sourceEventKey, ev.sourceEventOrdinal)
    }
    return map
}

const REPLAYABLE_CONTENT_EVENT_TYPES = new Set([
    'token',
    'thinking',
    'tool_call',
    'tool_result',
    'replace'
])

interface ReplayedContentEvent {
    eventType: string
    payloadJson: unknown
}

const replayedContentByKey = (
    events: Array<{
        eventType: string
        payloadJson: unknown
        sourceEventKey: string | null
        sourceEventOrdinal: number | null
    }>
): Map<string, Map<number, ReplayedContentEvent>> => {
    const map = new Map<string, Map<number, ReplayedContentEvent>>()
    for (const event of events) {
        if (
            event.sourceEventKey === null ||
            event.sourceEventOrdinal === null ||
            !REPLAYABLE_CONTENT_EVENT_TYPES.has(event.eventType)
        )
            continue
        const byOrdinal = map.get(event.sourceEventKey) ?? new Map()
        byOrdinal.set(event.sourceEventOrdinal, {
            eventType: event.eventType,
            payloadJson: event.payloadJson
        })
        map.set(event.sourceEventKey, byOrdinal)
    }
    return map
}

@Injectable()
export class ChatService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(ChatService.name)
    private readonly runningAdapters = new Map<string, AbortController>()
    // The ownership token for every locally-carried turn, keyed by assistant
    // message id. Write loops capture and pass their exact token; this map keeps
    // the same identity available to the shutdown handoff after those helpers
    // have returned. runningAdapters admits one carrier per message per process,
    // so the entry is unambiguous, and controller-scoped untrack drops both.
    private readonly turnFences = new Map<string, TurnExecutionFence>()
    private readonly unpersistedUpstreamRefs = new Map<
        string,
        { taskId: string | null; upstreamMessageId: string | null }
    >()
    private readonly turnDrainWaiters = new Set<() => void>()
    // Keyed by assistant message id, not counted, so it can be de-duplicated
    // against runningAdapters — see activeTurnCount().
    private readonly pendingTurnIds = new Set<string>()
    // Origin per held slot. Maintained beside the two sets above rather than
    // being derived from them, because neither set records who registered it;
    // if it ever drifts the COUNT is still correct, only the attribution is.
    private readonly turnOrigins = new Map<string, TurnOrigin>()
    private peakInflightSinceGauge = 0
    // The composition of THAT peak, captured at the instant it was set. It
    // cannot be recounted at tick time: by then the turns that made the peak
    // may have exited, so the count describes `inflight` and not
    // `peakInflight` — a five-turn spike that drains to one before the tick
    // would report its size and lose its source entirely. Two independent
    // per-origin high water marks would not do either: their maxima can fall
    // at different moments and need not add up to the global peak.
    private peakDispatchInflightSinceGauge = 0
    private peakRecoveryInflightSinceGauge = 0
    private concurrencyGaugeTimer: ReturnType<typeof setInterval> | null = null
    private readonly processLoad: ProcessLoadSampler =
        createProcessLoadSampler()
    private drainingForShutdown = false
    private staleClaimSweepTimer: ReturnType<typeof setInterval> | null = null
    private cancelConvergenceTimer: ReturnType<typeof setInterval> | null = null
    private convergingCancels = false
    private readonly prewarmedAt = new Map<string, number>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly repo: ChatRepository,
        private readonly broadcaster: ChatSseBroadcaster,
        private readonly adapters: ChatAdapterRegistry,
        private readonly usage: UsageService,
        private readonly files: FilesContextBuilder,
        private readonly spriteStatusSync: SpriteStatusSyncService,
        private readonly telemetry: TelemetryService,
        private readonly daemonResume: DaemonExecResumeService,
        private readonly spritesProvisioner: SpritesProvisioner,
        private readonly runtimes: AgentRuntimesService,
        @Optional()
        private readonly modelConfigs?: AgentModelConfigService,
        @Optional()
        private readonly reconcile?: AgentReconcileService,
        @Optional()
        private readonly uploads?: ChatUploadStorageService,
        @Optional()
        private readonly execDrivers?: ExecDriverFactory,
        @Optional()
        private readonly runtimeAccess?: RuntimeAccessService,
        @Optional()
        private readonly appEvents?: AppEventsService,
        // Optional like the block above: adoption is a flag-gated capability, and
        // unit tests build ChatService positionally without it — absent = the
        // pre-existing terminalize-on-subscribe behavior.
        @Optional()
        private readonly turnAdoption?: TurnAdoptionService,
        // Appended LAST and @Optional: unit tests construct ChatService
        // positionally, and an unresolvable constructor dep takes the whole app
        // down at boot (2026-07-25).
        @Optional()
        private readonly runnerManager?: RunnerManagerService,
        @Optional()
        private readonly cancelBus?: ChatCancelBus,
        @Optional()
        @Inject(MANAGED_CHANNEL_GUARD_PORT)
        private readonly managedChannelBreaker?: ManagedChannelGuardPort,
        // Same rule as the block above — appended last, @Optional. Absent = the
        // pre-#730 behaviour: no durable exec-health verdict is consulted and
        // every turn rediscovers a dead sprite exec endpoint for itself.
        @Optional()
        private readonly spriteExecHealth?: SpriteExecHealthService
    ) {
        // Registered here rather than in onApplicationBootstrap so a manually
        // constructed service (tests) gets the subscription without running
        // the whole bootstrap reconcile.
        this.cancelBus?.onCancelRequested((messageId) =>
            this.abortIfRunningLocally(messageId)
        )
    }

    // Peer-instance cancel delivery (ChatCancelBus): abort the turn if THIS
    // instance runs it; every non-owner instance receives the same NOTIFY and
    // ignores it. The abort funnels into the same normalizeEventForAbort path
    // a local cancel takes, so the terminal is cancelled_by_user either way.
    private abortIfRunningLocally(messageId: string): void {
        const controller = this.runningAdapters.get(messageId)
        if (!controller) return
        this.logger.log(
            `cross-instance cancel delivered for messageId=${messageId}`
        )
        this.telemetry.event('chat.cancel.bus_abort', { messageId })
        controller.abort()
    }

    // The one place env becomes turn-level budgets, so an admin-settings-driven
    // budget later has a single hook (hermes already does this for its own
    // transport budgets) and tests have a seam that does not require pushing a
    // real 60s floor through the suite on every timeout assertion.
    private turnBudgets(): TurnBudgets {
        return resolveTurnBudgets()
    }

    // The watchdog owns no AbortController of its own: the turn's controller is
    // whichever entry point registered it in runningAdapters (dispatch, resume,
    // adoption), and aborting THAT is what makes the underlying exec/fetch/RPC
    // actually tear down. Call it only AFTER the terminal is written — see the
    // classification comments in the two event loops.
    private abortTimedOutTurn(
        messageId: string,
        err: TurnBudgetExceededError
    ): void {
        this.logger.warn(
            `turn budget exceeded messageId=${messageId} kind=${err.kind} elapsedMs=${err.elapsedMs} budgetMs=${err.budgetMs}; aborting the transport`
        )
        const controller = this.runningAdapters.get(messageId)
        if (!controller || controller.signal.aborted) return
        controller.abort()
    }

    // The owner-side half of the cancel contract. `notify()` is fire-and-forget
    // over pg NOTIFY: a publish rejection, a LISTEN that has not been
    // (re)established yet, or a dropped connection all lose the message
    // silently, and the caller already has its 204. `cancel_requested_at` is
    // durable, so the owner re-reads it for its OWN live turns and converges
    // itself. Bound: one tick (CANCEL_CONVERGENCE_TICK_MS) plus one query.
    async convergeDurableCancels(): Promise<void> {
        if (this.convergingCancels) return
        const running = [...this.runningAdapters.keys()]
        if (running.length === 0) return
        this.convergingCancels = true
        try {
            const cancelled =
                await this.repo.findCancelRequestedMessageIds(running)
            for (const messageId of cancelled) {
                const controller = this.runningAdapters.get(messageId)
                if (!controller || controller.signal.aborted) continue
                this.logger.log(
                    `durable cancel converged for messageId=${messageId} (no bus delivery)`
                )
                this.telemetry.event('chat.cancel.durable_converge', {
                    messageId
                })
                controller.abort()
            }
        } catch (err) {
            this.logger.warn(
                `durable cancel convergence failed: ${(err as Error).message}`
            )
        } finally {
            this.convergingCancels = false
        }
    }

    // A cancel that found no local adapter: persist the durable flag (daemon
    // resume path and restart recovery read it), then broadcast to peers. The
    // log + telemetry exist because before #402 this path returned 204 having
    // aborted nothing, and that silence read as "cancel works".
    private async requestCancelRemotely(messageId: string): Promise<void> {
        await this.repo.markCancelRequested(messageId)
        this.cancelBus?.notify(messageId)
        this.logger.log(
            `cancel found no local adapter for messageId=${messageId}; marked and broadcast to peers`
        )
        this.telemetry.event('chat.cancel.broadcast', { messageId })
    }

    // Turns this instance is carrying: setting up, or running an adapter.
    // The two sets deliberately overlap — startAssistantTurn registers the
    // adapter while its caller still holds the pending mark — so they are
    // unioned by message id rather than summed. Summing was harmless for the
    // shutdown drain, which only asks whether the total is zero, but an
    // admission limit spends a slot per count, and the doubled turn spends
    // one that does not exist.
    activeTurnCount(): number {
        let pendingOnly = 0
        for (const messageId of this.pendingTurnIds)
            if (!this.runningAdapters.has(messageId)) pendingOnly += 1
        return this.runningAdapters.size + pendingOnly
    }

    async prepareForShutdown(timeoutMs: number): Promise<TurnShutdownResult> {
        this.drainingForShutdown = true
        const activeTurnsAtStart = this.activeTurnCount()
        await this.turnAdoption?.stopClaiming()
        const drainOutcome = await this.waitForActiveTurnsToDrain(timeoutMs)
        const activeTurnsRemaining = this.activeTurnCount()
        if (!this.turnAdoption?.enabled)
            return {
                drainOutcome: activeTurnsAtStart === 0 ? 'idle' : drainOutcome,
                activeTurnsAtStart,
                activeTurnsRemaining,
                handedOffTurns: 0,
                handoffOutcome:
                    activeTurnsRemaining === 0 ? 'not_needed' : 'disabled'
            }
        try {
            const handed = await this.repo.handoffOwnedTurns(
                [...this.turnFences.values()],
                this.upstreamRefsForHandoff()
            )
            if (handed.length > 0)
                this.logger.log(
                    `handed off ${handed.length} live turn(s) after shutdown drain timed out`
                )
            return {
                drainOutcome,
                activeTurnsAtStart,
                activeTurnsRemaining,
                handedOffTurns: handed.length,
                handoffOutcome:
                    handed.length > 0
                        ? 'handed_off'
                        : activeTurnsRemaining === 0
                          ? 'not_needed'
                          : 'no_adoptable_turns'
            }
        } catch (err) {
            this.logger.warn(
                `turn handoff after shutdown drain failed: ${(err as Error).message}`
            )
            return {
                drainOutcome,
                activeTurnsAtStart,
                activeTurnsRemaining,
                handedOffTurns: 0,
                handoffOutcome: 'failed'
            }
        }
    }

    private waitForActiveTurnsToDrain(
        timeoutMs: number
    ): Promise<'idle' | 'drained' | 'timeout'> {
        if (this.activeTurnCount() === 0) return Promise.resolve('idle')
        if (timeoutMs <= 0) return Promise.resolve('timeout')
        return new Promise((resolve) => {
            let settled = false
            const finish = (outcome: 'drained' | 'timeout'): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                this.turnDrainWaiters.delete(onActivity)
                resolve(outcome)
            }
            const onActivity = (): void => {
                if (this.activeTurnCount() === 0) finish('drained')
            }
            const timer = setTimeout(() => {
                finish(this.activeTurnCount() === 0 ? 'drained' : 'timeout')
            }, timeoutMs)
            this.turnDrainWaiters.add(onActivity)
            onActivity()
        })
    }

    private upstreamRefsForHandoff(): Array<{
        messageId: string
        taskId: string | null
        upstreamMessageId: string | null
    }> {
        return [...this.unpersistedUpstreamRefs].map(([messageId, ref]) => ({
            messageId,
            ...ref
        }))
    }

    private assertAcceptingTurns(): void {
        if (!this.drainingForShutdown) return
        throw new ServiceUnavailableException({
            code: 'service_restarting',
            message: 'server is restarting; retry the turn'
        })
    }

    // One slot per turn this instance is carrying, from the moment it takes
    // the work on until the moment it lets go. `enter`/`exit` fire exactly
    // once each per execution — the two sets overlap while startAssistantTurn
    // registers an adapter its dispatcher has not finished setting up, so the
    // edge is the slot changing hands, not either set changing.
    private turnSlotHeld(messageId: string): boolean {
        return (
            this.pendingTurnIds.has(messageId) ||
            this.runningAdapters.has(messageId)
        )
    }

    // Best-effort by construction. Observability must never be able to strand
    // a slot: these fire either side of the mutations that own the count, and
    // a throw escaping one would either leave an id in a set nothing will
    // clear or replace a real error propagating out of a finally.
    private emitTurnConcurrency(
        event: 'enter' | 'exit',
        messageId: string,
        origin: TurnOrigin
    ): void {
        try {
            const inflight = this.activeTurnCount()
            // STRICTLY greater, so the snapshot is the first instant this
            // window stood at its maximum. A later moment at the same level
            // with a different composition does not overwrite it: the tie has
            // to break one way, and this way the seed the reset leaves behind
            // — the slots held when the window opened — is a real instant of
            // the window like any other. Both callers set turnOrigins before
            // emitting, so the split here already includes this turn and adds
            // up to `inflight`.
            if (event === 'enter' && inflight > this.peakInflightSinceGauge)
                this.snapshotPeakInflight(inflight)
            this.telemetry.event('chat.turn.concurrency', {
                event,
                messageId,
                origin,
                inflight
            })
        } catch (err) {
            this.logger.warn(
                `turn concurrency telemetry failed: ${(err as Error).message}`
            )
        }
    }

    // Who is holding the slots right now. Sums to activeTurnCount() for as
    // long as turnOrigins tracks the held slots, which is the same condition
    // the emitted split has always rested on.
    private turnOriginSplit(): { dispatch: number; recovery: number } {
        let dispatch = 0
        let recovery = 0
        for (const origin of this.turnOrigins.values())
            if (origin === 'dispatch') dispatch += 1
            else recovery += 1
        return { dispatch, recovery }
    }

    // Level and composition are written in one synchronous method, with no
    // opportunity for another slot transition to interleave. Every
    // post-construction write to the high water mark goes through here — the
    // peak update on enter and the reset after a gauge attempt alike — because
    // a peak whose composition came from a different moment is exactly the
    // defect this exists to prevent.
    private snapshotPeakInflight(inflight: number): void {
        const split = this.turnOriginSplit()
        this.peakInflightSinceGauge = inflight
        this.peakDispatchInflightSinceGauge = split.dispatch
        this.peakRecoveryInflightSinceGauge = split.recovery
    }

    // The number an operator would have to set a per-instance turn limit
    // from, and the evidence for whether that number is safe. Dispatch-only
    // sampling cannot produce it: recovery registers turns without going
    // anywhere near a dispatch path, so a deploy — the exact burst a limit
    // exists to survive — would be invisible. Hence a periodic gauge rather
    // than an event per admission, carrying the peak between ticks so a spike
    // shorter than the interval still lands, the dispatch/recovery split, and
    // the process load at that concurrency.
    //
    // Two splits ship, and they answer different questions. `dispatchInflight`
    // / `recoveryInflight` are the composition of `inflight`, i.e. at the
    // tick. `peakDispatchInflight` / `peakRecoveryInflight` are the
    // composition of `peakInflight`, captured when that peak was set and
    // summing to it — the pair that says whether a peak was traffic or a
    // deploy. On the shortest spikes, the ones the peak exists to keep, the
    // two are not the same number and reading either as the other attributes
    // the peak to whoever happened to still be running at the tick.
    //
    // Rides telemetry.event(), i.e. the OTel LOGS exporter, because
    // OTEL_METRICS_EXPORTER defaults to 'none' (otel.ts) — a real metric
    // instrument would be exported nowhere on every current deployment.
    private emitConcurrencyGauge(): void {
        try {
            const inflight = this.activeTurnCount()
            // Defensive, and it has to re-snapshot rather than raise the
            // number on its own: if the mark were ever left below the level
            // it describes, its composition would be short by the same turns.
            if (inflight > this.peakInflightSinceGauge)
                this.snapshotPeakInflight(inflight)
            const peak = this.peakInflightSinceGauge
            // Sampled on EVERY tick, idle ones included, and before the
            // emit-or-not decision: both loop signals are windowed, so a
            // skipped tick folds that stretch into the next reported window
            // and understates the first sample after an idle stretch — which
            // is when a burst arrives. Measured [2026-08-10]: a 500ms idle
            // gap ahead of 50ms of work reported ELU 0.091, against 0.504 for
            // the same work in the next fixed window.
            const load = this.processLoad.sample()
            // An idle instance says nothing; the tick after it goes idle
            // still reports, so an episode always has a closing sample.
            if (inflight === 0 && peak === 0) return
            const split = this.turnOriginSplit()
            this.telemetry.event('chat.turn.concurrency.gauge', {
                inflight,
                dispatchInflight: split.dispatch,
                recoveryInflight: split.recovery,
                peakInflight: peak,
                peakDispatchInflight: this.peakDispatchInflightSinceGauge,
                peakRecoveryInflight: this.peakRecoveryInflightSinceGauge,
                ...load
            })
        } catch (err) {
            // This runs from a setInterval callback, where an escaping throw
            // takes the process down and would also skip the peak reset
            // below, pinning the series at a stale high water mark.
            this.logger.warn(
                `turn concurrency gauge failed: ${(err as Error).message}`
            )
        } finally {
            // Value and composition reset together, on every way out of this
            // method — normal emit, the idle return above, teardown flush and
            // a throwing sink — so the next window opens on the slots held
            // right now and who is holding them. Resetting one without the
            // other would leave the following sample describing two windows
            // at once.
            this.snapshotPeakInflight(this.activeTurnCount())
        }
    }

    private beginPendingTurn(assistantMessageId: string): void {
        const held = this.turnSlotHeld(assistantMessageId)
        this.pendingTurnIds.add(assistantMessageId)
        if (held) return
        this.turnOrigins.set(assistantMessageId, 'dispatch')
        this.emitTurnConcurrency('enter', assistantMessageId, 'dispatch')
    }

    private endPendingTurn(assistantMessageId: string): void {
        // Deliberately tolerant of an id that was never added: the callers
        // run this in a finally that also covers the statement which adds it.
        if (!this.pendingTurnIds.delete(assistantMessageId)) return
        this.notifyTurnDrainWaiters()
        this.releaseTurnSlotIfDone(assistantMessageId)
    }

    private releaseTurnSlotIfDone(messageId: string): void {
        if (this.turnSlotHeld(messageId)) return
        const origin = this.turnOrigins.get(messageId) ?? 'dispatch'
        this.turnOrigins.delete(messageId)
        this.emitTurnConcurrency('exit', messageId, origin)
    }

    // Check-and-SET, not a check followed later by a set. adoptTurnExecution
    // reads the map, awaits two DB reads, and only then registers, and a
    // daemon resume can check AND register inside that gap. The loser used to
    // overwrite the winner's entry, so two live transports counted as one,
    // cancel reached only the last one registered, and whichever finished
    // first deleted the other execution's registration with it — the count
    // fell to zero with work still running, which shutdown drain and every
    // concurrency measure read as idle. Returns false when the message is
    // already executing here; the caller decides whether that is a no-op
    // (recovery, which defers) or a fault (dispatch, which must not run a
    // second execution under one assistant message id).
    private trackRunningAdapter(
        messageId: string,
        controller: AbortController,
        origin: TurnOrigin = 'dispatch'
    ): boolean {
        if (this.runningAdapters.has(messageId)) return false
        const held = this.turnSlotHeld(messageId)
        this.runningAdapters.set(messageId, controller)
        this.notifyTurnDrainWaiters()
        if (!held) {
            this.turnOrigins.set(messageId, origin)
            this.emitTurnConcurrency('enter', messageId, origin)
        }
        return true
    }

    // Scoped to the controller that registered: the execution that won the
    // slot is the only one that can give it back, so a losing execution's
    // finally cannot delete a live entry that outlived it.
    private untrackRunningAdapter(
        messageId: string,
        controller: AbortController
    ): void {
        if (this.runningAdapters.get(messageId) !== controller) return
        this.runningAdapters.delete(messageId)
        this.turnFences.delete(messageId)
        this.notifyTurnDrainWaiters()
        this.releaseTurnSlotIfDone(messageId)
    }

    // Set only after this carrier holds the slot, so a preempting resume never
    // installs its fence in time for the carrier it displaced to delete it.
    private setTurnFence(fence: TurnExecutionFence): void {
        this.turnFences.set(fence.messageId, fence)
        this.broadcaster.setStreamFence(fence.messageId, fence)
    }

    private notifyTurnDrainWaiters(): void {
        for (const waiter of [...this.turnDrainWaiters]) waiter()
    }

    // Resolves as soon as no adapter holds `messageId`, driven by the same
    // notification untrackRunningAdapter already emits — not by polling and not
    // by a delay chosen to be "probably long enough". Returns false on timeout,
    // which the caller must treat as "the slot is still occupied".
    private waitForCarrierRelease(
        messageId: string,
        timeoutMs: number
    ): Promise<boolean> {
        if (!this.runningAdapters.has(messageId)) return Promise.resolve(true)
        return new Promise<boolean>((resolve) => {
            let settled = false
            const finish = (released: boolean): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                this.turnDrainWaiters.delete(onActivity)
                resolve(released)
            }
            const onActivity = (): void => {
                if (!this.runningAdapters.has(messageId)) finish(true)
            }
            const timer = setTimeout(() => {
                finish(!this.runningAdapters.has(messageId))
            }, timeoutMs)
            this.turnDrainWaiters.add(onActivity)
            onActivity()
        })
    }

    // A matched authoritative daemon hello outranks a transcript adoption of
    // the same turn, and by more than a lease. The daemon holds ONE reverse-WS
    // connection, so the replica that just took its hello is the only place its
    // still-buffered stream can be replayed at all; the adopter is re-deriving
    // that same answer from a file, and when it cannot it closes the turn with
    // server_restart. Waiting for the adopter's 90s lease to lapse throws the
    // recoverable buffer away for nothing.
    //
    // The durable claim comes FIRST and the abort second. The claim is what
    // actually fences the adopter — including an adopter on another replica,
    // which no abort of ours can reach — so there is no window in which the
    // loser is dying but still allowed to write. Then wait for the slot to be
    // released rather than assume it: attaching while the loser is still
    // draining would put two writers on one message id, which is the bug.
    private async preemptAdoptionForResume(args: {
        message: DbChatMessage
        daemonId: string
        refId: string
    }): Promise<TurnExecutionRow | null> {
        const { message, daemonId, refId } = args
        const ownerId = this.turnAdoption?.ownerId
        if (!ownerId) return null
        const claimed = await this.repo
            .claimTurnForResume({
                messageId: message.id,
                sessionId: message.sessionId,
                daemonId,
                daemonExecRef: refId,
                ownerId,
                leaseSeconds: TURN_LEASE_SECONDS
            })
            .catch((err: Error) => {
                this.logger.warn(
                    `resume claim failed messageId=${message.id}: ${err.message}`
                )
                return { outcome: 'busy' as const }
            })
        // No row, or a row that already terminalized. Either way there is
        // nothing to fence the adopter with, so aborting it would only leave a
        // writer we cannot stop. Leave the turn where it is.
        if (claimed.outcome !== 'claimed') return null
        const holder = this.runningAdapters.get(message.id)
        holder?.abort()
        const released = await this.waitForCarrierRelease(
            message.id,
            PREEMPT_SLOT_RELEASE_TIMEOUT_MS
        )
        if (!released) {
            this.logger.warn(
                `resume preemption for messageId=${message.id} timed out waiting for the adoption carrier to release`
            )
            await this.repo
                .handoffOwnedTurn(
                    message.id,
                    claimed.row.ownerId,
                    claimed.row.generation
                )
                .catch(() => undefined)
            return null
        }
        this.telemetry.event('chat.turn.resume_preempted_adoption', {
            messageId: message.id,
            generation: claimed.row.generation
        })
        return claimed.row
    }

    async onApplicationBootstrap(): Promise<void> {
        this.daemonResume.registerHandler({
            resumeAssistantTurn: (args) => this.resumeAssistantTurn(args),
            // The same map the resume declines on. A turn executing here is
            // being carried by someone — a fence-adopted carrier stream, a
            // live dispatch — and a recheck must not converge it under them.
            isRunningLocally: (messageId) =>
                this.runningAdapters.has(messageId),
            completeOfflineCancel: (args) => this.completeOfflineCancel(args),
            // The daemon's hello proved it holds NO stream for this turn, so
            // no resume will ever come and adoption would defer to the online
            // daemon forever. This authoritative evidence overrides the
            // deferral: converge to the retryable restart terminal.
            failUnresumable: async ({ message }) => {
                this.telemetry.event('chat.turn.unresumable', {
                    messageId: message.id,
                    sessionId: message.sessionId
                })
                const fence = await this.claimReconciliationFence(message.id)
                const persisted = await this.emitAdoptedRestartTerminal(
                    message.sessionId,
                    message.id,
                    fence ?? undefined
                )
                if (!persisted) throw new TurnFenceLostError(message.id)
            }
        })
        this.turnAdoption?.registerHandler({
            adopt: (row) => this.adoptTurnExecution(row),
            giveUp: (row) => this.terminalizeAdoptedTurn(row)
        })
        const orphans = await this.repo.listOrphanedAssistantMessages()
        const now = new Date()
        const interrupted = interruptedErrorEvent()
        for (const orphan of orphans) {
            try {
                const execution = await this.repo.getTurnExecution(
                    orphan.messageId
                )
                if (
                    execution &&
                    execution.state !== 'done' &&
                    execution.state !== 'failed' &&
                    (execution.runtime === 'sprites' ||
                        execution.runtime === 'external') &&
                    this.turnAdoption?.enabled
                ) {
                    this.turnAdoption.kick()
                    continue
                }
                let fence: TurnExecutionFence | null = null
                try {
                    fence = await this.claimReconciliationFence(
                        orphan.messageId
                    )
                } catch {
                    continue
                }
                // Writing a done/error event here also releases the session turn
                // lock for this message (repo.insertStreamEvent chokepoint).
                const { id } = await this.repo.insertStreamEvent(
                    {
                        sessionId: orphan.sessionId,
                        messageId: orphan.messageId,
                        seq: orphan.lastSeq + 1,
                        eventType: interrupted.type,
                        payloadJson: interrupted as unknown as Record<
                            string,
                            unknown
                        >,
                        createdAt: now
                    },
                    undefined,
                    fence ?? undefined
                )
                if (id !== null)
                    await this.emitDurableTerminalTelemetry({
                        sessionId: orphan.sessionId,
                        messageId: orphan.messageId,
                        outcome: 'error',
                        errorCode: interrupted.error.code,
                        via: 'restart_terminal'
                    })
            } catch (err) {
                this.logger.warn(
                    `failed to reconcile orphan messageId=${orphan.messageId}: ${(err as Error).message}`
                )
            }
        }
        this.logger.log(
            orphans.length === 0
                ? 'no orphaned assistant messages to reconcile'
                : `reconciled ${orphans.length} orphaned assistant message(s) on bootstrap`
        )
        // Belt to the reconcile suspenders: clear any turn-lock claim left dangling
        // by a crash before the message's first stream event (the loop above only
        // releases claims whose message got an interrupted event). Never clears a
        // claim pointing at a live inflight message, so it is safe across instances.
        const staleClaims = await this.repo
            .clearStaleInflightClaims()
            .catch((err: Error) => {
                this.logger.warn(
                    `failed to clear stale inflight turn claims: ${err.message}`
                )
                return 0
            })
        if (staleClaims > 0)
            this.logger.log(
                `cleared ${staleClaims} stale inflight turn claim(s) on bootstrap`
            )
        // Keep sweeping periodically: the bootstrap pass + 15min age gate cannot
        // clear a claim that went stale AFTER this boot without another restart.
        this.staleClaimSweepTimer = setInterval(() => {
            void this.repo
                .clearStaleInflightClaims()
                .then((n) => {
                    if (n > 0)
                        this.logger.log(
                            `periodic sweep cleared ${n} stale inflight turn claim(s)`
                        )
                })
                .catch((err: Error) =>
                    this.logger.warn(
                        `periodic stale-claim sweep failed: ${err.message}`
                    )
                )
        }, STALE_INFLIGHT_CLAIM_SWEEP_INTERVAL_MS)
        this.staleClaimSweepTimer.unref()
        this.cancelConvergenceTimer = setInterval(() => {
            void this.convergeDurableCancels()
        }, CANCEL_CONVERGENCE_TICK_MS)
        this.cancelConvergenceTimer.unref()
        this.concurrencyGaugeTimer = setInterval(() => {
            this.emitConcurrencyGauge()
        }, TURN_CONCURRENCY_GAUGE_MS)
        this.concurrencyGaugeTimer.unref()
    }

    // Graceful shutdown normally drains then hands off through
    // prepareForShutdown(). Keep this hook as an idempotent fallback for callers
    // that close the Nest app directly. Deliberately do NOT abort adapters:
    // aborting would REST-kill the still-running sprite exec and destroy the work
    // adoption is meant to recover.
    //
    // Runs in onModuleDestroy, NOT onApplicationShutdown: app.close() blocks on
    // the still-open SSE sockets (forceCloseConnections:'idle' leaves active
    // streams open), so onApplicationShutdown is often never reached before the
    // hard force-exit. onModuleDestroy runs at the very start of app.close(),
    // before any server-close hang, so the fallback handoff can still land.
    async onModuleDestroy(): Promise<void> {
        this.drainingForShutdown = true
        await this.turnAdoption?.stopClaiming()
        if (this.staleClaimSweepTimer) {
            clearInterval(this.staleClaimSweepTimer)
            this.staleClaimSweepTimer = null
        }
        if (this.cancelConvergenceTimer) {
            clearInterval(this.cancelConvergenceTimer)
            this.cancelConvergenceTimer = null
        }
        // Flushed unconditionally, not just when a timer is running: a turn
        // that started and finished between two ticks would otherwise be a
        // saturation episode with no sample anywhere, and teardown is exactly
        // when a short-lived burst is most likely to be the last thing that
        // happened.
        this.emitConcurrencyGauge()
        if (this.concurrencyGaugeTimer) {
            clearInterval(this.concurrencyGaugeTimer)
            this.concurrencyGaugeTimer = null
        }
        this.processLoad.stop()
        if (!this.turnAdoption?.enabled) return
        try {
            const handed = await this.repo.handoffOwnedTurns(
                [...this.turnFences.values()],
                this.upstreamRefsForHandoff()
            )
            if (handed.length > 0)
                this.logger.log(
                    `handed off ${handed.length} live turn(s) for adoption on shutdown`
                )
        } catch (err) {
            this.logger.warn(
                `turn handoff on shutdown failed: ${(err as Error).message}`
            )
        }
    }

    async cancelStream(
        userId: string,
        agentId: string,
        sessionId: string,
        assistantMessageId?: string
    ): Promise<void> {
        await this.assertSessionAccess(sessionId, userId, agentId)
        const messageId = await this.repo.latestInflightMessageId(sessionId)
        if (assistantMessageId && messageId !== assistantMessageId)
            throw new ConflictException('assistant turn is no longer active')
        if (!messageId) return
        const controller = this.runningAdapters.get(messageId)
        if (controller) {
            controller.abort()
            return
        }
        await this.requestCancelRemotely(messageId)
    }

    // Message-scoped cancel for protocol callers (A2A) that name a specific
    // assistant turn rather than "the session's latest" — cancelStream resolves
    // latestInflightMessageId and would cancel the wrong turn when several tasks
    // share a context/session.
    async cancelMessage(
        userId: string,
        agentId: string,
        assistantMessageId: string
    ): Promise<void> {
        const message = await this.repo.getMessageById(assistantMessageId)
        if (!message) return
        await this.assertSessionAccess(message.sessionId, userId, agentId)
        const controller = this.runningAdapters.get(assistantMessageId)
        if (controller) {
            controller.abort()
            return
        }
        await this.requestCancelRemotely(assistantMessageId)
    }

    async hasInflightTurn(sessionId: string): Promise<boolean> {
        const messageId = await this.repo.latestInflightMessageId(sessionId)
        return messageId !== null
    }

    // Durable turn state for observers that outlive the in-process stream
    // (channel bridge reconcile): reads the persisted terminal event instead
    // of relying on an in-memory ChatTurnObserver callback.
    async getTurnOutcome(assistantMessageId: string): Promise<ChatTurnOutcome> {
        const message = await this.repo.getMessageById(assistantMessageId)
        if (!message) return { state: 'missing' }
        const terminal =
            await this.repo.findTerminalStreamEvent(assistantMessageId)
        if (!terminal) return { state: 'running' }
        if (terminal.eventType === 'done') {
            const blocks =
                (message.contentBlocksJson as ChatContentBlock[]) ?? []
            const text = blocks
                .filter(
                    (b): b is Extract<ChatContentBlock, { type: 'text' }> =>
                        b.type === 'text'
                )
                .map((b) => b.text)
                .join('')
            return { state: 'done', text }
        }
        const payload = terminal.payloadJson as {
            error?: { code?: string; message?: string }
        }
        const code = payload.error?.code
        return {
            state: 'error',
            errorMessage: payload.error?.message ?? 'unknown error',
            cancelled: code === 'cancelled' || code === CANCELLED_BY_USER_CODE
        }
    }

    async listSessions(
        userId: string,
        agentId: string
    ): Promise<ChatSessionSummary[]> {
        await this.assertAgentAccess(agentId, userId)
        const sessions = await this.repo.listSessions(userId, agentId)
        const untitledIds = sessions
            .filter((s) => s.title === null)
            .map((s) => s.id)

        let sessionsWithTitles = sessions
        if (untitledIds.length > 0) {
            const firstMessages =
                await this.repo.listFirstUserMessages(untitledIds)
            const titleById = new Map<string, string>()
            for (const msg of firstMessages) {
                const blocks =
                    (msg.contentBlocksJson as ChatContentBlock[]) ?? []
                const title = deriveTitleFromBlocks(blocks)
                if (title) titleById.set(msg.sessionId, title)
            }

            if (titleById.size > 0) {
                const pairs = Array.from(titleById.entries())
                void Promise.all(
                    pairs.map(([sessionId, title]) =>
                        this.repo.updateTitleIfEmpty(sessionId, title)
                    )
                ).catch((err: Error) => {
                    this.logger.warn(
                        `failed to backfill titles: ${err.message}`
                    )
                })

                sessionsWithTitles = sessions.map((s) =>
                    s.title === null && titleById.has(s.id)
                        ? { ...s, title: titleById.get(s.id) as string }
                        : s
                )
            }
        }

        const channelsBySessionId = sessionChannelMap(
            await this.repo.listSessionChannels(
                sessionsWithTitles.map((session) => session.id)
            )
        )
        return sessionsWithTitles.map((session) =>
            toApiSession(session, channelsBySessionId.get(session.id) ?? null)
        )
    }

    async createSession(
        userId: string,
        agentId: string,
        title?: string
    ): Promise<ChatSessionSummary> {
        await this.assertAgentAccess(agentId, userId)
        const created = await this.repo.createSession({
            id: createObjectId('chatSession'),
            userId,
            agentId,
            title: title ?? null,
            frameworkSessionRef: null,
            createdAt: new Date(),
            updatedAt: new Date()
        })
        return toApiSession(created, null)
    }

    async updateSession(
        userId: string,
        agentId: string,
        sessionId: string,
        patch: { title?: string | null }
    ): Promise<ChatSessionSummary> {
        await this.assertSessionAccess(sessionId, userId, agentId)
        if (patch.title !== undefined) {
            const normalized =
                typeof patch.title === 'string'
                    ? patch.title.trim().length === 0
                        ? null
                        : patch.title.trim()
                    : null
            const updated = await this.repo.updateTitle(sessionId, normalized)
            if (!updated) throw new NotFoundException('chat session not found')
        }
        const refreshed = await this.repo.getSession(sessionId, userId)
        if (!refreshed) throw new NotFoundException('chat session not found')
        const [channelRow] = await this.repo.listSessionChannels([sessionId])
        const channelMap = sessionChannelMap(channelRow ? [channelRow] : [])
        return toApiSession(refreshed, channelMap.get(sessionId) ?? null)
    }

    // Append attachment blocks to an assistant message after the turn has
    // terminated (channel outbound files). No access check: the caller is the
    // trusted channel bridge acting on a message it just finalized.
    async appendAssistantAttachments(
        messageId: string,
        blocks: ChatContentBlock[]
    ): Promise<void> {
        await this.repo.appendMessageBlocks(messageId, blocks)
    }

    async listMessages(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<ChatMessage[]> {
        await this.assertSessionAccess(sessionId, userId, agentId)
        const rows = await this.repo.listMessagesWithUsage(sessionId)
        const errors = await this.repo.terminalErrorsForMessages(
            rows.map((r) => r.message.id)
        )
        return rows.map(({ message, usage }) =>
            toApiMessage(message, usage, errors.get(message.id) ?? null)
        )
    }

    async listMessagePage(
        userId: string,
        agentId: string,
        sessionId: string,
        opts: { limit?: number; before?: string }
    ): Promise<ChatMessagesPage> {
        await this.assertSessionAccess(sessionId, userId, agentId)
        const limit = normalizeMessagePageLimit(opts.limit)
        const before = opts.before ? decodeMessageCursor(opts.before) : null

        // The page reads take ONE snapshot, because they classify the same
        // turn from three angles and a client cannot reconcile two answers
        // about it. Under a snapshot per statement, a terminal landing
        // between the row read and the inflight read pairs a PRE-terminal
        // partial row with a POST-terminal "nothing is inflight" — a page
        // that renders half an answer as final history and names no turn to
        // replay, so the tab stays half-finished until it is reloaded.
        //
        // A normal turn persists final content before its terminal. Recovery
        // terminals that do not rewrite content instead make the existing row
        // final, and no path mutates it after terminal. Thus a snapshot either
        // sees settled terminal state, including its error, or pre-terminal
        // content plus the replay target that can deliver the rest.
        const {
            hasMore,
            pageRows,
            errors,
            inflightAssistantMessageId,
            streamCursorEventId
        } = await this.repo.readSnapshot(async (repo) => {
            const rows = await repo.listMessagePageWithUsage(sessionId, {
                limit: limit + 1,
                before
            })
            const more = rows.length > limit
            const page = more ? rows.slice(0, limit) : rows
            const inflight = before
                ? null
                : await repo.latestInflightMessageId(sessionId)
            return {
                hasMore: more,
                pageRows: page,
                errors: await repo.terminalErrorsForMessages(
                    page.map((r) => r.message.id)
                ),
                // Only the newest page can contain the inflight assistant
                // turn; skip the extra query for older history.
                inflightAssistantMessageId: inflight,
                // Without an inflight replay target, hand SSE the stream
                // boundary from this same snapshot. Reading max later
                // would skip a turn completed in the handoff gap.
                streamCursorEventId:
                    before || inflight
                        ? null
                        : String(await repo.maxSessionStreamEventId(sessionId))
            }
        })
        const messages = pageRows
            .map(({ message, usage }) =>
                toApiMessage(message, usage, errors.get(message.id) ?? null)
            )
            .reverse()
        const earliest = pageRows[pageRows.length - 1]?.message ?? null

        // Read out of pageRows, never with a second query. The cursor is only
        // meaningful against the exact `contentBlocks` shipped beside it, and
        // a re-read could pick up a checkpoint written since — pairing this
        // response's content with a later cursor, which is the one direction
        // that loses content instead of duplicating it.
        const inflightRow = inflightAssistantMessageId
            ? (pageRows.find(
                  ({ message }) => message.id === inflightAssistantMessageId
              )?.message ?? null)
            : null
        const inflightCheckpointEventId =
            inflightRow?.contentCheckpointEventId != null
                ? String(inflightRow.contentCheckpointEventId)
                : null

        return {
            messages,
            hasMore,
            nextBefore:
                hasMore && earliest
                    ? encodeMessageCursor({
                          createdAt: earliest.createdAt,
                          id: earliest.id
                      })
                    : null,
            inflightAssistantMessageId,
            inflightCheckpointEventId,
            streamCursorEventId
        }
    }

    // Public /v1/conversations read. Lists the caller's NON-channel sessions
    // (across all agents, or one when filtered). Pure read: no lazy title
    // backfill. `after` is an object id resolved under the same predicate as
    // the list (so a bound/filtered caller can't anchor on a hidden session).
    async listConversations(
        userId: string,
        opts: {
            agentId: string | null
            limit: number
            after: string | null
            order: 'asc' | 'desc'
        }
    ): Promise<{ items: ChatSessionSummary[]; hasMore: boolean }> {
        let after: MessageCursor | null = null
        if (opts.after) {
            after = await this.repo.resolveConversationCursor(
                userId,
                { agentId: opts.agentId },
                opts.after
            )
            if (!after) throw invalidAfterCursor()
        }
        const rows = await this.repo.listUserConversationsPage(userId, {
            agentId: opts.agentId,
            limit: opts.limit + 1,
            after,
            order: opts.order
        })
        const hasMore = rows.length > opts.limit
        const pageRows = hasMore ? rows.slice(0, opts.limit) : rows
        return {
            items: pageRows.map((row) => toApiSession(row, null)),
            hasMore
        }
    }

    // Public /v1/conversations/{id}/messages read. 404 (without leaking
    // existence) when the session isn't the caller's, is channel-origin, or
    // doesn't match a bound token's agent.
    async listConversationMessages(
        userId: string,
        sessionId: string,
        opts: {
            boundAgentId: string | null
            limit: number
            after: string | null
            order: 'asc' | 'desc'
        }
    ): Promise<{ items: ChatMessage[]; hasMore: boolean }> {
        const session = await this.repo.getSession(sessionId, userId)
        if (!session) throw conversationNotFound()
        const [channelRow] = await this.repo.listSessionChannels([sessionId])
        if (channelRow) throw conversationNotFound()
        if (opts.boundAgentId && session.agentId !== opts.boundAgentId)
            throw conversationNotFound()

        let after: MessageCursor | null = null
        if (opts.after) {
            const cursor = await this.repo.getMessage(sessionId, opts.after)
            if (!cursor) throw invalidAfterCursor()
            after = { createdAt: cursor.createdAt, id: cursor.id }
        }

        const rows = await this.repo.listSessionMessagesPageWithUsage(
            sessionId,
            { limit: opts.limit + 1, after, order: opts.order }
        )
        const hasMore = rows.length > opts.limit
        const pageRows = hasMore ? rows.slice(0, opts.limit) : rows
        const errors = await this.repo.terminalErrorsForMessages(
            pageRows.map((r) => r.message.id)
        )
        return {
            items: pageRows.map(({ message, usage }) =>
                toApiMessage(message, usage, errors.get(message.id) ?? null)
            ),
            hasMore
        }
    }

    async deleteSession(
        userId: string,
        agentId: string,
        sessionId: string,
        force = false
    ): Promise<void> {
        await this.assertSessionAccess(sessionId, userId, agentId)
        if (force) {
            const deleted = await this.repo.deleteSession(sessionId)
            if (deleted) return
            throw new NotFoundException('session not found')
        }

        const deleted = await this.repo.deleteSessionIfEmpty(sessionId)
        if (deleted) return

        if (await this.repo.sessionHasMessages(sessionId))
            throw new ConflictException('session is not empty')

        throw new NotFoundException('session not found')
    }

    // Fired by the web composer on focus/first keystroke so the sprite's ~1s
    // VM resume overlaps typing time instead of the turn. Admission runs
    // through reserveActiveSlot inside forAgent, so prewarming opens the same
    // metering watermark a real turn would (no unmetered awake time) and
    // silently no-ops on quota rejection. Debounced per agent; duplicate wakes
    // across API instances are harmless (the exec is a no-op `true`).
    async prewarmAgent(
        userId: string,
        agentId: string
    ): Promise<{ accepted: boolean }> {
        await this.assertAgentAccess(agentId, userId)
        if (!this.execDrivers) return { accepted: false }
        const now = Date.now()
        const last = this.prewarmedAt.get(agentId)
        if (last !== undefined && now - last < PREWARM_DEBOUNCE_MS)
            return { accepted: false }
        this.prewarmedAt.set(agentId, now)
        if (this.prewarmedAt.size > 5000) {
            for (const [key, at] of this.prewarmedAt)
                if (now - at >= PREWARM_DEBOUNCE_MS)
                    this.prewarmedAt.delete(key)
        }
        void this.runPrewarm(agentId)
        return { accepted: true }
    }

    private async runPrewarm(agentId: string): Promise<void> {
        try {
            const agent = await this.loadAgent(agentId)
            if (agent.runtime !== 'sprites') return
            // A VM known to be refusing exec cannot be prewarmed, and one focus
            // event per composer against a 502ing endpoint is how #730 multiplied
            // the wasted handshakes. READ-ONLY: prewarm never claims the fleet's
            // one probe lease and never clears a cooldown — its `true` looks like
            // the probe, but spending the lease on a background wake would leave
            // the turn behind it with nothing to claim, and the turn is the one
            // that owes the user an answer.
            if (await this.spriteExecHealth?.isKnownUnavailable(agent.hostId))
                return
            const { driver } = await this.execDrivers!.forAgent(agentId, agent)
            const handle = driver.stream({
                cmd: ['true'],
                stdin: '',
                timeoutMs: 20_000
            })
            for await (const chunk of handle.stdout) void chunk
            await handle.result
            this.telemetry.event('chat.prewarm', { agentId })
        } catch (err) {
            // Quota rejections and transient wake failures are expected here;
            // the real turn surfaces them properly if they persist.
            this.logger.debug(
                `prewarm skipped for agent=${agentId} class=${safeErrorClass(err)}`
            )
        }
    }

    async sendMessage(
        userId: string,
        agentId: string,
        sessionId: string,
        text: string | undefined,
        attachments: CreateMessageAttachmentInput[] = [],
        modelOverride?: string,
        modelConfigSource?: AgentModelConfigSource | null,
        modelConfig?: AgentModelConfig | null,
        saveAsDefault?: boolean,
        claudeCodePermissionMode?: ClaudeCodePermissionMode | null,
        codexPermissionMode?: CodexPermissionMode | null,
        observer?: ChatTurnObserver,
        contextRefs: CreateMessageContextRefInput[] = [],
        uploads: CreateMessageUploadInput[] = [],
        // assistantMessageId lets a caller with a durable retry loop (channel
        // bridge) pre-record the planned turn id before this call, so a crash
        // between turn creation and its own bookkeeping is detectable instead
        // of producing a duplicate turn on replay. channelSource carries the
        // structured origin of an agent-managed channel turn to the adapter.
        opts?: {
            assistantMessageId?: string
            channelSource?: ChannelSource | null
        }
    ): Promise<{ userMessage: ChatMessage; assistantMessageId: string }> {
        const session = await this.assertSessionAccess(
            sessionId,
            userId,
            agentId
        )
        const agent = await this.loadAgent(agentId)
        const framework = agent.framework
        this.assertTurnOptions(
            framework,
            modelOverride,
            claudeCodePermissionMode,
            codexPermissionMode
        )
        const turnConfig = await this.resolveTurnConfig(
            userId,
            agentId,
            modelOverride,
            modelConfigSource,
            modelConfig,
            saveAsDefault
        )
        void this.markRuntimeActive(agentId)
        const adapter = this.adapters.get(framework)
        const contentBlocks = await this.buildUserContentBlocks(
            agentId,
            userId,
            framework,
            text,
            attachments,
            contextRefs,
            uploads
        )

        // Claim the session's single turn slot BEFORE inserting the user message,
        // so a rejected concurrent turn leaves no orphan user message. The claim is
        // released when this turn terminates (repo.insertStreamEvent on done/error)
        // or below if turn setup throws before the turn is handed to the adapter.
        const assistantMessageId = opts?.assistantMessageId ?? randomUUID()
        this.assertAcceptingTurns()

        try {
            // Inside the try that owns the matching endPendingTurn, so no
            // statement between the two can leave the slot marked and
            // unreleasable. endPendingTurn tolerates an id it never saw.
            this.beginPendingTurn(assistantMessageId)
            const claimed = await this.repo.claimInflightTurn(
                sessionId,
                assistantMessageId
            )
            // Losing the CAS means the claim names ANOTHER turn, and
            // releaseInflightTurn only clears a claim that names this one, so
            // the catch below cannot release the winner's slot.
            if (!claimed) throw new InflightTurnConflictError()
            if (this.drainingForShutdown) {
                await this.repo
                    .releaseInflightTurn(sessionId, assistantMessageId)
                    .catch(() => {})
                this.assertAcceptingTurns()
            }
            const userMessageRow = await this.repo.insertMessage({
                id: randomUUID(),
                sessionId,
                role: 'user',
                contentBlocksJson: contentBlocks,
                capabilityEventsJson: null,
                createdAt: new Date()
            })
            void this.markAgentMessaged(agentId)
            this.telemetry.event('chat.message.received', {
                sessionId,
                userId,
                agentId,
                framework,
                messageId: userMessageRow.id,
                attachments: attachments.length,
                contextRefs: contextRefs.length,
                uploads: uploads.length
            })

            if (session.title === null) {
                const derived = deriveTitleFromBlocks(contentBlocks)
                if (derived) {
                    await this.repo
                        .updateTitleIfEmpty(sessionId, derived)
                        .catch((err: Error) => {
                            this.logger.warn(
                                `failed to set title for session=${sessionId}: ${err.message}`
                            )
                        })
                }
            }

            // History is only consumed by adapters that replay it (codex builds
            // a fork transcript when it has no runtime session to resume;
            // openclaw/hermes/external-api send truncated context). claude-code
            // and gemini-cli resume via frameworkSessionRef and never read it,
            // so skip the full-session load on their hot path.
            const needsHistory =
                framework === 'codex'
                    ? !session.frameworkSessionRef
                    : framework !== 'claude-code' && framework !== 'gemini-cli'
            const historyRows = needsHistory
                ? await this.repo.listMessages(sessionId)
                : []
            await this.startAssistantTurn(
                adapter,
                session,
                userMessageRow,
                historyRows,
                framework,
                turnConfig,
                claudeCodePermissionMode,
                codexPermissionMode,
                observer,
                assistantMessageId,
                agent,
                opts?.channelSource ?? null
            )

            return {
                userMessage: toApiMessage(userMessageRow),
                assistantMessageId
            }
        } catch (err) {
            await this.repo
                .releaseInflightTurn(sessionId, assistantMessageId)
                .catch(() => {})
            throw err
        } finally {
            this.endPendingTurn(assistantMessageId)
        }
    }

    async regenerateMessage(
        userId: string,
        agentId: string,
        sessionId: string,
        messageId: string,
        text: string | undefined,
        modelOverride?: string,
        modelConfigSource?: AgentModelConfigSource | null,
        modelConfig?: AgentModelConfig | null,
        saveAsDefault?: boolean,
        codexPermissionMode?: CodexPermissionMode | null,
        observer?: ChatTurnObserver
    ): Promise<RegenerateMessageResponse> {
        const session = await this.assertSessionAccess(
            sessionId,
            userId,
            agentId
        )
        const agent = await this.loadAgent(agentId)
        const framework = agent.framework
        if (framework !== 'codex')
            throw new BadRequestException(
                'message regeneration is only supported for codex agents'
            )
        this.assertTurnOptions(
            framework,
            modelOverride,
            null,
            codexPermissionMode
        )

        const target = await this.repo.getMessage(sessionId, messageId)
        if (!target) throw new NotFoundException('message not found')
        if (target.role !== 'user')
            throw new BadRequestException('only user messages can be edited')

        const contentBlocks = this.buildRegeneratedUserContentBlocks(
            (target.contentBlocksJson as ChatContentBlock[]) ?? [],
            text
        )
        const turnConfig = await this.resolveTurnConfig(
            userId,
            agentId,
            modelOverride,
            modelConfigSource,
            modelConfig,
            saveAsDefault
        )

        // Claim the session's turn slot before the destructive rewrite; release it
        // if anything fails before the turn is handed to the adapter.
        const assistantMessageId = randomUUID()
        this.assertAcceptingTurns()

        try {
            this.beginPendingTurn(assistantMessageId)
            const claimed = await this.repo.claimInflightTurn(
                sessionId,
                assistantMessageId
            )
            if (!claimed) throw new InflightTurnConflictError()
            if (this.drainingForShutdown) {
                await this.repo
                    .releaseInflightTurn(sessionId, assistantMessageId)
                    .catch(() => {})
                this.assertAcceptingTurns()
            }
            const rewrite = await this.repo.rewriteMessageAndDeleteAfter(
                sessionId,
                messageId,
                contentBlocks
            )
            if (!rewrite) throw new NotFoundException('message not found')

            void this.markRuntimeActive(agentId)
            void this.markAgentMessaged(agentId)
            const adapter = this.adapters.get(framework)
            const forkedSession = { ...session, frameworkSessionRef: null }
            await this.startAssistantTurn(
                adapter,
                forkedSession,
                rewrite.userMessage,
                rewrite.historyRows,
                framework,
                turnConfig,
                null,
                codexPermissionMode,
                observer,
                assistantMessageId,
                agent
            )

            this.telemetry.event('chat.message.regenerated', {
                sessionId,
                userId,
                agentId,
                framework,
                messageId,
                assistantMessageId,
                deletedMessageCount: rewrite.deletedMessageIds.length
            })

            return {
                userMessage: toApiMessage(rewrite.userMessage),
                assistantMessageId,
                deletedMessageIds: rewrite.deletedMessageIds
            }
        } catch (err) {
            await this.repo
                .releaseInflightTurn(sessionId, assistantMessageId)
                .catch(() => {})
            throw err
        } finally {
            this.endPendingTurn(assistantMessageId)
        }
    }

    async subscribeStream(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<DbChatSession> {
        const session = await this.assertSessionAccess(
            sessionId,
            userId,
            agentId
        )
        await this.terminalizeDeadInflightTurn(sessionId)
        return session
    }

    // A turn that died without a terminal — its API process crashed mid-stream,
    // or runAdapter's own error path threw and the outer catch only logged —
    // still satisfies the DB's "inflight" predicate (no done/error event), so a
    // web reload replays its partial tokens and pins a working indicator that
    // never resolves. Force a retryable terminal on subscribe so the replay
    // ends and the UI can retry. Liveness is the same signal cancelStream uses:
    // a turn still running in THIS process (runningAdapters) is left alone, and
    // latestDeadInflightMessage applies the bootstrap sweep's daemon-liveness
    // predicate so a daemon turn that will resume via DaemonExecResumeService is
    // never reported dead.
    private async terminalizeDeadInflightTurn(
        sessionId: string
    ): Promise<void> {
        const dead = await this.repo.latestDeadInflightMessage(sessionId)
        if (!dead) return
        if (this.runningAdapters.has(dead.messageId)) return
        if (this.broadcaster.hasStream(dead.messageId)) return
        // A turn with a live execution record belongs to the adoption sweep, not
        // the terminalize path — nudge the sweep and leave the turn alone so a
        // deploy-orphaned turn is recovered instead of killed.
        const exec = await this.repo.getTurnExecution(dead.messageId)
        if (exec && exec.state !== 'done' && exec.state !== 'failed') {
            if (
                (exec.runtime === 'sprites' || exec.runtime === 'external') &&
                this.turnAdoption?.enabled
            ) {
                this.turnAdoption.kick()
                return
            }
        }
        let fence: TurnExecutionFence | null = null
        try {
            fence = await this.claimReconciliationFence(dead.messageId)
        } catch {
            return
        }
        if (fence)
            await this.broadcaster.beginResumeStream(
                sessionId,
                dead.messageId,
                fence
            )
        else
            this.broadcaster.beginStream(
                sessionId,
                dead.messageId,
                dead.lastSeq
            )
        const event = interruptedErrorEvent()
        const { persisted } = await this.broadcaster.emit(
            dead.messageId,
            {
                type: event.type,
                payload: event as unknown as Record<string, unknown>,
                sourceEventKey: SERVER_RESTART_SOURCE_EVENT_KEY,
                sourceEventOrdinal: 0
            },
            { replayFromStream: true }
        )
        if (persisted)
            await this.emitDurableTerminalTelemetry({
                sessionId,
                messageId: dead.messageId,
                outcome: 'error',
                errorCode: event.error.code,
                via: 'restart_terminal'
            })
    }

    // The message-scoped twin of terminalizeDeadInflightTurn: an A2A task names
    // its own assistantMessageId, so resubscribe/get must sweep THAT turn (not
    // the session's latest) before replaying, or a restart-orphaned turn replays
    // and then hangs forever waiting for a terminal. Reuses the same dedup key so
    // it no-ops against the session-scoped path on the same message.
    async terminalizeDeadInflightMessage(
        assistantMessageId: string
    ): Promise<void> {
        const dead = await this.repo.deadInflightMessageById(assistantMessageId)
        if (!dead) return
        if (this.runningAdapters.has(dead.messageId)) return
        if (this.broadcaster.hasStream(dead.messageId)) return
        // Same adoption guard as the session-scoped path: a turn with a live
        // execution record belongs to the adoption sweep — an A2A resubscribe
        // mid-gap must not kill a turn adoption would recover.
        const exec = await this.repo.getTurnExecution(dead.messageId)
        if (exec && exec.state !== 'done' && exec.state !== 'failed') {
            if (
                (exec.runtime === 'sprites' || exec.runtime === 'external') &&
                this.turnAdoption?.enabled
            ) {
                this.turnAdoption.kick()
                return
            }
        }
        let fence: TurnExecutionFence | null = null
        try {
            fence = await this.claimReconciliationFence(dead.messageId)
        } catch {
            return
        }
        if (fence)
            await this.broadcaster.beginResumeStream(
                dead.sessionId,
                dead.messageId,
                fence
            )
        else
            this.broadcaster.beginStream(
                dead.sessionId,
                dead.messageId,
                dead.lastSeq
            )
        const event = interruptedErrorEvent()
        const { persisted } = await this.broadcaster.emit(
            dead.messageId,
            {
                type: event.type,
                payload: event as unknown as Record<string, unknown>,
                sourceEventKey: SERVER_RESTART_SOURCE_EVENT_KEY,
                sourceEventOrdinal: 0
            },
            { replayFromStream: true }
        )
        if (persisted)
            await this.emitDurableTerminalTelemetry({
                sessionId: dead.sessionId,
                messageId: dead.messageId,
                outcome: 'error',
                errorCode: event.error.code,
                via: 'restart_terminal'
            })
    }

    private async buildUserContentBlocks(
        agentId: string,
        userId: string,
        framework: AgentFramework,
        text: string | undefined,
        attachments: CreateMessageAttachmentInput[],
        contextRefs: CreateMessageContextRefInput[],
        uploads: CreateMessageUploadInput[]
    ): Promise<ChatContentBlock[]> {
        if (
            attachments.length + contextRefs.length + uploads.length >
            CHAT_ATTACHMENT_MAX_COUNT
        )
            throw new BadRequestException(
                `at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments or context refs are allowed`
            )
        const normalizedText = text?.trim() ?? ''
        const normalizedAttachments = await this.normalizeAttachments(
            agentId,
            attachments
        )
        const normalizedContextRefs = await this.normalizeContextRefs(
            agentId,
            contextRefs
        )
        const normalizedUploads = await this.normalizeUploads(
            agentId,
            userId,
            framework,
            uploads
        )
        if (
            !normalizedText &&
            normalizedAttachments.length === 0 &&
            normalizedContextRefs.length === 0 &&
            normalizedUploads.length === 0
        )
            throw new BadRequestException(
                'text, attachments, or context refs are required'
            )
        const blocks: ChatContentBlock[] = []
        if (normalizedText) blocks.push({ type: 'text', text: normalizedText })
        blocks.push(...normalizedAttachments)
        blocks.push(...normalizedContextRefs)
        blocks.push(...normalizedUploads)
        return blocks
    }

    private async normalizeUploads(
        agentId: string,
        userId: string,
        framework: AgentFramework,
        uploads: CreateMessageUploadInput[]
    ): Promise<ChatUploadBlock[]> {
        if (uploads.length === 0) return []
        if (framework !== 'dify')
            throw new BadRequestException(
                `framework ${framework} does not support uploads`
            )
        if (!this.uploads)
            throw new ServiceUnavailableException(
                'chat-upload storage is not configured'
            )
        if (uploads.length > CHAT_UPLOAD_MAX_COUNT)
            throw new BadRequestException(
                `at most ${CHAT_UPLOAD_MAX_COUNT} uploads are allowed`
            )
        const blocks: ChatUploadBlock[] = []
        let totalSize = 0
        for (const upload of uploads) {
            if (!isObjectId(upload.uploadId, 'chatUpload'))
                throw new BadRequestException(
                    `invalid upload id: ${upload.uploadId}`
                )
            const stat = await this.uploads.stat(
                upload.uploadId,
                userId,
                agentId
            )
            if (!stat)
                throw new BadRequestException(
                    `upload not found: ${upload.uploadId}`
                )
            if (stat.size > CHAT_UPLOAD_MAX_FILE_BYTES)
                throw new BadRequestException(
                    `upload exceeds ${CHAT_UPLOAD_MAX_FILE_BYTES} bytes: ${upload.uploadId}`
                )
            totalSize += stat.size
            if (totalSize > CHAT_UPLOAD_MAX_TOTAL_BYTES)
                throw new BadRequestException(
                    `uploads exceed ${CHAT_UPLOAD_MAX_TOTAL_BYTES} bytes total`
                )
            blocks.push({
                type: 'upload',
                uploadId: stat.id,
                name: upload.name?.trim() || stat.name,
                contentType: upload.contentType?.trim() || stat.contentType,
                size: stat.size
            })
        }
        return blocks
    }

    private async normalizeAttachments(
        agentId: string,
        attachments: CreateMessageAttachmentInput[]
    ): Promise<ChatAttachmentBlock[]> {
        if (attachments.length === 0) return []
        if (
            attachments.some(
                (attachment) =>
                    attachment.rootId && attachment.rootId !== 'workspace'
            )
        )
            throw new BadRequestException('attachments must use workspace root')
        const agent = await this.loadAgent(agentId)
        const ctx = await this.files.build(agent, 'workspace')
        if (ctx.root.id !== 'workspace')
            throw new BadRequestException('attachments must use workspace root')

        const blocks: ChatAttachmentBlock[] = []
        let totalSize = 0
        for (const attachment of attachments) {
            const absPath = resolveSafePath(ctx.mountPath, attachment.path)
            const stat = await ctx.stat(absPath)
            if (!stat || stat.entry.type !== 'file')
                throw new BadRequestException(
                    `attachment not found: ${attachment.path}`
                )
            if (stat.entry.size > CHAT_ATTACHMENT_MAX_FILE_BYTES)
                throw new BadRequestException(
                    `attachment exceeds ${CHAT_ATTACHMENT_MAX_FILE_BYTES} bytes: ${attachment.path}`
                )
            totalSize += stat.entry.size
            if (totalSize > CHAT_ATTACHMENT_MAX_TOTAL_BYTES)
                throw new BadRequestException(
                    `attachments exceed ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES} bytes total`
                )
            blocks.push({
                type: 'attachment',
                name:
                    attachment.name?.trim() ||
                    stat.entry.name ||
                    attachment.path.split('/').filter(Boolean).at(-1) ||
                    'attachment',
                path: absPath,
                rootId: 'workspace',
                contentType:
                    stat.contentType ||
                    attachment.contentType?.trim() ||
                    'application/octet-stream',
                size: stat.entry.size
            })
        }
        return blocks
    }

    private async normalizeContextRefs(
        agentId: string,
        contextRefs: CreateMessageContextRefInput[]
    ): Promise<ChatContextRefBlock[]> {
        if (contextRefs.length === 0) return []
        const agent = await this.loadAgent(agentId)
        const blocks: ChatContextRefBlock[] = []

        for (const ref of contextRefs) {
            const rootId = ref.rootId?.trim() || 'workspace'
            const ctx = await this.files.build(agent, rootId)
            const absPath = resolveSafePath(ctx.mountPath, ref.path)
            const stat = await ctx.stat(absPath)
            if (!stat)
                throw new BadRequestException(
                    `context ref not found: ${ref.path}`
                )
            if (stat.entry.type !== 'file' && stat.entry.type !== 'dir')
                throw new BadRequestException(
                    `context ref must be a file or directory: ${ref.path}`
                )
            if (ref.entryType && ref.entryType !== stat.entry.type)
                throw new BadRequestException(
                    `context ref type mismatch: ${ref.path}`
                )

            blocks.push({
                type: 'context_ref',
                name:
                    ref.name?.trim() ||
                    stat.entry.name ||
                    ref.path.split('/').filter(Boolean).at(-1) ||
                    ctx.root.label ||
                    'context',
                path: absPath,
                rootId: ctx.root.id,
                entryType: stat.entry.type,
                ...(stat.entry.type === 'file'
                    ? {
                          contentType:
                              stat.contentType ||
                              ref.contentType?.trim() ||
                              'application/octet-stream',
                          size: stat.entry.size
                      }
                    : {})
            })
        }

        return blocks
    }

    private buildRegeneratedUserContentBlocks(
        existingBlocks: ChatContentBlock[],
        text: string | undefined
    ): ChatContentBlock[] {
        const normalizedText = text?.trim() ?? ''
        const next: ChatContentBlock[] = []
        let sawText = false
        let insertedText = false

        for (const block of existingBlocks) {
            if (block.type === 'text') {
                sawText = true
                if (normalizedText && !insertedText) {
                    next.push({ type: 'text', text: normalizedText })
                    insertedText = true
                }
                continue
            }
            if (block.type === 'attachment' || block.type === 'context_ref')
                next.push(block)
        }

        if (!sawText && normalizedText)
            next.unshift({ type: 'text', text: normalizedText })

        if (!normalizedText && next.length === 0)
            throw new BadRequestException(
                'text, attachments, or context refs are required'
            )

        return next
    }

    private assertTurnOptions(
        framework: AgentFramework,
        modelOverride?: string,
        claudeCodePermissionMode?: ClaudeCodePermissionMode | null,
        codexPermissionMode?: CodexPermissionMode | null
    ): void {
        if (modelOverride && !MESSAGE_MODEL_OVERRIDE_FRAMEWORKS.has(framework))
            throw new BadRequestException(
                `model override is not supported for framework ${framework}`
            )
        if (claudeCodePermissionMode && framework !== 'claude-code')
            throw new BadRequestException(
                `claude code permission mode is not supported for framework ${framework}`
            )
        if (codexPermissionMode && framework !== 'codex')
            throw new BadRequestException(
                `codex permission mode is not supported for framework ${framework}`
            )
    }

    private async resolveTurnConfig(
        userId: string,
        agentId: string,
        modelOverride?: string,
        modelConfigSource?: AgentModelConfigSource | null,
        modelConfig?: AgentModelConfig | null,
        saveAsDefault?: boolean
    ): Promise<ChatTurnConfig> {
        if (!this.modelConfigs)
            return {
                model: modelOverride ?? null,
                modelConfig: null
            }

        return this.modelConfigs.resolveTurnConfig({
            callerUserId: userId,
            agentId,
            model: modelOverride ?? null,
            modelConfigSource: modelConfigSource ?? null,
            modelConfig: modelConfig ?? null,
            saveAsDefault: saveAsDefault === true
        })
    }

    private async startAssistantTurn(
        adapter: ReturnType<ChatAdapterRegistry['get']>,
        session: DbChatSession,
        userMessageRow: DbChatMessage,
        historyRows: DbChatMessage[],
        framework: AgentFramework,
        turnConfig: ChatTurnConfig,
        claudeCodePermissionMode?: ClaudeCodePermissionMode | null,
        codexPermissionMode?: CodexPermissionMode | null,
        observer?: ChatTurnObserver,
        assistantMessageId: string = randomUUID(),
        agent?: Agent,
        channelSource?: ChannelSource | null
    ): Promise<string> {
        await this.repo.insertMessage({
            id: assistantMessageId,
            sessionId: session.id,
            role: 'assistant',
            contentBlocksJson: [],
            capabilityEventsJson: messageMetadataForTurn(turnConfig.model),
            createdAt: new Date()
        })

        const history = historyRows.map((row) => toApiMessage(row))
        this.broadcaster.beginStream(session.id, assistantMessageId)

        const abortController = new AbortController()
        if (!this.trackRunningAdapter(assistantMessageId, abortController))
            throw new InflightTurnConflictError()

        // The arguments below are evaluated AFTER the registration and before
        // runAdapter returns the promise that carries the untracking finally
        // — toApiMessage() throwing in that window used to leak the entry,
        // and a leaked entry is permanent: the drain never reaches zero
        // again.
        let run: Promise<void>
        try {
            run = this.runAdapter(
                adapter,
                session,
                toApiMessage(userMessageRow),
                assistantMessageId,
                history,
                turnConfig.model,
                turnConfig.modelConfig,
                turnConfig.runtimeLocalTuning ?? null,
                framework === 'claude-code'
                    ? (claudeCodePermissionMode ??
                          DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
                    : null,
                framework === 'codex'
                    ? (codexPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE)
                    : null,
                abortController.signal,
                observer,
                agent,
                channelSource
            )
        } catch (err) {
            this.broadcaster.endStream(assistantMessageId)
            this.untrackRunningAdapter(assistantMessageId, abortController)
            throw err
        }

        void run
            .catch(async (err: Error) => {
                if (err instanceof TurnOwnershipUnavailableError) {
                    this.logger.warn(err.message)
                    const event = interruptedErrorEvent()
                    try {
                        const { persisted } = await this.broadcaster.emit(
                            assistantMessageId,
                            {
                                type: event.type,
                                payload: event as unknown as Record<
                                    string,
                                    unknown
                                >,
                                sourceEventKey: SERVER_RESTART_SOURCE_EVENT_KEY,
                                sourceEventOrdinal: 0
                            },
                            {
                                contentBlocksJson: [],
                                contentCheckpointEventId: null
                            }
                        )
                        if (persisted)
                            await this.emitDurableTerminalTelemetry({
                                sessionId: session.id,
                                messageId: assistantMessageId,
                                outcome: 'error',
                                errorCode: event.error.code,
                                via: 'restart_terminal',
                                session
                            })
                    } catch (terminalError) {
                        this.logger.warn(
                            `ownership failure terminal unavailable messageId=${assistantMessageId}: ${(terminalError as Error).message}`
                        )
                    }
                    return
                }
                this.logger.error(
                    `adapter run failed for session=${session.id}: ${err.message}`
                )
                this.reportStreamError({
                    err,
                    detail: err.message,
                    errorCode: httpErrorCode(err) ?? null,
                    // Nothing durable was written, so there is no ChatError to
                    // read a retryable flag off; the runtime is equally
                    // unknown here because resolveAgentContext is one of the
                    // things that can throw into this catch.
                    retryable: null,
                    turnPhase: 'dispatch',
                    framework,
                    runtimeKind: UNKNOWN_RUNTIME_KIND,
                    session,
                    assistantMessageId
                })
                // The adapter run rejected without emitting a terminal event (e.g.
                // resolveAgentContext threw before the stream loop), so the
                // inflight-turn lock was never released by insertStreamEvent. A
                // stamped turn is recoverable work: handing its exact generation
                // back while retaining the claim prevents a newer turn entering
                // the session before recovery. An unstamped setup failure has no
                // carrier to recover and may release as before.
                const fence = this.turnFences.get(assistantMessageId)
                this.broadcaster.endStream(assistantMessageId, fence)
                if (fence)
                    await this.repo
                        .handoffOwnedTurn(
                            assistantMessageId,
                            fence.ownerId,
                            fence.generation
                        )
                        .catch(() => false)
                else
                    await this.repo
                        .releaseInflightTurn(session.id, assistantMessageId)
                        .catch(() => false)
            })
            .finally(() => {
                this.untrackRunningAdapter(assistantMessageId, abortController)
            })

        return assistantMessageId
    }

    async resumeAssistantTurn(args: {
        message: DbChatMessage
        daemonId: string
        refId: string
    }): Promise<DaemonResumeOutcome> {
        const { message, daemonId, refId } = args
        // The shutdown drain hands this instance's turns to a peer; a recheck
        // timer armed in a dying process would not survive to fire anyway.
        if (this.drainingForShutdown) return 'handled'
        const abortController = new AbortController()
        let claimed: TurnExecutionRow | null = null
        if (!this.trackRunningAdapter(message.id, abortController, 'resume')) {
            // A transcript adoption is the one holder this hello outranks; see
            // preemptAdoptionForResume. A dispatch is the live carrier and a
            // resume is this same path already in flight — neither is weaker,
            // so both still decline.
            claimed =
                this.turnOrigins.get(message.id) === 'adoption'
                    ? await this.preemptAdoptionForResume({
                          message,
                          daemonId,
                          refId
                      })
                    : null
            if (!claimed) {
                this.logger.log(
                    `resume skipped messageId=${message.id} (already running locally)`
                )
                return 'skipped_running_locally'
            }
            if (
                !this.trackRunningAdapter(message.id, abortController, 'resume')
            ) {
                // A repeat hello can occupy the local slot in the narrow gap
                // after the displaced adoption releases it. We already own a
                // bumped durable generation at that point; give that exact
                // claim back instead of leaving a carrier-less 90-second live
                // lease that every repeat hello must defer behind.
                await this.repo
                    .handoffOwnedTurn(
                        message.id,
                        claimed.ownerId,
                        claimed.generation
                    )
                    .catch(() => false)
                // Reported, not just logged: the execution holding the turn can
                // still end without settling it (the #624 fence declines a
                // crashed buffer and suspends), and then this hello was the
                // last thing scheduled to look at the ref (#648).
                this.logger.log(
                    `resume skipped messageId=${message.id} (already running locally)`
                )
                return 'skipped_running_locally'
            }
            this.logger.log(
                `resume took messageId=${message.id} from a transcript adoption (generation=${claimed.generation})`
            )
        }
        let fence: TurnExecutionFence | null = null
        let awakeHold: SpriteAwakeHold | null = null
        let resumeSuspended = false
        let leaseTimer: ReturnType<typeof setInterval> | null = null
        let resumeFenceLost = false
        try {
            const session = await this.repo.getSessionById(message.sessionId)
            if (!session) {
                this.logger.warn(
                    `resume skipped messageId=${message.id} (session ${message.sessionId} not found)`
                )
                return 'handled'
            }
            const agentCtx = await this.resolveAgentContext(session.agentId)
            if (!claimed) {
                const ownerId = this.turnAdoption?.ownerId
                if (!ownerId) {
                    this.logger.warn(
                        `resume skipped messageId=${message.id} (no durable owner identity)`
                    )
                    return 'skipped_owned_elsewhere'
                }
                let ownership
                try {
                    ownership = await this.repo.claimTurnForResume({
                        messageId: message.id,
                        sessionId: session.id,
                        daemonId,
                        daemonExecRef: refId,
                        ownerId,
                        leaseSeconds: TURN_LEASE_SECONDS
                    })
                } catch (err) {
                    this.logger.warn(
                        `resume claim failed messageId=${message.id}: ${(err as Error).message}`
                    )
                    return 'skipped_owned_elsewhere'
                }
                if (ownership.outcome === 'busy') {
                    this.logger.log(
                        `resume skipped messageId=${message.id} (owned by a live carrier)`
                    )
                    return 'skipped_owned_elsewhere'
                }
                if (ownership.outcome !== 'claimed') return 'handled'
                claimed = ownership.row
            }
            fence = {
                messageId: message.id,
                ownerId: claimed.ownerId,
                generation: claimed.generation
            }
            this.setTurnFence(fence)
            const adapter = this.adapters.get(agentCtx.framework)
            if (!adapter.resumeMessage) {
                // A sprite turn already has a better answer waiting: the
                // adoption sweep rebuilds it from the framework transcript.
                // Terminalizing here would let the daemon's reconnect DESTROY
                // that path — the reconnect is supposed to help the turn, not
                // end it. Leave the turn open and let adoption have it.
                if (
                    claimed.runtime === 'sprites' ||
                    claimed.runtime === 'external'
                ) {
                    await this.repo
                        .handoffOwnedTurn(
                            message.id,
                            fence.ownerId,
                            fence.generation
                        )
                        .catch(() => undefined)
                    this.logger.log(
                        `resume unsupported for ${agentCtx.framework}; leaving messageId=${message.id} to adoption`
                    )
                    this.telemetry.event('chat.turn.resume', {
                        messageId: message.id,
                        framework: agentCtx.framework,
                        runtime: agentCtx.runtime,
                        daemonId,
                        outcome: 'deferred_to_adoption'
                    })
                    return 'handled'
                }
                await this.failResumeUnsupported(session, message, fence)
                return 'handled'
            }
            // A runner turn: the daemon carrying it lives inside the sprite, so
            // the resumed remainder needs the same awake lease the dispatching
            // instance held. Its lease died with it (or is about to expire), and
            // an unheld sprite suspends the runner mid-answer.
            awakeHold = await this.holdRunnerSpriteAwake(agentCtx, {
                agentId: session.agentId,
                turnId: message.id
            })
            await this.broadcaster.beginResumeStream(
                session.id,
                message.id,
                fence
            )
            // A daemon stream can legitimately run for the turn's whole
            // remaining life, so the claim above has to be kept alive or a
            // sweep would find the turn adoptable under a live resume.
            const renewOwnerId = fence.ownerId
            leaseTimer = setInterval(() => {
                void this.repo
                    .renewTurnLease(
                        message.id,
                        renewOwnerId,
                        TURN_LEASE_SECONDS,
                        fence!.generation
                    )
                    .then((renewed) => {
                        if (renewed) return
                        resumeFenceLost = true
                        abortController.abort(
                            new TurnFenceLostError(message.id)
                        )
                    })
                    .catch(() => undefined)
            }, TURN_LEASE_RENEW_MS)
            leaseTimer.unref?.()
            const resumeStatusOrdinal = await this.resumingStatusOrdinal(
                message.id
            )
            if (resumeStatusOrdinal !== null)
                await this.emitTurnStatus(
                    message.id,
                    'resuming',
                    resumeStatusOrdinal
                )
            const replaysWholeSource = OPENCLAW_REPLAY_FRAMEWORKS.has(
                agentCtx.framework
            )
            const fromSeq = replaysWholeSource
                ? 0
                : await this.resumeFromSeq(message.id)
            const streamEvents =
                replaysWholeSource || fromSeq > 0
                    ? await this.repo.listStreamEventsSince(message.id, 0n)
                    : []
            const outcome = await this.runAdapterFromIterable(
                adapter.resumeMessage({
                    userId: session.userId,
                    agentId: session.agentId,
                    runtimeId: agentCtx.runtimeId,
                    sessionId: session.id,
                    messageId: message.id,
                    framework: agentCtx.framework,
                    runtimeKind: agentCtx.runtime,
                    model: agentCtx.model,
                    modelOverride: null,
                    modelProviderId: agentCtx.modelProviderId,
                    modelProviderBuiltInId: agentCtx.modelProviderBuiltInId,
                    modelConfig: null,
                    claudeCodePermissionMode: null,
                    codexPermissionMode: null,
                    frameworkSessionRef: session.frameworkSessionRef,
                    history: [],
                    abortSignal: abortController.signal,
                    turnFence: fence,
                    daemonId,
                    daemonExecRef: refId,
                    fromSeq
                }),
                session,
                message.id,
                agentCtx,
                abortController.signal,
                {
                    startedAt: message.createdAt.getTime(),
                    via: 'resume',
                    fence,
                    // Replaying from 0 re-derives every block, so seeding would
                    // double them; skipping ahead does not, so the already-stored
                    // prefix has to be seeded or persistContent would overwrite the
                    // message with just the resumed tail.
                    initialEvents: fromSeq > 0 ? streamEvents : [],
                    replayedContent: replaysWholeSource
                        ? replayedContentByKey(streamEvents)
                        : undefined
                }
            )
            resumeSuspended = outcome.suspended
            resumeFenceLost = outcome.fenceLost
            if (outcome.fenceLost) {
                this.telemetry.event('chat.turn.resume', {
                    messageId: message.id,
                    framework: agentCtx.framework,
                    runtime: agentCtx.runtime,
                    daemonId,
                    fromSeq,
                    outcome: 'fenced_out'
                })
                return 'handled'
            }
            this.telemetry.event('chat.turn.resume', {
                messageId: message.id,
                framework: agentCtx.framework,
                runtime: agentCtx.runtime,
                daemonId,
                fromSeq,
                // 0 means the cursor was unavailable and the whole turn was
                // replayed — safe, but it says the cursor is not doing its job.
                // The outcome is the turn's REAL terminal: this used to report
                // every non-resuspended resume as converged, so a resumed turn
                // that failed read as a success (#544).
                outcome: outcome.suspended
                    ? 'suspended_again'
                    : outcome.outcome,
                ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {})
            })
        } catch (err) {
            const lostFence =
                resumeFenceLost || err instanceof TurnFenceLostError
            this.logger.warn(
                lostFence
                    ? `resume fenced out messageId=${message.id}; stopping this carrier`
                    : `resume turn failed messageId=${message.id}: ${(err as Error).message}`
            )
            // No chat.turn.terminal here on purpose: nothing was terminalized,
            // so claiming one would break the durable-to-funnel parity. The
            // writer that eventually converges this turn emits it.
            this.telemetry.event('chat.turn.resume', {
                messageId: message.id,
                daemonId,
                outcome: lostFence ? 'fenced_out' : 'failed',
                ...(lostFence ? {} : { errorMessage: (err as Error).message })
            })
            // Only if this process still owns the turn. The claim is the whole
            // point: once another owner holds it, the inflight claim belongs to
            // THEIR live turn, and releasing it here would let a second turn
            // start on the session under them.
            const stillOwned = !lostFence && fence !== null
            if (fence) this.broadcaster.endStream(message.id, fence)
            if (stillOwned && fence) {
                // Keep the session claim. A matched retry requires it to still
                // name this message; releasing it here made every later hello
                // fail claimTurnForResume's identity check and left a daemon
                // turn nonterminal forever. Hand this exact generation back
                // instead, then report a skipped outcome so the daemon resume
                // coordinator arms its bounded retry.
                await this.repo
                    .handoffOwnedTurn(
                        message.id,
                        fence.ownerId,
                        fence.generation
                    )
                    .catch(() => false)
                return 'skipped_owned_elsewhere'
            } else
                this.logger.warn(
                    `resume for messageId=${message.id} lost the turn to another owner; leaving the inflight claim to them`
                )
        } finally {
            if (leaseTimer) clearInterval(leaseTimer)
            // Same rule as the dispatch path: a resume that suspends again has
            // handed the work back to the runner, so the lease must survive.
            if (awakeHold) {
                if (resumeSuspended) awakeHold.detach()
                else await awakeHold.release().catch(() => undefined)
            }
            this.untrackRunningAdapter(message.id, abortController)
        }
        return 'handled'
    }

    // Only for a sprite turn carried by a daemon — i.e. the sprite's own
    // runner. A daemon-runtime turn runs on the user's machine and has no
    // sprite to keep awake.
    private async holdRunnerSpriteAwake(
        agentCtx: { runtime: AgentRuntime; spriteName: string | null },
        args: { agentId: string; turnId: string }
    ): Promise<SpriteAwakeHold | null> {
        if (!this.runnerManager) return null
        if (agentCtx.runtime !== 'sprites' || !agentCtx.spriteName) return null
        const exec = await this.spriteExecFor(
            args.agentId,
            agentCtx.spriteName
        ).catch((err: Error) => {
            this.logger.warn(
                `sprite awake-hold unavailable agentId=${args.agentId}: ${err.message}`
            )
            return null
        })
        if (!exec) return null
        return this.runnerManager.keepSpriteAwake({
            exec,
            turnId: args.turnId
        })
    }

    private async claimReconciliationFence(
        messageId: string
    ): Promise<TurnExecutionFence | null> {
        const execution = await this.repo.getTurnExecution(messageId)
        if (!execution) return null
        if (execution.state === 'done' || execution.state === 'failed')
            return null
        const ownerId = this.turnAdoption?.ownerId
        if (!ownerId) throw new TurnFenceLostError(messageId)
        const claimed = await this.repo.claimTurnForReconciliation(
            messageId,
            ownerId,
            TURN_LEASE_SECONDS
        )
        if (!claimed) throw new TurnFenceLostError(messageId)
        return {
            messageId,
            ownerId: claimed.ownerId,
            generation: claimed.generation
        }
    }

    async completeOfflineCancel(args: {
        message: DbChatMessage
        daemonId: string
        refId: string
    }): Promise<void> {
        const { message } = args
        const session = await this.repo.getSessionById(message.sessionId)
        if (!session) return
        const fence = await this.claimReconciliationFence(message.id)
        if (fence)
            await this.broadcaster.beginResumeStream(
                session.id,
                message.id,
                fence
            )
        else if (!this.broadcaster.hasStream(message.id))
            this.broadcaster.beginStream(
                session.id,
                message.id,
                await this.repo.maxStreamEventSeq(message.id),
                fence
            )
        const terminalContent = { replayFromStream: true } as const
        const cancelEvent = cancelledByUserEvent()
        const { persisted } = await this.broadcaster.emit(
            message.id,
            {
                type: cancelEvent.type,
                payload: cancelEvent as unknown as Record<string, unknown>
            },
            terminalContent
        )
        this.broadcaster.endStream(message.id, fence ?? undefined)
        if (!persisted) throw new TurnFenceLostError(message.id)
        if (persisted)
            await this.emitDurableTerminalTelemetry({
                sessionId: session.id,
                messageId: message.id,
                outcome: 'cancelled',
                errorCode: CANCELLED_BY_USER_CODE,
                via: 'offline_cancel',
                session,
                message
            })
    }

    private async failResumeUnsupported(
        session: DbChatSession,
        message: DbChatMessage,
        fence: TurnExecutionFence
    ): Promise<void> {
        await this.broadcaster.beginResumeStream(session.id, message.id, fence)
        const { persisted } = await this.broadcaster.emit(message.id, {
            type: 'error',
            payload: {
                type: 'error',
                error: {
                    code: 'resume_unsupported',
                    message:
                        'this adapter does not support resume; please retry',
                    retryable: true
                }
            }
        })
        this.broadcaster.endStream(message.id, fence)
        if (persisted)
            await this.emitDurableTerminalTelemetry({
                sessionId: session.id,
                messageId: message.id,
                outcome: 'error',
                errorCode: 'resume_unsupported',
                via: 'resume_unsupported',
                session,
                message
            })
    }

    // Adopt a turn orphaned by a deploy/crash/auto-stop (claimed by
    // TurnAdoptionService) and finish it under the SAME assistantMessageId so
    // web SSE, the channel sweep and A2A all converge without a re-run.
    //
    // External turns branch out to adoptExternalTurnExecution, which converges
    // against the upstream instead of a local record. The rest finish from the
    // framework's on-disk record: Claude turns re-poll the session transcript
    // (seen-state rebuilt from the durable log, recoverTurnFromClaudeJsonl
    // emits only the unseen tail); Codex turns re-poll the rollout (explicit
    // task_started/task_complete framing, per-kind text cursors dedup the
    // delivered prefix); gemini-cli turns re-poll their append-only session
    // JSONL and emit once at the terminal poll. Frameworks outside that set —
    // and any recovery miss — close out with the retryable server_restart
    // terminal. Throwing leaves the lease held-then-lapsing so a later sweep
    // retries.
    async adoptTurnExecution(row: TurnExecutionRow): Promise<void> {
        if (this.drainingForShutdown) return
        if (this.runningAdapters.has(row.messageId)) return
        const message = await this.repo.getMessageById(row.messageId)
        if (!message) return
        const session = await this.repo.getSessionById(row.sessionId)
        if (!session) return
        if (this.drainingForShutdown) {
            if (this.turnAdoption?.enabled)
                await this.repo
                    .handoffOwnedTurn(
                        row.messageId,
                        this.turnAdoption.ownerId,
                        row.generation
                    )
                    .catch(() => undefined)
            return
        }
        const abortController = new AbortController()
        // The has() pre-filter above only saves the two reads; THIS is the
        // arbitration, because a daemon resume can register inside them.
        if (
            !this.trackRunningAdapter(
                row.messageId,
                abortController,
                'adoption'
            )
        )
            return
        // The claim that produced this row bumped its generation, so this pair
        // is exactly the ownership this adoption may write under. A matched
        // daemon hello outranks a transcript replay and can supersede it
        // mid-stream; from that instant every write below is refused by
        // Postgres, on this instance and on any other.
        const fence: TurnExecutionFence = {
            messageId: row.messageId,
            ownerId: row.ownerId,
            generation: row.generation
        }
        this.setTurnFence(fence)
        try {
            const agentCtx = await this.resolveAgentContext(session.agentId)
            if (row.runtime === 'external') {
                await this.adoptExternalTurnExecution(
                    row,
                    session,
                    message,
                    agentCtx,
                    abortController,
                    fence
                )
                return
            }
            const adoptable =
                agentCtx.framework === 'claude-code' ||
                ((agentCtx.framework === 'codex' ||
                    agentCtx.framework === 'gemini-cli') &&
                    !!session.frameworkSessionRef)
            if (!adoptable || !this.execDrivers) {
                // A daemon-carried turn may still be executing inside its
                // runner, and terminalizing it here is irreversible: the resume
                // path only matches turns WITHOUT a terminal, so writing one
                // destroys the recovery that was seconds away. Right after a
                // restart the daemon has not reconnected yet, so "is it online"
                // answers no — the question that matters is whether it was seen
                // recently enough to plausibly come back.
                //
                // Seen on staging 2026-07-28: a hermes runner turn was
                // killed with `server_restart` by exactly this branch (hermes is
                // not in the adoptable list) before its runner re-dialled.
                //
                // The grace bounds the hang: past it, terminalize as before so a
                // turn whose daemon is gone for good still converges.
                const carrier = await this.repo
                    .daemonSeenWithin(
                        message.daemonId,
                        DAEMON_RECONNECT_GRACE_MS
                    )
                    .catch(() => false)
                if (message.daemonExecRef && carrier) {
                    this.logger.log(
                        `adoption deferring to the daemon for messageId=${row.messageId} (${agentCtx.framework} has no transcript recovery)`
                    )
                    return
                }
                await this.emitAdoptedRestartTerminal(
                    session.id,
                    row.messageId,
                    fence
                )
                return
            }
            const [streamEvents, sourceRows, foreignUuids] = await Promise.all([
                this.repo.listStreamEventsSince(row.messageId, 0n),
                this.repo.listMessageSourceRows(row.messageId),
                this.repo.listForeignSourceUuids(row.sessionId, row.messageId)
            ])
            const { seen, firstSourceSeq } = buildSeenStateFromPersisted({
                streamEvents: streamEvents.map((e) => ({
                    eventType: e.eventType,
                    payloadJson: e.payloadJson
                })),
                sourceRows
            })
            // Recovery's fallback anchor needs at least one already-seen line;
            // a turn orphaned before its first output line was cached has none
            // and could never anchor. Recompute the prompt-as-sent from the
            // triggering user message (messageToPromptText is pure over the
            // stored row) so the primary prompt anchor works from a cold start.
            const userRow = await this.repo.latestUserMessageBefore(
                session.id,
                message.createdAt
            )
            const promptText = userRow
                ? messageToPromptText(toApiMessage(userRow))
                : ''
            const fsHandle = await this.execDrivers.recoveryFsForAgent(
                session.agentId
            )
            // Liveness signal for the stall detector: is the sprite exec still
            // running? A long turn generating a single block writes no new
            // complete transcript line for a while and looks stalled, but the
            // exec session is still listed — so keep waiting instead of giving
            // up. Only available when the exec session id was captured.
            const spritesClient = fsHandle.spritesClient
            const execSessionId = row.execSessionId
            const spriteName = row.spriteName
            const checkExecAlive =
                spritesClient && execSessionId && spriteName
                    ? async (): Promise<boolean> => {
                          const sessions =
                              await spritesClient.listExecSessions(spriteName)
                          return sessions.some((s) => s.id === execSessionId)
                      }
                    : undefined
            await this.broadcaster.beginResumeStream(
                session.id,
                row.messageId,
                fence
            )
            // Announce AFTER the seen-state/baseline reads above: those snapshot
            // the delivered log, and a row written before them would be replayed
            // into their derivations for no reason.
            await this.emitTurnStatus(
                row.messageId,
                'recovering',
                row.adoptCount
            )
            // Hold the lease for the whole continuation (the attach phase can
            // legitimately stream for the turn's full remaining life).
            const ownerId = this.turnAdoption?.ownerId
            const leaseTimer = ownerId
                ? setInterval(() => {
                      void this.repo
                          .renewTurnLease(
                              row.messageId,
                              ownerId,
                              TURN_LEASE_SECONDS,
                              fence.generation
                          )
                          .then((renewed) => {
                              if (!renewed)
                                  abortController.abort(
                                      new TurnFenceLostError(row.messageId)
                                  )
                          })
                          .catch(() => undefined)
                  }, TURN_LEASE_RENEW_MS)
                : null
            leaseTimer?.unref()
            const expectedSessionRef = session.frameworkSessionRef ?? ''
            const deliveredBaseline =
                deliveredBaselineFromStreamEvents(streamEvents)
            const adopted = () =>
                this.adoptedLiveStream({
                    fs: fsHandle.fs,
                    frameworkSessionRef: expectedSessionRef,
                    promptText,
                    seen,
                    foreignUuids,
                    firstSourceSeq,
                    model: agentCtx.model,
                    sessionId: session.id,
                    agentId: session.agentId,
                    messageId: row.messageId,
                    adoptCount: row.adoptCount,
                    abortSignal: abortController.signal,
                    checkExecAlive,
                    generation: fence.generation
                })
            const adoptedStream =
                agentCtx.framework === 'codex'
                    ? this.adoptedCodexLiveStream({
                          fs: fsHandle.fs,
                          frameworkSessionRef: expectedSessionRef,
                          promptText,
                          baseline: deliveredBaseline,
                          model: agentCtx.model,
                          messageCreatedAt: message.createdAt,
                          sessionId: session.id,
                          agentId: session.agentId,
                          messageId: row.messageId,
                          adoptCount: row.adoptCount,
                          abortSignal: abortController.signal,
                          checkExecAlive,
                          generation: fence.generation
                      })
                    : agentCtx.framework === 'gemini-cli'
                      ? this.adoptedGeminiLiveStream({
                            fs: fsHandle.fs,
                            frameworkSessionRef: expectedSessionRef,
                            promptText,
                            baseline: deliveredBaseline,
                            model: agentCtx.model,
                            messageCreatedAt: message.createdAt,
                            sessionId: session.id,
                            agentId: session.agentId,
                            messageId: row.messageId,
                            adoptCount: row.adoptCount,
                            abortSignal: abortController.signal,
                            checkExecAlive,
                            generation: fence.generation
                        })
                      : adopted()
            try {
                await this.runAdapterFromIterable(
                    adoptedStream,
                    session,
                    row.messageId,
                    agentCtx,
                    abortController.signal,
                    {
                        startedAt: message.createdAt.getTime(),
                        via: 'adoption',
                        fence,
                        initialEvents: streamEvents,
                        sourceOrdinalBase: maxOrdinalByKey(streamEvents)
                    }
                )
            } finally {
                if (leaseTimer) clearInterval(leaseTimer)
            }
        } finally {
            this.untrackRunningAdapter(row.messageId, abortController)
        }
    }

    // External-API twin of the transcript recovery above. There is no on-disk
    // record and no mid-turn re-attach, so the only source of truth is the
    // upstream itself: ask it what became of the task named by the refs stamped
    // while the dead relay was still streaming, and deliver the answer under
    // the SAME assistantMessageId. Frameworks (langflow) and turns (no refs
    // captured) that cannot be asked keep the pre-#670 retryable
    // server_restart terminal — an unrecoverable turn must close, not hang.
    private async adoptExternalTurnExecution(
        row: TurnExecutionRow,
        session: DbChatSession,
        message: NonNullable<
            Awaited<ReturnType<ChatRepository['getMessageById']>>
        >,
        agentCtx: Awaited<ReturnType<ChatService['resolveAgentContext']>>,
        abortController: AbortController,
        fence: TurnExecutionFence
    ): Promise<void> {
        const adapter = this.adapters.get(agentCtx.framework)
        const converged = adapter.convergeTurn?.({
            userId: session.userId,
            agentId: session.agentId,
            sessionId: session.id,
            messageId: row.messageId,
            frameworkSessionRef: session.frameworkSessionRef,
            upstreamTaskId: row.upstreamTaskId,
            upstreamMessageId: row.upstreamMessageId,
            abortSignal: abortController.signal
        })
        if (!converged) {
            this.telemetry.event('chat.turn.adopt_result_lost', {
                messageId: row.messageId,
                sessionId: row.sessionId,
                agentId: row.agentId,
                framework: agentCtx.framework,
                adoptCount: row.adoptCount,
                reason: 'external_not_convergeable'
            })
            await this.emitAdoptedRestartTerminal(
                session.id,
                row.messageId,
                fence
            )
            return
        }
        const streamEvents = await this.repo.listStreamEventsSince(
            row.messageId,
            0n
        )
        await this.broadcaster.beginResumeStream(
            session.id,
            row.messageId,
            fence
        )
        await this.emitTurnStatus(row.messageId, 'recovering', row.adoptCount)
        // Held for the whole poll: an upstream chat-flow legitimately runs for
        // minutes, and a lapsed lease here would let a peer claim the turn and
        // deliver the same answer twice.
        const ownerId = this.turnAdoption?.ownerId
        const leaseTimer = ownerId
            ? setInterval(() => {
                  void this.repo
                      .renewTurnLease(
                          row.messageId,
                          ownerId,
                          TURN_LEASE_SECONDS,
                          fence.generation
                      )
                      .then((renewed) => {
                          if (!renewed)
                              abortController.abort(
                                  new TurnFenceLostError(row.messageId)
                              )
                      })
                      .catch(() => undefined)
              }, TURN_LEASE_RENEW_MS)
            : null
        leaseTimer?.unref()
        try {
            const result = await this.runAdapterFromIterable(
                converged,
                session,
                row.messageId,
                agentCtx,
                abortController.signal,
                {
                    startedAt: message.createdAt.getTime(),
                    via: 'adoption',
                    fence,
                    // The convergence emits `replace`, which supersedes every
                    // answer token already delivered — so the blocks the dead
                    // relay persisted must be seeded here or the replace would
                    // drop the turn's tool/thinking record with them.
                    initialEvents: streamEvents,
                    sourceOrdinalBase: maxOrdinalByKey(streamEvents)
                }
            )
            this.telemetry.event(
                result.outcome === 'done'
                    ? 'chat.turn.adopt_recovered'
                    : 'chat.turn.adopt_result_lost',
                {
                    messageId: row.messageId,
                    sessionId: row.sessionId,
                    agentId: row.agentId,
                    framework: agentCtx.framework,
                    adoptCount: row.adoptCount,
                    outcome: result.outcome,
                    errorCode: result.errorCode,
                    via: 'external_converge'
                }
            )
        } finally {
            if (leaseTimer) clearInterval(leaseTimer)
        }
    }

    // Stream an adopted turn's remaining output as the on-disk transcript grows.
    // Each poll emits only the newly-appeared lines (seen advances by emitted
    // line uuid, so every line is delivered exactly once), holding the lease
    // between polls. Ends by yielding usage+done when the transcript goes
    // terminal, or a retryable server_restart error when it stops growing (the
    // agent died mid-turn), reads keep failing, or the budget lapses. The
    // recovery aligner bails to a non-terminal read on any mismatch, so a
    // reconstruction slip degrades to a retry, never to duplicated/lost text.
    private async *adoptedLiveStream(args: {
        fs: RecoveryFs
        frameworkSessionRef: string
        promptText: string
        seen: TurnSeenState
        foreignUuids: Set<string>
        firstSourceSeq: number
        model: string | null
        sessionId: string
        agentId: string
        messageId: string
        adoptCount: number
        abortSignal: AbortSignal
        checkExecAlive?: () => Promise<boolean>
        generation: number
    }): AsyncIterable<EmittedChatEvent> {
        const deadline = Date.now() + ADOPT_REPOLL_MAX_MS
        const ownerId = this.turnAdoption?.ownerId
        let firstSourceSeq = args.firstSourceSeq
        let lastProgress = -1
        let stall = 0
        let failedStreak = 0
        let polls = 0
        for (;;) {
            if (args.abortSignal.aborted) {
                yield cancelledByUserEvent()
                return
            }
            let verdict: TurnRecoveryVerdict = await recoverTurnFromClaudeJsonl(
                {
                    fs: args.fs,
                    frameworkSessionRef: args.frameworkSessionRef,
                    promptText: args.promptText,
                    seen: args.seen,
                    firstSourceSeq,
                    model: args.model,
                    tStart: Date.now(),
                    tFirstToken: null
                }
            ).catch(
                (err): TurnRecoveryVerdict => ({
                    outcome: 'failed',
                    detail: err instanceof Error ? err.message : String(err)
                })
            )
            polls += 1
            if (
                (verdict.outcome === 'recovered' ||
                    verdict.outcome === 'result_lost') &&
                verdict.events.some(
                    (e) =>
                        e.type === 'raw_source' &&
                        !!e.source.externalId &&
                        args.foreignUuids.has(e.source.externalId)
                )
            ) {
                // The anchor landed inside a PRIOR turn's lines — a repeated
                // prompt whose own user line is not yet on disk. Never emit
                // another message's content; once the CLI writes this turn's
                // user line the last-match anchor moves to it, so treat the
                // poll as a failed read and try again (bounded by the
                // failed-read limit).
                this.logger.warn(
                    `adoption anchored into a prior turn messageId=${args.messageId} (poll ${polls}) — re-polling`
                )
                verdict = {
                    outcome: 'failed',
                    detail: 'anchored into a prior turn'
                }
            }
            if (
                verdict.outcome === 'recovered' ||
                verdict.outcome === 'result_lost'
            ) {
                let emittedText = false
                for (const event of verdict.events) {
                    yield event
                    if (event.type === 'raw_source' && event.source.externalId)
                        args.seen.uuids.add(event.source.externalId)
                    if (event.type === 'token' || event.type === 'thinking')
                        emittedText = true
                }
                // Once the in-flight block at drop time has been emitted, its
                // already-streamed head is accounted for; later blocks are wholly
                // new, so the partial-delta reconciliation no longer applies.
                if (emittedText) args.seen.deltaRuns = []
                firstSourceSeq = verdict.lastSourceSeq
            }
            if (verdict.outcome === 'recovered') {
                this.telemetry.event('chat.turn.adopt_recovered', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    recoveredLines: verdict.recoveredLines,
                    adoptCount: args.adoptCount,
                    polls
                })
                yield { type: 'usage', usage: verdict.usage }
                yield { type: 'done', finalMessageId: args.messageId }
                return
            }
            if (verdict.outcome === 'result_lost') {
                failedStreak = 0
                if (verdict.lastSourceSeq > lastProgress) {
                    lastProgress = verdict.lastSourceSeq
                    stall = 0
                } else {
                    stall += 1
                }
            } else {
                failedStreak += 1
            }
            // Adoption is rare and time-boxed; a per-poll line makes a failed
            // recovery diagnosable from logs alone.
            this.logger.log(
                `adopt poll messageId=${args.messageId} #${polls} outcome=${verdict.outcome} ` +
                    `detail=${'detail' in verdict ? (verdict.detail ?? '') : ''} lastSourceSeq=${
                        'lastSourceSeq' in verdict ? verdict.lastSourceSeq : ''
                    } stall=${stall} failed=${failedStreak}`
            )
            let giveUp: string | null = null
            if (Date.now() >= deadline) giveUp = `deadline (${polls} polls)`
            else if (failedStreak >= ADOPT_REPOLL_FAILED_LIMIT)
                giveUp = `transcript unreadable (${failedStreak})`
            else if (stall >= ADOPT_REPOLL_STALL_LIMIT) {
                // Transcript stopped growing — but a long single-block turn is
                // still alive and just hasn't flushed a complete line yet. Only
                // give up if the sprite exec has actually ended; otherwise keep
                // waiting. Without a liveness signal, fall back to the stall.
                const alive = args.checkExecAlive
                    ? await args.checkExecAlive().catch(() => null)
                    : null
                if (alive === true) stall = 0
                else
                    giveUp =
                        alive === false
                            ? 'exec session ended'
                            : 'no transcript growth'
            }
            if (giveUp) {
                this.telemetry.event('chat.turn.adopt_result_lost', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    reason: giveUp,
                    polls
                })
                yield interruptedErrorEvent()
                return
            }
            if (ownerId) {
                const renewed = await this.repo.renewTurnLease(
                    args.messageId,
                    ownerId,
                    TURN_LEASE_SECONDS,
                    args.generation
                )
                if (!renewed) throw new TurnFenceLostError(args.messageId)
            }
            await this.abortableSleep(
                ADOPT_REPOLL_INTERVAL_MS,
                args.abortSignal
            )
        }
    }

    // Codex twin of adoptedLiveStream: re-poll the rollout (explicit
    // task_started/task_complete turn framing) and stream each newly-landed
    // item — codex is block-level, so items appear one complete row at a time
    // and the sinceLine cursor makes every row emit exactly once. The
    // delivered prefix is suppressed by per-kind text cursors + tool COUNT
    // skip (rollout ids never match the delivered stdout item ids); any text
    // divergence between the rollout and the delivered log fails loudly.
    private async *adoptedCodexLiveStream(args: {
        fs: RecoveryFs
        frameworkSessionRef: string
        promptText: string
        baseline: DeliveredBaseline
        model: string | null
        messageCreatedAt: Date
        sessionId: string
        agentId: string
        messageId: string
        adoptCount: number
        abortSignal: AbortSignal
        checkExecAlive?: () => Promise<boolean>
        generation: number
    }): AsyncIterable<EmittedChatEvent> {
        const deadline = Date.now() + ADOPT_REPOLL_MAX_MS
        const ownerId = this.turnAdoption?.ownerId
        const interceptor = createAdoptionInterceptor(args.baseline, {
            toolDedup: 'count'
        })
        let sinceLine = 0
        let lastProgress = -1
        let stall = 0
        let failedStreak = 0
        let polls = 0
        for (;;) {
            if (args.abortSignal.aborted) {
                yield cancelledByUserEvent()
                return
            }
            const verdict: CodexTurnVerdict = await recoverTurnFromCodexRollout(
                {
                    fs: args.fs,
                    frameworkSessionRef: args.frameworkSessionRef,
                    promptText: args.promptText,
                    model: args.model,
                    messageCreatedAt: args.messageCreatedAt,
                    sinceLine
                }
            ).catch(
                (err): CodexTurnVerdict => ({
                    outcome: 'failed',
                    detail: err instanceof Error ? err.message : String(err)
                })
            )
            polls += 1
            if (verdict.outcome !== 'failed') {
                for (const ev of verdict.events) {
                    const res = interceptor.intercept(ev)
                    if (res.mismatch) {
                        this.logger.warn(
                            `codex adopt rollout diverged messageId=${args.messageId}: ${res.mismatch}`
                        )
                        this.telemetry.event('chat.turn.adopt_result_lost', {
                            sessionId: args.sessionId,
                            agentId: args.agentId,
                            assistantMessageId: args.messageId,
                            reason: `rollout diverged: ${res.mismatch}`,
                            polls
                        })
                        yield interruptedErrorEvent()
                        return
                    }
                    for (const out of res.events) yield out
                }
                sinceLine = verdict.lastSourceSeq
            }
            this.logger.log(
                `adopt poll (codex) messageId=${args.messageId} #${polls} outcome=${verdict.outcome} ` +
                    `detail=${'detail' in verdict ? (verdict.detail ?? '') : ''} lastSourceSeq=${
                        'lastSourceSeq' in verdict ? verdict.lastSourceSeq : ''
                    } stall=${stall} failed=${failedStreak}`
            )
            if (verdict.outcome === 'recovered') {
                this.telemetry.event('chat.turn.adopt_recovered', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    recoveredLines: verdict.recoveredLines,
                    adoptCount: args.adoptCount,
                    polls
                })
                const usageRes = interceptor.intercept({
                    type: 'usage',
                    usage: verdict.usage
                })
                for (const out of usageRes.events) yield out
                yield { type: 'done', finalMessageId: args.messageId }
                return
            }
            if (verdict.outcome === 'turn_failed') {
                this.telemetry.event('chat.turn.adopt_result_lost', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    reason: `turn ${verdict.detail}`,
                    polls
                })
                yield interruptedErrorEvent()
                return
            }
            if (verdict.outcome === 'result_lost') {
                failedStreak = 0
                if (verdict.lastSourceSeq > lastProgress) {
                    lastProgress = verdict.lastSourceSeq
                    stall = 0
                } else {
                    stall += 1
                }
            } else {
                failedStreak += 1
            }
            let giveUp: string | null = null
            if (Date.now() >= deadline) giveUp = `deadline (${polls} polls)`
            else if (failedStreak >= ADOPT_REPOLL_FAILED_LIMIT)
                giveUp = `rollout unreadable (${failedStreak})`
            else if (stall >= ADOPT_REPOLL_STALL_LIMIT) {
                const alive = args.checkExecAlive
                    ? await args.checkExecAlive().catch(() => null)
                    : null
                if (alive === true) stall = 0
                else
                    giveUp =
                        alive === false
                            ? 'exec session ended'
                            : 'no rollout growth'
            }
            if (giveUp) {
                this.telemetry.event('chat.turn.adopt_result_lost', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    reason: giveUp,
                    polls
                })
                yield interruptedErrorEvent()
                return
            }
            if (ownerId) {
                const renewed = await this.repo.renewTurnLease(
                    args.messageId,
                    ownerId,
                    TURN_LEASE_SECONDS,
                    args.generation
                )
                if (!renewed) throw new TurnFenceLostError(args.messageId)
            }
            await this.abortableSleep(
                ADOPT_REPOLL_INTERVAL_MS,
                args.abortSignal
            )
        }
    }

    // Gemini twin of adoptedCodexLiveStream. gemini-cli writes an append-only
    // session JSONL with NO turn markers, and re-appends the same message id as
    // it gains content/tokens (last record wins), so — unlike codex's per-row
    // streaming — the turn is reconstructed WHOLE each poll and emitted ONCE at
    // the terminal poll (its final gemini message carries usage tokens, or the
    // exec ended with content on disk). The delivered prefix is suppressed by
    // the same interceptor (text prefix-align + tool count-skip); any text
    // divergence from the durable log fails loudly.
    private async *adoptedGeminiLiveStream(args: {
        fs: RecoveryFs
        frameworkSessionRef: string
        promptText: string
        baseline: DeliveredBaseline
        model: string | null
        messageCreatedAt: Date
        sessionId: string
        agentId: string
        messageId: string
        adoptCount: number
        abortSignal: AbortSignal
        checkExecAlive?: () => Promise<boolean>
        generation: number
    }): AsyncIterable<EmittedChatEvent> {
        const deadline = Date.now() + ADOPT_REPOLL_MAX_MS
        const ownerId = this.turnAdoption?.ownerId
        const interceptor = createAdoptionInterceptor(args.baseline, {
            toolDedup: 'count'
        })
        let lastProgress = -1
        let stall = 0
        let failedStreak = 0
        let polls = 0
        // Emit the reconstructed turn through the interceptor exactly once (at
        // the terminal poll): every event routed through the delivered-baseline
        // filter, then usage + done. Returns a mismatch string if the recovered
        // text disagrees with what was already delivered (fail loud).
        const emitTerminal = async function* (
            this: ChatService,
            events: EmittedChatEvent[],
            usage: ChatUsage
        ): AsyncGenerator<EmittedChatEvent, string | null> {
            for (const ev of events) {
                const res = interceptor.intercept(ev)
                if (res.mismatch) return res.mismatch
                for (const out of res.events) yield out
            }
            const usageRes = interceptor.intercept({ type: 'usage', usage })
            for (const out of usageRes.events) yield out
            yield { type: 'done', finalMessageId: args.messageId }
            return null
        }.bind(this)
        for (;;) {
            if (args.abortSignal.aborted) {
                yield cancelledByUserEvent()
                return
            }
            const verdict: GeminiTurnVerdict =
                await recoverTurnFromGeminiSession({
                    fs: args.fs,
                    frameworkSessionRef: args.frameworkSessionRef,
                    promptText: args.promptText,
                    model: args.model,
                    messageCreatedAt: args.messageCreatedAt
                }).catch(
                    (err): GeminiTurnVerdict => ({
                        outcome: 'failed',
                        detail: err instanceof Error ? err.message : String(err)
                    })
                )
            polls += 1
            if (verdict.outcome === 'recovered') {
                const mismatch = yield* emitTerminal(
                    verdict.events,
                    verdict.usage
                )
                if (mismatch) {
                    this.logger.warn(
                        `gemini adopt session diverged messageId=${args.messageId}: ${mismatch}`
                    )
                    this.telemetry.event('chat.turn.adopt_result_lost', {
                        sessionId: args.sessionId,
                        agentId: args.agentId,
                        assistantMessageId: args.messageId,
                        reason: `session diverged: ${mismatch}`,
                        polls
                    })
                    yield interruptedErrorEvent()
                    return
                }
                this.telemetry.event('chat.turn.adopt_recovered', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    recoveredLines: verdict.recoveredMessages,
                    adoptCount: args.adoptCount,
                    polls
                })
                return
            }
            if (verdict.outcome === 'result_lost') {
                failedStreak = 0
                if (verdict.lastSourceSeq > lastProgress) {
                    lastProgress = verdict.lastSourceSeq
                    stall = 0
                } else {
                    stall += 1
                }
            } else {
                failedStreak += 1
            }
            this.logger.log(
                `adopt poll (gemini) messageId=${args.messageId} #${polls} outcome=${verdict.outcome} ` +
                    `detail=${'detail' in verdict ? (verdict.detail ?? '') : ''} lastSourceSeq=${
                        'lastSourceSeq' in verdict ? verdict.lastSourceSeq : ''
                    } stall=${stall} failed=${failedStreak}`
            )
            let giveUp: string | null = null
            let execEnded = false
            if (Date.now() >= deadline) giveUp = `deadline (${polls} polls)`
            else if (failedStreak >= ADOPT_REPOLL_FAILED_LIMIT)
                giveUp = `session unreadable (${failedStreak})`
            else if (stall >= ADOPT_REPOLL_STALL_LIMIT) {
                const alive = args.checkExecAlive
                    ? await args.checkExecAlive().catch(() => null)
                    : null
                if (alive === true) stall = 0
                else {
                    execEnded = alive === false
                    giveUp = execEnded
                        ? 'exec session ended'
                        : 'no session growth'
                }
            }
            if (giveUp) {
                // The exec ended with a complete-enough assistant message on
                // disk but gemini-cli never recorded usage tokens: emit the
                // content best-effort (zero usage) rather than erroring away a
                // turn that actually produced an answer.
                if (
                    execEnded &&
                    verdict.outcome === 'result_lost' &&
                    verdict.hasContent
                ) {
                    const mismatch = yield* emitTerminal(verdict.events, {
                        model: args.model,
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        cacheCreationTokens: 0,
                        costUsd: null,
                        costSource: 'unknown',
                        firstTokenMs: null,
                        totalMs: null
                    })
                    if (!mismatch) {
                        this.telemetry.event('chat.turn.adopt_recovered', {
                            sessionId: args.sessionId,
                            agentId: args.agentId,
                            assistantMessageId: args.messageId,
                            recoveredLines: verdict.events.length,
                            adoptCount: args.adoptCount,
                            polls
                        })
                        return
                    }
                    this.logger.warn(
                        `gemini adopt exec-ended emit diverged messageId=${args.messageId}: ${mismatch}`
                    )
                }
                this.telemetry.event('chat.turn.adopt_result_lost', {
                    sessionId: args.sessionId,
                    agentId: args.agentId,
                    assistantMessageId: args.messageId,
                    reason: giveUp,
                    polls
                })
                yield interruptedErrorEvent()
                return
            }
            if (ownerId) {
                const renewed = await this.repo.renewTurnLease(
                    args.messageId,
                    ownerId,
                    TURN_LEASE_SECONDS,
                    args.generation
                )
                if (!renewed) throw new TurnFenceLostError(args.messageId)
            }
            await this.abortableSleep(
                ADOPT_REPOLL_INTERVAL_MS,
                args.abortSignal
            )
        }
    }

    // Where to restart a runner stream after the API process that was relaying
    // it went away. Historically always 0: replay the WHOLE turn and let the
    // source_event_key / (message,seq) unique indexes drop what was already
    // stored. That is correct but re-ships every byte of a long turn, so with
    // MF_TURN_RESUME_CURSOR on we skip to the last durably-recorded transport
    // seq instead, leaving only the tail after it to be re-derived (still
    // dedup-covered, so a stale or missing cursor degrades to the old
    // behaviour rather than losing content).
    private async resumeFromSeq(messageId: string): Promise<number> {
        if (!RESUME_FROM_CURSOR) return 0
        // Prefer the EXACT cursor recorded on the stream-event rows. It is the
        // only one safe for a token-level turn: the source-row cursor stops one
        // line short and lets that line be re-sent, which block-level output
        // absorbs by stable key but a delta stream can silently drop. When it
        // reads 0 the turn predates the watermark (or produced no stamped rows),
        // so fall back to the conservative cursor and, failing that, to a full
        // replay — every step of that ladder is content-preserving.
        const exact = await this.repo
            .exactResumeSeqForMessage(messageId)
            .catch((err: Error) => {
                this.logger.warn(
                    `exact resume cursor lookup failed messageId=${messageId}: ${err.message}`
                )
                return 0
            })
        if (exact > 0) {
            this.logger.log(
                `resume cursor messageId=${messageId} fromSeq=${exact} (exact)`
            )
            return exact
        }
        const seq = await this.repo
            .safeResumeSeqForMessage(messageId)
            .catch((err: Error) => {
                // Degrading to a full replay is safe, but doing it silently
                // would hide a broken cursor query behind "works fine".
                this.logger.warn(
                    `resume cursor lookup failed messageId=${messageId}, replaying from 0: ${err.message}`
                )
                return 0
            })
        if (seq > 0)
            this.logger.log(
                `resume cursor messageId=${messageId} fromSeq=${seq}`
            )
        return seq
    }

    // Bring this agent's sprite-side runner up, if this framework attempts it
    // (hermes always; others via the allowlist). Returns no handle for every
    // other case (not attempted, not a sprite, no runner manager, bring-up
    // failed) so the turn silently keeps using its direct transport —
    // a runner is an optimisation and must never be the reason a turn cannot
    // start.
    //
    // The ONE exception rides back in `execFailure`: a bring-up that died
    // because the sprite's exec endpoint could not give it a socket has proven
    // something about the fallback too, and the caller terminalizes on it
    // instead of walking into the same transport (#730).
    private async resolveSpriteRunner(args: {
        agentId: string
        userId: string
        framework: AgentFramework
        runtime: AgentRuntime
        spriteName: string | null
        workspacePath?: string | null
    }): Promise<{
        runner: { daemonId: string; exec: SpriteExecFn } | null
        execFailure?: RunnerExecFailure
    }> {
        const { agentId, userId } = args
        if (!this.runnerManager) return { runner: null }
        if (args.runtime !== 'sprites' || !args.spriteName)
            return { runner: null }
        if (!spriteRunnerAttemptedFor(args.framework, agentId))
            return { runner: null }
        const startedAt = Date.now()
        try {
            const exec = await this.spriteExecFor(agentId, args.spriteName)
            if (!exec) return { runner: null }
            const spriteName = args.spriteName
            const resolution = await this.runnerManager.ensureRunner({
                agentId,
                userId,
                spriteName,
                exec,
                workspacePath: args.workspacePath ?? null,
                // The inspect is the turn's first exec and the one a dead
                // endpoint surfaces on, so it is bounded by the exec-health
                // budget rather than by a command budget (#730).
                firstExecTimeoutMs: spriteExecHealthConfig().firstExecTimeoutMs
            })
            let runner = resolution.handle
            // A hermes runner is only usable when its daemon can OWN the ACP
            // client (turn.hermes): the caller stamps daemonId/daemonExecRef
            // from this handle, and a stamp against a daemon that cannot
            // serve turn.start would advertise a resume path that does not
            // exist. Decided at resolution time so the stamps stay truthful
            // and the turn falls to the interactive transport instead.
            let missingTurnRpc = false
            if (runner && args.framework === 'hermes') {
                const capable = await daemonAdvertisesFeature(
                    this.db,
                    runner.daemonId,
                    DAEMON_FEATURE_TURN_HERMES
                ).catch(() => false)
                if (!capable) {
                    runner = null
                    missingTurnRpc = true
                }
            }
            const fallbackReason =
                resolution.fallbackReason ??
                (missingTurnRpc ? 'runner_missing_turn_rpc' : undefined)
            // The question this answers, which cost hours of log archaeology to
            // answer once: how often does a turn actually GET a runner, and what
            // did waiting for one cost it? A cold bring-up can exceed its budget
            // and fall back, so `fallback` with a large ms is the signal that
            // matters — it is latency the user paid for nothing. fallbackReason
            // splits that bucket (#592): workspace_timeout is a frozen socket
            // eating the setup deadline, workspace_connection_closed died
            // mid-ensure, runner_unavailable never had a runner to lose; and
            // workspacePreflight=cached is the per-generation short-circuit
            // doing its job on a turn that used to pay an RPC.
            this.telemetry.event('chat.runner.resolve', {
                agentId,
                outcome: runner ? 'runner' : 'fallback',
                broughtUp: runner?.started ?? false,
                durationMs: Date.now() - startedAt,
                workspacePreflight: resolution.workspace.outcome,
                // The socket generation the handle was resolved against
                // (#619): lets a later dispatch-recovery event say whether
                // the generation changed between resolve and turn dispatch.
                resolvedGeneration: runner?.generation ?? null,
                ...(fallbackReason ? { fallbackReason } : {}),
                ...(resolution.workspace.ensureMs !== undefined
                    ? { workspaceEnsureMs: resolution.workspace.ensureMs }
                    : {})
            })
            return runner
                ? { runner: { daemonId: runner.daemonId, exec } }
                : {
                      runner: null,
                      ...(resolution.execFailure
                          ? { execFailure: resolution.execFailure }
                          : {})
                  }
        } catch (err) {
            this.logger.warn(
                `sprite runner unavailable agentId=${agentId} class=${safeErrorClass(err)}`
            )
            return { runner: null }
        }
    }

    // The durable exec-health verdict for the sprite this turn is bound to,
    // consulted BEFORE the first exec of the turn — the runner inspect for an
    // opted-in agent, the direct sprite exec for everyone else (#730).
    //
    // Returns the terminal this turn should end with, or null to proceed. The
    // semantics belong to SpriteExecHealthService and are not re-decided here:
    // no cooldown passes, a live one refuses, and a lapsed one hands exactly one
    // turn fleet-wide the right to go look.
    private async gateSpriteExec(args: {
        agentId: string
        runtime: AgentRuntime
        spriteName: string | null
        hostId: string | null
    }): Promise<SpriteExecTerminal | null> {
        if (!this.spriteExecHealth) return null
        if (args.runtime !== 'sprites' || !args.spriteName) return null
        const admission = await this.spriteExecHealth.admit(args.hostId)
        if (!admission || admission.decision === 'pass') return null
        if (admission.decision === 'blocked')
            return this.spriteExecTerminal(args.agentId, {
                hostId: admission.hostId,
                phase: 'cooldown',
                retryAt: admission.retryAt
            })

        // This turn holds the fleet's one probe. It may run ONE bounded,
        // idempotent no-op and nothing else: a failed WebSocket upgrade does not
        // prove the upstream never accepted the command, so replaying the turn's
        // real command here could run it twice (#503).
        const lease = admission.lease
        if (!lease) return null
        const probe = await this.probeSpriteExec(args.agentId, args.spriteName)
        // Inconclusive is neither recovery nor failure: an auth rejection or a
        // quota refusal says nothing about this VM's endpoint. Do not dispatch
        // the real command behind a probe whose lease remains held — that would
        // let the same user turn issue two execs without a health verdict. Leave
        // the lease untouched and terminalize; the next turn may claim it after
        // it lapses.
        if (probe === 'inconclusive')
            return this.spriteExecTerminal(
                args.agentId,
                {
                    hostId: admission.hostId,
                    phase: 'probe_failed',
                    retryAt: lease
                },
                { failureClass: 'probe_failed' }
            )
        const recorded = await this.spriteExecHealth.recordProbe({
            hostId: admission.hostId,
            ok: probe === 'ok',
            lease
        })
        if (probe === 'ok' && recorded.outcome !== 'not_owner') return null
        return this.spriteExecTerminal(
            args.agentId,
            {
                hostId: admission.hostId,
                phase: 'probe_failed',
                retryAt: recorded.retryAt ?? lease
            },
            { failureClass: probe === 'ok' ? 'probe_failed' : probe }
        )
    }

    // `true` on the sprite's own exec transport, bounded by the health probe
    // budget. Idempotent by construction, which is the only reason running it on
    // a host we already suspect is safe at all.
    //
    // Three outcomes, not two. 'inconclusive' covers everything that failed
    // without telling us anything about THIS endpoint — no sprites client, an
    // account-wide auth or quota refusal, a fact about the request — and it
    // neither clears nor re-arms.
    private async probeSpriteExec(
        agentId: string,
        spriteName: string
    ): Promise<'ok' | 'inconclusive' | SpriteExecFailureClass> {
        try {
            const exec = await this.spriteExecFor(agentId, spriteName)
            if (!exec) return 'inconclusive'
            const res = await exec({
                cmd: ['true'],
                timeoutMs: spriteExecHealthConfig().probeTimeoutMs
            })
            // A non-zero exit means the socket opened and the VM answered, so
            // this is not evidence that the exec endpoint is unhealthy. It is
            // still not a successful recovery proof, so the turn terminalizes
            // inconclusively and the lease lapses unchanged.
            return res.exitCode === 0 ? 'ok' : 'inconclusive'
        } catch (err) {
            const failure = classifyExecEndpointFailure(err)
            if (!failure)
                this.logger.warn(
                    `sprite exec probe inconclusive agentId=${agentId} class=${safeErrorClass(err)}`
                )
            return failure ? failure.failureClass : 'inconclusive'
        }
    }

    // The turn's first exec proved the endpoint cannot serve a socket. Arm the
    // shared cooldown so the turns behind this one fail fast instead of each
    // paying the same handshake, then terminalize: the direct sprite adapter is
    // the same transport that just failed, so falling back to it would spend a
    // second full budget to be told the same thing.
    private async markSpriteExecUnavailable(
        agentId: string,
        hostId: string | null,
        failure: RunnerExecFailure
    ): Promise<SpriteExecTerminal> {
        // Armed only when there is a host row and a breaker to write it. Without
        // one the turn is still spared — nothing changes the fact that the only
        // remaining transport is the one that just failed — but the retry hint
        // must not promise a cooldown nobody is holding.
        const retryAt = hostId
            ? await this.spriteExecHealth?.markUnavailable({
                  hostId,
                  failureClass: failure.failureClass,
                  upstreamStatus: failure.upstreamStatus ?? null
              })
            : null
        return this.spriteExecTerminal(
            agentId,
            {
                hostId,
                phase: 'runner_inspect',
                retryAt: retryAt ?? null
            },
            failure
        )
    }

    // Operational identifiers, which decision produced the terminal, and the
    // bounded deadline. Never the command, the exec URL, the sprite's output or
    // anything the user typed.
    private spriteExecTerminal(
        agentId: string,
        terminal: SpriteExecTerminal,
        failure?: {
            failureClass: SpriteExecFailureClass
            upstreamStatus?: number
        }
    ): SpriteExecTerminal {
        this.telemetry.event(SPRITE_EXEC_TERMINAL_EVENT, {
            agentId,
            hostId: terminal.hostId,
            phase: terminal.phase,
            failureClass: failure?.failureClass,
            upstreamStatus: failure?.upstreamStatus,
            retryInMs: terminal.retryAt
                ? terminal.retryAt.getTime() - Date.now()
                : undefined
        })
        return terminal
    }

    // Run a command on an agent's sprite. Shared by runner bring-up, the awake
    // lease and the exec-health probe so all three talk to the same sprite
    // through the same client.
    private async spriteExecFor(
        agentId: string,
        spriteName: string
    ): Promise<SpriteExecFn | null> {
        const handle = await this.execDrivers?.recoveryFsForAgent(agentId)
        const client = handle?.spritesClient
        if (!client) return null
        return (a) =>
            execSprite(client, spriteName, {
                cmd: a.cmd,
                stdin: a.stdin ?? '',
                timeoutMs: a.timeoutMs
            })
    }

    private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            if (signal.aborted) return resolve()
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort)
                resolve()
            }, ms)
            const onAbort = (): void => {
                clearTimeout(timer)
                resolve()
            }
            signal.addEventListener('abort', onAbort, { once: true })
        })
    }

    // adopt_count exhausted: close the turn out with the same retryable terminal
    // the pre-adoption path used, so the client can resend.
    async terminalizeAdoptedTurn(row: TurnExecutionRow): Promise<void> {
        if (this.runningAdapters.has(row.messageId)) return
        await this.emitAdoptedRestartTerminal(row.sessionId, row.messageId, {
            messageId: row.messageId,
            ownerId: row.ownerId,
            generation: row.generation
        })
    }

    // #674. Make recovery visible: a turn whose original execution died goes
    // quiet for as long as the rebuild takes, and until now the client could
    // not distinguish that from a hang. Rides the normal broadcaster path so
    // it gets a seq, a NOTIFY and the dedup index like any other row — but it
    // is informational only, so it must be emitted AFTER the stream's seq has
    // been re-seeded and BEFORE the recovery stream runs, and it must never be
    // treated as terminal.
    //
    // Best-effort for an ordinary write failure: the recovery this announces
    // is the valuable work, so a dropped stream or DB hiccup is logged and
    // swallowed. Fence loss is authority, not availability, and propagates so
    // the displaced carrier stops before attaching or polling its transport.
    private async emitTurnStatus(
        messageId: string,
        phase: ChatTurnStatusPhase,
        ordinal: number
    ): Promise<void> {
        try {
            const result = await this.broadcaster.emit(messageId, {
                type: 'turn_status',
                payload: { type: 'turn_status', phase },
                sourceEventKey: turnStatusSourceEventKey(phase),
                sourceEventOrdinal: ordinal
            })
            if (result.fenceLost) throw new TurnFenceLostError(messageId)
        } catch (err) {
            if (err instanceof TurnFenceLostError) throw err
            this.logger.warn(
                `turn_status ${phase} emit failed for messageId=${messageId}: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
        }
    }

    // The `resuming` row's dedup ordinal: advance once when a suspension is
    // newer than the last status, capped so the phase can never write more than
    // MAX_TURN_STATUS_RESUMING_ROWS rows.
    //
    // If the probe fails, skip the informational row rather than guessing an
    // identity that could race a successful peer and duplicate one attempt.
    // The resume is the valuable work and continues either way.
    private async resumingStatusOrdinal(
        messageId: string
    ): Promise<number | null> {
        try {
            return await this.repo.boundedResumeStatusOrdinal(
                messageId,
                turnStatusSourceEventKey('resuming'),
                MAX_TURN_STATUS_RESUMING_ROWS - 1
            )
        } catch (err) {
            this.logger.warn(
                `resume status ordinal lookup failed messageId=${messageId}: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
            return null
        }
    }

    private async emitAdoptedRestartTerminal(
        sessionId: string,
        messageId: string,
        fence?: TurnExecutionFence
    ): Promise<boolean> {
        if (fence)
            await this.broadcaster.beginResumeStream(
                sessionId,
                messageId,
                fence
            )
        else if (!this.broadcaster.hasStream(messageId))
            this.broadcaster.beginStream(
                sessionId,
                messageId,
                await this.repo.maxStreamEventSeq(messageId),
                fence ?? null
            )
        const event = interruptedErrorEvent()
        const { persisted } = await this.broadcaster.emit(messageId, {
            type: event.type,
            payload: event as unknown as Record<string, unknown>,
            sourceEventKey: SERVER_RESTART_SOURCE_EVENT_KEY,
            sourceEventOrdinal: 0
        })
        this.broadcaster.endStream(messageId, fence)
        if (persisted)
            await this.emitDurableTerminalTelemetry({
                sessionId,
                messageId,
                outcome: 'error',
                errorCode: event.error.code,
                via: 'restart_terminal'
            })
        return persisted
    }

    // The ONLY way an assistant turn's content reaches its row. The cursor is
    // a required argument, not an optional one, because the two columns are a
    // single fact: content_blocks_json is the fold of this turn's stream
    // events up to content_checkpoint_event_id and of nothing after it. A
    // writer that set the content and left an older cursor in place would
    // pair content with a cursor that under-covers it, and every subscriber
    // attaching from that cursor would be replayed the overlap on top of
    // content that already holds it. Requiring the argument means a new
    // writer has to answer the question rather than inherit a wrong answer.
    // `null` is always available and always safe: it means "full replay".
    private async writeAssistantContent(
        messageId: string,
        blocks: ChatContentBlock[],
        checkpointEventId: bigint | null,
        fence?: TurnExecutionFence
    ): Promise<void> {
        const { fenceLost } = await this.repo.writeAssistantContent(
            messageId,
            blocks,
            checkpointEventId,
            fence
        )
        // The checkpoint is a cache of the event log, so a rejected one costs
        // the new owner nothing — it replays from the cursor it inherited. The
        // carrier is not stopped from here either: its next stream event hits
        // the same fence and stops it there, on the path that actually decides
        // whether the turn keeps producing.
        if (fenceLost)
            this.logger.warn(
                `content checkpoint for message=${messageId} fenced out (turn ownership lost)`
            )
    }

    // Drive a turn that is already running elsewhere (a daemon resume, or an
    // adopted orphan) to its terminal. `suspended` tells the caller the turn is
    // still being executed by the daemon and its sprite must be left awake for
    // the next owner; `outcome`/`errorCode` are the real terminal disposition,
    // which the resume telemetry used to flatten into "converged" (#544).
    private async runAdapterFromIterable(
        events: AsyncIterable<EmittedChatEvent>,
        session: DbChatSession,
        assistantMessageId: string,
        agentCtx: Awaited<ReturnType<ChatService['resolveAgentContext']>>,
        abortSignal: AbortSignal,
        opts: {
            // Durable turn origin (message.createdAt), not the local handler
            // start: a resumed turn's latency is what the user waited for,
            // which includes the suspension gap.
            startedAt: number
            via: 'resume' | 'adoption'
            // The durable stream-event log of what this turn already
            // delivered, handed over whole rather than pre-folded into blocks:
            // `replace` is a state transition, so only the buffer that owns
            // that transition can reconstruct the content correctly (#689).
            initialEvents?: readonly DurableContentEvent[]
            sourceOrdinalBase?: Map<string, number>
            // OpenClaw resumes reparse a keyed source from its head. Rows a
            // dead relay already persisted must rebuild terminal content but
            // must not be inserted or delivered a second time.
            replayedContent?: Map<string, Map<number, ReplayedContentEvent>>
            fence: TurnExecutionFence
        }
    ): Promise<{
        suspended: boolean
        fenceLost: boolean
        outcome: TurnTerminalOutcome | 'suspended'
        errorCode: string | null
    }> {
        const { startedAt, sourceOrdinalBase, replayedContent } = opts
        // Same buffer as runAdapter — one implementation of the collapse and
        // sanitise invariants, so the two paths cannot drift. This path has
        // no periodic checkpoint (it only persists at a terminal), so it
        // takes the invariants and the memory cap, not the checkpoint rule.
        const assistantBlocks = createAssistantBlockBuffer(
            this.logger,
            assistantMessageId,
            opts.initialEvents
        )
        let recoveryCheckpointCursor = assistantBlocks.replayedThrough
        let completed = false
        let suspended = false
        let terminalError: EmittedErrorEvent | null = null
        let managedChannelFailureSignal: ManagedChannelFailureSignal | null =
            null
        let terminalPersisted = false
        // Latched once any write is refused because this carrier no longer owns
        // the turn. From that point the turn belongs to someone else and is
        // live under them, so this relay must not write a terminal, must not
        // report one it never persisted, and must not release the session's
        // inflight claim out from under the new owner.
        let fenceLost = false
        let totalTokensIn = 0
        let totalTokensOut = 0
        let currentSourceEventKey: string | null = null
        let currentSourceEventOrdinal = 0
        // Advances only on a NEW raw_source line — see runnerSeq on
        // EmittedStreamEvent for why the current line's seq would be wrong.
        let emittedThroughSeq: number | null = null
        let currentLineSeq: number | null = null
        const emitEvent = async (
            type: PersistedStreamEventType,
            payload: Record<string, unknown>,
            terminalContent?: TerminalStreamContent
        ): Promise<{ persisted: boolean }> => {
            const sourceEventOrdinal =
                currentSourceEventKey !== null
                    ? currentSourceEventOrdinal++
                    : null
            const replayed =
                currentSourceEventKey !== null && sourceEventOrdinal !== null
                    ? replayedContent
                          ?.get(currentSourceEventKey)
                          ?.get(sourceEventOrdinal)
                    : undefined
            if (replayed) {
                if (
                    replayed.eventType === type &&
                    isDeepStrictEqual(
                        replayed.payloadJson,
                        sanitizeForJsonb(payload)
                    )
                )
                    return { persisted: true }
                throw new Error(
                    `replayed content changed for message=${assistantMessageId} source=${currentSourceEventKey} ordinal=${sourceEventOrdinal}`
                )
            }
            const result = await this.broadcaster.emit(
                assistantMessageId,
                {
                    type,
                    payload,
                    sourceEventKey: currentSourceEventKey,
                    sourceEventOrdinal,
                    runnerSeq: emittedThroughSeq
                },
                terminalContent
            )
            if (result.fenceLost) fenceLost = true
            return result
        }
        // Always cursor-less. Once this recovery appends to the replayed seed,
        // its content is not the fold of any prefix it can name: a resumed
        // source can re-derive rows that are deduped away rather than inserted.
        // Writing null keeps whatever cursor the pre-crash dispatch left behind
        // from outliving the content it described.
        const prepareTerminalContent =
            async (): Promise<TerminalStreamContent> => {
                // Same fence as runAdapter's terminal write, for the same reason:
                // a superseded-content checkpoint still in flight is an older
                // prefix of this row and must not land after it.
                await checkpointer.fence()
                assistantBlocks.endInput()
                return {
                    contentBlocksJson: assistantBlocks.blocks,
                    contentCheckpointEventId: null
                }
            }
        // This path has no periodic checkpoint — it writes at the terminal —
        // but it is the path external convergence runs on, and convergence is
        // where `replace` comes from. The row is the cache every non-streaming
        // reader renders, and an upstream chat-flow legitimately runs for
        // minutes between the replace and the terminal, so leaving superseded
        // text in it for that long is the harm itself; a suspend means no
        // terminal from this process at all. Best-effort like the live path's
        // checkpoint, and detached like it (#749): a failure here must not take
        // the turn down, and a slow one must not stop it reading.
        const checkpointer = createContentCheckpointer({
            logger: this.logger,
            telemetry: this.telemetry,
            sessionId: session.id,
            messageId: assistantMessageId,
            write: (blocks, cursor) =>
                this.writeAssistantContent(
                    assistantMessageId,
                    blocks,
                    cursor,
                    opts.fence
                ),
            retire: (snapshot) => assistantBlocks.markCheckpointed(snapshot)
        })
        const checkpointSupersededContent = (
            checkpointEventId: bigint | null = null
        ): void => {
            if (!assistantBlocks.checkpointForced) return
            checkpointer.enqueue(
                assistantBlocks.snapshot(),
                Promise.resolve(
                    assistantBlocks.truncated ? null : checkpointEventId
                )
            )
        }
        // #689's second window, closed at the front instead of the back. The
        // process that died may never have landed its own forced checkpoint,
        // so the row this recovery inherits can still hold text the replay has
        // just established was superseded — and this recovery may itself
        // suspend, or be interrupted, without ever reaching a terminal. A
        // replay that folded no replace leaves the flag clear and writes
        // nothing.
        // The replayed seed is still an exact durable prefix, so pair its
        // repair with that prefix's last content row. A cold attach can then
        // render the repaired row and start after the replace, rather than
        // briefly replaying the superseded answer before reaching it. Any
        // content this recovery adds below gives up the cursor as before.
        checkpointSupersededContent(assistantBlocks.replayedThrough)
        try {
            try {
                for await (const raw of withTurnBudgets(
                    events,
                    this.turnBudgets(),
                    // The durable turn origin, so the total budget spans the
                    // whole turn instead of restarting at every continuation.
                    // Idle is unaffected: this transport has produced nothing
                    // yet, so its silence starts now.
                    startedAt
                )) {
                    const event = normalizeEventForAbort(raw, abortSignal)
                    if (event.type === 'raw_source') {
                        // A new line means the previous one is fully emitted, so its
                        // watermark can now be claimed by the rows that follow.
                        emittedThroughSeq = currentLineSeq ?? emittedThroughSeq
                        if (typeof event.runnerSeq === 'number')
                            currentLineSeq = event.runnerSeq
                        const row = buildChatMessageSourceRow({
                            sourceKind: 'live_stream',
                            sessionId: session.id,
                            messageId: assistantMessageId,
                            framework: agentCtx.framework,
                            runtime: agentCtx.runtime,
                            source: event.source,
                            runnerSeq: event.runnerSeq
                        })
                        currentSourceEventKey = row.sourceEventKey
                        // An adopted continuation re-derives keys the dead relay
                        // already used; continue their ordinals past the persisted
                        // max or the dedup unique index silently drops new events.
                        currentSourceEventOrdinal = sourceOrdinalBase
                            ? (sourceOrdinalBase.get(row.sourceEventKey) ??
                                  -1) + 1
                            : 0
                        try {
                            const sourceResult =
                                await this.repo.upsertMessageSources(
                                    [row],
                                    opts.fence
                                )
                            if (sourceResult.fenceLost) {
                                fenceLost = true
                                break
                            }
                        } catch (err) {
                            this.logger.warn(
                                `raw source cache write failed for resume message=${assistantMessageId}: ${(err as Error).message}`
                            )
                        }
                        continue
                    }
                    if (event.type === 'suspended') {
                        const accepted = (
                            await emitEvent('suspended', {
                                daemonId: event.daemonId,
                                daemonExecRef: event.daemonExecRef,
                                reason: event.reason
                            })
                        ).persisted
                        if (!accepted) break
                        suspended = true
                        break
                    }
                    if (event.type === 'usage') {
                        const u = event.usage as ChatUsage
                        totalTokensIn += Number(u?.inputTokens ?? 0)
                        totalTokensOut += Number(u?.outputTokens ?? 0)
                        void this.usage.record({
                            userId: session.userId,
                            agentId: session.agentId,
                            runtimeId: agentCtx.runtimeId,
                            sessionId: session.id,
                            messageId: assistantMessageId,
                            framework: agentCtx.framework,
                            runtimeKind: agentCtx.runtime,
                            modelProviderId: agentCtx.modelProviderId,
                            usage: event.usage,
                            fence: opts.fence
                        })
                        continue
                    }
                    if (event.type === 'done') {
                        completed = true
                        const terminalContent = await prepareTerminalContent()
                        terminalPersisted = (
                            await emitEvent(
                                event.type,
                                event as unknown as Record<string, unknown>,
                                terminalContent
                            )
                        ).persisted
                        break
                    }
                    if (event.type === 'error') {
                        const durableEvent = durableErrorEvent(event)
                        terminalError = durableEvent
                        managedChannelFailureSignal =
                            agentCtx.modelProviderSource === 'managed'
                                ? (event.managedChannelFailure ?? null)
                                : null
                        const terminalContent = await prepareTerminalContent()
                        terminalPersisted = (
                            await emitEvent(
                                event.type,
                                durableEvent as unknown as Record<
                                    string,
                                    unknown
                                >,
                                terminalContent
                            )
                        ).persisted
                        break
                    }
                    const accepted = (
                        await emitEvent(
                            event.type,
                            event as unknown as Record<string, unknown>
                        )
                    ).persisted
                    if (!accepted) break
                    if (event.type === 'token') {
                        recoveryCheckpointCursor = null
                        assistantBlocks.appendText('text', event.text)
                    }
                    if (event.type === 'thinking') {
                        recoveryCheckpointCursor = null
                        assistantBlocks.appendText('thinking', event.text)
                    }
                    if (event.type === 'tool_call') {
                        recoveryCheckpointCursor = null
                        assistantBlocks.pushBlock({
                            type: 'tool_call',
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            args: event.args,
                            elapsedMs: event.elapsedMs
                        })
                    }
                    if (event.type === 'tool_result') {
                        recoveryCheckpointCursor = null
                        assistantBlocks.pushBlock({
                            type: 'tool_result',
                            toolCallId: event.toolCallId,
                            result: event.result,
                            elapsedMs: event.elapsedMs
                        })
                    }
                    if (event.type === 'replace') {
                        recoveryCheckpointCursor = null
                        assistantBlocks.replaceAnswer(event.text)
                        checkpointSupersededContent()
                    }
                }
            } catch (err) {
                // Same classification rule as runAdapter, and the reason this
                // loop grew a catch at all: a budget breach has to become its
                // own retryable terminal HERE, ahead of the
                // `abortSignal.aborted` fallthrough below, or the watchdog's
                // own abort would make the turn read as cancelled_by_user.
                // Every other rejection still propagates to the caller
                // untouched — resume hands its exact generation back for a
                // bounded retry, while adoption lets the lease lapse so a
                // later sweep retries.
                if (!(err instanceof TurnBudgetExceededError)) throw err
                terminalError = turnBudgetErrorEvent(err)
                const terminalContent = await prepareTerminalContent()
                terminalPersisted = (
                    await emitEvent(
                        terminalError.type,
                        terminalError as unknown as Record<string, unknown>,
                        terminalContent
                    )
                ).persisted
                // Terminal first, abort second: that emit is what releases
                // the inflight claim and closes turn_executions. The shared
                // tail below then reports it through the normal funnel.
                this.abortTimedOutTurn(assistantMessageId, err)
            }
            if (
                abortSignal.aborted &&
                abortSignal.reason instanceof TurnFenceLostError
            )
                fenceLost = true
            if (
                !suspended &&
                !completed &&
                !terminalError &&
                !fenceLost &&
                abortSignal.aborted
            ) {
                // Mirror runAdapter: a stream that just stops while the abort is
                // in flight is a cancel, not a silent success. Without this the
                // fall-through below writes done over a cancelled turn.
                //
                // `!fenceLost` is what keeps a handoff from being libelled as a
                // user cancel: the new owner aborts this carrier to take the
                // turn, and this branch would otherwise read that abort as the
                // user's and terminalize a turn that is still running.
                terminalError = cancelledByUserEvent()
                const terminalContent = await prepareTerminalContent()
                terminalPersisted = (
                    await emitEvent(
                        terminalError.type,
                        terminalError as unknown as Record<string, unknown>,
                        terminalContent
                    )
                ).persisted
            }
            if (!suspended && !completed && !terminalError && !fenceLost) {
                // Mirror runAdapter: if the resume stream ends without an explicit
                // terminal, emit done so the turn terminalizes (and the inflight
                // lock is released via insertStreamEvent).
                completed = true
                const terminalContent = await prepareTerminalContent()
                terminalPersisted = (
                    await emitEvent(
                        'done',
                        {
                            type: 'done',
                            finalMessageId: assistantMessageId
                        },
                        terminalContent
                    )
                ).persisted
            }
            // Terminal telemetry mirrors the durable terminal row 1:1 (#544):
            // emit only when THIS invocation's row actually landed, so a replay
            // deduped away on sourceEventKey does not report a second terminal
            // for a turn it did not terminalize.
            if (!suspended && terminalPersisted) {
                if (completed) {
                    this.telemetry.event('chat.stream.complete', {
                        userId: session.userId,
                        sessionId: session.id,
                        agentId: session.agentId,
                        framework: agentCtx.framework,
                        runtimeKind: agentCtx.runtime,
                        model: agentCtx.model,
                        assistantMessageId,
                        durationMs: Date.now() - startedAt,
                        tokensIn: totalTokensIn,
                        tokensOut: totalTokensOut,
                        resumed: true
                    })
                } else if (
                    terminalError &&
                    terminalError.error.code !== CANCELLED_BY_USER_CODE
                ) {
                    this.reportStreamError({
                        err: new Error(terminalError.error.message),
                        detail: terminalError.error.message,
                        errorCode: terminalError.error.code,
                        retryable: terminalError.error.retryable,
                        turnPhase: opts.via,
                        framework: agentCtx.framework,
                        runtimeKind: agentCtx.runtime,
                        session,
                        assistantMessageId,
                        userId: session.userId,
                        durationMs: Date.now() - startedAt,
                        resumed: true
                    })
                }
                this.emitTurnTerminalTelemetry({
                    session,
                    agentCtx,
                    assistantMessageId,
                    outcome: terminalOutcomeOf(completed, terminalError),
                    errorCode: terminalError?.error.code ?? null,
                    startedAt,
                    // A resumed/adopted turn never observed setup, dispatch or
                    // first token — those fields stay absent rather than faked.
                    timings: {},
                    firstTokenAt: null,
                    resumed: true,
                    via: opts.via
                })
                const admission =
                    (await this.managedChannelBreaker?.ownedProbeAdmission(
                        {
                            brand:
                                agentCtx.modelProviderSource === 'managed'
                                    ? agentCtx.managedBrand
                                    : null,
                            protocol: agentCtx.inferenceProtocol,
                            model: agentCtx.model,
                            framework: agentCtx.framework,
                            runtimeKind: agentCtx.runtime
                        },
                        assistantMessageId
                    )) ?? null
                await this.settleManagedChannel(admission, {
                    completed,
                    errorCode: terminalError?.error.code ?? null,
                    detail: terminalError?.error.message ?? null,
                    capacitySignal: managedChannelFailureSignal
                })
            } else if (!suspended && !terminalPersisted) {
                this.logger.warn(
                    fenceLost
                        ? `message=${assistantMessageId} was taken over by another owner mid-relay; stopping without a terminal`
                        : `terminal for message=${assistantMessageId} was not persisted (deduped or stream gone); suppressing terminal telemetry`
                )
            }
        } finally {
            // A terminal has already fenced this to empty; a suspend or a
            // rethrown adapter error has not, and this process is done with
            // the row either way. Waiting here is what keeps a detached write
            // from landing under whoever owns the turn next.
            await checkpointer.drain()
            // A failed write drops the snapshot queued behind it because that
            // snapshot was sampled before the failure was known. At this final
            // ownership boundary there may be no later event to resample the
            // still-forced replace, so do that once from current content. A
            // terminal already persisted current content and must remain last.
            if (
                !completed &&
                !terminalError &&
                !fenceLost &&
                assistantBlocks.checkpointForced
            ) {
                checkpointSupersededContent(recoveryCheckpointCursor)
                await checkpointer.drain()
            }
            if (suspended) {
                this.broadcaster.endStream(assistantMessageId, opts.fence)
                // This API carrier is fully drained. Move its exact generation
                // to the short handoff lease so the next authoritative daemon
                // hello is not rejected behind a 90-second running lease.
                await this.repo
                    .handoffOwnedTurn(
                        assistantMessageId,
                        opts.fence.ownerId,
                        opts.fence.generation
                    )
                    .catch(() => false)
            }
        }
        return {
            suspended,
            fenceLost,
            outcome: suspended
                ? 'suspended'
                : terminalOutcomeOf(completed, terminalError),
            errorCode: terminalError?.error.code ?? null
        }
    }

    private async runAdapter(
        adapter: ReturnType<ChatAdapterRegistry['get']>,
        session: DbChatSession,
        userMessage: ChatMessage,
        assistantMessageId: string,
        history: ChatMessage[],
        modelOverride: string | null,
        modelConfig: AgentModelConfig | null,
        runtimeLocalTuning: RuntimeLocalTuning | null,
        claudeCodePermissionMode: ClaudeCodePermissionMode | null,
        codexPermissionMode: CodexPermissionMode | null,
        abortSignal: AbortSignal,
        observer?: ChatTurnObserver,
        agent?: Agent,
        channelSource?: ChannelSource | null
    ): Promise<void> {
        const assistantBlocks = createAssistantBlockBuffer(
            this.logger,
            assistantMessageId
        )
        const startedAt = Date.now()
        const timings: ChatTurnTimings = {}
        let firstTokenAt: number | null = null
        let totalTokensIn = 0
        let totalTokensOut = 0
        let terminalContentPrepared = false
        let completed = false
        let suspended = false
        let terminalError: EmittedErrorEvent | null = null
        let managedChannelFailureSignal: ManagedChannelFailureSignal | null =
            null
        let terminalPersisted = false
        // See runAdapterFromIterable: latched when a write is refused because
        // the turn moved to another owner. Dispatch reaches this only after its
        // lease lapsed and a sweep or a matched daemon hello took the turn, and
        // from then on this relay is a bystander to a live turn.
        let fenceLost = false
        let turnFence: TurnExecutionFence | null = null
        const loseTurnFence = (): void => {
            fenceLost = true
            const controller = this.runningAdapters.get(assistantMessageId)
            if (
                controller?.signal === abortSignal &&
                !controller.signal.aborted
            )
                controller.abort(new TurnFenceLostError(assistantMessageId))
        }
        let currentSourceEventKey: string | null = null
        let currentSourceEventOrdinal = 0
        // The buffer keeps `blocks` collapsed and jsonb-safe as it is built,
        // so a write is one serialisation and nothing else. It used to be
        // four full passes over the whole turn (collapse, two sanitise regex
        // passes, stringify) on every checkpoint, all of it synchronous on
        // the event loop that also serves HTTP and every other session's SSE.
        // Cursor-less on purpose. endInput() flushes a held surrogate half
        // that no single event row contains, and the terminal row itself is
        // written after this, so there is no id that describes this content.
        // It costs nothing: a turn past its terminal is not replayed from a
        // cursor, it is read from the row.
        const prepareTerminalContent =
            async (): Promise<TerminalStreamContent> => {
                if (terminalContentPrepared)
                    return {
                        contentBlocksJson: assistantBlocks.blocks,
                        contentCheckpointEventId: null
                    }
                // Ahead of everything else. A checkpoint still in flight holds an
                // older prefix of this same row, and letting it land afterwards
                // would replace the turn's final content with part of it. The
                // fence is the only thing that ORDERS the two — an UPDATE already
                // in the pool cannot be recalled.
                await checkpointer.fence()
                await flushSourceRows()
                assistantBlocks.endInput()
                terminalContentPrepared = true
                return {
                    contentBlocksJson: assistantBlocks.blocks,
                    contentCheckpointEventId: null
                }
            }
        // Partial-content checkpoints: the message row used to stay empty
        // until the terminal, so cold page loads mid-turn had to replay every
        // stream event and a crash lost all partial content. The web hides
        // the message row while its stream is live, so no double-render.
        //
        // Since the row also carries a cursor, a cold load no longer replays
        // the turn at all: it renders this content and subscribes from the
        // cursor. That makes WHEN this runs load-bearing — it is called after
        // the event's own row has been admitted, never before, so that a
        // `replace` is inside the cursor rather than left in the tail to be
        // applied a second time over content it has already superseded.
        //
        // What it does NOT do is wait for the write (#749). The row is a
        // cache; the loop below is the product. Sampling is synchronous and
        // ordered, the write is not, and the checkpointer owns everything
        // between the two.
        let lastCheckpointAt = Date.now()
        const checkpointer = createContentCheckpointer({
            logger: this.logger,
            telemetry: this.telemetry,
            sessionId: session.id,
            messageId: assistantMessageId,
            write: (blocks, cursor) =>
                this.writeAssistantContent(
                    assistantMessageId,
                    blocks,
                    cursor,
                    turnFence ?? undefined
                ),
            // Only a write that landed retires the pending bytes and the
            // forced flag. Retiring them on the attempt loses the fact that a
            // write is still owed — and for a `replace`, what is owed is the
            // removal of text the product has decided nobody should read.
            retire: (snapshot) => assistantBlocks.markCheckpointed(snapshot)
        })
        const maybeCheckpoint = (toolBoundary: boolean): void => {
            const now = Date.now()
            if (
                !shouldCheckpointContent({
                    pendingChars: assistantBlocks.pendingChars,
                    contentChars: assistantBlocks.contentChars,
                    sinceCheckpointMs: now - lastCheckpointAt,
                    sinceFailureMs:
                        checkpointer.lastFailureAt === null
                            ? null
                            : now - checkpointer.lastFailureAt,
                    toolBoundary,
                    forced: assistantBlocks.checkpointForced
                })
            )
                return
            lastCheckpointAt = now
            // Both halves of the row's single fact are fixed HERE, in one
            // synchronous step: the blocks are copied, and settle() takes its
            // place in the write chain before it returns, so the id it
            // eventually reports covers exactly the events this copy holds.
            // Sampling either half later — from a buffer that has grown, or
            // from a chain that has moved on — pairs content with a cursor
            // describing a different set of events, which is the bug the
            // pairing invariant exists to prevent.
            //
            // A truncated buffer has no such id at all: it is a suffix of the
            // turn, not a prefix, so it keeps the content and gives up the
            // cursor.
            const snapshot = assistantBlocks.snapshot()
            checkpointer.enqueue(
                snapshot,
                snapshot.truncated
                    ? Promise.resolve(null)
                    : this.broadcaster.settle(assistantMessageId)
            )
        }
        // Raw-source cache rows batch on a short window instead of one upsert
        // per JSONL line; rows are idempotent keyed upserts, so a crash loses
        // at most the last window (recoverable from the runtime session file).
        const pendingSourceRows: ReturnType<
            typeof buildChatMessageSourceRow
        >[] = []
        let sourceFlushTimer: ReturnType<typeof setTimeout> | null = null
        const flushSourceRows = async (): Promise<void> => {
            if (sourceFlushTimer) {
                clearTimeout(sourceFlushTimer)
                sourceFlushTimer = null
            }
            if (pendingSourceRows.length === 0) return
            const rows = pendingSourceRows.splice(0, pendingSourceRows.length)
            try {
                const result = await this.repo.upsertMessageSources(
                    rows,
                    turnFence ?? undefined
                )
                if (result.fenceLost) loseTurnFence()
            } catch (err) {
                this.logger.warn(
                    `raw source cache write failed for message=${assistantMessageId}: ${(err as Error).message}`
                )
            }
        }
        const agentCtx =
            agent && agent.id === session.agentId
                ? {
                      framework: agent.framework,
                      runtime: agent.runtime,
                      runtimeId: agent.runtimeId ?? null,
                      model: agent.model ?? null,
                      modelProviderId: agent.modelProviderId ?? null,
                      ...(await this.providerFacts(
                          agent.modelProviderId ?? null
                      )),
                      daemonId: agent.daemonId ?? null,
                      spriteName: agent.spriteName ?? null,
                      hostId: agent.hostId ?? null,
                      workspacePath: agent.workspacePath ?? null
                  }
                : await this.resolveAgentContext(session.agentId)
        // Decided BEFORE any runner, daemon or CLI work: when a managed
        // channel's shared upstream account pool is known empty, every one of
        // those steps is spent rediscovering it — minutes per turn (#660) — and
        // the turn ends the same way regardless. Exactly one turn per cooldown
        // is admitted across the fleet as the probe that decides recovery; the
        // rest terminalize here.
        //
        // Keyed off `source` as well as the brand so a BYO row can never be
        // gated by managed capacity, whatever its columns say.
        const admission =
            (await this.managedChannelBreaker?.admitTurn(
                {
                    brand:
                        agentCtx.modelProviderSource === 'managed'
                            ? agentCtx.managedBrand
                            : null,
                    protocol: agentCtx.inferenceProtocol,
                    model: modelOverride ?? agentCtx.model,
                    framework: agentCtx.framework,
                    runtimeKind: agentCtx.runtime
                },
                assistantMessageId
            )) ?? null
        const fastFail = admission?.decision === 'fail_fast' ? admission : null
        // Same shape, one layer down (#730): when this sprite's exec endpoint is
        // known to be refusing sockets, the runner inspect and the direct sprite
        // adapter are both the transport that is refusing, and the turn ends the
        // same way after paying both budgets. Consulted here so a blocked turn
        // costs one indexed read instead of a handshake — and before the runner,
        // because the inspect IS the turn's first exec.
        const blockedTerminal = fastFail
            ? null
            : await this.gateSpriteExec({
                  agentId: session.agentId,
                  runtime: agentCtx.runtime,
                  spriteName: agentCtx.spriteName,
                  hostId: agentCtx.hostId
              })
        // The daemon-exec bookkeeping is what makes a turn resumable: the
        // reverse-WS resume path finds an orphan by (daemon_id, daemon_exec_ref).
        // A runner turn needs the same row, so resolve the runner FIRST and stamp
        // whichever daemon will actually carry the stream.
        const resolution =
            fastFail || blockedTerminal
                ? null
                : await this.resolveSpriteRunner({
                      agentId: session.agentId,
                      userId: session.userId,
                      framework: agentCtx.framework,
                      runtime: agentCtx.runtime,
                      spriteName: agentCtx.spriteName,
                      workspacePath: agentCtx.workspacePath
                  })
        const runner = resolution?.runner ?? null
        // A runner bring-up that died ON the exec endpoint is the one fallback
        // the direct sprite adapter cannot serve: it dials the same socket the
        // inspect just proved dead, so the fallback pays a second full budget to
        // be told the same thing (39s + 39s in #730). Quarantine and terminalize
        // instead. Every other fallback reason is untouched.
        const execTerminal =
            blockedTerminal ??
            (resolution?.execFailure
                ? await this.markSpriteExecUnavailable(
                      session.agentId,
                      agentCtx.hostId,
                      resolution.execFailure
                  )
                : null)
        const runnerDaemonId = runner?.daemonId ?? null
        // A runner turn produces no platform-visible activity, so the sprite
        // would suspend under it. Held for the turn's whole life and released
        // at the terminal; if THIS instance dies mid-turn the lease survives on
        // its TTL, which is what keeps the runner executing and the turn
        // resumable.
        const awakeHold =
            runner && this.runnerManager
                ? this.runnerManager.keepSpriteAwake({
                      exec: runner.exec,
                      turnId: assistantMessageId
                  })
                : null
        const carryingDaemonId =
            agentCtx.runtime === 'daemon' ? agentCtx.daemonId : runnerDaemonId
        // A fail-fast turn never reaches a daemon and is terminal within
        // milliseconds, so it needs neither a resume ref nor an adoption lease:
        // stamping either would advertise work nobody is doing. A turn spared by
        // the exec-health verdict is the same case — nothing was dispatched, so
        // there is nothing for a fresh instance to adopt or resume.
        if (!fastFail && !execTerminal && carryingDaemonId) {
            await this.db
                .update(chatMessagesTable)
                .set({
                    daemonId: carryingDaemonId,
                    daemonExecRef: assistantMessageId
                })
                .where(eq(chatMessagesTable.id, assistantMessageId))
        }
        // Sprite and external-API turns get a durable execution record + lease
        // so a fresh instance can adopt them after a deploy/crash/auto-stop.
        // Stamping is unconditional (cheap); only the adoption sweep is
        // flag-gated, so a turn started before the flag flips is still
        // adoptable once enabled.
        //
        // External turns were left out until #670, which made every daily API
        // deploy a guaranteed kill: the upstream (Dify/A2A) finished the answer
        // and billed for it, while the user got a retryable server_restart and
        // no way back to the result.
        //
        // Daemon-runtime turns are stamped too, and NOT so they can be adopted:
        // listAdoptableTurnExecutions filters to sprites/external, so a
        // runtime='daemon' row is never a sweep candidate. The row is the only
        // cross-replica place a daemon turn's ownership can live, and #570 is
        // precisely two replicas each believing they own one — a hello that
        // lands on the peer while this dispatch is still streaming has nothing
        // to arbitrate against without it.
        let leaseTimer: ReturnType<typeof setInterval> | null = null
        const stampedRuntime =
            agentCtx.runtime === 'sprites' ||
            agentCtx.runtime === 'external' ||
            (agentCtx.runtime === 'daemon' && carryingDaemonId !== null)
        if (stampedRuntime && this.turnAdoption && !fastFail && !execTerminal) {
            const ownerId = this.turnAdoption.ownerId
            try {
                turnFence = await this.repo.upsertTurnExecution({
                    messageId: assistantMessageId,
                    sessionId: session.id,
                    agentId: session.agentId,
                    runtime: agentCtx.runtime,
                    spriteName: agentCtx.spriteName,
                    ownerId,
                    leaseSeconds: TURN_LEASE_SECONDS
                })
            } catch (err) {
                throw new TurnOwnershipUnavailableError(assistantMessageId, {
                    cause: err
                })
            }
            if (!turnFence)
                throw new TurnOwnershipUnavailableError(assistantMessageId)
            // The stream opened before the runtime was resolved, so the rows
            // ahead of this point had no row to be fenced against — nothing
            // could own the turn yet. From the stamp on, they do.
            this.setTurnFence(turnFence)
            const generation = turnFence.generation
            leaseTimer = setInterval(() => {
                void this.repo
                    .renewTurnLease(
                        assistantMessageId,
                        ownerId,
                        TURN_LEASE_SECONDS,
                        generation
                    )
                    .then((renewed) => {
                        if (renewed) return
                        loseTurnFence()
                    })
                    .catch(() => undefined)
            }, TURN_LEASE_RENEW_MS)
            if (typeof leaseTimer.unref === 'function') leaseTimer.unref()
        }
        // Keep every observed-but-unconfirmed ref available both to the next
        // announcement and to graceful shutdown. handoffOwnedTurns folds these
        // values into the handoff transaction, so its state change cannot race
        // ahead of the recovery handle.
        const unpersistedRef: {
            taskId?: string | null
            upstreamMessageId?: string | null
        } = {}
        const persistUpstreamRef = async (ref: {
            taskId?: string | null
            upstreamMessageId?: string | null
        }): Promise<void> => {
            const merged = {
                taskId: ref.taskId ?? unpersistedRef.taskId ?? null,
                upstreamMessageId:
                    ref.upstreamMessageId ??
                    unpersistedRef.upstreamMessageId ??
                    null
            }
            const pendingRef = {
                taskId: merged.taskId,
                upstreamMessageId: merged.upstreamMessageId
            }
            this.unpersistedUpstreamRefs.set(assistantMessageId, pendingRef)
            let failure: Error | null = null
            try {
                if (!turnFence)
                    throw new TurnOwnershipUnavailableError(assistantMessageId)
                const result = await this.repo.setTurnUpstreamRef(
                    assistantMessageId,
                    merged,
                    turnFence
                )
                if (result.fenceLost) {
                    loseTurnFence()
                    throw new TurnFenceLostError(assistantMessageId)
                }
                if (result.written) {
                    unpersistedRef.taskId = null
                    unpersistedRef.upstreamMessageId = null
                    if (
                        this.unpersistedUpstreamRefs.get(assistantMessageId) ===
                        pendingRef
                    )
                        this.unpersistedUpstreamRefs.delete(assistantMessageId)
                    return
                }
            } catch (err) {
                if (err instanceof TurnFenceLostError) throw err
                failure = err as Error
            }
            unpersistedRef.taskId = merged.taskId
            unpersistedRef.upstreamMessageId = merged.upstreamMessageId
            const reason = failure ? 'write_failed' : 'execution_row_missing'
            const attrs = {
                messageId: assistantMessageId,
                sessionId: session.id,
                agentId: session.agentId,
                framework: agentCtx.framework,
                reason
            }
            if (failure)
                this.telemetry.error(
                    'chat.turn.upstream_ref_lost',
                    failure,
                    attrs
                )
            else this.telemetry.event('chat.turn.upstream_ref_lost', attrs)
            this.logger.warn(
                `upstream ref not durable messageId=${assistantMessageId} reason=${reason}: ${failure?.message ?? 'no turn_executions row took the write'}`
            )
        }
        // Advances only on a NEW raw_source line — see runnerSeq on
        // EmittedStreamEvent for why the current line's seq would be wrong.
        let emittedThroughSeq: number | null = null
        let currentLineSeq: number | null = null
        const streamEvent = (
            type: PersistedStreamEventType,
            payload: Record<string, unknown>
        ): EmittedStreamEvent => ({
            type,
            payload,
            sourceEventKey: currentSourceEventKey,
            sourceEventOrdinal:
                currentSourceEventKey !== null
                    ? currentSourceEventOrdinal++
                    : null,
            runnerSeq: emittedThroughSeq
        })
        const emitEvent = async (
            type: PersistedStreamEventType,
            payload: Record<string, unknown>,
            terminalContent?: TerminalStreamContent
        ): Promise<{ persisted: boolean }> => {
            const result = await this.broadcaster.emit(
                assistantMessageId,
                streamEvent(type, payload),
                terminalContent
            )
            if (result.fenceLost) loseTurnFence()
            return result
        }
        // Rows on the broadcaster's NON-BUFFERED path are handed to its
        // per-stream write chain instead of being awaited. tool_call and
        // tool_result are over half the rows on an agentic turn, and awaiting
        // each one parked this loop — and with it the read of the sprite WSS
        // / daemon RPC / pod exec stream feeding it — for one commit apiece.
        // Ordering is the chain's job, not the caller's, and the cap inside
        // emitDetached keeps a database slower than the transport from
        // queueing without limit. Terminals and turn_status keep awaiting:
        // they read `persisted`.
        const emitEventDetached = (
            type: PersistedStreamEventType,
            payload: Record<string, unknown>
        ): Promise<boolean> =>
            this.broadcaster.emitDetached(
                assistantMessageId,
                streamEvent(type, payload)
            )
        try {
            // Substituting the stream rather than short-circuiting the method
            // is the whole trick: a fail-fast turn then walks the exact same
            // terminal path as any other adapter error — same persistence and
            // dedupe, same observer/SSE, same inflight-claim release, same
            // exactly-once terminal telemetry — and no invariant below has to
            // learn that this turn is special.
            const sparedStream = fastFail
                ? managedChannelFastFailStream(
                      this.managedChannelBreaker?.channelLabel(
                          fastFail.brand
                      ) ?? null
                  )
                : execTerminal
                  ? sandboxExecUnavailableStream(execTerminal)
                  : null
            const adapterStream =
                sparedStream ??
                adapter.sendMessage(
                    {
                        userId: session.userId,
                        agentId: session.agentId,
                        runtimeId: agentCtx.runtimeId,
                        sessionId: session.id,
                        messageId: assistantMessageId,
                        framework: agentCtx.framework,
                        runtimeKind: agentCtx.runtime,
                        model: modelOverride ?? agentCtx.model,
                        modelOverride,
                        runtimeLocalTuning,
                        modelProviderId: agentCtx.modelProviderId,
                        modelProviderBuiltInId: agentCtx.modelProviderBuiltInId,
                        modelConfig,
                        claudeCodePermissionMode,
                        codexPermissionMode,
                        frameworkSessionRef: session.frameworkSessionRef,
                        history,
                        abortSignal,
                        ...(turnFence ? { turnFence } : {}),
                        agent:
                            agent?.id === session.agentId ? agent : undefined,
                        channelSource: channelSource ?? undefined,
                        timings,
                        runnerDaemonId,
                        onExecSession:
                            agentCtx.runtime === 'sprites' &&
                            agentCtx.spriteName
                                ? (execSessionId) => {
                                      const fence = turnFence
                                      if (!fence) return
                                      void this.repo
                                          .setTurnExecSession(
                                              assistantMessageId,
                                              agentCtx.spriteName as string,
                                              execSessionId,
                                              fence
                                          )
                                          .then((written) => {
                                              if (!written) loseTurnFence()
                                          })
                                          .catch(() => undefined)
                                  }
                                : undefined,
                        // Persisted the moment the upstream names the work,
                        // not at the terminal: the whole point is that this
                        // instance may not live long enough to see one. The
                        // adapter holds provider progress until this attempt
                        // settles; failures are retained and reported above.
                        onUpstreamRef:
                            agentCtx.runtime === 'external' && this.turnAdoption
                                ? persistUpstreamRef
                                : undefined
                    },
                    userMessage
                )
            for await (const adapterEvent of withTurnBudgets(
                adapterStream,
                this.turnBudgets()
            )) {
                const event = normalizeEventForAbort(adapterEvent, abortSignal)
                if (event.type === 'raw_source') {
                    // A new line means the previous one is fully emitted, so its
                    // watermark can now be claimed by the rows that follow.
                    emittedThroughSeq = currentLineSeq ?? emittedThroughSeq
                    if (typeof event.runnerSeq === 'number')
                        currentLineSeq = event.runnerSeq
                    const row = buildChatMessageSourceRow({
                        sourceKind: 'live_stream',
                        sessionId: session.id,
                        messageId: assistantMessageId,
                        framework: agentCtx.framework,
                        runtime: agentCtx.runtime,
                        source: event.source,
                        runnerSeq: event.runnerSeq
                    })
                    currentSourceEventKey = row.sourceEventKey
                    currentSourceEventOrdinal = 0
                    pendingSourceRows.push(row)
                    if (pendingSourceRows.length >= 20) {
                        await flushSourceRows()
                    } else if (!sourceFlushTimer) {
                        sourceFlushTimer = setTimeout(() => {
                            sourceFlushTimer = null
                            void flushSourceRows()
                        }, 200)
                        if (typeof sourceFlushTimer.unref === 'function')
                            sourceFlushTimer.unref()
                    }
                    continue
                }
                if (event.type === 'suspended') {
                    await flushSourceRows()
                    const accepted = (
                        await emitEvent('suspended', {
                            daemonId: event.daemonId,
                            daemonExecRef: event.daemonExecRef,
                            reason: event.reason
                        })
                    ).persisted
                    if (!accepted) break
                    notifyObserver(observer, event)
                    suspended = true
                    this.logger.log(
                        `chat suspended messageId=${assistantMessageId} daemonId=${event.daemonId}`
                    )
                    break
                }
                if (event.type === 'usage') {
                    notifyObserver(observer, event)
                    const u = event.usage as ChatUsage
                    totalTokensIn += Number(u?.inputTokens ?? 0)
                    totalTokensOut += Number(u?.outputTokens ?? 0)
                    void this.usage.record({
                        userId: session.userId,
                        agentId: session.agentId,
                        runtimeId: agentCtx.runtimeId,
                        sessionId: session.id,
                        messageId: assistantMessageId,
                        framework: agentCtx.framework,
                        runtimeKind: agentCtx.runtime,
                        modelProviderId: agentCtx.modelProviderId,
                        usage: event.usage,
                        ...(turnFence ? { fence: turnFence } : {})
                    })
                    continue
                }
                if (event.type === 'done') {
                    completed = true
                    const terminalContent = await prepareTerminalContent()
                    terminalPersisted = (
                        await emitEvent(
                            event.type,
                            event as unknown as Record<string, unknown>,
                            terminalContent
                        )
                    ).persisted
                    if (terminalPersisted) notifyObserver(observer, event)
                    break
                }
                if (event.type === 'error') {
                    const durableEvent = durableErrorEvent(event)
                    terminalError = durableEvent
                    managedChannelFailureSignal =
                        agentCtx.modelProviderSource === 'managed'
                            ? (event.managedChannelFailure ?? null)
                            : null
                    const terminalContent = await prepareTerminalContent()
                    terminalPersisted = (
                        await emitEvent(
                            event.type,
                            durableEvent as unknown as Record<string, unknown>,
                            terminalContent
                        )
                    ).persisted
                    if (terminalPersisted)
                        notifyObserver(observer, durableEvent)
                    break
                }
                const accepted = DETACHED_STREAM_EVENT_TYPES.has(event.type)
                    ? await emitEventDetached(
                          event.type,
                          event as unknown as Record<string, unknown>
                      )
                    : (
                          await emitEvent(
                              event.type,
                              event as unknown as Record<string, unknown>
                          )
                      ).persisted
                if (!accepted) break
                notifyObserver(observer, event)
                if (event.type === 'token') {
                    if (firstTokenAt === null) firstTokenAt = Date.now()
                    assistantBlocks.appendText('text', event.text)
                }
                if (event.type === 'thinking')
                    assistantBlocks.appendText('thinking', event.text)
                if (event.type === 'tool_call')
                    assistantBlocks.pushBlock({
                        type: 'tool_call',
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        args: event.args,
                        elapsedMs: event.elapsedMs
                    })
                if (event.type === 'tool_result')
                    assistantBlocks.pushBlock({
                        type: 'tool_result',
                        toolCallId: event.toolCallId,
                        result: event.result,
                        elapsedMs: event.elapsedMs
                    })
                // A replace is in the checkpoint set where it was not before,
                // and it bypasses the byte rule. It supersedes answer text a
                // checkpoint may already have written, and until this write
                // lands the row still serves that text to every non-streaming
                // reader — a replacement that shrinks the answer moves far
                // less than 10% of it, so the byte rule alone could leave it
                // there for the rest of the turn. Costs one write per replace
                // — once per turn on the external converge path, and Dify's
                // background output moderation can fire a few more.
                if (event.type === 'replace')
                    assistantBlocks.replaceAnswer(event.text)
                // AFTER the emit, not before it. Both orders write the same
                // content; only this one can pair it with a cursor. Emitting
                // first means this event's row is already admitted, so the
                // settle inside covers it and the checkpoint's cursor does
                // not under-claim the content by exactly one event — which
                // for a `replace` would leave the replace in the tail, to be
                // applied a second time on top of content that has already
                // absorbed it, deleting the answer the client just rendered.
                //
                // Not awaited (#749): it samples, hands off and returns, so
                // the next transport event is read while the row is written.
                if (CHECKPOINTED_STREAM_EVENT_TYPES.has(event.type))
                    maybeCheckpoint(
                        event.type === 'tool_call' ||
                            event.type === 'tool_result'
                    )
            }
            if (suspended) {
                // No terminal on this path, so nothing else in this process
                // writes this content: a suspended turn is picked up by
                // whoever resumes it, seeded from the stream log. Anything
                // the checkpointer still owes has to land before then rather
                // than under the next owner.
                await checkpointer.drain()
                this.broadcaster.endStream(
                    assistantMessageId,
                    turnFence ?? undefined
                )
                // The runner still owns the remote work, but this API relay no
                // longer owns delivery. Expose that distinction durably after
                // its buffered writes have drained above.
                if (turnFence)
                    await this.repo
                        .handoffOwnedTurn(
                            assistantMessageId,
                            turnFence.ownerId,
                            turnFence.generation
                        )
                        .catch(() => false)
                return
            }
            if (
                !completed &&
                !terminalError &&
                !fenceLost &&
                abortSignal.aborted
            ) {
                const event = cancelledByUserEvent()
                terminalError = event
                const terminalContent = await prepareTerminalContent()
                terminalPersisted = (
                    await emitEvent(
                        event.type,
                        event as unknown as Record<string, unknown>,
                        terminalContent
                    )
                ).persisted
                if (terminalPersisted) notifyObserver(observer, event)
            }
            if (!completed && !terminalError && !fenceLost) {
                const event = {
                    type: 'done',
                    finalMessageId: assistantMessageId
                } as const
                completed = true
                const terminalContent = await prepareTerminalContent()
                terminalPersisted = (
                    await emitEvent(
                        event.type,
                        event as unknown as Record<string, unknown>,
                        terminalContent
                    )
                ).persisted
                if (terminalPersisted) notifyObserver(observer, event)
            }
            if (terminalPersisted && completed) {
                this.telemetry.event('chat.stream.complete', {
                    userId: session.userId,
                    sessionId: session.id,
                    agentId: session.agentId,
                    framework: agentCtx.framework,
                    runtimeKind: agentCtx.runtime,
                    model: modelOverride ?? agentCtx.model,
                    assistantMessageId,
                    durationMs: Date.now() - startedAt,
                    tokensIn: totalTokensIn,
                    tokensOut: totalTokensOut
                })
            } else if (
                terminalPersisted &&
                terminalError &&
                terminalError.error.code !== CANCELLED_BY_USER_CODE
            ) {
                this.reportStreamError({
                    err: new Error(terminalError.error.message),
                    detail: terminalError.error.message,
                    errorCode: terminalError.error.code,
                    retryable: terminalError.error.retryable,
                    turnPhase: 'stream',
                    framework: agentCtx.framework,
                    runtimeKind: agentCtx.runtime,
                    session,
                    assistantMessageId,
                    userId: session.userId,
                    durationMs: Date.now() - startedAt
                })
            }
            if (!suspended && terminalPersisted) {
                this.emitTurnTerminalTelemetry({
                    session,
                    agentCtx,
                    assistantMessageId,
                    outcome: completed
                        ? 'done'
                        : terminalError?.error.code === CANCELLED_BY_USER_CODE
                          ? 'cancelled'
                          : 'error',
                    errorCode: terminalError?.error.code ?? null,
                    startedAt,
                    timings,
                    firstTokenAt
                })
                await this.settleManagedChannel(admission, {
                    completed,
                    errorCode: terminalError?.error.code ?? null,
                    detail: terminalError?.error.message ?? null,
                    capacitySignal: managedChannelFailureSignal
                })
            } else if (!suspended && !terminalPersisted)
                this.logger.warn(
                    fenceLost
                        ? `message=${assistantMessageId} was taken over by another owner mid-stream; stopping without a terminal`
                        : `terminal for message=${assistantMessageId} was not persisted (deduped or stream gone); suppressing terminal telemetry`
                )
        } catch (err) {
            // A lost fence is not this turn's failure to report — the turn is
            // alive under a new owner. Writing a terminal here would be
            // rejected anyway, but preparing one and calling it an adapter
            // error also puts a false `error` in the funnel and settles the
            // managed-channel probe on a turn this process no longer holds.
            if (fenceLost || err instanceof TurnFenceLostError) {
                this.logger.warn(
                    `message=${assistantMessageId} was taken over by another owner mid-stream; stopping without a terminal`
                )
                return
            }
            // Classification order is load-bearing. The watchdog aborts the
            // turn's own AbortController (at the end of this block) so the
            // transport tears down, and normalizeEventForAbort rewrites any
            // terminal that arrives while aborted — so reading
            // `abortSignal.aborted` first would relabel every watchdog kill as
            // a user cancel: non-retryable, absent from the error funnel, and
            // indistinguishable from someone pressing stop. A budget breach
            // carries its own identity, so it is classified BEFORE the abort
            // check, never after.
            const budgetErr =
                err instanceof TurnBudgetExceededError ? err : null
            const event = budgetErr
                ? turnBudgetErrorEvent(budgetErr)
                : abortSignal.aborted
                  ? cancelledByUserEvent()
                  : adapterErrorEvent(
                        (err as Error).message,
                        httpErrorCode(err)
                    )
            const terminalContent = await prepareTerminalContent()
            const persisted = (
                await this.broadcaster.emit(
                    assistantMessageId,
                    {
                        type: event.type,
                        payload: event as unknown as Record<string, unknown>
                    },
                    terminalContent
                )
            ).persisted
            if (persisted) {
                if (event.error.code !== CANCELLED_BY_USER_CODE)
                    this.reportStreamError({
                        // The original error keeps its stack; the classified
                        // cause comes off the terminal that was actually
                        // written, so code and message can never disagree.
                        err: err as Error,
                        detail: event.error.message,
                        errorCode: event.error.code,
                        retryable: event.error.retryable,
                        turnPhase: 'stream',
                        framework: agentCtx.framework,
                        runtimeKind: agentCtx.runtime,
                        session,
                        assistantMessageId,
                        userId: session.userId,
                        durationMs: Date.now() - startedAt
                    })
                this.emitTurnTerminalTelemetry({
                    session,
                    agentCtx,
                    assistantMessageId,
                    outcome:
                        event.error.code === CANCELLED_BY_USER_CODE
                            ? 'cancelled'
                            : 'error',
                    errorCode: event.error.code,
                    startedAt,
                    timings,
                    firstTokenAt
                })
                notifyObserver(observer, event)
                await this.settleManagedChannel(admission, {
                    completed: false,
                    errorCode: event.error.code,
                    detail: event.error.message,
                    capacitySignal: null
                })
            } else {
                this.logger.warn(
                    `terminal for message=${assistantMessageId} was not persisted (deduped or stream gone); suppressing terminal telemetry`
                )
            }
            // Terminal first, abort second. That emit is what releases the
            // session's inflight claim and closes turn_executions; only once it
            // is durable is it safe to raise the abort every cancel path keys
            // off, and only then does tearing the transport down cost nothing.
            if (budgetErr) this.abortTimedOutTurn(assistantMessageId, budgetErr)
        } finally {
            if (leaseTimer) clearInterval(leaseTimer)
            this.unpersistedUpstreamRefs.delete(assistantMessageId)
            // A suspended turn is still being executed by the runner, so the
            // sprite must stay awake for whoever resumes it; only a real
            // terminal drops the lease.
            if (awakeHold) {
                if (suspended) awakeHold.detach()
                else await awakeHold.release().catch(() => undefined)
            }
        }
    }

    // The single writer of `chat.stream.error`. Every terminal path used to
    // assemble its own attrs, so the four of them disagreed on what a failed
    // turn even reports — and Sentry, grouping on the ChatService frame they
    // all rebuild their Error at, had nothing to tell a balance exhaustion
    // from a dead daemon (#786).
    //
    // `errorCode` stays the durable ChatError code the user already sees.
    // `cause` is the closed classification, absent when nothing in the
    // evidence identifies one — an absent cause means Sentry's default
    // grouping, which is the honest answer for a failure mode we have not met.
    // `causeVia` names the classifier branch that answered; the counts of
    // `message` (legacy string table hit) and `code_unmapped` (specific code
    // with no durable mapping) are the removal gate for that table
    // (legacy-inventory §4.4). The message is used to classify and otherwise
    // stays on the existing exception value: no tag, no fingerprint, nothing
    // persisted.
    private reportStreamError(args: {
        err: Error
        detail: string
        errorCode: string | null
        retryable: boolean | null
        turnPhase: ChatTurnPhase
        framework: AgentFramework
        runtimeKind: ChatFailureRuntimeKind
        session: DbChatSession
        assistantMessageId: string
        userId?: string
        durationMs?: number
        resumed?: boolean
    }): void {
        const { cause, via } = explainChatFailureCause({
            errorCode: args.errorCode,
            message: args.detail
        })
        this.telemetry.error(CHAT_STREAM_ERROR_EVENT, args.err, {
            userId: args.userId,
            sessionId: args.session.id,
            agentId: args.session.agentId,
            framework: args.framework,
            assistantMessageId: args.assistantMessageId,
            durationMs: args.durationMs,
            resumed: args.resumed,
            errorCode: args.errorCode ?? undefined,
            cause: cause ?? undefined,
            causeVia: via,
            runtimeKind: args.runtimeKind,
            retryable: args.retryable ?? undefined,
            turnPhase: args.turnPhase
        })
    }

    // One uniform funnel event per non-suspended turn with the latency spans
    // the adapters recorded — the dataset that decides whether CLI boot +
    // resume load justify the sprite-resident runner (see
    // docs/chat-sprite-pipeline.md in the harness repo). Since #544 this also
    // covers turns that terminalize outside the dispatch path (resume,
    // adoption, restart convergence), which carry `resumed`/`via` so the
    // dispatch-only percentiles stay separable.
    private emitTurnTerminalTelemetry(args: {
        session: DbChatSession
        agentCtx: { framework: AgentFramework; runtime: AgentRuntime }
        assistantMessageId: string
        outcome: TurnTerminalOutcome
        errorCode: string | null
        startedAt: number
        timings: ChatTurnTimings
        firstTokenAt: number | null
        resumed?: boolean
        via?: TurnTerminalVia
    }): void {
        // Turn-finalized fan-out for cross-cutting listeners (narranexus-sync
        // pulls job/channel config after every NarraNexus turn). Since #544
        // recovered turns land here too, so the fan-out now also fires for
        // resume/adoption/reconciliation terminals — deliberate: the turn did
        // finalize and may have changed config before dying, and the listener
        // coalesces bursts per runtime and skips stopped runtimes, so a deploy
        // wave of restart convergences stays bounded.
        this.appEvents?.emit('chat.turn.finalized', {
            agentId: args.session.agentId,
            framework: args.agentCtx.framework
        })
        const { timings } = args
        this.telemetry.event('chat.turn.terminal', {
            sessionId: args.session.id,
            userId: args.session.userId,
            agentId: args.session.agentId,
            framework: args.agentCtx.framework,
            runtimeKind: args.agentCtx.runtime,
            assistantMessageId: args.assistantMessageId,
            outcome: args.outcome,
            ...(args.errorCode ? { errorCode: args.errorCode } : {}),
            ...(args.resumed ? { resumed: true } : {}),
            ...(args.via ? { via: args.via } : {}),
            durationMs: Date.now() - args.startedAt,
            ...(timings.setupMs !== undefined
                ? { setupMs: timings.setupMs }
                : {}),
            ...(timings.execDispatchedAt !== undefined
                ? { dispatchMs: timings.execDispatchedAt - args.startedAt }
                : {}),
            ...(timings.execDispatchedAt !== undefined &&
            timings.firstStdoutAt !== undefined
                ? {
                      execToFirstStdoutMs:
                          timings.firstStdoutAt - timings.execDispatchedAt
                  }
                : {}),
            ...(args.firstTokenAt !== null
                ? { firstTokenMs: args.firstTokenAt - args.startedAt }
                : {})
        })
    }

    // Terminal telemetry for turns terminalized OUTSIDE an adapter event loop
    // (unsupported resume, offline cancel, restart convergence). Call only once
    // the durable row is known to have persisted, so the funnel keeps mirroring
    // chat_stream_events 1:1 — the shared server_restart dedup key means
    // several writers race for the same row and only one wins it.
    //
    // Deliberately does NOT emit chat.stream.error: these are reconciliation
    // writes, not live stream failures, and a deploy wave of them would trip
    // the chat.stream.error burst monitor.
    private async emitDurableTerminalTelemetry(args: {
        sessionId: string
        messageId: string
        outcome: TurnTerminalOutcome
        errorCode: string
        via: TurnTerminalVia
        session?: DbChatSession
        message?: DbChatMessage
    }): Promise<void> {
        try {
            const session =
                args.session ?? (await this.repo.getSessionById(args.sessionId))
            if (!session) {
                // The durable row was written, so this leaves the funnel one
                // event short of chat_stream_events — say so, or the gap is
                // undiagnosable from a reconcile readback.
                this.logger.warn(
                    `terminal telemetry skipped for message=${args.messageId} (session ${args.sessionId} not found)`
                )
                return
            }
            const message =
                args.message ?? (await this.repo.getMessageById(args.messageId))
            if (!message) {
                this.logger.warn(
                    `terminal telemetry skipped for message=${args.messageId} (message row not found)`
                )
                return
            }
            const agentCtx = await this.resolveAgentContext(session.agentId)
            this.emitTurnTerminalTelemetry({
                session,
                agentCtx,
                assistantMessageId: args.messageId,
                outcome: args.outcome,
                errorCode: args.errorCode,
                startedAt: message.createdAt.getTime(),
                timings: {},
                firstTokenAt: null,
                resumed: true,
                via: args.via
            })
        } catch (err) {
            // Enrichment is best effort: a deleted agent must never turn a
            // converged turn into a failure.
            this.logger.warn(
                `terminal telemetry failed for message=${args.messageId}: ${(err as Error).message}`
            )
        }
    }

    private async assertAgentAccess(
        agentId: string,
        userId: string
    ): Promise<void> {
        const rows = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        const agent = rows[0]
        if (!agent) throw new NotFoundException('agent not found')
        if (agent.userId !== userId)
            throw new NotFoundException('agent not found')
    }

    private async assertSessionAccess(
        sessionId: string,
        userId: string,
        agentId: string
    ): Promise<DbChatSession> {
        const session = await this.repo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        return session
    }

    private async markRuntimeActive(agentId: string): Promise<void> {
        try {
            const rows = await this.db
                .select({
                    id: agents.id,
                    userId: agents.userId,
                    runtime: agents.runtime,
                    runtimeId: agents.runtimeId,
                    spriteName: agents.spriteName,
                    spriteStatus: agents.spriteStatus,
                    k8sPodPhase: agents.k8sPodPhase,
                    accountId: agents.accountId,
                    hostId: agents.hostId
                })
                .from(agents)
                .where(eq(agents.id, agentId))
                .limit(1)
            const row = rows[0]
            if (!row) return
            if (row.runtime === 'sprites') {
                // Over-quota users must not re-open the accrual watermark via
                // this fire-and-forget wake: publishStatus('running') would let
                // the turn hit reserveActiveSlot's fast path unchecked. Skipping
                // forces the slow path, which reports the typed 403.
                if (
                    this.runtimeAccess &&
                    (await this.runtimeAccess.isActiveHoursExhausted(
                        row.userId
                    ))
                ) {
                    this.logger.debug(
                        `skipping sprite wake for agent=${agentId}: active hours quota reached`
                    )
                    return
                }
                if (row.spriteStatus !== 'running') {
                    await this.spriteStatusSync.publishStatus(row, {
                        spriteStatus: 'running'
                    })
                }
                // Always nudge the sprite-side service on chat activity. The
                // sprite VM can stay `running` while the service process
                // inside it has stopped. The nudge restarts the service
                // WITHOUT re-instating a keep-alive lease — the lease exists
                // only while `keepAliveEnabled` is on. `wakeSpriteRuntime` is
                // idempotent and no-ops for exec-kind frameworks.
                if (row.runtimeId) {
                    const runtime = await this.runtimes.findById(row.runtimeId)
                    if (runtime) {
                        await this.spritesProvisioner.wakeSpriteRuntime(runtime)
                        // chat-originated wakes publish spriteStatus='running'
                        // directly so sprite-status-sync never observes a wake
                        // transition, and channel/CLI/automation sends never hit
                        // the agent list/get views that call touchRuntime —
                        // this touch is what lets a false-stopped row heal on
                        // the next listing
                        this.reconcile?.touchRuntime(runtime)
                    }
                }
            } else if (
                row.runtime === 'k8s' &&
                row.k8sPodPhase &&
                row.k8sPodPhase !== 'Running'
            ) {
                // Don't override real k8s phase (Pending/CrashLoopBackOff/...) here;
                // the 10s sync tick is the source of truth for k8s pod state.
            }
        } catch (err) {
            this.logger.warn(
                `failed to mark runtime active for agent=${agentId}: ${(err as Error).message}`
            )
        }
    }

    // Sidebar recency ordering reads this, not the started/bootstrapped/
    // reconciled trio: reconcile re-stamps those on every liveness observation,
    // which reshuffled the list on a timer. Best-effort — a lost write only
    // leaves the agent ordered by its previous turn.
    private async markAgentMessaged(agentId: string): Promise<void> {
        try {
            const now = new Date()
            await this.db
                .update(agents)
                .set({ lastMessageAt: now, updatedAt: now })
                .where(eq(agents.id, agentId))
        } catch (err) {
            this.logger.warn(
                `failed to mark agent messaged for agent=${agentId}: ${(err as Error).message}`
            )
        }
    }

    private async loadAgent(agentId: string) {
        const rows = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        const row = rows[0]
        if (!row) throw new NotFoundException('agent not found')
        return row
    }

    // Report what a turn actually proved about its managed channel, from the
    // same two places that own the terminal, so the breaker can never learn a
    // different outcome than the user was shown.
    //
    // A fail-fast turn reports nothing (the service drops it): it never reached
    // the upstream, and since its synthesized terminal classifies as
    // account_pool_empty like the real thing, recording it would let the
    // breaker feed on its own output.
    private async settleManagedChannel(
        admission: ManagedChannelAdmission | null,
        terminal: {
            completed: boolean
            errorCode: string | null
            detail: string | null
            capacitySignal: ManagedChannelFailureSignal | null
        }
    ): Promise<void> {
        const breaker = this.managedChannelBreaker
        if (!breaker || !admission) return
        if (admission.decision === 'fail_fast') return
        if (terminal.completed) {
            await breaker.recordSuccess(admission)
            return
        }
        if (terminal.errorCode === CANCELLED_BY_USER_CODE) {
            await breaker.recordInconclusive(admission, 'cancelled')
            return
        }
        if (terminal.capacitySignal === 'account_pool_empty') {
            await breaker.recordPoolExhaustion(admission)
            return
        }
        const diagnosticCause = classifyChatFailureCause({
            errorCode: terminal.errorCode,
            message: terminal.detail
        })
        await breaker.recordInconclusive(
            admission,
            diagnosticCause === 'account_pool_empty'
                ? 'unstructured_pool_empty'
                : (diagnosticCause ?? 'unclassified')
        )
    }

    // The provider-row facts a turn needs beyond the agent row: the built-in
    // catalog id for the per-built-in price scope, and the managed identity the
    // channel breaker keys on. One primary-key read; used by the path that
    // already holds the agent row and so skips resolveAgentContext's join.
    private async providerFacts(
        providerId: string | null
    ): Promise<ProviderTurnFacts> {
        if (!providerId) return EMPTY_PROVIDER_FACTS
        const rows = await this.db
            .select({
                builtInId: userModelProviders.builtInId,
                source: userModelProviders.source,
                managedBrand: userModelProviders.managedBrand,
                inferenceProtocol: userModelProviders.inferenceProtocol
            })
            .from(userModelProviders)
            .where(eq(userModelProviders.id, providerId))
            .limit(1)
        const row = rows[0]
        if (!row) return EMPTY_PROVIDER_FACTS
        return {
            modelProviderBuiltInId: row.builtInId ?? null,
            modelProviderSource: row.source ?? null,
            managedBrand: row.managedBrand ?? null,
            inferenceProtocol: row.inferenceProtocol ?? null
        }
    }

    private async resolveAgentContext(agentId: string): Promise<
        {
            framework: AgentFramework
            runtime: AgentRuntime
            runtimeId: string | null
            model: string | null
            modelProviderId: string | null
            daemonId: string | null
            spriteName: string | null
            // The sandbox VM row, which is what exec health is keyed on: the
            // sprite NAME is the platform's handle for the machine, the host id
            // is ours, and the cooldown lives on ours (#730).
            hostId: string | null
            workspacePath: string | null
        } & ProviderTurnFacts
    > {
        // The provider's built_in_id rides along so per-provider and per-built-in
        // price scopes can be resolved at cost time without another read; the
        // managed source/brand/protocol ride along for the same reason, so the
        // channel breaker costs no extra query on the dispatch path.
        const rows = await this.db
            .select({
                framework: agents.framework,
                runtime: agents.runtime,
                runtimeId: agents.runtimeId,
                model: agents.model,
                modelProviderId: agents.modelProviderId,
                modelProviderBuiltInId: userModelProviders.builtInId,
                modelProviderSource: userModelProviders.source,
                managedBrand: userModelProviders.managedBrand,
                inferenceProtocol: userModelProviders.inferenceProtocol,
                daemonId: agents.daemonId,
                spriteName: agents.spriteName,
                hostId: agents.hostId,
                workspacePath: agents.workspacePath
            })
            .from(agents)
            .leftJoin(
                userModelProviders,
                eq(userModelProviders.id, agents.modelProviderId)
            )
            .where(eq(agents.id, agentId))
            .limit(1)
        const row = rows[0]
        if (!row) throw new NotFoundException('agent not found')
        return {
            framework: row.framework,
            runtime: row.runtime,
            runtimeId: row.runtimeId ?? null,
            model: row.model ?? null,
            modelProviderId: row.modelProviderId ?? null,
            modelProviderBuiltInId: row.modelProviderBuiltInId ?? null,
            modelProviderSource: row.modelProviderSource ?? null,
            managedBrand: row.managedBrand ?? null,
            inferenceProtocol: row.inferenceProtocol ?? null,
            daemonId: row.daemonId ?? null,
            spriteName: row.spriteName ?? null,
            hostId: row.hostId ?? null,
            workspacePath: row.workspacePath ?? null
        }
    }
}

const TITLE_MAX_LENGTH = 100
const MESSAGE_MODEL_OVERRIDE_FRAMEWORKS: ReadonlySet<AgentFramework> = new Set([
    'claude-code',
    'codex',
    'gemini-cli'
])

const deriveTitleFromText = (text: string): string | null => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return null
    return normalized.length > TITLE_MAX_LENGTH
        ? normalized.slice(0, TITLE_MAX_LENGTH)
        : normalized
}

const deriveTitleFromBlocks = (blocks: ChatContentBlock[]): string | null =>
    deriveTitleFromText(extractFirstText(blocks)) ??
    deriveTitleFromAttachments(blocks)

const deriveTitleFromAttachments = (
    blocks: ChatContentBlock[]
): string | null => {
    const names = blocks
        .filter(
            (b): b is ChatAttachmentBlock | ChatContextRefBlock =>
                b.type === 'attachment' || b.type === 'context_ref'
        )
        .map((b) => b.name.trim())
        .filter(Boolean)
    if (names.length === 0) return null
    const text =
        names.length === 1
            ? names[0]
            : `${names[0]} and ${names.length - 1} more`
    return deriveTitleFromText(text)
}

const extractFirstText = (blocks: ChatContentBlock[]): string => {
    for (const b of blocks) {
        if (b.type === 'text') return b.text
    }
    return ''
}

const conversationNotFound = (): NotFoundException =>
    new NotFoundException({
        message: 'conversation not found',
        code: 'conversation_not_found'
    })

const invalidAfterCursor = (): BadRequestException =>
    new BadRequestException({
        message: 'invalid after cursor',
        code: 'invalid_after'
    })

const toApiMessage = (
    row: DbChatMessage,
    usageRow?: AgentUsageEventRow | null,
    errorPayload?: Record<string, unknown> | null
): ChatMessage => {
    const usage = usageRow ? usageRowToChatUsage(usageRow) : null
    const error = chatErrorFromPayload(errorPayload ?? null)
    return {
        id: row.id,
        sessionId: row.sessionId,
        role: row.role as ChatRole,
        contentBlocks: (row.contentBlocksJson as ChatContentBlock[]) ?? [],
        createdAt: row.createdAt.toISOString(),
        model: usage?.model ?? modelFromMessageMetadata(row),
        usage,
        error
    }
}

const chatErrorFromPayload = (
    payload: Record<string, unknown> | null
): ChatError | null => {
    if (!payload) return null
    const inner = (payload as { error?: unknown }).error
    if (!inner || typeof inner !== 'object') return null
    const e = inner as {
        code?: unknown
        message?: unknown
        retryable?: unknown
    }
    if (typeof e.code !== 'string' || typeof e.message !== 'string') return null
    if (e.code === CANCELLED_BY_USER_CODE) return null
    return {
        code: e.code,
        message: e.message,
        retryable: typeof e.retryable === 'boolean' ? e.retryable : false
    }
}

const toApiSession = (
    row: DbChatSession,
    channel: ChatSessionChannelSummary | null
): ChatSessionSummary => ({
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    frameworkSessionRef: row.frameworkSessionRef,
    channel,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

interface SessionChannelMapRow {
    chatSessionId: string
    channelSessionId: string
    channelId: string
    provider: ChatSessionChannelSummary['provider']
    label: string
    displayName: string | null
    channelSessionCreatedAt: Date
    channelSessionUpdatedAt: Date
}

const sessionChannelMap = (
    rows: SessionChannelMapRow[]
): Map<string, ChatSessionChannelSummary> => {
    const selected = new Map<
        string,
        {
            channel: ChatSessionChannelSummary
            createdAt: number
            updatedAt: number
        }
    >()

    for (const row of rows) {
        const createdAt = row.channelSessionCreatedAt.getTime()
        const updatedAt = row.channelSessionUpdatedAt.getTime()
        const current = selected.get(row.chatSessionId)
        if (
            current &&
            (current.updatedAt > updatedAt ||
                (current.updatedAt === updatedAt &&
                    current.createdAt >= createdAt))
        ) {
            continue
        }

        selected.set(row.chatSessionId, {
            channel: {
                id: row.channelId,
                channelSessionId: row.channelSessionId,
                provider: row.provider,
                label: row.label,
                displayName: row.displayName
            },
            createdAt,
            updatedAt
        })
    }

    return new Map(
        Array.from(selected.entries()).map(([sessionId, value]) => [
            sessionId,
            value.channel
        ])
    )
}

const usageRowToChatUsage = (row: AgentUsageEventRow): ChatUsage => ({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    costSource: row.costSource,
    isFallbackModel: row.isFallbackModel,
    firstTokenMs: row.firstTokenMs,
    totalMs: row.totalMs
})

const messageMetadataForTurn = (
    model: string | null
): Record<string, unknown> | null => {
    const normalized = normalizeMessageModel(model)
    return normalized ? { model: normalized } : null
}

const cancelledByUserEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: CANCELLED_BY_USER_CODE,
        message: CANCELLED_BY_USER_MESSAGE,
        retryable: false
    }
})

const interruptedErrorEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: 'server_restart',
        message: 'stream interrupted by server restart',
        retryable: true
    }
})

// The terminal a managed turn gets when its channel's shared upstream account
// pool is known empty (#660). Not retryable: retrying is precisely what the
// breaker exists to stop, and the move that actually works is switching the
// agent's channel. It names the channel and the action and nothing else — no
// key, no base URL, no account id, no upstream body.
const managedChannelUnavailableEvent = (
    channelLabel: string | null
): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: MANAGED_CHANNEL_UNAVAILABLE_CODE,
        message: `${channelLabel ?? 'This managed channel'} has no upstream accounts available right now, so this message was not sent. Switch this agent to another model channel to keep working, or try again after the channel recovers.`,
        retryable: false
    }
})

// Substituted for the adapter's stream rather than short-circuiting the turn,
// so the fail-fast path is the ordinary terminal path with a different first
// event.
async function* managedChannelFastFailStream(
    channelLabel: string | null
): AsyncGenerator<EmittedChatEvent> {
    yield managedChannelUnavailableEvent(channelLabel)
}

// A user cancel is its own outcome, never an error: it must not land in the
// error funnel that pages on bursts.
const terminalOutcomeOf = (
    completed: boolean,
    terminalError: EmittedErrorEvent | null
): TurnTerminalOutcome =>
    completed
        ? 'done'
        : terminalError?.error.code === CANCELLED_BY_USER_CODE
          ? 'cancelled'
          : 'error'

// Preserve typed codes from HttpException bodies (quota rejections etc.) so
// web/CLI can key behavior off stream errors instead of matching message text.
const httpErrorCode = (err: unknown): string | undefined => {
    if (!(err instanceof HttpException)) return undefined
    const body = err.getResponse()
    if (typeof body !== 'object' || body === null) return undefined
    const code = (body as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
}

const adapterErrorEvent = (
    message: string,
    code = 'adapter_error'
): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code,
        message,
        retryable: true
    }
})

const safeErrorClass = (err: unknown): string => {
    if (err instanceof SpritesError) return `SpritesError:${err.code}`
    return err instanceof Error && err.name ? err.name : typeof err
}

const normalizeEventForAbort = (
    event: EmittedChatEvent,
    abortSignal: AbortSignal
): EmittedChatEvent => {
    if (event.type === 'error' && event.error.code === CANCELLED_BY_USER_CODE)
        return {
            type: 'error',
            error: {
                code: CANCELLED_BY_USER_CODE,
                message: event.error.message || CANCELLED_BY_USER_MESSAGE,
                retryable: false
            }
        }
    if (
        abortSignal.aborted &&
        (event.type === 'done' || event.type === 'error')
    )
        return cancelledByUserEvent()
    return event
}

const notifyObserver = (
    observer: ChatTurnObserver | undefined,
    event: EmittedChatEvent
): void => {
    if (!observer) return
    try {
        observer(event)
    } catch {
        /* observers must not interrupt the chat pipeline */
    }
}
