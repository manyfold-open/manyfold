import assert from 'node:assert/strict'
import test from 'node:test'
import {
    recoverTurnFromCodexRollout,
    type CodexTurnVerdict
} from '../src/modules/chat/recovery/turn-codex-rollout-recovery'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'

// The codex rollout carries explicit turn framing (task_started/task_complete
// by turn_id) and mirrors the CLI's stdout text verbatim in event_msg rows —
// these tests pin the anchoring, the terminal semantics, the cumulative-usage
// delta, and the incremental sinceLine cursor the adoption re-poll relies on.
// Shapes are modeled on a real codex-cli 0.144 rollout (probe 2026-07-24).

const row = {
    meta: (id: string): string =>
        JSON.stringify({ type: 'session_meta', payload: { id } }),
    taskStarted: (turnId: string): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: turnId }
        }),
    turnContext: (turnId: string, model: string): string =>
        JSON.stringify({
            type: 'turn_context',
            payload: { turn_id: turnId, cwd: '/w', model }
        }),
    userMessage: (message: string): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message }
        }),
    agentMessage: (message: string): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: { type: 'agent_message', message, phase: 'commentary' }
        }),
    agentReasoning: (text: string): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: { type: 'agent_reasoning', text }
        }),
    functionCall: (callId: string, name: string, args: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'function_call',
                id: `fc_${callId}`,
                call_id: callId,
                name,
                arguments: args
            }
        }),
    functionCallOutput: (callId: string, output: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: callId, output }
        }),
    assistantItem: (id: string, text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                id,
                role: 'assistant',
                content: [{ type: 'output_text', text }]
            }
        }),
    tokenCount: (input: number, cached: number, output: number): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: {
                    total_token_usage: {
                        input_tokens: input,
                        cached_input_tokens: cached,
                        output_tokens: output,
                        reasoning_output_tokens: 0
                    }
                }
            }
        }),
    taskComplete: (turnId: string): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: turnId }
        }),
    turnAborted: (turnId: string): string =>
        JSON.stringify({
            type: 'event_msg',
            payload: {
                type: 'turn_aborted',
                turn_id: turnId,
                reason: 'interrupted'
            }
        })
}

// A prior completed turn (turn-0) + the adopted turn (turn-1).
const priorTurn = [
    row.meta('thread-1'),
    row.taskStarted('turn-0'),
    row.userMessage('earlier prompt'),
    row.agentMessage('earlier answer'),
    row.tokenCount(100, 10, 20),
    row.taskComplete('turn-0')
]

const fsOf = (text: string | null): RecoveryFs =>
    ({
        locate: async () => (text === null ? null : '/w/.codex/rollout.jsonl'),
        readFile: async () => text,
        listFiles: async () => []
    }) as never

const recover = (
    lines: string[],
    opts?: { sinceLine?: number; promptText?: string }
): Promise<CodexTurnVerdict> =>
    recoverTurnFromCodexRollout({
        fs: fsOf(lines.join('\n') + '\n'),
        frameworkSessionRef: 'thread-1',
        promptText: opts?.promptText ?? 'run the probe',
        model: 'fallback-model',
        sinceLine: opts?.sinceLine ?? 0
    })

const fullTurn = [
    ...priorTurn,
    row.taskStarted('turn-1'),
    row.turnContext('turn-1', 'gpt-5.6-sol'),
    row.userMessage('run the probe'),
    row.agentReasoning('**Planning the run**'),
    row.agentMessage('Running it now.'),
    row.functionCall('call_A', 'exec_command', '{"cmd":"echo hi"}'),
    row.functionCallOutput('call_A', 'hi\n'),
    row.assistantItem('msg_1', 'Done: hi'),
    row.agentMessage('Done: hi'),
    row.tokenCount(300, 60, 90),
    row.taskComplete('turn-1')
]

test('recovers a completed codex turn: anchor, events in order, usage delta, model', async () => {
    const v = await recover(fullTurn)
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const semantic = v.events.filter((e) => e.type !== 'raw_source')
    assert.deepEqual(
        semantic.map((e) => e.type),
        ['thinking', 'token', 'tool_call', 'tool_result', 'token']
    )
    assert.deepEqual(semantic[1], { type: 'token', text: 'Running it now.' })
    const call = semantic[2] as { toolCallId: string; args: unknown }
    assert.equal(call.toolCallId, 'call_A')
    assert.deepEqual(call.args, { cmd: 'echo hi' })
    // Cumulative session totals minus the pre-turn totals.
    assert.equal(v.usage.inputTokens, 200)
    assert.equal(v.usage.cacheReadTokens, 50)
    assert.equal(v.usage.outputTokens, 70)
    assert.equal(v.usage.model, 'gpt-5.6-sol')
    assert.equal(v.usage.costSource, 'unknown')
    // The prior turn's content must never leak into this turn's events.
    assert.ok(
        !v.events.some(
            (e) => e.type === 'token' && e.text.includes('earlier answer')
        )
    )
})

test('a turn without its terminal marker is result_lost with its partial events', async () => {
    const inflight = fullTurn.slice(0, -2) // no token_count tail, no task_complete
    const v = await recover(inflight)
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /not terminal/)
    const semantic = v.events.filter((e) => e.type !== 'raw_source')
    assert.equal(semantic.length, 5, 'partial content still streams')
    assert.equal(v.lastSourceSeq, inflight.length)
})

test('sinceLine makes re-polls incremental: only new rows emit', async () => {
    const inflight = fullTurn.slice(0, priorTurn.length + 5)
    const first = await recover(inflight)
    assert.equal(first.outcome, 'result_lost')
    if (first.outcome !== 'result_lost') return
    const grown = fullTurn
    const second = await recover(grown, { sinceLine: first.lastSourceSeq })
    assert.equal(second.outcome, 'recovered')
    if (second.outcome !== 'recovered') return
    const semantic = second.events.filter((e) => e.type !== 'raw_source')
    assert.deepEqual(
        semantic.map((e) => e.type),
        ['tool_call', 'tool_result', 'token'],
        'rows already emitted by the previous poll must not repeat'
    )
})

test('turn_aborted closes the turn as turn_failed', async () => {
    const aborted = [
        ...fullTurn.slice(0, priorTurn.length + 5),
        row.turnAborted('turn-1')
    ]
    const v = await recover(aborted)
    assert.equal(v.outcome, 'turn_failed')
    if (v.outcome !== 'turn_failed') return
    assert.equal(v.detail, 'turn_aborted')
})

test('a prompt mismatch never emits another turn content', async () => {
    const v = await recover(fullTurn, { promptText: 'a DIFFERENT prompt' })
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /does not match/)
    assert.equal(v.events.length, 0)
})

test('missing rollout file fails loudly', async () => {
    const v = await recoverTurnFromCodexRollout({
        fs: fsOf(null),
        frameworkSessionRef: 'thread-1',
        promptText: '',
        model: null,
        sinceLine: 0
    })
    assert.equal(v.outcome, 'failed')
})

test('raw_source rows carry the rollout line and a stable id', async () => {
    const v = await recover(fullTurn)
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const sources = v.events.filter((e) => e.type === 'raw_source') as Array<{
        source: { externalId: string; sourceSeq: number; rawText: string }
    }>
    assert.equal(sources.length, 5)
    const callSource = sources.find((s) => s.source.externalId === 'call_A')
    assert.ok(callSource, 'tool rows key by call_id')
    assert.ok(callSource.source.rawText.includes('function_call'))
})
