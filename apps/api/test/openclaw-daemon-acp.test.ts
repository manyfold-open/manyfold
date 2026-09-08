import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import type { DetectedFramework } from '@manyfold/shared'

// What a healthy daemon host reports on its heartbeat. The ACP turn is only
// admitted when the openclaw entry names a gateway the daemon could reach, so
// this is the default and each refusal case overrides it.
const REACHABLE_GATEWAY: DetectedFramework[] = [
    {
        framework: 'openclaw',
        version: '2026.5.18',
        path: '/usr/local/bin/openclaw',
        gateway: {
            port: 18789,
            reachable: true,
            checkedAt: new Date().toISOString()
        }
    }
]

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
    detectedFrameworks?: DetectedFramework[]
    onBudgets?: () => void
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
                                    ],
                                    detectedFrameworks:
                                        script.detectedFrameworks ??
                                        REACHABLE_GATEWAY
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
        getCachedChatExecTimeoutMs: async () => {
            // A seam for the pre-dispatch cancel test: this await sits between
            // the caller's abort check and the dispatch, which is exactly the
            // window the drain re-checks.
            script.onBudgets?.()
            return {
                keepAliveMs: 1_000,
                livenessTimeoutMs: 1_000,
                timeoutMs: 60_000
            }
        }
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
})

test('the ask mode and a model pick ride the payload as a sessions.patch', async () => {
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
})

test('a turn that ends without a stopReason suspends rather than terminalizing', async () => {
        const rig = buildRig({
            lines: [noteLine('partial')],
            result: { ok: finalWithUsage(null) }
        })
        const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
        assert.ok(events.some((e) => e.type === 'suspended'))
        assert.ok(!events.some((e) => e.type === 'done'))
        assert.ok(!events.some((e) => e.type === 'usage'))
})
// The legacy `openclaw agent --local --json` spawn this used to fall back to is
// gone (ADR-0027 O9), so an incapable daemon is REFUSED, with the fix in the
// message — the hermes_daemon_upgrade_required shape from ADR-0024.
test('a daemon whose CLI does not advertise turn.openclaw.acp is refused with the upgrade fix', async () => {
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') },
        clientFeatures: ['turn.openclaw'] // gateway-http capable, not ACP
    })
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    const err = events.find((e) => e.type === 'error') as
        | { error: { code: string; message: string; retryable: boolean } }
        | undefined
    assert.equal(err?.error.code, 'openclaw_daemon_upgrade_required')
    assert.equal(err?.error.retryable, false)
    assert.match(err?.error.message ?? '', /mf update/)
})

test('resume replays the buffered ACP frames via exec.resume', async () => {
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
})

// --- gateway admission (ADR-0027: discover, never start) --------------------
//
// The bridge connects to a gateway the daemon only DISCOVERED. The heartbeat
// reports what it found, so the API refuses here with the fix in the message
// rather than letting the bridge fail with a bare connect error. Prove-red:
// delete the daemonAdmissionRefusal call and every case below dispatches.

const errorOf = (
    events: EmittedChatEvent[]
): { code: string; message: string; retryable: boolean } | undefined =>
    (
        events.find((e) => e.type === 'error') as
            | { error: { code: string; message: string; retryable: boolean } }
            | undefined
    )?.error

test('a daemon host with no openclaw detected is refused, not dispatched', async () => {
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') },
        detectedFrameworks: [
            { framework: 'hermes', version: '1.0.0', path: '/usr/bin/hermes' }
        ]
    })
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    const err = errorOf(events)
    assert.equal(err?.code, 'openclaw_daemon_gateway_unavailable')
    assert.equal(err?.retryable, false)
    assert.match(err?.message ?? '', /install openclaw/)
})

test('a daemon host whose openclaw has no gateway configured is refused', async () => {
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') },
        detectedFrameworks: [
            {
                framework: 'openclaw',
                version: '2026.5.18',
                path: '/usr/local/bin/openclaw'
            }
        ]
    })
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    const err = errorOf(events)
    assert.equal(err?.code, 'openclaw_daemon_gateway_unavailable')
    assert.equal(err?.retryable, false)
    assert.match(err?.message ?? '', /openclaw gateway install/)
})

// Retryable, unlike the two structural refusals above: the probe runs on the
// daemon's framework-detect interval, not per turn, so a gateway started since
// the last heartbeat is already fine and a retry is the cheapest way to find out.
test('an unreachable gateway is refused retryably, naming the port and its probe age', async () => {
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') },
        detectedFrameworks: [
            {
                framework: 'openclaw',
                version: '2026.5.18',
                path: '/usr/local/bin/openclaw',
                gateway: {
                    port: 18789,
                    reachable: false,
                    checkedAt: new Date(Date.now() - 180_000).toISOString()
                }
            }
        ]
    })
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    const err = errorOf(events)
    assert.equal(err?.code, 'openclaw_daemon_gateway_unavailable')
    assert.equal(err?.retryable, true)
    assert.match(err?.message ?? '', /18789/)
    assert.match(err?.message ?? '', /probed 3m ago/)
    assert.match(err?.message ?? '', /openclaw gateway start/)
})

// `reachable: null` means the host's config names a REMOTE gateway, which the
// daemon deliberately does not probe. The url-less bridge follows that config
// itself, so it is not ours to refuse.
test('a remote (unprobed) gateway still dispatches', async () => {
    const rig = buildRig({
        lines: [noteLine('hi')],
        result: { ok: finalWithUsage('end_turn') },
        detectedFrameworks: [
            {
                framework: 'openclaw',
                version: '2026.5.18',
                path: '/usr/local/bin/openclaw',
                gateway: {
                    port: null,
                    reachable: null,
                    checkedAt: new Date().toISOString()
                }
            }
        ]
    })
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 1)
    assert.ok(events.some((e) => e.type === 'done'))
})

// "Couldn't check" must never read as the non-retryable upgrade demand a
// definite `false` produces — the ADR-0024 rule the hermes gate states.
test('a failed admission lookup is retryable, never the upgrade demand', async () => {
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') }
    })
    // Only the runtime_hosts read fails: the agents row still resolves, so the
    // turn reaches the admission gate rather than dying before it.
    const adapter = rig.adapter as unknown as { db: unknown }
    adapter.db = {
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
                            throw new Error('connection terminated')
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
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    const err = errorOf(events)
    assert.equal(err?.code, 'openclaw_daemon_acp_failed')
    assert.equal(err?.retryable, true)
})

// #402. A cancel that arrives before the caller even starts is caught at the
// head of sendViaDaemonAcp.
test('a turn cancelled before it starts never reaches the daemon', async () => {
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') }
    })
    const controller = new AbortController()
    controller.abort()
    const events = await drain(
        rig.adapter.sendMessage(
            ctx({ abortSignal: controller.signal } as never),
            USER_MSG
        )
    )
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    assert.equal(errorOf(events)?.code, 'openclaw_aborted')
})

// The harder half, and the one the head check cannot see: a cancel that lands
// in an await AFTER it — here the budgets lookup, one of several between that
// check and the dispatch. A signal never replays to a listener registered
// later, so without a re-check at the dispatch itself the daemon runs an ACP
// turn nobody will read. Prove-red: drop the re-check in
// drainOpenclawAcpTurnStream and a turn.start goes out.
test('a turn cancelled while it is being prepared never reaches the daemon', async () => {
    const controller = new AbortController()
    const rig = buildRig({
        lines: [],
        result: { ok: finalWithUsage('end_turn') },
        onBudgets: () => controller.abort()
    })
    const events = await drain(
        rig.adapter.sendMessage(
            ctx({ abortSignal: controller.signal } as never),
            USER_MSG
        )
    )
    assert.equal(rig.calls.filter((c) => c.method === 'turn.start').length, 0)
    assert.equal(errorOf(events)?.code, 'openclaw_aborted')
})

// The API-driven cells own their ACP client, so a lost API loses the turn —
// there is nothing buffered to replay. Only the daemon cell is resumable.
test('a sprite or k8s openclaw resume is refused, with no RPC attempted', async () => {
    for (const runtimeKind of ['sprites', 'k8s'] as const) {
        const rig = buildRig({
            lines: [],
            result: { ok: finalWithUsage('end_turn') }
        })
        const events = await drain(
            rig.adapter.resumeMessage({
                ...ctx({ frameworkSessionRef: 'agent:main:mf-cts_1' }),
                runtimeKind,
                daemonId: 'dh_runner',
                daemonExecRef: 'msg_1',
                fromSeq: 0
            } as ApiChatResumeContext)
        )
        assert.equal(rig.calls.length, 0, `${runtimeKind}: no RPC`)
        const err = errorOf(events)
        assert.equal(err?.code, 'openclaw_resume_unsupported')
        assert.equal(err?.retryable, false)
    }
})
