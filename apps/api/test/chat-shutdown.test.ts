import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'

interface ShutdownHarness {
    service: ChatService
    controller: AbortController
    handoffs: string[]
    stopClaimingCalls: () => number
    finishRunningTurn: () => void
    finishPendingTurn: () => void
    assertAcceptingTurns: () => void
}

const makeHarness = (opts?: {
    running?: number
    pending?: number
    adoptionEnabled?: boolean
    handedOff?: string[]
}): ShutdownHarness => {
    const controller = new AbortController()
    const runningAdapters = new Map<string, AbortController>()
    for (let index = 0; index < (opts?.running ?? 0); index += 1)
        runningAdapters.set(`message-${index}`, controller)
    // Distinct ids from the running ones on purpose: activeTurnCount() unions
    // the two by message id, so a pending turn that shares an id with a
    // running one is ONE turn, which is exactly the overlap the union exists
    // to collapse and not what "running: 1, pending: 1" is asking for.
    const pendingTurnIds = new Set<string>()
    for (let index = 0; index < (opts?.pending ?? 0); index += 1)
        pendingTurnIds.add(`pending-${index}`)
    const handoffs: string[] = []
    let stops = 0
    const service = Object.create(ChatService.prototype) as ChatService
    Object.assign(service, {
        runningAdapters,
        unpersistedUpstreamRefs: new Map(),
        turnDrainWaiters: new Set<() => void>(),
        pendingTurnIds,
        // Object.create skips the constructor, so the fields the slot
        // bookkeeping owns have to be seeded by hand.
        turnOrigins: new Map<string, string>(),
        turnFences: new Map<string, unknown>(),
        peakInflightSinceGauge: 0,
        peakDispatchInflightSinceGauge: 0,
        peakRecoveryInflightSinceGauge: 0,
        telemetry: { event: () => undefined },
        drainingForShutdown: false,
        repo: {
            handoffOwnedTurns: async () => {
                handoffs.push('handoff')
                return opts?.handedOff ?? []
            }
        },
        turnAdoption: {
            enabled: opts?.adoptionEnabled ?? true,
            ownerId: 'owner-1',
            stopClaiming: () => {
                stops += 1
            }
        },
        logger: {
            log: () => undefined,
            warn: () => undefined
        }
    })
    const internals = service as unknown as {
        untrackRunningAdapter: (
            messageId: string,
            controller: AbortController
        ) => void
        endPendingTurn: (assistantMessageId: string) => void
        assertAcceptingTurns: () => void
    }
    return {
        service,
        controller,
        handoffs,
        stopClaimingCalls: () => stops,
        finishRunningTurn: () =>
            internals.untrackRunningAdapter('message-0', controller),
        finishPendingTurn: () => internals.endPendingTurn('pending-0'),
        assertAcceptingTurns: () => internals.assertAcceptingTurns()
    }
}

test('shutdown is immediate when no local turn is active', async () => {
    const h = makeHarness()

    const result = await h.service.prepareForShutdown(1000)

    assert.deepEqual(result, {
        drainOutcome: 'idle',
        activeTurnsAtStart: 0,
        activeTurnsRemaining: 0,
        handedOffTurns: 0,
        handoffOutcome: 'not_needed'
    })
    assert.equal(h.stopClaimingCalls(), 1)
    assert.deepEqual(h.handoffs, ['handoff'])
    assert.throws(h.assertAcceptingTurns, /server is restarting/)
})

test('shutdown waits for pending setup and a running adapter to drain', async () => {
    const h = makeHarness({ running: 1, pending: 1 })
    const resultPromise = h.service.prepareForShutdown(1000)

    h.finishPendingTurn()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.service.activeTurnCount(), 1)
    h.finishRunningTurn()

    const result = await resultPromise
    assert.equal(result.drainOutcome, 'drained')
    assert.equal(result.activeTurnsAtStart, 2)
    assert.equal(result.activeTurnsRemaining, 0)
    assert.equal(result.handoffOutcome, 'not_needed')
    assert.deepEqual(h.handoffs, ['handoff'])
})

test('shutdown hands off a turn that outlives the drain budget without aborting it', async () => {
    const h = makeHarness({
        running: 1,
        handedOff: ['message-0']
    })

    const result = await h.service.prepareForShutdown(5)

    assert.equal(result.drainOutcome, 'timeout')
    assert.equal(result.activeTurnsRemaining, 1)
    assert.equal(result.handedOffTurns, 1)
    assert.equal(result.handoffOutcome, 'handed_off')
    assert.equal(h.controller.signal.aborted, false)
    assert.deepEqual(h.handoffs, ['handoff'])
})

test('shutdown reports an unprotected turn when adoption is disabled', async () => {
    const h = makeHarness({ running: 1, adoptionEnabled: false })

    const result = await h.service.prepareForShutdown(0)

    assert.equal(result.drainOutcome, 'timeout')
    assert.equal(result.activeTurnsRemaining, 1)
    assert.equal(result.handedOffTurns, 0)
    assert.equal(result.handoffOutcome, 'disabled')
    assert.equal(h.handoffs.length, 0)
})
