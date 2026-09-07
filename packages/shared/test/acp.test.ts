import assert from 'node:assert/strict'
import test from 'node:test'
import {
    acpEventsFromFrame,
    acpEventsFromNotification,
    acpModelMatches,
    decodeAcpSessionState,
    decodePermissionRequest,
    isFatalStderrLine,
    MANYFOLD_PERMISSION_RESOLUTION_METHOD,
    pickAutoApproveOptionId,
    pickRejectOptionId,
    pickStderrErrorLine,
    type AcpEvent
} from '../src/acp'

// The pure ACP decoders both clients (apps/api hermes-acp-client, apps/cli
// daemon/acp-turn) share. The frames below are recorded verbatim: the openclaw
// ones from a live `openclaw acp` bridge probe [2026-09-07], the hermes ones
// from its own traffic. A REPLAY of a buffered stream must decode to the exact
// same events a live turn produced, so this is the contract that keeps live and
// recovered turns from diverging.
//
// Prove-red control (manual): delete the `agent_thought_chunk` case in
// acpEventsFromNotification and the "openclaw thinking chunk" assertion fails;
// change `endsWith(':'+bare)` in acpModelMatches and the ollama-tag case fails.

test('agent_message_chunk -> text (openclaw live frame)', () => {
    const events = acpEventsFromNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            sessionId: 's1',
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Hello from the stub model.' }
            }
        }
    })
    assert.deepEqual(events, [
        { type: 'text', text: 'Hello from the stub model.' }
    ])
})

test('agent_thought_chunk -> thinking', () => {
    const events = acpEventsFromNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'deliberating' }
            }
        }
    })
    assert.deepEqual(events, [{ type: 'thinking', text: 'deliberating' }])
})

test('tool_call -> tool_call event (openclaw exec frame)', () => {
    const events = acpEventsFromNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call_1',
                title: 'exec: command: echo hi',
                status: 'in_progress',
                rawInput: { command: 'echo hi' },
                kind: 'execute'
            }
        }
    })
    assert.equal(events.length, 1)
    const ev = events[0] as Extract<AcpEvent, { type: 'tool_call' }>
    assert.equal(ev.type, 'tool_call')
    assert.equal(ev.toolCallId, 'call_1')
    assert.deepEqual(ev.input, { command: 'echo hi' })
})

test('tool_call_update: terminal statuses become results, progress is dropped', () => {
    assert.deepEqual(
        acpEventsFromNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'call_1',
                    status: 'in_progress'
                }
            }
        }),
        []
    )
    const done = acpEventsFromNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call_1',
                status: 'completed',
                rawOutput: { content: [{ type: 'text', text: 'ok' }] }
            }
        }
    })
    assert.equal(done.length, 1)
    assert.equal(done[0].type, 'tool_result')
})

test('normalizeUpdateKind tolerates snake/camel/kebab', () => {
    for (const kind of ['agent_message_chunk', 'agentMessageChunk', 'agent-message-chunk']) {
        const events = acpEventsFromNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { update: { sessionUpdate: kind, content: { type: 'text', text: 'x' } } }
        })
        assert.deepEqual(events, [{ type: 'text', text: 'x' }], kind)
    }
})

test('decodePermissionRequest: openclaw exec ask -> title + detail + options', () => {
    // Recorded verbatim from the live openclaw bridge [2026-09-07].
    const ev = decodePermissionRequest(0, {
        toolCall: {
            toolCallId: 'exec:f9d3ff40',
            title: 'Command approval requested',
            kind: 'execute',
            status: 'pending',
            rawInput: { name: 'exec', command: 'echo hi > /tmp/x.txt', host: 'gateway' }
        },
        options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
    })
    assert.equal(ev.type, 'permission_request')
    assert.equal(ev.requestId, '0')
    assert.equal(ev.title, 'Command approval requested')
    assert.equal(ev.detail, 'echo hi > /tmp/x.txt')
    assert.deepEqual(ev.options, [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ])
})

test('acpEventsFromFrame: agent request permission + synthetic resolution', () => {
    const req = acpEventsFromFrame({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/request_permission',
        params: { toolCall: { title: 'ask' }, options: [] }
    })
    assert.equal(req[0]?.type, 'permission_request')
    assert.equal((req[0] as { requestId: string }).requestId, '3')

    const res = acpEventsFromFrame({
        jsonrpc: '2.0',
        method: MANYFOLD_PERMISSION_RESOLUTION_METHOD,
        params: { requestId: '3', outcome: 'selected', optionId: 'allow-once' }
    })
    assert.deepEqual(res, [
        {
            type: 'permission_resolution',
            requestId: '3',
            outcome: 'selected',
            optionId: 'allow-once'
        }
    ])

    // A plain response frame carries no events.
    assert.deepEqual(
        acpEventsFromFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
        []
    )
})

test('pickAutoApproveOptionId: broadest allow first; legacy fallback is a parameter', () => {
    assert.equal(
        pickAutoApproveOptionId({
            options: [
                { optionId: 'a1', kind: 'allow_once' },
                { optionId: 'a2', kind: 'allow_always' }
            ]
        }),
        'a2'
    )
    // openclaw's allow-once / reject-once shape resolves to the allow.
    assert.equal(
        pickAutoApproveOptionId({
            options: [
                { optionId: 'allow-once', kind: 'allow_once' },
                { optionId: 'deny', kind: 'reject_once' }
            ]
        }),
        'allow-once'
    )
    // No options: hermes keeps its legacy id, openclaw passes null.
    assert.equal(pickAutoApproveOptionId(undefined, 'approve_for_session'), 'approve_for_session')
    assert.equal(pickAutoApproveOptionId(undefined), null)
})

test('pickRejectOptionId: reject_once first, any reject second', () => {
    assert.equal(
        pickRejectOptionId([
            { optionId: 'r1', kind: 'reject_always' },
            { optionId: 'r2', kind: 'reject_once' }
        ]),
        'r2'
    )
    assert.equal(pickRejectOptionId([{ optionId: 'r1', kind: 'reject_always' }]), 'r1')
    assert.equal(pickRejectOptionId([{ optionId: 'a', kind: 'allow_once' }]), null)
})

test('decodeAcpSessionState reads models/modes; null when neither populated', () => {
    const state = decodeAcpSessionState({
        models: {
            currentModelId: 'openrouter:anthropic/claude',
            availableModels: [{ modelId: 'openrouter:anthropic/claude' }, { modelId: 'openai:gpt-4' }]
        },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept_edits' }] }
    })
    assert.deepEqual(state, {
        currentModelId: 'openrouter:anthropic/claude',
        modelIds: ['openrouter:anthropic/claude', 'openai:gpt-4'],
        currentModeId: 'default',
        modeIds: ['default', 'accept_edits']
    })
    assert.equal(decodeAcpSessionState({}), null)
    assert.equal(decodeAcpSessionState(undefined), null)
})

test('acpModelMatches: bare vs provider:model, colon-safe for ollama tags', () => {
    assert.equal(acpModelMatches('openrouter:llama3:8b', 'llama3:8b'), true)
    assert.equal(acpModelMatches('llama3:8b', 'llama3:8b'), true)
    assert.equal(acpModelMatches('openrouter:gpt-4', 'gpt-4o'), false)
    assert.equal(acpModelMatches(null, 'gpt-4'), false)
})

test('stderr classifiers: fatal markers and most-informative line', () => {
    assert.equal(isFatalStderrLine('Aborting after 3 attempts'), true)
    assert.equal(isFatalStderrLine('Non-retryable provider error'), true)
    assert.equal(isFatalStderrLine('attempt 1/3 failed, retrying'), false)
    assert.equal(
        pickStderrErrorLine(['✓ booted', 'HTTP 401 Unauthorized', 'trailing']),
        'HTTP 401 Unauthorized'
    )
    assert.equal(pickStderrErrorLine(['✓ booted', 'ready']), null)
})
