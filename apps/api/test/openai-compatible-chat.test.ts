import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'
import { OpenAiChatCompletionsController } from '../src/modules/openai-compat/openai-chat-completions.controller'
import {
    OpenAiChatCompletionsService,
    OpenAiCompatError
} from '../src/modules/openai-compat/openai-chat-completions.service'

const user: AuthPrincipal = {
    userId: 'user-1',
    email: 'user@example.com',
    kind: 'human-api-token',
    tokenId: 'pat_1',
    scopes: ['chat.completions']
}

test('OpenAI-compatible request validation rejects missing model', async () => {
    const harness = makeHarness()

    await assert.rejects(
        () =>
            harness.service.prepare(user, {
                messages: [{ role: 'user', content: 'hello' }]
            }),
        (err: unknown) =>
            err instanceof OpenAiCompatError && err.code === 'missing_model'
    )
})

test('OpenAI-compatible request validation rejects unsupported multimodal content', async () => {
    const harness = makeHarness()

    await assert.rejects(
        () =>
            harness.service.prepare(user, {
                model: 'agt_abc',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'describe' },
                            {
                                // image_url / file parts are now supported; an
                                // unknown part type is still rejected.
                                type: 'input_audio',
                                input_audio: { data: 'AAAA' }
                            }
                        ]
                    }
                ]
            }),
        (err: unknown) =>
            err instanceof OpenAiCompatError &&
            err.code === 'unsupported_message_content'
    )
})

test('OpenAI-compatible request validation rejects tool calls', async () => {
    const harness = makeHarness()

    await assert.rejects(
        () =>
            harness.service.prepare(user, {
                model: 'agt_abc',
                messages: [{ role: 'user', content: 'hello' }],
                tools: [{ type: 'function', function: { name: 'lookup' } }]
            }),
        (err: unknown) =>
            err instanceof OpenAiCompatError && err.code === 'unsupported_tools'
    )
})

test('OpenAI-compatible non-streaming response uses final chat completion shape', async () => {
    const harness = makeHarness({
        events: [
            { type: 'token', text: 'hello' },
            {
                type: 'usage',
                usage: {
                    model: 'test',
                    inputTokens: 3,
                    outputTokens: 5,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    costUsd: null,
                    costSource: 'unknown',
                    isFallbackModel: false,
                    firstTokenMs: null,
                    totalMs: null
                }
            },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-session-id'], 'cts-new')
    assert.equal(res.body.object, 'chat.completion')
    assert.equal(res.body.choices[0].message.content, 'hello')
    assert.deepEqual(res.body.usage, {
        prompt_tokens: 3,
        completion_tokens: 5,
        total_tokens: 8
    })
    assert.equal(res.body.metadata.session_id, 'cts-new')
})

test('OpenAI-compatible controller accepts api.full tokens', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_full'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, 'ok')
})

test('OpenAI-compatible streaming response writes SSE chunks and DONE sentinel', async () => {
    const harness = makeHarness({
        events: [
            { type: 'token', text: 'hel' },
            { type: 'token', text: 'lo' },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    const sse = res.rawChunks.join('')
    assert.equal(res.hijacked, true)
    assert.match(sse, /"object":"chat\.completion\.chunk"/)
    assert.match(sse, /"role":"assistant"/)
    assert.match(sse, /"content":"hel"/)
    assert.match(sse, /"content":"lo"/)
    assert.match(sse, /data: \[DONE\]\n\n$/)
})

// Reasoning rides delta.reasoning_content so a caller that only reads content
// gets the answer and nothing else. Tool activity deliberately stays in content.
test('OpenAI-compatible streaming keeps reasoning out of content', async () => {
    const harness = makeHarness({
        events: [
            { type: 'thinking', text: 'weighing ' },
            { type: 'thinking', text: 'the options' },
            {
                type: 'tool_call',
                toolCallId: 'call-1',
                toolName: 'search',
                args: { q: 'weather' }
            },
            { type: 'token', text: 'sunny' },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    const deltas = streamDeltas(res.rawChunks)
    assert.equal(
        deltas.map((d) => d.reasoning_content ?? '').join(''),
        'weighing the options'
    )
    const content = deltas.map((d) => d.content ?? '').join('')
    assert.equal(content.includes('[thinking]'), false)
    assert.match(content, /\[tool_call:search\]/)
    assert.match(content, /sunny$/)
})

// Deltas already sent cannot be retracted, so the superseding answer goes out
// once at the end and finish_reason is the only signal that the earlier text
// was moderated away.
test('OpenAI-compatible streaming ends a replaced turn on content_filter', async () => {
    const harness = makeHarness({
        events: [
            { type: 'token', text: 'the bad answer' },
            {
                type: 'replace',
                text: 'I cannot help with that.',
                reason: 'output_moderation'
            },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    const sse = res.rawChunks.join('')
    const deltas = streamDeltas(res.rawChunks)
    assert.equal(
        deltas.map((d) => d.content ?? '').join(''),
        'the bad answerI cannot help with that.'
    )
    assert.match(sse, /"finish_reason":"content_filter"/)
    assert.equal(sse.includes('"finish_reason":"stop"'), false)
})

test('OpenAI-compatible non-streaming returns only the superseding answer', async () => {
    const harness = makeHarness({
        events: [
            { type: 'token', text: 'the bad answer' },
            {
                type: 'replace',
                text: 'I cannot help with that.',
                reason: 'output_moderation'
            },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    const choice = res.body.choices[0]
    assert.equal(choice.message.content, 'I cannot help with that.')
    assert.equal(choice.finish_reason, 'content_filter')
})

test('OpenAI-compatible non-streaming response carries reasoning_content', async () => {
    const harness = makeHarness({
        events: [
            { type: 'thinking', text: 'weighing the options' },
            { type: 'token', text: 'sunny' },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    const message = res.body.choices[0].message
    assert.equal(message.content, 'sunny')
    assert.equal(message.reasoning_content, 'weighing the options')
})

test('OpenAI-compatible response omits reasoning_content when nothing was thought', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal('reasoning_content' in res.body.choices[0].message, false)
})

test('OpenAI-compatible metadata session id reuses an existing Manyfold session', async () => {
    const harness = makeHarness()

    await harness.service.prepare(user, {
        model: 'agt_abc',
        metadata: { session_id: 'cts-existing' },
        messages: [{ role: 'user', content: 'hello' }]
    })

    assert.deepEqual(harness.calls.createSession, [])
    assert.deepEqual(harness.calls.subscribeStream, ['cts-existing'])
})

test('OpenAI-compatible controller returns OpenAI-style missing auth errors', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.create(makeRequest(undefined), res as never, {
        model: 'agt_abc',
        messages: [{ role: 'user', content: 'hello' }]
    })

    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.body, {
        error: {
            message: 'Missing bearer token',
            type: 'authentication_error',
            code: 'missing_api_key'
        }
    })
})

test('OpenAI-compatible controller rejects non-nca bearer tokens', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer not_an_nca_token'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 401)
    assert.equal(res.body.error.code, 'invalid_api_key')
})

test('OpenAI-compatible controller returns invalid API key for bad nca token', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_bad'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.body, {
        error: {
            message: 'api token not found',
            type: 'authentication_error',
            code: 'invalid_api_key'
        }
    })
})

test('OpenAI-compatible controller rejects API tokens without chat scope', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_full_missing_chat'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 401)
    assert.equal(res.body.error.code, 'invalid_api_key')
    assert.match(res.body.error.message, /chat\.completions/)
})

test('OpenAI-compatible controller returns agent_not_found when token cannot access agent', async () => {
    const harness = makeHarness({
        createSessionError: new NotFoundException('agent not found')
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_missing',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error.code, 'agent_not_found')
})

test('OpenAI-compatible controller increments quota once per successful call', async () => {
    const harness = makeHarness()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        makeReply() as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )
    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        makeReply() as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.deepEqual(harness.calls.assertAndIncrement, ['user-1', 'user-1'])
})

test('OpenAI-compatible controller increments quota for streaming requests', async () => {
    const harness = makeHarness({
        events: [
            { type: 'token', text: 'hi' },
            { type: 'done', finalMessageId: 'msg-assistant' }
        ]
    })

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        makeReply() as never,
        {
            model: 'agt_abc',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.deepEqual(harness.calls.assertAndIncrement, ['user-1'])
})

test('OpenAI-compatible controller returns 429 rate_limit_error when quota exceeded', async () => {
    const harness = makeHarness({
        apiQuotaError: new HttpException(
            {
                message:
                    'monthly API request quota reached (10 for starter plan)',
                code: 'API_REQUEST_QUOTA_REACHED',
                current: 11,
                limit: 10,
                planName: 'starter'
            },
            HttpStatus.TOO_MANY_REQUESTS
        )
    })
    const res = makeReply()

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        res as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.equal(res.statusCode, 429)
    assert.deepEqual(res.body, {
        error: {
            message: 'monthly API request quota reached (10 for starter plan)',
            type: 'rate_limit_error',
            code: 'API_REQUEST_QUOTA_REACHED'
        }
    })
    assert.deepEqual(harness.calls.sendMessage, [])
})

test('OpenAI-compatible controller skips chat work when quota check throws', async () => {
    const harness = makeHarness({
        apiQuotaError: new HttpException(
            { message: 'over limit', code: 'API_REQUEST_QUOTA_REACHED' },
            HttpStatus.TOO_MANY_REQUESTS
        )
    })

    await harness.controller.create(
        makeRequest('Bearer nca_valid'),
        makeReply() as never,
        {
            model: 'agt_abc',
            messages: [{ role: 'user', content: 'hello' }]
        }
    )

    assert.deepEqual(harness.calls.createSession, [])
    assert.deepEqual(harness.calls.subscribeStream, [])
    assert.deepEqual(harness.calls.sendMessage, [])
})

type FakeEvent = Parameters<
    OpenAiChatCompletionsService['startTurn']
>[2] extends (event: infer Event) => void
    ? Event
    : never

const makeHarness = (
    opts: {
        events?: FakeEvent[]
        createSessionError?: Error
        apiQuotaError?: Error
    } = {}
) => {
    const calls = {
        createSession: [] as string[],
        subscribeStream: [] as string[],
        sendMessage: [] as Array<{
            userId: string
            agentId: string
            sessionId: string
            text: string
        }>,
        assertAndIncrement: [] as string[]
    }
    const chat = {
        createSession: async (userId: string, agentId: string) => {
            if (opts.createSessionError) throw opts.createSessionError
            calls.createSession.push(`${userId}:${agentId}`)
            return { id: 'cts-new' }
        },
        subscribeStream: async (
            _userId: string,
            _agentId: string,
            sessionId: string
        ) => {
            calls.subscribeStream.push(sessionId)
            return { id: sessionId }
        },
        sendMessage: async (
            userId: string,
            agentId: string,
            sessionId: string,
            text: string,
            _attachments: unknown,
            _model: unknown,
            _modelConfigSource: unknown,
            _modelConfig: unknown,
            _saveAsDefault: unknown,
            _claudeCodePermissionMode: unknown,
            _codexPermissionMode: unknown,
            observer: (event: FakeEvent) => void
        ) => {
            calls.sendMessage.push({ userId, agentId, sessionId, text })
            for (const event of opts.events ?? [
                { type: 'token', text: 'ok' },
                { type: 'done', finalMessageId: 'msg-assistant' }
            ])
                observer(event)
            return {
                userMessage: { id: 'msg-user' },
                assistantMessageId: 'msg-assistant'
            }
        }
    }
    const auth = {
        verifyBearerToken: async (token: string) => {
            if (token === 'nca_valid') return user
            if (token === 'nca_full')
                return {
                    ...user,
                    tokenId: 'pat_2',
                    scopes: ['api.full']
                }
            if (token === 'nca_full_missing_chat')
                return {
                    ...user,
                    tokenId: 'pat_3',
                    scopes: []
                }
            throw new Error('api token not found')
        }
    }
    const apiQuota = {
        assertAndIncrement: async (userId: string) => {
            calls.assertAndIncrement.push(userId)
            if (opts.apiQuotaError) throw opts.apiQuotaError
        }
    }
    const service = new OpenAiChatCompletionsService(chat as never, {} as never)
    const controller = new OpenAiChatCompletionsController(
        auth as never,
        service,
        apiQuota as never
    )
    return { service, controller, calls }
}

const streamDeltas = (chunks: string[]): Record<string, string>[] =>
    chunks
        .flatMap((chunk) => chunk.split('\n\n'))
        .map((line) => line.replace(/^data: /, '').trim())
        .filter((line) => line.length > 0 && line !== '[DONE]')
        .map((line) => JSON.parse(line) as { choices?: unknown[] })
        .flatMap((payload) => payload.choices ?? [])
        .map(
            (choice) =>
                (choice as { delta?: Record<string, string> }).delta ?? {}
        )

const makeRequest = (authorization: string | undefined) =>
    ({
        headers: authorization ? { authorization } : {}
    }) as never

const makeReply = () => {
    const reply = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as any,
        hijacked: false,
        rawChunks: [] as string[],
        header(key: string, value: string) {
            this.headers[key.toLowerCase()] = value
            return this
        },
        status(code: number) {
            this.statusCode = code
            return this
        },
        send(body: unknown) {
            this.body = body
            return this
        },
        hijack() {
            this.hijacked = true
        },
        raw: {
            socket: { setNoDelay: () => undefined },
            writeHead: (code: number, headers: Record<string, string>) => {
                reply.statusCode = code
                for (const [key, value] of Object.entries(headers))
                    reply.headers[key.toLowerCase()] = value
            },
            write: (chunk: string) => {
                reply.rawChunks.push(chunk)
            },
            end: () => undefined
        }
    }
    return reply
}
