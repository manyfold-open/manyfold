import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import {
    ChatService,
    InflightTurnConflictError
} from '../src/modules/chat/chat.service'
import type { TurnBudgets } from '../src/modules/chat/turn-budgets'

// A turn's slot — its place in activeTurnCount() — is the only thing that
// says how much work this instance is carrying. Shutdown drain waits on it,
// and any future per-instance limit would be set from it, so the two ways it
// can lie are what these cover: a slot that is never given back (the instance
// reads as permanently busy and the drain never finishes), and two live
// executions sharing one entry (the instance reads as idle with work still
// running).

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null
}

const BOUND_MS = 4_000
const IDLE_MS = 150

const keepLoopAlive = (): (() => void) => {
    const timer = setInterval(() => {}, 1_000)
    return () => clearInterval(timer)
}

const until = async (
    predicate: () => boolean,
    ms = BOUND_MS
): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (predicate()) return true
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return predicate()
}

// The gauge carries two dispatch/recovery splits and they are not the same
// measurement: the bare pair is the composition of `inflight` at the tick,
// the `peak`-prefixed pair is the composition of `peakInflight` at the
// instant that peak was set. Asserted together everywhere below, because
// reading one as the other is the whole defect.
const attribution = (
    gauge: Record<string, number>
): Record<string, number> => ({
    inflight: gauge.inflight,
    dispatchInflight: gauge.dispatchInflight,
    recoveryInflight: gauge.recoveryInflight,
    peakInflight: gauge.peakInflight,
    peakDispatchInflight: gauge.peakDispatchInflight,
    peakRecoveryInflight: gauge.peakRecoveryInflight
})

// Every terminal and non-terminal exit funnels through the same runAdapter
// .finally today, which is exactly why each is walked separately: that shared
// funnel is a fact about the current code, and the invariant has to outlive
// it.
const exitPaths: Array<{
    name: string
    finish: (h: Harness) => void
    budgets?: TurnBudgets
}> = [
    { name: 'finishes', finish: (h) => h.release('a', 'done') },
    { name: 'errors', finish: (h) => h.release('a', 'error') },
    { name: 'is cancelled', finish: (h) => h.cancel('a') },
    { name: 'suspends', finish: (h) => h.release('a', 'suspend') },
    {
        name: 'is killed by the watchdog',
        finish: (h) => h.release('a', 'park'),
        budgets: { idleTimeoutMs: IDLE_MS, maxDurationMs: 0 }
    }
]

for (const path of exitPaths)
    test(`a turn that ${path.name} gives its slot back`, async () => {
        const stop = keepLoopAlive()
        const h = makeHarness({ budgets: path.budgets })
        try {
            await h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi')
            await h.started('session-a')
            assert.equal(h.service.activeTurnCount(), 1)

            path.finish(h)

            assert.ok(
                await until(() => h.service.activeTurnCount() === 0),
                `the slot must come back within ${BOUND_MS}ms`
            )
            assert.deepEqual(
                h.concurrencyEvents().map((e) => e.event),
                ['enter', 'exit'],
                'exactly one enter and one exit per execution'
            )
        } finally {
            h.releaseAll('done')
            stop()
        }
    })

// pendingTurnIds and runningAdapters overlap for a moment on the SAME message
// id: startAssistantTurn registers the adapter while sendMessage still holds
// the pending mark. Summing them counts that turn twice, which reads as load
// the instance is not carrying.
test('a turn in the setup/running overlap counts once, not twice', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        h.internals.beginPendingTurn('msg-overlap')
        h.internals.trackRunningAdapter(
            'msg-overlap',
            new AbortController(),
            'adoption'
        )

        assert.equal(h.service.activeTurnCount(), 1)
        assert.deepEqual(
            h.concurrencyEvents().map((e) => e.event),
            ['enter'],
            'one slot changing hands, not two'
        )
        h.internals.emitConcurrencyGauge()
        assert.deepEqual(
            attribution(h.gauges()[0]),
            {
                inflight: 1,
                dispatchInflight: 1,
                recoveryInflight: 0,
                peakInflight: 1,
                peakDispatchInflight: 1,
                peakRecoveryInflight: 0
            },
            'the running handoff cannot overwrite the pending slot origin'
        )
    } finally {
        stop()
    }
})

// Observability must never be able to strand a slot. The emit sits either
// side of the mutations that own the count, and the reservation happens
// outside any try the caller owns, so a throw here used to leave the id in
// pendingTurnIds with nothing left to clear it — a permanent +1 on every
// future reading.
test('a throwing telemetry sink cannot leak a slot', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness({ throwOnConcurrencyEvent: true })
    try {
        const sent = await h.service.sendMessage(
            'user-1',
            'agent-1',
            'session-a',
            'hi'
        )
        assert.ok(sent.assistantMessageId)
        await h.started('session-a')
        h.release('a', 'done')

        assert.ok(
            await until(() => h.service.activeTurnCount() === 0),
            'the count must still return to zero'
        )
    } finally {
        h.releaseAll('done')
        stop()
    }
})

// runAdapter's arguments are evaluated AFTER the adapter is registered and
// BEFORE the promise carrying the untracking finally exists. toApiMessage()
// throwing in that window (here: a row whose createdAt is not a Date) left
// the entry behind forever — and a leaked runningAdapters entry is worse than
// a leaked pending mark, because nothing anywhere ever deletes it.
test('a throw between registering and running gives the slot back', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness({ corruptUserMessageRow: true })
    try {
        await assert.rejects(
            h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi'),
            /reading 'toISOString'/
        )

        assert.equal(
            h.service.activeTurnCount(),
            0,
            'a turn that never started must not hold a slot'
        )
        assert.equal(
            await h.latestInflight('session-a'),
            null,
            'and its session claim is released'
        )
    } finally {
        stop()
    }
})

// Pre-existing, and the reason the count could not be trusted: adoption reads
// the map, awaits two DB reads, and only then registers — and a daemon resume
// checks AND registers inside that gap. Adoption used to overwrite the live
// resume, then terminalize a turn the resume was still streaming.
test('adoption defers to a resume that registered during its DB reads', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const adopting = h.service.adoptTurnExecution({
            messageId: 'msg-contended',
            sessionId: 'session-contended',
            agentId: 'agent-1',
            runtime: 'sprites',
            adoptCount: 1,
            execSessionId: null,
            spriteName: null,
            upstreamTaskId: null,
            upstreamMessageId: null,
            ownerId: 'owner-0',
            generation: 1
        } as never)
        await h.messageReadStarted

        const resuming = h.service.resumeAssistantTurn({
            message: {
                id: 'msg-contended',
                sessionId: 'session-contended',
                createdAt: new Date(),
                daemonId: 'daemon-1',
                daemonExecRef: 'ref-1'
            } as never,
            daemonId: 'daemon-1',
            refId: 'ref-1'
        })
        assert.equal(h.service.activeTurnCount(), 1, 'the resume owns the slot')

        h.releaseMessageRead()
        await adopting

        assert.equal(
            h.terminalsFor('msg-contended'),
            0,
            'adoption must not terminalize a turn another execution is streaming'
        )
        assert.equal(
            h.service.activeTurnCount(),
            1,
            'and must not release the live execution slot'
        )

        h.release('contended', 'done')
        await resuming
        assert.equal(h.service.activeTurnCount(), 0)
        assert.deepEqual(
            h.concurrencyEvents().map((e) => `${e.event}:${e.origin}`),
            ['enter:resume', 'exit:resume'],
            'one execution, attributed to the one that actually ran'
        )
    } finally {
        h.releaseAll('done')
        stop()
    }
})

test('only the execution that took a slot can give it back', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const winner = new AbortController()
        const loser = new AbortController()
        assert.equal(
            h.internals.trackRunningAdapter('msg-x', winner, 'resume'),
            true
        )
        assert.equal(
            h.internals.trackRunningAdapter('msg-x', loser, 'adoption'),
            false,
            'registration is a check-and-set'
        )

        h.internals.untrackRunningAdapter('msg-x', loser)

        assert.equal(
            h.service.activeTurnCount(),
            1,
            'a loser deregistering must not evict the live execution'
        )
        h.internals.untrackRunningAdapter('msg-x', winner)
        assert.equal(h.service.activeTurnCount(), 0)
    } finally {
        stop()
    }
})

// A second execution under one assistant message id would interleave two
// transports into one stream. The session CAS makes it unreachable today, so
// the check-and-set is the assertion that it stays unreachable.
test('dispatch refuses to start a second execution for one message', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        h.internals.trackRunningAdapter('msg-taken', new AbortController())

        await assert.rejects(
            h.service.sendMessage(
                'user-1',
                'agent-1',
                'session-a',
                'hi',
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                [],
                {
                    assistantMessageId: 'msg-taken'
                }
            ),
            InflightTurnConflictError
        )
        assert.equal(h.service.activeTurnCount(), 1, 'still just the first')
        assert.equal(await h.latestInflight('session-a'), null)
    } finally {
        stop()
    }
})

// The session CAS now runs inside the try that releases the claim on failure,
// so a turn that loses the race reaches a releaseInflightTurn naming the id
// it never got. That is only safe because the release is itself a
// compare-and-set on inflight_message_id, proven against real Postgres in
// chat-inflight-claim.pg.test.ts ("a non-matching release is a no-op").
test('a turn that loses the session CAS does not release the winner claim', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const first = await h.service.sendMessage(
            'user-1',
            'agent-1',
            'session-a',
            'hi'
        )
        await assert.rejects(
            h.service.sendMessage('user-1', 'agent-1', 'session-a', 'again'),
            InflightTurnConflictError
        )

        assert.equal(
            await h.latestInflight('session-a'),
            first.assistantMessageId
        )
        assert.equal(h.service.activeTurnCount(), 1)
    } finally {
        h.releaseAll('done')
        stop()
    }
})

// Dispatch-only sampling cannot produce a number anyone could set a limit
// from: recovery registers turns without going near a dispatch path, so a
// deploy — the exact burst a limit would exist to survive — would be
// invisible in the series.
test('recovery moves the gauge, and says it was recovery', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        h.release('resumed', 'done')
        await h.service.resumeAssistantTurn({
            message: {
                id: 'msg-resumed',
                sessionId: 'session-resumed',
                createdAt: new Date(),
                daemonId: 'daemon-1',
                daemonExecRef: 'ref-1'
            } as never,
            daemonId: 'daemon-1',
            refId: 'ref-1'
        })

        assert.deepEqual(
            h.concurrencyEvents().map((e) => `${e.event}:${e.origin}`),
            ['enter:resume', 'exit:resume']
        )
    } finally {
        stop()
    }
})

// The recheck the daemon service arms after a decline (#648) exists only
// because the decline is reported here. Declining silently is what let a turn
// whose hello arrived mid-fence hang until the next reconnect: the holder can
// end WITHOUT settling the turn, and by then the hello is gone.
test('a resume declined by a live execution reports the decline', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const fence = new AbortController()
        h.internals.trackRunningAdapter('msg-fenced', fence, 'dispatch')

        const outcome = await h.service.resumeAssistantTurn({
            message: {
                id: 'msg-fenced',
                sessionId: 'session-fenced',
                createdAt: new Date(),
                daemonId: 'daemon-1',
                daemonExecRef: 'ref-1'
            } as never,
            daemonId: 'daemon-1',
            refId: 'ref-1'
        })

        assert.equal(outcome, 'skipped_running_locally')
        assert.equal(
            h.service.activeTurnCount(),
            1,
            'and the holder keeps its slot'
        )
        assert.equal(fence.signal.aborted, false)
    } finally {
        stop()
    }
})

test('the gauge carries the peak, the split and the load at that level', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        h.internals.emitConcurrencyGauge()
        assert.equal(h.gauges().length, 0, 'an idle instance says nothing')

        await h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi')
        h.internals.trackRunningAdapter(
            'msg-recovered',
            new AbortController(),
            'adoption'
        )
        h.internals.emitConcurrencyGauge()

        const gauge = h.gauges()[0]
        assert.equal(gauge.inflight, 2)
        assert.equal(gauge.peakInflight, 2)
        assert.equal(gauge.dispatchInflight, 1)
        assert.equal(gauge.recoveryInflight, 1)
        // Nothing exited between the peak and the tick, so the two splits
        // agree here — the only case in which they do.
        assert.equal(gauge.peakDispatchInflight, 1)
        assert.equal(gauge.peakRecoveryInflight, 1)
        assert.equal(typeof gauge.eventLoopUtilization, 'number')
        assert.ok(
            gauge.eventLoopUtilization >= 0 && gauge.eventLoopUtilization <= 1,
            'utilization is a fraction of the interval'
        )
        assert.ok(gauge.rssMb > 0)
        assert.ok(gauge.heapUsedMb > 0)
    } finally {
        h.releaseAll('done')
        stop()
    }
})

// A spike shorter than the tick is the one a limit would have to survive, so
// the peak between ticks is what makes the series trustworthy.
test('a spike between ticks still lands, then the series goes quiet', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        await h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi')
        h.release('a', 'done')
        assert.ok(await until(() => h.service.activeTurnCount() === 0))

        h.internals.emitConcurrencyGauge()
        assert.deepEqual(
            h.gauges().map(attribution),
            [
                {
                    inflight: 0,
                    dispatchInflight: 0,
                    recoveryInflight: 0,
                    peakInflight: 1,
                    peakDispatchInflight: 1,
                    peakRecoveryInflight: 0
                }
            ],
            'the closing sample reports the peak it saw, and that it was traffic'
        )

        h.internals.emitConcurrencyGauge()
        assert.equal(h.gauges().length, 1, 'then an idle instance goes quiet')
    } finally {
        stop()
    }
})

// The other half of the same claim, and the one an operator acts on
// differently: an instance filling up after a deploy drains nothing at the
// tick either, so a closing sample that cannot name recovery reads exactly
// like the traffic spike above.
test('a recovery-only spike between ticks says it was recovery', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const controller = new AbortController()
        h.internals.trackRunningAdapter('msg-resumed', controller, 'resume')
        h.internals.untrackRunningAdapter('msg-resumed', controller)
        assert.equal(h.service.activeTurnCount(), 0)

        h.internals.emitConcurrencyGauge()

        assert.deepEqual(
            h.gauges().map(attribution),
            [
                {
                    inflight: 0,
                    dispatchInflight: 0,
                    recoveryInflight: 0,
                    peakInflight: 1,
                    peakDispatchInflight: 0,
                    peakRecoveryInflight: 1
                }
            ],
            'the same shape as a dispatch spike, told apart by the peak split'
        )
    } finally {
        stop()
    }
})

// The witness on the issue: a five-turn peak of three dispatch and two
// recovery, drained to a single dispatch turn before the tick, reported
// peakInflight=5 next to dispatchInflight=1 and recoveryInflight=0. The size
// of the burst survived the window and everything about its source did not.
test('a mixed burst attributes the peak to the peak, not to the survivors', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const burst = (
            [
                ['msg-d1', 'dispatch'],
                ['msg-d2', 'dispatch'],
                ['msg-d3', 'dispatch'],
                ['msg-r1', 'resume'],
                ['msg-r2', 'adoption']
            ] as const
        ).map(([id, origin]) => ({
            id,
            origin,
            controller: new AbortController()
        }))
        for (const slot of burst)
            h.internals.trackRunningAdapter(
                slot.id,
                slot.controller,
                slot.origin
            )
        assert.equal(h.service.activeTurnCount(), 5)
        for (const slot of burst.slice(1))
            h.internals.untrackRunningAdapter(slot.id, slot.controller)
        assert.equal(h.service.activeTurnCount(), 1)

        h.internals.emitConcurrencyGauge()

        const gauge = h.gauges()[0]
        assert.deepEqual(attribution(gauge), {
            inflight: 1,
            dispatchInflight: 1,
            recoveryInflight: 0,
            peakInflight: 5,
            peakDispatchInflight: 3,
            peakRecoveryInflight: 2
        })
        assert.equal(
            gauge.peakDispatchInflight + gauge.peakRecoveryInflight,
            gauge.peakInflight,
            'one instant of the window, so the split adds up to the level'
        )
    } finally {
        stop()
    }
})

// A window can stand at its maximum more than once with different turns
// holding it, so the tie has to break deterministically. Strictly-greater
// wins: the first instant that reached the level keeps it, including the one
// the reset seeds the window with.
test('an equal peak keeps the composition of the first instant that reached it', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const stays = new AbortController()
        const leaves = new AbortController()
        const late = new AbortController()
        h.internals.trackRunningAdapter('msg-d1', stays, 'dispatch')
        h.internals.trackRunningAdapter('msg-d2', leaves, 'dispatch')
        h.internals.untrackRunningAdapter('msg-d2', leaves)
        h.internals.trackRunningAdapter('msg-r1', late, 'resume')

        h.internals.emitConcurrencyGauge()

        assert.deepEqual(
            attribution(h.gauges()[0]),
            {
                inflight: 2,
                dispatchInflight: 1,
                recoveryInflight: 1,
                peakInflight: 2,
                peakDispatchInflight: 2,
                peakRecoveryInflight: 0
            },
            'both splits are true of the same tick, of two different instants'
        )
    } finally {
        stop()
    }
})

// The reset itself seeds the next window with a real first instant. Reaching
// that same level later with a different composition must not overwrite the
// seed; otherwise the tie rule would change at every gauge boundary.
test('a reset-seeded peak wins a later equal-level tie', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const stays = new AbortController()
        const leaves = new AbortController()
        const late = new AbortController()
        h.internals.trackRunningAdapter('msg-d1', stays, 'dispatch')
        h.internals.trackRunningAdapter('msg-d2', leaves, 'dispatch')

        h.internals.emitConcurrencyGauge()
        h.internals.untrackRunningAdapter('msg-d2', leaves)
        h.internals.trackRunningAdapter('msg-r1', late, 'resume')
        h.internals.emitConcurrencyGauge()

        assert.deepEqual(attribution(h.gauges()[1]), {
            inflight: 2,
            dispatchInflight: 1,
            recoveryInflight: 1,
            peakInflight: 2,
            peakDispatchInflight: 2,
            peakRecoveryInflight: 0
        })
    } finally {
        stop()
    }
})

// A window that reset its number but kept the last window's composition would
// describe two windows at once, and the error is invisible: the fields still
// look like a plausible split of a plausible peak.
test('the peak and its composition reset together, onto the slots still held', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const leaving = new AbortController()
        const staying = new AbortController()
        h.internals.trackRunningAdapter('msg-d1', leaving, 'dispatch')
        h.internals.trackRunningAdapter('msg-r1', staying, 'adoption')
        h.internals.untrackRunningAdapter('msg-d1', leaving)

        h.internals.emitConcurrencyGauge()
        h.internals.emitConcurrencyGauge()
        h.internals.untrackRunningAdapter('msg-r1', staying)
        h.internals.emitConcurrencyGauge()
        h.internals.emitConcurrencyGauge()

        assert.deepEqual(
            h.gauges().map(attribution),
            [
                {
                    inflight: 1,
                    dispatchInflight: 0,
                    recoveryInflight: 1,
                    peakInflight: 2,
                    peakDispatchInflight: 1,
                    peakRecoveryInflight: 1
                },
                {
                    inflight: 1,
                    dispatchInflight: 0,
                    recoveryInflight: 1,
                    peakInflight: 1,
                    peakDispatchInflight: 0,
                    peakRecoveryInflight: 1
                },
                {
                    inflight: 0,
                    dispatchInflight: 0,
                    recoveryInflight: 0,
                    peakInflight: 1,
                    peakDispatchInflight: 0,
                    peakRecoveryInflight: 1
                }
            ],
            'the window after a peak opens on what is held, not on what was'
        )
        assert.deepEqual(
            [
                h.internals.peakInflightSinceGauge,
                h.internals.peakDispatchInflightSinceGauge,
                h.internals.peakRecoveryInflightSinceGauge
            ],
            [0, 0, 0],
            'and the closing sample leaves nothing behind for the next one'
        )
    } finally {
        stop()
    }
})

// The gauge runs from a setInterval callback, where an escaping throw takes
// the process down — and would also skip the peak reset, pinning the series
// at a stale high water mark. Same defect the enter/exit emit already had.
test('a throwing sink cannot kill the gauge tick or pin the peak', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness({ throwOnGaugeEvent: true })
    try {
        await h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi')
        h.release('a', 'done')
        assert.ok(await until(() => h.service.activeTurnCount() === 0))

        // A slot still held when the sink throws, taken by recovery while the
        // window's peak was dispatch: the reset has to land on that slot AND
        // on its origin, not merely zero the number.
        const held = new AbortController()
        h.internals.trackRunningAdapter('msg-recovered', held, 'adoption')

        assert.doesNotThrow(() => h.internals.emitConcurrencyGauge())
        assert.deepEqual(
            [
                h.internals.peakInflightSinceGauge,
                h.internals.peakDispatchInflightSinceGauge,
                h.internals.peakRecoveryInflightSinceGauge
            ],
            [1, 0, 1],
            'the peak and its composition reset even when the emit throws'
        )
    } finally {
        stop()
    }
})

// Sampling precedes both the idle decision and the telemetry emit. It can
// therefore fail before either branch, but the finally must still open the
// next window on the slots held now and their current composition.
test('a throwing load sampler cannot pin peak attribution', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        const dispatch = new AbortController()
        const recovery = new AbortController()
        h.internals.trackRunningAdapter('msg-dispatch', dispatch, 'dispatch')
        h.internals.untrackRunningAdapter('msg-dispatch', dispatch)
        h.internals.trackRunningAdapter('msg-recovery', recovery, 'adoption')
        h.throwLoadSampler()

        assert.doesNotThrow(() => h.internals.emitConcurrencyGauge())
        assert.equal(h.gauges().length, 0, 'sampling failed before the emit')
        assert.deepEqual(
            [
                h.internals.peakInflightSinceGauge,
                h.internals.peakDispatchInflightSinceGauge,
                h.internals.peakRecoveryInflightSinceGauge
            ],
            [1, 0, 1],
            'the failed attempt still resets onto the live recovery slot'
        )
    } finally {
        stop()
    }
})

// Both loop signals are windowed, so a skipped tick folds that stretch into
// the next reported window. Idle ticks stay silent but must still advance the
// sampler, or the first sample after any quiet period understates the load.
test('an idle tick samples the window even though it emits nothing', () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        h.stubLoadSampler()

        h.internals.emitConcurrencyGauge()

        assert.equal(h.gauges().length, 0, 'silent while idle')
        assert.equal(h.loadSampleCount(), 1, 'but the window still advanced')
    } finally {
        stop()
    }
})

// A turn that starts and finishes between two ticks, followed by teardown, is
// a saturation episode with no sample anywhere unless teardown flushes.
test('teardown flushes a gauge the ticks never got to', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        await h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi')
        h.release('a', 'done')
        assert.ok(await until(() => h.service.activeTurnCount() === 0))
        assert.equal(h.gauges().length, 0, 'no tick has fired yet')

        await h.service.onModuleDestroy()

        assert.deepEqual(
            h.gauges().map(attribution),
            [
                {
                    inflight: 0,
                    dispatchInflight: 0,
                    recoveryInflight: 0,
                    peakInflight: 1,
                    peakDispatchInflight: 1,
                    peakRecoveryInflight: 0
                }
            ],
            'the episode is reported instead of being lost, source included'
        )
        assert.deepEqual(
            [
                h.internals.peakInflightSinceGauge,
                h.internals.peakDispatchInflightSinceGauge,
                h.internals.peakRecoveryInflightSinceGauge
            ],
            [0, 0, 0],
            'the flush resets like any other gauge attempt'
        )
    } finally {
        stop()
    }
})

// The claim that decides whether this series is worth anything. Utilization
// is a duty cycle, so a single synchronous stall reads as a low percentage
// while every request behind it missed its deadline; delay is what sees it.
test('a synchronous stall shows up as event-loop delay', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness()
    try {
        await h.service.sendMessage('user-1', 'agent-1', 'session-a', 'hi')
        // Let the histogram collect a baseline, then block the loop outright.
        await new Promise((resolve) => setTimeout(resolve, 60))
        const blockUntil = Date.now() + 200
        while (Date.now() < blockUntil) {
            /* deliberately blocking the loop */
        }
        // The monitor records the stall when its own timer finally gets to
        // run, so the loop has to turn over before the histogram is read. In
        // production that is free: the gauge IS a timer callback, so the loop
        // has necessarily resumed before it fires.
        await new Promise((resolve) => setTimeout(resolve, 30))

        h.internals.emitConcurrencyGauge()

        const gauge = h.gauges()[0]
        assert.ok(
            gauge.eventLoopDelayMaxMs >= 100,
            `a 200ms stall must be visible; got ${gauge.eventLoopDelayMaxMs}ms`
        )
        assert.equal(typeof gauge.eventLoopDelayP99Ms, 'number')
        assert.ok(gauge.eventLoopDelayP99Ms >= 0)
    } finally {
        h.releaseAll('done')
        stop()
    }
})

interface TelemetryEvent {
    name: string
    props: Record<string, unknown>
}

type Finish = 'done' | 'error' | 'suspend' | 'park'

interface TurnControl {
    started: Promise<void>
    startedResolve: () => void
    finish: Promise<Finish>
    release: (finish: Finish) => void
}

interface Harness {
    service: ChatService
    telemetry: TelemetryEvent[]
    concurrencyEvents: () => Array<{ event: string; origin: string }>
    gauges: () => Array<Record<string, number>>
    terminalsFor: (messageId: string) => number
    latestInflight: (sessionId: string) => Promise<string | null>
    started: (sessionId: string) => Promise<void>
    messageReadStarted: Promise<void>
    releaseMessageRead: () => void
    release: (suffix: string, finish: Finish) => void
    releaseAll: (finish: Finish) => void
    cancel: (suffix: string) => void
    internals: {
        beginPendingTurn: (assistantMessageId: string) => void
        trackRunningAdapter: (
            messageId: string,
            controller: AbortController,
            origin?: 'dispatch' | 'resume' | 'adoption'
        ) => boolean
        untrackRunningAdapter: (
            messageId: string,
            controller: AbortController
        ) => void
        emitConcurrencyGauge: () => void
        peakInflightSinceGauge: number
        peakDispatchInflightSinceGauge: number
        peakRecoveryInflightSinceGauge: number
    }
    stubLoadSampler: () => void
    throwLoadSampler: () => void
    loadSampleCount: () => number
}

const makeHarness = (
    opts: {
        budgets?: TurnBudgets
        throwOnConcurrencyEvent?: boolean
        throwOnGaugeEvent?: boolean
        corruptUserMessageRow?: boolean
    } = {}
): Harness => {
    const telemetry: TelemetryEvent[] = []
    const inflightBySession = new Map<string, string>()
    const controls = new Map<string, TurnControl>()
    const terminals = new Map<string, number>()

    const controlFor = (sessionId: string): TurnControl => {
        const existing = controls.get(sessionId)
        if (existing) return existing
        let startedResolve!: () => void
        let release!: (finish: Finish) => void
        const started = new Promise<void>((r) => {
            startedResolve = r
        })
        const finish = new Promise<Finish>((r) => {
            release = r
        })
        const control: TurnControl = {
            started,
            startedResolve,
            finish,
            release
        }
        controls.set(sessionId, control)
        return control
    }

    let messageReadStartedResolve!: () => void
    const messageReadStarted = new Promise<void>((r) => {
        messageReadStartedResolve = r
    })
    let messageReadRelease!: () => void
    const messageReadGate = new Promise<void>((r) => {
        messageReadRelease = r
    })
    let gateMessageRead = true

    const sessionRow = (id: string) => ({
        id,
        userId: 'user-1',
        agentId: 'agent-1',
        title: 'seeded',
        frameworkSessionRef: null,
        createdAt: new Date(),
        updatedAt: new Date()
    })

    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => [agentRow] })
                }),
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({
            set: () => ({ where: async () => undefined })
        })
    }
    const repo = {
        listOrphanedAssistantMessages: async () => [],
        getSession: async (sessionId: string) => sessionRow(sessionId),
        getSessionById: async (sessionId: string) => sessionRow(sessionId),
        getMessageById: async (messageId: string) => {
            if (gateMessageRead) {
                gateMessageRead = false
                messageReadStartedResolve()
                await messageReadGate
            }
            return {
                id: messageId,
                sessionId: 'session-contended',
                role: 'assistant',
                createdAt: new Date(),
                daemonId: null,
                daemonExecRef: null
            }
        },
        getTurnExecution: async () => null,
        daemonSeenWithin: async () => false,
        insertMessage: async (row: {
            id: string
            sessionId: string
            role: string
        }) =>
            opts.corruptUserMessageRow && row.role === 'user'
                ? { ...row, createdAt: null }
                : row,
        listMessages: async () => [],
        listStreamEventsSince: async () => [],
        latestInflightMessageId: async (sessionId: string) =>
            inflightBySession.get(sessionId) ?? null,
        claimInflightTurn: async (sessionId: string, messageId: string) => {
            if (inflightBySession.has(sessionId)) return false
            inflightBySession.set(sessionId, messageId)
            return true
        },
        releaseInflightTurn: async (sessionId: string, messageId: string) => {
            if (inflightBySession.get(sessionId) === messageId)
                inflightBySession.delete(sessionId)
        },
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length,
            fenceLost: false
        }),
        upsertTurnExecution: async (row: {
            messageId: string
            ownerId: string
        }) => ({
            messageId: row.messageId,
            ownerId: row.ownerId,
            generation: 1
        }),
        claimTurnForResume: async () => ({
            outcome: 'claimed' as const,
            row: {
                messageId: 'msg-contended',
                sessionId: 'session-contended',
                agentId: 'agent-1',
                runtime: 'sprites' as const,
                ownerId: 'owner-1',
                generation: 2,
                state: 'running' as const
            }
        }),
        renewTurnLease: async () => true,
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        clearStaleInflightClaims: async () => 0,
        maxStreamEventSeq: async () => 0n,
        boundedResumeStatusOrdinal: async () => 0,
        markCancelRequested: async () => undefined,
        findCancelRequestedMessageIds: async () => []
    }

    const streamSessionOf = new Map<string, string>()
    const record = async (
        messageId: string,
        event: { type: string }
    ): Promise<{ persisted: boolean; fenceLost: boolean }> => {
        if (event.type === 'done' || event.type === 'error') {
            terminals.set(messageId, (terminals.get(messageId) ?? 0) + 1)
            const sessionId = streamSessionOf.get(messageId)
            if (
                sessionId !== undefined &&
                inflightBySession.get(sessionId) === messageId
            )
                inflightBySession.delete(sessionId)
        }
        return { persisted: true, fenceLost: false }
    }
    const broadcaster = {
        beginStream: (sessionId: string, messageId: string) => {
            streamSessionOf.set(messageId, sessionId)
        },
        setStreamFence: () => undefined,
        beginResumeStream: async (sessionId: string, messageId: string) => {
            streamSessionOf.set(messageId, sessionId)
        },
        endStream: () => undefined,
        hasStream: () => true,
        emit: record,
        emitDetached: record
    }

    const turnStream = async function* (
        ctx: ApiChatAdapterContext
    ): AsyncIterable<EmittedChatEvent> {
        const control = controlFor(ctx.sessionId)
        yield { type: 'token', text: 'hi' }
        control.startedResolve()
        const cancelled = new Promise<'cancelled'>((resolve) => {
            if (ctx.abortSignal?.aborted) resolve('cancelled')
            else
                ctx.abortSignal?.addEventListener(
                    'abort',
                    () => resolve('cancelled'),
                    { once: true }
                )
        })
        const outcome = await Promise.race([control.finish, cancelled])
        if (outcome === 'cancelled') {
            yield {
                type: 'error',
                error: {
                    code: 'cancelled_by_user',
                    message: 'cancelled by user',
                    retryable: false
                }
            }
            return
        }
        if (outcome === 'park') {
            await new Promise<void>(() => {})
            return
        }
        if (outcome === 'suspend') {
            yield {
                type: 'suspended',
                daemonId: 'daemon-1',
                daemonExecRef: ctx.messageId,
                reason: 'daemon_owns_turn'
            }
            return
        }
        if (outcome === 'error') {
            yield {
                type: 'error',
                error: {
                    code: 'adapter_failed',
                    message: 'the transport died',
                    retryable: true
                }
            }
            return
        }
        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    const adapter = { sendMessage: turnStream, resumeMessage: turnStream }
    const adapters = { get: () => adapter }
    const files = { build: async () => ({ root: { id: 'workspace' } }) }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        files as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, props: Record<string, unknown>) => {
                if (
                    (opts.throwOnConcurrencyEvent &&
                        name === 'chat.turn.concurrency') ||
                    (opts.throwOnGaugeEvent &&
                        name === 'chat.turn.concurrency.gauge')
                )
                    throw new Error('telemetry sink is down')
                telemetry.push({ name, props })
            },
            error: () => undefined
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
            ownerId: 'owner-1',
            enabled: false,
            stopClaiming: async () => undefined
        } as never
    )

    const internals = service as unknown as Harness['internals'] & {
        turnBudgets: () => TurnBudgets
        runningAdapters: Map<string, AbortController>
        processLoad: { sample: () => unknown; stop: () => void }
    }
    let loadSamples = 0
    if (opts.budgets) {
        const budgets = opts.budgets
        internals.turnBudgets = () => budgets
    }

    return {
        service,
        telemetry,
        concurrencyEvents: () =>
            telemetry
                .filter((e) => e.name === 'chat.turn.concurrency')
                .map((e) => ({
                    event: String(e.props.event),
                    origin: String(e.props.origin)
                })),
        gauges: () =>
            telemetry
                .filter((e) => e.name === 'chat.turn.concurrency.gauge')
                .map((e) => e.props as Record<string, number>),
        terminalsFor: (messageId: string) => terminals.get(messageId) ?? 0,
        latestInflight: (sessionId: string) =>
            repo.latestInflightMessageId(sessionId),
        stubLoadSampler: () => {
            internals.processLoad = {
                sample: () => {
                    loadSamples += 1
                    return {
                        eventLoopUtilization: 0,
                        eventLoopDelayP99Ms: 0,
                        eventLoopDelayMaxMs: 0,
                        rssMb: 1,
                        heapUsedMb: 1
                    }
                },
                stop: () => undefined
            }
        },
        throwLoadSampler: () => {
            internals.processLoad = {
                sample: () => {
                    throw new Error('process load sampler is down')
                },
                stop: () => undefined
            }
        },
        loadSampleCount: () => loadSamples,
        started: (sessionId: string) => controlFor(sessionId).started,
        messageReadStarted,
        releaseMessageRead: () => messageReadRelease(),
        release: (suffix, finish) =>
            controlFor(`session-${suffix}`).release(finish),
        releaseAll: (finish) => {
            for (const control of controls.values()) control.release(finish)
        },
        cancel: (suffix) => {
            for (const [messageId, controller] of internals.runningAdapters)
                if (streamSessionOf.get(messageId) === `session-${suffix}`)
                    controller.abort()
        },
        internals
    }
}
