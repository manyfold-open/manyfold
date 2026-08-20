import test from 'node:test'
import assert from 'node:assert/strict'
import type { SdkAgent } from '@manyfold/sdk'
import { buildAgentMenuItems, isSectionBoundary } from '../src/lib/agentMenu'

// The builder only reads label keys, so echoing the key back is enough to
// assert which string each item pulls — and it keeps the suffix assertions
// about the builder rather than about en.ts copy.
const t = ((key: string) => key) as unknown as Parameters<
    typeof buildAgentMenuItems
>[1]

let seq = 0
const makeAgent = (over: Partial<SdkAgent> = {}): SdkAgent => {
    seq += 1
    return {
        id: `agt_${seq}`,
        userId: 'usr_1',
        runtimeId: 'rt_1',
        daemonId: null,
        daemonNeedsUpgrade: false,
        name: `Agent ${seq}`,
        framework: 'claude-code',
        frameworkVersion: null,
        frameworkLatestVersion: null,
        frameworkUpgradeAvailable: false,
        frameworkVersionBlockedReason: null,
        cliVersion: null,
        cliLatestVersion: null,
        cliUpdateAvailable: false,
        runtime: 'sprites',
        status: 'running',
        spriteStatus: null,
        k8sPodPhase: null,
        accountSlug: null,
        clusterId: null,
        clusterName: null,
        spriteName: null,
        spriteId: null,
        mountPath: '/',
        namespace: null,
        ingressHost: null,
        endpointUrl: null,
        controlUiEnabled: false,
        dashboardEnabled: false,
        dashboardState: null,
        keepAliveEnabled: false,
        currentPhase: null,
        failureReason: null,
        internalId: 'int',
        model: null,
        extras: {},
        workspacePath: null,
        storageBytes: null,
        storageMeasuredAt: null,
        startedAt: null,
        lastActiveAt: null,
        lastMessageAt: null,
        lastBootstrappedAt: null,
        lastReconciledAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over
    }
}

const noop = (): void => {}

const handlers = (
    over: Partial<Parameters<typeof buildAgentMenuItems>[2]> = {}
): Parameters<typeof buildAgentMenuItems>[2] => ({
    onRename: noop,
    onModelProvider: noop,
    onAgentSettings: noop,
    onOpenDashboard: noop,
    onOpenRuntime: noop,
    onDelete: noop,
    ...over
})

test('orders items quick actions, then navigation, then destructive', () => {
    const items = buildAgentMenuItems(makeAgent(), t, handlers())
    assert.deepEqual(
        items.map((item) => item.id),
        [
            'rename',
            'model-provider',
            'agent-settings',
            'open-dashboard',
            'runtime',
            'delete'
        ]
    )
    assert.deepEqual(
        items.map((item) => item.section),
        ['quick', 'quick', 'nav', 'nav', 'nav', 'danger']
    )
})

test('every dialog and destructive item promises a second step', () => {
    const items = buildAgentMenuItems(makeAgent(), t, handlers())
    for (const item of items) {
        if (item.kind === 'dialog' || item.kind === 'danger')
            assert.ok(
                item.label.endsWith('…'),
                `${item.id} should end with an ellipsis`
            )
        else
            assert.ok(
                !item.label.endsWith('…'),
                `${item.id} should not end with an ellipsis`
            )
    }
})

test('leaving the agent is marked with an arrow, entering it is not', () => {
    const byId = new Map(
        buildAgentMenuItems(makeAgent(), t, handlers()).map((item) => [
            item.id,
            item
        ])
    )
    assert.equal(byId.get('agent-settings')?.trailing, null)
    assert.equal(byId.get('runtime')?.trailing, '→')
    assert.equal(byId.get('open-dashboard')?.trailing, '↗')
    assert.equal(byId.get('rename')?.trailing, null)
})

test('drops the dashboard item when the framework has none', () => {
    const items = buildAgentMenuItems(
        makeAgent(),
        t,
        handlers({ onOpenDashboard: null })
    )
    assert.equal(
        items.some((item) => item.id === 'open-dashboard'),
        false
    )
})

test('drops the runtime item when the agent has no runtime attached', () => {
    const items = buildAgentMenuItems(
        makeAgent({ runtime: 'external', runtimeId: null }),
        t,
        handlers({ onOpenDashboard: null })
    )
    assert.deepEqual(
        items.map((item) => item.id),
        ['rename', 'model-provider', 'agent-settings', 'delete']
    )
})

test('an external agent still groups into exactly two sections', () => {
    const items = buildAgentMenuItems(
        makeAgent({ runtime: 'external', runtimeId: null }),
        t,
        handlers({ onOpenDashboard: null })
    )
    const boundaries = items
        .map((_, index) => index)
        .filter((index) => isSectionBoundary(items, index))
    assert.deepEqual(boundaries, [2, 3])
})

test('a delete in flight disables the item and says so', () => {
    const items = buildAgentMenuItems(makeAgent(), t, handlers(), {
        deleting: true
    })
    const remove = items.find((item) => item.id === 'delete')
    assert.equal(remove?.disabled, true)
    assert.equal(remove?.label, 'web.agents.detail.delete.deleting…')
})

test('a separator falls at each section change', () => {
    const items = buildAgentMenuItems(makeAgent(), t, handlers())
    const shape = items.flatMap((item, index) =>
        isSectionBoundary(items, index) ? ['---', item.label] : [item.label]
    )
    assert.deepEqual(shape, [
        'web.shell.rename…',
        'web.shell.modelProvider…',
        '---',
        'web.shell.agentSettings',
        'web.shell.openDashboard',
        'web.shell.runtime',
        '---',
        'web.agents.detail.delete.agentAction…'
    ])
})

test('only the destructive item is flagged danger', () => {
    const items = buildAgentMenuItems(makeAgent(), t, handlers())
    assert.equal(items.filter((item) => item.danger).length, 1)
})
