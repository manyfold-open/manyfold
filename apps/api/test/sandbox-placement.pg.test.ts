import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    createDb,
    plans,
    runtimeHosts,
    runtimeProviders,
    users,
    type Database,
    type NewAgentRuntimeRow
} from '@manyfold/db'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'

// Sandbox placement is raw SQL — the attach probe computes framework presence and
// the service-slot occupant in one subselect-laden statement — so only real
// Postgres proves it. The fake db in runtime-access.service.test.ts models the
// same shape by hand and would happily agree with a broken query.
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
    providerId: string
    oldHostId: string
    newHostId: string
    seed: (
        hostId: string,
        framework: NewAgentRuntimeRow['framework'],
        status?: NewAgentRuntimeRow['status']
    ) => Promise<void>
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

// sandboxLimit feeds BOTH the plan and the per-user override: the effective
// provisioned-host quota is the max of the two.
const buildHarness = async (opts?: {
    sandboxLimit?: number
}): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const planId = `plan_pgtest_${suffix}`
    const providerId = `rtp_pgtest_${suffix}`
    const oldHostId = `sbx_pgtest_old_${suffix}`
    const newHostId = `sbx_pgtest_new_${suffix}`

    const sandboxLimit = opts?.sandboxLimit ?? 5
    await db.insert(plans).values({
        id: planId,
        name: `pgtest-${suffix}`,
        maxAgentsProvisioned: sandboxLimit,
        maxConcurrentActive: 5,
        maxStorageGb: 100,
        monthlyApiRequestLimit: null
    })
    await db.insert(users).values({
        id: userId,
        email: `${suffix}@pgtest.local`,
        planId,
        statefulSandboxLimit: sandboxLimit
    })
    await db.insert(runtimeProviders).values({
        id: providerId,
        kind: 'sprites',
        name: `pgtest-${suffix}`,
        credentialCiphertext: 'encrypted',
        config: { orgSlug: 'pgtest-org', orgId: `org-${suffix}`, tokenId: `tok-${suffix}` }
    })
    // Two existing sandboxes, both ready and published. Under explicit
    // placement neither may be chosen unless a request names it.
    const now = Date.now()
    await db.insert(runtimeHosts).values([
        {
            id: oldHostId,
            userId,
            kind: 'hosted',
            providerId,
            providerRef: {
                kind: 'sprites',
                spriteName: oldHostId.replace(/_/g, '-'),
                spriteId: `sprite-old-${suffix}`
            },
            name: `pgtest-sandbox-old-${suffix}`,
            status: 'ready',
            createdAt: new Date(now - 2 * HOUR_MS)
        },
        {
            id: newHostId,
            userId,
            kind: 'hosted',
            providerId,
            providerRef: {
                kind: 'sprites',
                spriteName: newHostId.replace(/_/g, '-'),
                spriteId: `sprite-new-${suffix}`
            },
            name: `pgtest-sandbox-new-${suffix}`,
            status: 'ready',
            createdAt: new Date(now - HOUR_MS)
        }
    ])

    return {
        db,
        service: makeService(db),
        userId,
        providerId,
        oldHostId,
        newHostId,
        seed: async (hostId, framework, status = 'ready'): Promise<void> => {
            const id = `art_pgseed_${randomBytes(6).toString('hex')}`
            await db.insert(agentRuntimes).values({
                id,
                userId,
                name: `${hostId}-${framework}-${randomBytes(3).toString('hex')}`,
                framework,
                status,
                hostId,
                mountPath: '/home/sprite'
            })
        },
        close: async (): Promise<void> => {
            // agent_runtimes + runtime_hosts cascade from the user row.
            await db.delete(users).where(eq(users.id, userId))
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

const reserve = (
    h: Harness,
    overrides?: {
        hostId?: string
        framework?: NewAgentRuntimeRow['framework']
    }
): ReturnType<RuntimeAccessService['reserveSpriteRuntime']> =>
    h.service.reserveSpriteRuntime({
        id: `art_pgtest_${randomBytes(6).toString('hex')}`,
        userId: h.userId,
        framework: overrides?.framework ?? 'gemini-cli',
        providerId: h.providerId,
        hostId: overrides?.hostId,
        mountPath: '/home/sprite/.manyfold/workspaces/agt_pgtest'
    })

const codeOf = (err: unknown): string | undefined =>
    (err as { response?: { code?: string } }).response?.code

// Explicit placement: two idle, healthy, published sandboxes exist and neither is
// touched. The old behaviour selected the OLDER of these by `created_at`.
test(
    'a reservation with no named sandbox always builds a fresh host',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const { runtime, hostCreated } = await reserve(h)
            assert.equal(hostCreated, true)
            assert.notEqual(runtime.hostId, h.oldHostId)
            assert.notEqual(runtime.hostId, h.newHostId)
        } finally {
            await h.close()
        }
    }
)

test(
    'a named sandbox is attached to without creating a host',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'claude-code')
            const { runtime, hostCreated } = await reserve(h, {
                hostId: h.oldHostId,
                framework: 'codex'
            })
            assert.equal(hostCreated, false)
            assert.equal(runtime.hostId, h.oldHostId)
        } finally {
            await h.close()
        }
    }
)

// No capacity ceiling. Four co-resident runtimes used to be the limit, which
// would have made this the rejected fifth.
test(
    'a fifth framework still attaches to a sandbox running four',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'claude-code')
            await h.seed(h.oldHostId, 'codex')
            await h.seed(h.oldHostId, 'openclaw')
            await h.seed(h.oldHostId, 'hermes')
            const { runtime, hostCreated } = await reserve(h, {
                hostId: h.oldHostId,
                framework: 'gemini-cli'
            })
            assert.equal(hostCreated, false)
            assert.equal(runtime.hostId, h.oldHostId)
        } finally {
            await h.close()
        }
    }
)

// A coding framework needs no public port, so it never blocks a service one —
// this is the case the old exec-kind gate refused outright.
test(
    'a service framework attaches to a sandbox running only coding frameworks',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'claude-code')
            await h.seed(h.oldHostId, 'codex')
            const { runtime, hostCreated } = await reserve(h, {
                hostId: h.oldHostId,
                framework: 'hermes'
            })
            assert.equal(hostCreated, false)
            assert.equal(runtime.hostId, h.oldHostId)
            assert.equal(runtime.framework, 'hermes')
        } finally {
            await h.close()
        }
    }
)

// Both would claim the sprite's single `http_port`, which the platform rejects —
// so this must fail here, before any VM work, not inside bootstrap.
test(
    'a second service framework on one sandbox is refused',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'openclaw')
            await assert.rejects(
                reserve(h, { hostId: h.oldHostId, framework: 'hermes' }),
                (err: unknown) => {
                    assert.equal(codeOf(err), 'SANDBOX_SERVICE_SLOT_TAKEN')
                    assert.equal(
                        (
                            err as {
                                response?: { existingFramework?: string }
                            }
                        ).response?.existingFramework,
                        'openclaw',
                        'the caller needs to know which framework holds the slot'
                    )
                    return true
                }
            )
        } finally {
            await h.close()
        }
    }
)

// A failed service runtime releases the port, so its sandbox can take another one.
test(
    'a failed service framework does not hold the service slot',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'openclaw', 'failed')
            const { runtime } = await reserve(h, {
                hostId: h.oldHostId,
                framework: 'hermes'
            })
            assert.equal(runtime.hostId, h.oldHostId)
        } finally {
            await h.close()
        }
    }
)

// Callers route a same-framework create into the existing instance before
// reserving, so this fires only on a race. The partial unique index on
// (host_id, framework) is what makes the check trustworthy under concurrency.
test(
    'a second instance of the same framework on one sandbox is refused',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'codex')
            await assert.rejects(
                reserve(h, { hostId: h.oldHostId, framework: 'codex' }),
                (err: unknown) => {
                    assert.equal(codeOf(err), 'SANDBOX_FRAMEWORK_EXISTS')
                    return true
                }
            )
        } finally {
            await h.close()
        }
    }
)

// The gate above reads `status <> 'failed'`; the unique index on
// (host_id, framework) has no status predicate, so a failed row is REUSED by
// the upsert rather than duplicated. If the two ever diverge, the insert here
// throws a raw constraint error instead of returning the existing row.
test(
    'the partial unique index agrees with the framework-presence gate',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed(h.oldHostId, 'codex', 'failed')
            const { runtime } = await reserve(h, {
                hostId: h.oldHostId,
                framework: 'codex'
            })
            assert.equal(
                runtime.hostId,
                h.oldHostId,
                'a failed instance frees the framework slot and its row is reused'
            )
            assert.equal(runtime.status, 'installing')
        } finally {
            await h.close()
        }
    }
)

test(
    'attaching to a foreign sandbox is not found',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const other = await buildHarness()
            try {
                await assert.rejects(
                    reserve(h, { hostId: other.oldHostId }),
                    (err: unknown) => {
                        assert.equal(codeOf(err), 'SANDBOX_NOT_FOUND')
                        return true
                    }
                )
            } finally {
                await other.close()
            }
        } finally {
            await h.close()
        }
    }
)

test(
    'a fresh host still consumes provisioned quota',
    { skip: !RUN },
    async () => {
        const h = await buildHarness({ sandboxLimit: 2 })
        try {
            await assert.rejects(reserve(h), (err: unknown) => {
                assert.equal(codeOf(err), 'RUNTIME_LIMIT_REACHED')
                return true
            })
        } finally {
            await h.close()
        }
    }
)
