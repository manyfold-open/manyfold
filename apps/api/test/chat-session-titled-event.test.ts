import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ChatContentBlock,
    ChatSessionsChangedEvent
} from '@manyfold/shared'
import { ChatService } from '../src/modules/chat/chat.service'

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const makeHarness = (
    options: { titleWon: boolean } = { titleWon: true }
): {
    service: ChatService
    emitted: Array<{ userId: string; event: ChatSessionsChangedEvent }>
} => {
    const inserted: unknown[] = []
    const emitted: Array<{
        userId: string
        event: ChatSessionsChangedEvent
    }> = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
    }
    const repo = {
        getSession: async () => sessionRow,
        insertMessage: async (row: {
            contentBlocksJson: ChatContentBlock[]
        }) => {
            inserted.push(row)
            return row
        },
        listMessages: async () => inserted,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        updateTitleIfEmpty: async () => options.titleWon,
        touchSession: async () => undefined,
        listSessions: async () => [sessionRow],
        listFirstUserMessages: async () => [
            {
                sessionId: 'session-1',
                contentBlocksJson: [
                    { type: 'text', text: 'ship the retry fix' }
                ]
            }
        ],
        listSessionChannels: async () => []
    }
    const broadcaster = {
        setStreamFence: () => undefined,
        beginStream: () => undefined,
        emit: async () => ({ persisted: true }),
        emitDetached: async () => true
    }
    const adapters = {
        get: () => ({
            sendMessage: async function* () {
                yield { type: 'done', finalMessageId: 'msg-assistant' }
            }
        })
    }
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        { build: async () => ({}) } as never,
        { publishStatus: () => {} } as never,
        { event: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )
    ;(service as unknown as { statusBroadcaster?: unknown }).statusBroadcaster =
        {
            emitSessionsChanged: (
                userId: string,
                event: ChatSessionsChangedEvent
            ) => {
                emitted.push({ userId, event })
            }
        }
    return { service, emitted }
}

// WHY: A2A and openai-compat create sessions with no title, so a row pushed
// live at create time would sit untitled in the sidebar until a reload.
test('a derived first-turn title emits chat-sessions-changed', async () => {
    const h = makeHarness()

    await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'ship the retry fix'
    )

    assert.equal(h.emitted.length, 1)
    assert.equal(h.emitted[0]?.userId, 'user-1')
    assert.equal(h.emitted[0]?.event.type, 'chat-sessions-changed')
    assert.equal(h.emitted[0]?.event.reason, 'titled')
    assert.equal(h.emitted[0]?.event.agentId, 'agent-1')
    assert.equal(h.emitted[0]?.event.sessionId, 'session-1')
})

// WHY: updateTitleIfEmpty is a CAS on title IS NULL. Two racing turns both
// derive a title but only one flips the row, so only that one may notify.
test('a losing racing turn emits nothing', async () => {
    const h = makeHarness({ titleWon: false })

    await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'ship the retry fix'
    )

    assert.deepEqual(h.emitted, [])
})

// WHY: listSessions read-repairs untitled rows with a fire-and-forget UPDATE
// and returns before it commits. Emitting there would make the client refetch,
// see title IS NULL again, re-derive and re-emit — a read/emit cycle bounded
// only by commit latency, not by any guard. The backfill already merges the
// titles into its own response, so that client has them without an event.
test('the listSessions title backfill emits nothing', async () => {
    const h = makeHarness()

    const sessions = await h.service.listSessions('user-1', 'agent-1')

    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.title, 'ship the retry fix')
    assert.deepEqual(h.emitted, [])
})
