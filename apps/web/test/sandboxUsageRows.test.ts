import test from 'node:test'
import assert from 'node:assert/strict'
import type { SandboxUsageHost } from '@manyfold/shared'
import {
    formatBytesDecimal,
    hostStorageRows,
    sharePct
} from '../src/lib/sandboxUsageRows'

const makeHost = (over: Partial<SandboxUsageHost> = {}): SandboxUsageHost => ({
    hostId: 'sbx_1',
    name: 'alpha',
    spriteStatus: 'running',
    activeSecondsThisPeriod: 0,
    storageBytes: 5_000_000_000,
    storageMeasuredAt: '2026-06-15T10:00:00.000Z',
    storageMeasured: true,
    storageMeasuredVia: 'df',
    storageFreshness: 'stale',
    attributionComplete: true,
    asleep: false,
    runtimes: [],
    homes: [{ framework: 'claude-code', bytes: 400_000_000, measuredBytes: 400_000_000, path: '/fixture/.claude', agentIds: ['agt_1'] }],
    agents: [
        {
            agentId: 'agt_1',
            name: 'coder',
            framework: 'claude-code',
            workspaceBytes: 1_200_000_000,
            workspaceMeasuredAt: '2026-06-15T10:00:00.000Z',
            attributedBytes: 1_200_000_000
        },
        {
            agentId: 'agt_2',
            name: 'fresh',
            framework: 'codex',
            workspaceBytes: null,
            workspaceMeasuredAt: null,
            attributedBytes: null
        }
    ],
    ...over
})

test('formatBytesDecimal uses decimal units matching the meter GB math', () => {
    assert.equal(formatBytesDecimal(5_000_000_000), '5.00 GB')
    assert.equal(formatBytesDecimal(1_234_000_000), '1.23 GB')
    assert.equal(formatBytesDecimal(400_000_000), '400.0 MB')
    assert.equal(formatBytesDecimal(12_500), '12.5 KB')
    assert.equal(formatBytesDecimal(999), '999 B')
    assert.equal(formatBytesDecimal(0), '0 B')
    assert.equal(formatBytesDecimal(null), '—')
})

test('sharePct clamps to [0, 100] and handles a zero total', () => {
    assert.equal(sharePct(50, 200), 25)
    assert.equal(sharePct(300, 200), 100)
    assert.equal(sharePct(10, 0), 0)
})

test('hostStorageRows lists attributed workspaces, homes and a measured remainder', () => {
    const rows = hostStorageRows(makeHost())
    assert.deepEqual(
        rows.map((r) => [r.kind, r.bytes]),
        [
            ['workspace', 1_200_000_000],
            ['workspace', null],
            ['home', 400_000_000],
            ['other', 3_400_000_000]
        ]
    )
    const other = rows[rows.length - 1]
    assert.equal(Math.round(other.pct), 68)
})

test('hostStorageRows omits the remainder when the host was never measured', () => {
    const host = makeHost({
        storageBytes: null,
        storageMeasuredAt: null,
        storageMeasured: false,
        homes: [],
        agents: [
            {
                agentId: 'agt_2',
                name: 'fresh',
                framework: 'codex',
                workspaceBytes: null,
                workspaceMeasuredAt: null,
                attributedBytes: null
            }
        ]
    })
    const rows = hostStorageRows(host)
    assert.deepEqual(
        rows.map((r) => r.kind),
        ['workspace']
    )
})

// WHY: a standalone sandbox with no agent has nothing to drill down into, but
// its rootfs reading is real. Inferring "measured" from the rows below made it
// render as unmeasured and swallowed its whole reading.
test('hostStorageRows gives a bare measured sandbox the whole reading as remainder', () => {
    const host = makeHost({ storageBytes: 4_200_000_000, homes: [], agents: [] })
    const rows = hostStorageRows(host)
    assert.deepEqual(
        rows.map((r) => [r.kind, r.bytes]),
        [['other', 4_200_000_000]]
    )
})

test('hostStorageRows leaves a conflicting filesystem remainder unknown', () => {
    const host = makeHost({
        storageBytes: 1_000_000_000,
        homes: [{ framework: 'claude-code', bytes: 900_000_000, measuredBytes: 900_000_000, path: '/fixture/.claude', agentIds: ['agt_1'] }],
        agents: [
            {
                agentId: 'agt_1',
                name: 'coder',
                framework: 'claude-code',
                workspaceBytes: 800_000_000,
                workspaceMeasuredAt: '2026-06-15T10:00:00.000Z',
                attributedBytes: 800_000_000
            }
        ]
    })
    const rows = hostStorageRows(host)
    const other = rows[rows.length - 1]
    assert.equal(other.kind, 'other')
    assert.equal(other.bytes, null)
})

test('known raw path usage remains visible when allocation is unknown', () => {
    const host = makeHost({ attributionComplete: false, agents: [{ agentId: 'agt_1', name: 'coder', framework: 'codex', workspaceBytes: 1200, workspaceMeasuredAt: '2026-06-15T10:00:00.000Z', attributedBytes: null }] })
    const rows = hostStorageRows(host)
    assert.equal(rows[0].measuredBytes, 1200)
    assert.equal(rows[0].bytes, null)
    assert.equal(rows.some((row) => row.kind === 'other'), false)
})
