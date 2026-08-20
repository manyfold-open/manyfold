import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    createDb,
    plans,
    runtimeHosts,
    sandboxActiveDurationDays,
    users,
    type Database
} from '@manyfold/db'
import { ForbiddenException } from '@nestjs/common'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import { SandboxActiveDurationService } from '../src/modules/agents/sandbox-active-duration/sandbox-active-duration.service'

// Real-Postgres proof of the active-hours hard block: the day-bucket ledger
// SUM, the usage-period resolution (no live subscription → calendar month)
// and the users⋈plans limit read all run against real SQL — the fake-db unit
// tests stub all three. Also proves the two unblock levers act immediately:
// users.active_hours_bonus and a plan change, both re-read on every admission.
// Env-gated like the other *.pg.test.ts (run per-file, see repo convention):
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/active-hours-quota.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    service: RuntimeAccessService
    userId: string
    planId: string
    hostId: string
    close: () => Promise<void>
}

const makeService = (db: Database): RuntimeAccessService => {
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
    const telemetry = { event: () => {}, error: () => {} }
    return new RuntimeAccessService(
        db as never,
        adminSettings as never,
        telemetry as never,
        new SandboxActiveDurationService(db) as never
    )
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const planId = `plan_pgtest_${suffix}`
    const hostId = `rt_pgtest_${suffix}`

    await db.insert(plans).values({
        id: planId,
        name: `pgtest-${suffix}`,
        maxAgentsProvisioned: 5,
        maxConcurrentActive: 5,
        maxStorageGb: 10,
        monthlyActiveHoursIncluded: 1,
        monthlyApiRequestLimit: null
    })
    await db.insert(users).values({
        id: userId,
        email: `${suffix}@pgtest.local`,
        planId
    })
    await db.insert(runtimeHosts).values({
        id: hostId,
        userId,
        kind: 'sandbox',
        name: `pgtest-sandbox-${suffix}`,
        spriteStatus: 'cold',
        activeAccrualSince: null
    })
    // 1h of metered activity today: exactly the plan's included hour, so the
    // user is at the limit inside the current calendar-month usage period.
    await db.insert(sandboxActiveDurationDays).values({
        hostId,
        userId,
        day: new Date().toISOString().slice(0, 10),
        activeSeconds: 3600
    })

    return {
        db,
        service: makeService(db),
        userId,
        planId,
        hostId,
        close: async (): Promise<void> => {
            // sandbox_active_duration_days.user_id and runtime_hosts.user_id
            // cascade on user delete.
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(plans).where(eq(plans.id, planId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const resetHostCold = async (h: Harness): Promise<void> => {
    await h.db
        .update(runtimeHosts)
        .set({ spriteStatus: 'cold', activeAccrualSince: null })
        .where(eq(runtimeHosts.id, h.hostId))
}

test(
    'reserveActiveSlot blocks at the ledger-summed limit and unblocks via bonus or plan change',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await assert.rejects(
                () =>
                    h.service.reserveActiveSlot({
                        userId: h.userId,
                        hostId: h.hostId
                    }),
                (err) => {
                    const body = (
                        err as ForbiddenException
                    ).getResponse() as {
                        code?: string
                        current?: number
                        limit?: number
                    }
                    assert.equal(body.code, 'ACTIVE_HOURS_QUOTA_REACHED')
                    assert.equal(body.current, 1)
                    assert.equal(body.limit, 1)
                    return err instanceof ForbiddenException
                }
            )

            // Admin relief valve: the bonus is read live on the next admission.
            await h.db
                .update(users)
                .set({ activeHoursBonus: 1 })
                .where(eq(users.id, h.userId))
            const withBonus = await h.service.reserveActiveSlot({
                userId: h.userId,
                hostId: h.hostId
            })
            assert.ok(withBonus.plan, 'bonus lifts the limit immediately')

            // Plan change (upgrade) is also read live — reset the bonus and
            // make the plan unlimited.
            await resetHostCold(h)
            await h.db
                .update(users)
                .set({ activeHoursBonus: 0 })
                .where(eq(users.id, h.userId))
            await assert.rejects(() =>
                h.service.reserveActiveSlot({
                    userId: h.userId,
                    hostId: h.hostId
                })
            )
            await h.db
                .update(plans)
                .set({ monthlyActiveHoursIncluded: null })
                .where(eq(plans.id, h.planId))
            const unlimited = await h.service.reserveActiveSlot({
                userId: h.userId,
                hostId: h.hostId
            })
            assert.ok(unlimited.plan, 'plan upgrade unblocks immediately')
        } finally {
            await h.close()
        }
    }
)

test(
    'ledger rows outside the current usage period do not count against the limit',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Move the activity into last month: the calendar-month period of
            // a subscription-less user must exclude it.
            const lastMonth = new Date()
            lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)
            await h.db
                .update(sandboxActiveDurationDays)
                .set({ day: lastMonth.toISOString().slice(0, 10) })
                .where(eq(sandboxActiveDurationDays.userId, h.userId))

            const result = await h.service.reserveActiveSlot({
                userId: h.userId,
                hostId: h.hostId
            })
            assert.ok(result.plan, 'last month usage is outside the window')
        } finally {
            await h.close()
        }
    }
)
