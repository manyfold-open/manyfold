import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getTableName } from 'drizzle-orm'
import type { SpritesClient } from '@manyfold/sprites'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import { RunnerManagerService } from '../src/modules/chat/runner/runner-manager.service'
import { SpriteStorageService } from '../src/modules/agents/sprite-storage/sprite-storage.service'
import {
    SANDBOX_EXEC_UNAVAILABLE_CODE,
    SPRITE_EXEC_TERMINAL_EVENT
} from '../src/modules/chat/sprite-exec-terminal'
import type {
    SpriteExecAdmission,
    SpriteExecDecision
} from '../src/modules/agents/sprite-exec-health/sprite-exec-health.service'

// #730, the half that lives in the turn path. A sprite whose exec endpoint 502s
// the WebSocket upgrade cost every routed turn 39s on the runner inspect and 39s
// more on the direct-sprite fallback before an unactionable terminal, and each
// turn rediscovered it alone.
//
// The durable breaker's own semantics — one prober fleet-wide, only success
// clears, a lapsed lease cannot move a newer one — are properties of the SQL and
// are proven against a real Postgres in sprite-exec-health.pg.test.ts; they are
// cited here, not re-run. What is proven here is the CROSS-LAYER contract those
// semantics are useless without, driven through the real sendMessage →
// startAssistantTurn → runAdapter path, a real RunnerManagerService and a real
// socket that fails the way the staging sprite did:
//
//   * the verdict is consulted before the turn's first exec, and a refusal costs
//     no handshake at all;
//   * a classified endpoint failure terminalizes instead of falling back onto the
//     same transport, exactly once, and leaves nothing resumable behind;
//   * the one command a suspect endpoint is ever asked to run is `true`;
//   * a failure that is not the endpoint's clears and re-arms nothing.

interface WireHarness {
    port: number
    upgrades: number
    cmds: string[][]
    close: () => Promise<void>
}

// The command reaches the sprite in the exec URL's query, so the wire itself
// says what ran — the only place a "no framework command was replayed" claim can
// be checked without trusting the code under test.
const cmdOf = (url: string | undefined): string[] =>
    new URL(url ?? '/', 'http://sprite.invalid').searchParams.getAll('cmd')

// Answers every UPGRADE with a plain HTTP status instead of 101, how the
// unhealthy staging sprite behaved. Sockets are torn down by close(): destroying
// one here races the client's response parse, and that race is the difference
// between a status-carrying handshake failure and a bare transport error.
const startRejectingServer = async (status: number): Promise<WireHarness> => {
    const state = { upgrades: 0, cmds: [] as string[][] }
    const sockets = new Set<Duplex>()
    const server = createServer()
    server.on('upgrade', (req, socket) => {
        state.upgrades += 1
        state.cmds.push(cmdOf(req.url))
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
        if (!socket.destroyed)
            socket.write(
                `HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`
            )
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    return wireHarness(server, state, sockets)
}

// A sprite that answers: the socket opens and the command exits 0.
const startExitingServer = async (): Promise<WireHarness> => {
    const state = { upgrades: 0, cmds: [] as string[][] }
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (ws: WebSocket, req) => {
        state.upgrades += 1
        state.cmds.push(cmdOf(req.url))
        ws.on('error', () => {})
        ws.send(Buffer.from([0x03, 0]))
    })
    const address = wss.address()
    return {
        port: typeof address === 'object' && address ? address.port : 0,
        get upgrades() {
            return state.upgrades
        },
        get cmds() {
            return state.cmds
        },
        close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
    }
}

const wireHarness = (
    server: Server,
    state: { upgrades: number; cmds: string[][] },
    sockets: Set<Duplex>
): WireHarness => {
    const address = server.address()
    return {
        port: typeof address === 'object' && address ? address.port : 0,
        get upgrades() {
            return state.upgrades
        },
        get cmds() {
            return state.cmds
        },
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy()
                server.close(() => resolve())
            })
    }
}

// Byte-for-byte what ChatService.spriteExecFor builds its exec from, so the
// classification and the bounded budget are proven against the transport the
// turn actually uses.
const spritesClientFor = (port: number): SpritesClient =>
    ({
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        authHeaderForInternalUse: () => ({})
    }) as unknown as SpritesClient

const HOST_ID = 'rh_sandbox_1'

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    spriteName: 'art-abc',
    spriteStatus: 'running',
    hostId: HOST_ID,
    workspacePath: null,
    daemonId: null,
    model: 'claude-sonnet-4',
    modelProviderId: null,
    builtInId: null,
    source: null,
    managedBrand: null,
    inferenceProtocol: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const BOUND_MS = 20_000

interface HealthCall {
    method: 'admit' | 'isKnownUnavailable' | 'markUnavailable' | 'recordProbe'
    hostId?: string | null
    failureClass?: string
    upstreamStatus?: number | null
    ok?: boolean
    lease?: Date
}

test('a runner inspect that 502s ends the turn instead of retrying the same socket', async () => {
    const server = await startRejectingServer(502)
    const h = makeHarness({ port: server.port, runner: true })
    try {
        await h.send()

        // The fallback the runner used to invite is a direct sprite exec over
        // the socket that just refused: a second full budget to be told the same
        // thing. One upgrade, total, is the whole fix.
        assert.equal(server.upgrades, 1)
        assert.equal(h.adapterCalls.length, 0)

        const [terminal] = h.terminals
        assert.equal(h.terminals.length, 1)
        assert.equal(terminal.error?.code, SANDBOX_EXEC_UNAVAILABLE_CODE)
        // The opposite of the managed-channel refusal next door: this platform
        // fault clears by itself in under a minute, so the turn IS worth sending
        // again and the client must be told so.
        assert.equal(terminal.error?.retryable, true)
        assert.match(terminal.error?.message ?? '', /not accepting commands/i)
        assert.match(terminal.error?.message ?? '', /was not sent/i)

        // And the endpoint is quarantined with what was proven about it, so the
        // turns behind this one fail fast instead of each paying a handshake.
        const mark = h.health.find((c) => c.method === 'markUnavailable')
        assert.equal(mark?.hostId, HOST_ID)
        assert.equal(mark?.failureClass, 'handshake_5xx')
        assert.equal(mark?.upstreamStatus, 502)

        // One incident, counted with the failure that proved the endpoint dead.
        assert.equal(h.streamErrors.length, 1)
        assert.equal(h.streamErrors[0].attrs.cause, 'exec_handshake_failed')
    } finally {
        await server.close()
    }
})

test('a failed cooldown write does not promise a deadline that was never armed', async () => {
    const server = await startRejectingServer(502)
    const h = makeHarness({
        port: server.port,
        runner: true,
        markUnavailable: false
    })
    try {
        await h.send()

        assert.equal(server.upgrades, 1)
        assert.equal(h.adapterCalls.length, 0)
        assert.match(
            h.terminals[0].error?.message ?? '',
            /try again in a moment/i
        )
        assert.doesNotMatch(
            h.terminals[0].error?.message ?? '',
            /try again in about/i
        )
    } finally {
        await server.close()
    }
})

test('a hostless agent still suppresses fallback after a classified inspect failure', async () => {
    const server = await startRejectingServer(502)
    const h = makeHarness({ port: server.port, runner: true, hostId: null })
    try {
        await h.send()

        assert.equal(server.upgrades, 1)
        assert.equal(h.adapterCalls.length, 0)
        assert.deepEqual(
            h.health.map((call) => [call.method, call.hostId]),
            [['admit', null]]
        )
        assert.equal(h.terminals[0].error?.code, SANDBOX_EXEC_UNAVAILABLE_CODE)
        assert.match(
            h.terminals[0].error?.message ?? '',
            /try again in a moment/i
        )
    } finally {
        await server.close()
    }
})

// Nothing was dispatched, so there is nothing for a fresh instance to adopt or
// resume. Asserted against the passing twin, because 0 is also what a broken
// harness reports.
test('a spared turn leaves no adoption lease and no resume ref behind', async () => {
    const server = await startRejectingServer(502)
    const ok = await startExitingServer()
    const spared = makeHarness({ port: server.port, runner: true })
    const dispatched = makeHarness({ port: ok.port })
    try {
        await spared.send()
        await dispatched.send()

        assert.equal(spared.calls.upsertTurnExecution, 0)
        assert.equal(dispatched.calls.upsertTurnExecution, 1)
        assert.equal(spared.calls.stampedResumeRef, 0)
        assert.equal(dispatched.adapterCalls.length, 1)
    } finally {
        await server.close()
        await ok.close()
    }
})

test('a blocked verdict is decided before the turn touches the endpoint', async () => {
    const server = await startRejectingServer(502)
    const h = makeHarness({
        port: server.port,
        runner: true,
        decision: 'blocked'
    })
    try {
        await h.send()

        // The point of a durable verdict: instance B refuses without spending
        // the handshake instance A already spent.
        assert.equal(server.upgrades, 0)
        assert.equal(h.adapterCalls.length, 0)
        assert.equal(h.terminals.length, 1)
        assert.equal(h.terminals[0].error?.code, SANDBOX_EXEC_UNAVAILABLE_CODE)
        assert.equal(h.terminals[0].error?.retryable, true)
        // The deadline the breaker handed back reaches the user as the one thing
        // they can act on.
        assert.match(h.terminals[0].error?.message ?? '', /try again in about/i)

        // Read-only: a blocked turn is not the fleet's one prober, so it claims
        // nothing, clears nothing and re-arms nothing.
        assert.deepEqual(
            h.health.map((c) => c.method),
            ['admit']
        )
    } finally {
        await server.close()
    }
})

test('the probe winner runs one no-op, and only its success releases the host', async () => {
    const server = await startExitingServer()
    const h = makeHarness({ port: server.port, decision: 'probe' })
    try {
        await h.send()

        // The one command a suspect endpoint is ever asked to run. Replaying the
        // turn's real command would risk running it twice: a failed upgrade does
        // not prove the upstream never accepted the first one.
        assert.deepEqual(server.cmds, [['true']])

        const probe = h.health.find((c) => c.method === 'recordProbe')
        assert.equal(probe?.ok, true)
        // The exact lease object admit handed out, not a recomputed deadline:
        // it is the ownership token the conditional update matches on.
        assert.equal(probe?.lease, h.lease)

        // Recovery is not a terminal — the turn that proved it goes on to run.
        assert.equal(h.adapterCalls.length, 1)
        assert.equal(h.terminals[0].type, 'done')
    } finally {
        await server.close()
    }
})

test('a stale successful probe cannot dispatch user work after losing its lease', async () => {
    const server = await startExitingServer()
    const h = makeHarness({
        port: server.port,
        decision: 'probe',
        recordProbe: 'not_owner'
    })
    try {
        await h.send()

        assert.deepEqual(server.cmds, [['true']])
        assert.equal(h.adapterCalls.length, 0)
        assert.equal(h.terminals[0].error?.code, SANDBOX_EXEC_UNAVAILABLE_CODE)
    } finally {
        await server.close()
    }
})

test('a failed probe re-arms its own lease and dispatches nothing', async () => {
    const server = await startRejectingServer(502)
    const h = makeHarness({ port: server.port, decision: 'probe' })
    try {
        await h.send()

        assert.deepEqual(server.cmds, [['true']])
        const probe = h.health.find((c) => c.method === 'recordProbe')
        assert.equal(probe?.ok, false)
        assert.equal(probe?.lease, h.lease)
        // recordProbe owns the re-arm. A markUnavailable on top would extend a
        // window the prober already set, from the same single observation.
        assert.equal(
            h.health.filter((c) => c.method === 'markUnavailable').length,
            0
        )

        assert.equal(h.adapterCalls.length, 0)
        assert.equal(h.terminals[0].error?.code, SANDBOX_EXEC_UNAVAILABLE_CODE)
    } finally {
        await server.close()
    }
})

// The false-positive boundary, from the probe's side. RunnerManagerService owns
// the same exclusion for the inspect (runner-manager-exec-health.test.ts); this
// is the assertion that the probe did not grow a second, looser opinion.
test('an inconclusive account-wide probe dispatches no user work and reports no health verdict', async () => {
    const server = await startRejectingServer(401)
    const h = makeHarness({ port: server.port, decision: 'probe' })
    try {
        await h.send()

        // A revoked account token is not a sick VM. Reporting it either way
        // would clear a cooldown nothing proved, or quarantine every sprite on
        // that account at once. The lease simply lapses.
        assert.deepEqual(
            h.health.map((c) => c.method),
            ['admit']
        )
        // A health probe already consumed the only safe exec attempt for this
        // turn. Dispatching its real command now would make two execs without a
        // recovery verdict and could duplicate user work under an ambiguous
        // transport failure.
        assert.equal(h.adapterCalls.length, 0)
        assert.equal(h.terminals[0].error?.code, SANDBOX_EXEC_UNAVAILABLE_CODE)
    } finally {
        await server.close()
    }
})

test('prewarm reads the verdict and skips, without taking the probe', async () => {
    const server = await startExitingServer()
    const unhealthy = makeHarness({ port: server.port, unavailable: true })
    const healthy = makeHarness({ port: server.port })
    try {
        await unhealthy.prewarm()
        await healthy.prewarm()

        // A composer focus event per keystroke burst against a 502ing endpoint is
        // how #730 multiplied the wasted handshakes.
        assert.equal(unhealthy.calls.forAgent, 0)
        assert.equal(healthy.calls.forAgent, 1)
        // Read-only, and it must stay that way: spending the fleet's one probe on
        // a background wake would leave the turn behind it with nothing to claim.
        assert.deepEqual(
            unhealthy.health.map((c) => c.method),
            ['isKnownUnavailable']
        )
    } finally {
        await server.close()
    }
})

test('storage measurement reads the verdict and skips, without taking the probe', async () => {
    const unhealthy = storageHarness(true)
    const healthy = storageHarness(false)

    await unhealthy.service.measureHostIfDue(HOST_ID)
    await healthy.service.measureHostIfDue(HOST_ID)

    // Six 8s df/du timeouts per request bought nothing on a VM that is refusing
    // exec. The interval bookkeeping is untouched, so the next due window
    // measures normally once the host is back (#553 / #575 / #580 unchanged).
    assert.equal(unhealthy.accountReads, 0)
    assert.equal(healthy.accountReads, 1)
    assert.deepEqual(
        unhealthy.health.map((c) => c.method),
        ['isKnownUnavailable']
    )
})

test('the terminal exposes no host, sprite, endpoint or command — to the user or to an index', async () => {
    const server = await startRejectingServer(502)
    const h = makeHarness({ port: server.port, runner: true })
    try {
        await h.send()

        const message = h.terminals[0].error?.message ?? ''
        // A user cannot act on a sprite name, a host id or an exec URL, and an
        // incident channel is not where they should leak.
        assert.doesNotMatch(message, /art-|rh_|ldt_|wss?:\/\/|https?:\/\//)
        assert.doesNotMatch(message, /127\.0\.0\.1|authorization|token/i)

        // The transition event is operational identifiers, the decision and the
        // deadline. Pinned as a whitelist: a later field is a deliberate choice,
        // not an accident.
        const [event] = h.named(SPRITE_EXEC_TERMINAL_EVENT)
        assert.equal(h.named(SPRITE_EXEC_TERMINAL_EVENT).length, 1)
        assert.deepEqual(Object.keys(event).sort(), [
            'agentId',
            'failureClass',
            'hostId',
            'phase',
            'retryInMs',
            'upstreamStatus'
        ])
        assert.equal(event.phase, 'runner_inspect')
        assert.equal(event.upstreamStatus, 502)
    } finally {
        await server.close()
    }
})

interface HarnessOptions {
    port: number
    hostId?: string | null
    decision?: SpriteExecDecision
    runner?: boolean
    unavailable?: boolean
    recordProbe?: 'recorded' | 'not_owner' | 'unavailable'
    markUnavailable?: boolean
}

interface Harness {
    adapterCalls: ApiChatAdapterContext[]
    health: HealthCall[]
    streamErrors: Array<{ attrs: Record<string, unknown> }>
    terminals: Array<{
        type: string
        error?: { code: string; message: string; retryable: boolean }
    }>
    calls: {
        upsertTurnExecution: number
        stampedResumeRef: number
        forAgent: number
    }
    lease: Date
    named: (name: string) => Array<Record<string, unknown>>
    send: () => Promise<void>
    prewarm: () => Promise<void>
}

const makeHarness = (opts: HarnessOptions): Harness => {
    const currentAgent = {
        ...agentRow,
        hostId: opts.hostId === undefined ? HOST_ID : opts.hostId
    }
    const insertedMessages: Array<{ id: string; role: string }> = []
    let latestInflight: string | null = null
    const events: Array<{ name: string; props: Record<string, unknown> }> = []
    const streamErrors: Array<{ attrs: Record<string, unknown> }> = []
    const adapterCalls: ApiChatAdapterContext[] = []
    const health: HealthCall[] = []
    const terminals: Harness['terminals'] = []
    const calls = {
        upsertTurnExecution: 0,
        stampedResumeRef: 0,
        forAgent: 0
    }
    const lease = new Date(Date.now() + 20_000)
    let turnFinishedResolve!: () => void
    let turnFinished = new Promise<void>((r) => {
        turnFinishedResolve = r
    })

    const db = {
        select: () => ({
            from: (table: Parameters<typeof getTableName>[0]) => {
                // The runner's own lookup asks runtime_hosts whether a runner
                // daemon already exists for this sprite; answering it with an
                // agent row would hand the turn a runner it never brought up.
                const rows =
                    getTableName(table) === 'runtime_hosts'
                        ? []
                        : [currentAgent]
                return {
                    leftJoin: () => ({
                        where: () => ({ limit: async () => rows })
                    }),
                    where: () => ({ limit: async () => rows })
                }
            }
        }),
        update: (table: Parameters<typeof getTableName>[0]) => {
            if (getTableName(table) === 'chat_messages')
                calls.stampedResumeRef += 1
            return { set: () => ({ where: async () => undefined }) }
        }
    }
    const repo = {
        listOrphanedAssistantMessages: async () => [],
        getSession: async () => sessionRow,
        getSessionById: async () => sessionRow,
        insertMessage: async (row: { id: string; role: string }) => {
            insertedMessages.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length,
            fenceLost: false
        }),
        upsertTurnExecution: async (row: {
            messageId: string
            ownerId: string
        }) => {
            calls.upsertTurnExecution += 1
            return {
                messageId: row.messageId,
                ownerId: row.ownerId,
                generation: 1
            }
        },
        renewTurnLease: async () => true,
        setTurnExecSession: async () => true,
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        clearStaleInflightClaims: async () => 0,
        maxStreamEventSeq: async () => 0n,
        markCancelRequested: async () => undefined,
        findCancelRequestedMessageIds: async () => []
    }
    const record = async (
        _messageId: string,
        event: { type: string; payload?: Record<string, unknown> }
    ): Promise<{ persisted: boolean; fenceLost: boolean }> => {
        if (event.type === 'done' || event.type === 'error') {
            latestInflight = null
            terminals.push(
                event.payload as unknown as Harness['terminals'][number]
            )
        }
        return { persisted: true, fenceLost: false }
    }
    const broadcaster = {
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        hasStream: () => true,
        emit: record,
        emitDetached: record
    }

    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            adapterCalls.push(ctx)
            yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }

    // Mirrors TelemetryService.sanitize, which decides whether an attribute
    // ships at all — asserting on the raw object would call a field present that
    // production drops.
    const shipped = (
        attrs: Record<string, unknown>
    ): Record<string, unknown> => {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(attrs))
            if (value !== undefined && value !== null) out[key] = value
        return out
    }
    const telemetry = {
        event: (name: string, props: Record<string, unknown> = {}) =>
            events.push({ name, props: shipped(props) }),
        error: (name: string, _err: Error, props: Record<string, unknown>) => {
            events.push({ name, props: shipped(props) })
            if (name === 'chat.stream.error')
                streamErrors.push({ attrs: shipped(props) })
        }
    }

    // The durable state machine is proven in sprite-exec-health.pg.test.ts. Here
    // it is recorded rather than run, so what the turn path ASKS and what it
    // does with each answer are the assertions.
    const execHealth = {
        admit: async (hostId: string | null): Promise<SpriteExecAdmission> => {
            health.push({ method: 'admit', hostId })
            const decision = opts.decision ?? 'pass'
            return {
                hostId: hostId as string,
                decision,
                retryAt:
                    decision === 'blocked'
                        ? new Date(Date.now() + 45_000)
                        : null,
                lease: decision === 'probe' ? lease : null
            }
        },
        isKnownUnavailable: async (hostId: string | null) => {
            health.push({ method: 'isKnownUnavailable', hostId })
            return opts.unavailable === true
        },
        markUnavailable: async (failure: {
            hostId: string
            failureClass: string
            upstreamStatus?: number | null
        }) => {
            health.push({ method: 'markUnavailable', ...failure })
            return opts.markUnavailable === false
                ? null
                : new Date(Date.now() + 60_000)
        },
        recordProbe: async (result: {
            hostId: string
            ok: boolean
            lease: Date
        }) => {
            health.push({ method: 'recordProbe', ...result })
            return {
                outcome: opts.recordProbe ?? 'recorded',
                retryAt:
                    result.ok || opts.recordProbe !== undefined
                        ? null
                        : new Date(Date.now() + 60_000)
            }
        }
    }

    const emptyHandle = () => ({
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
        abort: () => {}
    })
    const execDrivers = {
        recoveryFsForAgent: async () => ({
            spritesClient: spritesClientFor(opts.port),
            agent: currentAgent
        }),
        forAgent: async () => {
            calls.forAgent += 1
            return { driver: { stream: () => emptyHandle() } }
        }
    }

    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const runnerManager = new TestRunnerManager(
        db as never,
        {
            isOnline: () => false,
            findById: async () => null
        } as never,
        {
            mint: async () => ({
                tokenId: 't',
                plaintext: 'ldt_secret_value',
                name: 'runner',
                expiresAt: null,
                createdAt: new Date()
            }),
            deleteUnbound: async () => true
        } as never,
        { rpc: async () => ({}) } as never
    )

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        telemetry as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        { findById: async () => null } as never,
        undefined,
        undefined,
        undefined,
        execDrivers as never,
        undefined,
        undefined,
        { ownerId: 'owner-1' } as never,
        runnerManager,
        undefined,
        undefined,
        execHealth as never
    )

    const internals = service as unknown as {
        runAdapter: (...args: unknown[]) => Promise<void>
    }
    const originalRun = internals.runAdapter.bind(service)
    internals.runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await originalRun(...args)
        } finally {
            turnFinishedResolve()
        }
    }

    const withRollout = async (body: () => Promise<void>): Promise<void> => {
        const previous = process.env.MF_SPRITE_RUNNER_AGENTS
        if (opts.runner) process.env.MF_SPRITE_RUNNER_AGENTS = '*'
        else delete process.env.MF_SPRITE_RUNNER_AGENTS
        try {
            await body()
        } finally {
            if (previous === undefined)
                delete process.env.MF_SPRITE_RUNNER_AGENTS
            else process.env.MF_SPRITE_RUNNER_AGENTS = previous
        }
    }

    return {
        adapterCalls,
        health,
        streamErrors,
        terminals,
        calls,
        lease,
        named: (name) =>
            events.filter((e) => e.name === name).map((e) => e.props),
        send: () =>
            withRollout(async () => {
                await service.sendMessage(
                    'user-1',
                    'agent-1',
                    'session-1',
                    'hello',
                    [],
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    () => {}
                )
                // Waits on the run itself rather than on the released claim: the
                // spared turn's terminal and its telemetry are both written
                // inside it.
                await waitBounded(turnFinished)
                turnFinished = new Promise<void>((r) => {
                    turnFinishedResolve = r
                })
            }),
        prewarm: async () => {
            await service.prewarmAgent('user-1', 'agent-1')
            // prewarmAgent answers the request and runs the wake detached, so
            // the assertion has to wait for the microtasks it left behind.
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
    }
}

const storageHarness = (unavailable: boolean) => {
    const health: HealthCall[] = []
    const state = { accountReads: 0 }
    const hostRow = {
        id: HOST_ID,
        userId: 'user-1',
        kind: 'sandbox',
        accountId: 'sac_1',
        spriteName: 'art-abc',
        spriteStatus: 'running',
        storageMeasuredAt: null
    }
    const db = {
        select: () => ({
            from: (table: Parameters<typeof getTableName>[0]) => {
                const list =
                    getTableName(table) === 'runtime_hosts' ? [hostRow] : []
                // The host lookup ends in .limit(1); the per-host agent listing
                // awaits the where() directly, so it has to be both.
                const result = Promise.resolve(list) as Promise<unknown[]> & {
                    limit: () => Promise<unknown[]>
                }
                result.limit = async () => list
                return { where: () => result }
            }
        })
    }
    const accounts = {
        getById: async () => {
            state.accountReads += 1
            return null
        }
    }
    const service = new SpriteStorageService(
        db as never,
        accounts as never,
        { event: () => {}, error: () => {} } as never,
        {
            isKnownUnavailable: async (hostId: string | null) => {
                health.push({ method: 'isKnownUnavailable', hostId })
                return unavailable
            }
        } as never
    )
    return {
        service,
        health,
        get accountReads() {
            return state.accountReads
        }
    }
}

const waitBounded = async (promise: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `turn did not finish within ${BOUND_MS}ms`
                            )
                        ),
                    BOUND_MS
                )
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
