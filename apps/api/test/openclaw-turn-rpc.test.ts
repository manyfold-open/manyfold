import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// S4, openclaw half. Today's sprite openclaw turn is an SSE POST whose socket
// the API holds — and the gateway CANCELS the run when that socket closes, so
// an API restart destroys the answer outright. turn.start moves the socket
// into the sprite's runner; these tests pin the transport choice, that the
// daemon gets the EXACT request the API would have sent, and what may licence
// a `done` on the replayed stream.

const deltaLine = (text: string, id?: string): string =>
    `${JSON.stringify({
        ...(id ? { id } : {}),
        choices: [{ delta: { content: text } }]
    })}\n`

interface StreamCall {
    daemonId: string
    method: string
    payload: Record<string, unknown>
    refIdOverride?: string
    onEvent?: (kind: string, data: string, seq?: number) => void
}

const buildHarness = (script: {
    lines: string[]
    result: { ok: Record<string, unknown> | undefined } | { error: string }
}) => {
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
                            internalId: 'main',
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
    const attaches: Array<{ refId: string; fromSeq: number }> = []
    const drivers = {
        recoveryFsForAgent: async () => ({ fs: { locate: async () => null } }),
        // #666: a daemon-runtime resume leaves the registry entirely and
        // replays over the exec seam. Recorded here only to prove which of the
        // two resume paths a turn took.
        daemonDriverFor: () => ({
            stream: () => {
                throw new Error('a resume must not dispatch a new exec')
            },
            resumeStream: (req: { refId: string; fromSeq: number }) => {
                attaches.push(req)
                return {
                    stdout: (async function* (): AsyncGenerator<string> {})(),
                    stderr: (async function* (): AsyncGenerator<string> {})(),
                    result: Promise.resolve({
                        exitCode: 0,
                        stdout: '',
                        stderr: ''
                    }),
                    abort: () => {}
                }
            }
        })
    }
    const telemetry = { event: () => {} }
    const adapter = new OpenclawAdapter(
        db as never,
        {} as never,
        pricing as never,
        {} as never,
        drivers as never,
        telemetry as never,
        registry as never
    )
    return { adapter, calls, attaches }
}

const ctx = (extra: Partial<ApiChatAdapterContext> = {}): ApiChatAdapterContext =>
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

const asAny = (a: OpenclawAdapter): Record<string, unknown> => a as never

test('turn.start needs runnerDaemonId, the flag AND the daemon capability', async () => {
    for (const [flag, feature, runner, expected] of [
        ['1', true, 'dh_runner', 'turn'],
        ['1', false, 'dh_runner', 'sse'],
        ['', true, 'dh_runner', 'sse'],
        ['1', true, undefined, 'sse']
    ] as const) {
        await withEnv({ MF_OPENCLAW_TURN_RPC: flag }, async () => {
            const { adapter } = buildHarness({ lines: [], result: { ok: {} } })
            const routes: string[] = []
            const a = asAny(adapter)
            a.resolveRuntime = async () => ({
                ingressHost: 'gw.sprites.app',
                gatewayToken: 'tok',
                modelId: 'openclaw',
                displayModel: 'gpt-x'
            })
            a.daemonSupportsTurnRpc = async () => feature
            a.sendViaTurnRpc = async function* () {
                routes.push('turn')
                yield { type: 'done', finalMessageId: 'msg_1' }
            }
            a.sendOpenAiCompat = async function* () {
                routes.push('sse')
                yield { type: 'done', finalMessageId: 'msg_1' }
            }
            await drain(
                adapter.sendMessage(ctx({ runnerDaemonId: runner }), userMsg)
            )
            assert.deepEqual(
                routes,
                [expected],
                `flag=${flag || 'off'} feature=${feature} runner=${runner}`
            )
        })
    }
})

test('the daemon gets the exact request the API would have sent', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [deltaLine('hel'), deltaLine('lo')],
            result: { ok: { stopReason: 'done', sessionId: null } }
        })
        const a = asAny(h.adapter)
        a.resolveRuntime = async () => ({
            ingressHost: 'gw.sprites.app',
            gatewayToken: 'gw_tok',
            modelId: 'openclaw',
            displayModel: 'gpt-x'
        })
        a.daemonSupportsTurnRpc = async () => true
        const events = await drain(
            h.adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), userMsg)
        )
        assert.equal(h.calls.length, 1)
        const call = h.calls[0]
        assert.equal(call.method, 'turn.start')
        // refId == messageId is what lets the reverse-WS resume path find the
        // stream again by (daemon_id, daemon_exec_ref).
        assert.equal(call.refIdOverride, 'msg_1')
        assert.equal(call.payload.framework, 'openclaw')
        assert.match(String(call.payload.url), /\/v1\/chat\/completions$/)
        assert.equal(call.payload.token, 'gw_tok')
        const body = call.payload.body as {
            model: string
            stream: boolean
            messages: Array<{ role: string; content: string }>
        }
        assert.equal(body.model, 'openclaw')
        assert.equal(body.stream, true)
        assert.equal(body.messages.at(-1)?.content, 'hi')

        const tokens = events.filter((e) => e.type === 'token')
        assert.equal(
            tokens.map((t) => (t as { text: string }).text).join(''),
            'hello'
        )
        // Ordinal fallback keys, counted from the stream head — the identity a
        // replay depends on.
        const sources = events.filter((e) => e.type === 'raw_source')
        assert.deepEqual(
            sources.map(
                (s) => (s as { source: { externalId: string } }).source.externalId
            ),
            ['openclaw-sse-1', 'openclaw-sse-2']
        )
        assert.equal(events.at(-1)?.type, 'done')
    })
})

// THE truncation pin, openclaw edition: a bare exec final ({exitCode}) or a
// stream that just stopped carries no stopReason and MUST suspend — never a
// half-answer labelled `done` (the exact failure the hermes drills caught).
test('a final without stopReason suspends, never done', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [deltaLine('partial answer so far')],
            result: { ok: { exitCode: 0 } }
        })
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        const last = events.at(-1)
        assert.equal(last?.type, 'suspended')
        assert.match((last as { reason: string }).reason, /without \[DONE\]/)
        assert.ok(!events.some((e) => e.type === 'done'))
        assert.ok(!events.some((e) => e.type === 'error'))
    })
})

test('a stopReason licenses done and the replayed usage rides along', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [
                deltaLine('whole answer'),
                `${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 7 }, model: 'gpt-x' })}\n`
            ],
            result: { ok: { stopReason: 'done', sessionId: null } }
        })
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        assert.equal(events.at(-1)?.type, 'done')
        assert.ok(
            events.some((e) => e.type === 'usage'),
            'usage captured from the replayed deltas must be emitted'
        )
    })
})

test('an openclaw resume always replays from seq 0, whatever the cursor says', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [],
            result: { ok: { stopReason: 'done', sessionId: null } }
        })
        await drain(h.adapter.resumeMessage!(resumeCtx({ fromSeq: 7 })))
        assert.equal(h.calls.length, 1)
        assert.equal(h.calls[0].method, 'exec.resume')
        assert.equal(h.calls[0].payload.fromSeq, 0)
    })
})

// A daemon-runtime openclaw turn's buffer holds `openclaw agent --json` CLI
// stdout — a different shape this SSE decoder must not touch. #666 gave that
// shape a resume of its own over the exec seam, so what is pinned here is the
// fork: the turn stream stays untouched, and MF_OPENCLAW_TURN_RPC does not
// reach the exec replay. Gating it would be worse than the bug it replaced —
// the daemon path SUSPENDS a lost socket, so a flag-off refusal terminalizes
// a turn the daemon is still holding an answer for.
test('a daemon-runtime turn replays over the exec seam, never through this decoder', async () => {
    for (const turnRpc of ['1', '0']) {
        await withEnv({ MF_OPENCLAW_TURN_RPC: turnRpc }, async () => {
            const h = buildHarness({ lines: [], result: { ok: {} } })
            const events = await drain(
                h.adapter.resumeMessage!(resumeCtx({ runtimeKind: 'daemon' }))
            )
            assert.equal(
                h.calls.length,
                0,
                `MF_OPENCLAW_TURN_RPC=${turnRpc}: no turn RPC may be attempted`
            )
            assert.deepEqual(
                h.attaches.map((a) => [a.refId, a.fromSeq]),
                [['msg_1', 0]],
                `MF_OPENCLAW_TURN_RPC=${turnRpc}: the buffered CLI stdout must be replayed over the exec seam`
            )
            assert.ok(
                !events.some((e) => e.type === 'error'),
                `MF_OPENCLAW_TURN_RPC=${turnRpc}: got ${JSON.stringify(events)}`
            )
        })
    }
})

test('a replaced connection suspends the turn instead of killing it', async () => {
    await withEnv({ MF_OPENCLAW_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [],
            result: { error: 'connection replaced' }
        })
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        const last = events.at(-1)
        assert.equal(last?.type, 'suspended')
        assert.equal((last as { daemonExecRef: string }).daemonExecRef, 'msg_1')
    })
})
