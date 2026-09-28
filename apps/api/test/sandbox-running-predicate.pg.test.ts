import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    createDb,
    plans,
    runtimeHosts,
    runtimeProviders,
    users,
    type Database
} from '@manyfold/db'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import { AdminSandboxQuotasService } from '../src/modules/admin-sandbox-quotas/admin-sandbox-quotas.service'

// Real-Postgres proof that the two raw-SQL spots which count running sandboxes
// — the keep-awake enable's committed-capacity union and the admin overview's
// per-user subquery — select the same set as runningHostedHosts: a live
// sprites host whose power is running. The unit fakes read these queries as
// text, so only a real database can say the SQL is right.
const RUN = process.env.RUN_PG_E2E === '1'

interface Seed {
    id: string
    status: 'provisioning' | 'ready' | 'failed' | 'deleting'
    powerState: 'running' | 'suspended' | 'stopped'
    keepAwake: boolean
}

const seedUser = async (
    db: Database,
    maxConcurrentActive: number,
    hosts: Seed[]
) => {
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const planId = `plan_pgtest_${suffix}`
    const providerId = `rtp_pgtest_${suffix}`
    await db.insert(plans).values({
        id: planId,
        name: `pgtest-${suffix}`,
        maxAgentsProvisioned: 10,
        maxConcurrentActive,
        maxStorageGb: 1,
        monthlyApiRequestLimit: null
    })
    await db.insert(users).values({
        id: userId,
        email: `${suffix}@pgtest.local`,
        planId
    })
    await db.insert(runtimeProviders).values({
        id: providerId,
        kind: 'sprites',
        name: `pgtest-${suffix}`,
        credentialCiphertext: 'encrypted'
    })
    for (const host of hosts)
        await db.insert(runtimeHosts).values({
            id: `${host.id}_${suffix}`,
            userId,
            kind: 'hosted',
            providerId,
            providerRef: {
                kind: 'sprites',
                spriteName: `${host.id}-${suffix}`,
                spriteId: 'sp'
            },
            name: `pgtest-${host.id}-${suffix}`,
            status: host.status,
            powerState: host.powerState,
            keepAwake: host.keepAwake
        })
    return {
        userId,
        hostId: (id: string) => `${id}_${suffix}`,
        cleanup: async () => {
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(plans).where(eq(plans.id, planId))
            await db
                .delete(runtimeProviders)
                .where(eq(runtimeProviders.id, providerId))
        }
    }
}

const adminSettings = {
    getCachedSpritesEffectiveCap: async () => ({
        activeCap: 1_000_000,
        softThresholdPct: 99,
        policyActiveCap: 1_000_000,
        vendorRunningLimit: null,
        clamped: false
    }),
    isFeatureEnabled: async () => true
}

const HOSTS: Seed[] = [
    { id: 'running', status: 'ready', powerState: 'running', keepAwake: false },
    { id: 'asleep_kept', status: 'ready', powerState: 'stopped', keepAwake: true },
    { id: 'target', status: 'ready', powerState: 'running', keepAwake: false },
    { id: 'asleep', status: 'ready', powerState: 'suspended', keepAwake: false },
    { id: 'failed', status: 'failed', powerState: 'running', keepAwake: true }
]

const closeDb = async (db: Database) => {
    const client = (db as unknown as { $client?: { end?: () => Promise<void> } })
        .$client
    if (client?.end) await client.end()
}

// WHY: enabling keep-awake commits a slot, so it counts every sandbox already
// running or kept awake — the target excluded, a failed host never.
test('keep-awake enable counts running and kept-awake sandboxes, not the target or a failed one', { skip: !RUN }, async () => {
    const db = createDb(process.env.DATABASE_URL!)
    const service = new RuntimeAccessService(
        db as never,
        adminSettings as never,
        { event: () => {}, error: () => {} } as never,
        { userActiveSecondsInPeriod: async () => 0 } as never
    )
    const full = await seedUser(db, 2, HOSTS)
    const roomy = await seedUser(db, 3, HOSTS)
    try {
        await assert.rejects(
            service.enableKeepAlive({
                userId: full.userId,
                hostId: full.hostId('target')
            }),
            (err) => {
                assert.ok(err instanceof ForbiddenException)
                const body = (err as ForbiddenException).getResponse() as {
                    current?: number
                }
                assert.equal(body.current, 2)
                return true
            }
        )
        await service.enableKeepAlive({
            userId: roomy.userId,
            hostId: roomy.hostId('target')
        })
        const [row] = await db
            .select({ keepAwake: runtimeHosts.keepAwake })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, roomy.hostId('target')))
        assert.equal(row?.keepAwake, true)
    } finally {
        await full.cleanup()
        await roomy.cleanup()
        await closeDb(db)
    }
})

test('the admin overview counts a user running sandboxes the way the caps do', { skip: !RUN }, async () => {
    const db = createDb(process.env.DATABASE_URL!)
    const service = new AdminSandboxQuotasService(
        db as never,
        adminSettings as never,
        { activeSecondsInPeriodByUser: async () => new Map() } as never
    )
    const seeded = await seedUser(db, 2, HOSTS)
    try {
        const page = await service.listUsers({ limit: 200 })
        const row = page.users.find((user) => user.userId === seeded.userId)
        assert.ok(row, 'seeded user listed')
        assert.equal(row.concurrentActive, 2)
        assert.equal(row.provisioned, 4)
    } finally {
        await seeded.cleanup()
        await closeDb(db)
    }
})
