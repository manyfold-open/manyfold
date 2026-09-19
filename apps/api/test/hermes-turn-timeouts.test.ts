import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import type { ApiChatAdapterContext, EmittedChatEvent } from '../src/modules/chat/chat-adapter'

test('turn.start carries only split budgets', async () => {
    const calls: Array<{
        payload: Record<string, unknown>
        timeoutMs?: number
    }> = []
    const registry = {
        streamRpc: (args: {
            payload: Record<string, unknown>
            timeoutMs?: number
            onEvent?: (kind: string, data: string, seq?: number) => void
        }) => {
            calls.push({ payload: args.payload, timeoutMs: args.timeoutMs })
            return {
                refId: 'ref_test',
                result: Promise.resolve({ stopReason: 'end_turn' }),
                cancel: () => {}
            }
        }
    }
    const MAX_MS = 7_200_000
    const adapter = new HermesAdapter(
        {} as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        registry as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                keepAliveMs: 20_000,
                livenessTimeoutMs: 75_000,
                timeoutMs: MAX_MS
            })
        } as never
    )
    const ctx = {
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'hermes',
        runtimeKind: 'daemon',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: []
    } as unknown as ApiChatAdapterContext
    const message: ChatMessage = {
        id: 'msg_user',
        sessionId: 'cts_1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }],
        createdAt: '2026-08-05T00:00:00.000Z'
    }
    const send = (
        adapter as unknown as {
            sendViaTurnRpc: (
                c: ApiChatAdapterContext,
                m: ChatMessage,
                a: { daemonId: string; cwd: string | null }
            ) => AsyncIterable<EmittedChatEvent>
        }
    ).sendViaTurnRpc(ctx, message, { daemonId: 'dh_1', cwd: '/w' })
    for await (const _ of send) void _
    assert.equal(calls.length, 1)
    const payload = calls[0].payload
    assert.equal(Object.hasOwn(payload, 'timeoutMs'), false)
    assert.equal(payload.idleTimeoutMs, 240_000)
    assert.equal(
        payload.maxDurationMs,
        MAX_MS,
        'the ceiling comes from the admin chat exec budget, not a hermes constant'
    )
    assert.equal(
        calls[0].timeoutMs,
        MAX_MS + 10_000,
        'the RPC deadline is a third absolute clock and must stay above the turn cap'
    )
})
