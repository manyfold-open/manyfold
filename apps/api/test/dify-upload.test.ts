import {
    ChatMessage,
    chatCapabilitiesByFramework
} from '@manyfold/shared'
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
    type InvokeFile,
    type InvokeInput
} from '@manyfold/external-providers'
import { DifyChatAdapter } from '../src/modules/chat/adapters/external-api.adapter'

// The endpoint-safety guard does a real DNS lookup and blocks private hosts;
// this escape hatch lets us point the provider at a mock host instead.
process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'

const ORIGIN = 'http://dify.test'
const ENDPOINT = `${ORIGIN}/v1`

const SSE_OK =
    'data: {"event":"message","answer":"hi there","conversation_id":"conv-1"}\n\n' +
    'data: {"event":"message_end","metadata":{"usage":{"prompt_tokens":3,"completion_tokens":2}}}\n\n'

const textMessage = (text: string): ChatMessage => ({
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    contentBlocks: text ? [{ type: 'text', text }] : [],
    createdAt: new Date().toISOString()
})

const fileOf = (contentType: string): InvokeFile => ({
    name: 'attachment',
    contentType,
    size: 5,
    read: async () => Buffer.from('hello')
})

const invokeInput = (
    message: ChatMessage,
    files: InvokeFile[]
): InvokeInput => ({
    config: { endpointUrl: ENDPOINT, apiKey: 'app-test' },
    binding: { remoteRef: { userIdentifier: 'user-x' } },
    session: { id: 'session-1', frameworkSessionRef: null },
    message,
    history: [],
    model: null,
    modelConfig: null,
    files
})

const collect = async (input: InvokeInput): Promise<EmittedEvent[]> => {
    const events: EmittedEvent[] = []
    for await (const event of getExternalProvider('dify').invoke(
        input,
        new AbortController().signal
    ))
        events.push(event)
    return events
}

const withMock = async (
    setup: (pool: ReturnType<MockAgent['get']>) => void,
    run: () => Promise<void>
): Promise<void> => {
    const previous: Dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    try {
        setup(agent.get(ORIGIN))
        await run()
    } finally {
        setGlobalDispatcher(previous)
    }
}

test('uploads each file to /v1/files/upload and references it in chat-messages', async () => {
    let chatBody: { files?: unknown; user?: string; query?: string } = {}
    await withMock(
        (pool) => {
            pool.intercept({ path: '/v1/files/upload', method: 'POST' }).reply(
                200,
                { id: 'upload-xyz', mime_type: 'image/png' }
            )
            pool.intercept({
                path: '/v1/chat-messages',
                method: 'POST',
                body: (raw: string) => {
                    chatBody = JSON.parse(raw)
                    return true
                }
            }).reply(200, SSE_OK, {
                headers: { 'content-type': 'text/event-stream' }
            })
        },
        async () => {
            const events = await collect(
                invokeInput(textMessage('describe'), [fileOf('image/png')])
            )
            assert.deepEqual(chatBody.files, [
                {
                    type: 'image',
                    transfer_method: 'local_file',
                    upload_file_id: 'upload-xyz'
                }
            ])
            // same user identifier for upload and chat-messages
            assert.equal(chatBody.user, 'user-x')
            assert.equal(chatBody.query, 'describe')
            assert.ok(
                events.some((e) => e.type === 'token' && e.text === 'hi there')
            )
            assert.ok(events.some((e) => e.type === 'done'))
        }
    )
})

test('maps MIME to Dify file type (pdf -> document)', async () => {
    let chatBody: { files?: Array<{ type?: string }> } = {}
    await withMock(
        (pool) => {
            pool.intercept({ path: '/v1/files/upload', method: 'POST' }).reply(
                200,
                { id: 'up-doc' }
            )
            pool.intercept({
                path: '/v1/chat-messages',
                method: 'POST',
                body: (raw: string) => {
                    chatBody = JSON.parse(raw)
                    return true
                }
            }).reply(200, SSE_OK, {
                headers: { 'content-type': 'text/event-stream' }
            })
        },
        async () => {
            await collect(
                invokeInput(textMessage('read it'), [fileOf('application/pdf')])
            )
            assert.equal(chatBody.files?.[0]?.type, 'document')
        }
    )
})

test('a file-only message sends a single-space query (Dify rejects empty)', async () => {
    let chatBody: { query?: string } = {}
    await withMock(
        (pool) => {
            pool.intercept({ path: '/v1/files/upload', method: 'POST' }).reply(
                200,
                { id: 'up-1' }
            )
            pool.intercept({
                path: '/v1/chat-messages',
                method: 'POST',
                body: (raw: string) => {
                    chatBody = JSON.parse(raw)
                    return true
                }
            }).reply(200, SSE_OK, {
                headers: { 'content-type': 'text/event-stream' }
            })
        },
        async () => {
            await collect(invokeInput(textMessage(''), [fileOf('image/png')]))
            assert.equal(chatBody.query, ' ')
        }
    )
})

test('a failed file upload terminalizes the turn and never calls chat-messages', async () => {
    await withMock(
        (pool) => {
            pool.intercept({ path: '/v1/files/upload', method: 'POST' }).reply(
                400,
                'file type not allowed'
            )
            // no chat-messages intercept: disableNetConnect would throw if hit
        },
        async () => {
            const events = await collect(
                invokeInput(textMessage('hello'), [fileOf('image/png')])
            )
            const error = events.find((e) => e.type === 'error')
            assert.ok(error && error.type === 'error')
            assert.equal(error.error.code, 'dify_upload_http_400')
            assert.ok(!events.some((e) => e.type === 'token'))
        }
    )
})

test('dify exposes the attachments capability; langflow and a2a do not', () => {
    assert.equal(chatCapabilitiesByFramework.dify.attachments, true)
    assert.equal(chatCapabilitiesByFramework.langflow.attachments, false)
    assert.equal(chatCapabilitiesByFramework.a2a.attachments, false)
    const adapter = new DifyChatAdapter(
        null as never,
        null as never,
        null as never
    )
    assert.equal(adapter.getCapabilities().attachments, true)
})
