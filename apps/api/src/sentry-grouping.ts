import {
    CHAT_STREAM_ERROR_EVENT,
    CHAT_STREAM_ERROR_FINGERPRINT_VERSION,
    isAgentFramework,
    isChatFailureCause,
    isChatFailureRuntimeKind,
    isChatTurnPhase
} from './common/telemetry/chat-failure-taxonomy'

export interface TelemetryCaptureOptions {
    tags: Record<string, string>
    extra: Record<string, unknown>
    fingerprint?: string[]
}

// The exact options production hands Sentry.captureException, lifted out of
// ./sentry so the grouping contract is testable: importing ./sentry runs
// Sentry.init as a side effect, and a test that has to mock that ends up
// asserting on source text instead of on behaviour.
//
// Every tag and every fingerprint component is re-checked against a closed
// enum HERE rather than trusted from the caller. This is the boundary where a
// value becomes a Sentry tag, and an unbounded tag is both a cardinality bomb
// and a leak (#661) — so a value that is not a known member is dropped, never
// passed through. Raw exception messages stay on the exception; ids, refs and
// urls stay in `extra`. Neither becomes indexed, and beforeSend keeps applying
// the existing scrubber to both carriers.
export const buildTelemetryCaptureOptions = (
    name: string,
    attrs: Record<string, unknown>
): TelemetryCaptureOptions => {
    const options: TelemetryCaptureOptions = {
        tags: { 'nca.event': name },
        extra: attrs
    }
    if (name !== CHAT_STREAM_ERROR_EVENT) return options

    const { cause, framework, runtimeKind, turnPhase, retryable } = attrs
    if (isAgentFramework(framework))
        options.tags['nca.chat_framework'] = framework
    if (isChatFailureRuntimeKind(runtimeKind))
        options.tags['nca.chat_runtime_kind'] = runtimeKind
    if (isChatTurnPhase(turnPhase))
        options.tags['nca.chat_turn_phase'] = turnPhase
    if (typeof retryable === 'boolean')
        options.tags['nca.chat_retryable'] = String(retryable)

    // An unclassified failure keeps Sentry's default stack grouping. A bucket
    // called `unknown` would rebuild exactly the one issue this splits, and it
    // would swallow every genuinely new failure mode into it.
    if (!isChatFailureCause(cause)) return options
    options.tags['nca.chat_cause'] = cause
    // Cause alone. Framework stays a tag and out of the key because the same
    // exhausted balance reaches us through several adapters and is one
    // incident; errorCode is neither, because adapters mint codes freely so it
    // is not a statically closed set — it rides `extra`, where breadth is free.
    options.fingerprint = [CHAT_STREAM_ERROR_FINGERPRINT_VERSION, cause]
    return options
}