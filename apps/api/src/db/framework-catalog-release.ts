import { schema } from '@manyfold/db'
import {
    builtInFrameworkModelCatalog,
    frameworkModelCatalogRows
} from '@manyfold/shared'
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { syncFrameworkCatalog } from '../modules/framework-catalog/framework-catalog-sync'
import {
    acquireMigrationMutex,
    releaseMigrationMutex
} from './migration-runner'

// The release step's catalog pass, run by every migrate entrypoint after its
// journals: the model catalog tables are brought in line with
// framework-model-catalog.yaml as built into @manyfold/shared. It holds the
// migration mutex, so two releases racing each other apply it in turn.
export const applyBuiltInFrameworkCatalog = async (
    client: ReturnType<typeof postgres>,
    log: (line: string) => void = console.log
): Promise<void> => {
    await acquireMigrationMutex(client)
    try {
        const plan = await syncFrameworkCatalog(
            drizzle(client, { schema }),
            frameworkModelCatalogRows(builtInFrameworkModelCatalog)
        )
        if (plan.changes.length === 0) log('catalog.apply up to date')
        for (const change of plan.changes) log(`catalog.apply ${change}`)
    } finally {
        await releaseMigrationMutex(client)
    }
}
