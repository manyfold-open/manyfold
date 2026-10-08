import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    createDb,
    hostDaemons,
    plans,
    runtimeHosts,
    runtimeProviders,
    users,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { FEATURE_TOGGLE_KEYS } from '@manyfold/shared'
import { withScratchDatabase } from '../scripts/scratch-db'
import type { ProviderHealthReport } from '../src/modules/hosts/providers/sandbox-provider'
import {
    SANDBOX_HEALTH_CHECKED_EVENT,
    SANDBOX_MAINTENANCE_ENTERED_EVENT,
    SANDBOX_MAINTENANCE_EXITED_EVENT,
    SandboxHealthService
} from '../src/modules/sandboxes/health/sandbox-health.service'
import { RECHECK_LADDER_MS } from '../src/modules/sandboxes/health/sandbox-health-policy'

// The maintenance stage is a state machine on runtime_hosts, and the API runs
// on more than one instance. What makes it safe is SQL, so it is proven here
// against a real Postgres with several services on their own pools:
//
//   * one check per machine across the fleet, and a machine that keeps failing
//     is asked about at most once per interval, a failed call included;
//   * a verdict lands only through the lease it was claimed under, so one that
//     comes back after an admin ended the maintenance cannot put it back;
//   * automatic entry is shadowed while its switch is off and capped per hour
//     while it is on; an admin's check always applies;
//   * a healthy re-check is the way out, and anything else backs off;
//   * the sweep never asks about a machine a daemon proved alive.
//
// Each test creates, migrates and drops a throwaway database. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/sandbox-health.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface TelemetryEvent {
    name: string
    attrs: Record<string, unknown>
}

type Script = (host: RuntimeHostRow) => Promise<ProviderHealthReport | 'gone'>

interface Instance {
    db: Database
    health: SandboxHealthService
}

interface Harness {
    fleet: Instance[]
    first: Instance
    user: string
    provider: string
    host: (name: string, extra?: Partial<typeof runtimeHosts.$inferInsert>) => Promise<string>
    row: (hostId: string) => Promise<RuntimeHostRow>
    set: (hostId: string, values: Partial<typeof runtimeHosts.$inferInsert>) => Promise<void>
    asked: string[]
    announced: string[]
    named: (name: string) => TelemetryEvent[]
    script: { current: Script }
    toggles: Record<string, boolean>
}

const report = (
    verdict: ProviderHealthReport['verdict'],
    reason: string | null = null
): ProviderHealthReport => ({
    verdict,
    rawStatus: verdict,
    reason,
    elapsedMs: 1000
})

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const withHarness = async (
    body: (harness: Harness) => Promise<void>,
    fleetSize = 3
): Promise<void> =>
    withScratchDatabase('sbxhealth', async ({ url }) => {
        const log: TelemetryEvent[] = []
        const asked: string[] = []
        const announced: string[] = []
        const toggles: Record<string, boolean> = {}
        const script: { current: Script } = {
            current: async () => report('unhealthy', 'failed to start machine')
        }
        const sfx = randomBytes(6).toString('hex')
        const ids = {
            plan: `plan_pgtest_${sfx}`,
            user: `user_pgtest_${sfx}`,
            provider: `rtp_pgtest_${sfx}`
        }
        const providerRow = { id: ids.provider, kind: 'sprites', name: 'pgtest' }
        const adapter = {
            checkHealth: async ({ host }: { host: RuntimeHostRow }) => {
                asked.push(host.id)
                return script.current(host)
            }
        }
        const spawn = (): Instance => {
            const db = createDb(url, { max: 2 })
            const health = new SandboxHealthService(
                db,
                {
                    resolve: async () => ({ provider: providerRow, adapter })
                } as never,
                {
                    isFeatureEnabled: async (key: string) => toggles[key] === true
                } as never,
                {
                    event: (name: string, attrs: Record<string, unknown> = {}) =>
                        log.push({ name, attrs })
                } as never,
                {
                    announceHostState: async (hostId: string) => {
                        announced.push(hostId)
                    }
                } as never
            )
            return { db, health }
        }
        const fleet = Array.from({ length: fleetSize }, spawn)
        const db = fleet[0].db
        try {
            await db.insert(plans).values({
                id: ids.plan,
                name: `pgtest-${sfx}`,
                maxAgentsProvisioned: 3,
                maxConcurrentActive: 1,
                maxStorageGb: 3
            })
            await db.insert(users).values({
                id: ids.user,
                email: `${sfx}@pgtest.local`,
                planId: ids.plan
            })
            await db.insert(runtimeProviders).values({
                id: ids.provider,
                kind: 'sprites',
                name: `pgtest-${sfx}`,
                credentialCiphertext: 'encrypted'
            })
            let seq = 0
            await body({
                fleet,
                first: fleet[0],
                user: ids.user,
                provider: ids.provider,
                host: async (name, extra = {}) => {
                    seq += 1
                    const id = `rh_pgtest_${name}_${seq}_${sfx}`
                    await db.insert(runtimeHosts).values({
                        id,
                        userId: ids.user,
                        kind: 'hosted',
                        providerId: ids.provider,
                        providerRef: {
                            kind: 'sprites',
                            spriteName: `sbx-${name}-${seq}-${sfx}`,
                            spriteId: null
                        },
                        name: `pgtest-${name}-${seq}`,
                        status: 'ready',
                        ...extra
                    })
                    return id
                },
                row: async (hostId) => {
                    const [row] = await db
                        .select()
                        .from(runtimeHosts)
                        .where(eq(runtimeHosts.id, hostId))
                        .limit(1)
                    return row
                },
                set: async (hostId, values) => {
                    await db
                        .update(runtimeHosts)
                        .set(values)
                        .where(eq(runtimeHosts.id, hostId))
                },
                asked,
                announced,
                named: (name) => log.filter((event) => event.name === name),
                script,
                toggles
            })
        } finally {
            for (const instance of fleet) await closeDb(instance.db)
        }
    })

const afterFailure = (instance: Instance, hostId: string): Promise<void> =>
    (
        instance.health as unknown as {
            checkAfterFailure: (hostId: string, cause: string) => Promise<void>
        }
    ).checkAfterFailure(hostId, 'bring_up')

const within = (at: Date | null, expectedMs: number, slackMs = 5_000): boolean =>
    at !== null && Math.abs(at.getTime() - Date.now() - expectedMs) < slackMs

test(
    "an admin's check that finds the machine broken puts the sandbox into maintenance",
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host('broken')

            const result = await h.first.health.checkNow(id)

            assert.equal(result.outcome, 'entered')
            const row = await h.row(id)
            assert.equal(row.status, 'maintenance')
            assert.equal(
                row.failureReason,
                'Health check: unhealthy — failed to start machine'
            )
            assert.equal(row.healthStatus, 'unhealthy')
            assert.equal(row.healthFailureCount, 1)
            assert.ok(row.maintenanceSince)
            assert.ok(within(row.healthCheckNextAt, RECHECK_LADDER_MS[0]))
            assert.equal(row.healthCheckLeaseUntil, null)
            assert.deepEqual(h.announced, [id])
            assert.equal(h.named(SANDBOX_MAINTENANCE_ENTERED_EVENT).length, 1)
        })
)

test(
    'a healthy re-check is the way out, and anything else backs off',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host('flaky')
            await h.first.health.checkNow(id)

            // Due, still broken: it stays, one step further down the ladder.
            await h.set(id, { healthCheckNextAt: new Date(Date.now() - 1_000) })
            await h.first.health.tick()
            let row = await h.row(id)
            assert.equal(row.status, 'maintenance')
            assert.equal(row.healthFailureCount, 2)
            assert.ok(within(row.healthCheckNextAt, RECHECK_LADDER_MS[1]))

            // Not due: the tick leaves it alone.
            h.script.current = async () => report('healthy')
            await h.first.health.tick()
            assert.equal((await h.row(id)).status, 'maintenance')

            // Due and healthy: back to ready, with the maintenance state cleared.
            await h.set(id, { healthCheckNextAt: new Date(Date.now() - 1_000) })
            await h.first.health.tick()
            row = await h.row(id)
            assert.equal(row.status, 'ready')
            assert.equal(row.failureReason, null)
            assert.equal(row.maintenanceSince, null)
            assert.equal(row.healthCheckNextAt, null)
            assert.equal(row.healthFailureCount, 0)
            assert.equal(row.healthStatus, 'healthy')
            assert.equal(h.named(SANDBOX_MAINTENANCE_EXITED_EVENT).length, 1)
            assert.deepEqual(h.announced, [id, id])
        })
)

test(
    'a repaired machine is checked again within minutes, whatever its step',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host('repaired')
            await h.first.health.checkNow(id)
            await h.set(id, {
                healthFailureCount: 3,
                healthCheckNextAt: new Date(Date.now() - 1_000)
            })
            h.script.current = async () =>
                report('repaired', 'restarted stopped machine')

            await h.first.health.tick()

            const row = await h.row(id)
            assert.equal(row.status, 'maintenance')
            assert.equal(row.healthFailureCount, 4)
            assert.ok(within(row.healthCheckNextAt, 2 * 60_000))
        })
)

test(
    'one check per machine across the fleet',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host('contended')
            h.script.current = async () => {
                await new Promise((resolve) => setTimeout(resolve, 200))
                return report('unhealthy')
            }

            const results = await Promise.all(
                h.fleet.map((instance) => instance.health.checkNow(id))
            )

            assert.equal(h.asked.length, 1, 'the provider was asked once')
            assert.equal(
                results.filter((r) => r.outcome === 'entered').length,
                1
            )
            assert.equal(
                results.filter((r) => r.outcome === 'in_progress').length,
                h.fleet.length - 1
            )
        })
)

test(
    'a failing machine is asked about at most once per interval, a failed call included',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS] = true
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_MAINTENANCE_AUTO] = true
            const id = await h.host('erroring')
            h.script.current = async () => {
                throw new Error('bad gateway')
            }

            await afterFailure(h.first, id)
            await afterFailure(h.fleet[1], id)

            assert.equal(h.asked.length, 1)
            // A call that told nothing changed nothing.
            const row = await h.row(id)
            assert.equal(row.status, 'ready')
            assert.equal(row.healthStatus, null)
            assert.equal(row.healthCheckLeaseUntil, null)
            assert.ok(row.healthCheckAttemptedAt)
        })
)

test(
    'automatic checks only record while automatic entry is off',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS] = true
            const id = await h.host('shadowed')

            await afterFailure(h.first, id)

            const row = await h.row(id)
            assert.equal(row.status, 'ready')
            assert.equal(row.healthStatus, 'unhealthy')
            const [checked] = h.named(SANDBOX_HEALTH_CHECKED_EVENT)
            assert.equal(checked.attrs.outcome, 'suppressed')
            assert.equal(checked.attrs.mode, 'shadow')
            assert.deepEqual(h.announced, [])

            // And with the failure-check switch off, nothing is asked at all.
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS] = false
            const other = await h.host('untouched')
            await afterFailure(h.first, other)
            assert.deepEqual(h.asked, [id])
        })
)

test(
    'automatic entry is capped per hour; an admin check is not',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS] = true
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_MAINTENANCE_AUTO] = true
            for (let i = 0; i < 5; i += 1)
                await h.host('earlier', {
                    status: 'maintenance',
                    maintenanceSince: new Date(),
                    healthCheckNextAt: new Date(Date.now() + 3_600_000)
                })
            const capped = await h.host('capped')
            const admin = await h.host('admin')

            await afterFailure(h.first, capped)
            const adminResult = await h.first.health.checkNow(admin)

            assert.equal((await h.row(capped)).status, 'ready')
            const [checked] = h.named(SANDBOX_HEALTH_CHECKED_EVENT)
            assert.equal(checked.attrs.mode, 'capped')
            assert.equal(adminResult.outcome, 'entered')
            assert.equal((await h.row(admin)).status, 'maintenance')
        })
)

test(
    'ending maintenance drops a verdict still in flight',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host('ended')
            await h.first.health.checkNow(id)
            await h.set(id, { healthCheckNextAt: new Date(Date.now() - 1_000) })
            let answer!: (value: ProviderHealthReport) => void
            h.script.current = () =>
                new Promise<ProviderHealthReport>((resolve) => {
                    answer = resolve
                })

            const recheck = h.first.health.tick()
            while (!answer) await new Promise((resolve) => setTimeout(resolve, 10))
            const ended = await h.fleet[1].health.endMaintenance(id)
            answer(report('unhealthy'))
            await recheck

            assert.equal(ended?.status, 'ready')
            const row = await h.row(id)
            assert.equal(row.status, 'ready', 'the late verdict did not put it back')
            assert.equal(row.healthCheckLeaseUntil, null)
            const outcomes = h
                .named(SANDBOX_HEALTH_CHECKED_EVENT)
                .map((e) => e.attrs.outcome)
            assert.deepEqual(outcomes, ['entered', 'lost'])
        })
)

test(
    'the sweep never asks about a machine a daemon proved alive, or one too young to judge',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_SWEEP] = true
            const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3_600_000)
            const idle = await h.host('idle', { createdAt: twoDaysAgo })
            const alive = await h.host('alive', { createdAt: twoDaysAgo })
            await h.host('young')
            await h.first.db.insert(hostDaemons).values({
                hostId: alive,
                userId: h.user,
                daemonUuid: `uuid-${alive}`,
                lastSeenAt: new Date()
            })
            h.script.current = async () => report('healthy')

            await h.first.health.tick()

            assert.deepEqual(h.asked, [idle])
            assert.equal((await h.row(idle)).healthStatus, 'healthy')
        })
)

test(
    'a failure on a machine whose daemon is connected asks the provider nothing',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            h.toggles[FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS] = true
            const id = await h.host('connected')
            await h.first.db.insert(hostDaemons).values({
                hostId: id,
                userId: h.user,
                daemonUuid: `uuid-${id}`,
                lastSeenAt: new Date(),
                rpcConnectedAt: new Date()
            })

            await afterFailure(h.first, id)

            assert.deepEqual(h.asked, [])
        })
)
