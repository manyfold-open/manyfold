import type {
    ChatContentBlock,
    ChatMessage
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ConflictException } from '@nestjs/common'
import type { ApiChatAdapterContext } from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'

const baseAgentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'codex',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null,
    spriteName: 'sprite-1',
    spriteStatus: 'running',
    accountId: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: 'Existing chat',
    frameworkSessionRef: 'codex-old-session',
    createdAt: new Date('2026-05-11T08:00:00Z'),
    updatedAt: new Date('2026-05-11T08:00:00Z')
}

test('regenerateMessage rejects non-codex agents', async () => {
    const harness = makeHarness({
        agent: { ...baseAgentRow, framework: 'claude-code' }
    })

    await assert.rejects(
        () =>
            harness.service.regenerateMessage(
                'user-1',
                'agent-1',
                'session-1',
                'msg-user',
                'edited'
            ),
        BadRequestException
    )
    assert.equal(harness.rewriteCalls, 0)
})

test('regenerateMessage rejects non-user messages', async () => {
    const harness = makeHarness({
        messages: [
            makeMessage('msg-assistant', 'assistant', [
                { type: 'text', text: 'answer' }
            ])
        ]
    })

    await assert.rejects(
        () =>
            harness.service.regenerateMessage(
                'user-1',
                'agent-1',
                'session-1',
                'msg-assistant',
                'edited'
            ),
        BadRequestException
    )
    assert.equal(harness.rewriteCalls, 0)
})

test('regenerateMessage rejects sessions with an active stream', async () => {
    const harness = makeHarness({ inflightMessageId: 'msg-active' })

    await assert.rejects(
        () =>
            harness.service.regenerateMessage(
                'user-1',
                'agent-1',
                'session-1',
                'msg-user',
                'edited'
            ),
        ConflictException
    )
    assert.equal(harness.rewriteCalls, 0)
})

test('regenerateMessage rewrites the user message, truncates following messages, and starts a fresh codex session', async () => {
    const harness = makeHarness({
        messages: [
            makeMessage('msg-prior', 'user', [
                { type: 'text', text: 'prior question' }
            ]),
            makeMessage('msg-user', 'user', [
                { type: 'text', text: 'old prompt' },
                {
                    type: 'attachment',
                    name: 'notes.txt',
                    path: '/workspace/notes.txt',
                    rootId: 'workspace',
                    contentType: 'text/plain',
                    size: 12
                }
            ]),
            makeMessage('msg-old-assistant', 'assistant', [
                { type: 'text', text: 'old answer' }
            ]),
            makeMessage('msg-after', 'user', [
                { type: 'text', text: 'follow up' }
            ])
        ]
    })

    const result = await harness.service.regenerateMessage(
        'user-1',
        'agent-1',
        'session-1',
        'msg-user',
        'edited prompt',
        'gpt-5.5',
        undefined,
        undefined,
        undefined,
        'full-access'
    )
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(result.deletedMessageIds, [
        'msg-old-assistant',
        'msg-after'
    ])
    assert.deepEqual(result.userMessage.contentBlocks, [
        { type: 'text', text: 'edited prompt' },
        {
            type: 'attachment',
            name: 'notes.txt',
            path: '/workspace/notes.txt',
            rootId: 'workspace',
            contentType: 'text/plain',
            size: 12
        }
    ])
    assert.equal(harness.rewriteCalls, 1)
    assert.equal(harness.frameworkRefCleared, true)
    assert.equal(harness.adapterCtx?.frameworkSessionRef, null)
    assert.equal(harness.adapterCtx?.model, 'gpt-5.5')
    assert.equal(harness.adapterCtx?.codexPermissionMode, 'full-access')
    assert.deepEqual(
        harness.adapterCtx?.history.map((message) => message.id),
        ['msg-prior', 'msg-user']
    )
    assert.equal(harness.adapterUserMessage?.id, 'msg-user')
    assert.equal(result.assistantMessageId, harness.insertedAssistantId)
})

test('regenerateMessage defaults omitted Codex permission mode to full-access', async () => {
    const harness = makeHarness()

    await harness.service.regenerateMessage(
        'user-1',
        'agent-1',
        'session-1',
        'msg-user',
        'edited prompt'
    )
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(harness.adapterCtx?.codexPermissionMode, 'full-access')
})

interface HarnessOptions {
    agent?: Record<string, unknown>
    messages?: DbMessage[]
    inflightMessageId?: string | null
}

interface DbMessage {
    id: string
    sessionId: string
    role: 'user' | 'assistant' | 'system'
    contentBlocksJson: ChatContentBlock[]
    capabilityEventsJson: unknown
    createdAt: Date
}

const makeHarness = (
    opts: HarnessOptions = {}
): {
    service: ChatService
    adapterCtx: ApiChatAdapterContext | null
    adapterUserMessage: ChatMessage | null
    insertedAssistantId: string | null
    rewriteCalls: number
    frameworkRefCleared: boolean
} => {
    const agent = opts.agent ?? baseAgentRow
    const messages = opts.messages?.map((message) => ({ ...message })) ?? [
        makeMessage('msg-user', 'user', [{ type: 'text', text: 'old prompt' }]),
        makeMessage('msg-old-assistant', 'assistant', [
            { type: 'text', text: 'old answer' }
        ])
    ]
    let rewriteCalls = 0
    let frameworkRefCleared = false
    let insertedAssistantId: string | null = null
    let adapterCtx: ApiChatAdapterContext | null = null
    let adapterUserMessage: ChatMessage | null = null

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agent]
                })
            })
        }),
        update: () => ({
            set: () => ({
                where: async () => undefined
            })
        })
    }
    const repo = {
        getSession: async () => sessionRow,
        latestInflightMessageId: async () => opts.inflightMessageId ?? null,
        claimInflightTurn: async () => opts.inflightMessageId == null,
        releaseInflightTurn: async () => {},
        getMessage: async (_sessionId: string, messageId: string) =>
            messages.find((message) => message.id === messageId) ?? null,
        rewriteMessageAndDeleteAfter: async (
            _sessionId: string,
            messageId: string,
            contentBlocks: ChatContentBlock[]
        ) => {
            rewriteCalls += 1
            frameworkRefCleared = true
            const index = messages.findIndex(
                (message) => message.id === messageId
            )
            if (index === -1) return null
            const deletedMessageIds = messages
                .slice(index + 1)
                .map((message) => message.id)
            messages[index] = {
                ...messages[index],
                contentBlocksJson: contentBlocks
            }
            const historyRows = messages.slice(0, index + 1)
            messages.splice(index + 1)
            return {
                userMessage: messages[index],
                deletedMessageIds,
                historyRows
            }
        },
        insertMessage: async (row: DbMessage) => {
            messages.push(row)
            if (row.role === 'assistant') insertedAssistantId = row.id
            return row
        },
        touchSession: async () => undefined,
        upsertMessageSources: async () => ({ upserted: 0 }),
        insertStreamEvent: async () => ({ id: BigInt(1) })
    }
    const broadcaster = {
        setStreamFence: () => undefined,
        beginStream: () => undefined,
        emit: async () => ({ persisted: true }),
        emitDetached: async () => true
    }
    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext,
            userMessage: ChatMessage
        ) {
            adapterCtx = ctx
            adapterUserMessage = userMessage
            yield { type: 'done' as const, finalMessageId: ctx.messageId }
        }
    }
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: async () => undefined } as never,
        { event: () => {}, error: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    return {
        service,
        get adapterCtx() {
            return adapterCtx
        },
        get adapterUserMessage() {
            return adapterUserMessage
        },
        get insertedAssistantId() {
            return insertedAssistantId
        },
        get rewriteCalls() {
            return rewriteCalls
        },
        get frameworkRefCleared() {
            return frameworkRefCleared
        }
    }
}

const makeMessage = (
    id: string,
    role: DbMessage['role'],
    contentBlocksJson: ChatContentBlock[]
): DbMessage => ({
    id,
    sessionId: 'session-1',
    role,
    contentBlocksJson,
    capabilityEventsJson: null,
    createdAt: new Date(`2026-05-11T08:00:0${id.length % 10}Z`)
})
