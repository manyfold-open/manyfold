import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, eq, sql, sum } from 'drizzle-orm'
import {
    createDb,
    runtimeHosts,
    sandboxActiveDurationDays,
    users,
    type Database
} from '@manyfold/db'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import type { UsagePeriod } from '@/common/usage-period/usage-period'

// Real-Postgres proofs for the active-duration meter. The CAS-no-double-count and
// the ON CONFLICT increment are Postgres semantics a fake can't honestly model.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const T0 = Date.UTC(2026, 5, 15, 10, 0, 0)
const DAY = '2026-06-15'
const JUNE: UsagePeriod = {
    start: new Date(Date.UTC(2026, 5, 1)),
    end: new Date(Date.UTC(2026, 6, 1)),
    source: 'calendar'
}

interface Harness {
    db: Database
    svc: SandboxActiveDurationService
    userId: string
    hostId: string
    close: () => Promise<void>
}

const buildHarness = async (accrualSince: Date | null): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const hostId = `sbx_pgtest_${suffix}`
    await db.insert(users).values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(runtimeHosts).values({
        id: hostId,
        userId,
        name: `pgtest-sandbox-${suffix}`,
        kind: 'sandbox',
        activeAccrualSince: accrualSince
    })
    return {
        db,
        svc: new SandboxActiveDurationService(db as never),
        userId,
        hostId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const ledgerSeconds = async (h: Harness, day = DAY): Promise<number> => {
    const [row] = await h.db
        .select({ s: sandboxActiveDurationDays.activeSeconds })
        .from(sandboxActiveDurationDays)
        .where(
            and(
                eq(sandboxActiveDurationDays.hostId, h.hostId),
                eq(sandboxActiveDurationDays.day, day)
            )
        )
    return row?.s ?? 0
}

const watermark = async (h: Harness): Promise<Date | null> => {
    const [row] = await h.db
        .select({ since: runtimeHosts.activeAccrualSince })
        .from(runtimeHosts)
        .where(eq(runtimeHosts.id, h.hostId))
        .limit(1)
    return row?.since ?? null
}

// WHY: with several API instances sampling the same host, a naive
// active_seconds += delta would credit N×. The watermark CAS must let exactly
// one writer claim [since, now); the rest see the moved watermark and skip.
test(
    'concurrent accrue credits the interval exactly once (CAS, no double-count)',
    { skip: !RUN },
    async () => {
        const h = await buildHarness(new Date(T0))
        try {
            const host = {
                id: h.hostId,
                userId: h.userId,
                activeAccrualSince: new Date(T0)
            }
            const now = new Date(T0 + 10_000)
            await Promise.all([
                h.svc.accrue(host, false, now),
                h.svc.accrue(host, false, now),
                h.svc.accrue(host, false, now)
            ])
            assert.equal(await ledgerSeconds(h), 10)
            assert.equal(await watermark(h), null)
        } finally {
            await h.close()
        }
    }
)

// WHY: hosts get reaped/deleted, but the user's period usage must not drop when
// that happens mid-period — host_id is a bare column (no cascade) and user_id is
// denormalized precisely so the rollup survives host deletion.
test(
    'user period rollup survives host deletion',
    { skip: !RUN },
    async () => {
        const h = await buildHarness(new Date(T0))
        try {
            await h.svc.settleHostNotRunning(
                h.hostId,
                h.userId,
                new Date(T0 + 30_000)
            )
            assert.equal(
                await h.svc.userActiveSecondsInPeriod(h.userId, JUNE),
                30
            )
            await h.db
                .delete(runtimeHosts)
                .where(eq(runtimeHosts.id, h.hostId))
            assert.equal(
                await h.svc.userActiveSecondsInPeriod(h.userId, JUNE),
                30
            )
        } finally {
            await h.close()
        }
    }
)

// WHY: explicit delete / teardown / reaper clear or drop the host row; without a
// settle the final running interval is silently lost. settle must credit it and
// null the watermark before the row goes away.
test(
    'settleHostNotRunning credits the final interval and clears the watermark',
    { skip: !RUN },
    async () => {
        const h = await buildHarness(new Date(T0))
        try {
            await h.svc.settleHostNotRunning(
                h.hostId,
                h.userId,
                new Date(T0 + 45_000)
            )
            assert.equal(await ledgerSeconds(h), 45)
            assert.equal(await watermark(h), null)
            // idempotent: a second settle with no open watermark is a no-op
            await h.svc.settleHostNotRunning(
                h.hostId,
                h.userId,
                new Date(T0 + 90_000)
            )
            assert.equal(await ledgerSeconds(h), 45)
        } finally {
            await h.close()
        }
    }
)

// WHY: an interval across UTC midnight must land in BOTH day buckets — a
// billing period whose day window starts on the second day would otherwise
// see the wrong share of the split.
test(
    'settle across UTC midnight writes both day buckets',
    { skip: !RUN },
    async () => {
        const since = new Date(Date.UTC(2026, 5, 15, 23, 59, 30))
        const h = await buildHarness(since)
        try {
            await h.svc.settleHostNotRunning(
                h.hostId,
                h.userId,
                new Date(Date.UTC(2026, 5, 16, 0, 0, 20))
            )
            assert.equal(await ledgerSeconds(h, '2026-06-15'), 30)
            assert.equal(await ledgerSeconds(h, '2026-06-16'), 20)
        } finally {
            await h.close()
        }
    }
)

// WHY: this is the whole point of day buckets — a mid-month billing window
// (subscription anchored on the 12th) must sum exactly the days inside
// [startDay, endDay) and ignore usage before the period began.
test(
    'userActiveSecondsInPeriod sums only the day buckets inside the window',
    { skip: !RUN },
    async () => {
        const h = await buildHarness(null)
        try {
            const seed = async (day: string, seconds: number): Promise<void> => {
                await h.db.insert(sandboxActiveDurationDays).values({
                    hostId: h.hostId,
                    userId: h.userId,
                    day,
                    activeSeconds: seconds
                })
            }
            await seed('2026-06-10', 100)
            await seed('2026-06-15', 50)
            await seed('2026-07-02', 25)
            const period: UsagePeriod = {
                start: new Date(Date.UTC(2026, 5, 12, 15, 0, 0)),
                end: new Date(Date.UTC(2026, 6, 12, 15, 0, 0)),
                source: 'subscription'
            }
            assert.equal(
                await h.svc.userActiveSecondsInPeriod(h.userId, period),
                75
            )
        } finally {
            await h.close()
        }
    }
)

// WHY: reserveActiveSlot once opened the watermark with SQL now() (µs). The CAS
// compares the column against a JS Date (ms), and a µs value can never equal a
// ms param — the watermark wedged forever and the host silently stopped
// metering (prod accrued 40s in a month). The column is timestamptz(3) exactly
// so that ANY writer — including raw now() — is rounded to ms at storage. This
// test plants the watermark server-side the way the buggy writer did; on the
// pre-precision schema it fails.
test(
    'settles a watermark opened by raw SQL now() (µs-precision regression)',
    { skip: !RUN },
    async () => {
        const h = await buildHarness(null)
        try {
            await h.db.execute(
                sql`update runtime_hosts set active_accrual_since = now() where id = ${h.hostId}`
            )
            const grain = (await h.db.execute(
                sql`select active_accrual_since = date_trunc('milliseconds', active_accrual_since) as ms from runtime_hosts where id = ${h.hostId}`
            )) as unknown as Array<{ ms: boolean }>
            assert.equal(grain[0]?.ms, true)

            // Re-read the row like syncSandboxHosts does, then observe not-running:
            // the CAS must claim + settle instead of silently missing.
            const since = await watermark(h)
            assert.ok(since)
            await h.svc.accrue(
                { id: h.hostId, userId: h.userId, activeAccrualSince: since },
                false,
                new Date(since.getTime() + 10_000)
            )
            assert.equal(await watermark(h), null)
            // The watermark is a real timestamp, so read the whole ledger rather
            // than a fixed day bucket.
            const [total] = await h.db
                .select({ s: sum(sandboxActiveDurationDays.activeSeconds) })
                .from(sandboxActiveDurationDays)
                .where(eq(sandboxActiveDurationDays.hostId, h.hostId))
            assert.equal(Number(total?.s ?? 0), 10)
        } finally {
            await h.close()
        }
    }
)
