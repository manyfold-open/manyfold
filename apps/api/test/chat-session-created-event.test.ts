import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatSessionsChangedEvent } from '@manyfold/shared'
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

const buildService = (
    broadcaster: unknown
): { service: ChatService; created: { id: string } } => {
    const created = { id: '' }
    const service = new ChatService(
        agentAccessDb() as never,
        {
            createSession: async (row: { id: string }) => {
                created.id = row.id
                return {
                    ...row,
                    createdAt: new Date('2026-05-06T10:00:00.000Z'),
                    updatedAt: new Date('2026-05-06T10:00:00.000Z')
                }
            }
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
    // The broadcaster is appended last and @Optional, so reaching it by field
    // survives the next optional dep being appended ahead of it.
    ;(service as unknown as { statusBroadcaster?: unknown }).statusBroadcaster =
        broadcaster
    return { service, created }
}

// WHY: every out-of-band producer (channels, automations, A2A, openai-compat)
// funnels through createSession, so this one emit is what the sidebar hears.
test('createSession emits chat-sessions-changed for the owning user', async () => {
    const emitted: Array<{ userId: string; event: ChatSessionsChangedEvent }> =
        []
    const { service, created } = buildService({
        emitSessionsChanged: (
            userId: string,
            event: ChatSessionsChangedEvent
        ) => {
            emitted.push({ userId, event })
        }
    })

    const session = await service.createSession('user-1', 'agent-1')

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.userId, 'user-1')
    assert.equal(emitted[0]?.event.agentId, 'agent-1')
    assert.equal(emitted[0]?.event.type, 'chat-sessions-changed')
    assert.equal(emitted[0]?.event.reason, 'created')
    assert.equal(emitted[0]?.event.sessionId, created.id)
    assert.equal(emitted[0]?.event.sessionId, session.id)
})

test('createSession works with no broadcaster wired', async () => {
    const { service } = buildService(undefined)

    const session = await service.createSession('user-1', 'agent-1')

    assert.equal(session.agentId, 'agent-1')
    assert.ok(session.id.startsWith('cts_'))
})
