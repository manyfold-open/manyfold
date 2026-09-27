import assert from 'node:assert/strict'
import test from 'node:test'
import type { SdkAgent } from '@manyfold/sdk'
import { makeAgentSummary } from './hostModelFixtures'
import {
    applyAgentStatusSnapshots,
    applyHostPowerUpdate,
    getAgentChatAvailability,
    reconcileSidebarAgents,
    sortSidebarAgents
} from '../src/lib/chatAgents'

const agent = (patch: Partial<SdkAgent>): SdkAgent =>
    makeAgentSummary({
        id: 'agent-a',
        runtimeId: 'runtime-1',
        hostId: 'host-1',
        framework: 'codex',
        mountPath: '/workspace',
        internalId: 'internal-a',
        workspacePath: '/home/sprite/.nca/workspaces/agent-a',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        ...patch
    })

test('sorts sidebar agents by newest createdAt first', () => {
    const rows = [
        agent({
            id: 'agent-old',
            createdAt: '2026-05-01T00:00:00.000Z'
        }),
        agent({
            id: 'agent-new',
            createdAt: '2026-05-03T00:00:00.000Z'
        }),
        agent({
            id: 'agent-mid',
            createdAt: '2026-05-02T00:00:00.000Z'
        })
    ]

    assert.deepEqual(
        sortSidebarAgents(rows).map((row) => row.id),
        ['agent-new', 'agent-mid', 'agent-old']
    )
})

test('keeps sidebar agent order stable when updatedAt changes', () => {
    const olderButRecentlyUpdated = agent({
        id: 'agent-old',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z'
    })
    const newerButNotRecentlyUpdated = agent({
        id: 'agent-new',
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
    })

    assert.deepEqual(
        sortSidebarAgents([
            olderButRecentlyUpdated,
            newerButNotRecentlyUpdated
        ]).map((row) => row.id),
        ['agent-new', 'agent-old']
    )
})

test('uses id as a deterministic tie breaker for sidebar agents', () => {
    const rows = [
        agent({ id: 'agent-c' }),
        agent({ id: 'agent-a' }),
        agent({ id: 'agent-b' })
    ]

    assert.deepEqual(
        sortSidebarAgents(rows).map((row) => row.id),
        ['agent-a', 'agent-b', 'agent-c']
    )
})

test('does not mutate sidebar agent input order', () => {
    const rows = [agent({ id: 'agent-b' }), agent({ id: 'agent-a' })]

    sortSidebarAgents(rows)

    assert.deepEqual(
        rows.map((row) => row.id),
        ['agent-b', 'agent-a']
    )
})

test('reuses the current agent list when a poll returns equivalent snapshots', () => {
    const current = [
        agent({
            id: 'agent-a',
            extras: { nested: { enabled: true } }
        }),
        agent({ id: 'agent-b' })
    ]
    const incoming = current.map((row) => ({
        ...row,
        extras: JSON.parse(JSON.stringify(row.extras)) as Record<
            string,
            unknown
        >
    }))

    const reconciled = reconcileSidebarAgents(current, incoming)

    assert.equal(reconciled, current)
    assert.equal(reconciled[0], current[0])
    assert.equal(reconciled[1], current[1])
})

test('replaces only semantically changed agent snapshots', () => {
    const current = [
        agent({
            id: 'agent-a',
            extras: { nested: { enabled: true } }
        }),
        agent({ id: 'agent-b' })
    ]
    const incoming = [
        {
            ...current[0],
            extras: { nested: { enabled: false } }
        },
        { ...current[1] }
    ]

    const reconciled = reconcileSidebarAgents(current, incoming)

    assert.notEqual(reconciled, current)
    assert.equal(reconciled[0], incoming[0])
    assert.equal(reconciled[1], current[1])
})

test('preserves agent identities while applying incoming order changes', () => {
    const current = [agent({ id: 'agent-a' }), agent({ id: 'agent-b' })]
    const incoming = [{ ...current[1] }, { ...current[0] }]

    const reconciled = reconcileSidebarAgents(current, incoming)

    assert.notEqual(reconciled, current)
    assert.equal(reconciled[0], current[1])
    assert.equal(reconciled[1], current[0])
})

test('preserves unchanged identities when agents are added or removed', () => {
    const current = [agent({ id: 'agent-a' }), agent({ id: 'agent-b' })]
    const withAddition = reconcileSidebarAgents(current, [
        { ...current[0] },
        { ...current[1] },
        agent({ id: 'agent-c' })
    ])

    assert.equal(withAddition[0], current[0])
    assert.equal(withAddition[1], current[1])

    const withRemoval = reconcileSidebarAgents(withAddition, [
        { ...withAddition[1] },
        { ...withAddition[2] }
    ])

    assert.equal(withRemoval[0], current[1])
    assert.equal(withRemoval[1], withAddition[2])
})

test('same-value status events leave the agent list untouched', () => {
    const current = [
        agent({
            id: 'agent-a',
            powerState: 'suspended',
            availability: 'wakeable'
        })
    ]

    const reconciled = applyAgentStatusSnapshots(current, [
        {
            agentId: 'agent-a',
            powerState: 'suspended',
            availability: 'wakeable'
        }
    ])

    assert.equal(reconciled, current)
    assert.equal(reconciled[0], current[0])
})

test('status events replace only the affected agent', () => {
    const current = [
        agent({
            id: 'agent-a',
            powerState: 'suspended',
            availability: 'wakeable'
        }),
        agent({ id: 'agent-b' })
    ]

    const reconciled = applyAgentStatusSnapshots(current, [
        {
            agentId: 'agent-a',
            powerState: 'running',
            availability: 'available'
        }
    ])

    assert.notEqual(reconciled, current)
    assert.notEqual(reconciled[0], current[0])
    assert.equal(reconciled[0].powerState, 'running')
    assert.equal(reconciled[0].availability, 'available')
    assert.equal(reconciled[1], current[1])
})

test('a host power event reaches every agent on that host and no other', () => {
    const current = [
        agent({ id: 'agent-a', hostId: 'host-1' }),
        agent({ id: 'agent-b', hostId: 'host-1' }),
        agent({ id: 'agent-c', hostId: 'host-2' })
    ]

    const reconciled = applyHostPowerUpdate(current, {
        hostId: 'host-1',
        powerState: 'suspended',
        daemonOnline: false
    })

    assert.equal(reconciled[0].powerState, 'suspended')
    assert.equal(reconciled[0].daemonOnline, false)
    assert.equal(reconciled[1].powerState, 'suspended')
    assert.equal(reconciled[2], current[2])
    // Availability is the API's per-agent word, not re-derived here.
    assert.equal(reconciled[0].availability, current[0].availability)
    assert.equal(
        applyHostPowerUpdate(reconciled, {
            hostId: 'host-1',
            powerState: 'suspended',
            daemonOnline: false
        }),
        reconciled
    )
})

test('an asleep sandbox agent is ready to send', () => {
    const availability = getAgentChatAvailability(
        agent({ availability: 'wakeable', powerState: 'suspended' })
    )

    assert.equal(
        availability.ready,
        true,
        'sending wakes the sandbox and server-side reconcile self-heals; blocking the composer was the #108 lockout'
    )
})

test('an offline self-owned computer stays blocked with honest copy', () => {
    const availability = getAgentChatAvailability(
        agent({
            runtime: 'daemon',
            hostKind: 'local',
            providerKind: null,
            powerState: null,
            daemonOnline: false,
            availability: 'offline'
        })
    )

    assert.equal(availability.ready, false)
    assert.equal(availability.code, 'status')
    assert.ok(
        availability.reason?.includes('offline'),
        'the copy must say the machine is offline'
    )
    assert.ok(
        !availability.reason?.includes('repair'),
        'the copy must not promise a nonexistent repair action'
    )
})

test('a failed agent stays blocked', () => {
    const availability = getAgentChatAvailability(
        agent({ status: 'failed', availability: 'unavailable' })
    )

    assert.equal(
        availability.ready,
        false,
        'waking a sandbox does not fix a failed bootstrap'
    )
})

test('a pending agent stays blocked', () => {
    const availability = getAgentChatAvailability(
        agent({ status: 'pending', availability: 'unavailable' })
    )

    assert.equal(availability.ready, false)
    assert.ok(availability.reason?.includes('pending'))
})

test('an agent whose runtime is not available stays blocked', () => {
    const availability = getAgentChatAvailability(
        agent({ availability: 'unavailable' })
    )

    assert.equal(availability.ready, false)
    assert.equal(availability.code, 'status')
})

test('an asleep sandbox agent still hits the cli-upgrade gate', () => {
    const availability = getAgentChatAvailability(
        agent({
            availability: 'wakeable',
            powerState: 'suspended',
            daemonNeedsUpgrade: true
        })
    )

    assert.equal(availability.ready, false)
    assert.equal(
        availability.code,
        'cli-upgrade',
        'unblocking wakeable sandboxes must not skip the CLI-upgrade gate'
    )
})

test('null agent reports no-agent', () => {
    const availability = getAgentChatAvailability(null)

    assert.equal(
        availability.code,
        'no-agent',
        'selecting no agent must keep the dedicated no-agent state'
    )
})
