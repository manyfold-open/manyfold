import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentUsageEvents,
    createDb,
    userModelProviders,
    users,
    type Database
} from '@manyfold/db'
import { ModelProvidersService } from '../src/modules/model-providers/model-providers.service'

// Real-Postgres proof for the per-provider spend aggregate. The api unit
// tests run against a fake db whose where() is a no-op, so the user scoping,
// the from/to bounds, the NULL-cost semantics and the retained NULL-provider
// group can only be proven here. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://... npx tsx --test test/model-provider-usage.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    service: ModelProvidersService
    userId: string
    otherUserId: string
    providerA: string
    providerB: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const otherUserId = `user_pgtest_other_${suffix}`
    const providerA = `ump_pgtest_a_${suffix}`
    const providerB = `ump_pgtest_b_${suffix}`

    for (const [id, email] of [
        [userId, `${suffix}@pgtest.local`],
        [otherUserId, `other-${suffix}@pgtest.local`]
    ])
        await db.insert(users).values({ id, email })
    for (const [id, owner] of [
        [providerA, userId],
        [providerB, userId]
    ])
        await db.insert(userModelProviders).values({
            id,
            userId: owner,
            inferenceProtocol: 'openai_chat_completions',
            providerName: `pgtest-${id}`,
            apiKeyCiphertext: 'ciphertext'
        })

    // Only listUsage/usageByProvider are exercised; the crypto, provider-test
    // and managed collaborators are never reached on this path. Positional
    // construction is supported by design (see the constructor's comment).
    const service = new ModelProvidersService(db, null as never, null as never)

    return {
        db,
        service,
        userId,
        otherUserId,
        providerA,
        providerB,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(users).where(eq(users.id, otherUserId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const event = async (
    h: Harness,
    input: {
        userId?: string
        modelProviderId: string | null
        costUsd: string | null
        createdAt: Date
        inputTokens?: number
    }
): Promise<void> => {
    await h.db.insert(agentUsageEvents).values({
        id: `aue_pgtest_${randomBytes(8).toString('hex')}`,
        userId: input.userId ?? h.userId,
        framework: 'claude-code',
        runtimeKind: 'sprites',
        model: 'test-model',
        inputTokens: input.inputTokens ?? 10,
        outputTokens: 5,
        costUsd: input.costUsd,
        costSource: input.costUsd === null ? 'unknown' : 'table',
        modelProviderId: input.modelProviderId,
        createdAt: input.createdAt
    })
}

const day = (n: number): Date => new Date(Date.now() - n * 86_400_000)

const rowFor = (
    report: { rows: Array<{ modelProviderId: string | null }> },
    id: string | null
): (typeof report.rows)[number] | undefined =>
    report.rows.find((r) => r.modelProviderId === id)

test('spend is scoped to the caller and keeps the unattributed group', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: '1.500000',
            createdAt: day(1)
        })
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: '0.500000',
            createdAt: day(2)
        })
        // No provider bound on the agent — real spend that must not vanish.
        await event(h, {
            modelProviderId: null,
            costUsd: '0.250000',
            createdAt: day(1)
        })
        // Another tenant's spend must never appear.
        await event(h, {
            userId: h.otherUserId,
            modelProviderId: null,
            costUsd: '99.000000',
            createdAt: day(1)
        })

        const report = await h.service.listUsage(h.userId, {})
        const a = rowFor(report, h.providerA)
        assert.equal(a?.usage.costUsd, 2)
        assert.equal(a?.usage.eventCount, 2)
        assert.equal(a?.usage.inputTokens, 20)

        const unattributed = rowFor(report, null)
        assert.equal(unattributed?.usage.costUsd, 0.25)
        assert.equal(unattributed?.usage.eventCount, 1)

        const total = report.rows.reduce(
            (n, r) => n + (r.usage.costUsd ?? 0),
            0
        )
        assert.equal(total, 2.25)
    } finally {
        await h.close()
    }
})

test('an all-unpriced group reports null cost, not zero', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: null,
            createdAt: day(1)
        })
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: null,
            createdAt: day(1)
        })
        await event(h, {
            modelProviderId: h.providerB,
            costUsd: '3.000000',
            createdAt: day(1)
        })
        await event(h, {
            modelProviderId: h.providerB,
            costUsd: null,
            createdAt: day(1)
        })

        const report = await h.service.listUsage(h.userId, {})
        const a = rowFor(report, h.providerA)
        // Unknown, not free — rendering 0 here would be a lie.
        assert.equal(a?.usage.costUsd, null)
        assert.equal(a?.usage.unpricedEventCount, 2)
        assert.equal(a?.usage.eventCount, 2)

        const b = rowFor(report, h.providerB)
        // A mixed group sums only the priced rows, so the amount is a lower
        // bound — which is exactly what unpricedEventCount tells the UI.
        assert.equal(b?.usage.costUsd, 3)
        assert.equal(b?.usage.unpricedEventCount, 1)
        assert.equal(b?.usage.eventCount, 2)
    } finally {
        await h.close()
    }
})

test('from is inclusive and to is exclusive', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        const inside = day(3)
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: '1.000000',
            createdAt: inside
        })
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: '1.000000',
            createdAt: day(40)
        })

        const windowed = await h.service.listUsage(h.userId, {
            from: day(7).toISOString()
        })
        assert.equal(rowFor(windowed, h.providerA)?.usage.eventCount, 1)

        const onBoundary = await h.service.listUsage(h.userId, {
            from: inside.toISOString()
        })
        assert.equal(rowFor(onBoundary, h.providerA)?.usage.eventCount, 1)

        const excluded = await h.service.listUsage(h.userId, {
            to: inside.toISOString()
        })
        assert.equal(rowFor(excluded, h.providerA)?.usage.eventCount, 1)
        assert.equal(rowFor(excluded, h.providerA)?.usage.costUsd, 1)
    } finally {
        await h.close()
    }
})

test('deleting a provider moves its history into the unattributed group', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await event(h, {
            modelProviderId: h.providerA,
            costUsd: '4.000000',
            createdAt: day(1)
        })
        await h.db
            .delete(userModelProviders)
            .where(eq(userModelProviders.id, h.providerA))

        // agent_usage_events.model_provider_id is ON DELETE SET NULL, so the
        // spend survives the provider row and lands in the null group.
        const report = await h.service.listUsage(h.userId, {})
        assert.equal(rowFor(report, h.providerA), undefined)
        assert.equal(rowFor(report, null)?.usage.costUsd, 4)
    } finally {
        await h.close()
    }
})
