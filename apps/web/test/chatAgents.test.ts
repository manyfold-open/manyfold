import assert from 'node:assert/strict'
import test from 'node:test'
import type { SdkAgent } from '@manyfold/sdk'
import {
    applyAgentStatusSnapshots,
    getAgentChatAvailability,
    reconcileSidebarAgents,
    sortSidebarAgents
} from '../src/lib/chatAgents'

const agent = (patch: Partial<SdkAgent>): SdkAgent => ({
    id: 'agent-a',
    userId: 'user-1',
    runtimeId: 'runtime-1',
    name: 'Agent A',
    framework: 'codex',
    frameworkVersion: null,
    frameworkLatestVersion: null,
    frameworkUpgradeAvailable: false,
    frameworkVersionBlockedReason: null,
    cliVersion: null,
    cliLatestVersion: null,
    cliUpdateAvailable: false,
    daemonId: null,
    daemonNeedsUpgrade: false,
    runtime: 'sprites',
    status: 'running',
    spriteStatus: null,
    k8sPodPhase: null,
    accountSlug: null,
    clusterId: null,
    clusterName: null,
    spriteName: null,
    spriteId: null,
    mountPath: '/workspace',
    namespace: null,
    ingressHost: null,
    endpointUrl: null,
    controlUiEnabled: false,
    dashboardEnabled: false,
    dashboardState: null,
    keepAliveEnabled: false,
    currentPhase: null,
    failureReason: null,
    internalId: 'internal-a',
    model: null,
    extras: {},
    workspacePath: '/home/sprite/.nca/workspaces/agent-a',
    storageBytes: null,
    storageMeasuredAt: null,
    lastActiveAt: null,
    lastMessageAt: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
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
            spriteStatus: 'warm',
            k8sPodPhase: 'Running'
        })
    ]

    const reconciled = applyAgentStatusSnapshots(current, [
        {
            agentId: 'agent-a',
            spriteStatus: 'warm',
            k8sPodPhase: 'Running'
        }
    ])

    assert.equal(reconciled, current)
    assert.equal(reconciled[0], current[0])
})

test('status events replace only the affected agent', () => {
    const current = [
        agent({
            id: 'agent-a',
            spriteStatus: 'warm',
            k8sPodPhase: 'Running'
        }),
        agent({ id: 'agent-b' })
    ]

    const reconciled = applyAgentStatusSnapshots(current, [
        {
            agentId: 'agent-a',
            spriteStatus: 'running',
            k8sPodPhase: 'Running'
        }
    ])

    assert.notEqual(reconciled, current)
    assert.notEqual(reconciled[0], current[0])
    assert.equal(reconciled[0].spriteStatus, 'running')
    assert.equal(reconciled[1], current[1])
})

test('stopped sprite agent is ready to send', () => {
    const availability = getAgentChatAvailability(
        agent({ status: 'stopped', runtime: 'sprites' })
    )

    assert.equal(
        availability.ready,
        true,
        'sending wakes the sprite and server-side reconcile self-heals; blocking the composer was the #108 lockout'
    )
})

test('stopped daemon agent stays blocked with honest copy', () => {
    const availability = getAgentChatAvailability(
        agent({ status: 'stopped', runtime: 'daemon' })
    )

    assert.equal(availability.ready, false)
    assert.equal(availability.code, 'status')
    assert.ok(
        availability.reason?.includes('stopped'),
        'the copy must state the actual agent status'
    )
    assert.ok(
        !availability.reason?.includes('repair'),
        'the copy must not promise a nonexistent repair action'
    )
})

test('failed sprite agent stays blocked', () => {
    const availability = getAgentChatAvailability(
        agent({ status: 'failed', runtime: 'sprites' })
    )

    assert.equal(
        availability.ready,
        false,
        'waking a sprite does not fix a failed bootstrap'
    )
})

test('pending sprite agent stays blocked', () => {
    const availability = getAgentChatAvailability(
        agent({ status: 'pending', runtime: 'sprites' })
    )

    assert.equal(
        availability.ready,
        false,
        'stopped-sprite is the only carve-out'
    )
})

test('stopped sprite agent still hits the cli-upgrade gate', () => {
    const availability = getAgentChatAvailability(
        agent({
            status: 'stopped',
            runtime: 'sprites',
            daemonNeedsUpgrade: true
        })
    )

    assert.equal(availability.ready, false)
    assert.equal(
        availability.code,
        'cli-upgrade',
        'unblocking wakeable sprites must not skip the CLI-upgrade gate'
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
