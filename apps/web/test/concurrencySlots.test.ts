import test from 'node:test'
import assert from 'node:assert/strict'
import type { SdkAgent } from '@manyfold/sdk'
import type { SandboxSummary } from '@manyfold/shared'
import {
    countActiveSandboxes,
    groupActiveSandboxes
} from '../src/lib/concurrencySlots'

let seq = 0
const makeAgent = (over: Partial<SdkAgent> = {}): SdkAgent => {
    seq += 1
    return {
        id: `agt_${seq}`,
        userId: 'usr_1',
        runtimeId: `spr_${seq}`,
        daemonId: null,
        daemonNeedsUpgrade: false,
        name: `Agent ${seq}`,
        framework: 'claude-code',
        frameworkVersion: null,
        frameworkLatestVersion: null,
        frameworkUpgradeAvailable: false,
        frameworkVersionBlockedReason: null,
        cliVersion: null,
        cliUpdateAvailable: false,
        cliLatestVersion: null,
        runtime: 'sprites',
        status: 'running',
        spriteStatus: 'running',
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
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        ...over
    }
}

const makeSandbox = (over: Partial<SandboxSummary> = {}): SandboxSummary => {
    seq += 1
    return {
        id: `sbx_${seq}`,
        userId: 'usr_1',
        name: `sandbox-${seq}`,
        accountSlug: 'acct',
        spriteName: null,
        spriteStatus: 'running',
        terminalEnabled: false,
        terminalModelCredentials: false,
        agentsCount: 0,
        detectedFrameworks: [],
        cliVersion: null,
        latestCliVersion: null,
        cliUpdateAvailable: false,
        activeSecondsThisPeriod: 0,
        emptiedAt: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        ...over
    }
}

const none: ReadonlySet<string> = new Set()

test('co-resident cross-framework agents share one slot', () => {
    const claude = makeAgent({ spriteName: 'sbx-1', framework: 'claude-code' })
    const codex = makeAgent({ spriteName: 'sbx-1', framework: 'codex' })
    const slots = groupActiveSandboxes([claude, codex], [], none)
    assert.equal(slots.length, 1)
    assert.deepEqual(
        slots[0].agents.map((a) => a.id),
        [claude.id, codex.id]
    )
    assert.equal(countActiveSandboxes([claude, codex], []), 1)
})

test('agents on the same runtime collapse into one slot', () => {
    const a = makeAgent({ spriteName: 'sbx-1', runtimeId: 'spr_x' })
    const b = makeAgent({ spriteName: 'sbx-1', runtimeId: 'spr_x' })
    assert.equal(countActiveSandboxes([a, b], []), 1)
})

test('distinct sprite VMs get distinct slots', () => {
    const a = makeAgent({ spriteName: 'sbx-1' })
    const b = makeAgent({ spriteName: 'sbx-2' })
    assert.equal(countActiveSandboxes([a, b], []), 2)
})

test('non-running and non-sprites agents are excluded', () => {
    const warm = makeAgent({ spriteName: 'sbx-1', spriteStatus: 'warm' })
    const cold = makeAgent({ spriteName: 'sbx-2', spriteStatus: 'cold' })
    const nul = makeAgent({ spriteName: 'sbx-3', spriteStatus: null })
    const daemon = makeAgent({ runtime: 'daemon', spriteName: 'sbx-4' })
    assert.equal(countActiveSandboxes([warm, cold, nul, daemon], []), 0)
})

test('spriteName falls back to runtimeId as the group key', () => {
    const a = makeAgent({ spriteName: null, runtimeId: 'spr_x' })
    const b = makeAgent({ spriteName: null, runtimeId: 'spr_x' })
    const slots = groupActiveSandboxes([a, b], [], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].key, 'spr_x')
    assert.equal(slots[0].name, a.name)
})

test('running agent with neither spriteName nor runtimeId is excluded', () => {
    const a = makeAgent({ spriteName: null, runtimeId: null })
    assert.equal(countActiveSandboxes([a], []), 0)
})

test('a bare running sandbox occupies its own slot', () => {
    const row = makeSandbox({ spriteName: 'sbx-bare', name: 'my box' })
    const slots = groupActiveSandboxes([], [row], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].key, row.id)
    assert.equal(slots[0].name, 'my box')
    assert.deepEqual(slots[0].agents, [])
    assert.equal(slots[0].releasing, false)
})

test('non-running sandbox rows are skipped', () => {
    const warm = makeSandbox({ spriteStatus: 'warm' })
    const cold = makeSandbox({ spriteStatus: 'cold' })
    const nul = makeSandbox({ spriteStatus: null })
    assert.equal(countActiveSandboxes([], [warm, cold, nul]), 0)
})

test('agent state overrides a stale running sandbox row', () => {
    const stopped = makeAgent({ spriteName: 'sbx-1', spriteStatus: 'warm' })
    const staleRow = makeSandbox({ spriteName: 'sbx-1' })
    assert.equal(countActiveSandboxes([stopped], [staleRow]), 0)
})

test('row and running agents on the same VM count once, named by the row', () => {
    const agent = makeAgent({ spriteName: 'sbx-1' })
    const row = makeSandbox({ spriteName: 'sbx-1', name: 'renamed box' })
    const slots = groupActiveSandboxes([agent], [row], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].name, 'renamed box')
    assert.deepEqual(
        slots[0].agents.map((a) => a.id),
        [agent.id]
    )
})

test('unprovisioned rows count only when they hold no agents', () => {
    const orphan = makeSandbox({ spriteName: null, agentsCount: 1 })
    const empty = makeSandbox({ spriteName: null, agentsCount: 0 })
    const slots = groupActiveSandboxes([], [orphan, empty], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].key, empty.id)
})

test('slot releases only when every agent on the VM is releasing', () => {
    const a = makeAgent({ spriteName: 'sbx-1' })
    const b = makeAgent({ spriteName: 'sbx-1' })
    const partial = groupActiveSandboxes([a, b], [], new Set([a.id]))
    assert.equal(partial[0].releasing, false)
    const all = groupActiveSandboxes([a, b], [], new Set([a.id, b.id]))
    assert.equal(all[0].releasing, true)
})

test('empty sandbox list degrades to pure agent grouping', () => {
    const a = makeAgent({ spriteName: 'sbx-1' })
    const b = makeAgent({ spriteName: 'sbx-2' })
    assert.equal(countActiveSandboxes([a, b], []), 2)
})
