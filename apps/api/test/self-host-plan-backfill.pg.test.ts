import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { appSettings, auditLogs, createDb, plans, users } from '@manyfold/db'
import { auditAction } from '@manyfold/shared'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import {
    SELF_HOST_PLAN_BACKFILL_SETTING_KEY,
    SelfHostPlanBackfillService
} from '@/modules/self-host-plan-backfill/self-host-plan-backfill.service'
import { UsersService } from '@/modules/users/users.service'

// #876's exact upgrade fixture: a self-host database whose account was created
// before MF_DEFAULT_PLAN_ID existed, so it sits on 'free' and no migration,
// login or admin route ever moves it. The claim/idempotence semantics are a
// real INSERT ... ON CONFLICT DO NOTHING inside a transaction, which a fake db
// cannot honestly model. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
//
// Everything runs inside one transaction that is always rolled back, and the
// services take that tx as their db (drizzle turns their own transaction into
// a savepoint). Suffixed ids are not enough here the way they are elsewhere:
// the backfill is deliberately unfiltered, so a committed run would move every
// other 'free' account in the database — including ones a pg test file running
// in parallel just seeded.
const RUN = process.env.RUN_PG_E2E === '1'

const ROLLBACK = Symbol('rollback')

const selfHostConfig = (planId?: string): never =>
    ({ get: () => planId }) as unknown as never

type Tx = Parameters<Parameters<ReturnType<typeof createDb>['transaction']>[0]>[0]

const inRolledBackTx = async (
    url: string,
    body: (tx: Tx) => Promise<void>
): Promise<void> => {
    const db = createDb(url)
    try {
        await db
            .transaction(async (tx) => {
                await body(tx)
                throw ROLLBACK
            })
            .catch((err: unknown) => {
                if (err !== ROLLBACK) throw err
            })
    } finally {
        const client = (
            db as unknown as { $client?: { end?: () => Promise<void> } }
        ).$client
        if (client?.end) await client.end()
    }
}

test(
    'self-host plan backfill moves pre-existing free accounts exactly once (#876)',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')
        const suffix = randomBytes(8).toString('hex')
        const legacyId = `user_pgtest_legacy_${suffix}`
        const deliberateId = `user_pgtest_deliberate_${suffix}`

        await inRolledBackTx(url, async (tx) => {
            const service = new SelfHostPlanBackfillService(
                tx as never,
                selfHostConfig('self_hosted'),
                new CapabilitiesRegistry()
            )

            const [target] = await tx
                .select({ id: plans.id })
                .from(plans)
                .where(eq(plans.id, 'self_hosted'))
                .limit(1)
            assert.ok(target, "the 'self_hosted' plan must be seeded")

            // A database that has already been backfilled would answer
            // 'already-applied' on the first run. Undoing the marker is safe
            // because this whole transaction is rolled back.
            await tx
                .delete(appSettings)
                .where(eq(appSettings.key, SELF_HOST_PLAN_BACKFILL_SETTING_KEY))

            // The pre-#871 account: created while the deployment default was
            // still 'free', so nothing has moved it since.
            await tx.insert(users).values({
                id: legacyId,
                email: `${legacyId}@example.com`,
                planId: 'free'
            })

            const first = await service.run()
            assert.equal(first.applied, true, 'the first run must apply')
            assert.ok(
                first.applied && first.movedUserIds.includes(legacyId),
                'the pre-existing free account must move'
            )

            const [moved] = await tx
                .select({ planId: users.planId })
                .from(users)
                .where(eq(users.id, legacyId))
                .limit(1)
            assert.equal(moved?.planId, 'self_hosted')

            // Idempotence: a restart must not re-run, and an operator's later
            // deliberate 'free' assignment must survive it.
            await tx.insert(users).values({
                id: deliberateId,
                email: `${deliberateId}@example.com`,
                planId: 'free'
            })
            const second = await service.run()
            assert.deepEqual(second, {
                applied: false,
                reason: 'already-applied'
            })

            const [untouched] = await tx
                .select({ planId: users.planId })
                .from(users)
                .where(eq(users.id, deliberateId))
                .limit(1)
            assert.equal(
                untouched?.planId,
                'free',
                'a deliberate free assignment made after the backfill must stand'
            )
        })
    }
)

// The durable half of the recovery path: whatever the backfill did or didn't
// do at boot, an admin has to be able to move one account by hand. Nothing in
// the open-source composition root could before this.
test(
    'admin plan assignment moves one account and audits it (#876)',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')
        const suffix = randomBytes(8).toString('hex')
        const targetId = `user_pgtest_target_${suffix}`
        const adminId = `user_pgtest_admin_${suffix}`

        await inRolledBackTx(url, async (tx) => {
            const service = new UsersService(
                tx as never,
                new CapabilitiesRegistry()
            )
            await tx.insert(users).values(
                [targetId, adminId].map((id) => ({
                    id,
                    email: `${id}@example.com`,
                    planId: 'free'
                }))
            )

            const summary = await service.setPlan(
                targetId,
                adminId,
                'self_hosted'
            )
            assert.equal(summary.planId, 'self_hosted')
            assert.equal(summary.planName, 'Self-hosted')

            const [row] = await tx
                .select({ planId: users.planId })
                .from(users)
                .where(eq(users.id, targetId))
                .limit(1)
            assert.equal(row?.planId, 'self_hosted')

            const [entry] = await tx
                .select({ meta: auditLogs.meta })
                .from(auditLogs)
                .where(
                    and(
                        eq(auditLogs.actorId, adminId),
                        eq(auditLogs.action, auditAction.USER_PLAN_UPDATED)
                    )
                )
                .limit(1)
            assert.deepEqual(entry?.meta, {
                previousPlanId: 'free',
                planId: 'self_hosted'
            })

            // A plan id with no row would otherwise surface as a raw FK error.
            await assert.rejects(
                service.setPlan(targetId, adminId, `nope_${suffix}`),
                (err: unknown) => err instanceof BadRequestException
            )
        })
    }
)
