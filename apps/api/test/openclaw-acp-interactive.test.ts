import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ExecStreamRequest,
    ExecStreamResult,
    InteractiveExecHandle,
    InteractiveExecRequest
} from '../src/modules/chat/adapters/exec-driver'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// The API-driven openclaw ACP path (MF_OPENCLAW_ACP) end to end: sendMessage
// routing a no-runner sprite turn into sendViaOpenclawAcp, which drives the real
// AcpTurn (OPENCLAW_ACP_DIALECT) over a scripted `openclaw acp` transport. The
// frames replayed here are recorded verbatim from a live openclaw@2026.5.18
// bridge [2026-09-07]. Pins: the cmd + gateway-token env, the deterministic
// _meta.sessionKey (never session/resume), the event mapping, the persisted
// framework session ref = the gateway key, and the post-turn usage read-back
// (`sessions.get` over the one-shot exec seam, recorded [2026-09-08]).

// The bridge is exec'd behind a cat/kill wrapper because it ignores stdin EOF,
// and resolves the loopback gateway from the box's own openclaw.json: an
// explicit --url makes the CLI refuse env/config credentials.
const BRIDGE_SCRIPT =
    'exec openclaw acp --no-prefix-cwd < <(cat; kill -TERM $$)'

// The bridge enters the agent workspace ITSELF (mkdir -p; cd) instead of via
// the exec transport's `dir`. A fresh sprite's workspace is created lazily by
// openclaw, not at bootstrap, and wrapSpriteCommand turns `dir` into
// `cd <dir> && …`, so passing it would exit the shell 1 before openclaw ran.
// Seen on sprites [2026-09-08].
const WORKSPACE = '/home/sprite/ws'
const enterWorkspace = `mkdir -p '${WORKSPACE}' 2>/dev/null; cd '${WORKSPACE}' 2>/dev/null; `
const BRIDGE_CMD = ['bash', '-lc', `${enterWorkspace}${BRIDGE_SCRIPT}`]

// One recorded `sessions.get` result: a 2-call tool-loop turn after an earlier
// 1-call turn, exactly as the gateway transcript hands them back.
const transcriptUsage = (input: number, output: number) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})
const transcriptUser = (text: string) => ({
    role: 'user',
    content: [
        {
            type: 'text',
            text: `Sender (untrusted metadata):\n\`\`\`json\n{"label":"ACP"}\n\`\`\`\n\n${text}`
        }
    ],
    timestamp: 1788822861870
})
const transcriptAssistant = (input: number, output: number, text: string) => ({
    role: 'assistant',
    api: 'openai-completions',
    provider: 'primary',
    model: 'stub-model',
    usage: transcriptUsage(input, output),
    stopReason: 'stop',
    content: [{ type: 'text', text }],
    timestamp: 1788822861885
})
const TOOL_LOOP_TRANSCRIPT = {
    messages: [
        transcriptUser('Say hello.'),
        transcriptAssistant(101, 11, 'Answer from call 1.'),
        transcriptUser('hi'),
        transcriptAssistant(201, 21, 'Running a command (call 2).'),
        {
            role: 'toolResult',
            content: [{ type: 'text', text: 'billing-probe' }],
            timestamp: 1788822872202
        },
        transcriptAssistant(301, 31, 'Answer from call 3.')
    ]
}

interface PushQueue<T> {
    iterable: AsyncIterable<T>
    push(item: T): void
    end(): void
}

const pushQueue = <T>(): PushQueue<T> => {
    const items: T[] = []
    let ended = false
    let notify: (() => void) | null = null
    const wake = (): void => {
        const n = notify
        notify = null
        n?.()
    }
    return {
        iterable: {
            [Symbol.asyncIterator]: async function* () {
                while (true) {
                    while (items.length > 0) yield items.shift()!
                    if (ended) return
                    await new Promise<void>((resolve) => {
                        notify = resolve
                    })
                }
            }
        },
        push: (item: T) => {
            items.push(item)
            wake()
        },
        end: () => {
            ended = true
            wake()
        }
    }
}

interface Rig {
    adapter: OpenclawAdapter
    requests: InteractiveExecRequest[]
    // One-shot execs (the post-turn usage read-back) and what each returned.
    streams: ExecStreamRequest[]
    streamResults: Array<{ stdout: string; exitCode: number }>
    telemetry: Array<{ name: string; attrs: Record<string, unknown> }>
    writes: Array<Record<string, unknown>>
    sessionRefs: Array<{ sessionId: string; ref: string | null }>
    holders: Array<{
        messageId: string
        respond: (r: string, o: string) => 'delivered' | 'unknown'
    }>
    exit: (r: ExecStreamResult) => void
    die: (e: Error) => void
    waitFor: (method: string) => Promise<Record<string, unknown>>
    reply: (frame: Record<string, unknown>) => void
    note: (update: Record<string, unknown>) => void
}

const buildRig = (
    opts: { streamResults?: Array<{ stdout: string; exitCode: number }> } = {}
): Rig => {
    const requests: InteractiveExecRequest[] = []
    const streams: ExecStreamRequest[] = []
    const streamResults = [
        ...(opts.streamResults ?? [
            { stdout: JSON.stringify(TOOL_LOOP_TRANSCRIPT), exitCode: 0 }
        ])
    ]
    const telemetry: Array<{ name: string; attrs: Record<string, unknown> }> =
        []
    const writes: Array<Record<string, unknown>> = []
    const waiters: Array<{
        method: string
        resolve: (f: Record<string, unknown>) => void
    }> = []
    const stdout = pushQueue<string>()
    const stderr = pushQueue<string>()
    let settled = false
    let resolveResult!: (r: ExecStreamResult) => void
    let rejectResult!: (e: Error) => void
    const result = new Promise<ExecStreamResult>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
    })
    const settleExit = (r: ExecStreamResult): void => {
        if (settled) return
        settled = true
        stdout.end()
        stderr.end()
        resolveResult(r)
    }
    const settleFail = (e: Error): void => {
        if (settled) return
        settled = true
        stdout.end()
        stderr.end()
        rejectResult(e)
    }
    const handle: InteractiveExecHandle = {
        stdout: stdout.iterable,
        stderr: stderr.iterable,
        write: (data: Buffer) => {
            for (const raw of data.toString('utf8').split('\n')) {
                if (!raw.trim()) continue
                const frame = JSON.parse(raw) as Record<string, unknown>
                writes.push(frame)
                const idx = waiters.findIndex((w) => w.method === frame.method)
                if (idx !== -1) waiters.splice(idx, 1)[0].resolve(frame)
            }
        },
        endInput: () => settleExit({ exitCode: 0, stdout: '', stderr: '' }),
        result,
        abort: () => settleFail(new Error('transport aborted'))
    }
    const drivers = {
        forAgent: async () => ({
            driver: {
                // The one-shot seam serves the scripted `sessions.get` results
                // in order; running out is a rig bug, not a turn outcome.
                stream: (req: ExecStreamRequest) => {
                    streams.push(req)
                    const scripted = streamResults.shift()
                    if (!scripted)
                        throw new Error(
                            'unexpected one-shot exec: no scripted result'
                        )
                    return {
                        stdout: (async function* () {
                            yield scripted.stdout
                        })(),
                        stderr: (async function* (): AsyncGenerator<string> {})(),
                        result: Promise.resolve({
                            exitCode: scripted.exitCode,
                            stdout: scripted.stdout,
                            stderr: ''
                        }),
                        abort: () => {}
                    }
                },
                streamInteractive: (req: InteractiveExecRequest) => {
                    requests.push(req)
                    return handle
                }
            },
            creds: {},
            runtime: 'sprites',
            agent: { id: 'agt_1', workspacePath: '/home/sprite/ws', extras: null }
        })
    }
    // resolveRuntime selects from agents then agentCredentials; the mock returns
    // a superset agent row, and a creds row for the credentials table.
    const db = {
        select: () => ({
            from: (table: unknown) => ({
                where: () => ({
                    limit: async () => {
                        const name = String(
                            (table as { [k: string]: unknown } | undefined)?.[
                                Symbol.for('drizzle:Name') as unknown as string
                            ] ?? ''
                        )
                        if (name === 'agent_credentials')
                            return [
                                { payloadCiphertext: 'x', keyVersion: 1 }
                            ]
                        return [
                            {
                                runtime: 'sprites',
                                internalId: 'oc1',
                                daemonId: null,
                                ingressHost: 'agt.example.com',
                                runtimeId: 'art_1',
                                framework: 'openclaw',
                                name: 'My Agent'
                            }
                        ]
                    }
                })
            })
        })
    }
    const crypto = {
        decrypt: () =>
            JSON.stringify({
                gatewayToken: 'gw-token-123',
                primaryModelName: 'stub-model'
            })
    }
    const sessionRefs: Array<{ sessionId: string; ref: string | null }> = []
    const chatRepo = {
        updateFrameworkSessionRef: async (
            sessionId: string,
            ref: string | null
        ) => {
            sessionRefs.push({ sessionId, ref })
        }
    }
    const adminSettings = {
        getCachedChatExecTimeoutMs: async () => ({
            keepAliveMs: 1_000,
            livenessTimeoutMs: 1_000,
            timeoutMs: 60_000
        })
    }
    const holders: Array<{
        messageId: string
        respond: (r: string, o: string) => 'delivered' | 'unknown'
    }> = []
    const permissionCoordinator = {
        register: (
            messageId: string,
            holder: {
                respond: (r: string, o: string) => 'delivered' | 'unknown'
                pendingIds: () => string[]
            }
        ) => {
            holders.push({ messageId, respond: holder.respond })
            return () => {}
        }
    }
    const adapter = new OpenclawAdapter(
        db as never,
        crypto as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        chatRepo as never,
        drivers as never,
        {
            record: () => {},
            event: (name: string, attrs: Record<string, unknown>) => {
                telemetry.push({ name, attrs })
            }
        } as never,
        undefined as never,
        adminSettings as never,
        undefined as never,
        permissionCoordinator as never
    )
    return {
        adapter,
        requests,
        streams,
        streamResults,
        telemetry,
        writes,
        sessionRefs,
        holders,
        exit: settleExit,
        die: settleFail,
        waitFor: (method) => {
            const already = writes.find((f) => f.method === method)
            if (already) return Promise.resolve(already)
            return new Promise((resolve) => waiters.push({ method, resolve }))
        },
        reply: (frame) => stdout.push(`${JSON.stringify(frame)}\n`),
        note: (update) =>
            stdout.push(
                `${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: { update }
                })}\n`
            )
    }
}

const ctx = (
    extra: Partial<ApiChatAdapterContext> = {}
): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'openclaw',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        frameworkSessionRef: null,
        history: [],
        ...extra
    }) as ApiChatAdapterContext

const USER_MSG = {
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

test('a no-runner sprite openclaw turn runs the ACP conversation over the interactive transport', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig()
        void (async () => {
            const init = await rig.waitFor('initialize')
            rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
            const create = await rig.waitFor('session/new')
            rig.reply({
                jsonrpc: '2.0',
                id: create.id,
                result: { sessionId: 'db72f14f-live' }
            })
            const prompt = await rig.waitFor('session/prompt')
            // Recorded openclaw bridge frames.
            rig.note({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Hello from the stub model.' }
            })
            rig.reply({
                jsonrpc: '2.0',
                id: prompt.id,
                result: { stopReason: 'end_turn' }
            })
        })()

        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))

        // The bridge is launched against the loopback gateway with its token,
        // behind the wrapper that makes stdin EOF terminate it.
        assert.equal(rig.requests.length, 1)
        const req = rig.requests[0]
        assert.deepEqual(req.cmd, BRIDGE_CMD)
        // No `dir`: the bridge enters the workspace itself, so the transport
        // must NOT prepend `cd <workspace> && …` (absent on a fresh sprite → the
        // shell would exit 1 before openclaw, the ~300ms empty-stderr failure).
        assert.equal(req.dir, undefined)
        assert.equal(req.env?.OPENCLAW_GATEWAY_TOKEN, 'gw-token-123')
        assert.equal(req.env?.OPENCLAW_HIDE_BANNER, '1')

        // session/new pins the deterministic gateway key, and no session/resume.
        // The agent slot is `main` (the sprite gateway's only agent), NOT the
        // manyfold internalId 'oc1' — binding to the id fails "Agent <id> no
        // longer exists in configuration". Seen on sprites [2026-09-08].
        const created = rig.writes.find((f) => f.method === 'session/new')!
        const meta = (created.params as { _meta?: { sessionKey?: string } })._meta
        assert.equal(meta?.sessionKey, 'agent:main:mf-cts_1')
        assert.ok(!rig.writes.some((f) => f.method === 'session/resume'))

        // The text streams through as a token, and the turn terminalizes.
        assert.ok(
            events.some((e) => e.type === 'token' && e.text === 'Hello from the stub model.')
        )
        assert.ok(events.some((e) => e.type === 'done'))

        // The gateway key is persisted as the framework session ref.
        assert.deepEqual(rig.sessionRefs, [
            { sessionId: 'cts_1', ref: 'agent:main:mf-cts_1' }
        ])

        // Billing: the ACP stream carried no usage, so the turn read it back
        // from the gateway transcript — one in-box sessions.get on its key —
        // and the SUM of this turn's two model calls precedes done.
        assert.equal(rig.streams.length, 1)
        assert.deepEqual(rig.streams[0].cmd, [
            'openclaw',
            'gateway',
            'call',
            'sessions.get',
            '--params',
            JSON.stringify({ key: 'agent:main:mf-cts_1', limit: 60 }),
            '--json',
            '--timeout',
            '10000'
        ])
        assert.equal(rig.streams[0].env?.OPENCLAW_GATEWAY_TOKEN, 'gw-token-123')
        const usageIdx = events.findIndex((e) => e.type === 'usage')
        const doneIdx = events.findIndex((e) => e.type === 'done')
        assert.ok(usageIdx !== -1 && usageIdx < doneIdx)
        const usageEvent = events[usageIdx]
        assert.equal(usageEvent.type, 'usage')
        if (usageEvent.type === 'usage') {
            assert.equal(usageEvent.usage.inputTokens, 502)
            assert.equal(usageEvent.usage.outputTokens, 52)
            assert.equal(usageEvent.usage.model, 'stub-model')
        }
        const recorded = rig.telemetry.find(
            (t) => t.name === 'openclaw_acp_usage'
        )
        assert.equal(recorded?.attrs['nca.outcome'], 'ok')
        assert.equal(recorded?.attrs['nca.provider_calls'], 2)
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

const scriptCleanTurn = (rig: Rig): void => {
    void (async () => {
        const init = await rig.waitFor('initialize')
        rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
        const create = await rig.waitFor('session/new')
        rig.reply({
            jsonrpc: '2.0',
            id: create.id,
            result: { sessionId: 'sess-usage' }
        })
        const prompt = await rig.waitFor('session/prompt')
        rig.reply({
            jsonrpc: '2.0',
            id: prompt.id,
            result: { stopReason: 'end_turn' }
        })
    })()
}

test('a usage read-back that fails never fails the turn — it is logged and counted', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            streamResults: [
                { stdout: 'gateway call failed: ECONNREFUSED', exitCode: 1 }
            ]
        })
        scriptCleanTurn(rig)
        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
        assert.equal(rig.streams.length, 1)
        assert.ok(!events.some((e) => e.type === 'usage'))
        assert.ok(!events.some((e) => e.type === 'error'))
        assert.ok(events.some((e) => e.type === 'done'))
        const recorded = rig.telemetry.find(
            (t) => t.name === 'openclaw_acp_usage'
        )
        assert.equal(recorded?.attrs['nca.outcome'], 'error')
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('a turn whose prompt is not the transcript tail is not billed (a bridge-answered command wrote nothing)', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            streamResults: [
                {
                    stdout: JSON.stringify({
                        messages: [
                            transcriptUser('Say hello.'),
                            transcriptAssistant(101, 11, 'Answer from call 1.')
                        ]
                    }),
                    exitCode: 0
                }
            ]
        })
        scriptCleanTurn(rig)
        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
        // Billing that tail again would charge the previous turn twice.
        assert.ok(!events.some((e) => e.type === 'usage'))
        assert.ok(events.some((e) => e.type === 'done'))
        const recorded = rig.telemetry.find(
            (t) => t.name === 'openclaw_acp_usage'
        )
        assert.equal(recorded?.attrs['nca.outcome'], 'prompt_mismatch')
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('a turn longer than the usage window is re-read once at the wide limit', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        // 60 assistant messages and no user anchor: the window is full.
        const fullWindow = {
            messages: Array.from({ length: 60 }, () =>
                transcriptAssistant(1, 1, 'step')
            )
        }
        const wide = {
            messages: [
                transcriptUser('hi'),
                ...Array.from({ length: 70 }, () =>
                    transcriptAssistant(10, 1, 'step')
                )
            ]
        }
        const rig = buildRig({
            streamResults: [
                { stdout: JSON.stringify(fullWindow), exitCode: 0 },
                { stdout: JSON.stringify(wide), exitCode: 0 }
            ]
        })
        scriptCleanTurn(rig)
        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
        assert.equal(rig.streams.length, 2)
        const limits = rig.streams.map(
            (s) => (JSON.parse(s.cmd[5]) as { limit: number }).limit
        )
        assert.deepEqual(limits, [60, 400])
        const usage = events.find((e) => e.type === 'usage') as
            | { usage: { inputTokens: number; outputTokens: number } }
            | undefined
        assert.equal(usage?.usage.inputTokens, 700)
        assert.equal(usage?.usage.outputTokens, 70)
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('with the flag OFF the openclaw turn never launches the ACP bridge', async () => {
    delete process.env.MF_OPENCLAW_ACP
    const rig = buildRig()
    // Pre-aborted so the gateway-http path short-circuits without a real fetch;
    // we only assert the ACP bridge cmd was never requested.
    const ac = new AbortController()
    ac.abort()
    await drain(
        rig.adapter.sendMessage(ctx({ abortSignal: ac.signal }), USER_MSG)
    ).catch(() => {})
    assert.equal(
        rig.requests.filter((r) => (r.cmd ?? []).includes('acp')).length,
        0
    )
})

test('the default permission mode patches execAsk in the wrapper and surfaces an answerable card', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig()
        void (async () => {
            const init = await rig.waitFor('initialize')
            rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
            const create = await rig.waitFor('session/new')
            rig.reply({
                jsonrpc: '2.0',
                id: create.id,
                result: { sessionId: 'sess-perm' }
            })
            await rig.waitFor('session/prompt')
            // The gateway relays an exec approval as an agent->client request.
            rig.reply({
                jsonrpc: '2.0',
                id: 900,
                method: 'session/request_permission',
                params: {
                    toolCall: {
                        toolCallId: 'exec:1',
                        title: 'Command approval requested',
                        rawInput: { command: 'echo hi > /tmp/x' }
                    },
                    options: [
                        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
                    ]
                }
            })
        })()

        const events: EmittedChatEvent[] = []
        const it = rig.adapter.sendMessage(
            ctx({ openclawPermissionMode: 'default' }),
            USER_MSG
        )
        // Drain in the background so we can answer the card mid-turn.
        const done = (async () => {
            for await (const ev of it) {
                events.push(ev)
                if (ev.type === 'permission_request') {
                    // The coordinator routes the answer back to the turn.
                    assert.equal(rig.holders.length, 1)
                    rig.holders[0].respond(ev.requestId, 'allow-once')
                    // Resolve the prompt so the turn can finish.
                    const prompt = rig.writes.find(
                        (f) => f.method === 'session/prompt'
                    )!
                    rig.reply({
                        jsonrpc: '2.0',
                        id: prompt.id,
                        result: { stopReason: 'end_turn' }
                    })
                }
            }
        })()
        await done

        // The exec cmd is the bash wrapper that pre-patches execAsk.
        const req = rig.requests[0]
        assert.equal(req.cmd?.[0], 'bash')
        assert.match(String(req.cmd?.[2]), /gateway call sessions\.patch/)
        assert.match(String(req.cmd?.[2]), /execAsk/)
        assert.match(String(req.cmd?.[2]), /exec openclaw acp/)

        // The card surfaced and was answered through the coordinator.
        const ask = events.find((e) => e.type === 'permission_request')
        assert.ok(ask)
        assert.equal(
            (ask as { options: Array<{ kind: string }> }).options[0].kind,
            'allow_once'
        )
        // The client wrote the selected answer back to the bridge.
        const answered = rig.writes.find(
            (f) =>
                f.result &&
                JSON.stringify(f.result).includes('allow-once')
        )
        assert.ok(answered)
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('a per-message model pick is applied via the wrapper sessions.patch', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig()
        void (async () => {
            const init = await rig.waitFor('initialize')
            rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
            const create = await rig.waitFor('session/new')
            rig.reply({
                jsonrpc: '2.0',
                id: create.id,
                result: { sessionId: 'sess-model' }
            })
            const prompt = await rig.waitFor('session/prompt')
            rig.reply({
                jsonrpc: '2.0',
                id: prompt.id,
                result: { stopReason: 'end_turn' }
            })
        })()

        await drain(
            rig.adapter.sendMessage(
                ctx({ modelOverride: 'anthropic/claude-x' }),
                USER_MSG
            )
        )

        const req = rig.requests[0]
        assert.equal(req.cmd?.[0], 'bash')
        // The gateway registers catalog models under the `primary` provider, so
        // the pick routes as primary/<model>; the provider then serves it
        // (verified passthrough, so no catalog registration is needed).
        assert.match(
            String(req.cmd?.[2]),
            /sessions\.patch.*"model":"primary\/anthropic\/claude-x"/
        )
        // No ask mode was set, so execAsk is absent.
        assert.ok(!String(req.cmd?.[2]).includes('execAsk'))
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('a gateway JSON-RPC error surfaces its data.details, not just "Internal error"', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig()
        void (async () => {
            const init = await rig.waitFor('initialize')
            rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
            const create = await rig.waitFor('session/new')
            rig.reply({
                jsonrpc: '2.0',
                id: create.id,
                result: { sessionId: 'sess-err' }
            })
            const prompt = await rig.waitFor('session/prompt')
            // The gateway's generic top-level message with the real cause in
            // data.details — the shape the openclaw gateway returns on a
            // provider/model failure.
            rig.reply({
                jsonrpc: '2.0',
                id: prompt.id,
                error: {
                    code: -32603,
                    message: 'Internal error',
                    data: { details: 'model gpt-5.6-terra: provider rejected the request' }
                }
            })
        })()

        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
        const err = events.find((e) => e.type === 'error') as
            | { error: { message: string } }
            | undefined
        assert.ok(err, 'expected an error event')
        assert.match(err!.error.message, /provider rejected the request/)
        assert.match(err!.error.message, /Internal error/)
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})
