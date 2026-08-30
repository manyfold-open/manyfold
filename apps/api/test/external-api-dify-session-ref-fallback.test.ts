import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
    createServer,
    type IncomingMessage,
    type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { DifyChatAdapter } from '../src/modules/chat/adapters/external-api.adapter'
import { TurnFenceLostError } from '../src/modules/chat/turn-fence'

const userMessage = (): ChatMessage => ({
    id: 'user-message-1',
    sessionId: 'cts_1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hello' }],
    createdAt: '2026-06-16T09:00:00.000Z'
})

const adapterCtx = (frameworkSessionRef: string | null) => ({
    userId: 'user_1',
    agentId: 'agt_1',
    runtimeId: null,
    sessionId: 'cts_1',
    messageId: 'assistant-message-1',
    framework: 'dify' as const,
    runtimeKind: 'external' as const,
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    frameworkSessionRef,
    history: [],
    turnFence: {
        messageId: 'assistant-message-1',
        ownerId: 'owner-1',
        generation: 1
    }
})

class FakeDb {
    select() {
        return {
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: 'agt_1',
                            userId: 'user_1',
                            extras: {
                                externalBinding: {
                                    providerId: 'ueap_1',
                                    framework: 'dify',
                                    remoteRef: { userIdentifier: 'user_1' }
                                }
                            }
                        }
                    ]
                })
            })
        }
    }
}

class FakeProviders {
    constructor(private readonly endpointUrl: string) {}

    async resolveForUser() {
        return {
            provider: 'dify' as const,
            endpointUrl: this.endpointUrl,
            apiKey: 'test-key',
            metadata: {}
        }
    }
}

class FakeChatRepo {
    readonly refs: Array<string | null> = []
    failWith: Error | null = null

    async updateFrameworkSessionRef(_sessionId: string, ref: string | null) {
        if (this.failWith) throw this.failWith
        this.refs.push(ref)
    }
}

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
    const items: T[] = []
    for await (const item of iterable) items.push(item)
    return items
}

const readJsonBody = async (
    req: IncomingMessage
): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
    >
}

const writeSse = (
    res: ServerResponse,
    payload: Record<string, unknown>
): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const withPrivateProviderEndpoints = async <T>(
    fn: () => Promise<T>
): Promise<T> => {
    const previous = process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS
    process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'
    try {
        return await fn()
    } finally {
        if (previous === undefined)
            delete process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS
        else process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = previous
    }
}

const startDifyServer = async (
    handler: (
        body: Record<string, unknown>,
        res: ServerResponse
    ) => Promise<void> | void
): Promise<{ endpointUrl: string; close: () => Promise<void> }> => {
    const server = createServer((req, res) => {
        void (async () => {
            if (req.method !== 'POST' || req.url !== '/v1/chat-messages') {
                res.writeHead(404)
                res.end()
                return
            }
            const body = await readJsonBody(req)
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            await handler(body, res)
            res.end()
        })().catch((err) => {
            res.writeHead(500)
            res.end((err as Error).message)
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        endpointUrl: `http://127.0.0.1:${port}/v1`,
        close: async () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()))
            })
    }
}

test('dify stale conversation id is cleared and retried once without a session ref', async () => {
    const attempts: unknown[] = []
    const server = await startDifyServer((body, res) => {
        attempts.push(body.conversation_id)
        if (attempts.length === 1) {
            writeSse(res, {
                event: 'error',
                code: 'ConversationNotExistsError',
                message: 'ConversationNotExistsError'
            })
            return
        }
        writeSse(res, {
            event: 'message',
            conversation_id: 'new-dify-session',
            answer: 'ok'
        })
        writeSse(res, {
            event: 'message_end',
            conversation_id: 'new-dify-session',
            metadata: {
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_price: '0'
                }
            }
        })
    })
    try {
        await withPrivateProviderEndpoints(async () => {
            const repo = new FakeChatRepo()
            const adapter = new DifyChatAdapter(
                new FakeDb() as never,
                new FakeProviders(server.endpointUrl) as never,
                repo as never
            )

            const events = await collect(
                adapter.sendMessage(
                    adapterCtx('old-dify-session'),
                    userMessage()
                )
            )

            assert.deepEqual(attempts, ['old-dify-session', ''])
            assert.deepEqual(repo.refs, [null, 'new-dify-session'])
            assert.deepEqual(
                events.map((event) => event.type),
                ['token', 'usage', 'done']
            )
            assert.equal(events[0].type, 'token')
            if (events[0].type === 'token') assert.equal(events[0].text, 'ok')
        })
    } finally {
        await server.close()
    }
})

test('dify fence loss while clearing a stale conversation stops before retry', async () => {
    const attempts: unknown[] = []
    const server = await startDifyServer((body, res) => {
        attempts.push(body.conversation_id)
        writeSse(res, {
            event: 'error',
            code: 'ConversationNotExistsError',
            message: 'ConversationNotExistsError'
        })
    })
    try {
        await withPrivateProviderEndpoints(async () => {
            const repo = new FakeChatRepo()
            repo.failWith = new TurnFenceLostError('assistant-message-1')
            const adapter = new DifyChatAdapter(
                new FakeDb() as never,
                new FakeProviders(server.endpointUrl) as never,
                repo as never
            )

            await assert.rejects(
                collect(
                    adapter.sendMessage(
                        adapterCtx('old-dify-session'),
                        userMessage()
                    )
                ),
                TurnFenceLostError
            )
            assert.deepEqual(attempts, ['old-dify-session'])
        })
    } finally {
        await server.close()
    }
})

test('dify stale conversation retry is disabled after provider output begins', async () => {
    const attempts: unknown[] = []
    const server = await startDifyServer((body, res) => {
        attempts.push(body.conversation_id)
        writeSse(res, {
            event: 'message',
            answer: 'partial'
        })
        writeSse(res, {
            event: 'error',
            code: 'ConversationNotExistsError',
            message: 'ConversationNotExistsError'
        })
    })
    try {
        await withPrivateProviderEndpoints(async () => {
            const repo = new FakeChatRepo()
            const adapter = new DifyChatAdapter(
                new FakeDb() as never,
                new FakeProviders(server.endpointUrl) as never,
                repo as never
            )

            const events = await collect(
                adapter.sendMessage(
                    adapterCtx('old-dify-session'),
                    userMessage()
                )
            )

            assert.deepEqual(attempts, ['old-dify-session'])
            assert.deepEqual(repo.refs, [])
            assert.deepEqual(
                events.map((event) => event.type),
                ['token', 'error', 'done']
            )
        })
    } finally {
        await server.close()
    }
})
