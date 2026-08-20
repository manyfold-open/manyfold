import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MockAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    type Dispatcher
} from 'undici'
import {
    getExternalProvider,
    type EmittedEvent,
    type InvokeInput
} from '@manyfold/external-providers'

// The endpoint-safety guard does a real DNS lookup and blocks private hosts;
// this escape hatch lets us point the provider at a mock host instead.
process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'

const ORIGIN = 'http://dify.test'
const ENDPOINT = `${ORIGIN}/v1`

const sse = (...payloads: Record<string, unknown>[]): string =>
    payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')

const reasoningChunk = (
    reasoning: string,
    isFinal = false
): Record<string, unknown> => ({
    event: 'reasoning_chunk',
    conversation_id: 'conv-1',
    data: {
        message_id: 'm-1',
        reasoning,
        node_id: 'llm-node',
        is_final: isFinal
    }
})

const agentLog = (
    id: string,
    label: string,
    status: string,
    extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
    event: 'agent_log',
    conversation_id: 'conv-1',
    data: {
        node_execution_id: 'nx-1',
        id,
        label,
        parent_id: null,
        error: null,
        status,
        data: {},
        metadata: {},
        node_id: 'agent-node',
        ...extra
    }
})

const MESSAGE_END = {
    event: 'message_end',
    metadata: { usage: { prompt_tokens: 3, completion_tokens: 2 } }
}

const invokeInput = (): InvokeInput => ({
    config: { endpointUrl: ENDPOINT, apiKey: 'app-test' },
    binding: { remoteRef: { userIdentifier: 'user-x' } },
    session: { id: 'session-1', frameworkSessionRef: null },
    message: {
        id: 'msg-1',
        sessionId: 'session-1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }],
        createdAt: new Date().toISOString()
    } satisfies ChatMessage,
    history: [],
    model: null,
    modelConfig: null
})

const collect = async (body: string): Promise<EmittedEvent[]> => {
    const previous: Dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    try {
        agent
            .get(ORIGIN)
            .intercept({ path: '/v1/chat-messages', method: 'POST' })
            .reply(200, body, {
                headers: { 'content-type': 'text/event-stream' }
            })
        const events: EmittedEvent[] = []
        for await (const event of getExternalProvider('dify').invoke(
            invokeInput(),
            new AbortController().signal
        ))
            events.push(event)
        return events
    } finally {
        setGlobalDispatcher(previous)
    }
}

const usageOf = (events: EmittedEvent[]): EmittedEvent & { type: 'usage' } => {
    const usage = events.find((e) => e.type === 'usage')
    assert.ok(usage, 'expected a usage event')
    return usage as EmittedEvent & { type: 'usage' }
}

// A chatflow LLM node in "separated" reasoning mode never puts the chain of
// thought in the answer, so dropping these events means the caller sees nothing
// until the whole thinking phase is over.
test('separated-mode reasoning streams as thinking ahead of the answer', async () => {
    const events = await collect(
        sse(
            reasoningChunk('weighing '),
            reasoningChunk('the options'),
            reasoningChunk('', true),
            { event: 'message', answer: 'done', conversation_id: 'conv-1' },
            MESSAGE_END
        )
    )
    assert.deepEqual(
        events.filter((e) => e.type === 'thinking' || e.type === 'token'),
        [
            { type: 'thinking', text: 'weighing ' },
            { type: 'thinking', text: 'the options' },
            { type: 'token', text: 'done' }
        ]
    )
})

test('agent node progress becomes tool call/result pairs', async () => {
    const events = await collect(
        sse(
            agentLog('log-round', 'ROUND 1', 'start'),
            agentLog('log-step', 'search Thought', 'start', {
                data: { query: 'weather' }
            }),
            agentLog('log-step', 'search Thought', 'success', {
                data: { output: 'sunny' }
            }),
            agentLog('log-round', 'ROUND 1', 'success'),
            { event: 'message', answer: 'sunny', conversation_id: 'conv-1' },
            MESSAGE_END
        )
    )
    assert.deepEqual(
        events.filter(
            (e) => e.type === 'tool_call' || e.type === 'tool_result'
        ),
        [
            {
                type: 'tool_call',
                toolCallId: 'log-round',
                toolName: 'ROUND 1',
                args: {}
            },
            {
                type: 'tool_call',
                toolCallId: 'log-step',
                toolName: 'search Thought',
                args: { query: 'weather' }
            },
            {
                type: 'tool_result',
                toolCallId: 'log-step',
                result: { output: 'sunny' }
            },
            { type: 'tool_result', toolCallId: 'log-round', result: {} }
        ]
    )
})

// Output moderation rewrites an answer that already streamed. Dropping this
// event leaves the caller holding text Dify decided should not stand.
test('message_replace surfaces the superseding answer', async () => {
    const events = await collect(
        sse(
            {
                event: 'message',
                answer: 'the bad answer',
                conversation_id: 'conv-1'
            },
            {
                event: 'message_replace',
                conversation_id: 'conv-1',
                answer: 'I cannot help with that.',
                reason: 'output_moderation'
            },
            MESSAGE_END
        )
    )
    assert.deepEqual(
        events.filter((e) => e.type === 'token' || e.type === 'replace'),
        [
            { type: 'token', text: 'the bad answer' },
            {
                type: 'replace',
                text: 'I cannot help with that.',
                reason: 'output_moderation'
            }
        ]
    )
})

test('an agent_log without an id is ignored', async () => {
    const events = await collect(
        sse(
            { event: 'agent_log', data: { label: 'ROUND 1', status: 'start' } },
            { event: 'message', answer: 'ok', conversation_id: 'conv-1' },
            MESSAGE_END
        )
    )
    assert.deepEqual(
        events.filter((e) => e.type === 'tool_call'),
        []
    )
})

// firstTokenMs feeds TTFT telemetry, so it has to mean "the caller saw answer
// text" — thinking and agent progress must not satisfy it.
test('firstTokenMs is anchored on the answer token, not on thinking', async () => {
    const withAnswer = await collect(
        sse(
            reasoningChunk('thinking hard'),
            { event: 'message', answer: 'hello', conversation_id: 'conv-1' },
            MESSAGE_END
        )
    )
    const measured = usageOf(withAnswer).usage.firstTokenMs
    assert.equal(typeof measured, 'number')
    assert.ok((measured as number) >= 0)

    const thinkingOnly = await collect(
        sse(
            reasoningChunk('thinking hard'),
            agentLog('log-1', 'ROUND 1', 'start'),
            MESSAGE_END
        )
    )
    assert.equal(usageOf(thinkingOnly).usage.firstTokenMs, null)
})
