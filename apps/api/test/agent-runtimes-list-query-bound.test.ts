import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRuntimeRow } from '@manyfold/db'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'
import { AgentRuntimesController } from '../src/modules/agent-runtimes/agent-runtimes.controller'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'

// GET /agent-runtimes used to map every row through toSummary(), which fired
// up to four queries per runtime — one staging request produced 83 DB spans
// and ~10s wall time (#542). These tests pin the fixed shape: summarizing a
// list is a bounded number of bulk queries, not O(runtime_count) fan-out.

const user = { userId: 'user-1' } as AuthPrincipal

const NOW = new Date('2026-08-06T12:00:00.000Z')

const runtimeRow = (
    id: string,
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id,
        userId: 'user-1',
        name: `runtime-${id}`,
        framework: 'claude-code',
        kind: 'external',
        status: 'ready',
        accountId: null,
        clusterId: null,
        daemonId: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides
    }) as AgentRuntimeRow

// 50 mixed runtimes: sprites (account refs, one dangling), k8s (cluster
// refs), daemon (one online host, one revoked), external (no refs at all).
const fixtureRuntimes = (): AgentRuntimeRow[] => {
    const rows: AgentRuntimeRow[] = []
    for (let i = 0; i < 20; i++)
        rows.push(
            runtimeRow(`art_${i}`, {
                kind: 'sprites',
                accountId: i % 2 === 0 ? 'sac_1' : 'sac_dangling'
            })
        )
    for (let i = 20; i < 35; i++)
        rows.push(
            runtimeRow(`art_${i}`, { kind: 'k8s', clusterId: 'k8c_1' })
        )
    for (let i = 35; i < 45; i++)
        rows.push(
            runtimeRow(`art_${i}`, {
                kind: 'daemon',
                daemonId: i % 2 === 0 ? 'dh_online' : 'dh_revoked'
            })
        )
    for (let i = 45; i < 50; i++) rows.push(runtimeRow(`art_${i}`))
    return rows
}

// Fake drizzle that records one entry per EXECUTED query (chain awaited), not
// per builder constructed — listByUser embeds a notExists() subquery builder
// that never runs on its own. Results route on the selection's column keys.
const buildDb = (runtimes: AgentRuntimeRow[]) => {
    const executed: string[] = []
    const route = (selection?: Record<string, unknown>) => {
        if (!selection) return { label: 'runtimes.list', rows: runtimes }
        const keys = Object.keys(selection).sort().join(',')
        if (keys === 'id,slug')
            return {
                label: 'accounts.bulk',
                rows: [{ id: 'sac_1', slug: 'acme' }]
            }
        if (keys === 'id,name')
            return {
                label: 'clusters.bulk',
                rows: [{ id: 'k8c_1', name: 'main-cluster' }]
            }
        if (keys === 'cliVersion,id,name,rpcLastSeenAt,status')
            return {
                label: 'daemons.bulk',
                rows: [
                    {
                        id: 'dh_online',
                        name: 'laptop',
                        status: 'active',
                        cliVersion: '0.22.3',
                        rpcLastSeenAt: new Date()
                    },
                    {
                        id: 'dh_revoked',
                        name: 'old-box',
                        status: 'revoked',
                        cliVersion: null,
                        rpcLastSeenAt: null
                    }
                ]
            }
        if (keys === 'runtimeId,value')
            return {
                label: 'agentCounts.grouped',
                rows: [
                    { runtimeId: 'art_0', value: 3 },
                    { runtimeId: 'art_20', value: 1 }
                ]
            }
        return { label: `unexpected:${keys}`, rows: [] }
    }
    const db = {
        select: (selection?: Record<string, unknown>) => {
            const { label, rows } = route(selection)
            const chain = {
                from: () => chain,
                where: () => chain,
                groupBy: () => chain,
                limit: () => chain,
                then: (
                    resolve: (rows: unknown[]) => unknown,
                    reject: (err: unknown) => unknown
                ) => {
                    executed.push(label)
                    return Promise.resolve(rows).then(resolve, reject)
                }
            }
            return chain
        }
    }
    return { db, executed }
}

const buildService = (runtimes: AgentRuntimeRow[]) => {
    const { db, executed } = buildDb(runtimes)
    const service = new AgentRuntimesService(db as never, {} as never)
    return { service, executed }
}

test('listing 50 mixed runtimes stays at 4 summary queries, not 4 per row', async () => {
    const runtimes = fixtureRuntimes()
    const { service, executed } = buildService(runtimes)
    const controller = new AgentRuntimesController(
        {} as never,
        service,
        {} as never,
        {} as never,
        {} as never
    )

    const summaries = await controller.list(user)

    assert.equal(summaries.length, 50)
    assert.deepEqual(
        [...executed].sort(),
        [
            'accounts.bulk',
            'agentCounts.grouped',
            'clusters.bulk',
            'daemons.bulk',
            'runtimes.list'
        ],
        `expected 1 list + 4 bulk queries for 50 runtimes, got: ${executed.join(', ')}`
    )
})

test('summaries assemble from the bulk maps with unchanged semantics', async () => {
    const runtimes = fixtureRuntimes()
    const { service } = buildService(runtimes)

    const summaries = await service.toSummaries(runtimes)

    assert.deepEqual(
        summaries.map((s) => s.id),
        runtimes.map((r) => r.id),
        'row order must be preserved'
    )
    const byId = new Map(summaries.map((s) => [s.id, s]))
    assert.equal(byId.get('art_0')?.accountSlug, 'acme')
    assert.equal(byId.get('art_0')?.agentsCount, 3)
    assert.equal(
        byId.get('art_1')?.accountSlug,
        null,
        'dangling account ref resolves to null, not a throw'
    )
    assert.equal(byId.get('art_1')?.agentsCount, 0)
    assert.equal(byId.get('art_20')?.clusterName, 'main-cluster')
    assert.equal(byId.get('art_20')?.agentsCount, 1)
    assert.equal(byId.get('art_36')?.daemonName, 'laptop')
    assert.equal(byId.get('art_36')?.daemonOnline, true)
    assert.equal(byId.get('art_36')?.daemonCliVersion, '0.22.3')
    assert.equal(byId.get('art_35')?.daemonName, 'old-box')
    assert.equal(
        byId.get('art_35')?.daemonOnline,
        false,
        'a known-but-revoked daemon host is offline, not null'
    )
    const external = byId.get('art_45')
    assert.equal(external?.accountSlug, null)
    assert.equal(external?.clusterName, null)
    assert.equal(external?.daemonName, null)
    assert.equal(external?.daemonOnline, null)
    assert.equal(external?.agentsCount, 0)
})

test('an empty list touches the database zero times', async () => {
    const { service, executed } = buildService([])

    assert.deepEqual(await service.toSummaries([]), [])
    assert.deepEqual(executed, [])
})

test('toSummary delegates to the batch path and skips queries for absent refs', async () => {
    const runtime = runtimeRow('art_0', {
        kind: 'daemon',
        daemonId: 'dh_online'
    })
    const { service, executed } = buildService([runtime])

    const summary = await service.toSummary(runtime)

    assert.equal(summary.id, 'art_0')
    assert.equal(summary.daemonName, 'laptop')
    assert.equal(summary.daemonOnline, true)
    assert.deepEqual(
        executed,
        ['daemons.bulk', 'agentCounts.grouped'],
        'no account/cluster ref means no account/cluster query'
    )
})
