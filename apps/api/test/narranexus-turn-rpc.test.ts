import assert from 'node:assert/strict'
import test from 'node:test'
import { NarraNexusChatAdapter } from '../src/modules/narranexus/narranexus-chat.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// #555: NarraNexusChatAdapter never forwarded DaemonRegistryService to its
// parent, so `viaTurnRpc` was constant-false and resumeMessage was
// unconditionally `openclaw_resume_unsupported` — the API process kept holding
// the SSE socket and a rolling deploy destroyed in-flight narranexus turns.
// These tests pin that the subclass forwards the registry: the same
// flag+capability+runner conditions that move an openclaw turn onto
// turn.start now move a narranexus turn too, and the inherited resume path
// actually attaches.

const deltaLine = (text: string): string =>
    `${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`

interface StreamCall {
    daemonId: string
    method: string
    payload: Record<string, unknown>
    refIdOverride?: string
    onEvent?: (kind: string, data: string, seq?: number) => void
}

const buildHarness = (
    script: {
        lines: string[]
        result: { ok: Record<string, unknown> | undefined } | { error: string }
    },
    opts: { withRegistry?: boolean } = {}
) => {
    const calls: StreamCall[] = []
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
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            runtime: 'sprites',
                            internalId: 'narranexus',
                            daemonId: null
                        }
                    ]
                })
            })
        })
    }
    const pricing = {
        computeCost: () => ({ costUsd: null, costSource: 'none' })
    }
    const drivers = {
        recoveryFsForAgent: async () => ({ fs: { locate: async () => null } })
    }
    const telemetry = { event: () => {} }
    const adapter =
        opts.withRegistry === false
            ? new NarraNexusChatAdapter(
                  db as never,
                  {} as never,
                  pricing as never,
                  {} as never,
                  drivers as never,
                  telemetry as never
              )
            : new NarraNexusChatAdapter(
                  db as never,
                  {} as never,
                  pricing as never,
                  {} as never,
                  drivers as never,
                  telemetry as never,
                  registry as never
              )
    return { adapter, calls }
}

const ctx = (extra: Partial<ApiChatAdapterContext> = {}): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'narranexus',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: 'sess_known',
        history: [],
        ...extra
    }) as ApiChatAdapterContext

const resumeCtx = (
    extra: Partial<ApiChatResumeContext> = {}
): ApiChatResumeContext =>
    ({
        ...ctx(),
        daemonId: 'dh_runner',
        daemonExecRef: 'msg_1',
        fromSeq: 0,
        ...extra
    }) as ApiChatResumeContext

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

const withEnv = async (
    env: Record<string, string>,
    fn: () => Promise<void>
): Promise<void> => {
    const prior = new Map(
        Object.keys(env).map((k) => [k, process.env[k]] as const)
    )
    Object.assign(process.env, env)
    try {
        await fn()
    } finally {
        for (const [k, v] of prior) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
}

const userMsg = {
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

const asAny = (a: NarraNexusChatAdapter): Record<string, unknown> => a as never

const stubRoutes = (adapter: NarraNexusChatAdapter, routes: string[]): void => {
    const a = asAny(adapter)
    a.resolveRuntime = async () => ({
        ingressHost: 'gw.sprites.app',
        gatewayToken: 'tok',
        modelId: 'narranexus',
        displayModel: null
    })
    a.daemonSupportsTurnRpc = async () => true
    a.sendViaTurnRpc = async function* () {
        routes.push('turn')
        yield { type: 'done', finalMessageId: 'msg_1' }
    }
    a.sendOpenAiCompat = async function* () {
        routes.push('sse')
        yield { type: 'done', finalMessageId: 'msg_1' }
    }
}

// THE #555 pin: with the registry forwarded, the exact conditions that route
// an openclaw turn onto turn.start route a narranexus turn too. Reverting the
// constructor to `undefined` turns this red.
test('a narranexus turn takes turn.start when flag, capability and runner align', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const { adapter } = buildHarness({ lines: [], result: { ok: {} } })
        const routes: string[] = []
        stubRoutes(adapter, routes)
        await drain(
            adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), userMsg)
        )
        assert.deepEqual(routes, ['turn'])
    })
})

test('flag off keeps narranexus on the direct gateway path', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '' }, async () => {
        const { adapter } = buildHarness({ lines: [], result: { ok: {} } })
        const routes: string[] = []
        stubRoutes(adapter, routes)
        await drain(
            adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), userMsg)
        )
        assert.deepEqual(routes, ['sse'])
    })
})

// The registry stays @Optional — six-arg positional construction (and a boot
// where DI cannot resolve it) must fall back to the gateway transport, never
// crash.
test('without a registry the flag alone cannot move narranexus off the gateway', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const { adapter } = buildHarness(
            { lines: [], result: { ok: {} } },
            { withRegistry: false }
        )
        const routes: string[] = []
        stubRoutes(adapter, routes)
        await drain(
            adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), userMsg)
        )
        assert.deepEqual(routes, ['sse'])
    })
})

// The inherited resume is live once the registry exists: it attaches via
// exec.resume from seq 0 and a stopReason final licenses done — before #555
// this yielded `openclaw_resume_unsupported` unconditionally.
test('a narranexus resume replays through exec.resume and completes', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [deltaLine('whole answer')],
            result: { ok: { stopReason: 'done', sessionId: null } }
        })
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        assert.equal(h.calls.length, 1)
        assert.equal(h.calls[0].method, 'exec.resume')
        assert.equal(h.calls[0].payload.fromSeq, 0)
        assert.equal(events.at(-1)?.type, 'done')
        assert.ok(!events.some((e) => e.type === 'error'))
    })
})

test('a narranexus resume without a registry stays unsupported-retryable', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness(
            { lines: [], result: { ok: {} } },
            { withRegistry: false }
        )
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        assert.equal(events.length, 1)
        assert.equal(events[0].type, 'error')
        assert.equal(
            (events[0] as { error: { code: string } }).error.code,
            'openclaw_resume_unsupported'
        )
        assert.equal(h.calls.length, 0, 'no RPC may be attempted')
    })
})
