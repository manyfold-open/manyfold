import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import test from 'node:test'
import { desc, eq } from 'drizzle-orm'
import { appSettings, auditLogs, createDb } from '@manyfold/db'
import { auditAction } from '@manyfold/shared'
import { A2A_TURN_TIMEOUTS_SETTING_KEY } from '@/modules/admin-settings/admin-settings.service'
import { A2aTimeoutEnvMigrationService } from '@/modules/a2a-timeout-env-migration/a2a-timeout-env-migration.service'

// The claim semantics are a real INSERT ... ON CONFLICT DO NOTHING, which a
// fake db cannot honestly model. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
//
// Everything runs inside one transaction that is always rolled back, because
// the setting row is a database-wide singleton: a committed run would decide
// a2a timeouts for every other pg test file in the run.
const RUN = process.env.RUN_PG_E2E === '1'

const ROLLBACK = Symbol('rollback')

const config = (value?: string): never =>
    ({ get: () => value }) as unknown as never

const settingsSpy = (): { calls: number; fake: never } => {
    const state = { calls: 0 }
    return {
        get calls() {
            return state.calls
        },
        fake: {
            invalidateA2aTurnTimeoutsCache: () => {
                state.calls += 1
            }
        } as never
    }
}

type Tx = Parameters<
    Parameters<ReturnType<typeof createDb>['transaction']>[0]
>[0]

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

const readRow = async (tx: Tx): Promise<Record<string, unknown> | null> => {
    const [row] = await tx
        .select({ valueJson: appSettings.valueJson })
        .from(appSettings)
        .where(eq(appSettings.key, A2A_TURN_TIMEOUTS_SETTING_KEY))
        .limit(1)
    return row?.valueJson ?? null
}

test(
    'env migration writes the setting row exactly once and audits it',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')

        await inRolledBackTx(url, async (tx) => {
            await tx
                .delete(appSettings)
                .where(eq(appSettings.key, A2A_TURN_TIMEOUTS_SETTING_KEY))

            const spy = settingsSpy()
            const service = new A2aTimeoutEnvMigrationService(
                tx as never,
                config('300000'),
                spy.fake
            )

            const first = await service.run()
            assert.deepEqual(first, {
                applied: true,
                blockingTimeoutSeconds: 300,
                asyncTimeoutSeconds: 300,
                clamped: false
            })
            assert.equal(spy.calls, 1, 'the cached null must be dropped')
            assert.deepEqual(await readRow(tx), {
                blockingTimeoutSeconds: 300,
                asyncTimeoutSeconds: 300
            })

            const [entry] = await tx
                .select({ meta: auditLogs.meta })
                .from(auditLogs)
                .where(
                    eq(
                        auditLogs.action,
                        auditAction.A2A_TURN_TIMEOUTS_ENV_MIGRATED
                    )
                )
                .orderBy(desc(auditLogs.createdAt))
                .limit(1)
            assert.deepEqual(entry?.meta, {
                envMs: 300000,
                blockingTimeoutSeconds: 300,
                asyncTimeoutSeconds: 300
            })

            // A restart with the env var still set must not touch the row.
            const second = await service.run()
            assert.deepEqual(second, { applied: false, reason: 'row-exists' })
            assert.equal(spy.calls, 1)
        })
    }
)

test(
    "env migration never clobbers an admin's saved setting",
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')

        await inRolledBackTx(url, async (tx) => {
            const adminSaved = {
                blockingTimeoutSeconds: 90,
                asyncTimeoutSeconds: 180
            }
            await tx
                .insert(appSettings)
                .values({
                    key: A2A_TURN_TIMEOUTS_SETTING_KEY,
                    valueJson: adminSaved
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: { valueJson: adminSaved }
                })

            const spy = settingsSpy()
            const service = new A2aTimeoutEnvMigrationService(
                tx as never,
                config('300000'),
                spy.fake
            )
            assert.deepEqual(await service.run(), {
                applied: false,
                reason: 'row-exists'
            })
            assert.equal(spy.calls, 0)
            assert.deepEqual(await readRow(tx), adminSaved)
        })
    }
)

test(
    'out-of-range env values are clamped to the setting bounds, ceiling first',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')

        // env 10s sits below the 30s floor; env 2h sits above the 1h blocking
        // cap but inside the async cap; 100ms must round UP to a whole second.
        const cases = [
            {
                env: '10000',
                expect: {
                    blockingTimeoutSeconds: 30,
                    asyncTimeoutSeconds: 30
                }
            },
            {
                env: '7200000',
                expect: {
                    blockingTimeoutSeconds: 3600,
                    asyncTimeoutSeconds: 7200
                }
            },
            {
                env: '100',
                expect: {
                    blockingTimeoutSeconds: 30,
                    asyncTimeoutSeconds: 30
                }
            }
        ]
        for (const { env, expect } of cases) {
            await inRolledBackTx(url, async (tx) => {                await tx
                    .delete(appSettings)
                    .where(eq(appSettings.key, A2A_TURN_TIMEOUTS_SETTING_KEY))
                const spy = settingsSpy()
                const service = new A2aTimeoutEnvMigrationService(
                    tx as never,
                    config(env),
                    spy.fake
                )
                const result = await service.run()
                assert.equal(result.applied, true, `env=${env} must apply`)
                assert.ok(result.applied && result.clamped)
                assert.deepEqual(await readRow(tx), expect, `env=${env}`)
            })
        }
    }
)
