import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// Runner transport routing: a runner turn changes only the TRANSPORT.
// Everything the adapter derives from `runtime` (credential injection,
// workspace cwd, model config) must keep its sprite meaning, because the daemon
// exec RPC forwards env/stdin/cwd — verified against the CLI's exec handler.
// Two things do change and both are deliberate, so they are pinned here.

interface StreamCall {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    dir?: string
    execHandle?: string
}

const buildHarness = () => {
    const calls: { driver: string; req: StreamCall }[] = []
    const resumes: { driver: string; refId: string; fromSeq: number }[] = []
    const emptyHandle = () => ({
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
        abort: () => {}
    })
    const makeDriver = (label: string) => ({
        stream: (req: StreamCall) => {
            calls.push({ driver: label, req })
            return emptyHandle()
        },
        resumeStream: (req: { refId: string; fromSeq: number }) => {
            resumes.push({ driver: label, ...req })
            return emptyHandle()
        }
    })
    const drivers = {
        forAgent: async () => ({
            driver: makeDriver('sprite'),
            creds: {
                anthropicBaseUrl: 'https://anthropic.example',
                anthropicAuthToken: 'sk-test'
            },
            runtime: 'sprites' as const,
            agent: {
                id: 'agt_1',
                daemonId: null,
                workspacePath: '/home/sprite/.manyfold/workspaces/agt_1'
            }
        }),
        daemonDriverFor: (daemonId: string) => makeDriver(`runner:${daemonId}`)
    }
    const adminSettings = {
        isFeatureEnabled: async () => true,
        getCachedChatExecTimeoutMs: async () => ({
            timeoutMs: 1000,
            keepAliveMs: 1000,
            livenessTimeoutMs: 1000
        })
    }
    const adapter = new ClaudeCodeAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        adminSettings as never
    )
    return { adapter, calls, resumes }
}

const ctx = (extra: Partial<ApiChatAdapterContext> = {}): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'claude-code',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        ...extra
    }) as ApiChatAdapterContext

const drain = async (adapter: ClaudeCodeAdapter, c: ApiChatAdapterContext) => {
    for await (const _ of adapter.sendMessage(c, {
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }]
    } as never)) {
        void _
    }
}

test('without a runner the turn keeps using the sprite driver', async () => {
    const h = buildHarness()
    await drain(h.adapter, ctx())
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].driver, 'sprite')
    assert.equal(h.calls[0].req.execHandle, undefined)
})

test('with a runner the turn goes to that runner over the daemon transport', async () => {
    const h = buildHarness()
    await drain(h.adapter, ctx({ runnerDaemonId: 'dh_runner' }))
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].driver, 'runner:dh_runner')
})

test('a runner turn keeps sprite credential injection and workspace cwd', async () => {
    const h = buildHarness()
    await drain(h.adapter, ctx({ runnerDaemonId: 'dh_runner' }))
    const req = h.calls[0].req
    // WHY: routing must not flip the adapter into daemon-runtime semantics —
    // a sprite has no standing claude credentials, so dropping the injected env
    // would fail every runner turn.
    assert.equal(req.env?.ANTHROPIC_AUTH_TOKEN, 'sk-test')
    assert.equal(req.dir, '/home/sprite/.manyfold/workspaces/agt_1')
    // The prompt stays on stdin (the daemon exec RPC writes payload.stdin to
    // the child), so long prompts are unaffected by argv limits.
    assert.equal(req.stdin, 'hi')
    assert.ok(!req.cmd.includes('hi'), 'prompt must not be in argv')
})

test('a runner turn is block-level and carries the messageId as its refId', async () => {
    const h = buildHarness()
    await drain(h.adapter, ctx({ runnerDaemonId: 'dh_runner' }))
    const req = h.calls[0].req
    // execHandle == messageId is what makes the stream findable by the resume
    // path (it matches daemon_exec_ref).
    assert.equal(req.execHandle, 'msg_1')
    // Deliberately NOT token-level: MF_RUNNER_DELTA_STREAM defaults off, so a
    // runner turn stays block-level. The exact resume cursor made delta safe
    // here; the default is a rollout choice, not a safety gate.
    assert.ok(
        !req.cmd.includes('--include-partial-messages'),
        'a runner turn must stay block-level'
    )
})

// Switching this flag after import used to be invisible: the adapter
// snapshotted MF_RUNNER_DELTA_STREAM at module load, so the existing
// same-process coverage could only exercise the default-off side. Reading it
// per call makes both sides assertable here, and pinning the flip in both
// directions prevents the module-load snapshot from coming back.
test('a runner turn follows MF_RUNNER_DELTA_STREAM flips within one process', async (t) => {
    const previous = process.env.MF_RUNNER_DELTA_STREAM
    t.after(() => {
        if (previous === undefined) delete process.env.MF_RUNNER_DELTA_STREAM
        else process.env.MF_RUNNER_DELTA_STREAM = previous
    })

    delete process.env.MF_RUNNER_DELTA_STREAM
    const unset = buildHarness()
    await drain(unset.adapter, ctx({ runnerDaemonId: 'dh_runner' }))
    assert.ok(
        !unset.calls[0].req.cmd.includes('--include-partial-messages'),
        'unset must stay block-level'
    )

    // Mixed case on purpose: the accepted values are 1/true/yes compared
    // case-insensitively, so an operator's `YES` has to opt in like `1`.
    process.env.MF_RUNNER_DELTA_STREAM = 'YES'
    const on = buildHarness()
    await drain(on.adapter, ctx({ runnerDaemonId: 'dh_runner' }))
    assert.ok(
        on.calls[0].req.cmd.includes('--include-partial-messages'),
        'the same process must observe the flag turning on'
    )

    process.env.MF_RUNNER_DELTA_STREAM = '0'
    const off = buildHarness()
    await drain(off.adapter, ctx({ runnerDaemonId: 'dh_runner' }))
    assert.ok(
        !off.calls[0].req.cmd.includes('--include-partial-messages'),
        'a rollback must take effect without a restart'
    )
})

test('a sprite turn without a runner still gets token-level streaming', async () => {
    const h = buildHarness()
    await drain(h.adapter, ctx())
    // WHY: the routing change must not regress the streaming behaviour of every
    // sprite turn that is NOT opted in.
    assert.ok(h.calls[0].req.cmd.includes('--include-partial-messages'))
})

// The routing above only runs if chat.service actually RESOLVES a runner, and
// that resolution reads ids the tests above never exercised. It shipped broken:
// the helper took the agent-context object, which has framework/runtime/
// spriteName but NO agentId or userId, so the allowlist check silently missed
// and every opted-in turn quietly fell back to sprite exec — with no log line,
// because the guard returns before logging. The staging drill caught it; this
// pins the contract so a rename cannot re-break it.
test('the runner resolver is called with the ids it needs, not the agent context', async () => {
    const { ChatService } = await import('../src/modules/chat/chat.service')
    const seen: Array<Record<string, unknown>> = []
    const service = Object.create(ChatService.prototype) as {
        resolveSpriteRunner: (a: {
            agentId: string
            userId: string
            runtime: string
            spriteName: string | null
            workspacePath?: string | null
        }) => Promise<{
            runner: { daemonId: string; exec: unknown } | null
            execFailure?: unknown
        }>
        runnerManager?: unknown
        execDrivers?: unknown
        telemetry?: unknown
    }
    service.runnerManager = {
        ensureRunner: async (a: Record<string, unknown>) => {
            seen.push(a)
            return {
                handle: { daemonId: 'dh_runner', started: false },
                workspace: { outcome: 'ensured' }
            }
        }
    }
    // telemetry is a required constructor dep in production; this service is
    // built with Object.create, so the stub has to supply it.
    service.telemetry = { event: () => {} }
    service.execDrivers = {
        recoveryFsForAgent: async () => ({
            spritesClient: {},
            agent: { userId: 'user-1' }
        })
    }

    process.env.MF_SPRITE_RUNNER_AGENTS = 'agt_optedin'
    try {
        const resolved = await service.resolveSpriteRunner({
            agentId: 'agt_optedin',
            userId: 'user-1',
            runtime: 'sprites',
            spriteName: 'art-abc',
            workspacePath: '/home/sprite/.narranexus'
        })
        assert.equal(resolved.runner?.daemonId, 'dh_runner')
        // The exec closure comes back with it so the turn can release the
        // sprite-awake lease through the same channel it acquired it on.
        assert.equal(typeof resolved.runner?.exec, 'function')
        assert.equal(seen.length, 1)
        assert.equal(seen[0].agentId, 'agt_optedin')
        assert.equal(seen[0].userId, 'user-1')
        assert.equal(seen[0].spriteName, 'art-abc')
        // The workspace has to ride along: ensureRunner registers a custom
        // workspace with the runner daemon, whose exec guard would otherwise
        // refuse the turn's cwd (`outside allowed roots`, staging 2026-08-04).
        assert.equal(seen[0].workspacePath, '/home/sprite/.narranexus')
        // And the first exec carries the health budget rather than the 60s
        // inspect default (#730): an endpoint that fails the upgrade burns the
        // whole bound before the user hears anything, so the bound is the
        // user-visible cost of the fault.
        assert.equal(typeof seen[0].firstExecTimeoutMs, 'number')
        assert.ok((seen[0].firstExecTimeoutMs as number) < 60_000)

        // An agent that is not on the list must not touch its sprite at all.
        const other = await service.resolveSpriteRunner({
            agentId: 'agt_other',
            userId: 'user-1',
            runtime: 'sprites',
            spriteName: 'art-xyz'
        })
        assert.equal(other.runner, null)
        // No runner AND no classified failure: an opted-out agent proves nothing
        // about its endpoint, so nothing may be quarantined on its behalf.
        assert.equal(other.execFailure, undefined)
        assert.equal(seen.length, 1)
    } finally {
        delete process.env.MF_SPRITE_RUNNER_AGENTS
    }
})

// '*' is the full-rollout switch: after the restart drills proved the runner
// path for every framework, prod flips one value instead of enumerating every
// agent id ever created. Only the exact single '*' widens the gate — a '*'
// embedded in a list stays a literal id, so a stray character in an allowlist
// edit cannot silently enrol everyone.
test("the '*' allowlist value opts every sprite agent in", async () => {
    const { ChatService } = await import('../src/modules/chat/chat.service')
    const service = Object.create(ChatService.prototype) as {
        resolveSpriteRunner: (a: {
            agentId: string
            userId: string
            runtime: string
            spriteName: string | null
        }) => Promise<{
            runner: { daemonId: string; exec: unknown } | null
            execFailure?: unknown
        }>
        runnerManager?: unknown
        execDrivers?: unknown
        telemetry?: unknown
    }
    service.runnerManager = {
        ensureRunner: async () => ({
            handle: { daemonId: 'dh_runner', started: false },
            workspace: { outcome: 'none' }
        })
    }
    service.telemetry = { event: () => {} }
    service.execDrivers = {
        recoveryFsForAgent: async () => ({
            spritesClient: {},
            agent: { userId: 'user-1' }
        })
    }

    try {
        process.env.MF_SPRITE_RUNNER_AGENTS = '*'
        const resolved = await service.resolveSpriteRunner({
            agentId: 'agt_never_listed',
            userId: 'user-1',
            runtime: 'sprites',
            spriteName: 'art-abc'
        })
        assert.equal(resolved.runner?.daemonId, 'dh_runner')

        process.env.MF_SPRITE_RUNNER_AGENTS = 'agt_a,*'
        const listed = await service.resolveSpriteRunner({
            agentId: 'agt_never_listed',
            userId: 'user-1',
            runtime: 'sprites',
            spriteName: 'art-abc'
        })
        assert.equal(listed.runner, null)
    } finally {
        delete process.env.MF_SPRITE_RUNNER_AGENTS
    }
})

// The routing above gets a runner turn STARTED. Getting it FINISHED after an
// api restart is the whole point, and that runs through resumeMessage — which
// resolved its driver from the AGENT's runtime and bailed out with
// `claude_resume_unsupported` for anything that was not runtime=daemon. A
// runner turn is runtime=sprites with a null agent.daemonId, so every runner
// turn was silently unresumable: the one property the runner exists to
// provide. The buffer lives on the daemon that reported the stream, so that
// is the only correct driver.
test('a runner turn resumes against the daemon that reported it', async () => {
    const h = buildHarness()
    const events: EmittedChatEvent[] = []
    for await (const ev of h.adapter.resumeMessage!({
        ...ctx(),
        daemonId: 'dh_runner',
        daemonExecRef: 'msg_1',
        fromSeq: 7
    } as never)) {
        events.push(ev as EmittedChatEvent)
    }
    assert.equal(h.resumes.length, 1)
    assert.equal(h.resumes[0].driver, 'runner:dh_runner')
    assert.equal(h.resumes[0].refId, 'msg_1')
    // The cursor has to survive the hop: replaying from 0 is the safe fallback,
    // not the contract.
    assert.equal(h.resumes[0].fromSeq, 7)
    assert.ok(
        !events.some(
            (e) =>
                e.type === 'error' &&
                e.error.code === 'claude_resume_unsupported'
        ),
        'a sprites agent must not be refused a resume'
    )
})
