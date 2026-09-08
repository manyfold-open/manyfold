import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// The BYOD daemon ACP path (ADR-0027, O6): a daemon openclaw turn dispatched as
// turn.start with the ACP payload, whose frames the daemon replays. Routing
// (transport choice, no payload env, fallback, resume) is pinned by the
// exec-env turn-rpc matrix; this pins the DECODE — that ACP frames become
// tokens, the final's read-back usage becomes a usage event, and the gateway
// key is persisted — plus the payload the API assembles for the ask mode.

const noteLine = (text: string): string =>
    `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text }
            }
        }
    })}\n`

interface StreamCall {
    daemonId: string
    method: string
    payload: Record<string, unknown>
    refIdOverride?: string
    onEvent?: (kind: string, data: string, seq?: number) => void
}

const buildRig = (script: {
    lines: string[]
    result: { ok: Record<string, unknown> | undefined } | { error: string }
    clientFeatures?: string[]
}) => {
    const calls: StreamCall[] = []
    const sessionRefs: Array<{ sessionId: string; ref: string | null }> = []
    const registry = {
        streamRpc: (args: StreamCall) => {
            calls.push(args)
            for (const line of script.lines) args.onEvent?.('stdout', line, 0)
            return {
                refId: args.refIdOverride ?? 'ref_test',
                result:
                    'ok' in script.result
                        ? Promise.resolve(script.result.ok)
                        : Promise.reject(new Error(script.result.error)),
                cancel: () => {}
            }
        }
    }
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
                        if (name === 'runtime_hosts')
                            return [
                                {
                                    clientFeatures: script.clientFeatures ?? [
                                        'turn.openclaw.acp'
                                    ]
                                }
                            ]
                        // agents row
                        return [
                            {
                                runtime: 'daemon',
                                internalId: 'oc1',
                                daemonId: 'dh_byod'
                            }
                        ]
                    }
                })
            })
        })
    }
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
    const adapter = new OpenclawAdapter(
        db as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        chatRepo as never,
        {} as never,
        { event: () => {} } as never,
        registry as never,
        adminSettings as never
    )
    return { adapter, calls, sessionRefs }
}

const ctx = (extra: Partial<ApiChatAdapterContext> = {}): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'openclaw',
        runtimeKind: 'daemon',
        model: null,
        modelOverride: null,
        frameworkSessionRef: null,
        openclawPermissionMode: null,
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

const finalWithUsage = (stopReason: string | null) => ({
    stopReason,
    sessionId: 'sess_oc_1',
    usage: {
        inputTokens: 101,
        outputTokens: 11,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        calls: 1,
        model: 'stub-model',
        provider: 'primary'
    },
    usageStatus: 'ok'
})

test('a daemon ACP turn decodes frames to tokens, bills the read-back usage, persists the key', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            lines: [noteLine('hel'), noteLine('lo')],
            result: { ok: finalWithUsage('end_turn') }
        })
        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))

        // It dispatched turn.start with the ACP payload, keyed and ref-pinned.
        assert.equal(rig.calls.length, 1)
        assert.equal(rig.calls[0].method, 'turn.start')
        assert.equal(rig.calls[0].refIdOverride, 'msg_1')
        const payload = rig.calls[0].payload
        assert.equal(payload.transport, 'acp')
        assert.equal(payload.sessionKey, 'agent:main:mf-cts_1')
        assert.equal('patch' in payload, false) // dontAsk, no model → no patch
        assert.equal(payload.env, undefined) // never an env channel

        // Frames became tokens; the read-back usage became a usage event; done.
        const tokens = events
            .filter((e) => e.type === 'token')
            .map((e) => (e as { text: string }).text)
            .join('')
        assert.equal(tokens, 'hello')
        const usage = events.find((e) => e.type === 'usage') as
            | { usage: { inputTokens: number; outputTokens: number } }
            | undefined
        assert.equal(usage?.usage.inputTokens, 101)
        assert.equal(usage?.usage.outputTokens, 11)
        assert.ok(events.some((e) => e.type === 'done'))

        // The gateway key is persisted as the framework session ref.
        assert.deepEqual(rig.sessionRefs, [
            { sessionId: 'cts_1', ref: 'agent:main:mf-cts_1' }
        ])
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('the ask mode and a model pick ride the payload as a sessions.patch', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            lines: [noteLine('ok')],
            result: { ok: finalWithUsage('end_turn') }
        })
        await drain(
            rig.adapter.sendMessage(
                ctx({ openclawPermissionMode: 'default', modelOverride: 'claude-x' }),
                USER_MSG
            )
        )
        const patch = rig.calls[0].payload.patch as
            | { execAsk?: string; model?: string }
            | undefined
        assert.equal(patch?.execAsk, 'on-miss')
        assert.equal(patch?.model, 'primary/claude-x')
        assert.equal(rig.calls[0].payload.permissionMode, 'default')
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('a turn that ends without a stopReason suspends rather than terminalizing', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            lines: [noteLine('partial')],
            result: { ok: finalWithUsage(null) }
        })
        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
        assert.ok(events.some((e) => e.type === 'suspended'))
        assert.ok(!events.some((e) => e.type === 'done'))
        assert.ok(!events.some((e) => e.type === 'usage'))
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('with the flag off a daemon turn never takes the ACP path', async () => {
    delete process.env.MF_OPENCLAW_ACP
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') }
    })
    // The CLI-spawn fallback resolves a driver via forAgent, which this rig
    // does not provide; the point is only that NO turn.start was dispatched.
    await drain(rig.adapter.sendMessage(ctx(), USER_MSG)).catch(() => {})
    assert.equal(
        rig.calls.filter((c) => c.method === 'turn.start').length,
        0
    )
})

test('a daemon whose CLI does not advertise turn.openclaw.acp never takes the ACP path', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            lines: [],
            result: { ok: finalWithUsage('end_turn') },
            clientFeatures: ['turn.openclaw'] // gateway-http capable, not ACP
        })
        await drain(rig.adapter.sendMessage(ctx(), USER_MSG)).catch(() => {})
        assert.equal(
            rig.calls.filter((c) => c.method === 'turn.start').length,
            0
        )
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})

test('resume replays the buffered ACP frames via exec.resume', async () => {
    process.env.MF_OPENCLAW_ACP = '1'
    try {
        const rig = buildRig({
            lines: [noteLine('recovered')],
            result: { ok: finalWithUsage('end_turn') }
        })
        const resumeCtx = {
            ...ctx({ frameworkSessionRef: 'agent:main:mf-cts_1' }),
            daemonId: 'dh_byod',
            daemonExecRef: 'msg_1',
            fromSeq: 0
        } as ApiChatResumeContext
        const events = await drain(rig.adapter.resumeMessage(resumeCtx))
        assert.equal(rig.calls[0].method, 'exec.resume')
        assert.equal(
            (rig.calls[0].payload as { originalRefId?: string }).originalRefId,
            'msg_1'
        )
        assert.equal('env' in rig.calls[0].payload, false)
        assert.ok(
            events.some(
                (e) => e.type === 'token' && (e as { text: string }).text === 'recovered'
            )
        )
        assert.ok(events.some((e) => e.type === 'done'))
    } finally {
        delete process.env.MF_OPENCLAW_ACP
    }
})
