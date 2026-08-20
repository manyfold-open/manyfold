import assert from 'node:assert/strict'
import test from 'node:test'
import { agents } from '@manyfold/db'
import { ChatService } from '../src/modules/chat/chat.service'

const runtimeRow = {
    id: 'rt-1',
    userId: 'user-1',
    name: 'main',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'ready'
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: 'existing',
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'rt-1',
    spriteName: 'sprite-1',
    spriteStatus: 'running',
    status: 'running',
    k8sPodPhase: null,
    accountId: 'acc-1',
    model: null,
    modelProviderId: null,
    daemonId: null
}

interface UpdateCall {
    table: unknown
    patch: Record<string, unknown>
    scoped: boolean
}

const makeHarness = (opts: { updateFails?: boolean } = {}) => {
    const updates: UpdateCall[] = []
    const warnings: string[] = []
    const inserted: Array<{ id: string; role: string }> = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: (table: unknown) => ({
            set: (patch: Record<string, unknown>) => ({
                where: async (clause: unknown) => {
                    updates.push({ table, patch, scoped: clause !== undefined })
                    if (opts.updateFails)
                        throw new Error('connection terminated')
                }
            })
        })
    }
    const repo = {
        getSession: async () => sessionRow,
        insertMessage: async (row: { id: string; role: string }) => {
            inserted.push(row)
            return row
        },
        listMessages: async () => inserted,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        updateTitleIfEmpty: async () => undefined,
        touchSession: async () => undefined
    }
    const service = new ChatService(
        db as never,
        repo as never,
        {
            setStreamFence: () => undefined,
            beginStream: () => undefined,
            emit: async () => ({ persisted: true }),
            emitDetached: async () => true
        } as never,
        {
            get: () => ({
                sendMessage: async function* () {
                    yield { type: 'done', finalMessageId: 'msg-assistant' }
                }
            })
        } as never,
        {} as never,
        {} as never,
        { publishStatus: async () => undefined } as never,
        { event: () => undefined } as never,
        {} as never,
        { wakeSpriteRuntime: async () => undefined } as never,
        { findById: async () => runtimeRow } as never,
        undefined as never,
        { touchRuntime: () => undefined } as never
    )
    service['logger'].warn = (msg: string) => {
        warnings.push(msg)
    }
    return { service, updates, warnings, inserted }
}

const messageUpdates = (updates: UpdateCall[]): UpdateCall[] =>
    updates.filter((u) => 'lastMessageAt' in u.patch)

test('markAgentMessaged stamps lastMessageAt on the agents row for that agent only', async () => {
    const h = makeHarness()

    await h.service['markAgentMessaged']('agent-1')

    const calls = messageUpdates(h.updates)
    assert.equal(calls.length, 1)
    assert.equal(
        calls[0].table,
        agents,
        'the stamp belongs on the agents row, which is what the sidebar list reads — deriving it per request from chat tables would put an aggregate on a path polled every 5s'
    )
    assert.ok(
        calls[0].patch.lastMessageAt instanceof Date,
        'lastMessageAt must be a Date for the timestamptz column'
    )
    assert.deepEqual(
        calls[0].patch.updatedAt,
        calls[0].patch.lastMessageAt,
        'the row-level updatedAt moves with the stamp so list consumers see the change'
    )
    assert.ok(
        calls[0].scoped,
        'the update must carry a where clause — an unscoped stamp would mark every agent as just-prompted'
    )
    assert.deepEqual(h.warnings, [])
})

test('a failed stamp is swallowed: ordering metadata must never break a turn', async () => {
    const h = makeHarness({ updateFails: true })

    await h.service['markAgentMessaged']('agent-1')

    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0], /agent-1/)
})

test('sendMessage stamps lastMessageAt once the user message is persisted', async () => {
    const h = makeHarness()

    await h.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await new Promise((resolve) => setImmediate(resolve))

    assert.ok(
        h.inserted.some((row) => row.role === 'user'),
        'precondition: the turn persisted a user message'
    )
    assert.equal(
        messageUpdates(h.updates).length,
        1,
        'every prompt entry point (web chat, channels, automations, public API, A2A) funnels through sendMessage, so this one stamp is what keeps sidebar recency honest for all of them'
    )
})

test('a turn rejected by the inflight lock does not count as a prompt', async () => {
    const h = makeHarness()
    h.service['repo'].claimInflightTurn = async () => false

    await assert.rejects(
        h.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    )
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(
        messageUpdates(h.updates),
        [],
        'the stamp sits after insertMessage precisely so a 409-rejected concurrent send does not bump the agent to the top of the sidebar'
    )
})
