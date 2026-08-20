import type {
    EmittedChatEvent,
    EmittedErrorEvent
} from '@/modules/chat/chat-adapter'

// The durable code every "this agent's sandbox cannot take a command right now"
// terminal carries (#730), so a client can key retry affordances off it instead
// of matching prose it does not own.
export const SANDBOX_EXEC_UNAVAILABLE_CODE = 'sandbox_exec_unavailable'

// Emitted once per spared turn, alongside the breaker's own admission/probe/mark
// events. Together they answer the only two operational questions: is the
// endpoint out, and how many turns did being out cost.
export const SPRITE_EXEC_TERMINAL_EVENT = 'sprite_exec.terminal'

// Which decision produced the terminal. Telemetry only — the user is told the
// same thing either way, because the action is the same.
export type SpriteExecTerminalPhase =
    | 'cooldown' // the durable verdict refused this turn before any exec
    | 'probe_failed' // this turn held the fleet's one probe and it failed
    | 'runner_inspect' // the turn's first exec proved the endpoint dead

export interface SpriteExecTerminal {
    // Null only in the case the breaker does not own: an agent whose sprite has
    // no runtime host row to arm. The turn is still spared — the transport that
    // just failed is the only one the fallback has — it is simply not recorded.
    hostId: string | null
    phase: SpriteExecTerminalPhase
    retryAt: Date | null
}

const retryHint = (retryAt: Date | null): string => {
    const seconds = retryAt
        ? Math.ceil((retryAt.getTime() - Date.now()) / 1000)
        : 0
    return seconds > 0
        ? `Try again in about ${seconds}s.`
        : 'Try again in a moment.'
}

// Retryable, and the ONE thing this terminal must get right: the sandbox
// platform fault behind it clears by itself in under a minute, so the turn is
// worth sending again — unlike the managed-channel refusal next door, where
// retrying is the thing being prevented.
//
// It names the layer that failed and the action, and nothing else: no sprite
// name, no host id, no exec URL, no upstream body. A user cannot act on any of
// those and an incident channel should not be where they leak.
export const sandboxExecUnavailableEvent = (
    terminal: SpriteExecTerminal
): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: SANDBOX_EXEC_UNAVAILABLE_CODE,
        message: `This agent's sandbox is not accepting commands right now, so this message was not sent. ${retryHint(terminal.retryAt)} If it keeps failing, restart the agent's sandbox from its runtime settings.`,
        retryable: true
    }
})

// Substituted for the adapter's stream rather than short-circuiting the turn, so
// the refusal is the ordinary terminal path with a different first event — same
// persistence and dedupe, same observer/SSE, same inflight-claim release, same
// exactly-once terminal telemetry. Nothing downstream has to learn that this
// turn is special.
export async function* sandboxExecUnavailableStream(
    terminal: SpriteExecTerminal
): AsyncGenerator<EmittedChatEvent> {
    yield sandboxExecUnavailableEvent(terminal)
}
