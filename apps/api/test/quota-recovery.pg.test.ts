import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
    automations,
    automationRuns,
    createDb,
    plans,
    users
} from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import { withScratchDatabase } from '../scripts/scratch-db'
import { AutomationsService } from '../src/modules/automations/automations.service'
import type { UsagePeriodPort } from '../src/common/ports/usage-period.ports'
import {
    createQuotaFixture as fixture,
    exhaustedAt,
    restoredAt,
    nextNatural
} from './helpers/quota-fixture'

const barrier = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

test(
    'quota recovery uses current headroom and future natural occurrences',
    {
        skip: process.env.RUN_PG_E2E !== '1'
    },
    async (t) => {
        await withScratchDatabase('quota_recovery', async ({ url }) => {
            const db = createDb(url)
            try {
                for (const change of ['plan change', 'limit increase']) {
                    await t.test(
                        `parked automation recovers after ${change} without an edit`,
                        async (st) => {
                            st.mock.timers.enable({
                                apis: ['Date'],
                                now: exhaustedAt.getTime()
                            })
                            const h = await fixture(db)
                            try {
                                await h.tick()
                                assert.equal(h.sent.length, 0)
                                st.mock.timers.setTime(restoredAt.getTime())
                                if (change === 'plan change')
                                    await db
                                        .update(users)
                                        .set({ planId: h.expandedPlanId })
                                        .where(eq(users.id, h.userId))
                                else
                                    await db
                                        .update(plans)
                                        .set({ maxAutomationRunsMonthly: 100 })
                                        .where(eq(plans.id, h.planId))
                                await h.tick()
                                assert.equal(
                                    h.sent.length,
                                    0,
                                    'retry wakeup is not a scheduled occurrence'
                                )
                                assert.equal(
                                    (
                                        await db
                                            .select()
                                            .from(automationRuns)
                                            .where(
                                                eq(
                                                    automationRuns.userId,
                                                    h.userId
                                                )
                                            )
                                    ).length,
                                    1,
                                    'recovery creates no run, including a failed run'
                                )
                                assert.equal(
                                    (
                                        await h.readAutomation()
                                    ).nextRunAt?.toISOString(),
                                    nextNatural.toISOString()
                                )
                                await h.tick()
                                assert.equal(
                                    h.sent.length,
                                    0,
                                    'recovery is idempotent'
                                )
                                st.mock.timers.setTime(nextNatural.getTime())
                                await h.tick()
                                assert.equal(
                                    h.sent.length,
                                    1,
                                    'the next natural occurrence dispatches'
                                )
                            } finally {
                                await h.close()
                            }
                        }
                    )
                }
                await t.test(
                    'quota park uses the same non-calendar usage period as reservation',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        const anchor = {
                            start: new Date('2026-04-05T00:00:00.000Z'),
                            end: new Date('2026-05-05T00:00:00.000Z'),
                            source: 'subscription' as const
                        }
                        const period: UsagePeriodPort = {
                            resolve: async () => anchor,
                            resolveMany: async (_db, ids) =>
                                new Map(ids.map((id) => [id, anchor]))
                        }
                        const h = await fixture(db, period)
                        try {
                            await h.tick()
                            assert.equal(
                                (
                                    await h.readAutomation()
                                ).nextRunAt?.toISOString(),
                                anchor.end.toISOString()
                            )
                        } finally {
                            await h.close()
                        }
                    }
                )
                for (const change of [
                    'microsecond edit',
                    'connection settings'
                ]) {
                    await t.test(
                        `park CAS preserves full PostgreSQL precision across ${change}`,
                        async (st) => {
                            st.mock.timers.enable({
                                apis: ['Date'],
                                now: exhaustedAt.getTime()
                            })
                            const single = createDb(url, { max: 1 })
                            const h = await fixture(single)
                            const entered = barrier(),
                                release = barrier()
                            const reserve =
                                h.runtimeAccess.reserveAutomationRun.bind(
                                    h.runtimeAccess
                                )
                            h.runtimeAccess.reserveAutomationRun = async (
                                userId
                            ) => {
                                try {
                                    await reserve(userId)
                                } finally {
                                    entered.resolve()
                                    await release.promise
                                }
                            }
                            const ticking = h.tick()
                            try {
                                await entered.promise
                                if (change === 'microsecond edit') {
                                    await single
                                        .update(automations)
                                        .set({
                                            updatedAt: sql`'2026-04-09T12:34:56.123457Z'::timestamptz`
                                        })
                                        .where(
                                            eq(automations.id, h.automationId)
                                        )
                                } else {
                                    await single.execute(
                                        sql`select set_config('TimeZone', 'Pacific/Auckland', false), set_config('DateStyle', 'SQL, DMY', false)`
                                    )
                                }
                                release.resolve()
                                await ticking
                                await single.execute(
                                    sql`select set_config('TimeZone', 'UTC', false), set_config('DateStyle', 'ISO, MDY', false)`
                                )
                                const row = await h.readAutomation()
                                if (change === 'microsecond edit') {
                                    assert.equal(
                                        row.quotaRetryAt,
                                        null,
                                        'a same-millisecond edit rejects the older revision'
                                    )
                                    assert.equal(
                                        row.nextRunAt?.toISOString(),
                                        exhaustedAt.toISOString()
                                    )
                                } else {
                                    assert.ok(row.quotaRetryAt)
                                    assert.equal(
                                        row.nextRunAt?.toISOString(),
                                        '2026-05-01T00:00:00.000Z'
                                    )
                                }
                            } finally {
                                release.resolve()
                                await ticking
                                await h.close()
                                await (
                                    single as unknown as {
                                        $client: { end: () => Promise<void> }
                                    }
                                ).$client.end()
                            }
                        }
                    )
                }
                await t.test(
                    'two service instances recover one marked row without dispatching or touching unmarked schedules',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        const h = await fixture(db)
                        const other = createDb(url)
                        const release = barrier(),
                            both = barrier()
                        const waiting: Promise<void>[] = []
                        try {
                            const source = await h.readAutomation()
                            const controls = [
                                {
                                    ...source,
                                    id: createObjectId('automation'),
                                    nextRunAt: new Date('2026-05-01T00:00:00Z')
                                },
                                {
                                    ...source,
                                    id: createObjectId('automation'),
                                    dtstart: new Date('2026-08-01T00:00:00Z'),
                                    nextRunAt: new Date('2026-08-01T00:00:00Z')
                                }
                            ]
                            await db.insert(automations).values(controls)
                            await h.tick()
                            st.mock.timers.setTime(restoredAt.getTime())
                            await db
                                .update(users)
                                .set({ planId: h.expandedPlanId })
                                .where(eq(users.id, h.userId))
                            const access = h.makeAccess(other)
                            const second = new AutomationsService(
                                other,
                                h.chat as never,
                                { get: () => 'false' } as never,
                                access
                            )
                            let arrivals = 0
                            for (const service of [h.runtimeAccess, access]) {
                                const reserve =
                                    service.reserveAutomationRun.bind(service)
                                service.reserveAutomationRun = async (id) => {
                                    await reserve(id)
                                    if (++arrivals === 2) both.resolve()
                                    await release.promise
                                }
                            }
                            waiting.push(
                                h.tick(),
                                (
                                    second as unknown as {
                                        tick: () => Promise<void>
                                    }
                                ).tick()
                            )
                            await both.promise
                            release.resolve()
                            await Promise.all(waiting)
                            const recovered = await h.readAutomation()
                            assert.equal(recovered.quotaRetryAt, null)
                            assert.equal(
                                recovered.nextRunAt?.toISOString(),
                                nextNatural.toISOString()
                            )
                            assert.equal(h.sent.length, 0)
                            assert.equal(
                                (
                                    await db
                                        .select()
                                        .from(automationRuns)
                                        .where(
                                            eq(automationRuns.userId, h.userId)
                                        )
                                ).length,
                                1
                            )
                            for (const expected of controls) {
                                const [current] = await db
                                    .select()
                                    .from(automations)
                                    .where(eq(automations.id, expected.id))
                                assert.equal(
                                    current.nextRunAt?.toISOString(),
                                    expected.nextRunAt.toISOString()
                                )
                                assert.equal(
                                    current.updatedAt.toISOString(),
                                    expected.updatedAt.toISOString()
                                )
                                assert.equal(current.quotaRetryAt, null)
                            }
                        } finally {
                            release.resolve()
                            await Promise.all(waiting)
                            await h.close()
                            await (
                                other as unknown as {
                                    $client: { end: () => Promise<void> }
                                }
                            ).$client.end()
                        }
                    }
                )
                for (const operation of ['update', 'pause', 'delete']) {
                    await t.test(
                        `${operation} clears the quota marker`,
                        async (st) => {
                            st.mock.timers.enable({
                                apis: ['Date'],
                                now: exhaustedAt.getTime()
                            })
                            const h = await fixture(db)
                            try {
                                await h.tick()
                                assert.ok(
                                    (await h.readAutomation()).quotaRetryAt
                                )
                                if (operation === 'delete')
                                    await h.scheduler.delete(
                                        h.userId,
                                        h.automationId
                                    )
                                else
                                    await h.scheduler.update(
                                        h.userId,
                                        h.automationId,
                                        operation === 'pause'
                                            ? { status: 'paused' }
                                            : { title: 'updated fixture' }
                                    )
                                assert.equal(
                                    (await h.readAutomation()).quotaRetryAt,
                                    null
                                )
                            } finally {
                                await h.close()
                            }
                        }
                    )
                }
                await t.test(
                    'a skipped one-shot with no future occurrence is never backfilled',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        const h = await fixture(db)
                        try {
                            await db
                                .update(automations)
                                .set({
                                    rrule: 'RRULE:FREQ=DAILY;COUNT=1',
                                    dtstart: new Date('2026-04-10T09:00:00Z')
                                })
                                .where(eq(automations.id, h.automationId))
                            await h.tick()
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 60_000
                            )
                            await h.tick()
                            const row = await h.readAutomation()
                            assert.equal(row.nextRunAt, null)
                            assert.equal(row.quotaRetryAt, null)
                            assert.equal(h.sent.length, 0)
                        } finally {
                            await h.close()
                        }
                    }
                )
            } finally {
                await (
                    db as unknown as { $client: { end: () => Promise<void> } }
                ).$client.end()
            }
        })
    }
)
