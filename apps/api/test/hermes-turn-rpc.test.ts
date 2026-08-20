import { chatCapabilitiesByFramework } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// S4, second half: the runner-owned hermes turn. The API used to BE the ACP
// client, speaking over a forwarded exec pipe — and ACP is client-driven, so
// an API restart ended the turn by construction (drilled three times on
// staging 2026-07-28: the child was gone, exec.resume returned an already-
// complete stream, 0 chars recovered). turn.start moves the client INTO the
// daemon: the API only reads the stream, live or replayed, and its restarts
// are invisible to the turn. These tests pin the transport choice, the wire
// shape, and — most importantly — what may licence a `done` terminal.

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

const thoughtLine = (text: string): string =>
    `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text }
            }
        }
    })}\n`

const toolCallLine = (toolCallId: string, name: string): string =>
    `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'tool_call',
                toolCallId,
                name,
                rawInput: { command: 'ls' }
            }
        }
    })}\n`

const turnEndLine = (): string =>
    `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'turn_end', usage: { total: 1 } } }
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
    result:
        | { ok: Record<string, unknown> | undefined }
        | { error: string }
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
    const chatRepo = {
        updateFrameworkSessionRef: async (sessionId: string, ref: string | null) => {
            sessionRefs.push({ sessionId, ref })
        }
    }
    const pricing = {
        computeCost: () => ({ costUsd: null, costSource: 'none' })
    }
    const adapter = new HermesAdapter(
        {} as never,
        {} as never,
        pricing as never,
        registry as never,
        chatRepo as never
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
        framework: 'hermes',
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

const resumeCtx = (extra: Partial<ApiChatResumeContext> = {}): ApiChatResumeContext =>
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

// The transport choice. Flag AND per-daemon capability must both hold: the
// flag is the rollout switch, the capability keeps the RPC away from CLIs
// that would answer `not_implemented` and fail the turn.
test('turn.start needs both the flag and the daemon capability', async () => {
    for (const [flag, feature, expected] of [
        ['1', true, 'turn'],
        ['1', false, 'pipe'],
        ['', true, 'pipe']
    ] as const) {
        await withEnv({ MF_HERMES_TURN_RPC: flag }, async () => {
            const { adapter } = buildHarness({ lines: [], result: { ok: {} } })
            const routes: string[] = []
            const a = adapter as unknown as Record<string, unknown>
            a.daemonSupportsTurnRpc = async () => feature
            a.sendViaTurnRpc = async function* () {
                routes.push('turn')
                yield { type: 'done', finalMessageId: 'msg_1' }
            }
            a.sendViaAcpPipe = async function* () {
                routes.push('pipe')
                yield { type: 'done', finalMessageId: 'msg_1' }
            }
            await drain(
                (
                    adapter as unknown as {
                        sendViaDaemonAcp: (
                            c: unknown,
                            m: unknown,
                            a: unknown
                        ) => AsyncIterable<EmittedChatEvent>
                    }
                ).sendViaDaemonAcp(ctx(), userMsg, {
                    daemonId: 'dh_runner',
                    cwd: '/ws'
                })
            )
            assert.deepEqual(
                routes,
                [expected],
                `flag=${flag || 'off'} feature=${feature}`
            )
        })
    }
})

test('a live turn.start carries the whole turn and refId == messageId', async () => {
    await withEnv({ MF_HERMES_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [noteLine('hel'), noteLine('lo')],
            result: {
                ok: {
                    stopReason: 'end_turn',
                    sessionId: 'sess_new',
                    result: { usage: { inputTokens: 1, outputTokens: 2 } }
                }
            }
        })
        ;(adapterAsAny(h.adapter).daemonSupportsTurnRpc as unknown) =
            async () => true
        const events = await drain(
            adapterAsAny(h.adapter).sendViaDaemonAcp(
                ctx({ frameworkSessionRef: 'sess_prior' }),
                userMsg,
                { daemonId: 'dh_runner', cwd: '/home/sprite/ws' }
            ) as AsyncIterable<EmittedChatEvent>
        )
        assert.equal(h.calls.length, 1)
        const call = h.calls[0]
        assert.equal(call.method, 'turn.start')
        // refId == messageId is what lets the reverse-WS resume path find the
        // stream again by (daemon_id, daemon_exec_ref).
        assert.equal(call.refIdOverride, 'msg_1')
        assert.equal(call.payload.framework, 'hermes')
        assert.equal(call.payload.prompt, 'hi')
        assert.equal(call.payload.dir, '/home/sprite/ws')
        // The prior ACP session rides along so the daemon can session/resume.
        assert.equal(call.payload.sessionId, 'sess_prior')

        const tokens = events.filter((e) => e.type === 'token')
        assert.equal(tokens.map((t) => (t as { text: string }).text).join(''), 'hello')
        // Ordinal source keys, counted from the stream head — the identity a
        // replay depends on.
        const sources = events.filter((e) => e.type === 'raw_source')
        assert.deepEqual(
            sources.map((s) => (s as { source: { externalId: string } }).source.externalId),
            ['hermes-acp-1', 'hermes-acp-2']
        )
        assert.equal(events.at(-1)?.type, 'done')
        // The session the daemon ended up with replaces the stale ref (a
        // resume that fell back to session/new would otherwise strand every
        // later turn on the dead session).
        assert.deepEqual(h.sessionRefs, [{ sessionId: 'cts_1', ref: 'sess_new' }])
    })
})

// What a hermes turn puts on the wire is also what the clients are told it can
// put on the wire, and for four months it was not: the shared capability row
// said hermes streamed nothing, called no tools and did no thinking, so the Web
// dropped the thinking and tool blocks this very path emits (#677). The
// assertion runs in this direction on purpose — the emissions are the evidence,
// the row follows them. Cross-framework equality of the two declarations is
// pinned in chat-capability-contract.test.ts.
test('a turn emits the token, thinking and tool blocks its capability row claims', async () => {
    await withEnv({ MF_HERMES_TURN_RPC: '1' }, async () => {
        const h = buildHarness({
            lines: [
                noteLine('hel'),
                thoughtLine('weighing it'),
                toolCallLine('call-1', 'Bash'),
                noteLine('lo')
            ],
            result: { ok: { stopReason: 'end_turn', sessionId: 'sess_new' } }
        })
        ;(adapterAsAny(h.adapter).daemonSupportsTurnRpc as unknown) =
            async () => true
        const events = await drain(
            adapterAsAny(h.adapter).sendViaDaemonAcp(ctx(), userMsg, {
                daemonId: 'dh_runner',
                cwd: '/home/sprite/ws'
            }) as AsyncIterable<EmittedChatEvent>
        )

        assert.equal(
            events
                .filter((e) => e.type === 'token')
                .map((e) => (e as { text: string }).text)
                .join(''),
            'hello'
        )
        assert.deepEqual(
            events
                .filter((e) => e.type === 'thinking')
                .map((e) => (e as { text: string }).text),
            ['weighing it']
        )
        assert.deepEqual(
            events
                .filter((e) => e.type === 'tool_call')
                .map((e) => {
                    const call = e as { toolCallId: string; toolName: string }
                    return [call.toolCallId, call.toolName]
                }),
            [['call-1', 'Bash']]
        )

        const row = chatCapabilitiesByFramework.hermes
        assert.deepEqual(
            {
                streaming: row.streaming,
                thinking: row.thinking,
                toolCalls: row.toolCalls
            },
            { streaming: true, thinking: true, toolCalls: true }
        )
    })
})

// THE truncation regression pin. A resume once replayed 468 of a ~5000-char
// answer and emitted `done` because it trusted the RPC settling (staging,
// 2026-07-28). Completion now needs positive evidence — a stopReason in the
// final (the daemon saw session/prompt resolve) or an in-stream turn_end.
// A legacy exec final ({exitCode: 0}) carries neither, and MUST suspend.
test('a final without stopReason and no turn_end suspends, never done', async () => {
    await withEnv({ MF_HERMES_ACP_RESUME: '1' }, async () => {
        const h = buildHarness({
            lines: [noteLine('partial answer so far')],
            result: { ok: { exitCode: 0 } }
        })
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        const last = events.at(-1)
        assert.equal(last?.type, 'suspended')
        assert.match(
            (last as { reason: string }).reason,
            /without turn_end/
        )
        assert.ok(!events.some((e) => e.type === 'done'))
        assert.ok(!events.some((e) => e.type === 'error'))
    })
})

test('a stopReason in the final licenses done; usage rides the result', async () => {
    await withEnv({ MF_HERMES_ACP_RESUME: '1' }, async () => {
        const h = buildHarness({
            lines: [noteLine('whole answer'), turnEndLine()],
            result: {
                ok: {
                    stopReason: 'end_turn',
                    sessionId: 'sess_1',
                    result: { usage: { inputTokens: 7, outputTokens: 9 } }
                }
            }
        })
        const events = await drain(h.adapter.resumeMessage!(resumeCtx()))
        assert.equal(events.at(-1)?.type, 'done')
        const usage = events.find((e) => e.type === 'usage')
        assert.ok(usage, 'usage from the prompt result must be emitted')
    })
})

// Ordinal keys are COUNTED FROM THE STREAM HEAD, so the replay must start
// there: a mid-stream cursor would renumber every event and the dedup keys
// would all miss — duplicating the answer instead of absorbing it. The ladder
// may compute any cursor it likes; hermes must ignore it.
test('a hermes resume always replays from seq 0, whatever the cursor says', async () => {
    await withEnv({ MF_HERMES_ACP_RESUME: '1' }, async () => {
        const h = buildHarness({
            lines: [turnEndLine()],
            result: { ok: { stopReason: 'end_turn', sessionId: 's' } }
        })
        await drain(h.adapter.resumeMessage!(resumeCtx({ fromSeq: 7 })))
        assert.equal(h.calls.length, 1)
        assert.equal(h.calls[0].method, 'exec.resume')
        assert.equal(h.calls[0].payload.originalRefId, 'msg_1')
        assert.equal(h.calls[0].payload.fromSeq, 0)
    })
})

// The reconnect that enables recovery must never be reported as the failure —
// the same bug class fixed for claude/codex/gemini and for the pipe path.
test('a replaced connection suspends the turn instead of killing it', async () => {
    await withEnv({ MF_HERMES_ACP_RESUME: '1' }, async () => {
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

const adapterAsAny = (
    adapter: HermesAdapter
): Record<string, (...args: never[]) => unknown> & {
    sendViaDaemonAcp: (
        c: unknown,
        m: unknown,
        a: unknown
    ) => AsyncIterable<EmittedChatEvent>
} => adapter as never
