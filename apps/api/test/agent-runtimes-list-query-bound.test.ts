import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRuntimeRow } from '@manyfold/db'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'
import { AgentRuntimesController } from '../src/modules/agent-runtimes/agent-runtimes.controller'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'

// GET /agent-runtimes used to map every row through toSummary(), which fired
// up to four queries per runtime — one staging request produced 83 DB spans
// and ~10s wall time (#542). Under ADR-0036 a summary is one join (runtime ⋈
// host ⋈ host daemon ⋈ provider) plus one grouped agent count, whatever the
// list size; these pin that shape and the facts derived from it.

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
        status: 'ready',
        hostId: null,
        mountPath: '/workspace',
        controlUiEnabled: true,
        dashboardEnabled: false,
        dashboardState: null,
        serviceStatus: 'unknown',
        serviceStatusAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides
    }) as AgentRuntimeRow

const host = (over: Record<string, unknown>) => ({
    id: 'sbx_1',
    userId: 'user-1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sp_1' },
    name: 'sandbox-001',
    status: 'ready',
    powerState: 'suspended',
    ...over
})

// 50 mixed runtimes: sandboxes, cloud computers, self-owned computers (one
// online, one retired) and external runtimes with no host at all.
const fixtureRuntimes = (): AgentRuntimeRow[] => {
    const rows: AgentRuntimeRow[] = []
    for (let i = 0; i < 20; i++)
        rows.push(runtimeRow(`art_${i}`, { hostId: 'sbx_1' }))
    for (let i = 20; i < 35; i++)
        rows.push(runtimeRow(`art_${i}`, { hostId: 'pdh_1' }))
    for (let i = 35; i < 45; i++)
        rows.push(
            runtimeRow(`art_${i}`, {
                hostId: i % 2 === 0 ? 'dh_online' : 'dh_retired'
            })
        )
    for (let i = 45; i < 50; i++)
        rows.push(runtimeRow(`art_${i}`, { framework: 'dify' }))
    return rows
}

const hostsById: Record<string, unknown> = {
    sbx_1: host({}),
    pdh_1: host({
        id: 'pdh_1',
        name: 'computer-001',
        providerId: 'rtp_k8s',
        providerRef: { kind: 'k8s', namespace: 'nca-user-1', ingressHost: null, podPhase: 'Running' },
        powerState: 'running'
    }),
    dh_online: host({
        id: 'dh_online',
        kind: 'local',
        providerId: null,
        providerRef: null,
        name: 'laptop',
        powerState: null
    }),
    dh_retired: host({
        id: 'dh_retired',
        kind: 'local',
        providerId: null,
        providerRef: null,
        name: 'old-box',
        status: 'retired',
        powerState: null
    })
}
const providersById: Record<string, unknown> = {
    rtp_1: { id: 'rtp_1', kind: 'sprites', name: 'acme' },
    rtp_k8s: { id: 'rtp_k8s', kind: 'k8s', name: 'main-cluster' }
}
const daemonsByHost: Record<string, unknown> = {
    sbx_1: { hostId: 'sbx_1', cliVersion: '5.0.0', lastSeenAt: new Date() },
    dh_online: { hostId: 'dh_online', cliVersion: '5.0.1', lastSeenAt: new Date() },
    dh_retired: {
        hostId: 'dh_retired',
        cliVersion: '4.9.0',
        lastSeenAt: new Date(Date.now() - 3_600_000)
    }
}

// Fake drizzle that records one entry per EXECUTED query (chain awaited), not
// per builder constructed. Results route on the selection's column keys.
const buildDb = (runtimes: AgentRuntimeRow[]) => {
    const executed: string[] = []
    const route = (selection?: Record<string, unknown>) => {
        if (!selection) return { label: 'runtimes.list', rows: runtimes }
        const keys = Object.keys(selection).sort().join(',')
        if (keys === 'daemon,host,provider,runtimeId')
            return {
                label: 'context.join',
                rows: runtimes.map((r) => {
                    const h = r.hostId
                        ? (hostsById[r.hostId] as { providerId: string | null })
                        : null
                    return {
                        runtimeId: r.id,
                        host: h,
                        daemon: r.hostId ? (daemonsByHost[r.hostId] ?? null) : null,
                        provider: h?.providerId
                            ? providersById[h.providerId]
                            : null
                    }
                })
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
                leftJoin: () => chain,
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

test('listing 50 mixed runtimes stays at 2 summary queries, not 4 per row', async () => {
    const runtimes = fixtureRuntimes()
    const { service, executed } = buildService(runtimes)
    const controller = new AgentRuntimesController(service, {} as never)

    const summaries = await controller.list(user)

    assert.equal(summaries.length, 50)
    assert.deepEqual(
        [...executed].sort(),
        ['agentCounts.grouped', 'context.join', 'runtimes.list'],
        `expected 1 list + 2 bulk queries for 50 runtimes, got: ${executed.join(', ')}`
    )
})

test('summaries derive placement, host and daemon facts from the join', async () => {
    const runtimes = fixtureRuntimes()
    const { service } = buildService(runtimes)

    const summaries = await service.toSummaries(runtimes)

    assert.deepEqual(
        summaries.map((s) => s.id),
        runtimes.map((r) => r.id),
        'row order must be preserved'
    )
    const byId = new Map(summaries.map((s) => [s.id, s]))
    const sandbox = byId.get('art_0')!
    assert.equal(sandbox.kind, 'sprites')
    assert.equal(sandbox.hostName, 'sandbox-001')
    assert.equal(sandbox.hostKind, 'hosted')
    assert.equal(sandbox.hostStatus, 'ready')
    assert.equal(sandbox.providerName, 'acme')
    assert.equal(sandbox.providerKind, 'sprites')
    assert.equal(sandbox.providerRefLabel, 'sbx-1')
    assert.equal(sandbox.powerState, 'suspended')
    assert.equal(sandbox.daemonOnline, true)
    assert.equal(sandbox.daemonCliVersion, '5.0.0')
    assert.equal(sandbox.availability, 'available')
    assert.equal(sandbox.agentsCount, 3)
    assert.equal(byId.get('art_1')?.agentsCount, 0)

    const pod = byId.get('art_20')!
    assert.equal(pod.kind, 'k8s')
    assert.equal(pod.providerName, 'main-cluster')
    assert.equal(pod.providerRefLabel, 'nca-user-1')
    assert.equal(pod.daemonOnline, false, 'a registered-nowhere daemon reads offline')
    assert.equal(pod.availability, 'wakeable', 'hosted and not online is wakeable')
    assert.equal(pod.agentsCount, 1)

    const laptop = byId.get('art_36')!
    assert.equal(laptop.kind, 'daemon')
    assert.equal(laptop.hostName, 'laptop')
    assert.equal(laptop.daemonOnline, true)
    assert.equal(laptop.daemonCliVersion, '5.0.1')
    assert.equal(laptop.availability, 'available')

    const retired = byId.get('art_35')!
    assert.equal(retired.hostName, 'old-box')
    assert.equal(retired.hostStatus, 'retired')
    assert.equal(retired.daemonOnline, false, 'a stale heartbeat is offline, not null')
    assert.equal(retired.availability, 'unavailable', 'a retired host is never usable')

    const external = byId.get('art_45')!
    assert.equal(external.kind, 'external')
    assert.equal(external.hostId, null)
    assert.equal(external.providerName, null)
    assert.equal(external.daemonOnline, null)
    assert.equal(external.availability, 'available')
    assert.equal(external.agentsCount, 0)
})

test('an empty list touches the database zero times', async () => {
    const { service, executed } = buildService([])

    assert.deepEqual(await service.toSummaries([]), [])
    assert.deepEqual(executed, [])
})

test('toSummary delegates to the batch path', async () => {
    const runtime = runtimeRow('art_0', { hostId: 'dh_online' })
    const { service, executed } = buildService([runtime])

    const summary = await service.toSummary(runtime)

    assert.equal(summary.id, 'art_0')
    assert.equal(summary.hostName, 'laptop')
    assert.equal(summary.daemonOnline, true)
    assert.deepEqual(executed, ['context.join', 'agentCounts.grouped'])
})
