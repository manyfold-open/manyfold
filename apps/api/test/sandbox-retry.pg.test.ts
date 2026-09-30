import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { NotFoundException } from '@nestjs/common'
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

// A retry flips a failed sandbox back to provisioning with the guard written
// in SQL, so only real Postgres proves it: the fake db in
// runtime-access.service.test.ts matches a row by id alone and would flip it
// whatever its status or owner.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const HOUR_MS = 60 * 60_000

interface Harness {
    db: Database
    service: RuntimeAccessService
    userId: string
    otherUserId: string
    seedHost: (over: {
        status: 'provisioning' | 'ready' | 'failed' | 'deleting'
        userId?: string
        failureReason?: string
        emptiedAt?: Date
    }) => Promise<string>
    readHost: (id: string) => Promise<typeof runtimeHosts.$inferSelect>
    close: () => Promise<void>
}

const makeService = (db: Database): RuntimeAccessService =>
    new RuntimeAccessService(
        db as never,
        {
            getCachedSpritesEffectiveCap: async () => ({
                activeCap: 1_000_000,
                softThresholdPct: 99,
                policyActiveCap: 1_000_000,
                vendorRunningLimit: null,
                clamped: false
            }),
            isFeatureEnabled: async () => true
        } as never,
        { event: () => {}, error: () => {} } as never,
        { userActiveSecondsInPeriod: async () => 0 } as never
    )

const buildHarness = async (opts?: {
    sandboxLimit?: number
}): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const otherUserId = `user_pgtest_other_${suffix}`
    const planId = `plan_pgtest_${suffix}`
    const providerId = `rtp_pgtest_${suffix}`
    const sandboxLimit = opts?.sandboxLimit ?? 5
    await db.insert(plans).values({
        id: planId,
        name: `pgtest-${suffix}`,
        maxAgentsProvisioned: sandboxLimit,
        maxConcurrentActive: 5,
        maxStorageGb: 100,
        monthlyApiRequestLimit: null
    })
    await db.insert(users).values([
        {
            id: userId,
            email: `${suffix}@pgtest.local`,
            planId,
            statefulSandboxLimit: sandboxLimit
        },
        {
            id: otherUserId,
            email: `other-${suffix}@pgtest.local`,
            planId,
            statefulSandboxLimit: sandboxLimit
        }
    ])
    await db.insert(runtimeProviders).values({
        id: providerId,
        kind: 'sprites',
        name: `pgtest-${suffix}`,
        credentialCiphertext: 'encrypted',
        config: { orgSlug: 'pgtest-org', orgId: `org-${suffix}`, tokenId: `tok-${suffix}` }
    })
    let seeded = 0
    return {
        db,
        service: makeService(db),
        userId,
        otherUserId,
        seedHost: async (over): Promise<string> => {
            seeded += 1
            const id = `sbx_pgtest_${seeded}_${suffix}`
            await db.insert(runtimeHosts).values({
                id,
                userId: over.userId ?? userId,
                kind: 'hosted',
                providerId,
                providerRef: {
                    kind: 'sprites',
                    spriteName: id.replace(/_/g, '-'),
                    spriteId: null
                },
                name: `pgtest-sandbox-${seeded}-${suffix}`,
                status: over.status,
                failureReason: over.failureReason ?? null,
                emptiedAt: over.emptiedAt ?? null
            })
            return id
        },
        readHost: async (id) => {
            const [row] = await db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, id))
            return row
        },
        close: async (): Promise<void> => {
            // runtime_hosts cascade from the user rows.
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(users).where(eq(users.id, otherUserId))
            await db.delete(plans).where(eq(plans.id, planId))
            await db
                .delete(runtimeProviders)
                .where(eq(runtimeProviders.id, providerId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const codeOf = (err: unknown): string | undefined =>
    (err as { response?: { code?: string } }).response?.code

test(
    'a failed sandbox goes back to provisioning in its own row, its reason cleared and its reaper clock restarted',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const builtAt = new Date(Date.now() - 10 * 24 * HOUR_MS)
            const id = await h.seedHost({
                status: 'failed',
                failureReason: 'runner did not connect',
                emptiedAt: builtAt
            })
            const retried = await h.service.reserveSandboxRetry({
                userId: h.userId,
                hostId: id
            })
            assert.equal(retried.id, id)
            const row = await h.readHost(id)
            assert.equal(row.status, 'provisioning')
            assert.equal(row.failureReason, null)
            assert.ok(row.emptiedAt && row.emptiedAt > builtAt)
        } finally {
            await h.close()
        }
    }
)

test(
    'a sandbox that is not failed keeps its state',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const id = await h.seedHost({ status: 'deleting' })
            await assert.rejects(
                () =>
                    h.service.reserveSandboxRetry({
                        userId: h.userId,
                        hostId: id
                    }),
                (err) => codeOf(err) === 'SANDBOX_NOT_FAILED'
            )
            assert.equal((await h.readHost(id)).status, 'deleting')
        } finally {
            await h.close()
        }
    }
)

test(
    "another user's failed sandbox is not found and not touched",
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const id = await h.seedHost({
                status: 'failed',
                userId: h.otherUserId
            })
            await assert.rejects(
                () =>
                    h.service.reserveSandboxRetry({
                        userId: h.userId,
                        hostId: id
                    }),
                NotFoundException
            )
            assert.equal((await h.readHost(id)).status, 'failed')
        } finally {
            await h.close()
        }
    }
)

test(
    'a retry is refused while live sandboxes fill the plan, and the row stays failed',
    { skip: !RUN },
    async () => {
        const h = await buildHarness({ sandboxLimit: 1 })
        try {
            await h.seedHost({ status: 'ready' })
            const id = await h.seedHost({ status: 'failed' })
            await assert.rejects(
                () =>
                    h.service.reserveSandboxRetry({
                        userId: h.userId,
                        hostId: id
                    }),
                (err) => codeOf(err) === 'RUNTIME_LIMIT_REACHED'
            )
            assert.equal((await h.readHost(id)).status, 'failed')
        } finally {
            await h.close()
        }
    }
)
