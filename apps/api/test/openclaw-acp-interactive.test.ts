import assert from 'node:assert/strict'
import test from 'node:test'
import type {
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
// _meta.sessionKey (never session/resume), the event mapping, and the
// persisted framework session ref = the gateway key.

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

const buildRig = (): Rig => {
    const requests: InteractiveExecRequest[] = []
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
                stream: () => {
                    throw new Error('one-shot stream must not be used')
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
        { record: () => {} } as never,
        undefined as never,
        adminSettings as never,
        undefined as never,
        permissionCoordinator as never
    )
    return {
        adapter,
        requests,
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

        // The bridge is launched against the loopback gateway with its token.
        assert.equal(rig.requests.length, 1)
        const req = rig.requests[0]
        assert.deepEqual(req.cmd, [
            'openclaw',
            'acp',
            '--url',
            'ws://127.0.0.1:18789',
            '--no-prefix-cwd'
        ])
        assert.equal(req.dir, '/home/sprite/ws')
        assert.equal(req.env?.OPENCLAW_GATEWAY_TOKEN, 'gw-token-123')
        assert.equal(req.env?.OPENCLAW_HIDE_BANNER, '1')

        // session/new pins the deterministic gateway key, and no session/resume.
        const created = rig.writes.find((f) => f.method === 'session/new')!
        const meta = (created.params as { _meta?: { sessionKey?: string } })._meta
        assert.equal(meta?.sessionKey, 'agent:oc1:mf-cts_1')
        assert.ok(!rig.writes.some((f) => f.method === 'session/resume'))

        // The text streams through as a token, and the turn terminalizes.
        assert.ok(
            events.some((e) => e.type === 'token' && e.text === 'Hello from the stub model.')
        )
        assert.ok(events.some((e) => e.type === 'done'))

        // The gateway key is persisted as the framework session ref.
        assert.deepEqual(rig.sessionRefs, [
            { sessionId: 'cts_1', ref: 'agent:oc1:mf-cts_1' }
        ])
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
