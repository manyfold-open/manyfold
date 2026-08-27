import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import type { ApiChatAdapterContext } from '../src/modules/chat/chat-adapter'

// A sprite hermes turn used to POST to the sprite's resident gateway, and
// closing that socket CANCELLED the run — so an api restart destroyed the
// answer outright. That is the failure the runner transport removes, and the
// only way out is for something inside the sprite to hold the upstream: the
// runner.
//
// ACP is now the ONLY protocol: a runner-carried sprite turn rides turn.start
// (daemon-owned client, resumable), and a sprite without a runner falls to
// the API-owned interactive-exec ACP client — same protocol, not resumable,
// exactly the durability the gateway POST had.
//
// Drilled on staging 2026-07-28 (agent m201): the runner brought itself up,
// ACP started INSIDE the sprite alongside the still-running resident gateway
// services, and the turn completed — so the coexistence worry was unfounded.

const buildHarness = (opts: { runtime: 'sprites' | 'daemon' }) => {
    const acpCalls: Array<{
        daemonId: string
        cwd: string | null
        env?: Record<string, string>
    }> = []
    const interactiveCalls: string[] = []

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            runtime: opts.runtime,
                            daemonId: opts.runtime === 'daemon' ? 'dh_own' : null,
                            workspacePath: '/home/sprite/.manyfold/workspaces/agt_1',
                            extras: null
                        }
                    ]
                })
            })
        })
    }
    const adapter = new HermesAdapter(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    // Both transports are stubbed: the unit under test is which one is chosen,
    // not what either does with the stream.
    const a = adapter as unknown as Record<string, unknown>
    a.sendViaTurnRpc = async function* (
        _c: unknown,
        _m: unknown,
        args: { daemonId: string; cwd: string | null; env?: Record<string, string> }
    ) {
        acpCalls.push(args)
        yield { type: 'done', finalMessageId: 'msg_1' }
    }
    a.sendViaInteractiveAcp = async function* (c: { agentId: string }) {
        interactiveCalls.push(c.agentId)
        yield { type: 'done', finalMessageId: 'msg_1' }
    }
    a.requireTurnHermes = async () => true
    a.daemonSupportsTurnRpc = async () => true
    return { adapter, acpCalls, interactiveCalls }
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

const drain = async (
    it: AsyncIterable<unknown>
): Promise<{ ok: boolean; error?: string }> => {
    try {
        for await (const _ of it) void _
        return { ok: true }
    } catch (err) {
        return { ok: false, error: (err as Error).message }
    }
}

test('a runner-carried sprite hermes turn goes to ACP over that runner', async () => {
    const h = buildHarness({ runtime: 'sprites' })

    const out = await drain(
        h.adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), {
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'hi' }]
        } as never)
    )

    assert.ok(out.ok, out.error)
    assert.equal(h.acpCalls.length, 1)
    assert.equal(h.acpCalls[0].daemonId, 'dh_runner')
    // The sprite's own workspace, so hermes reads the config the sprite
    // bootstrap wrote — the turn stays a SPRITE turn in every respect
    // except who holds the transport.
    assert.equal(
        h.acpCalls[0].cwd,
        '/home/sprite/.manyfold/workspaces/agt_1'
    )
    assert.deepEqual(
        h.interactiveCalls,
        [],
        'the interactive fallback must not be used when the runner carries the turn'
    )
})

test('a sprite hermes turn with no runner falls to the interactive ACP transport', async () => {
    const h = buildHarness({ runtime: 'sprites' })

    const out = await drain(
        h.adapter.sendMessage(ctx(), {
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'hi' }]
        } as never)
    )

    assert.ok(out.ok, out.error)
    assert.deepEqual(h.interactiveCalls, ['agt_1'])
    assert.deepEqual(h.acpCalls, [])
})

test('a runner whose daemon lost turn.hermes falls to interactive ACP, not a dead RPC', async () => {
    const h = buildHarness({ runtime: 'sprites' })
    ;(h.adapter as unknown as Record<string, unknown>).daemonSupportsTurnRpc =
        async () => false

    const out = await drain(
        h.adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), {
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'hi' }]
        } as never)
    )

    assert.ok(out.ok, out.error)
    assert.deepEqual(h.interactiveCalls, ['agt_1'])
    assert.deepEqual(h.acpCalls, [])
})

test("a daemon hermes turn still uses the agent's own daemon, not a runner", async () => {
    const h = buildHarness({ runtime: 'daemon' })

    // A runner id must never override the agent's own daemon: a daemon-runtime
    // agent has no sprite, and its work belongs on the machine it registered.
    await drain(
        h.adapter.sendMessage(ctx({ runnerDaemonId: 'dh_runner' }), {
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'hi' }]
        } as never)
    )

    assert.equal(h.acpCalls.length, 1)
    assert.equal(h.acpCalls[0].daemonId, 'dh_own')
})

// The recovery half. Before this the ACP path emitted NO source rows, so its
// stream events had a null dedup key: insertStreamEvent plain-inserted them and
// beginResumeStream continued from max(seq), which means a replay would have
// appended the whole answer a second time instead of being absorbed. Ordinal
// keying is what makes the replay idempotent — safe here because the
// instability that forced claude to block-level output came from the
// BROADCASTER merging rows, whereas exec.resume replays byte-identical stdout,
// so the Nth ACP event is the same event in both runs.
test('ACP content events carry a stable, replay-identical source key', async () => {
    const { acpEventsFromNotification } = await import(
        '../src/modules/chat/adapters/hermes-acp-client'
    )
    const note = {
        jsonrpc: '2.0' as const,
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'hello' }
            }
        }
    }
    // Decoding the same notification twice must give the same events — that is
    // the property a replay depends on.
    const a = acpEventsFromNotification(note as never)
    const b = acpEventsFromNotification(note as never)
    assert.deepEqual(a, b)
    assert.deepEqual(a, [{ type: 'text', text: 'hello' }])
})

// Resume needs a daemon-carried stream to replay. A turn that ran on the
// interactive transport (sprite exec / pod exec) recorded no daemon refs, so
// recovery must decline it cleanly instead of inventing a replay.
test('resume without daemon refs declines as unsupported', async () => {
    const h = buildHarness({ runtime: 'sprites' })
    const events: Array<Record<string, unknown>> = []
    for await (const ev of h.adapter.resumeMessage!({
        ...ctx(),
        daemonId: null,
        daemonExecRef: null,
        fromSeq: 0
    } as never)) {
        events.push(ev as Record<string, unknown>)
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(
        (events[0].error as { code: string }).code,
        'hermes_resume_unsupported'
    )
    assert.equal((events[0].error as { retryable: boolean }).retryable, false)
})

// The exit condition, which is where the truncation came from. `done` is
// irreversible: it makes the turn invisible to every later recovery attempt. So
// it may only be emitted on POSITIVE evidence that the agent finished — the ACP
// `turn_end` notification. The RPC settling is not that evidence; the first
// version trusted it and terminalized a turn mid-generation (468 of ~5000 chars
// reported as success, staging 2026-07-28).
test('turn_end is the only thing that licenses a done terminal', async () => {
    const { acpEventsFromNotification } = await import(
        '../src/modules/chat/adapters/hermes-acp-client'
    )
    const turnEnd = acpEventsFromNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'turn_end', usage: { total: 1 } } }
    } as never)
    assert.deepEqual(
        turnEnd.map((e) => e.type),
        ['turn_end'],
        'the resume watches for exactly this event'
    )
    // A content chunk must NOT look like completion — otherwise any mid-stream
    // notification would license the terminal.
    const chunk = acpEventsFromNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial' }
            }
        }
    } as never)
    assert.ok(!chunk.some((e) => e.type === 'turn_end'))
})
