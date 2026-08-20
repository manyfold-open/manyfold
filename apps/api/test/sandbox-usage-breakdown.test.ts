import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { UsagePeriod } from '@/common/usage-period/usage-period'
import {
    buildSandboxUsageBreakdown,
    type SandboxUsageAgentInput,
    type SandboxUsageHostInput
} from '@/modules/runtime-access/sandbox-usage-breakdown'

const JUNE: UsagePeriod = {
    start: new Date(Date.UTC(2026, 5, 1)),
    end: new Date(Date.UTC(2026, 6, 1)),
    source: 'calendar'
}

const hostA: SandboxUsageHostInput = {
    id: 'sbx-a',
    name: 'alpha',
    spriteStatus: 'running',
    storageBytes: 5_000_000_000,
    storageMeasuredAt: new Date(Date.UTC(2026, 5, 15, 10, 0, 0)),
    storageBreakdown: {
        vmUsedBytes: 5_000_000_000,
        homes: [{ framework: 'claude-code', bytes: 400_000_000 }],
        workspaces: [
            { agentId: 'agt-1', bytes: 1_200_000_000 },
            { agentId: 'agt-2', bytes: 300_000_000 }
        ],
        measuredVia: 'df'
    }
}

const hostB: SandboxUsageHostInput = {
    id: 'sbx-b',
    name: 'beta',
    spriteStatus: null,
    storageBytes: null,
    storageMeasuredAt: null,
    storageBreakdown: null
}

const agents: SandboxUsageAgentInput[] = [
    { id: 'agt-2', name: 'writer', framework: 'claude-code', hostId: 'sbx-a' },
    { id: 'agt-1', name: 'coder', framework: 'claude-code', hostId: 'sbx-a' },
    { id: 'agt-3', name: 'fresh', framework: 'codex', hostId: 'sbx-a' },
    { id: 'agt-x', name: 'orphan', framework: 'codex', hostId: null }
]

test('buildSandboxUsageBreakdown groups agents under hosts with workspace bytes from the host breakdown', () => {
    const result = buildSandboxUsageBreakdown(
        JUNE,
        [hostB, hostA],
        agents,
        new Map([
            ['sbx-a', 3600],
            ['sbx-gone', 1800]
        ])
    )

    assert.deepEqual(
        result.hosts.map((h) => h.hostId),
        ['sbx-a', 'sbx-b']
    )
    const [alpha, beta] = result.hosts
    assert.deepEqual(
        alpha.agents.map((a) => [a.agentId, a.workspaceBytes]),
        [
            ['agt-1', 1_200_000_000],
            ['agt-3', null],
            ['agt-2', 300_000_000]
        ]
    )
    assert.deepEqual(alpha.homes, [
        { framework: 'claude-code', bytes: 400_000_000 }
    ])
    assert.equal(alpha.activeSecondsThisPeriod, 3600)
    assert.equal(alpha.storageMeasuredAt, '2026-06-15T10:00:00.000Z')
    assert.equal(alpha.storageMeasured, true)

    assert.equal(beta.storageBytes, null)
    assert.equal(beta.storageMeasured, false)
    assert.equal(beta.activeSecondsThisPeriod, 0)
    assert.deepEqual(beta.agents, [])
    assert.deepEqual(beta.homes, [])
})

// WHY: a bare standalone sandbox is fully measured and still has no agent or
// home rows, so "measured" cannot be inferred from the drill-down below it.
test('buildSandboxUsageBreakdown reports a bare measured sandbox as measured', () => {
    const bare: SandboxUsageHostInput = {
        id: 'sbx-c',
        name: 'gamma',
        spriteStatus: 'running',
        storageBytes: 4_200_000_000,
        storageMeasuredAt: new Date(Date.UTC(2026, 5, 15, 10, 0, 0)),
        storageBreakdown: {
            vmUsedBytes: 4_200_000_000,
            homes: [],
            workspaces: [],
            measuredVia: 'df'
        }
    }
    const result = buildSandboxUsageBreakdown(JUNE, [bare], [], new Map())
    assert.equal(result.hosts[0].storageMeasured, true)
    assert.deepEqual(result.hosts[0].agents, [])
})

// WHY: migration 0159 backfilled storage_bytes from agent rows without a
// host-grain breakdown. Those hosts have a number but no drill-down to render.
test('buildSandboxUsageBreakdown reports a backfilled host as not measured', () => {
    const backfilled: SandboxUsageHostInput = {
        id: 'sbx-d',
        name: 'delta',
        spriteStatus: 'warm',
        storageBytes: 1_500_000_000,
        storageMeasuredAt: new Date(Date.UTC(2026, 5, 15, 10, 0, 0)),
        storageBreakdown: null
    }
    const result = buildSandboxUsageBreakdown(JUNE, [backfilled], [], new Map())
    assert.equal(result.hosts[0].storageBytes, 1_500_000_000)
    assert.equal(result.hosts[0].storageMeasured, false)
})

test('buildSandboxUsageBreakdown totals equal the meter inputs and deleted hosts survive', () => {
    const result = buildSandboxUsageBreakdown(
        JUNE,
        [hostA, hostB],
        agents,
        new Map([
            ['sbx-a', 3600],
            ['sbx-gone', 1800],
            ['sbx-gone-2', 7200]
        ])
    )

    assert.equal(result.storageBytesTotal, 5_000_000_000)
    assert.equal(result.activeSecondsTotal, 3600 + 1800 + 7200)
    assert.deepEqual(result.deletedHosts, [
        { hostId: 'sbx-gone-2', activeSecondsThisPeriod: 7200 },
        { hostId: 'sbx-gone', activeSecondsThisPeriod: 1800 }
    ])
    assert.deepEqual(result.usagePeriod, {
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-07-01T00:00:00.000Z',
        source: 'calendar'
    })
})

test('buildSandboxUsageBreakdown drops agents whose host row is missing', () => {
    const result = buildSandboxUsageBreakdown(
        JUNE,
        [hostB],
        [
            {
                id: 'agt-9',
                name: 'ghost',
                framework: 'codex',
                hostId: 'sbx-vanished'
            }
        ],
        new Map()
    )
    assert.deepEqual(result.hosts[0].agents, [])
    assert.equal(result.storageBytesTotal, 0)
    assert.equal(result.activeSecondsTotal, 0)
    assert.deepEqual(result.deletedHosts, [])
})
