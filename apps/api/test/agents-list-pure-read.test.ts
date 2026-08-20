import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentsService } from '../src/modules/agents/agents.service'

// #516: GET /api/agents used to start a reconcile for every runtime the
// caller owns — 42+ DB statements per list request on a 66-runtime staging
// account. The list must be a pure read whose query count does not grow with
// the caller's runtime count.

const agentRow = (i: number, status: 'running' | 'stopped') => ({
    id: `agent-${i}`,
    userId: 'u-1',
    runtimeId: `rt-${i}`,
    framework: 'claude-code',
    runtime: 'sprites',
    name: `a${i}`,
    internalId: `agent-${i}`,
    status,
    model: null,
    extras: {},
    workspacePath: '/workspace',
    daemonId: null,
    clusterId: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z')
})

// One agent per runtime, half stopped: 60 runtimes total, well past the
// 50-mixed-runtimes bound in the issue's acceptance criteria.
const listRows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        agent: agentRow(i, i % 2 === 0 ? 'running' : 'stopped'),
        clusterName: null,
        controlUiEnabled: true,
        dashboardEnabled: false,
        dashboardState: null,
        keepAliveEnabled: false
    }))

const makeDb = (rows: unknown[]) => {
    const counters = { selects: 0, updates: 0, inserts: 0 }
    const chain = () => {
        const b = Object.assign(Promise.resolve(rows), {
            from: () => b,
            leftJoin: () => b,
            where: () => b,
            orderBy: () => b,
            limit: () => b
        })
        return b
    }
    return {
        counters,
        select: () => {
            counters.selects += 1
            return chain()
        },
        update: () => {
            counters.updates += 1
            return chain()
        },
        insert: () => {
            counters.inserts += 1
            return chain()
        }
    }
}

// Any reconcile involvement fails the test — the list path must not even
// look up runtimes to decide whether to touch them.
const untouchableReconcile = new Proxy(
    {},
    {
        get: (_t, prop) => () => {
            throw new Error(`list must not call reconcile.${String(prop)}`)
        }
    }
)

const makeService = (db: ReturnType<typeof makeDb>) =>
    new AgentsService(
        db as never,
        untouchableReconcile as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

test('listForUser is a pure read: one SELECT, no writes, no reconcile', async () => {
    const db = makeDb(listRows(60))
    const rows = await makeService(db).listForUser('u-1')

    assert.equal(rows.length, 60)
    assert.equal(db.counters.selects, 1, 'exactly one SELECT')
    assert.equal(db.counters.updates, 0, 'no UPDATE from a list request')
    assert.equal(db.counters.inserts, 0, 'no INSERT from a list request')
})

test('listForUser query count does not grow with runtime count', async () => {
    const small = makeDb(listRows(3))
    await makeService(small).listForUser('u-1')

    const large = makeDb(listRows(60))
    await makeService(large).listForUser('u-1')

    assert.equal(
        large.counters.selects,
        small.counters.selects,
        'query count must be independent of the runtime count'
    )
})

test('listAll is a pure read: one SELECT, no writes, no reconcile', async () => {
    const db = makeDb(listRows(60))
    const rows = await makeService(db).listAll()

    assert.equal(rows.length, 60)
    assert.equal(db.counters.selects, 1, 'exactly one SELECT')
    assert.equal(db.counters.updates, 0, 'no UPDATE from a list request')
    assert.equal(db.counters.inserts, 0, 'no INSERT from a list request')
})
