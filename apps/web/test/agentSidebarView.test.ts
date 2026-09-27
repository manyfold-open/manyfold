import test from 'node:test'
import assert from 'node:assert/strict'
import type { SdkAgent } from '@manyfold/sdk'
import { makeAgentSummary } from './hostModelFixtures'
import {
    applyAgentsView,
    availableFrameworkOptions,
    availableHostOptions,
    defaultAgentsViewConfig,
    normalizeAgentsViewConfig,
    runtimeHostRef
} from '../src/lib/agentSidebarView'

const NOW = 1_781_568_000_000
const HOUR = 3_600_000
const DAY = 86_400_000

const startOfToday = (): number => {
    const d = new Date(NOW)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

const iso = (ms: number): string => new Date(ms).toISOString()

const makeAgent = (over: Partial<SdkAgent> = {}): SdkAgent =>
    makeAgentSummary({
        runtimeId: null,
        hostId: null,
        hostName: null,
        createdAt: iso(NOW),
        updatedAt: iso(NOW),
        ...over
    })

const ctx = (hostNames: Map<string, string> = new Map()) => ({
    now: NOW,
    hostNames
})

test('runtimeHostRef names a self-owned computer by its host record, falling back to the placement', () => {
    const named = makeAgent({ runtime: 'daemon', hostId: 'dh_1' })
    const unnamed = makeAgent({ runtime: 'daemon', hostId: 'dh_2' })
    const hostNames = new Map([['dh_1', 'Ying-MacBook']])
    assert.deepEqual(runtimeHostRef(named, hostNames), {
        key: 'host:dh_1',
        label: 'Ying-MacBook'
    })
    assert.deepEqual(runtimeHostRef(unnamed, hostNames), {
        key: 'host:dh_2',
        label: 'Self-owned computer'
    })
})

test('runtimeHostRef collapses agents that share a host onto one key', () => {
    const a = makeAgent({ hostId: 'sbx_1', hostName: 'sandbox-a' })
    const b = makeAgent({ hostId: 'sbx_1', hostName: 'sandbox-a' })
    const refA = runtimeHostRef(a, new Map())
    const refB = runtimeHostRef(b, new Map())
    assert.equal(refA.key, 'host:sbx_1')
    assert.equal(refA.key, refB.key)
})

test("runtimeHostRef labels a host by the shell's freshest name, else the agent's own", () => {
    const agent = makeAgent({ hostId: 'sbx_1', hostName: 'sandbox-002' })
    assert.deepEqual(
        runtimeHostRef(agent, new Map([['sbx_1', 'sandbox-renamed']])),
        { key: 'host:sbx_1', label: 'sandbox-renamed' }
    )
    assert.deepEqual(runtimeHostRef(agent, new Map()), {
        key: 'host:sbx_1',
        label: 'sandbox-002'
    })
    assert.deepEqual(
        runtimeHostRef(makeAgent({ hostId: 'sbx_2' }), new Map()),
        { key: 'host:sbx_2', label: 'Stateful sandbox' }
    )
})

test('group by host shows the sandbox name for a sandbox host', () => {
    const a = makeAgent({ hostId: 'sbx_x', hostName: 'sandbox-002' })
    const result = applyAgentsView(
        [a],
        { ...defaultAgentsViewConfig, groupBy: 'host' },
        ctx(new Map([['sbx_x', 'sandbox-007']]))
    )
    assert.equal(result.groups[0].hostLabel, 'sandbox-007')
})

test('runtimeHostRef keys a cloud computer by its host and external by a single bucket', () => {
    const k8s = makeAgent({
        runtime: 'k8s',
        providerKind: 'k8s',
        hostId: 'pdh_1',
        hostName: 'lhr-prod'
    })
    const external = makeAgent({ runtime: 'external' })
    assert.deepEqual(runtimeHostRef(k8s, new Map()), {
        key: 'host:pdh_1',
        label: 'lhr-prod'
    })
    assert.deepEqual(runtimeHostRef(external, new Map()), {
        key: 'external',
        label: 'External API'
    })
})

test('host filter keeps only agents on the selected hosts', () => {
    const onA = makeAgent({ hostId: 'sbx_a' })
    const onB = makeAgent({ hostId: 'sbx_b' })
    const result = applyAgentsView(
        [onA, onB],
        { ...defaultAgentsViewConfig, hosts: ['host:sbx_a'] },
        ctx()
    )
    assert.equal(result.visibleCount, 1)
    assert.equal(result.hiddenCount, 1)
    assert.equal(result.groups[0].agents[0].id, onA.id)
})

test('framework filter keeps only the selected frameworks', () => {
    const claude = makeAgent({ framework: 'claude-code' })
    const codex = makeAgent({ framework: 'codex' })
    const result = applyAgentsView(
        [claude, codex],
        { ...defaultAgentsViewConfig, frameworks: ['codex'] },
        ctx()
    )
    assert.deepEqual(
        result.groups[0].agents.map((a) => a.id),
        [codex.id]
    )
})

test('activity window measures lastMessageAt but falls back to createdAt when never prompted', () => {
    const stale = makeAgent({
        lastMessageAt: iso(NOW - 5 * DAY),
        createdAt: iso(NOW - 10 * DAY)
    })
    const recent = makeAgent({
        lastMessageAt: iso(NOW - 2 * HOUR),
        createdAt: iso(NOW - 10 * DAY)
    })
    const freshNeverPrompted = makeAgent({
        lastMessageAt: null,
        createdAt: iso(NOW - 2 * HOUR)
    })
    const result = applyAgentsView(
        [stale, recent, freshNeverPrompted],
        { ...defaultAgentsViewConfig, activity: '3d' },
        ctx()
    )
    const ids = new Set(result.groups[0].agents.map((a) => a.id))
    assert.ok(ids.has(recent.id))
    assert.ok(ids.has(freshNeverPrompted.id))
    assert.ok(!ids.has(stale.id))
})

// lastActiveAt is max(startedAt, lastBootstrappedAt, lastReconciledAt), and
// reconcile re-stamps lastReconciledAt on every live agent roughly every 15s
// while the app is open. Ordering or filtering on it made the sidebar reshuffle
// on a timer and made "Last 24 hours" match every reachable agent.
test('a reconcile sweep does not reorder or unfilter the sidebar', () => {
    const idle = makeAgent({
        id: 'agt_idle',
        createdAt: iso(NOW - 90 * DAY),
        lastMessageAt: iso(NOW - 40 * DAY)
    })
    const used = makeAgent({
        id: 'agt_used',
        createdAt: iso(NOW - 90 * DAY),
        lastMessageAt: iso(NOW - 2 * DAY)
    })
    const swept = [idle, used].map((a) => ({
        ...a,
        lastActiveAt: iso(NOW),
        lastReconciledAt: iso(NOW)
    }))

    const order = (rows: SdkAgent[]): string[] =>
        applyAgentsView(
            rows,
            { ...defaultAgentsViewConfig, sortBy: 'recency' },
            ctx()
        ).groups.flatMap((g) => g.agents.map((a) => a.id))
    assert.deepEqual(order([idle, used]), ['agt_used', 'agt_idle'])
    assert.deepEqual(order(swept), ['agt_used', 'agt_idle'])

    const windowed = applyAgentsView(
        swept,
        { ...defaultAgentsViewConfig, activity: '30d' },
        ctx()
    )
    assert.deepEqual(
        windowed.groups.flatMap((g) => g.agents.map((a) => a.id)),
        ['agt_used']
    )
    assert.equal(windowed.hiddenCount, 1)
})

test('sort by created and by recency order the list differently', () => {
    const older = makeAgent({
        id: 'agt_older',
        createdAt: iso(NOW - 5 * DAY),
        lastMessageAt: iso(NOW - 1 * HOUR)
    })
    const newer = makeAgent({
        id: 'agt_newer',
        createdAt: iso(NOW - 1 * DAY),
        lastMessageAt: iso(NOW - 5 * HOUR)
    })
    const byCreated = applyAgentsView(
        [older, newer],
        { ...defaultAgentsViewConfig, sortBy: 'created' },
        ctx()
    )
    assert.deepEqual(
        byCreated.groups[0].agents.map((a) => a.id),
        ['agt_newer', 'agt_older']
    )
    const byRecency = applyAgentsView(
        [older, newer],
        { ...defaultAgentsViewConfig, sortBy: 'recency' },
        ctx()
    )
    assert.deepEqual(
        byRecency.groups[0].agents.map((a) => a.id),
        ['agt_older', 'agt_newer']
    )
})

test('group by host returns one group per host carrying the display label', () => {
    const a1 = makeAgent({
        runtime: 'daemon',
        hostId: 'dh_1',
        createdAt: iso(NOW - 1 * HOUR)
    })
    const a2 = makeAgent({
        runtime: 'daemon',
        hostId: 'dh_1',
        createdAt: iso(NOW - 2 * HOUR)
    })
    const b1 = makeAgent({
        hostId: 'sbx_x',
        hostName: 'cloud-x',
        createdAt: iso(NOW - 3 * HOUR)
    })
    const result = applyAgentsView(
        [a1, a2, b1],
        { ...defaultAgentsViewConfig, groupBy: 'host' },
        ctx(new Map([['dh_1', 'Ying-MacBook']]))
    )
    assert.equal(result.groups.length, 2)
    assert.equal(result.groups[0].hostLabel, 'Ying-MacBook')
    assert.equal(result.groups[0].agents.length, 2)
    assert.equal(result.groups[1].hostLabel, 'cloud-x')
})

test('group by date buckets on createdAt in fixed chronological order', () => {
    const t0 = startOfToday()
    const today = makeAgent({ id: 'd_today', createdAt: iso(t0 + 1 * HOUR) })
    const yesterday = makeAgent({
        id: 'd_yesterday',
        createdAt: iso(t0 - 12 * HOUR)
    })
    const week = makeAgent({ id: 'd_week', createdAt: iso(t0 - 4 * DAY) })
    const month = makeAgent({ id: 'd_month', createdAt: iso(t0 - 15 * DAY) })
    const older = makeAgent({ id: 'd_older', createdAt: iso(t0 - 60 * DAY) })
    const result = applyAgentsView(
        [month, older, today, week, yesterday],
        { ...defaultAgentsViewConfig, groupBy: 'date' },
        ctx()
    )
    assert.deepEqual(
        result.groups.map((g) => g.key),
        ['today', 'yesterday', 'week', 'month', 'older']
    )
})

test('group by none yields a single unlabeled group and no empty group when filtered out', () => {
    const a = makeAgent({ framework: 'codex' })
    const present = applyAgentsView([a], defaultAgentsViewConfig, ctx())
    assert.equal(present.groups.length, 1)
    assert.equal(present.groups[0].kind, 'none')
    assert.equal(present.groups[0].hostLabel, null)

    const emptied = applyAgentsView(
        [a],
        { ...defaultAgentsViewConfig, frameworks: ['claude-code'] },
        ctx()
    )
    assert.equal(emptied.groups.length, 0)
    assert.equal(emptied.visibleCount, 0)
})

test('availableHostOptions counts agents per host, busiest first', () => {
    const agents = [
        makeAgent({ hostId: 'sbx_a', hostName: 'a' }),
        makeAgent({ hostId: 'sbx_a', hostName: 'a' }),
        makeAgent({ runtime: 'daemon', hostId: 'dh_1' })
    ]
    const options = availableHostOptions(agents, new Map([['dh_1', 'mac']]))
    assert.deepEqual(options, [
        { key: 'host:sbx_a', label: 'a', count: 2 },
        { key: 'host:dh_1', label: 'mac', count: 1 }
    ])
})

test('availableFrameworkOptions counts agents per framework', () => {
    const agents = [
        makeAgent({ framework: 'claude-code' }),
        makeAgent({ framework: 'claude-code' }),
        makeAgent({ framework: 'codex' })
    ]
    assert.deepEqual(availableFrameworkOptions(agents), [
        { framework: 'claude-code', count: 2 },
        { framework: 'codex', count: 1 }
    ])
})

test('activeFilterCount reported via applyAgentsView reflects engaged filter dimensions', () => {
    const a = makeAgent()
    const none = applyAgentsView([a], defaultAgentsViewConfig, ctx())
    assert.equal(none.activeFilterCount, 0)
    const two = applyAgentsView(
        [a],
        { ...defaultAgentsViewConfig, frameworks: ['claude-code'], activity: '7d' },
        ctx()
    )
    assert.equal(two.activeFilterCount, 2)
})

test('normalizeAgentsViewConfig drops unknown enum values and non-framework strings', () => {
    assert.deepEqual(
        normalizeAgentsViewConfig({
            hosts: ['host:sbx_a', 5],
            frameworks: ['codex', 'not-a-framework'],
            activity: '14d',
            groupBy: 'host',
            sortBy: 'wat'
        }),
        {
            hosts: ['host:sbx_a'],
            frameworks: ['codex'],
            activity: 'all',
            groupBy: 'host',
            sortBy: 'created'
        }
    )
    assert.deepEqual(
        normalizeAgentsViewConfig(null),
        defaultAgentsViewConfig
    )
})
