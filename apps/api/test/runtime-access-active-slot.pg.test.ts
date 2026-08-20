import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
    createDb,
    plans,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'

// Real-Postgres proof that the active-duration admission write does NOT crash
// postgres-js by binding a raw JS Date into a sql`` fragment.
//
// The bug: reserveActiveSlot opened the metering watermark with
//   activeAccrualSince: sql`coalesce(${runtimeHosts.activeAccrualSince}, ${now})`
// where `now` was a raw JS Date. Drizzle passes sql`` params to postgres-js via
// client.unsafe(); on the describe-first bind path postgres-js does NOT apply its
// Date serializer, so the Date reaches Buffer.byteLength() and throws
//   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
//   string or an instance of Buffer or ArrayBuffer. Received an instance of Date
// reserveActiveSlot is the shared admission path for BOTH a chat turn
// (ExecDriverFactory.forAgent) and an interactive terminal (SpritesTerminal.tunnel),
// so the crash surfaced as a chat SSE `adapter_error` and as `terminal.tunnel_failed`.
// The fix coerces the Date to a ms-precision ISO string with a ::timestamptz cast.
//
// The existing runtime-access.service.test.ts runs against a hand-rolled fake db
// that never serializes params, so it cannot see this class of bug — it only
// reproduces against real Postgres. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
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
    const usage = { userActiveSecondsInPeriod: async () => 0 }
    return new RuntimeAccessService(
        db as never,
        adminSettings as never,
        telemetry as never,
        usage as never
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
        maxAgentsProvisioned: 1,
        maxConcurrentActive: 1,
        maxStorageGb: 1,
        monthlyApiRequestLimit: null
    })
    await db.insert(users).values({
        id: userId,
        email: `${suffix}@pgtest.local`,
        planId
    })
    // A cold sandbox host with an unopened watermark (activeAccrualSince null),
    // exactly the state a chat/terminal admission finds before reserving a slot.
    await db.insert(runtimeHosts).values({
        id: hostId,
        userId,
        kind: 'sandbox',
        name: `pgtest-sandbox-${suffix}`,
        spriteStatus: 'cold',
        activeAccrualSince: null
    })

    return {
        db,
        service: makeService(db),
        userId,
        planId,
        hostId,
        close: async (): Promise<void> => {
            // runtime_hosts.user_id cascades on user delete.
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(plans).where(eq(plans.id, planId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

// WHY: this is the exact call the failing chat turn and terminal open make. It
// must admit the slot AND open the metering watermark. Before the fix the
// coalesce() write threw ERR_INVALID_ARG_TYPE inside postgres-js and the whole
// admission rejected — which is what the e2e codex-main chat step and the
// TerminalGateway both surfaced.
test(
    'reserveActiveSlot admits and opens the watermark without crashing on a JS Date',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const before = Date.now()
            const result = await h.service.reserveActiveSlot({
                userId: h.userId,
                hostId: h.hostId
            })
            const after = Date.now()

            assert.equal(result.activeCount, 0)

            const [row] = await h.db
                .select({
                    spriteStatus: runtimeHosts.spriteStatus,
                    activeAccrualSince: runtimeHosts.activeAccrualSince
                })
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, h.hostId))
                .limit(1)

            assert.equal(row.spriteStatus, 'running')
            assert.ok(
                row.activeAccrualSince instanceof Date,
                'watermark must be opened'
            )
            // The watermark is stamped from the admission's own JS Date, at
            // ms precision (the column is timestamp precision 3).
            const stamped = row.activeAccrualSince.getTime()
            assert.ok(
                stamped >= before && stamped <= after,
                `watermark ${stamped} not within [${before}, ${after}]`
            )

            // coalesce keeps an already-open interval intact: a second admission
            // must not move the watermark.
            await h.service.reserveActiveSlot({
                userId: h.userId,
                hostId: h.hostId
            })
            const [again] = await h.db
                .select({ activeAccrualSince: runtimeHosts.activeAccrualSince })
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, h.hostId))
                .limit(1)
            assert.equal(again.activeAccrualSince?.getTime(), stamped)
        } finally {
            await h.close()
        }
    }
)

// WHY: documents the shared root cause behind all three coerced sites
// (runtime-access reserveActiveSlot, sprite-status-sync running transition,
// users billingForUsers). A raw JS Date bound into a Drizzle sql`` fragment
// crashes postgres-js in Buffer.byteLength; the ms-precision ISO string cast to
// ::timestamptz round-trips losslessly. If a future edit drops `.toISOString()`
// the first assertion is the canary.
test(
    'a raw JS Date in a Drizzle sql`` fragment crashes; ms-ISO ::timestamptz does not',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const now = new Date()
            await assert.rejects(
                () =>
                    h.db.execute(
                        sql`select coalesce(null::timestamptz, ${now}) as d`
                    ),
                (err: unknown) => {
                    const message = (err as Error).message
                    assert.match(message, /Received an instance of Date/)
                    return true
                }
            )

            const rows = (await h.db.execute(
                sql`select coalesce(null::timestamptz, ${now.toISOString()}::timestamptz) as d`
            )) as unknown as Array<{ d: string | Date }>
            const round = new Date(rows[0].d as string).getTime()
            assert.equal(round, now.getTime())
        } finally {
            await h.close()
        }
    }
)
