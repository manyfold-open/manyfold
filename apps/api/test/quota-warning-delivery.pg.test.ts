import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { automationRuns, channels, createDb, plans, users } from '@manyfold/db'
import {
    apiPaths,
    createObjectId,
    type QuotaWarningEvent
} from '@manyfold/shared'
import {
    calendarUsagePeriodPort,
    type UsagePeriodPort
} from '../src/common/ports/usage-period.ports'
import { withScratchDatabase } from '../scripts/scratch-db'
import { exhaustedAt } from './helpers/quota-fixture'
import { deferred, withDeliveryFixture } from './helpers/quota-delivery-fixture'

test(
    'quota receipts cross real instances and retain authenticated, current-policy delivery semantics',
    {
        skip: process.env.RUN_PG_E2E !== '1',
        timeout: 30_000
    },
    async (t) => {
        await withScratchDatabase('quota_delivery', async ({ url }) => {
            const first = createDb(url),
                second = createDb(url)
            try {
                await t.test(
                    'real HTTP AuthGuard permits own human/full ACK and rejects narrow/runtime or other-user receipts',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        await withDeliveryFixture(first, second, async (h) => {
                            const [warning] =
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            assert.ok(warning.receiptId)
                            const post = (token: string, body: unknown) =>
                                fetch(
                                    `${h.api.baseUrl}${apiPaths.ME_RUNTIME_ACCESS_QUOTA_WARNING_ACK}`,
                                    {
                                        method: 'POST',
                                        headers: {
                                            authorization: `Bearer ${token}`,
                                            'content-type': 'application/json'
                                        },
                                        body: JSON.stringify(body)
                                    }
                                )
                            for (const token of ['narrow', 'runtime']) {
                                const res = await post(token, {
                                    receiptId: warning.receiptId
                                })
                                assert.equal(res.status, 401)
                                await res.body?.cancel()
                                const stream = await fetch(
                                    `${h.api.baseUrl}${apiPaths.AGENT_SPRITE_STATUS_STREAM}`,
                                    {
                                        headers: {
                                            authorization: `Bearer ${token}`
                                        }
                                    }
                                )
                                assert.equal(stream.status, 401)
                                await stream.body?.cancel()
                            }
                            assert.deepEqual(
                                await h
                                    .client('other')
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        warning.receiptId
                                    ),
                                { acknowledged: false }
                            )
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                {}
                            )
                            const accepted = await post('full', {
                                receiptId: warning.receiptId,
                                userId: 'not-authority',
                                usage: 0,
                                limit: 0,
                                plan: 'not-authority'
                            })
                            assert.equal(accepted.status, 200)
                            assert.deepEqual(await accepted.json(), {
                                acknowledged: true
                            })
                            const stamp = (await h.readUser())
                                .lastQuotaWarningsAt
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 60_000
                            )
                            assert.deepEqual(
                                await h
                                    .client('human')
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        warning.receiptId
                                    ),
                                { acknowledged: false }
                            )
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                stamp
                            )
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 25 * 60 * 60_000
                            )
                            const [next] =
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            assert.notEqual(next.receiptId, warning.receiptId)
                            assert.deepEqual(
                                await h
                                    .client('human')
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        next.receiptId
                                    ),
                                { acknowledged: true }
                            )
                            assert.deepEqual(h.api.failures, [])
                        })
                    }
                )
                await t.test(
                    'a remote subscriber ACKs PG NOTIFY delivery while an absent subscriber leaves the stamp untouched',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        await withDeliveryFixture(first, second, async (h) => {
                            const dropped = deferred()
                            h.busB.onEvent((userId, event) => {
                                if (
                                    userId === h.userId &&
                                    event.type === 'quota-warning'
                                )
                                    dropped.resolve()
                            })
                            await h.tickWarnings()
                            await dropped.promise
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                {}
                            )
                            const received = deferred<QuotaWarningEvent>(),
                                acked = deferred()
                            const ack = h.accessB.acknowledgeQuotaWarning.bind(
                                h.accessB
                            )
                            h.accessB.acknowledgeQuotaWarning = async (
                                ...args
                            ) => {
                                const accepted = await ack(...args)
                                if (accepted) acked.resolve()
                                return accepted
                            }
                            const { errors } = await h.subscribe((event) =>
                                received.resolve(event)
                            )
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 60_000
                            )
                            await h.tickWarnings()
                            const warning = await received.promise
                            await acked.promise
                            assert.equal(warning.code, 'automation_runs')
                            assert.equal(warning.usage, 1)
                            assert.ok(warning.receiptId)
                            const delivered = (await h.readUser())
                                .lastQuotaWarningsAt
                            assert.equal(
                                delivered.automation_runs,
                                new Date().toISOString()
                            )
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 120_000
                            )
                            await h.tickWarnings()
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                delivered
                            )
                            assert.deepEqual(errors, [])
                            assert.deepEqual(h.api.failures, [])
                        })
                    }
                )
                await t.test(
                    'offline pending warnings are retired after recovery instead of replaying stale payloads',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        await withDeliveryFixture(first, second, async (h) => {
                            await h.tick()
                            assert.ok((await h.readAutomation()).quotaRetryAt)
                            await h.runtimeAccess.evaluateQuotaThresholds(
                                h.userId
                            )
                            assert.ok(
                                (await h.readUser()).pendingQuotaWarnings
                                    .automation_runs
                            )
                            await first
                                .update(users)
                                .set({ planId: h.expandedPlanId })
                                .where(eq(users.id, h.userId))
                            const events: QuotaWarningEvent[] = []
                            await h.subscribe((event) => {
                                events.push(event)
                            })
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 60_000
                            )
                            await h.tick()
                            const recovered = await h.readAutomation()
                            assert.equal(recovered.quotaRetryAt, null)
                            assert.equal(
                                recovered.nextRunAt?.toISOString(),
                                '2026-04-10T10:00:00.000Z'
                            )
                            assert.deepEqual(h.sent, [])
                            await h.tickWarnings()
                            assert.deepEqual(
                                (await h.readUser()).pendingQuotaWarnings,
                                {}
                            )
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                {}
                            )
                            assert.deepEqual(events, [])
                        })
                    }
                )
                for (const change of ['plan', 'limit', 'period']) {
                    await t.test(
                        `receipt received before ${change} change cannot burn a stamp when ACK is admitted afterward`,
                        async (st) => {
                            const before = new Date('2026-04-30T23:59:00Z')
                            st.mock.timers.enable({
                                apis: ['Date'],
                                now: before.getTime()
                            })
                            await withDeliveryFixture(
                                first,
                                second,
                                async (h) => {
                                    const entering = deferred(),
                                        release = deferred(),
                                        finished = deferred<boolean>()
                                    const ack =
                                        h.accessB.acknowledgeQuotaWarning.bind(
                                            h.accessB
                                        )
                                    h.accessB.acknowledgeQuotaWarning = async (
                                        ...args
                                    ) => {
                                        entering.resolve()
                                        await release.promise
                                        const accepted = await ack(...args)
                                        finished.resolve(accepted)
                                        return accepted
                                    }
                                    try {
                                        await h.subscribe(() => {})
                                        await h.tickWarnings()
                                        await entering.promise
                                        if (change === 'plan')
                                            await first
                                                .update(users)
                                                .set({
                                                    planId: h.expandedPlanId
                                                })
                                                .where(eq(users.id, h.userId))
                                        else if (change === 'limit')
                                            await first
                                                .update(plans)
                                                .set({
                                                    maxAutomationRunsMonthly: 100
                                                })
                                                .where(eq(plans.id, h.planId))
                                        else
                                            st.mock.timers.setTime(
                                                before.getTime() + 120_000
                                            )
                                        release.resolve()
                                        assert.equal(
                                            await finished.promise,
                                            false
                                        )
                                        assert.deepEqual(
                                            (await h.readUser())
                                                .lastQuotaWarningsAt,
                                            {}
                                        )
                                        assert.deepEqual(
                                            (await h.readUser())
                                                .pendingQuotaWarnings,
                                            {}
                                        )
                                        assert.deepEqual(h.api.failures, [])
                                    } finally {
                                        release.resolve()
                                    }
                                }
                            )
                        }
                    )
                }
                await t.test(
                    'a changed limit rotates a receipt even when the current threshold is still due',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        await withDeliveryFixture(first, second, async (h) => {
                            await first
                                .update(plans)
                                .set({ maxChannels: 1 })
                                .where(eq(plans.id, h.planId))
                            await first
                                .insert(channels)
                                .values({
                                    id: createObjectId('channel'),
                                    userId: h.userId,
                                    agentId: h.agentId,
                                    provider: 'fake',
                                    label: 'fixture',
                                    configJson: {}
                                })
                            const old = (
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            ).find((item) => item.code === 'channels')!
                            await first
                                .update(plans)
                                .set({ maxChannels: 2 })
                                .where(eq(plans.id, h.planId))
                            assert.deepEqual(
                                await h
                                    .client()
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        old.receiptId
                                    ),
                                { acknowledged: false }
                            )
                            const fresh = (
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            ).find((item) => item.code === 'channels')!
                            assert.equal(fresh.usage, 1)
                            assert.equal(fresh.limit, 2)
                            assert.notEqual(fresh.receiptId, old.receiptId)
                            assert.deepEqual(
                                await h
                                    .client()
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        old.receiptId
                                    ),
                                { acknowledged: false }
                            )
                            assert.equal(
                                (await h.readUser()).pendingQuotaWarnings
                                    .channels?.receiptId,
                                fresh.receiptId
                            )
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                {}
                            )
                        })
                    }
                )
                await t.test(
                    'pending receipts expire and evaluation retains only supported current codes',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        await withDeliveryFixture(first, second, async (h) => {
                            const [old] =
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            await first.execute(
                                sql`update users set pending_quota_warnings = pending_quota_warnings || ${JSON.stringify({ unknown_fixture_code: { receiptId: createObjectId('quotaWarningReceipt'), policyKey: 'fixture', createdAt: exhaustedAt.toISOString() } })}::jsonb where id = ${h.userId}`
                            )
                            st.mock.timers.setTime(
                                exhaustedAt.getTime() + 24 * 60 * 60_000
                            )
                            const [fresh] =
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            assert.notEqual(fresh.receiptId, old.receiptId)
                            const pending = (await h.readUser())
                                .pendingQuotaWarnings
                            assert.deepEqual(Object.keys(pending), [
                                'automation_runs'
                            ])
                            assert.deepEqual(
                                await h
                                    .client()
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        old.receiptId
                                    ),
                                { acknowledged: false }
                            )
                            assert.equal(
                                (await h.readUser()).pendingQuotaWarnings
                                    .automation_runs?.receiptId,
                                fresh.receiptId
                            )
                            assert.deepEqual(
                                (await h.readUser()).lastQuotaWarningsAt,
                                {}
                            )
                        })
                    }
                )
                await t.test(
                    'ACK reads policy and usage in one repeatable-read snapshot across an overlapping recovery',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        const entered = deferred(),
                            release = deferred()
                        let hold = false
                        const isolations: string[] = []
                        const period: UsagePeriodPort = {
                            ...calendarUsagePeriodPort,
                            resolve: async (db, id, now) => {
                                const rows = await db.execute(
                                    sql`select current_setting('transaction_isolation') as isolation`
                                )
                                isolations.push(String(rows[0].isolation))
                                if (hold) {
                                    entered.resolve()
                                    await release.promise
                                }
                                return calendarUsagePeriodPort.resolve(
                                    db,
                                    id,
                                    now
                                )
                            }
                        }
                        await withDeliveryFixture(
                            first,
                            second,
                            async (h) => {
                                const [warning] =
                                    await h.runtimeAccess.evaluateQuotaThresholds(
                                        h.userId
                                    )
                                hold = true
                                const acknowledging = h
                                    .client()
                                    .runtimeAccess.acknowledgeQuotaWarning(
                                        warning.receiptId
                                    )
                                try {
                                    await entered.promise
                                    await first
                                        .update(plans)
                                        .set({ maxAutomationRunsMonthly: 100 })
                                        .where(eq(plans.id, h.planId))
                                    await first
                                        .delete(automationRuns)
                                        .where(
                                            eq(automationRuns.userId, h.userId)
                                        )
                                    release.resolve()
                                    assert.deepEqual(
                                        await acknowledging,
                                        { acknowledged: true },
                                        'overlapping recovery is ordered after this established snapshot'
                                    )
                                    assert.ok(isolations.length >= 2)
                                    assert.ok(
                                        isolations.every(
                                            (value) =>
                                                value === 'repeatable read'
                                        )
                                    )
                                    assert.equal(
                                        (await h.readUser()).lastQuotaWarningsAt
                                            .automation_runs,
                                        exhaustedAt.toISOString()
                                    )
                                    hold = false
                                    assert.deepEqual(
                                        await h.runtimeAccess.evaluateQuotaThresholds(
                                            h.userId
                                        ),
                                        []
                                    )
                                    assert.deepEqual(h.api.failures, [])
                                } finally {
                                    release.resolve()
                                    await acknowledging.catch(() => {})
                                }
                            },
                            period
                        )
                    }
                )
                await t.test(
                    'two HTTP clients ACK several codes concurrently without 500s, lost stamps or timestamp extension',
                    async (st) => {
                        st.mock.timers.enable({
                            apis: ['Date'],
                            now: exhaustedAt.getTime()
                        })
                        await withDeliveryFixture(first, second, async (h) => {
                            await first
                                .update(plans)
                                .set({ maxChannels: 2, maxAutomations: 2 })
                                .where(eq(plans.id, h.planId))
                            await first
                                .insert(channels)
                                .values({
                                    id: createObjectId('channel'),
                                    userId: h.userId,
                                    agentId: h.agentId,
                                    provider: 'fake',
                                    label: 'fixture',
                                    configJson: {}
                                })
                            const warnings =
                                await h.runtimeAccess.evaluateQuotaThresholds(
                                    h.userId
                                )
                            assert.equal(warnings.length, 3)
                            const release = deferred(),
                                started = deferred()
                            let starts = 0,
                                conflicts = 0
                            const restore: Array<() => void> = []
                            for (const db of [first, second]) {
                                const original = db.transaction
                                db.transaction = (async (
                                    ...args: Parameters<typeof db.transaction>
                                ) => {
                                    const [body, options] = args
                                    try {
                                        return await original.call(
                                            db,
                                            async (tx) => {
                                                const rows = await tx.execute(
                                                    sql`select current_setting('transaction_isolation') as isolation, pg_current_snapshot()::text as snapshot`
                                                )
                                                assert.equal(
                                                    rows[0].isolation,
                                                    'repeatable read'
                                                )
                                                if (++starts === 6)
                                                    started.resolve()
                                                await release.promise
                                                return body(tx)
                                            },
                                            options
                                        )
                                    } catch (error) {
                                        const failure = error as {
                                            code?: string
                                            cause?: { code?: string }
                                        }
                                        if (
                                            failure.code === '40001' ||
                                            failure.cause?.code === '40001'
                                        )
                                            conflicts++
                                        throw error
                                    }
                                }) as typeof db.transaction
                                restore.push(() => {
                                    db.transaction = original
                                })
                            }
                            const a = h.client('human', 'first'),
                                b = h.client('full', 'second')
                            const requests = warnings.flatMap((warning) => [
                                a.runtimeAccess.acknowledgeQuotaWarning(
                                    warning.receiptId
                                ),
                                b.runtimeAccess.acknowledgeQuotaWarning(
                                    warning.receiptId
                                )
                            ])
                            try {
                                await Promise.race([
                                    started.promise,
                                    Promise.all(requests).then(() => {
                                        throw new Error(
                                            'ACKs ended before the snapshot barrier'
                                        )
                                    })
                                ])
                                release.resolve()
                                const outcomes = await Promise.all(requests)
                                assert.ok(
                                    conflicts > 0,
                                    'actual PostgreSQL serialization conflicts were exercised'
                                )
                                assert.equal(
                                    outcomes.filter((item) => item.acknowledged)
                                        .length,
                                    3
                                )
                                const stamps = (await h.readUser())
                                    .lastQuotaWarningsAt
                                assert.equal(Object.keys(stamps).length, 3)
                                assert.ok(
                                    Object.values(stamps).every(
                                        (value) =>
                                            value === exhaustedAt.toISOString()
                                    )
                                )
                                assert.deepEqual(
                                    (await h.readUser()).pendingQuotaWarnings,
                                    {}
                                )
                                st.mock.timers.setTime(
                                    exhaustedAt.getTime() + 60_000
                                )
                                for (const warning of warnings)
                                    assert.deepEqual(
                                        await b.runtimeAccess.acknowledgeQuotaWarning(
                                            warning.receiptId
                                        ),
                                        { acknowledged: false }
                                    )
                                assert.deepEqual(
                                    (await h.readUser()).lastQuotaWarningsAt,
                                    stamps
                                )
                                assert.deepEqual(h.api.failures, [])
                                assert.deepEqual(h.apiA.failures, [])
                            } finally {
                                release.resolve()
                                await Promise.allSettled(requests)
                                for (const undo of restore) undo()
                            }
                        })
                    }
                )
            } finally {
                await (
                    first as unknown as {
                        $client: { end: () => Promise<void> }
                    }
                ).$client.end()
                await (
                    second as unknown as {
                        $client: { end: () => Promise<void> }
                    }
                ).$client.end()
            }
        })
    }
)
