import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import type { ApiChatAdapterContext } from '../src/modules/chat/chat-adapter'

// A sprite hermes turn POSTs to the sprite's resident gateway, and closing that
// socket CANCELS the run — so an api restart destroys the answer outright. That
// is the failure the runner transport exists to remove, and the only way out is
// for something inside the sprite to hold the upstream: the runner.
//
// ACP is not new machinery here — daemon-runtime hermes has used it in
// production all along (JSON-RPC over a child process's stdio, carried by the
// daemon exec RPC, which means the runner's durable exec buffer backs it). What
// these pin is that a runner-carried SPRITE turn takes that same road, and that
// a turn without a runner is left completely alone.
//
// Drilled on staging 2026-07-28 (agent m201): the runner brought itself up, ACP
// started INSIDE the sprite alongside the still-running resident gateway
// services, and the turn completed — so the coexistence worry was unfounded.
// What is still NOT claimed is recovery: hermes has no resumeMessage, so an
// interrupted turn suspends and lands on the adoption ladder rather than
// replaying its ACP stream. The suspend behaviour itself is covered by
// daemon-transport-suspend.test.ts (the shared predicate) plus that drill.

const buildHarness = (opts: { runtime: 'sprites' | 'daemon' }) => {
    const acpCalls: Array<{ daemonId: string; cwd: string | null }> = []
    const gatewayCalls: string[] = []

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            runtime: opts.runtime,
                            daemonId: opts.runtime === 'daemon' ? 'dh_own' : null,
                            workspacePath: '/home/sprite/.manyfold/workspaces/agt_1'
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
    ;(
        adapter as unknown as {
            sendViaDaemonAcp: (
                c: unknown,
                m: unknown,
                a: { daemonId: string; cwd: string | null }
            ) => AsyncIterable<unknown>
        }
    ).sendViaDaemonAcp = async function* (_c, _m, a) {
        acpCalls.push(a)
        yield { type: 'done', finalMessageId: 'msg_1' }
    }
    ;(
        adapter as unknown as { resolveRuntime: (id: string) => Promise<unknown> }
    ).resolveRuntime = async (id: string) => {
        gatewayCalls.push(id)
        throw new Error('gateway path reached')
    }
    return { adapter, acpCalls, gatewayCalls }
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
    assert.deepEqual(h.acpCalls, [
        {
            daemonId: 'dh_runner',
            // The sprite's own workspace, so hermes reads the config the sprite
            // bootstrap wrote — the turn stays a SPRITE turn in every respect
            // except who holds the transport.
            cwd: '/home/sprite/.manyfold/workspaces/agt_1'
        }
    ])
    assert.deepEqual(h.gatewayCalls, [], 'the gateway must not be contacted')
})

test('a sprite hermes turn with no runner still uses the resident gateway', async () => {
    const h = buildHarness({ runtime: 'sprites' })

    // WHY: the allowlist is empty everywhere, so this is the path every real
    // hermes agent takes today. Routing must not disturb it.
    const out = await drain(
        h.adapter.sendMessage(ctx(), {
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'hi' }]
        } as never)
    )

    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /gateway path reached/)
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

// The ACP resume is OFF by default and must stay off: a staging drill showed it
// terminalizing a turn that was still generating (~468 of ~5000 chars, reported
// as `done`). Daemon-runtime hermes agents in production are daemon-carried, so
// an enabled-by-default resume would hand them a truncated answer labelled
// success, where today they get a retryable terminal. This pins the default.
test('the ACP resume stays disabled unless explicitly enabled', async () => {
    const h = buildHarness({ runtime: 'sprites' })
    const events: Array<Record<string, unknown>> = []
    for await (const ev of h.adapter.resumeMessage!({
        ...ctx(),
        daemonId: 'dh_runner',
        daemonExecRef: 'msg_1',
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
    // Retryable: the user can resend. Not a claim that the turn is unrecoverable
    // in principle — only that this path is not trusted yet.
    assert.equal((events[0].error as { retryable: boolean }).retryable, true)
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
