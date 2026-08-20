import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import {
    createAdoptionInterceptor,
    deliveredBaselineFromStreamEvents
} from '../src/modules/chat/recovery/adoption-interceptor'

// Adoption recovery re-consumes a turn's source from the top; the interceptor
// must suppress EXACTLY what the dead relay already delivered and emit only
// the remainder. A wrong suppression either duplicates user-visible text or
// drops it silently — these tests pin the alignment contract.

const ev = {
    token: (text: string): EmittedChatEvent => ({ type: 'token', text }),
    thinking: (text: string): EmittedChatEvent => ({ type: 'thinking', text }),
    toolCall: (id: string): EmittedChatEvent => ({
        type: 'tool_call',
        toolCallId: id,
        toolName: 'Bash',
        args: null
    }),
    toolResult: (id: string): EmittedChatEvent => ({
        type: 'tool_result',
        toolCallId: id,
        result: 'ok'
    })
}

const baselineOf = (
    events: Array<{ eventType: string; payloadJson: unknown }>
): ReturnType<typeof deliveredBaselineFromStreamEvents> =>
    deliveredBaselineFromStreamEvents(events)

test('baseline concatenates delivered text and counts tool events', () => {
    const b = baselineOf([
        { eventType: 'token', payloadJson: { text: 'Hel' } },
        { eventType: 'thinking', payloadJson: { text: 'hmm' } },
        { eventType: 'token', payloadJson: { text: 'lo' } },
        { eventType: 'tool_call', payloadJson: { toolCallId: 'x' } },
        { eventType: 'tool_call', payloadJson: { toolCallId: 'x' } },
        { eventType: 'tool_result', payloadJson: { toolCallId: 'x' } },
        { eventType: 'usage', payloadJson: {} }
    ])
    assert.equal(b.token, 'Hello')
    assert.equal(b.thinking, 'hmm')
    assert.equal(b.toolCalls.get('x'), 2)
    assert.equal(b.toolResults.get('x'), 1)
    assert.equal(b.usageDelivered, true)
})

test('interceptor suppresses the delivered prefix across different chunk boundaries', () => {
    // Delivered as ['Hel','lo w']; replay coalesces differently: ['Hello',' world'].
    const i = createAdoptionInterceptor(
        baselineOf([
            { eventType: 'token', payloadJson: { text: 'Hel' } },
            { eventType: 'token', payloadJson: { text: 'lo w' } }
        ])
    )
    const r1 = i.intercept(ev.token('Hello'))
    assert.deepEqual(r1.events, [])
    const r2 = i.intercept(ev.token(' world'))
    assert.equal(r2.mismatch, undefined)
    assert.deepEqual(r2.events, [{ type: 'token', text: 'orld' }])
    assert.equal(i.aligned(), true)
    // Everything after alignment passes through untouched.
    const r3 = i.intercept(ev.token('!'))
    assert.deepEqual(r3.events, [{ type: 'token', text: '!' }])
})

test('interceptor bails on a divergent replay instead of guessing', () => {
    const i = createAdoptionInterceptor(
        baselineOf([{ eventType: 'token', payloadJson: { text: 'Hello Bob' } }])
    )
    const r = i.intercept(ev.token('Hello world'))
    assert.ok(r.mismatch, 'divergence must be reported')
    assert.deepEqual(r.events, [], 'nothing may be emitted on divergence')
})

test('interceptor tracks token and thinking cursors independently', () => {
    const i = createAdoptionInterceptor(
        baselineOf([
            { eventType: 'thinking', payloadJson: { text: 'plan' } },
            { eventType: 'token', payloadJson: { text: 'Answer' } }
        ])
    )
    assert.deepEqual(i.intercept(ev.token('Answer: 42')).events, [
        { type: 'token', text: ': 42' }
    ])
    assert.deepEqual(i.intercept(ev.thinking('planning')).events, [
        { type: 'thinking', text: 'ning' }
    ])
})

test('interceptor dedups tool events as a multiset by id', () => {
    const i = createAdoptionInterceptor(
        baselineOf([
            { eventType: 'tool_call', payloadJson: { toolCallId: 'a' } }
        ])
    )
    assert.deepEqual(i.intercept(ev.toolCall('a')).events, [])
    // A second occurrence of the same id was NOT delivered — it must emit.
    assert.equal(i.intercept(ev.toolCall('a')).events.length, 1)
    // Results were never delivered for 'a', so the result passes through.
    assert.equal(i.intercept(ev.toolResult('a')).events.length, 1)
})

test('count-mode interceptor skips the first N tool events regardless of id', () => {
    // Codex rollout ids (fc_/call_) never match the delivered stdout item ids
    // (item_N); block-level order-preserving streams dedup by position.
    const i = createAdoptionInterceptor(
        baselineOf([
            { eventType: 'tool_call', payloadJson: { toolCallId: 'item_1' } },
            { eventType: 'tool_call', payloadJson: { toolCallId: 'item_2' } },
            { eventType: 'tool_result', payloadJson: { toolCallId: 'item_1' } }
        ]),
        { toolDedup: 'count' }
    )
    assert.deepEqual(i.intercept(ev.toolCall('call_A')).events, [])
    assert.deepEqual(i.intercept(ev.toolCall('call_B')).events, [])
    assert.equal(i.intercept(ev.toolCall('call_C')).events.length, 1)
    assert.deepEqual(i.intercept(ev.toolResult('call_A')).events, [])
    assert.equal(i.intercept(ev.toolResult('call_C')).events.length, 1)
    assert.equal(i.aligned(), true)
})

test('interceptor drops a re-derived usage when usage was already delivered', () => {
    const i = createAdoptionInterceptor(
        baselineOf([{ eventType: 'usage', payloadJson: {} }])
    )
    const usage: EmittedChatEvent = {
        type: 'usage',
        usage: { model: 'm', inputTokens: 1, outputTokens: 2 } as never
    }
    assert.deepEqual(i.intercept(usage).events, [])
    assert.equal(i.intercept(usage).events.length, 1)
})
