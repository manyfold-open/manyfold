import test from 'node:test'
import assert from 'node:assert/strict'
import { AdminDaemonController } from '../src/modules/daemon/admin-daemon.controller'

// #539: GET /api/admin/daemon/hosts enriched every host with four serial
// queries (runtimes, owner email, tokens, agent count) — 4 × host_count DB
// round trips per response, p99 61s in staging. The listing must use a
// bounded number of queries independent of the host count.

const hostRow = (i: number) => ({
    id: `dh-${i}`,
    userId: `u-${i % 2}`,
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
        daemonId: string
        framework: string
        name: string
    }>
    users: Array<{ id: string; email: string | null }>
    tokenCounts: Array<{ daemonId: string; count: number }>
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
        users: [
            { id: 'u-0', email: 'owner0@example.com' },
            { id: 'u-1', email: null }
        ],
        tokenCounts: hosts.map((h) => ({ daemonId: h.id, count: 2 })),
        agentCounts: hosts.map((h) => ({ daemonId: h.id, count: 3 }))
    }
}

// Responses are served in select() call order: hosts first, then one batch
// per enrichment dataset. A serial per-host implementation exhausts the
// queue and fails loudly.
const makeDb = (data: FakeDataset) => {
    const responses: unknown[][] = [
        data.hosts,
        data.runtimes,
        data.users,
        data.tokenCounts,
        data.agentCounts
    ]
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
                    `unexpected select #${counters.selects}: enrichment must be batched, not per-host`
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

const fakeHostService = {
    toSummary: (
        host: { id: string },
        runtimes: unknown[],
        agentCount: number
    ) => Promise.resolve({ id: host.id, runtimes, agentCount })
}

const makeController = (db: ReturnType<typeof makeDb>) =>
    new AdminDaemonController(db as never, fakeHostService as never)

test('listHosts uses a bounded query count: 1 host query + 4 batches', async () => {
    const db = makeDb(dataset(3))
    const rows = await makeController(db).listHosts()

    assert.equal(rows.length, 3)
    assert.equal(db.counters.selects, 5, 'exactly five SELECTs')
    assert.equal(db.counters.updates, 0, 'no UPDATE from a list request')
    assert.equal(db.counters.inserts, 0, 'no INSERT from a list request')
})

test('listHosts query count does not grow with host count', async () => {
    const small = makeDb(dataset(3))
    await makeController(small).listHosts()

    const large = makeDb(dataset(50))
    const rows = await makeController(large).listHosts()

    assert.equal(rows.length, 50)
    assert.equal(
        large.counters.selects,
        small.counters.selects,
        'query count must be independent of the host count'
    )
})

test('listHosts with no hosts stops after the host query', async () => {
    const db = makeDb({
        hosts: [],
        runtimes: [],
        users: [],
        tokenCounts: [],
        agentCounts: []
    })
    const rows = await makeController(db).listHosts()

    assert.deepEqual(rows, [])
    assert.equal(db.counters.selects, 1, 'no enrichment queries without hosts')
})

test('listHosts assembles batched rows onto the right hosts', async () => {
    const data = dataset(2)
    data.runtimes = [
        {
            id: 'rt-a',
            daemonId: 'dh-1',
            framework: 'claude-code',
            name: 'only-on-host-1'
        }
    ]
    data.tokenCounts = [{ daemonId: 'dh-1', count: 7 }]
    data.agentCounts = [{ daemonId: 'dh-0', count: 4 }]
    const db = makeDb(data)

    const rows = await makeController(db).listHosts()
    const byId = new Map(rows.map((r) => [r.id, r]))
    const host0 = byId.get('dh-0')
    const host1 = byId.get('dh-1')
    assert.ok(host0 && host1)

    assert.equal(host0.userEmail, 'owner0@example.com')
    assert.equal(host1.userEmail, null, 'missing user email stays null')
    assert.equal(host0.agentCount, 4)
    assert.equal(host1.agentCount, 0, 'hosts without agents count zero')
    assert.equal(host0.tokenCount, 0, 'hosts without tokens count zero')
    assert.equal(host1.tokenCount, 7)
    assert.deepEqual(
        host0.runtimes,
        [],
        'runtime rows must not leak across hosts'
    )
    assert.equal(host1.runtimes.length, 1)
    assert.equal((host1.runtimes[0] as { name: string }).name, 'only-on-host-1')
})
