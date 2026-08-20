import type {
    ChatContentBlock,
    ChatMessage,
    ChatSessionSummary
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'
import { OpenAiConversationsController } from '../src/modules/openai-compat/openai-conversations.controller'
import { OpenAiConversationsService } from '../src/modules/openai-compat/openai-conversations.service'

const CREATED_ISO = '2026-06-01T00:00:00.000Z'
const CREATED_UNIX = Math.floor(new Date(CREATED_ISO).getTime() / 1000)

const user: AuthPrincipal = {
    userId: 'user-1',
    email: 'user@example.com',
    kind: 'human-api-token',
    tokenId: 'pat_1',
    scopes: ['chat.completions']
}

const summary = (
    id: string,
    overrides: Partial<ChatSessionSummary> = {}
): ChatSessionSummary => ({
    id,
    agentId: 'agt_1',
    title: 'Title',
    frameworkSessionRef: null,
    channel: null,
    createdAt: CREATED_ISO,
    updatedAt: CREATED_ISO,
    ...overrides
})

const message = (
    id: string,
    contentBlocks: ChatContentBlock[]
): ChatMessage => ({
    id,
    sessionId: 'cts_1',
    role: 'assistant',
    contentBlocks,
    createdAt: CREATED_ISO,
    model: 'claude-sonnet-4-6',
    usage: null,
    error: null
})

test('list returns an OpenAI list envelope of conversation objects', async () => {
    const harness = makeHarness({
        conversations: {
            items: [summary('cts_1'), summary('cts_2')],
            hasMore: false
        }
    })
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_valid'),
        res as never,
        undefined,
        undefined,
        undefined,
        undefined
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.object, 'list')
    assert.equal(res.body.data.length, 2)
    assert.deepEqual(res.body.data[0], {
        object: 'conversation',
        id: 'cts_1',
        model: 'agt_1',
        title: 'Title',
        created_at: CREATED_UNIX,
        updated_at: CREATED_UNIX
    })
    assert.equal(res.body.first_id, 'cts_1')
    assert.equal(res.body.last_id, 'cts_2')
    assert.equal(res.body.has_more, false)
})

test('list defaults order to desc, limit to 20, and passes ?model through', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_valid'),
        res as never,
        'agt_x',
        undefined,
        undefined,
        undefined
    )

    assert.deepEqual(harness.calls.listConversations[0].params, {
        agentId: 'agt_x',
        limit: 20,
        after: null,
        order: 'desc'
    })
})

test('list passes limit / after / order through and reflects has_more + cursors', async () => {
    const harness = makeHarness({
        conversations: { items: [summary('cts_9')], hasMore: true }
    })
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_valid'),
        res as never,
        undefined,
        '2',
        'cts_after',
        'asc'
    )

    assert.deepEqual(harness.calls.listConversations[0].params, {
        agentId: null,
        limit: 2,
        after: 'cts_after',
        order: 'asc'
    })
    assert.equal(res.body.has_more, true)
    assert.equal(res.body.first_id, 'cts_9')
    assert.equal(res.body.last_id, 'cts_9')
})

test('list returns an empty envelope with null cursors', async () => {
    const harness = makeHarness({
        conversations: { items: [], hasMore: false }
    })
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_valid'),
        res as never,
        undefined,
        undefined,
        undefined,
        undefined
    )

    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.first_id, null)
    assert.equal(res.body.last_id, null)
    assert.equal(res.body.has_more, false)
})

test('list rejects an agent-bound token with 401 (no account-level /v1 access)', async () => {
    // B5b: an agent-bound bearer (apiToken.agentId set) must not drive the
    // account-level /v1 surface during the compat window. authenticateOpenAiRequest
    // rejects it before any service call, so the bound auto-scope path is unreachable.
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_bound'),
        res as never,
        undefined,
        undefined,
        undefined,
        undefined
    )

    assert.equal(res.statusCode, 401)
    assert.equal(res.body.error.code, 'invalid_api_key')
    assert.deepEqual(harness.calls.listConversations, [])
})

test('list rejects a non-integer / out-of-range limit with 400 invalid_limit', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_valid'),
        res as never,
        undefined,
        '500',
        undefined,
        undefined
    )

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'invalid_limit')
})

test('list rejects an unknown order with 400 invalid_order', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_valid'),
        res as never,
        undefined,
        undefined,
        undefined,
        'sideways'
    )

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'invalid_order')
})

test('messages returns the hybrid shape: text-only content + full content_blocks', async () => {
    const harness = makeHarness({
        messages: {
            items: [
                message('msg-1', [
                    { type: 'text', text: 'hello' },
                    {
                        type: 'tool_call',
                        toolCallId: 'tc1',
                        toolName: 'Bash',
                        args: { cmd: 'ls' }
                    },
                    { type: 'thinking', text: 'pondering' }
                ])
            ],
            hasMore: false
        }
    })
    const res = makeReply()

    await harness.controller.listMessages(
        makeRequest('Bearer nca_valid'),
        res as never,
        'cts_1',
        undefined,
        undefined,
        undefined
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.object, 'list')
    const msg = res.body.data[0]
    assert.equal(msg.object, 'message')
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.created_at, CREATED_UNIX)
    // content is OpenAI text parts only
    assert.deepEqual(msg.content, [{ type: 'text', text: 'hello' }])
    // content_blocks preserves tool_call + thinking fidelity
    assert.equal(msg.content_blocks.length, 3)
    assert.equal(msg.content_blocks[1].type, 'tool_call')
    assert.equal(msg.content_blocks[2].type, 'thinking')
    assert.deepEqual(Object.keys(msg).sort(), [
        'content',
        'content_blocks',
        'created_at',
        'id',
        'model',
        'object',
        'role'
    ])
})

test('messages sanitizes absolute workspace paths out of content_blocks', async () => {
    const harness = makeHarness({
        messages: {
            items: [
                message('msg-1', [
                    {
                        type: 'attachment',
                        name: 'file.txt',
                        path: '/root/.nca/workspaces/agt_1/sub/file.txt',
                        rootId: 'workspace',
                        contentType: 'text/plain',
                        size: 12
                    }
                ])
            ],
            hasMore: false
        }
    })
    const res = makeReply()

    await harness.controller.listMessages(
        makeRequest('Bearer nca_valid'),
        res as never,
        'cts_1',
        undefined,
        undefined,
        undefined
    )

    const block = res.body.data[0].content_blocks[0]
    assert.equal(block.path, 'sub/file.txt')
    assert.doesNotMatch(JSON.stringify(res.body), /\.nca\/workspaces/)
})

test('messages maps a NotFound (channel-origin / cross-user / bound) to a 404 body', async () => {
    const harness = makeHarness({
        messagesError: new NotFoundException({
            message: 'conversation not found',
            code: 'conversation_not_found'
        })
    })
    const res = makeReply()

    await harness.controller.listMessages(
        makeRequest('Bearer nca_valid'),
        res as never,
        'cts_x',
        undefined,
        undefined,
        undefined
    )

    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error.code, 'conversation_not_found')
})

test('messages maps an unresolvable after cursor to 400 invalid_after', async () => {
    const harness = makeHarness({
        messagesError: new BadRequestException({
            message: 'invalid after cursor',
            code: 'invalid_after'
        })
    })
    const res = makeReply()

    await harness.controller.listMessages(
        makeRequest('Bearer nca_valid'),
        res as never,
        'cts_1',
        undefined,
        'bad',
        undefined
    )

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'invalid_after')
})

test('endpoints accept api.full tokens', async () => {
    const harness = makeHarness()
    const res = makeReply()

    await harness.controller.list(
        makeRequest('Bearer nca_full'),
        res as never,
        undefined,
        undefined,
        undefined,
        undefined
    )

    assert.equal(res.statusCode, 200)
})

test('endpoints return OpenAI-style auth errors', async () => {
    const harness = makeHarness()

    const missing = makeReply()
    await harness.controller.list(
        makeRequest(undefined),
        missing as never,
        undefined,
        undefined,
        undefined,
        undefined
    )
    assert.equal(missing.statusCode, 401)
    assert.equal(missing.body.error.code, 'missing_api_key')

    const nonNca = makeReply()
    await harness.controller.list(
        makeRequest('Bearer not_an_nca_token'),
        nonNca as never,
        undefined,
        undefined,
        undefined,
        undefined
    )
    assert.equal(nonNca.statusCode, 401)
    assert.equal(nonNca.body.error.code, 'invalid_api_key')

    const badToken = makeReply()
    await harness.controller.list(
        makeRequest('Bearer nca_bad'),
        badToken as never,
        undefined,
        undefined,
        undefined,
        undefined
    )
    assert.equal(badToken.statusCode, 401)
    assert.equal(badToken.body.error.code, 'invalid_api_key')

    const noScope = makeReply()
    await harness.controller.list(
        makeRequest('Bearer nca_no_scope'),
        noScope as never,
        undefined,
        undefined,
        undefined,
        undefined
    )
    assert.equal(noScope.statusCode, 401)
    assert.match(noScope.body.error.message, /chat\.completions/)
})

const makeHarness = (
    opts: {
        conversations?: { items: ChatSessionSummary[]; hasMore: boolean }
        messages?: { items: ChatMessage[]; hasMore: boolean }
        messagesError?: Error
    } = {}
) => {
    const calls = {
        listConversations: [] as Array<{ userId: string; params: never }>,
        listConversationMessages: [] as Array<{
            userId: string
            sessionId: string
            params: never
        }>
    }
    const chat = {
        listConversations: async (userId: string, params: never) => {
            calls.listConversations.push({ userId, params })
            return opts.conversations ?? { items: [], hasMore: false }
        },
        listConversationMessages: async (
            userId: string,
            sessionId: string,
            params: never
        ) => {
            calls.listConversationMessages.push({ userId, sessionId, params })
            if (opts.messagesError) throw opts.messagesError
            return opts.messages ?? { items: [], hasMore: false }
        }
    }
    const auth = {
        verifyBearerToken: async (token: string) => {
            if (token === 'nca_valid') return user
            if (token === 'nca_bound')
                return {
                    userId: user.userId,
                    email: user.email,
                    kind: 'legacy-runtime',
                    agentId: 'agt_bound',
                    tokenId: 'pat_bound',
                    scopes: ['chat.completions'],
                    callerAgentId: null,
                    enforceAgentBinding: false,
                    createdVia: null
                }
            if (token === 'nca_full')
                return {
                    ...user,
                    tokenId: 'pat_full',
                    scopes: ['api.full']
                }
            if (token === 'nca_no_scope')
                return {
                    ...user,
                    tokenId: 'pat_none',
                    scopes: []
                }
            throw new Error('api token not found')
        }
    }
    const service = new OpenAiConversationsService(chat as never)
    const controller = new OpenAiConversationsController(auth as never, service)
    return { controller, calls }
}

const makeRequest = (authorization: string | undefined) =>
    ({
        headers: authorization ? { authorization } : {}
    }) as never

const makeReply = () => ({
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
        this.statusCode = code
        return this
    },
    send(body: unknown) {
        this.body = body
        return this
    }
})
