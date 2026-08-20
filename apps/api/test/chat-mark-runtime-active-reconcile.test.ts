import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'

const runtimeRow = {
    id: 'rt-1',
    userId: 'user-1',
    name: 'main',
    framework: 'narranexus',
    kind: 'sprites',
    status: 'ready'
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

const makeWakeHarness = (agentOver: Record<string, unknown> = {}) => {
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: 'narranexus',
        runtime: 'sprites',
        runtimeId: 'rt-1',
        spriteName: 'sprite-1',
        spriteStatus: 'warm',
        status: 'stopped',
        k8sPodPhase: null,
        accountId: 'acc-1',
        model: null,
        ...agentOver
    }
    const callLog: string[] = []
    const publishPatches: Array<Record<string, unknown>> = []
    const touchedRuntimes: unknown[] = []
    const warnings: string[] = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agentRow]
                })
            })
        })
    }
    const spriteStatusSync = {
        publishStatus: async (
            _row: unknown,
            patch: Record<string, unknown>
        ) => {
            callLog.push('publishStatus')
            publishPatches.push(patch)
        }
    }
    const spritesProvisioner = {
        wakeSpriteRuntime: async () => {
            callLog.push('wakeSpriteRuntime')
        }
    }
    const runtimes = {
        findById: async () => runtimeRow
    }
    const reconcile = {
        touchRuntime: (runtime: unknown) => {
            callLog.push('touchRuntime')
            touchedRuntimes.push(runtime)
        }
    }
    const service = new ChatService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        spriteStatusSync as never,
        {} as never,
        {} as never,
        spritesProvisioner as never,
        runtimes as never,
        undefined as never,
        reconcile as never
    )
    service['logger'].warn = (msg: string) => {
        warnings.push(msg)
    }
    return { service, callLog, publishPatches, touchedRuntimes, warnings }
}

test('markRuntimeActive publishes running, nudges the sprite service, then touches reconcile with the runtime row', async () => {
    const h = makeWakeHarness()

    await h.service['markRuntimeActive']('agent-1')

    // The lease-free wake rename (startSpriteServices → wakeSpriteRuntime) must
    // not disturb the reconcile heal order, and chat remains the wake entry for
    // channels/automations which funnel through it
    assert.deepEqual(
        h.callLog,
        ['publishStatus', 'wakeSpriteRuntime', 'touchRuntime'],
        `chat wakes hide the transition from sprite-status-sync (publishStatus writes running directly) and channel/CLI/automation sends never hit the list/get views that call touchRuntime, so the send itself must schedule the healing reconcile — and only after the lease-free wake nudge, or the listing hits a still-booting gateway; the heal order must survive the wakeSpriteRuntime rename; warnings: [${h.warnings.join('; ')}]`
    )
    assert.deepEqual(
        h.publishPatches,
        [{ spriteStatus: 'running' }],
        'the optimistic running publish is exactly why sprite-status-sync never observes a wake transition for chat-originated wakes'
    )
    assert.equal(
        h.touchedRuntimes[0],
        runtimeRow,
        'touchRuntime must receive the runtime row loaded via runtimes.findById so reconcile re-lists the runtime that hosts the poisoned row'
    )
})

test('markRuntimeActive wakes a stopped agent — it reads no agent.status', async () => {
    const h = makeWakeHarness({ status: 'stopped', spriteStatus: 'running' })

    await h.service['markRuntimeActive']('agent-1')

    assert.ok(
        h.callLog.includes('wakeSpriteRuntime'),
        `markRuntimeActive reads no agent.status: a #108-poisoned stopped row must still wake the sprite service, otherwise the false status would lock the agent out of its only heal path; warnings: [${h.warnings.join('; ')}]`
    )
    assert.ok(
        h.callLog.includes('touchRuntime'),
        'the reconcile touch must fire for stopped rows — it is the trigger that lets the next successful listing flip the row back to running'
    )
})

test('sendMessage has no agent.status gate: a stopped agent still accepts and persists the user message', async () => {
    const stoppedAgentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId: 'rt-1',
        spriteName: 'sprite-1',
        spriteStatus: 'warm',
        status: 'stopped',
        k8sPodPhase: null,
        accountId: 'acc-1',
        model: null,
        modelProviderId: null,
        daemonId: null
    }
    const inserted: Array<{
        id: string
        sessionId: string
        role: string
        contentBlocksJson: unknown
        capabilityEventsJson: unknown
        createdAt: Date
    }> = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [stoppedAgentRow]
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
        insertMessage: async (row: {
            id: string
            sessionId: string
            role: string
            contentBlocksJson: unknown
            capabilityEventsJson: unknown
            createdAt: Date
        }) => {
            inserted.push(row)
            return row
        },
        listMessages: async () => inserted,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        updateTitleIfEmpty: async () => undefined,
        touchSession: async () => undefined
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
        {} as never,
        { publishStatus: async () => undefined } as never,
        { event: () => undefined } as never,
        {} as never,
        { wakeSpriteRuntime: async () => undefined } as never,
        { findById: async () => runtimeRow } as never,
        undefined as never,
        { touchRuntime: () => undefined } as never
    )

    const result = await service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'wake up please'
    )
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(
        result.userMessage.role,
        'user',
        'sendMessage must resolve for a stopped agent — the server send path is the wake/heal contract (fix E) and must never gate on the advisory agent.status, otherwise the web lockout would extend to CLI/channels/automations'
    )
    const userInsert = inserted.find((row) => row.role === 'user')
    assert.ok(
        userInsert,
        'repo.insertMessage must receive the user message even when agent.status is stopped — sending is the only self-service path that wakes the sprite and heals a #108-poisoned row'
    )
    assert.deepEqual(
        userInsert.contentBlocksJson,
        [{ type: 'text', text: 'wake up please' }],
        'the stopped status must not alter or drop the persisted user content'
    )
    assert.ok(
        result.assistantMessageId,
        'the assistant turn must start despite the stopped status — genuine unavailability fails loud via adapter errors in the session, not via a pre-send gate'
    )
})
