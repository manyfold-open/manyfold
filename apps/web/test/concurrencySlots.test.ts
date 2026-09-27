import test from 'node:test'
import assert from 'node:assert/strict'
import {
    countActiveSandboxes,
    groupActiveSandboxes
} from '../src/lib/concurrencySlots'
import {
    makeAgentSummary as makeAgent,
    makeDaemonAgentSummary,
    makeSandboxSummary as makeSandbox
} from './hostModelFixtures'

const none: ReadonlySet<string> = new Set()

test('co-resident cross-framework agents share one slot', () => {
    const claude = makeAgent({ hostId: 'sbx_1', framework: 'claude-code' })
    const codex = makeAgent({ hostId: 'sbx_1', framework: 'codex' })
    const slots = groupActiveSandboxes([claude, codex], [], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].hostId, 'sbx_1')
    assert.deepEqual(
        slots[0].agents.map((a) => a.id),
        [claude.id, codex.id]
    )
    assert.equal(countActiveSandboxes([claude, codex], []), 1)
})

test('agents on the same runtime collapse into one slot', () => {
    const a = makeAgent({ hostId: 'sbx_1', runtimeId: 'art_x' })
    const b = makeAgent({ hostId: 'sbx_1', runtimeId: 'art_x' })
    assert.equal(countActiveSandboxes([a, b], []), 1)
})

test('distinct hosts get distinct slots', () => {
    const a = makeAgent({ hostId: 'sbx_1' })
    const b = makeAgent({ hostId: 'sbx_2' })
    assert.equal(countActiveSandboxes([a, b], []), 2)
})

test('non-running and non-sandbox agents are excluded', () => {
    const suspended = makeAgent({ hostId: 'sbx_1', powerState: 'suspended' })
    const stopped = makeAgent({ hostId: 'sbx_2', powerState: 'stopped' })
    const unknown = makeAgent({ hostId: 'sbx_3', powerState: null })
    const daemon = makeDaemonAgentSummary({
        hostId: 'dh_1',
        powerState: 'running'
    })
    assert.equal(
        countActiveSandboxes([suspended, stopped, unknown, daemon], []),
        0
    )
})

test('a running agent that has no host yet is excluded', () => {
    const a = makeAgent({ hostId: null, hostName: null })
    assert.equal(countActiveSandboxes([a], []), 0)
})

test('a bare running sandbox occupies its own slot', () => {
    const row = makeSandbox({ name: 'my box' })
    const slots = groupActiveSandboxes([], [row], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].key, row.id)
    assert.equal(slots[0].hostId, row.id)
    assert.equal(slots[0].name, 'my box')
    assert.deepEqual(slots[0].agents, [])
    assert.equal(slots[0].releasing, false)
})

test('non-running sandbox rows are skipped', () => {
    const suspended = makeSandbox({ powerState: 'suspended' })
    const stopped = makeSandbox({ powerState: 'stopped' })
    const provisioning = makeSandbox({
        status: 'provisioning',
        powerState: null,
        registered: false,
        daemonOnline: false
    })
    assert.equal(countActiveSandboxes([], [suspended, stopped, provisioning]), 0)
})

test('agent state overrides a stale running sandbox row', () => {
    const staleRow = makeSandbox()
    const asleep = makeAgent({ hostId: staleRow.id, powerState: 'suspended' })
    assert.equal(countActiveSandboxes([asleep], [staleRow]), 0)
})

test('row and running agents on the same host count once, named by the row', () => {
    const row = makeSandbox({ name: 'renamed box', agentsCount: 1 })
    const agent = makeAgent({ hostId: row.id, hostName: 'sandbox-old' })
    const slots = groupActiveSandboxes([agent], [row], none)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].name, 'renamed box')
    assert.deepEqual(
        slots[0].agents.map((a) => a.id),
        [agent.id]
    )
})

test('without a row the slot is named after the host the agents carry', () => {
    const agent = makeAgent({ hostId: 'sbx_1', hostName: 'sandbox-001' })
    assert.equal(groupActiveSandboxes([agent], [], none)[0].name, 'sandbox-001')
})

test('the keep-awake switch is read off the sandbox row, else off its agents', () => {
    const row = makeSandbox({ keepAwake: true })
    const onRow = makeAgent({ hostId: row.id, keepAwake: false })
    assert.equal(groupActiveSandboxes([onRow], [row], none)[0].keepAwake, true)
    const offRow = makeAgent({ hostId: 'sbx_x', keepAwake: true })
    assert.equal(groupActiveSandboxes([offRow], [], none)[0].keepAwake, true)
    const bare = makeSandbox({ keepAwake: true })
    assert.equal(groupActiveSandboxes([], [bare], none)[0].keepAwake, true)
})

test('slot releases only when every agent on the host is releasing', () => {
    const a = makeAgent({ hostId: 'sbx_1' })
    const b = makeAgent({ hostId: 'sbx_1' })
    const partial = groupActiveSandboxes([a, b], [], new Set([a.id]))
    assert.equal(partial[0].releasing, false)
    const all = groupActiveSandboxes([a, b], [], new Set([a.id, b.id]))
    assert.equal(all[0].releasing, true)
})

test('empty sandbox list degrades to pure agent grouping', () => {
    const a = makeAgent({ hostId: 'sbx_1' })
    const b = makeAgent({ hostId: 'sbx_2' })
    assert.equal(countActiveSandboxes([a, b], []), 2)
})
