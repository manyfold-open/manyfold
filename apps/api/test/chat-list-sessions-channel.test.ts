import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'

const date = new Date('2026-05-06T10:00:00.000Z')

const sessionRow = (id: string, title: string): Record<string, unknown> => ({
    id,
    userId: 'user-1',
    agentId: 'agent-1',
    title,
    frameworkSessionRef: null,
    createdAt: date,
    updatedAt: date
})

test('listSessions attaches channel metadata and keeps manual sessions null', async () => {
    const service = new ChatService(
        agentAccessDb() as never,
        {
            listSessions: async () => [
                sessionRow('session-manual', 'Manual'),
                sessionRow('session-channel', 'Channel')
            ],
            listFirstUserMessages: async () => [],
            listSessionChannels: async () => [
                {
                    chatSessionId: 'session-channel',
                    channelSessionId: 'chs-old',
                    channelId: 'channel-old',
                    provider: 'slack',
                    label: 'Older channel',
                    displayName: null,
                    channelSessionCreatedAt: new Date(
                        '2026-05-06T08:00:00.000Z'
                    ),
                    channelSessionUpdatedAt: new Date(
                        '2026-05-06T08:00:00.000Z'
                    )
                },
                {
                    chatSessionId: 'session-channel',
                    channelSessionId: 'chs-new',
                    channelId: 'channel-new',
                    provider: 'telegram',
                    label: 'Newest channel',
                    displayName: 'feat-login',
                    channelSessionCreatedAt: new Date(
                        '2026-05-06T09:00:00.000Z'
                    ),
                    channelSessionUpdatedAt: new Date(
                        '2026-05-06T09:00:00.000Z'
                    )
                }
            ]
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {}, error: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    const sessions = await service.listSessions('user-1', 'agent-1')

    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].id, 'session-manual')
    assert.equal(sessions[0].channel, null)
    assert.equal(sessions[0].createdAt, date.toISOString())
    assert.deepEqual(sessions[1].channel, {
        id: 'channel-new',
        channelSessionId: 'chs-new',
        provider: 'telegram',
        label: 'Newest channel',
        displayName: 'feat-login'
    })
})

const agentAccessDb = (): {
    select: () => {
        from: () => {
            where: () => {
                limit: () => Promise<Array<{ id: string; userId: string }>>
            }
        }
    }
} => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [{ id: 'agent-1', userId: 'user-1' }]
            })
        })
    })
})
