import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { ConfigService } from '@nestjs/config'
import type { WebSocket as WsClient } from 'ws'
import {
    chatMessages,
    chatStreamEvents,
    turnExecutions,
    type ChatMessage as DbChatMessage,
    type Database
} from '@manyfold/db'
import { DaemonExecResumeService } from '../src/modules/daemon/daemon-exec-resume.service'
import { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'

// #648: a hello can land while the #624 fence is still inside its 15s recovery
// loop for the same turn. The daemon reports the ref, the ref matches an open
// turn, and the resume is then declined — the fence still holds the turn's
// runningAdapters entry, so `resume skipped (already running locally)` is the
// only correct answer. But the fence can END without settling the turn: on a
// buffer that answers `daemon process crashed` it declines, surfaces the
// original transport error, and the turn suspends. At that point the hello is
// gone and it was the turn's LAST scheduled look — the matched branch arms no
// recheck and handleOne cleared any earlier one — so nothing re-examined the
// ref until the next reconnect. Staging drill A6 hung 337s that way, settling
// only when the lease sweep caught up, while the same drill's unskipped
// attempts settled on the ~74s recheck.
//
// These run the real service against a fake db (the SQL itself is pinned by
// daemon-exec-resume-recheck.pg.test.ts) and node's mock timers, so the armed
// delay under test is the production one, not a test override.

const DAEMON = 'dh-fenced'
const TURN = 'msg-fenced'

// The AC's bound: an affected turn settles in the recheck tier, not the
// minute-scale lease-sweeper tier.
const AC_SETTLE_BOUND_MS = 120_000

interface DbState {
    open: boolean
    execution: {
        runtime: 'sprites' | 'daemon' | 'k8s' | 'external'
        state: 'running' | 'handoff' | 'adopting' | 'done' | 'failed'
        leaseExpiresAt: Date
    } | null
    streamedRunnerFrames: boolean
    beforeOpenQuery: (() => Promise<void>) | null
    failOpenQuery: boolean
    beforeExecutionQuery: (() => Promise<void>) | null
    beforeSnapshotQuery: (() => Promise<void>) | null
    beforeResumeReturn: (() => Promise<void>) | null
    failResume: boolean
    ownedElsewhere: boolean
    beforeFailReturn: (() => Promise<void>) | null
    settleOnResume: boolean
    cancelled: boolean
}

// Models what the service's queries RETURN, not the SQL that shapes them:
// findOpenTurns is already covered against real Postgres.
const rowsFor = (state: DbState, row: DbChatMessage, table: unknown) => {
    if (table === chatMessages) return state.open ? [row] : []
    if (table === turnExecutions)
        return state.execution ? [state.execution] : []
    if (table === chatStreamEvents)
        return state.streamedRunnerFrames ? [{ one: 1 }] : []
    throw new Error('unexpected table in the resume-service fake db')
}

const query = (
    rows: unknown[],
    before: (() => Promise<void>) | null = null
) => {
    const result = (before ? before() : Promise.resolve()).then(() => rows)
    return Object.assign(result, {
        limit: async (n: number) => (await result).slice(0, n)
    })
}

const queryAfter = (
    rows: () => unknown[],
    before: (() => Promise<void>) | null = null
) => {
    const result = (before ? before() : Promise.resolve()).then(rows)
    return Object.assign(result, {
        limit: async (n: number) => (await result).slice(0, n)
    })
}

// Same shape as production, plus the arming delay it asked for — the tier that
// delay lands in is half of what #648 is about.
class ObservedRecheckService extends DaemonExecResumeService {
    readonly armedDelays: number[] = []

    protected recheckDelay(ms: number): number {
        this.armedDelays.push(ms)
        return ms
    }
}

interface Harness {
    service: ObservedRecheckService
    db: DbState
    connection: {
        token: string
        helloOrder: number
        pendingRefs: Set<string>
        online: boolean
    }
    runningLocally: Set<string>
    resumed: string[]
    resumedRefs: string[]
    converged: string[]
    cancelled: string[]
    timers: () => Map<string, unknown>
    armed: () => number
    armedDelay: (index: number) => number
    hello: (refIds: string[]) => Promise<void>
    settle: () => Promise<void>
    registerHandler: () => void
    retireConnection: (token?: string) => void
}

const makeHarness = (
    opts: {
        ageMs?: number
        registerHandler?: boolean
        refId?: string
        registry?: DaemonRegistryService
    } = {}
): Harness => {
    const db: DbState = {
        open: true,
        execution: null,
        streamedRunnerFrames: false,
        beforeOpenQuery: null,
        failOpenQuery: false,
        beforeExecutionQuery: null,
        beforeSnapshotQuery: null,
        beforeResumeReturn: null,
        failResume: false,
        ownedElsewhere: false,
        beforeFailReturn: null,
        settleOnResume: false,
        cancelled: false
    }
    const row = {
        id: TURN,
        sessionId: 'session-1',
        role: 'assistant',
        createdAt: new Date(Date.now() - (opts.ageMs ?? 0)),
        daemonId: DAEMON,
        daemonExecRef: opts.refId ?? TURN,
        get cancelRequestedAt() {
            return db.cancelled ? new Date(0) : null
        }
    } as unknown as DbChatMessage

    const fakeDb = {
        update: () => ({ set: () => ({ where: async () => undefined }) }),
        select: (selection?: Record<string, unknown>) => ({
            from: (table: unknown) => {
                if (
                    table === chatMessages &&
                    selection !== undefined &&
                    'message' in selection
                )
                    return {
                        leftJoin: () => ({
                            where: () => {
                                return queryAfter(
                                    () =>
                                        db.open
                                            ? [
                                                  {
                                                      message: row,
                                                      execution: db.execution,
                                                      streamedRunnerFrames:
                                                          db.streamedRunnerFrames
                                                  }
                                              ]
                                            : [],
                                    db.beforeSnapshotQuery
                                )
                            }
                        })
                    }
                return {
                    where: () =>
                        table === chatMessages && db.failOpenQuery
                            ? query([], async () => {
                                  throw new Error('open query failed')
                              })
                            : query(
                                  rowsFor(db, row, table),
                                  table === chatMessages
                                      ? db.beforeOpenQuery
                                      : table === turnExecutions
                                        ? db.beforeExecutionQuery
                                        : null
                              )
                }
            }
        })
    } as unknown as Database

    const connection = {
        token: 'connection-1',
        helloOrder: 1,
        pendingRefs: new Set<string>(),
        online: true
    }
    const retireListeners = new Set<(daemonId: string, token: string) => void>()
    const service = new ObservedRecheckService(fakeDb, opts.registry ?? {
        isOnline: () => connection.online,
        onConnectionRetired: (
            listener: (daemonId: string, token: string) => void
        ) => {
            retireListeners.add(listener)
            return () => {
                retireListeners.delete(listener)
            }
        },
        hasPendingRef: (_daemonId: string, refId: string) =>
            connection.pendingRefs.has(refId),
        currentHelloEvidence: () =>
            !connection.online || connection.helloOrder === 0
                ? null
                : {
                      connectionToken: connection.token,
                      helloOrder: connection.helloOrder
                  },
        isCurrentHelloEvidence: (
            _daemonId: string,
            evidence: { connectionToken: string; helloOrder: number } | null
        ) =>
            connection.online &&
            evidence?.connectionToken === connection.token &&
            evidence.helloOrder === connection.helloOrder
    } as unknown as DaemonRegistryService)

    const runningLocally = new Set<string>()
    const resumed: string[] = []
    const resumedRefs: string[] = []
    const converged: string[] = []
    const cancelled: string[] = []
    // The ChatService contract, pinned on the real service by
    // chat-turn-concurrency.test.ts: a resume declines when another execution
    // in this process already holds the turn.
    const registerHandler = (): void =>
        service.registerHandler({
            resumeAssistantTurn: async ({ message, refId }) => {
                if (runningLocally.has(message.id))
                    return 'skipped_running_locally'
                if (db.failResume) throw new Error('resume attach failed')
                // What claimTurnForResume answers while a live carrier still
                // holds the durable claim — on staging, a dying replica's
                // handoff drain grace.
                if (db.ownedElsewhere) {
                    if (db.beforeResumeReturn) await db.beforeResumeReturn()
                    return 'skipped_owned_elsewhere'
                }
                resumed.push(message.id)
                resumedRefs.push(refId)
                if (db.beforeResumeReturn) await db.beforeResumeReturn()
                if (db.settleOnResume) db.open = false
                return 'handled'
            },
            isRunningLocally: (messageId) => runningLocally.has(messageId),
            completeOfflineCancel: async ({ message }) => {
                cancelled.push(message.id)
                db.open = false
            },
            failUnresumable: async ({ message }) => {
                if (db.beforeFailReturn) await db.beforeFailReturn()
                converged.push(message.id)
                // A terminal takes the turn out of the open-turn lookup, which
                // makes every later look a no-op instead of a second verdict.
                db.open = false
            }
        })
    if (opts.registerHandler !== false) registerHandler()

    return {
        service,
        db,
        connection,
        runningLocally,
        resumed,
        resumedRefs,
        converged,
        cancelled,
        timers: () => {
            const owner = service as unknown as {
                recheckTimers: Map<string, unknown>
                helloLookupTimers: Map<string, unknown>
            }
            return new Map([...owner.recheckTimers, ...owner.helloLookupTimers])
        },
        armed: () => service.armedDelays.length,
        armedDelay: (index: number) => service.armedDelays[index],
        hello: (refIds: string[]) => {
            const evidence = {
                connectionToken: connection.token,
                helloOrder: ++connection.helloOrder
            }
            return service.handleInflightStreams(
                DAEMON,
                refIds.map((refId) => ({
                    refId,
                    method: 'turn.start' as const,
                    lastSeq: 0,
                    status: 'running' as const
                })),
                evidence
            )
        },
        settle: () => new Promise((resolve) => setImmediate(resolve)),
        registerHandler,
        retireConnection: (token = connection.token) => {
            if (token === connection.token) connection.online = false
            for (const listener of retireListeners) listener(DAEMON, token)
        }
    }
}

// The fence gave up: its probe proved nothing (`daemon process crashed`), so it
// surfaced the original transport error, the turn suspended, and the local
// entry went away. The lease it stopped renewing lapses shortly after.
const fenceDeclines = (h: Harness): void => {
    h.runningLocally.delete(TURN)
    h.db.execution = {
        runtime: 'daemon',
        state: 'running',
        leaseExpiresAt: new Date(Date.now() - 1_000)
    }
}

test('a hello skipped inside the fence window still leaves a recheck armed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        h.runningLocally.add(TURN)

        await h.hello([TURN])

        assert.deepEqual(
            h.resumed,
            [],
            'the resume declined: the fence still owns the turn'
        )
        assert.equal(
            h.timers().size,
            1,
            'the skipped resume has to leave a recheck behind, or nothing looks at this ref again'
        )
        assert.equal(h.armed(), 1)
        assert.ok(
            h.armedDelay(0) < AC_SETTLE_BOUND_MS,
            `the recheck tier, not the lease-sweeper tier (armed ${h.armedDelay(0)}ms)`
        )

        fenceDeclines(h)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(
            h.converged,
            [TURN],
            'and it settles the turn without waiting for another reconnect'
        )
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a repeated hello arms one recheck, and that recheck converges once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        h.runningLocally.add(TURN)

        // A daemon that flaps re-hellos every few seconds; each one matches
        // and each one is skipped by the same live execution.
        await h.hello([TURN])
        await h.hello([TURN])
        await h.hello([TURN])
        assert.equal(h.timers().size, 1, 'one timer, not one per hello')

        fenceDeclines(h)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN])

        // Convergence must not re-arm: a second terminal on one turn is the
        // failure this whole path exists to avoid.
        assert.equal(h.timers().size, 0)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN], 'exactly one convergence')
    } finally {
        mock.timers.reset()
    }
})

test('repeated young unmatched hellos keep one timer carrying the newest evidence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()

        await h.hello([])
        await h.hello([])

        assert.equal(h.timers().size, 1)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('an old timer on an online replacement stays covered until its hello arrives', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()

        await h.hello([])
        h.connection.token = 'connection-2'
        h.connection.helloOrder = 0
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.converged, [])
        assert.equal(
            h.timers().size,
            1,
            'stale negative evidence cannot terminalize or fall out of the bounded tier'
        )

        await h.hello([])
        assert.deepEqual(h.converged, [])
        assert.equal(h.timers().size, 1)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a matched hello whose resume attaches arms nothing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()

        await h.hello([TURN])

        assert.deepEqual(h.resumed, [TURN])
        assert.equal(
            h.timers().size,
            0,
            'the resume owns the turn; a recheck under it could only do harm'
        )

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [])
    } finally {
        mock.timers.reset()
    }
})

test('a matched hello without a handler keeps one retry for that ref', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ registerHandler: false })

        await h.hello([TURN])

        assert.deepEqual(h.resumed, [])
        assert.equal(h.timers().size, 1)

        h.registerHandler()
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.resumed, [TURN])
        assert.deepEqual(h.converged, [])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a rejected matched resume keeps one bounded retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        h.db.failResume = true

        await h.hello([TURN])

        assert.deepEqual(h.resumed, [])
        assert.equal(
            h.timers().size,
            1,
            'a rejected resume promise is not an owner after it returns'
        )

        h.db.failResume = false
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.resumed, [TURN])
        assert.deepEqual(h.converged, [])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a newer matched hello survives an older matched row lookup', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        let openQueries = 0
        let releaseLookup: () => void = () => {}
        let lookupStarted: () => void = () => {}
        const lookupGate = new Promise<void>((resolve) => {
            releaseLookup = resolve
        })
        const atLookup = new Promise<void>((resolve) => {
            lookupStarted = resolve
        })
        h.db.beforeOpenQuery = async () => {
            if (++openQueries !== 2) return
            lookupStarted()
            await lookupGate
        }

        const older = h.hello([TURN])
        await atLookup
        await h.hello([TURN])
        h.db.beforeOpenQuery = null
        releaseLookup()
        await older

        assert.deepEqual(h.resumed, [])
        assert.equal(
            h.timers().size,
            1,
            'the newer matched observation must not be lost as a duplicate of the self-fenced lookup'
        )

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.resumed, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a newer unmatched hello replaces an older matched row lookup', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        let openQueries = 0
        let releaseLookup: () => void = () => {}
        let lookupStarted: () => void = () => {}
        const lookupGate = new Promise<void>((resolve) => {
            releaseLookup = resolve
        })
        const atLookup = new Promise<void>((resolve) => {
            lookupStarted = resolve
        })
        h.db.beforeOpenQuery = async () => {
            if (++openQueries !== 2) return
            lookupStarted()
            await lookupGate
        }

        const older = h.hello([TURN])
        await atLookup
        await h.hello([])
        h.db.beforeOpenQuery = null
        releaseLookup()
        await older

        assert.deepEqual(h.resumed, [])
        assert.equal(h.timers().size, 1)

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN])
        assert.deepEqual(h.resumed, [])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a recheck that lands while the turn still runs here defers instead of converging', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        // The other end of the same fence: the probe FOUND the stream and is
        // replaying it as the carrier, so the local execution outlives the
        // hello by minutes. This turn was dispatched before #570 stamped
        // daemon rows, so the durable veto has nothing to read and in-process
        // liveness is the only thing standing between this recheck and a
        // terminal written over a live stream.
        const h = makeHarness()
        h.runningLocally.add(TURN)

        await h.hello([TURN])
        assert.equal(h.timers().size, 1)

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(
            h.converged,
            [],
            'the carrier is still streaming this turn'
        )
        assert.equal(
            h.timers().size,
            1,
            'and the ref stays under a recheck rather than being dropped'
        )

        // It ends without settling the turn — the deferral has to converge it.
        fenceDeclines(h)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN])
    } finally {
        mock.timers.reset()
    }
})

test('a skipped resume on an aged turn is armed in the same tier', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        // Past the dispatch age gate the delay is the slack alone; what must
        // not happen is the ref falling out of the recheck tier entirely.
        const h = makeHarness({ ageMs: 10 * 60_000 })
        h.runningLocally.add(TURN)

        await h.hello([TURN])

        assert.equal(h.timers().size, 1)
        assert.ok(
            h.armedDelay(0) > 0 && h.armedDelay(0) < AC_SETTLE_BOUND_MS,
            `armed ${h.armedDelay(0)}ms`
        )
    } finally {
        mock.timers.reset()
    }
})

test('a recheck and a new matched hello cannot own the turn together', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        h.runningLocally.add(TURN)
        await h.hello([TURN])

        h.runningLocally.delete(TURN)
        let releaseVerdict: () => void = () => {}
        let verdictStarted: () => void = () => {}
        const verdictGate = new Promise<void>((resolve) => {
            releaseVerdict = resolve
        })
        const atVerdict = new Promise<void>((resolve) => {
            verdictStarted = resolve
        })
        const blockVerdict = async (): Promise<void> => {
            verdictStarted()
            await verdictGate
        }
        h.db.beforeExecutionQuery = blockVerdict
        h.db.beforeSnapshotQuery = blockVerdict
        const recheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await atVerdict
        await h.hello([TURN])
        releaseVerdict()
        await recheck
        const convergedAfterVerdict = [...h.converged]

        assert.deepEqual(
            convergedAfterVerdict,
            [],
            'the recheck must revalidate after its database await and defer to the matched hello'
        )
        assert.deepEqual(h.resumed, [TURN], 'the handed-back ref resumes once')
    } finally {
        mock.timers.reset()
    }
})

test('a recheck revalidates an open snapshot after an earlier resume terminalizes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        let releaseResume: () => void = () => {}
        const resumeGate = new Promise<void>((resolve) => {
            releaseResume = resolve
        })
        h.db.beforeResumeReturn = () => resumeGate
        h.db.settleOnResume = true

        // This matched resume predates the recheck, so it cannot mark that
        // later recheck's supersession token. Hold it open until findOpenTurns
        // has snapshotted the still-open row.
        const hello = h.hello([TURN])
        await h.settle()
        assert.deepEqual(h.resumed, [TURN])

        let releaseOpenQuery: () => void = () => {}
        let openQueryStarted: () => void = () => {}
        const openQueryGate = new Promise<void>((resolve) => {
            releaseOpenQuery = resolve
        })
        const atOpenQuery = new Promise<void>((resolve) => {
            openQueryStarted = resolve
        })
        h.db.beforeOpenQuery = async () => {
            openQueryStarted()
            await openQueryGate
        }

        const recheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await atOpenQuery
        releaseResume()
        await hello
        assert.equal(h.db.open, false, 'the matched resume terminalized')
        releaseOpenQuery()
        await recheck

        assert.deepEqual(
            h.converged,
            [],
            'a stale open snapshot must not append a restart terminal after the real terminal'
        )
    } finally {
        mock.timers.reset()
    }
})

// #728: past the 60s age gate the hello used to converge the turn inline, on
// the durable verdict alone — a second, less guarded implementation of the
// terminal the recheck writes. A turn dispatched before #570 stamped daemon
// rows has none, so that verdict is `converge` immediately, and none of the
// recheck's live-state vetoes ran. The witness on develop @ 223c5f54: an aged
// unmatched ref with isRunningLocally=true came back `failed=['msg-review']`.
//
// The same root cause has a second face. The recheck's `resuming` claim is the
// guard a matched resume single-flights on, so a hello arriving while the
// recheck holds it reads as a duplicate resume and returns — while the recheck
// yields to that very hello. Both sides return; nobody owns the turn.

test('an aged unmatched hello never converges a turn this process is still carrying', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        // The daemon's authoritative buffer does not list the ref and the turn
        // is well past the dispatch age gate — the exact shape that converged
        // inline. The #624 fence's other end is carrying the stream here.
        const h = makeHarness({ ageMs: 2 * 60_000 })
        h.runningLocally.add(TURN)

        await h.hello([])

        assert.deepEqual(
            h.converged,
            [],
            'that terminal would land on a stream this process is still consuming'
        )
        assert.equal(
            h.timers().size,
            1,
            'and the ref has to stay under exactly one bounded recheck'
        )
        assert.equal(h.armed(), 1)
        assert.ok(
            h.armedDelay(0) < AC_SETTLE_BOUND_MS,
            `the recheck tier, not the lease-sweeper tier (armed ${h.armedDelay(0)}ms)`
        )

        // The carrier ends without settling the turn: converging is correct now.
        h.runningLocally.delete(TURN)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a matched hello arriving during an aged hello verdict outranks it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        let releaseVerdict: () => void = () => {}
        let verdictStarted: () => void = () => {}
        const verdictGate = new Promise<void>((resolve) => {
            releaseVerdict = resolve
        })
        const atVerdict = new Promise<void>((resolve) => {
            verdictStarted = resolve
        })
        const blockVerdict = async (): Promise<void> => {
            verdictStarted()
            await verdictGate
        }
        h.db.beforeExecutionQuery = blockVerdict
        h.db.beforeSnapshotQuery = blockVerdict

        // The hello that does not report the ref blocks in its durable verdict;
        // the daemon reconnects and the NEXT hello does report it. That is
        // newer, positive evidence than the absence the first one derived from.
        const agedHello = h.hello([])
        await atVerdict
        await h.hello([TURN])
        releaseVerdict()
        await agedHello

        assert.deepEqual(
            h.converged,
            [],
            'and the aged hello must not write server_restart on top of it'
        )
        assert.deepEqual(h.resumed, [TURN], 'resumed exactly once')
    } finally {
        mock.timers.reset()
    }
})

test('a matched hello blocked by a recheck claim is handed back, not dropped', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        let openQueries = 0
        let releaseReRead: () => void = () => {}
        let reReadStarted: () => void = () => {}
        const reReadGate = new Promise<void>((resolve) => {
            releaseReRead = resolve
        })
        const atReRead = new Promise<void>((resolve) => {
            reReadStarted = resolve
        })
        // On the old path this is the second open-turn query; on the guarded
        // path it is the final atomic snapshot. Both are taken UNDER the claim.
        h.db.beforeOpenQuery = async () => {
            if (++openQueries !== 2) return
            reReadStarted()
            await reReadGate
        }
        h.db.beforeSnapshotQuery = async () => {
            reReadStarted()
            await reReadGate
        }

        const recheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await Promise.race([
            atReRead,
            recheck.then(() => {
                throw new Error('recheck completed before the claimed snapshot')
            })
        ])
        h.db.beforeOpenQuery = null
        await h.hello([TURN])

        assert.deepEqual(
            h.resumed,
            [],
            'the claim turns the hello away while the recheck still holds it'
        )

        releaseReRead()
        await recheck

        assert.deepEqual(
            h.converged,
            [],
            'the daemon just reported the ref; converging it writes a terminal over a live stream'
        )
        assert.deepEqual(
            h.resumed,
            [TURN],
            'and the ref the recheck yielded is resumed exactly once, not dropped by both sides'
        )
        assert.equal(
            h.timers().size,
            0,
            'the resume owns the turn; a recheck under it could only do harm'
        )
    } finally {
        mock.timers.reset()
    }
})

test('repeated aged hellos across a firing recheck settle the turn exactly once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        // A flapping daemon re-hellos every few seconds without the ref, and
        // the deferral it arms fires in between, all while the local carrier
        // keeps streaming. None of those interleavings may stack a timer,
        // double-resume, or converge.
        const h = makeHarness({ ageMs: 2 * 60_000 })
        h.runningLocally.add(TURN)

        await h.hello([])
        await h.hello([])
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        await h.hello([])

        assert.equal(h.timers().size, 1, 'one timer across every interleaving')
        assert.deepEqual(h.converged, [])
        assert.deepEqual(h.resumed, [])

        h.runningLocally.delete(TURN)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.converged, [TURN], 'exactly one convergence')
        assert.equal(h.timers().size, 0, 'and convergence never re-arms')

        // A terminal takes the turn out of the open-turn lookup, so the next
        // hello and the next tick are both no-ops.
        await h.hello([])
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.converged, [TURN], 'exactly one terminal')
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('durable ownership created during the final snapshot vetoes convergence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        let releaseSnapshot: () => void = () => {}
        let snapshotStarted: () => void = () => {}
        const snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve
        })
        const atSnapshot = new Promise<void>((resolve) => {
            snapshotStarted = resolve
        })
        let openQueries = 0
        h.db.beforeOpenQuery = async () => {
            if (++openQueries !== 2) return
            snapshotStarted()
            await snapshotGate
        }
        h.db.beforeSnapshotQuery = async () => {
            snapshotStarted()
            await snapshotGate
        }

        const recheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await atSnapshot
        h.db.execution = {
            runtime: 'daemon',
            state: 'running',
            leaseExpiresAt: new Date(Date.now() + 60_000)
        }
        releaseSnapshot()
        await recheck

        assert.deepEqual(
            h.converged,
            [],
            'a newly live durable owner must outrank an earlier no-row verdict'
        )
        assert.equal(h.timers().size, 1, 'the live lease leaves one recheck')
    } finally {
        mock.timers.reset()
    }
})

test('a newer unmatched hello replaces an older hand-back without losing ownership', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        let releaseSnapshot: () => void = () => {}
        let snapshotStarted: () => void = () => {}
        const snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve
        })
        const atSnapshot = new Promise<void>((resolve) => {
            snapshotStarted = resolve
        })
        const blockSnapshot = async (): Promise<void> => {
            snapshotStarted()
            await snapshotGate
        }
        h.db.beforeExecutionQuery = blockSnapshot
        h.db.beforeSnapshotQuery = blockSnapshot

        const recheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await atSnapshot
        await h.hello([TURN])
        await h.hello([])

        releaseSnapshot()
        await recheck

        assert.deepEqual(
            h.resumed,
            [],
            'the older matched ref is no longer authoritative after the next hello omits it'
        )
        assert.deepEqual(
            h.converged,
            [],
            'the old snapshot cannot terminalize from evidence taken before the newer absence'
        )
        assert.equal(
            h.timers().size,
            1,
            'the newer absence remains covered by one bounded recheck'
        )

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN], 'then converges exactly once')
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a replaced local connection vetoes the old hello, then the new hello converges once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        let releaseSnapshot: () => void = () => {}
        let snapshotStarted: () => void = () => {}
        const snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve
        })
        const atSnapshot = new Promise<void>((resolve) => {
            snapshotStarted = resolve
        })
        const blockSnapshot = async (): Promise<void> => {
            snapshotStarted()
            await snapshotGate
        }
        h.db.beforeExecutionQuery = blockSnapshot
        h.db.beforeSnapshotQuery = blockSnapshot

        const oldHello = h.hello([])
        await atSnapshot
        h.connection.token = 'connection-2'
        h.connection.helloOrder = 0
        releaseSnapshot()
        await oldHello

        assert.deepEqual(
            h.converged,
            [],
            'isOnline stays true across a local replacement, so the socket token must fence the old hello'
        )
        assert.equal(
            h.timers().size,
            1,
            'the replacement has not supplied authoritative hello evidence, so the ref stays covered'
        )

        h.db.beforeExecutionQuery = null
        h.db.beforeSnapshotQuery = null
        await h.hello([])
        assert.deepEqual(
            h.converged,
            [TURN],
            'the current connection re-arbitrates and converges exactly once'
        )
    } finally {
        mock.timers.reset()
    }
})

test('a later cancellation in the final snapshot wins over restart convergence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        let releaseSnapshot: () => void = () => {}
        let snapshotStarted: () => void = () => {}
        const snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve
        })
        const atSnapshot = new Promise<void>((resolve) => {
            snapshotStarted = resolve
        })
        const blockSnapshot = async (): Promise<void> => {
            snapshotStarted()
            await snapshotGate
        }
        h.db.beforeExecutionQuery = blockSnapshot
        h.db.beforeSnapshotQuery = blockSnapshot

        const hello = h.hello([])
        await atSnapshot
        h.db.cancelled = true
        releaseSnapshot()
        await hello

        assert.deepEqual(h.cancelled, [TURN])
        assert.deepEqual(
            h.converged,
            [],
            'the final row requested cancellation, not server_restart'
        )
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('handler absence leaves one bounded recheck instead of dropping the turn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({
            ageMs: 2 * 60_000,
            registerHandler: false
        })

        await h.hello([])

        assert.deepEqual(h.converged, [])
        assert.equal(
            h.timers().size,
            1,
            'the missing terminal handler is temporary, not proof the turn can be abandoned'
        )

        h.registerHandler()
        await h.service.recheckUnmatchedTurn(DAEMON, TURN)
        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a rejected reconcile read retains one bounded retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        h.db.failOpenQuery = true

        await assert.rejects(
            h.service.recheckUnmatchedTurn(DAEMON, TURN),
            /open query failed/
        )

        assert.deepEqual(h.converged, [])
        assert.equal(
            h.timers().size,
            1,
            'a rejected database read is not an owner after it returns'
        )

        h.db.failOpenQuery = false
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a hand-back is not replayed after the terminal completed in flight', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        let releaseTerminal: () => void = () => {}
        let terminalStarted: () => void = () => {}
        const terminalGate = new Promise<void>((resolve) => {
            releaseTerminal = resolve
        })
        const atTerminal = new Promise<void>((resolve) => {
            terminalStarted = resolve
        })
        h.db.beforeFailReturn = async () => {
            terminalStarted()
            await terminalGate
        }

        const recheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await atTerminal
        await h.hello([TURN])
        assert.deepEqual(
            h.resumed,
            [],
            'the terminal claim still owns the turn'
        )

        releaseTerminal()
        await recheck

        assert.deepEqual(h.converged, [TURN])
        assert.deepEqual(
            h.resumed,
            [],
            'the fresh open-row read must not resume from the stale handed-back message after terminal'
        )
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a failed terminal write retains one bounded retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness()
        h.db.beforeFailReturn = async () => {
            throw new Error('terminal write failed')
        }

        await h.service.recheckUnmatchedTurn(DAEMON, TURN)

        assert.deepEqual(h.converged, [])
        assert.equal(
            h.timers().size,
            1,
            'a rejected terminal promise is not an owner after it returns'
        )

        h.db.beforeFailReturn = null
        await h.service.recheckUnmatchedTurn(DAEMON, TURN)
        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

// #570 SIGINT overlap, staging 2026-08-14. The dying replica handed generation
// 1 off with a drain-grace lease, the daemon's socket reconnected to a peer
// 1.1s later and its hello listed the ref, and the peer's claim correctly lost
// to that live grace — `skipped_owned_elsewhere`. The ref was then handed to
// the UNMATCHED recheck, which knows nothing about the stream the hello just
// proved live; for a daemon row its verdict is the lease alone, so as soon as
// the grace lapsed it claimed generation 2 and wrote `server_restart` over a
// stream the old machine was still serving (it did not exit for another 7s).
// Fencing held throughout — exactly one terminal, no stale write — and the
// turn was killed anyway. A busy claim is a statement about the CARRIER, so
// the matched evidence has to survive it.

const oldOwnerHandsOff = (h: Harness): void => {
    h.db.ownedElsewhere = true
    h.db.execution = {
        runtime: 'daemon',
        state: 'handoff',
        leaseExpiresAt: new Date(Date.now() + 15_000)
    }
}

// The old machine is gone: its drain grace has lapsed, so the peer's claim
// wins. A daemon row with a lapsed lease is also the exact shape the unmatched
// verdict converges on, which is what makes the distinction observable.
const oldOwnerExits = (h: Harness): void => {
    h.db.ownedElsewhere = false
    h.db.execution = {
        runtime: 'daemon',
        state: 'handoff',
        leaseExpiresAt: new Date(Date.now() - 1_000)
    }
}

test('a matched resume blocked by a live claim replays that ref, never a terminal', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        oldOwnerHandsOff(h)

        await h.hello([TURN])

        assert.deepEqual(h.resumed, [], 'the drain grace still owns the turn')
        assert.equal(h.timers().size, 1, 'and the ref stays covered')
        assert.ok(
            h.armedDelay(0) < AC_SETTLE_BOUND_MS,
            `the bounded tier (armed ${h.armedDelay(0)}ms)`
        )

        // The grace has not lapsed yet: the retry finds the same busy claim.
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.resumed, [])
        assert.deepEqual(
            h.converged,
            [],
            'a claim lost to a live carrier is not evidence the stream is gone'
        )
        assert.equal(h.timers().size, 1, 'one retry, still exactly one timer')

        oldOwnerExits(h)
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(
            h.converged,
            [],
            'the lapsed daemon lease must not terminalize a ref the hello matched'
        )
        assert.deepEqual(
            h.resumed,
            [TURN],
            'the retry replays the ref the hello matched, so the turn can finish'
        )
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a hello that stops listing the ref retires the blocked matched retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        oldOwnerHandsOff(h)

        await h.hello([TURN])
        assert.equal(h.timers().size, 1)

        // The daemon reconnects and its authoritative buffer no longer holds
        // the ref. The claim would succeed now — that must not matter.
        oldOwnerExits(h)
        await h.hello([])

        assert.deepEqual(
            h.resumed,
            [],
            'a ref the newest hello omits cannot be resumed from the older one'
        )
        assert.deepEqual(h.converged, [TURN])
        assert.equal(h.timers().size, 0)

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.resumed, [], 'the stale retry is gone, not deferred')
        assert.deepEqual(h.converged, [TURN], 'exactly one terminal')
    } finally {
        mock.timers.reset()
    }
})

test('a hello omitting the ref mid-resume leaves the unmatched recheck in charge', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        oldOwnerHandsOff(h)
        let releaseResume: () => void = () => {}
        let resumeStarted: () => void = () => {}
        const resumeGate = new Promise<void>((resolve) => {
            releaseResume = resolve
        })
        const atResume = new Promise<void>((resolve) => {
            resumeStarted = resolve
        })
        h.db.beforeResumeReturn = async () => {
            resumeStarted()
            await resumeGate
        }

        const blocked = h.hello([TURN])
        await atResume
        // The next hello lands while the blocked resume is still in flight, so
        // the absence has to retire evidence the resume is still carrying.
        oldOwnerExits(h)
        await h.hello([])
        releaseResume()
        await blocked

        assert.deepEqual(
            h.resumed,
            [],
            'the in-flight matched ref is retired by the newer absence'
        )
        assert.equal(
            h.timers().size,
            1,
            'and the turn falls back to one bounded unmatched recheck'
        )

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.resumed, [])
        assert.deepEqual(h.converged, [TURN], 'which converges it exactly once')
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a newer matched hello retains its ref when the open-turn lookup rejects', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        oldOwnerHandsOff(h)

        await h.hello([TURN])
        assert.equal(h.timers().size, 1)

        // Hello order advances before the async open-turn lookup. Even when
        // that lookup fails, the new authoritative list still says this ref is
        // servable and must supersede the older retry without changing its
        // matched meaning.
        h.db.failOpenQuery = true
        await assert.rejects(h.hello([TURN]), /open query failed/)
        h.db.failOpenQuery = false
        oldOwnerExits(h)

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(
            h.converged,
            [],
            'a failed lookup cannot turn positive hello evidence into a terminal'
        )
        assert.deepEqual(h.resumed, [TURN])
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

test('a newer matched hello covers an older unmatched lookup that has not found the ref yet', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        oldOwnerHandsOff(h)
        let releaseLookup: () => void = () => {}
        let lookupStarted: () => void = () => {}
        const lookupGate = new Promise<void>((resolve) => {
            releaseLookup = resolve
        })
        const atLookup = new Promise<void>((resolve) => {
            lookupStarted = resolve
        })
        h.db.beforeOpenQuery = async () => {
            lookupStarted()
            await lookupGate
        }

        const olderRecheck = h.service.recheckUnmatchedTurn(DAEMON, TURN)
        await atLookup
        h.db.beforeOpenQuery = null
        h.db.failOpenQuery = true
        await assert.rejects(h.hello([TURN]), /open query failed/)
        h.db.failOpenQuery = false
        oldOwnerExits(h)
        releaseLookup()
        await olderRecheck

        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()

        assert.deepEqual(h.converged, [])
        assert.deepEqual(
            h.resumed,
            [TURN],
            'the pending lookup must intersect its row with the newer hello'
        )
        assert.equal(h.timers().size, 0)
    } finally {
        mock.timers.reset()
    }
})

const overlapFailedMatchedHello = async (h: Harness, refId: string) => {
    let releaseLookup: () => void = () => {}
    let lookupStarted: () => void = () => {}
    const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve
    })
    const atLookup = new Promise<void>((resolve) => {
        lookupStarted = resolve
    })
    h.db.beforeOpenQuery = async () => {
        lookupStarted()
        await lookupGate
    }
    const olderHello = h.hello([])
    await atLookup
    h.db.beforeOpenQuery = null
    h.db.failOpenQuery = true
    await assert.rejects(h.hello([refId]), /open query failed/)
    return {
        finish: async () => {
            releaseLookup()
            await olderHello
        }
    }
}

test('overlapping hellos retain exactly one bounded matched retry after the newer lookup fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const refId = 'exec-exact-matched-ref'
    const h = makeHarness({ ageMs: 2 * 60_000, refId })
    t.after(() => h.service.onModuleDestroy())
    const overlap = await overlapFailedMatchedHello(h, refId)
    await overlap.finish()

    assert.equal(h.timers().size, 1)
    assert.equal(h.armed(), 1)
    assert.ok(h.armedDelay(0) > 0 && h.armedDelay(0) < AC_SETTLE_BOUND_MS)
    assert.deepEqual(h.resumed, [])
    assert.deepEqual(h.converged, [])
    assert.equal(
        (h.service as unknown as { helloSnapshots: Map<string, unknown> })
            .helloSnapshots.size,
        1,
        'one batch retry owns the latest inventory until a fresh lookup succeeds'
    )

    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.equal(h.timers().size, 1, 'another DB failure keeps one retry')
    assert.deepEqual(h.converged, [])

    let recoveryReads = 0
    h.db.failOpenQuery = false
    h.db.beforeOpenQuery = async () => {
        recoveryReads += 1
    }
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.ok(recoveryReads > 0, 'recovery must re-read the open row')
    assert.deepEqual(h.resumed, [TURN])
    assert.deepEqual(h.resumedRefs, [refId])
    assert.deepEqual(h.converged, [])
    assert.equal(h.timers().size, 0)
})

test('a newer unmatched hello supersedes the failed matched lookup before the older hello returns', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = makeHarness({ ageMs: 2 * 60_000 })
    t.after(() => h.service.onModuleDestroy())
    const overlap = await overlapFailedMatchedHello(h, TURN)
    await assert.rejects(h.hello([]), /open query failed/)
    await overlap.finish()
    assert.equal(h.timers().size, 1)

    h.db.failOpenQuery = false
    h.runningLocally.add(TURN)
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumed, [])
    assert.deepEqual(h.converged, [], 'local carrier still vetoes terminal')
    assert.equal(h.timers().size, 1)

    h.runningLocally.delete(TURN)
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumed, [], 'retired matched evidence cannot replay')
    assert.deepEqual(h.converged, [TURN])
    assert.equal(h.timers().size, 0)
})

test('a successful newer hello consumes the overlapping lookup retry without a duplicate resume', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = makeHarness({ ageMs: 2 * 60_000 })
    t.after(() => h.service.onModuleDestroy())
    const overlap = await overlapFailedMatchedHello(h, TURN)
    await overlap.finish()
    assert.equal(h.timers().size, 1)

    h.db.failOpenQuery = false
    h.db.settleOnResume = true
    await h.hello([TURN])
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumed, [TURN])
    assert.deepEqual(h.converged, [])
    assert.equal(h.timers().size, 0)
})

for (const shutdownBeforeLookupReturns of [true, false]) {
    test(`shutdown ${shutdownBeforeLookupReturns ? 'before lookup returns' : 'after retry is armed'} clears overlapping hello recovery`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const h = makeHarness({ ageMs: 2 * 60_000 })
        const overlap = await overlapFailedMatchedHello(h, TURN)
        if (shutdownBeforeLookupReturns) h.service.onModuleDestroy()
        await overlap.finish()
        if (!shutdownBeforeLookupReturns) {
            assert.equal(h.timers().size, 1)
            h.service.onModuleDestroy()
        }
        h.db.failOpenQuery = false
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.equal(h.timers().size, 0)
        assert.deepEqual(h.resumed, [])
        assert.deepEqual(h.converged, [])
        assert.equal(
            (h.service as unknown as { helloTurns: Map<string, unknown> })
                .helloTurns.size,
            0
        )
    })
}

test('shutdown does not rearm a matched retry after an in-flight busy claim returns', async () => {
    const h = makeHarness({ ageMs: 2 * 60_000 })
    oldOwnerHandsOff(h)
    let releaseResume: () => void = () => {}
    let resumeStarted: () => void = () => {}
    const resumeGate = new Promise<void>((resolve) => {
        releaseResume = resolve
    })
    const atResume = new Promise<void>((resolve) => {
        resumeStarted = resolve
    })
    h.db.beforeResumeReturn = async () => {
        resumeStarted()
        await resumeGate
    }

    const blocked = h.hello([TURN])
    await atResume
    h.service.onModuleDestroy()
    releaseResume()
    await blocked

    assert.equal(
        h.timers().size,
        0,
        'an async completion cannot recreate a timer after teardown cleared it'
    )
})

function reconciliationGate() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
        release = resolve
    })
    return { promise, release }
}

function lookupState(h: Harness) {
    return h.service as unknown as {
        helloSnapshots: Map<
            string,
            {
                streamsByRef: Map<string, unknown>
                evidence: { connectionToken: string }
            }
        >
        pendingOpenLookups: Map<string, { pending: number }>
    }
}

test('repeated sole-hello lookup failures keep one bounded owner and reuse its inventory', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = makeHarness({ refId: 'exact-sole-ref' })
    t.after(() => h.service.onModuleDestroy())
    h.db.failOpenQuery = true
    await assert.rejects(h.hello(['exact-sole-ref']), /open query failed/)
    const inventory = lookupState(h).helloSnapshots.get(DAEMON)?.streamsByRef
    assert.ok(inventory)
    for (let attempt = 0; attempt < 3; attempt++) {
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await h.settle()
        assert.equal(h.timers().size, 1)
        assert.equal(
            lookupState(h).helloSnapshots.get(DAEMON)?.streamsByRef,
            inventory
        )
        assert.deepEqual(h.resumed, [])
        assert.deepEqual(h.converged, [])
    }
    assert.ok(
        h.service.armedDelays.every(
            (delay) => delay > 0 && delay < AC_SETTLE_BOUND_MS
        )
    )
    h.db.failOpenQuery = false
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumedRefs, ['exact-sole-ref'])
    assert.equal(h.timers().size, 0)
    assert.equal(lookupState(h).helloSnapshots.size, 0)
})

test('a newer omission replaces the sole failed matched inventory before retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = makeHarness({ ageMs: 2 * 60_000 })
    t.after(() => h.service.onModuleDestroy())
    h.db.failOpenQuery = true
    await assert.rejects(h.hello([TURN]), /open query failed/)
    await assert.rejects(h.hello([]), /open query failed/)
    assert.equal(h.timers().size, 1)
    h.db.failOpenQuery = false
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumed, [])
    assert.deepEqual(h.converged, [TURN])
    assert.equal(h.timers().size, 0)
})

test(
    'old-epoch finally and retirement cannot delete the replacement lookup owner',
    { timeout: 5_000 },
    async (t) => {
        const h = makeHarness({ refId: 'epoch-ref' })
        const oldGate = reconciliationGate()
        const oldStarted = reconciliationGate()
        const newGate = reconciliationGate()
        const newStarted = reconciliationGate()
        t.after(() => {
            oldGate.release()
            newGate.release()
            h.service.onModuleDestroy()
        })
        h.db.beforeOpenQuery = async () => {
            oldStarted.release()
            await oldGate.promise
        }
        const oldHello = h.hello(['epoch-ref'])
        await oldStarted.promise
        h.retireConnection()
        h.connection.token = 'connection-2'
        h.connection.online = true
        h.connection.helloOrder = 0
        h.db.beforeOpenQuery = async () => {
            newStarted.release()
            await newGate.promise
        }
        const newHello = h.hello(['epoch-ref'])
        await newStarted.promise
        const state = lookupState(h)
        const newScope = state.pendingOpenLookups.get(DAEMON)
        const pending = newScope?.pending
        assert.ok(pending && pending > 0)
        oldGate.release()
        await oldHello
        assert.equal(state.pendingOpenLookups.get(DAEMON), newScope)
        assert.equal(newScope.pending, pending)
        h.retireConnection('connection-1')
        assert.equal(
            state.helloSnapshots.get(DAEMON)?.evidence.connectionToken,
            'connection-2'
        )
        newGate.release()
        await newHello
        assert.deepEqual(h.resumedRefs, ['epoch-ref'])
        assert.deepEqual(h.converged, [])
        assert.equal(state.helloSnapshots.size, 0)
        assert.equal(state.pendingOpenLookups.size, 0)
    }
)

test(
    'a fresh zero-open lookup discards history without turning an older row into unmatched evidence',
    { timeout: 5_000 },
    async (t) => {
        const h = makeHarness({ ageMs: 2 * 60_000 })
        const gate = reconciliationGate()
        const started = reconciliationGate()
        t.after(() => {
            gate.release()
            h.service.onModuleDestroy()
        })
        h.db.beforeOpenQuery = async () => {
            started.release()
            await gate.promise
        }
        const oldHello = h.hello([TURN])
        await started.promise
        h.db.beforeOpenQuery = null
        h.db.open = false
        await h.hello([TURN])
        assert.equal(
            lookupState(h).helloSnapshots.get(DAEMON)?.streamsByRef.size,
            0
        )
        gate.release()
        await oldHello
        assert.deepEqual(h.resumed, [])
        assert.deepEqual(h.converged, [])
        assert.equal(h.timers().size, 0)
        assert.equal(lookupState(h).helloSnapshots.size, 0)
    }
)

test('connection retirement removes a pending batch retry and its inventory', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = makeHarness()
    t.after(() => h.service.onModuleDestroy())
    h.db.failOpenQuery = true
    await assert.rejects(h.hello([TURN]), /open query failed/)
    assert.equal(h.timers().size, 1)
    h.retireConnection()
    assert.equal(h.timers().size, 0)
    assert.equal(lookupState(h).helloSnapshots.size, 0)
    h.db.failOpenQuery = false
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumed, [])
    assert.deepEqual(h.converged, [])
})

test('actual registry retirement releases a known turn handed from its timer to batch recovery', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const registry = new DaemonRegistryService(
        {
            update: () => ({
                set: () => ({
                    where: () => Object.assign(Promise.resolve(undefined), {
                        returning: async () => []
                    })
                })
            }),
            transaction(work: (tx: unknown) => Promise<unknown>) {
                return work(this)
            },
            select: () => ({
                from: () => ({ where: () => ({ limit: async () => [] }) })
            })
        } as unknown as Database,
        { get: () => undefined } as unknown as ConfigService
    )
    const h = makeHarness({ registry })
    const socket = { close: () => {} } as unknown as WsClient
    t.after(async () => {
        h.service.onModuleDestroy()
        await registry.onModuleDestroy()
    })
    await registry.register({
        daemonId: DAEMON,
        userId: 'user-fixture',
        cliVersion: null,
        hostname: null,
        socket
    })
    const hello = () => {
        const evidence = registry.recordHelloForSocket(DAEMON, socket)
        assert.ok(evidence)
        return h.service.handleInflightStreams(
            DAEMON,
            [
                {
                    refId: TURN,
                    method: 'turn.start',
                    lastSeq: 0,
                    status: 'running'
                }
            ],
            evidence
        )
    }
    const state = h.service as unknown as {
        helloTurns: Map<string, unknown>
        recheckTimers: Map<string, unknown>
        helloLookupTimers: Map<string, unknown>
    }
    h.runningLocally.add(TURN)
    await hello()
    assert.equal(state.recheckTimers.size, 1)
    assert.equal(state.helloTurns.size, 1)
    h.runningLocally.delete(TURN)
    h.db.failOpenQuery = true
    await assert.rejects(hello(), /open query failed/)
    assert.equal(state.recheckTimers.size, 0)
    assert.equal(state.helloLookupTimers.size, 1)
    await registry.unregister(DAEMON, socket)
    assert.equal(h.timers().size, 0)
    assert.equal(
        state.helloTurns.size,
        0,
        'retired batch ownership must not leave an unowned tracked turn'
    )
    assert.equal(lookupState(h).helloSnapshots.size, 0)
    h.db.failOpenQuery = false
    t.mock.timers.tick(AC_SETTLE_BOUND_MS)
    await h.settle()
    assert.deepEqual(h.resumed, [])
    assert.deepEqual(h.converged, [])
})

test(
    'shutdown during the batch retry lookup prevents late work and releases evidence',
    { timeout: 5_000 },
    async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const h = makeHarness()
        const gate = reconciliationGate()
        const started = reconciliationGate()
        t.after(() => {
            gate.release()
            h.service.onModuleDestroy()
        })
        h.db.failOpenQuery = true
        await assert.rejects(h.hello([TURN]), /open query failed/)
        h.db.failOpenQuery = false
        h.db.beforeOpenQuery = async () => {
            started.release()
            await gate.promise
        }
        t.mock.timers.tick(AC_SETTLE_BOUND_MS)
        await started.promise
        h.service.onModuleDestroy()
        gate.release()
        await h.settle()
        assert.equal(h.timers().size, 0)
        assert.equal(lookupState(h).helloSnapshots.size, 0)
        assert.equal(lookupState(h).pendingOpenLookups.size, 0)
        assert.deepEqual(h.resumed, [])
        assert.deepEqual(h.converged, [])
    }
)
