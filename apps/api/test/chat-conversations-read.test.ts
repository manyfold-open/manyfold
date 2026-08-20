import type { ChatContentBlock } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { ChatService } from '../src/modules/chat/chat.service'

const sessionRow = (
    overrides: Partial<{
        id: string
        userId: string
        agentId: string
        title: string | null
        frameworkSessionRef: string | null
        createdAt: Date
        updatedAt: Date
    }> = {}
) => ({
    id: 'cts_1',
    userId: 'user-1',
    agentId: 'agt_1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides
})

const messageRow = (
    id: string,
    blocks: ChatContentBlock[] = [{ type: 'text', text: id }]
) => ({
    id,
    sessionId: 'cts_1',
    role: 'assistant',
    contentBlocksJson: blocks,
    capabilityEventsJson: null,
    compactedStreamRows: 42,
    streamCompactedAt: new Date('2026-06-02T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z')
})

const makeService = (repo: Record<string, unknown>): ChatService =>
    new ChatService(
        {} as never,
        repo as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

const responseCode = (err: unknown): string | undefined => {
    const body = (err as { getResponse?: () => unknown }).getResponse?.()
    return (body as { code?: string } | undefined)?.code
}

test('listConversations slices to limit, computes hasMore from limit+1, maps summaries', async () => {
    let seenOpts: { agentId: string | null; limit: number; order: string } = {
        agentId: 'unset',
        limit: -1,
        order: 'unset'
    }
    const service = makeService({
        resolveConversationCursor: async () => null,
        listUserConversationsPage: async (
            _userId: string,
            opts: { agentId: string | null; limit: number; order: string }
        ) => {
            seenOpts = opts
            // repo is asked for limit+1 rows; return exactly that to signal more
            return [
                sessionRow({ id: 'cts_1' }),
                sessionRow({ id: 'cts_2' }),
                sessionRow({ id: 'cts_3' })
            ]
        }
    })

    const result = await service.listConversations('user-1', {
        agentId: null,
        limit: 2,
        after: null,
        order: 'desc'
    })

    assert.equal(seenOpts.limit, 3) // limit + 1
    assert.equal(seenOpts.order, 'desc')
    assert.equal(result.items.length, 2)
    assert.equal(result.hasMore, true)
    assert.equal(result.items[0].id, 'cts_1')
    assert.equal(result.items[0].channel, null)
    assert.equal(result.items[0].agentId, 'agt_1')
})

test('listConversations resolves the after cursor under the same predicate', async () => {
    let seenAfter: { id: string } | null = null
    const service = makeService({
        resolveConversationCursor: async (
            _userId: string,
            opts: { agentId: string | null },
            after: string
        ) => {
            assert.equal(opts.agentId, 'agt_x')
            return { createdAt: new Date('2026-06-01T00:00:00Z'), id: after }
        },
        listUserConversationsPage: async (
            _userId: string,
            opts: { after: { id: string } | null }
        ) => {
            seenAfter = opts.after
            return []
        }
    })

    await service.listConversations('user-1', {
        agentId: 'agt_x',
        limit: 5,
        after: 'cts_cursor',
        order: 'asc'
    })

    const capturedAfter = seenAfter as { id: string } | null
    assert.equal(capturedAfter?.id, 'cts_cursor')
})

test('listConversations rejects an unresolvable after cursor with invalid_after', async () => {
    const service = makeService({
        resolveConversationCursor: async () => null,
        listUserConversationsPage: async () => []
    })

    await assert.rejects(
        () =>
            service.listConversations('user-1', {
                agentId: null,
                limit: 5,
                after: 'cts_missing',
                order: 'desc'
            }),
        (err: unknown) =>
            err instanceof BadRequestException &&
            responseCode(err) === 'invalid_after'
    )
})

test('listConversationMessages 404s (without leaking) for unknown, channel-origin, and wrong bound agent', async () => {
    const unknown = makeService({ getSession: async () => null })
    await assert.rejects(
        () =>
            unknown.listConversationMessages('user-1', 'cts_x', {
                boundAgentId: null,
                limit: 20,
                after: null,
                order: 'desc'
            }),
        (err: unknown) =>
            err instanceof NotFoundException &&
            responseCode(err) === 'conversation_not_found'
    )

    const channel = makeService({
        getSession: async () => sessionRow(),
        listSessionChannels: async () => [{ chatSessionId: 'cts_1' }]
    })
    await assert.rejects(
        () =>
            channel.listConversationMessages('user-1', 'cts_1', {
                boundAgentId: null,
                limit: 20,
                after: null,
                order: 'desc'
            }),
        (err: unknown) =>
            err instanceof NotFoundException &&
            responseCode(err) === 'conversation_not_found'
    )

    const wrongAgent = makeService({
        getSession: async () => sessionRow({ agentId: 'agt_a' }),
        listSessionChannels: async () => []
    })
    await assert.rejects(
        () =>
            wrongAgent.listConversationMessages('user-1', 'cts_1', {
                boundAgentId: 'agt_b',
                limit: 20,
                after: null,
                order: 'desc'
            }),
        (err: unknown) =>
            err instanceof NotFoundException &&
            responseCode(err) === 'conversation_not_found'
    )
})

test('listConversationMessages resolves after via getMessage and paginates with hasMore', async () => {
    let seen: { limit: number; after: { id: string } | null; order: string } = {
        limit: -1,
        after: null,
        order: 'unset'
    }
    const service = makeService({
        getSession: async () => sessionRow(),
        listSessionChannels: async () => [],
        getMessage: async (_sessionId: string, id: string) => messageRow(id),
        listSessionMessagesPageWithUsage: async (
            _sessionId: string,
            opts: { limit: number; after: { id: string } | null; order: string }
        ) => {
            seen = opts
            return [messageRow('m1'), messageRow('m2'), messageRow('m3')].map(
                (message) => ({ message, usage: null })
            )
        },
        terminalErrorsForMessages: async () => new Map()
    })

    const result = await service.listConversationMessages('user-1', 'cts_1', {
        boundAgentId: null,
        limit: 2,
        after: 'm0',
        order: 'desc'
    })

    assert.equal(seen.after?.id, 'm0')
    assert.equal(seen.limit, 3) // limit + 1
    assert.equal(seen.order, 'desc')
    assert.equal(result.items.length, 2)
    assert.equal(result.hasMore, true)
    assert.equal(result.items[0].id, 'm1')
    assert.equal(
        'compactedStreamRows' in result.items[0],
        false,
        'Admin-only compaction evidence must not enter the public Chat API'
    )
    assert.equal('streamCompactedAt' in result.items[0], false)
})

test('listConversationMessages rejects an unresolvable after cursor with invalid_after', async () => {
    const service = makeService({
        getSession: async () => sessionRow(),
        listSessionChannels: async () => [],
        getMessage: async () => null
    })

    await assert.rejects(
        () =>
            service.listConversationMessages('user-1', 'cts_1', {
                boundAgentId: null,
                limit: 20,
                after: 'm_missing',
                order: 'desc'
            }),
        (err: unknown) =>
            err instanceof BadRequestException &&
            responseCode(err) === 'invalid_after'
    )
})
