import { readyChatRunner, withRunnerCursors } from './chat-runner-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { ChatService } from '../src/modules/chat/chat.service'

const agentAccessDb = (): unknown => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [{ id: 'agent-1', userId: 'user-1' }]
            })
        })
    })
})

// An empty chat session the delete-if-empty query kept.
const serviceKeeping = (channelRows: unknown[]): ChatService =>
    new ChatService(
        agentAccessDb() as never,
        withRunnerCursors({
            getSession: async () => ({
                id: 'session-1',
                userId: 'user-1',
                agentId: 'agent-1'
            }),
            deleteSessionIfEmpty: async () => false,
            sessionHolderState: async () => ({ holderTerminalId: null }),
            sessionHasMessages: async () => false,
            listSessionChannels: async () => channelRows
        } as never),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {}, error: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        readyChatRunner(undefined)
    )

test('a delete-if-empty of a channel scope\'s session is refused with its own code', async () => {
    await assert.rejects(
        () =>
            serviceKeeping([
                { chatSessionId: 'session-1', channelSessionId: 'chs-1' }
            ]).deleteSession('user-1', 'agent-1', 'session-1'),
        (err) => {
            assert.ok(err instanceof ConflictException)
            assert.equal(
                (err.getResponse() as { code?: string }).code,
                'session_bound_to_channel'
            )
            return true
        }
    )
    await assert.rejects(
        () =>
            serviceKeeping([]).deleteSession('user-1', 'agent-1', 'session-1'),
        NotFoundException
    )
})
