import { readFileSync, writeFileSync } from 'node:fs'
import { schema } from '@manyfold/db'
import {
    builtInFrameworkModelCatalog,
    frameworkModelCatalogRows,
    parseFrameworkModelCatalog,
    type FrameworkModelCatalog
} from '@manyfold/shared'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { Document, parse } from 'yaml'
import {
    catalogDocumentFromRows,
    readFrameworkCatalogRows,
    syncFrameworkCatalog
} from '../modules/framework-catalog/framework-catalog-sync'
import {
    acquireMigrationMutex,
    releaseMigrationMutex
} from './migration-runner'

// Operator tool for the framework model catalog tables (DATABASE_URL):
//   import [--file <catalog.yaml>] [--dry-run]
//     apply a catalog file, by default the one built into this release — the
//     same pass the release step runs; --dry-run prints the changes instead
//   export [--file <catalog.yaml>]
//     write the database's rows as a catalog file that import accepts
// A row a file lists is set to what the file says. The release step reapplies
// the built-in catalog, so a lasting change belongs in
// packages/shared/src/framework-model-catalog.yaml.
const USAGE =
    'usage: framework-catalog import [--file <catalog.yaml>] [--dry-run]\n' +
    '       framework-catalog export [--file <catalog.yaml>]'

interface Args {
    command: 'import' | 'export'
    file: string | null
    dryRun: boolean
}

const parseArgs = (argv: string[]): Args => {
    const [command, ...rest] = argv
    if (command !== 'import' && command !== 'export') throw new Error(USAGE)
    let file: string | null = null
    let dryRun = false
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]
        if (arg === '--file' && rest[i + 1]) file = rest[++i]
        else if (arg === '--dry-run' && command === 'import') dryRun = true
        else throw new Error(`unexpected argument '${arg}'\n${USAGE}`)
    }
    return { command, file, dryRun }
}

const readCatalogFile = (file: string): FrameworkModelCatalog =>
    parseFrameworkModelCatalog(parse(readFileSync(file, 'utf8')))

const run = async (): Promise<void> => {
    const args = parseArgs(process.argv.slice(2))
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')
    const client = postgres(url, { max: 1 })
    try {
        const db = drizzle(client, { schema })
        if (args.command === 'export') {
            const document = new Document(
                catalogDocumentFromRows(await readFrameworkCatalogRows(db))
            )
            document.commentBefore = ` Exported from database ${new URL(url).pathname.slice(1)} at ${new Date().toISOString()}`
            const text = document.toString({ indent: 4 })
            if (args.file) writeFileSync(args.file, text)
            else process.stdout.write(text)
            return
        }
        const catalog = args.file
            ? readCatalogFile(args.file)
            : builtInFrameworkModelCatalog
        await acquireMigrationMutex(client)
        try {
            const plan = await syncFrameworkCatalog(
                db,
                frameworkModelCatalogRows(catalog),
                { dryRun: args.dryRun }
            )
            for (const change of plan.changes) console.log(change)
            console.log(
                plan.changes.length === 0
                    ? 'catalog is up to date'
                    : args.dryRun
                      ? `dry run: ${plan.changes.length} change(s), nothing written`
                      : `applied ${plan.changes.length} change(s)`
            )
        } finally {
            await releaseMigrationMutex(client)
        }
    } finally {
        await client.end()
    }
}

if (require.main === module)
    run().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
