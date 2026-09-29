import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, frameworkModelCatalog } from '@manyfold/db'
import {
    builtInFrameworkModelCatalog,
    frameworkModelCatalogRows
} from '@manyfold/shared'
import { and, eq } from 'drizzle-orm'
import { withScratchDatabase } from '../scripts/scratch-db'
import {
    readFrameworkCatalogRows,
    syncFrameworkCatalog
} from '../src/modules/framework-catalog/framework-catalog-sync'

const RUN = process.env.RUN_PG_E2E === '1'

// The scratch database is migrated through src/db/migrate.ts, so it has been
// through the release step's catalog pass before the test body runs.
test(
    'the release step leaves the built-in catalog in place and repairs a drifted row',
    { skip: !RUN },
    async () => {
        await withScratchDatabase('catalog_sync', async ({ url }) => {
            const db = createDb(url, { max: 2 })
            try {
                const desired = frameworkModelCatalogRows(
                    builtInFrameworkModelCatalog
                )
                const rows = await readFrameworkCatalogRows(db)
                for (const want of desired.models) {
                    const row = rows.models.find(
                        (candidate) =>
                            candidate.framework === want.framework &&
                            candidate.modelKey === want.modelKey
                    )
                    assert.ok(row, `${want.framework} ${want.modelKey} missing`)
                    assert.deepEqual(
                        [row.isActive, row.isDefault, row.sortOrder],
                        [want.isActive, want.isDefault, want.sortOrder],
                        `${want.framework} ${want.modelKey}`
                    )
                }
                assert.deepEqual(
                    (await syncFrameworkCatalog(db, desired)).changes,
                    []
                )

                await db.insert(frameworkModelCatalog).values({
                    id: 'fmc_admin_row',
                    framework: 'codex',
                    modelKey: 'operator-model',
                    kind: 'model',
                    displayName: 'Operator model',
                    capabilities: {},
                    sortOrder: 5,
                    isActive: true,
                    isDefault: false
                })
                const gpt6Sol = and(
                    eq(frameworkModelCatalog.framework, 'codex'),
                    eq(frameworkModelCatalog.modelKey, 'gpt-6-sol')
                )
                await db
                    .update(frameworkModelCatalog)
                    .set({ isActive: false })
                    .where(gpt6Sol)

                assert.deepEqual(
                    (await syncFrameworkCatalog(db, desired)).changes,
                    ['~ model codex gpt-6-sol: isActive false → true']
                )
                const [admin] = await db
                    .select()
                    .from(frameworkModelCatalog)
                    .where(eq(frameworkModelCatalog.id, 'fmc_admin_row'))
                assert.deepEqual(
                    [admin?.isActive, admin?.sortOrder, admin?.displayName],
                    [true, 5, 'Operator model']
                )
            } finally {
                await db.$client.end({ timeout: 5 })
            }
        })
    }
)
