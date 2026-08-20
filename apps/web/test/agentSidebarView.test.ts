import test from 'node:test'
import assert from 'node:assert/strict'
import type { SdkAgent } from '@manyfold/sdk'
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

let seq = 0
const makeAgent = (over: Partial<SdkAgent> = {}): SdkAgent => {
    seq += 1
    return {
        id: `agt_${seq}`,
        userId: 'usr_1',
        runtimeId: null,
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
        createdAt: iso(NOW),
        updatedAt: iso(NOW),
        ...over
    }
}

const ctx = (hostNames: Map<string, string> = new Map()) => ({
    now: NOW,
    hostNames
})

test('runtimeHostRef names a daemon by its host record, falling back to the kind label', () => {
    const named = makeAgent({ runtime: 'daemon', daemonId: 'rh_1' })
    const unnamed = makeAgent({ runtime: 'daemon', daemonId: 'rh_2' })
    const hostNames = new Map([['rh_1', 'Ying-MacBook']])
    assert.deepEqual(runtimeHostRef(named, hostNames), {
        key: 'daemon:rh_1',
        label: 'Ying-MacBook'
    })
    assert.deepEqual(runtimeHostRef(unnamed, hostNames), {
        key: 'daemon:rh_2',
        label: 'Self-owned computer'
    })
})

test('runtimeHostRef collapses agents that share a sprite VM onto one host key', () => {
    const a = makeAgent({
        runtime: 'sprites',
        spriteId: 'sp_1',
        spriteName: 'sandbox-a'
    })
    const b = makeAgent({
        runtime: 'sprites',
        spriteId: 'sp_1',
        spriteName: 'sandbox-a'
    })
    const refA = runtimeHostRef(a, new Map())
    const refB = runtimeHostRef(b, new Map())
    assert.equal(refA.key, 'sprite:sp_1')
    assert.equal(refA.key, refB.key)
})

test('runtimeHostRef labels a sprite by its sandbox name when mapped, else the raw VM id', () => {
    const agent = makeAgent({
        runtime: 'sprites',
        spriteId: 'sp_1',
        spriteName: 'sbx-rawvmid'
    })
    assert.deepEqual(
        runtimeHostRef(agent, new Map([['sbx-rawvmid', 'sandbox-002']])),
        { key: 'sprite:sp_1', label: 'sandbox-002' }
    )
    assert.deepEqual(runtimeHostRef(agent, new Map()), {
        key: 'sprite:sp_1',
        label: 'sbx-rawvmid'
    })
})

test('group by host shows the sandbox name for a sprite host', () => {
    const a = makeAgent({
        runtime: 'sprites',
        spriteId: 'sp_x',
        spriteName: 'sbx-rawvmid'
    })
    const result = applyAgentsView(
        [a],
        { ...defaultAgentsViewConfig, groupBy: 'host' },
        ctx(new Map([['sbx-rawvmid', 'sandbox-007']]))
    )
    assert.equal(result.groups[0].hostLabel, 'sandbox-007')
})

test('runtimeHostRef keys k8s by cluster and external by a single bucket', () => {
    const k8s = makeAgent({
        runtime: 'k8s',
        clusterId: 'cl_1',
        clusterName: 'lhr-prod'
    })
    const external = makeAgent({ runtime: 'external' })
    assert.deepEqual(runtimeHostRef(k8s, new Map()), {
        key: 'k8s:cl_1',
        label: 'lhr-prod'
    })
    assert.deepEqual(runtimeHostRef(external, new Map()), {
        key: 'external',
        label: 'External API'
    })
})

test('host filter keeps only agents on the selected hosts', () => {
    const onA = makeAgent({ runtime: 'sprites', spriteId: 'sp_a' })
    const onB = makeAgent({ runtime: 'sprites', spriteId: 'sp_b' })
    const result = applyAgentsView(
        [onA, onB],
        { ...defaultAgentsViewConfig, hosts: ['sprite:sp_a'] },
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
        daemonId: 'rh_1',
        createdAt: iso(NOW - 1 * HOUR)
    })
    const a2 = makeAgent({
        runtime: 'daemon',
        daemonId: 'rh_1',
        createdAt: iso(NOW - 2 * HOUR)
    })
    const b1 = makeAgent({
        runtime: 'sprites',
        spriteId: 'sp_x',
        spriteName: 'cloud-x',
        createdAt: iso(NOW - 3 * HOUR)
    })
    const result = applyAgentsView(
        [a1, a2, b1],
        { ...defaultAgentsViewConfig, groupBy: 'host' },
        ctx(new Map([['rh_1', 'Ying-MacBook']]))
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
        makeAgent({ runtime: 'sprites', spriteId: 'sp_a', spriteName: 'a' }),
        makeAgent({ runtime: 'sprites', spriteId: 'sp_a', spriteName: 'a' }),
        makeAgent({ runtime: 'daemon', daemonId: 'rh_1' })
    ]
    const options = availableHostOptions(agents, new Map([['rh_1', 'mac']]))
    assert.deepEqual(options, [
        { key: 'sprite:sp_a', label: 'a', count: 2 },
        { key: 'daemon:rh_1', label: 'mac', count: 1 }
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
            hosts: ['sprite:sp_a', 5],
            frameworks: ['codex', 'not-a-framework'],
            activity: '14d',
            groupBy: 'host',
            sortBy: 'wat'
        }),
        {
            hosts: ['sprite:sp_a'],
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
