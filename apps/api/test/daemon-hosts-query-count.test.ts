import test from 'node:test'
import assert from 'node:assert/strict'
import { DaemonController } from '../src/modules/daemon/daemon.controller'

// #607: GET /api/daemon/hosts loaded runtimes with one query per host after
// a single batched agents count — 1 + host_count DB round trips per response,
// each a seq scan on an unindexed daemon_id. The listing must use a bounded
// number of queries independent of the host count (the #539 admin twin
// already enforces this for /api/admin/daemon/hosts).

const hostRow = (i: number) => ({
    id: `dh-${i}`,
    userId: 'u-0',
    kind: 'daemon',
    name: `machine-${i}`,
    daemonUuid: `uuid-${i}`,
    hostname: `host-${i}`,
    os: 'darwin',
    arch: 'arm64',
    cliVersion: '0.22.4',
    startupMethod: null,
    homeDir: null,
    workspaceBaseDir: null,
    detectedFrameworks: [],
    clientFeatures: [],
    status: 'active',
    lastSeenAt: null,
    rpcLastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z')
})

interface FakeDataset {
    hosts: ReturnType<typeof hostRow>[]
    runtimes: Array<{
        id: string
        daemonId: string | null
        framework: string
        name: string
    }>
    agentCounts: Array<{ daemonId: string | null; count: number }>
}

const dataset = (hostCount: number): FakeDataset => {
    const hosts = Array.from({ length: hostCount }, (_, i) => hostRow(i))
    return {
        hosts,
        runtimes: hosts.map((h) => ({
            id: `rt-${h.id}`,
            daemonId: h.id,
            framework: 'claude-code',
            name: `runtime-${h.id}`
        })),
        agentCounts: hosts.map((h) => ({ daemonId: h.id, count: 3 }))
    }
}

// Hosts come from DaemonHostService.listForUser (not this.db), so the queue
// holds only the two batches. Order matters: Promise.all's array literal
// constructs the agents-count builder first, then the runtimes builder — a
// reorder in the controller must update this queue. A per-host implementation
// exhausts the queue and fails loudly.
const makeDb = (data: FakeDataset) => {
    const responses: unknown[][] = [data.agentCounts, data.runtimes]
    const counters = { selects: 0, updates: 0, inserts: 0 }
    const chain = (rows: unknown[]) => {
        const b = Object.assign(Promise.resolve(rows), {
            from: () => b,
            where: () => b,
            groupBy: () => b,
            orderBy: () => b,
            limit: () => b
        })
        return b
    }
    return {
        counters,
        select: () => {
            counters.selects += 1
            const rows = responses.shift()
            if (!rows)
                throw new Error(
                    `unexpected select #${counters.selects}: runtimes must be batched, not per-host`
                )
            return chain(rows)
        },
        update: () => {
            counters.updates += 1
            return chain([])
        },
        insert: () => {
            counters.inserts += 1
            return chain([])
        }
    }
}

const fakeHostService = (hosts: unknown[]) => ({
    listForUser: () => Promise.resolve(hosts),
    toSummary: (
        host: { id: string },
        runtimes: unknown[],
        agentCount: number
    ) => Promise.resolve({ id: host.id, runtimes, agentCount })
})

const makeController = (db: ReturnType<typeof makeDb>, hosts: unknown[]) =>
    new DaemonController(
        db as never,
        undefined as never,
        fakeHostService(hosts) as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

const principal = { userId: 'u-0' } as never

test('listHosts uses a bounded query count: 2 batches', async () => {
    const data = dataset(3)
    const db = makeDb(data)
    const rows = await makeController(db, data.hosts).listHosts(principal)

    assert.equal(rows.length, 3)
    assert.equal(db.counters.selects, 2, 'exactly two SELECTs')
    assert.equal(db.counters.updates, 0, 'no UPDATE from a list request')
    assert.equal(db.counters.inserts, 0, 'no INSERT from a list request')
})

test('listHosts query count does not grow with host count', async () => {
    const small = dataset(3)
    const smallDb = makeDb(small)
    await makeController(smallDb, small.hosts).listHosts(principal)

    const large = dataset(50)
    const largeDb = makeDb(large)
    const rows = await makeController(largeDb, large.hosts).listHosts(principal)

    assert.equal(rows.length, 50)
    assert.equal(
        largeDb.counters.selects,
        smallDb.counters.selects,
        'query count must be independent of the host count'
    )
})

test('listHosts with no hosts issues no queries', async () => {
    const db = makeDb({ hosts: [], runtimes: [], agentCounts: [] })
    const rows = await makeController(db, []).listHosts(principal)

    assert.deepEqual(rows, [])
    // Unlike the admin twin (which loads hosts through this.db and so counts
    // one select), hosts come from the host service here: zero DB selects.
    assert.equal(db.counters.selects, 0, 'no queries without hosts')
})

test('listHosts assembles batched rows onto the right hosts in order', async () => {
    const data = dataset(2)
    data.runtimes = [
        {
            id: 'rt-a',
            daemonId: 'dh-1',
            framework: 'claude-code',
            name: 'only-on-host-1'
        },
        { id: 'rt-orphan', daemonId: null, framework: 'codex', name: 'orphan' }
    ]
    data.agentCounts = [{ daemonId: 'dh-0', count: 4 }]
    const db = makeDb(data)

    const rows = await makeController(db, data.hosts).listHosts(principal)
    assert.deepEqual(
        rows.map((r) => r.id),
        ['dh-0', 'dh-1'],
        'response preserves listForUser order'
    )
    const [host0, host1] = rows

    assert.equal(host0.agentCount, 4)
    assert.equal(host1.agentCount, 0, 'hosts without agents count zero')
    assert.deepEqual(
        host0.runtimes,
        [],
        'runtime rows must not leak across hosts'
    )
    assert.equal(host1.runtimes.length, 1)
    assert.equal(host1.runtimes[0].runtimeId, 'rt-a')
    assert.equal(host1.runtimes[0].name, 'only-on-host-1')
})
