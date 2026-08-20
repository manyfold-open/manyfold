import {
    agentFramework,
    agentRuntime
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime
} from '@manyfold/shared'

export const CHAT_STREAM_ERROR_EVENT = 'chat.stream.error'

// Sentry groups by the captured stack, and every Chat terminal is rebuilt at
// the same ChatService frame — so provider balance, an empty account pool, a
// stale resume ref, an offline daemon and a Sprite handshake 502 all landed in
// ONE issue whose title changed to whatever arrived last (#786). The
// fingerprint keyed on this list is what splits them, so each member below is
// an incident an operator can alert on and resolve on its own.
//
// Closed and versioned on purpose. A fingerprint component is a grouping key:
// adding a member only splits new events out of the unclassified bucket, but
// renaming one or moving what it MEANS re-groups history, and that is what the
// version is for.
export const CHAT_STREAM_ERROR_FINGERPRINT_VERSION = 'chat.stream.error.v1'

export const chatFailureCauses = [
    'balance_exhausted',
    'account_pool_empty',
    'rate_limited',
    'auth_invalid',
    'invalid_request',
    'stale_resume_ref',
    'daemon_offline',
    'exec_handshake_failed',
    'empty_response',
    'inactivity_timeout',
    'turn_duration_exceeded',
    'unsupported_capability'
] as const

export type ChatFailureCause = (typeof chatFailureCauses)[number]

// Which emitter wrote the terminal: `dispatch` is the pre-context rejection,
// `stream` the live adapter loop, and the last two are the recovery loop's own
// `via`. A cause reaching us only from `dispatch` is a different operational
// story from the same cause mid-stream.
const chatTurnPhases = [
    'dispatch',
    'stream',
    'resume',
    'adoption'
] as const

export type ChatTurnPhase = (typeof chatTurnPhases)[number]

// A dispatch rejection can fail before resolveAgentContext ever runs, so it
// knows which framework the turn was sent with and nothing at all about the
// runtime. Saying so explicitly beats dropping the field, which would make
// "absent" mean both "no runtime was resolved yet" and "a new emitter forgot
// to pass one" — and beats guessing, which would put a fabricated runtime on a
// dashboard operators route by.
export const UNKNOWN_RUNTIME_KIND = 'unknown'

export type ChatFailureRuntimeKind = AgentRuntime | typeof UNKNOWN_RUNTIME_KIND

const causes: ReadonlySet<string> = new Set(chatFailureCauses)
const phases: ReadonlySet<string> = new Set(chatTurnPhases)
const frameworks: ReadonlySet<string> = new Set(Object.values(agentFramework))
const runtimeKinds: ReadonlySet<string> = new Set([
    ...Object.values(agentRuntime),
    UNKNOWN_RUNTIME_KIND
])

export const isChatFailureCause = (value: unknown): value is ChatFailureCause =>
    typeof value === 'string' && causes.has(value)

export const isChatTurnPhase = (value: unknown): value is ChatTurnPhase =>
    typeof value === 'string' && phases.has(value)

export const isAgentFramework = (value: unknown): value is AgentFramework =>
    typeof value === 'string' && frameworks.has(value)

export const isChatFailureRuntimeKind = (
    value: unknown
): value is ChatFailureRuntimeKind =>
    typeof value === 'string' && runtimeKinds.has(value)