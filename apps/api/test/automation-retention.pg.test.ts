import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, count, eq, inArray, isNull, lte } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    automationRuns,
    automations,
    createDb,
    plans,
    users,
    type Database
} from '@manyfold/db'
import { AutomationsService } from '../src/modules/automations/automations.service'
import { AutomationRetentionService } from '../src/modules/automations/automation-retention.service'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'

// Real-Postgres proof of the #588 two-phase deletion lifecycle: the tombstone
// keeps the automation and its runs queryable, every product surface filter
// excludes it (list/get/due-scan/slot count), the purge sweep removes only
// rows past the retention cutoff and cascades their runs, and user/agent
// hard-deletes still cascade immediately (the deliberate privacy exception).
// Env-gated; run per-file:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/automation-retention.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const DAY_MS = 24 * 60 * 60 * 1000

interface Harness {
    db: Database
    service: AutomationsService
    sweep: (retentionDays: number) => AutomationRetentionService
    ids: Record<string, string>
    close: () => Promise<void>
}

const RRULE = 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const sfx = randomBytes(8).toString('hex')
    const ids: Record<string, string> = {
        plan: `plan_pgtest_${sfx}`,
        user: `user_pgtest_${sfx}`,
        runtime: `art_pgtest_${sfx}`,
        agent: `agt_pgtest_${sfx}`,
        agentDoomed: `agt_pgtest_doom_${sfx}`,
        autoLive: `atm_pgtest_live_${sfx}`,
        autoDeleted: `atm_pgtest_del_${sfx}`,
        autoExpired: `atm_pgtest_exp_${sfx}`,
        autoOnAgent: `atm_pgtest_agent_${sfx}`,
        runLive: `amr_pgtest_live_${sfx}`,
        runDeleted: `amr_pgtest_del_${sfx}`,
        runExpired: `amr_pgtest_exp_${sfx}`,
        runOnAgent: `amr_pgtest_agent_${sfx}`
    }
    const now = new Date()
    const pastDue = new Date(now.getTime() - 60_000)

    await db.insert(plans).values({
        id: ids.plan,
        name: `pgtest-${sfx}`,
        maxAgentsProvisioned: 3,
        maxConcurrentActive: 1,
        maxStorageGb: 3,
        // 2 live + 2 tombstoned fixtures: reserving a third live slot only
        // succeeds when the count excludes tombstones.
        maxAutomations: 3
    })
    await db.insert(users).values({
        id: ids.user,
        email: `${sfx}@pgtest.local`,
        planId: ids.plan
    })
    await db.insert(agentRuntimes).values({
        id: ids.runtime,
        userId: ids.user,
        name: `pgtest-rt-${sfx}`,
        framework: 'codex',
        kind: 'sprites',
        status: 'ready'
    })
    const agentRows: Array<typeof agents.$inferInsert> = [
        {
            id: ids.agent,
            userId: ids.user,
            name: `pgtest-agent-${sfx}`,
            framework: 'codex',
            runtime: 'sprites',
            status: 'running',
            runtimeId: ids.runtime,
            internalId: `int-${sfx}`
        },
        {
            id: ids.agentDoomed,
            userId: ids.user,
            name: `pgtest-agent-doom-${sfx}`,
            framework: 'codex',
            runtime: 'sprites',
            status: 'running',
            runtimeId: ids.runtime,
            internalId: `int-doom-${sfx}`
        }
    ]
    await db.insert(agents).values(agentRows)
    const automationBase = {
        userId: ids.user,
        agentId: ids.agent,
        prompt: 'pgtest prompt',
        status: 'active' as const,
        schedulePreset: 'daily' as const,
        rrule: RRULE,
        timezone: 'UTC',
        dtstart: now,
        nextRunAt: pastDue
    }
    await db.insert(automations).values([
        { ...automationBase, id: ids.autoLive, title: 'live' },
        {
            ...automationBase,
            id: ids.autoDeleted,
            title: 'tombstoned fresh',
            nextRunAt: null,
            deletedAt: new Date(now.getTime() - 89 * DAY_MS)
        },
        {
            ...automationBase,
            id: ids.autoExpired,
            title: 'tombstoned expired',
            nextRunAt: null,
            deletedAt: new Date(now.getTime() - 91 * DAY_MS)
        },
        {
            ...automationBase,
            id: ids.autoOnAgent,
            agentId: ids.agentDoomed,
            title: 'on doomed agent'
        }
    ])
    const runBase = {
        userId: ids.user,
        agentId: ids.agent,
        trigger: 'scheduled' as const,
        status: 'succeeded' as const,
        titleSnapshot: 'pgtest',
        promptSnapshot: 'pgtest prompt',
        rruleSnapshot: RRULE
    }
    await db.insert(automationRuns).values([
        { ...runBase, id: ids.runLive, automationId: ids.autoLive },
        { ...runBase, id: ids.runDeleted, automationId: ids.autoDeleted },
        { ...runBase, id: ids.runExpired, automationId: ids.autoExpired },
        {
            ...runBase,
            id: ids.runOnAgent,
            automationId: ids.autoOnAgent,
            agentId: ids.agentDoomed
        }
    ])

    const service = new AutomationsService(
        db as never,
        {} as never,
        { get: () => 'false' } as never,
        {
            reserveAutomationSlot: async () => {},
            reserveAutomationRun: async () => {}
        } as never
    )
    const sweep = (retentionDays: number): AutomationRetentionService =>
        new AutomationRetentionService(
            db as never,
            { get: () => undefined } as never,
            {
                getAutomationRetention: async () => ({ retentionDays })
            } as never,
            undefined,
            undefined
        )
    return {
        db,
        service,
        sweep,
        ids,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, ids.user))
            await db.delete(plans).where(eq(plans.id, ids.plan))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

test(
    'tombstoned automations stay queryable but vanish from every product surface',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Direct PostgreSQL access still sees the tombstones and runs.
            const raw = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(eq(automations.userId, h.ids.user))
            assert.equal(raw.length, 4, 'all rows physically present')
            const rawRuns = await h.db
                .select({ id: automationRuns.id })
                .from(automationRuns)
                .where(eq(automationRuns.userId, h.ids.user))
            assert.equal(rawRuns.length, 4, 'all runs physically present')

            // list() and get() exclude the tombstones.
            const listed = await h.service.list(h.ids.user)
            assert.deepEqual(
                listed.map((a) => a.id).sort(),
                [h.ids.autoLive, h.ids.autoOnAgent].sort()
            )
            await assert.rejects(
                h.service.get(h.ids.user, h.ids.autoDeleted),
                /automation not found/
            )

            // The scheduler due-scan predicate skips tombstones even when
            // status/next_run_at would qualify: force a due-looking tombstone
            // and replicate the tick() WHERE restricted to this test's user.
            await h.db
                .update(automations)
                .set({ nextRunAt: new Date(Date.now() - 60_000) })
                .where(eq(automations.id, h.ids.autoDeleted))
            const due = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(
                    and(
                        eq(automations.userId, h.ids.user),
                        eq(automations.status, 'active'),
                        lte(automations.nextRunAt, new Date()),
                        isNull(automations.deletedAt)
                    )
                )
            assert.deepEqual(
                due.map((a) => a.id).sort(),
                [h.ids.autoLive, h.ids.autoOnAgent].sort(),
                'due scan must not surface the tombstone'
            )

            // Plan-slot accounting frees the tombstoned slots immediately.
            const [slotCount] = await h.db
                .select({ value: count() })
                .from(automations)
                .where(
                    and(
                        eq(automations.userId, h.ids.user),
                        isNull(automations.deletedAt)
                    )
                )
            assert.equal(Number(slotCount?.value), 2)
            const runtimeAccess = new RuntimeAccessService(
                h.db as never,
                {} as never,
                {} as never,
                {} as never
            )
            await runtimeAccess.reserveAutomationSlot(h.ids.user)

            // delete() writes the tombstone; the row and its runs survive.
            await h.service.delete(h.ids.user, h.ids.autoLive)
            const [tombstoned] = await h.db
                .select()
                .from(automations)
                .where(eq(automations.id, h.ids.autoLive))
            assert.ok(tombstoned, 'row survives the API delete')
            assert.ok(tombstoned.deletedAt instanceof Date)
            assert.equal(tombstoned.nextRunAt, null)
            const [runAfterDelete] = await h.db
                .select()
                .from(automationRuns)
                .where(eq(automationRuns.id, h.ids.runLive))
            assert.ok(runAfterDelete, 'run history survives the API delete')

            // Deleting an already-deleted automation is a clean 404.
            await assert.rejects(
                h.service.delete(h.ids.user, h.ids.autoLive),
                /automation not found/
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'the purge sweep removes only tombstones past the cutoff and cascades their runs',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const result = await h.sweep(90).runOnce()

            assert.ok(result.purged >= 1, 'the expired tombstone is purged')
            assert.equal(result.failed, 0)
            const remaining = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(eq(automations.userId, h.ids.user))
            const remainingIds = remaining.map((r) => r.id).sort()
            assert.ok(
                !remainingIds.includes(h.ids.autoExpired),
                'expired tombstone hard-deleted'
            )
            assert.ok(
                remainingIds.includes(h.ids.autoDeleted),
                '89-day tombstone survives a 90-day window'
            )
            const runs = await h.db
                .select({ id: automationRuns.id })
                .from(automationRuns)
                .where(
                    inArray(automationRuns.id, [
                        h.ids.runExpired,
                        h.ids.runDeleted,
                        h.ids.runLive
                    ])
                )
            const runIds = runs.map((r) => r.id).sort()
            assert.ok(
                !runIds.includes(h.ids.runExpired),
                'purged automation cascades its runs'
            )
            assert.ok(
                runIds.includes(h.ids.runDeleted),
                'retained tombstone keeps its runs'
            )

            // A shortened window applies to the surviving tombstone on the
            // next sweep — the documented behaviour for setting changes.
            const shortened = await h.sweep(30).runOnce()
            assert.ok(shortened.purged >= 1)
            const afterShorten = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(eq(automations.id, h.ids.autoDeleted))
            assert.equal(afterShorten.length, 0)
        } finally {
            await h.close()
        }
    }
)

test(
    'user erasure hard-deletes automations and runs immediately via FK cascade',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.db.delete(users).where(eq(users.id, h.ids.user))

            const rows = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(eq(automations.userId, h.ids.user))
            assert.equal(rows.length, 0, 'tombstones do not survive erasure')
            const runs = await h.db
                .select({ id: automationRuns.id })
                .from(automationRuns)
                .where(eq(automationRuns.userId, h.ids.user))
            assert.equal(runs.length, 0)
        } finally {
            await h.close()
        }
    }
)

test(
    'agent deletion hard-deletes its automations and runs — the documented exception',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.db.delete(agents).where(eq(agents.id, h.ids.agentDoomed))

            const rows = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(eq(automations.id, h.ids.autoOnAgent))
            assert.equal(rows.length, 0)
            const runs = await h.db
                .select({ id: automationRuns.id })
                .from(automationRuns)
                .where(eq(automationRuns.id, h.ids.runOnAgent))
            assert.equal(runs.length, 0)

            // Automations on the surviving agent are untouched.
            const others = await h.db
                .select({ id: automations.id })
                .from(automations)
                .where(eq(automations.userId, h.ids.user))
            assert.ok(others.length > 0)
        } finally {
            await h.close()
        }
    }
)
