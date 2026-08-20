import type {
    EmittedChatEvent,
    EmittedErrorEvent
} from '@/modules/chat/chat-adapter'

export type TurnBudgetKind = 'idle' | 'total'

export interface TurnBudgets {
    idleTimeoutMs: number
    maxDurationMs: number
}

export const TURN_IDLE_TIMEOUT_CODE = 'turn_idle_timeout'
export const TURN_MAX_DURATION_CODE = 'turn_max_duration'

// A turn-level watchdog is the LAST backstop, not a response deadline: below a
// minute it stops detecting hangs and starts truncating healthy turns, which is
// exactly the shape #556 shipped by accident (a fixed 240s hermes deadline that
// the streamed notifications never reset, cutting off every turn longer than
// four minutes). So a sub-floor env value is clamped UP rather than honoured —
// one fat-fingered `MF_TURN_IDLE_TIMEOUT_MS=500` must not be able to kill every
// turn in the fleet. `0` stays the explicit, unambiguous off switch.
export const TURN_BUDGET_FLOOR_MS = 60_000
// The other end of the same argument, and it bites in the opposite direction.
// Node keeps a timer delay in a signed 32-bit int: a delay above 2^31-1ms does
// not become a longer timer, it overflows and node silently rewrites the
// duration to 1ms. Exact reproduction on the API runtime:
// `setTimeout(fn, 2147483648)._idleTimeout === 1`, with a TimeoutOverflowWarning
// on stderr as the only trace — a warning, not an error, so nothing gates on it.
// Any chat knob that reaches setTimeout is clamped DOWN to this, so a configured
// value can only ever move a deadline in the direction the operator meant.
// An operator widening a budget past ~24.86 days would otherwise get the exact
// inverse of what they asked for: every turn in the fleet killed almost
// immediately. Both budgets are clamped down to this ceiling, the mirror of the
// floor's clamp UP. 24.86 days is far longer than any turn this system can hold
// open, so the clamp removes a cliff and nothing else. The external convergence
// poll interval (#670) is a different knob with the identical overflow, and
// clamps here for the same reason.
export const MAX_TIMER_DELAY_MS = 2_147_483_647
// Directly injected values bypass env validation. Fail open on invalid input:
// passing NaN or a negative number to setTimeout would silently make it 1ms.
const normalizeTimerBudgetMs = (ms: number): number =>
    ms === Number.POSITIVE_INFINITY
        ? MAX_TIMER_DELAY_MS
        : !Number.isFinite(ms) || ms <= 0
          ? 0
          : Math.min(MAX_TIMER_DELAY_MS, ms)
// Generous on purpose. `raw_source` lines count as activity, so this budget only
// elapses when the transport itself produces NOTHING; a quiet tool run still
// trickles. #660 measured single turns at 221-273s doing nothing but retrying an
// empty pool, and those turns were healthy.
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_TURN_MAX_DURATION_MS = 2 * 60 * 60_000

const resolveBudgetMs = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) return fallback
    if (parsed === 0) return 0
    return normalizeTimerBudgetMs(Math.max(TURN_BUDGET_FLOOR_MS, parsed))
}

// Read per call rather than frozen at module load: these are operational knobs
// an operator flips on a running fleet, and freezing them at import time also
// makes them untestable (same reasoning as MF_SPRITE_RUNNER_AGENTS).
export const resolveTurnBudgets = (): TurnBudgets => ({
    idleTimeoutMs: resolveBudgetMs(
        process.env.MF_TURN_IDLE_TIMEOUT_MS,
        DEFAULT_TURN_IDLE_TIMEOUT_MS
    ),
    maxDurationMs: resolveBudgetMs(
        process.env.MF_TURN_MAX_DURATION_MS,
        DEFAULT_TURN_MAX_DURATION_MS
    )
})

// Its own type so the event loops can classify a watchdog kill BEFORE they look
// at `abortSignal.aborted` — the watchdog aborts the turn itself to tear the
// transport down, so anything that reads the signal first sees a cancel and
// mislabels the timeout as `cancelled_by_user`.
export class TurnBudgetExceededError extends Error {
    constructor(
        readonly kind: TurnBudgetKind,
        readonly elapsedMs: number,
        readonly budgetMs: number
    ) {
        super(
            kind === 'idle'
                ? `turn produced no adapter events for ${Math.round(elapsedMs / 1000)}s (idle budget ${Math.round(budgetMs / 1000)}s) — the adapter stream is parked`
                : `turn was still streaming after ${Math.round(elapsedMs / 1000)}s (max duration budget ${Math.round(budgetMs / 1000)}s)`
        )
        this.name = 'TurnBudgetExceededError'
    }
}

export const turnBudgetErrorEvent = (
    err: TurnBudgetExceededError
): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code:
            err.kind === 'idle'
                ? TURN_IDLE_TIMEOUT_CODE
                : TURN_MAX_DURATION_CODE,
        message: err.message,
        retryable: true
    }
})

// Wrap an adapter stream in two budgets and throw TurnBudgetExceededError when
// either lapses. Without this an iterator parked forever on next() holds the
// session's inflight claim, the runningAdapters entry, the sprite awake hold and
// the lease renew timer until the next deploy — and every existing backstop
// deliberately steps around it (terminalizeDeadInflightTurn skips turns live in
// this process; clearStaleInflightClaims only clears claims whose message is
// already terminal or gone). The total budget belongs to the TURN rather than to
// one wrapper, so a continuation inherits the remaining time; the idle budget
// belongs to the transport in front of it. Neither can outlive
// MAX_TIMER_DELAY_MS as a single timer.
export async function* withTurnBudgets(
    source: AsyncIterable<EmittedChatEvent>,
    budgets: TurnBudgets,
    // Durable turn origin (the assistant message's createdAt) for a stream that
    // CONTINUES a turn this process did not start. Omitted — or unreadable, which
    // getTime() reports as NaN — means the turn starts here, which is what a
    // fresh dispatch wants; NaN must never reach setTimeout, which reads it as 1ms.
    turnStartedAt?: number
): AsyncIterable<EmittedChatEvent> {
    const idleTimeoutMs = normalizeTimerBudgetMs(budgets.idleTimeoutMs)
    const maxDurationMs = normalizeTimerBudgetMs(budgets.maxDurationMs)
    if (idleTimeoutMs === 0 && maxDurationMs === 0) {
        yield* source
        return
    }
    const now = Date.now()
    // A deploy, a daemon resume and an adoption each build a NEW wrapper around
    // a turn that has been running since long before this process saw it, so a
    // total budget measured from wrapper creation handed every one of them
    // another full budget: a turn at 1h59m could resume for another 2h, and
    // again, with the cap never actually binding. The remaining time is clamped
    // to one budget so that an origin in the FUTURE — clock skew between the row
    // and this process — cannot buy more than one either.
    const startedAt =
        turnStartedAt !== undefined && Number.isFinite(turnStartedAt)
            ? Math.min(turnStartedAt, now)
            : now
    const totalRemainingMs = Math.min(
        maxDurationMs,
        startedAt + maxDurationMs - now
    )
    // Deliberately NOT inherited from the origin: the idle budget measures
    // transport silence, and a continuation's transport has said nothing yet, so
    // its silence starts here. Only the total budget is durable.
    let lastEventAt = now
    const breach: { err: TurnBudgetExceededError | null } = { err: null }
    // Resolved by whichever timer fires; recreated per iteration so a turn that
    // yields a million events does not accumulate a million pending reactions on
    // one long-lived promise.
    let wake: ((err: TurnBudgetExceededError) => void) | null = null
    const trip = (kind: TurnBudgetKind, budgetMs: number): void => {
        if (breach.err) return
        breach.err = new TurnBudgetExceededError(
            kind,
            Math.max(
                0,
                Date.now() - (kind === 'idle' ? lastEventAt : startedAt)
            ),
            budgetMs
        )
        wake?.(breach.err)
    }
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    // Rearmed on EVERY event, `raw_source` included: a transport line is proof
    // of life even when it derives no user-visible event.
    const armIdle = (): void => {
        if (idleTimeoutMs === 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(
            () => trip('idle', idleTimeoutMs),
            normalizeTimerBudgetMs(idleTimeoutMs)
        )
        idleTimer.unref?.()
    }
    // A continuation can inherit a deadline that has already passed. Trip
    // synchronously instead of arming a 0ms timer: the loop's first check then
    // throws before the source is pulled at all, and the caller's existing catch
    // writes the same durable retryable terminal it writes for a live breach.
    const exhausted = maxDurationMs !== 0 && totalRemainingMs <= 0
    if (exhausted) trip('total', maxDurationMs)
    const totalTimer =
        maxDurationMs === 0 || exhausted
            ? null
            : setTimeout(
                  () => trip('total', maxDurationMs),
                  normalizeTimerBudgetMs(totalRemainingMs)
              )
    totalTimer?.unref?.()
    armIdle()
    const iterator = source[Symbol.asyncIterator]()
    let abandoned = false
    try {
        for (;;) {
            if (breach.err) {
                abandoned = true
                throw breach.err
            }
            const next = iterator.next()
            const tripped = new Promise<TurnBudgetExceededError>((resolve) => {
                if (breach.err) resolve(breach.err)
                else wake = resolve
            })
            // A parked next() never settles, so the race is the only thing that
            // can get control back. Its later rejection (the abort tearing the
            // transport down) is still observed by Promise.race, so it cannot
            // surface as an unhandled rejection.
            const settled = await Promise.race([next, tripped])
            wake = null
            if (settled instanceof TurnBudgetExceededError) {
                abandoned = true
                throw settled
            }
            if (settled.done) return
            lastEventAt = Date.now()
            armIdle()
            yield settled.value
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer)
        if (totalTimer) clearTimeout(totalTimer)
        // Every non-breach exit (done, the `suspended` break, a consumer throw)
        // still awaits the source's return() so the adapter generator's own
        // cleanup runs — that path is unchanged from a bare `for await`. After a
        // breach it is fire-and-forget: return() queues behind the request the
        // generator is parked on, so awaiting it would hang the caller forever,
        // which is the exact failure this watchdog exists to end.
        if (abandoned) void iterator.return?.().catch(() => undefined)
        else await iterator.return?.()
    }
}
