import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import {
    DEFAULT_TURN_IDLE_TIMEOUT_MS,
    DEFAULT_TURN_MAX_DURATION_MS,
    MAX_TIMER_DELAY_MS,
    resolveTurnBudgets,
    TURN_BUDGET_FLOOR_MS,
    turnBudgetErrorEvent,
    TurnBudgetExceededError,
    withTurnBudgets
} from '../src/modules/chat/turn-budgets'

// #668. Real timers with small budgets, and the budgets are passed in rather
// than read from env: the 60s floor is a production safety clamp on OPERATOR
// input, and asserting watchdog BEHAVIOUR through it would mean a 60s test.
// The floor gets its own tests below, against resolveTurnBudgets — which is the
// only thing it applies to. (#513's lesson, inverted: the trap there was a test
// whose budget was silently clamped up, so it asserted the clamp and not the
// behaviour. Here the two are tested separately and on purpose.)

const BOUND_MS = 4_000

// Every watchdog timer is unref'd, because a hung turn must never be the reason
// a process refuses to exit. Production always has the HTTP server's handles on
// the loop; a test whose only other handle is a promise that never settles does
// not, and node would exit before the budget could lapse. So these tests hold
// the loop open themselves.
const keepLoopAlive = (): (() => void) => {
    const timer = setInterval(() => {}, 1_000)
    return () => clearInterval(timer)
}

const settledWithin = async <T>(
    promise: Promise<T>,
    ms: number
): Promise<{ settled: boolean }> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<{ settled: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), ms)
    })
    try {
        return await Promise.race([
            promise.then(
                () => ({ settled: true }),
                () => ({ settled: true })
            ),
            expiry
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const withEnv = async (
    vars: Record<string, string | undefined>,
    fn: () => void | Promise<void>
): Promise<void> => {
    const saved = new Map<string, string | undefined>()
    for (const key of Object.keys(vars)) saved.set(key, process.env[key])
    try {
        for (const [key, value] of Object.entries(vars)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await fn()
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

const token = (text: string): EmittedChatEvent => ({ type: 'token', text })

// Yields `count` events `gapMs` apart, then ends. `onCleanup` fires from the
// generator's own finally, which is how the tests below observe whether the
// wrapper propagated return() to the source.
const trickle = (
    count: number,
    gapMs: number,
    onCleanup?: () => void
): AsyncIterable<EmittedChatEvent> => {
    async function* gen(): AsyncIterable<EmittedChatEvent> {
        try {
            for (let i = 0; i < count; i++) {
                await new Promise((resolve) => setTimeout(resolve, gapMs))
                yield token(`t${i}`)
            }
        } finally {
            onCleanup?.()
        }
    }
    return gen()
}

// One event, then parked on next() forever — the exact production failure: the
// transport is alive as far as node is concerned, so nothing else ever notices.
const parkAfterOneToken = (
    onCleanup?: () => void
): AsyncIterable<EmittedChatEvent> => {
    async function* gen(): AsyncIterable<EmittedChatEvent> {
        try {
            yield token('hi')
            await new Promise<void>(() => {})
        } finally {
            onCleanup?.()
        }
    }
    return gen()
}

const drain = async (
    events: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const seen: EmittedChatEvent[] = []
    for await (const event of events) seen.push(event)
    return seen
}

test('a parked iterator breaches the idle budget instead of hanging forever', async () => {
    const stop = keepLoopAlive()
    try {
        const seen: EmittedChatEvent[] = []
        const run = (async () => {
            for await (const event of withTurnBudgets(parkAfterOneToken(), {
                idleTimeoutMs: 200,
                maxDurationMs: 0
            }))
                seen.push(event)
        })()
        const outcome = await settledWithin(run, BOUND_MS)
        assert.ok(
            outcome.settled,
            `a parked turn must end inside ${BOUND_MS}ms, not hang the suite`
        )
        const err = await run.then(
            () => null,
            (e: unknown) => e
        )
        assert.ok(
            err instanceof TurnBudgetExceededError,
            `expected a budget error, got ${String(err)}`
        )
        assert.equal(err.kind, 'idle')
        assert.equal(err.budgetMs, 200)
        // setTimeout can fire ~1ms early against Date.now() (ms truncation on
        // both clocks), which failed this as 199 >= 200 on a loaded CI runner.
        assert.ok(
            err.elapsedMs >= 190,
            `elapsed ${err.elapsedMs}ms should roughly cover the budget`
        )
        assert.deepEqual(seen, [token('hi')])
    } finally {
        stop()
    }
})

test('the idle budget rearms on every event, so a slow but live stream survives', async () => {
    // Ten 20ms gaps: total elapsed (~200ms) is well past the 120ms budget, so
    // this passes only if the budget is per-gap rather than per-turn.
    const seen = await drain(
        withTurnBudgets(trickle(10, 20), {
            idleTimeoutMs: 120,
            maxDurationMs: 0
        })
    )
    assert.equal(seen.length, 10)
})

test('raw_source alone rearms the idle budget: transport activity is liveness', async () => {
    // A quiet tool run derives no user-visible event for minutes; only the
    // JSONL lines prove the transport is alive.
    async function* rawOnly(): AsyncIterable<EmittedChatEvent> {
        for (let i = 0; i < 6; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            yield {
                type: 'raw_source',
                source: {
                    sourceRef: 'session-1',
                    sourceSeq: i,
                    externalId: `raw-${i}`,
                    parentExternalId: null,
                    rawFormat: 'jsonl',
                    rawText: '{"type":"message"}',
                    parserName: 'test-stream-jsonl',
                    parserVersion: '1'
                }
            }
        }
        yield { type: 'done', finalMessageId: 'm1' }
    }
    const seen = await drain(
        withTurnBudgets(rawOnly(), { idleTimeoutMs: 100, maxDurationMs: 0 })
    )
    assert.equal(seen.length, 7)
})

test('the total budget is NOT rearmed by events', async () => {
    // Steady 10ms events forever: the idle budget can never fire, so anything
    // that ends this turn is the wall clock.
    async function* forever(): AsyncIterable<EmittedChatEvent> {
        for (let i = 0; ; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10))
            yield token(`t${i}`)
        }
    }
    const err = await drain(
        withTurnBudgets(forever(), { idleTimeoutMs: 0, maxDurationMs: 150 })
    ).then(
        () => null,
        (e: unknown) => e
    )
    assert.ok(err instanceof TurnBudgetExceededError)
    assert.equal(err.kind, 'total')
    assert.equal(err.budgetMs, 150)
})

// The continuation contract. A deploy, a daemon resume and an adoption each
// build a NEW wrapper around a turn that started long before this process saw
// it, and every one of them used to restart the total budget from zero.

const budgetErrorOf = async (
    events: AsyncIterable<EmittedChatEvent>
): Promise<unknown> =>
    drain(events).then(
        () => null,
        (e: unknown) => e
    )

test('a continuation gets what REMAINS of the durable budget, not a fresh one', async () => {
    const TOTAL = 1_200
    const spent = 1_000
    const at = Date.now()
    const err = await budgetErrorOf(
        withTurnBudgets(
            trickle(10_000, 10),
            { idleTimeoutMs: 0, maxDurationMs: TOTAL },
            // The durable turn origin: this turn has been running for `spent`
            // ms already, under some other process.
            at - spent
        )
    )
    const wallMs = Date.now() - at
    assert.ok(err instanceof TurnBudgetExceededError)
    assert.equal(err.kind, 'total')
    assert.ok(
        wallMs < TOTAL - 400,
        `a continuation must terminalize on the REMAINING ~${TOTAL - spent}ms, not a fresh ${TOTAL}ms (took ${wallMs}ms)`
    )
    // Reported against the durable origin, so the terminal says how long the
    // user actually waited rather than how long this wrapper lived.
    assert.ok(
        err.elapsedMs >= TOTAL - 10,
        `elapsed ${err.elapsedMs}ms must be measured from the durable origin`
    )
})

test('a continuation whose durable budget is already spent breaches before touching the source', async () => {
    const TOTAL = 300
    let pulled = false
    async function* neverStarted(): AsyncIterable<EmittedChatEvent> {
        pulled = true
        yield token('hi')
    }
    const at = Date.now()
    const err = await budgetErrorOf(
        withTurnBudgets(
            neverStarted(),
            { idleTimeoutMs: 0, maxDurationMs: TOTAL },
            at - TOTAL * 5
        )
    )
    const wallMs = Date.now() - at
    assert.ok(
        err instanceof TurnBudgetExceededError,
        `an already-spent durable budget must breach, got ${String(err)}`
    )
    assert.equal(err.kind, 'total')
    assert.ok(
        wallMs < 200,
        `an exhausted budget must terminalize immediately, not after another ${TOTAL}ms (took ${wallMs}ms)`
    )
    assert.equal(
        pulled,
        false,
        'a turn that is already over its deadline must not open the transport at all'
    )
    assert.ok(err.elapsedMs >= TOTAL * 5)
    // The exhausted path is the ordinary breach path, so it produces the same
    // retryable terminal the caller's catch already knows how to write.
    const terminal = turnBudgetErrorEvent(err)
    assert.equal(terminal.error.code, 'turn_max_duration')
    assert.equal(terminal.error.retryable, true)
})

// The failure mode in one test: 1h59m + another 2h + another 2h, forever.
test('re-wrapping the same turn does not grant another full budget', async () => {
    const TOTAL = 900
    const origin = Date.now() - (TOTAL - 200)
    const at = Date.now()
    const first = await budgetErrorOf(
        withTurnBudgets(
            trickle(10_000, 10),
            { idleTimeoutMs: 0, maxDurationMs: TOTAL },
            origin
        )
    )
    const afterFirst = Date.now()
    // The redeploy/re-resume: same durable turn, brand new wrapper.
    const second = await budgetErrorOf(
        withTurnBudgets(
            trickle(10_000, 10),
            { idleTimeoutMs: 0, maxDurationMs: TOTAL },
            origin
        )
    )
    const secondMs = Date.now() - afterFirst
    assert.ok(first instanceof TurnBudgetExceededError)
    assert.equal(first.kind, 'total')
    assert.ok(second instanceof TurnBudgetExceededError)
    assert.equal(second.kind, 'total')
    assert.ok(
        secondMs < 200,
        `the second wrapper must inherit an already-spent budget, not restart it (ran ${secondMs}ms)`
    )
    assert.ok(
        Date.now() - at < TOTAL + 400,
        'two continuations must not add up to two budgets'
    )
})

test('a durable origin in the future cannot buy more than one budget', async () => {
    // The row's createdAt is written by postgres and the budget is measured by
    // this process; a skewed clock must not be able to widen the cap.
    const TOTAL = 300
    const at = Date.now()
    const err = await budgetErrorOf(
        withTurnBudgets(
            trickle(10_000, 10),
            { idleTimeoutMs: 0, maxDurationMs: TOTAL },
            at + 3_000
        )
    )
    const wallMs = Date.now() - at
    assert.ok(err instanceof TurnBudgetExceededError)
    assert.equal(err.kind, 'total')
    assert.ok(
        wallMs < 1_500,
        `a future origin must still cap at one budget (took ${wallMs}ms)`
    )
    assert.ok(
        err.elapsedMs >= TOTAL - 10,
        `elapsed ${err.elapsedMs}ms must use the capped local origin, not report negative time`
    )
})

test('an unreadable durable origin falls back to a fresh budget, not a 1ms one', async () => {
    // createdAt.getTime() on an unreadable row is NaN, and node reads a NaN
    // setTimeout delay the same way it reads an overflowing one: 1ms. An
    // unknown origin has to mean "starts here", never "already over".
    const stop = keepLoopAlive()
    try {
        const run = drain(
            withTurnBudgets(
                parkAfterOneToken(),
                { idleTimeoutMs: 0, maxDurationMs: 60_000 },
                new Date('nonsense').getTime()
            )
        )
        run.catch(() => undefined)
        assert.equal(
            (await settledWithin(run, 600)).settled,
            false,
            'a NaN origin must not collapse the total budget into a 1ms timer'
        )
    } finally {
        stop()
    }
})

test('a durable origin never touches the idle budget or the off switch', async () => {
    const stop = keepLoopAlive()
    try {
        const ancient = Date.now() - 10 * 60_000
        // Total disabled: an origin far past any budget must not manufacture a
        // deadline where the operator turned one off.
        const err = await budgetErrorOf(
            withTurnBudgets(
                parkAfterOneToken(),
                { idleTimeoutMs: 200, maxDurationMs: 0 },
                ancient
            )
        )
        assert.ok(err instanceof TurnBudgetExceededError)
        assert.equal(
            err.kind,
            'idle',
            'with the total budget off, only silence can end a continuation'
        )
        // Idle measures the silence of THIS transport, which has said nothing
        // yet — inheriting the origin would kill every continuation instantly.
        assert.ok(err.elapsedMs < 60_000)

        const both = drain(
            withTurnBudgets(
                parkAfterOneToken(),
                { idleTimeoutMs: 0, maxDurationMs: 0 },
                ancient
            )
        )
        both.catch(() => undefined)
        assert.equal(
            (await settledWithin(both, 400)).settled,
            false,
            'both budgets at 0 stay off no matter how old the turn is'
        )
    } finally {
        stop()
    }
})

// #668 second finding. Node keeps a timer delay in a signed 32-bit int, so
// setTimeout(fn, 2**31) silently becomes a 1ms timer: an operator widening the
// watchdog would get every turn killed at once. Asserted as behaviour, not by
// watching for node's TimeoutOverflowWarning — a warning on stderr is not a
// contract, and it says nothing about which budget overflowed.
test('an idle budget above the timer ceiling does not collapse into a 1ms timeout', async () => {
    const stop = keepLoopAlive()
    try {
        const run = drain(
            withTurnBudgets(parkAfterOneToken(), {
                idleTimeoutMs: MAX_TIMER_DELAY_MS + 1,
                maxDurationMs: 0
            })
        )
        run.catch(() => undefined)
        assert.equal(
            (await settledWithin(run, 600)).settled,
            false,
            'an over-ceiling idle budget must stay armed, not fire at 1ms'
        )
    } finally {
        stop()
    }
})

test('a max-duration budget above the timer ceiling does not collapse into a 1ms timeout', async () => {
    const stop = keepLoopAlive()
    try {
        const run = drain(
            withTurnBudgets(parkAfterOneToken(), {
                idleTimeoutMs: 0,
                maxDurationMs: MAX_TIMER_DELAY_MS + 1
            })
        )
        run.catch(() => undefined)
        assert.equal(
            (await settledWithin(run, 600)).settled,
            false,
            'an over-ceiling total budget must stay armed, not fire at 1ms'
        )
    } finally {
        stop()
    }
})

test('invalid injected budgets never become 1ms timers', async () => {
    const stop = keepLoopAlive()
    try {
        const runs = [
            drain(
                withTurnBudgets(parkAfterOneToken(), {
                    idleTimeoutMs: Number.NaN,
                    maxDurationMs: 0
                })
            ),
            drain(
                withTurnBudgets(parkAfterOneToken(), {
                    idleTimeoutMs: -1,
                    maxDurationMs: 0
                })
            ),
            drain(
                withTurnBudgets(parkAfterOneToken(), {
                    idleTimeoutMs: 0,
                    maxDurationMs: Number.NaN
                })
            )
        ]
        for (const run of runs) run.catch(() => undefined)
        assert.equal(
            (await settledWithin(Promise.race(runs), 300)).settled,
            false,
            'invalid direct inputs must fail open, never truncate a turn at 1ms'
        )
    } finally {
        stop()
    }
})

test('an injected over-ceiling budget reports the effective ceiling', async () => {
    const configured = MAX_TIMER_DELAY_MS + 1
    const err = await budgetErrorOf(
        withTurnBudgets(
            parkAfterOneToken(),
            { idleTimeoutMs: 0, maxDurationMs: configured },
            Date.now() - configured
        )
    )
    assert.ok(err instanceof TurnBudgetExceededError)
    assert.equal(err.kind, 'total')
    assert.equal(err.budgetMs, MAX_TIMER_DELAY_MS)
})

// Inverse control for the disable switch: if `0` did not mean "off", this same
// parked iterator would have terminalized like the first test's did.
test('both budgets at 0 pass a parked iterator straight through', async () => {
    const stop = keepLoopAlive()
    try {
        const run = drain(
            withTurnBudgets(parkAfterOneToken(), {
                idleTimeoutMs: 0,
                maxDurationMs: 0
            })
        )
        run.catch(() => undefined)
        const outcome = await settledWithin(run, 600)
        assert.equal(
            outcome.settled,
            false,
            'a disabled watchdog must not terminalize a parked turn'
        )
    } finally {
        stop()
    }
})

test('a breach does not wait on the parked source return(), which would hang', async () => {
    // The source's cleanup itself parks. A wrapper that awaited return() would
    // hang the caller forever — the exact failure the watchdog exists to end.
    async function* unreturnable(): AsyncIterable<EmittedChatEvent> {
        try {
            yield token('hi')
            await new Promise<void>(() => {})
        } finally {
            await new Promise<void>(() => {})
        }
    }
    const stop = keepLoopAlive()
    try {
        const run = drain(
            withTurnBudgets(unreturnable(), {
                idleTimeoutMs: 100,
                maxDurationMs: 0
            })
        ).then(
            () => 'resolved',
            (e: unknown) =>
                e instanceof TurnBudgetExceededError ? 'budget' : 'other'
        )
        const outcome = await settledWithin(run, BOUND_MS)
        assert.ok(outcome.settled, 'the breach must not be blocked by return()')
        assert.equal(await run, 'budget')
    } finally {
        stop()
    }
})

test('a consumer break still tears the source down (the suspended path)', async () => {
    let cleaned = false
    const budgeted = withTurnBudgets(
        trickle(10, 5, () => {
            cleaned = true
        }),
        { idleTimeoutMs: 500, maxDurationMs: 0 }
    )
    for await (const _event of budgeted) break
    assert.ok(
        cleaned,
        'breaking out must propagate return() to the adapter generator'
    )
})

test('a normal end runs the source cleanup and clears the timers', async () => {
    let cleaned = false
    const seen = await drain(
        withTurnBudgets(
            trickle(3, 5, () => {
                cleaned = true
            }),
            { idleTimeoutMs: 300, maxDurationMs: 5_000 }
        )
    )
    assert.equal(seen.length, 3)
    assert.ok(cleaned)
    // If either timer had survived the exit it would fire here and, being the
    // only thing left, would show up as a stray unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 350))
})

test('budget errors map to retryable terminals that name the kind', () => {
    const idle = turnBudgetErrorEvent(
        new TurnBudgetExceededError('idle', 1_800_000, 1_800_000)
    )
    assert.equal(idle.error.code, 'turn_idle_timeout')
    assert.equal(idle.error.retryable, true)
    assert.match(idle.error.message, /1800s/)
    assert.notEqual(idle.error.code, 'cancelled_by_user')

    const total = turnBudgetErrorEvent(
        new TurnBudgetExceededError('total', 7_200_000, 7_200_000)
    )
    assert.equal(total.error.code, 'turn_max_duration')
    assert.equal(total.error.retryable, true)
    assert.match(total.error.message, /7200s/)
})

test('unset env yields the shipped defaults', async () => {
    await withEnv(
        {
            MF_TURN_IDLE_TIMEOUT_MS: undefined,
            MF_TURN_MAX_DURATION_MS: undefined
        },
        () => {
            assert.deepEqual(resolveTurnBudgets(), {
                idleTimeoutMs: DEFAULT_TURN_IDLE_TIMEOUT_MS,
                maxDurationMs: DEFAULT_TURN_MAX_DURATION_MS
            })
            assert.equal(DEFAULT_TURN_IDLE_TIMEOUT_MS, 30 * 60_000)
            assert.equal(DEFAULT_TURN_MAX_DURATION_MS, 2 * 60 * 60_000)
        }
    )
})

// The floor's whole job: a sub-floor value must come back RAISED, never
// honoured. A watchdog that can be set to half a second is a truncator.
test('a sub-floor env value clamps UP to the floor, on both budgets', async () => {
    await withEnv(
        {
            MF_TURN_IDLE_TIMEOUT_MS: '500',
            MF_TURN_MAX_DURATION_MS: '1'
        },
        () => {
            const budgets = resolveTurnBudgets()
            assert.equal(budgets.idleTimeoutMs, TURN_BUDGET_FLOOR_MS)
            assert.equal(budgets.maxDurationMs, TURN_BUDGET_FLOOR_MS)
            assert.ok(budgets.idleTimeoutMs > 500)
            assert.ok(budgets.maxDurationMs > 1)
        }
    )
})

test('an above-floor env value is honoured exactly, not overridden', async () => {
    await withEnv(
        {
            MF_TURN_IDLE_TIMEOUT_MS: '90000',
            MF_TURN_MAX_DURATION_MS: '600000'
        },
        () => {
            assert.deepEqual(resolveTurnBudgets(), {
                idleTimeoutMs: 90_000,
                maxDurationMs: 600_000
            })
        }
    )
})

// The exact env values an operator would use to say "basically never time this
// out". Above node's ceiling they used to reach setTimeout intact and come back
// as a 1ms timer, i.e. the opposite instruction.
test('an env value above the node timer ceiling clamps DOWN, on both budgets', async () => {
    assert.equal(MAX_TIMER_DELAY_MS, 2 ** 31 - 1)
    await withEnv(
        {
            // 2^31, one past the ceiling, and ~347 days.
            MF_TURN_IDLE_TIMEOUT_MS: '2147483648',
            MF_TURN_MAX_DURATION_MS: '30000000000'
        },
        () => {
            const budgets = resolveTurnBudgets()
            assert.equal(budgets.idleTimeoutMs, MAX_TIMER_DELAY_MS)
            assert.equal(budgets.maxDurationMs, MAX_TIMER_DELAY_MS)
            // The failure this replaces: a 1ms budget would satisfy any
            // "is it a number" assertion, so pin the direction too.
            assert.ok(budgets.idleTimeoutMs > TURN_BUDGET_FLOOR_MS)
            assert.ok(budgets.maxDurationMs > TURN_BUDGET_FLOOR_MS)
        }
    )
})

test('the ceiling value itself is honoured exactly', async () => {
    await withEnv(
        {
            MF_TURN_IDLE_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS),
            MF_TURN_MAX_DURATION_MS: String(MAX_TIMER_DELAY_MS)
        },
        () => {
            assert.deepEqual(resolveTurnBudgets(), {
                idleTimeoutMs: MAX_TIMER_DELAY_MS,
                maxDurationMs: MAX_TIMER_DELAY_MS
            })
        }
    )
})

test('0 disables a budget and is never clamped up to the floor', async () => {
    await withEnv(
        { MF_TURN_IDLE_TIMEOUT_MS: '0', MF_TURN_MAX_DURATION_MS: '0' },
        () => {
            assert.deepEqual(resolveTurnBudgets(), {
                idleTimeoutMs: 0,
                maxDurationMs: 0
            })
        }
    )
    // One budget off must not disturb the other.
    await withEnv(
        {
            MF_TURN_IDLE_TIMEOUT_MS: '0',
            MF_TURN_MAX_DURATION_MS: undefined
        },
        () => {
            const budgets = resolveTurnBudgets()
            assert.equal(budgets.idleTimeoutMs, 0)
            assert.equal(budgets.maxDurationMs, DEFAULT_TURN_MAX_DURATION_MS)
        }
    )
})

test('unparseable or negative env values fall back to the defaults', async () => {
    await withEnv(
        {
            MF_TURN_IDLE_TIMEOUT_MS: 'soon',
            MF_TURN_MAX_DURATION_MS: '-1'
        },
        () => {
            assert.deepEqual(resolveTurnBudgets(), {
                idleTimeoutMs: DEFAULT_TURN_IDLE_TIMEOUT_MS,
                maxDurationMs: DEFAULT_TURN_MAX_DURATION_MS
            })
        }
    )
})

test('resolveTurnBudgets reads env per call, so an operator flip takes effect', async () => {
    await withEnv({ MF_TURN_IDLE_TIMEOUT_MS: '120000' }, () => {
        assert.equal(resolveTurnBudgets().idleTimeoutMs, 120_000)
        process.env.MF_TURN_IDLE_TIMEOUT_MS = '300000'
        assert.equal(resolveTurnBudgets().idleTimeoutMs, 300_000)
    })
})
