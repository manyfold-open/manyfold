#!/usr/bin/env node
// Editions migration-ownership check (design doc §4.5): the core journal
// must never touch a cloud-owned table, and the cloud journal's DDL must stay
// on cloud-owned tables (data-only statements may additionally touch the
// shared-config allowlist — cloud seeds its own app_settings keys). FK
// direction is one-way: cloud SQL may REFERENCE core tables, core SQL must
// never reference cloud tables. The frozen legacy chain is exempt (history).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CLOUD_TABLE_CONTRACT } from './editions-cloud-tables.mjs'

// §4.1 ownership matrix — pg table names, derived from the shared contract so
// this checker and the ESLint import boundary can never drift (#886).
// Additions to the contract are a contract change: a table's journal decides
// which edition creates it.
export const CLOUD_TABLES = new Set(
    CLOUD_TABLE_CONTRACT.map((entry) => entry.table)
)

// Core tables the cloud journal may write DATA into (never DDL): shared
// config keyed by string, where cloud seeds its own keys.
export const CLOUD_DATA_ALLOWED_CORE_TABLES = new Set(['app_settings'])

const ident = '(?:"([a-z0-9_]+)"|([a-z0-9_]+))'
const captured = (m) => (m[1] ?? m[2]).replace(/^public\./, '')

const PATTERNS = {
    ddl: [
        new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?(?:"public"\\.)?${ident}`, 'gi'),
        new RegExp(`ALTER TABLE (?:ONLY )?(?:"public"\\.)?${ident}`, 'gi'),
        new RegExp(`DROP TABLE (?:IF EXISTS )?(?:"public"\\.)?${ident}`, 'gi'),
        new RegExp(`CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?"?[a-z0-9_]+"? ON (?:"public"\\.)?${ident}`, 'gi')
    ],
    data: [
        new RegExp(`INSERT INTO (?:public\\.|"public"\\.)?${ident}`, 'gi'),
        new RegExp(`UPDATE (?:ONLY )?(?:public\\.|"public"\\.)?${ident} SET`, 'gi'),
        new RegExp(`DELETE FROM (?:public\\.|"public"\\.)?${ident}`, 'gi')
    ],
    reference: [new RegExp(`REFERENCES (?:"public"\\.)?${ident}`, 'gi')]
}

const collect = (sql, regexes) => {
    const names = []
    for (const re of regexes) {
        re.lastIndex = 0
        for (const m of sql.matchAll(re)) names.push(captured(m))
    }
    return names
}

export const checkJournal = (dir, kind) => {
    const problems = []
    if (!existsSync(dir)) return [`${dir}: journal directory missing`]
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        const sql = readFileSync(join(dir, file), 'utf8')
        const ddl = collect(sql, PATTERNS.ddl)
        const data = collect(sql, PATTERNS.data)
        const refs = collect(sql, PATTERNS.reference)
        if (kind === 'core') {
            for (const t of [...ddl, ...data])
                if (CLOUD_TABLES.has(t))
                    problems.push(`${file}: core journal touches cloud table "${t}"`)
            for (const t of refs)
                if (CLOUD_TABLES.has(t))
                    problems.push(`${file}: core journal declares FK into cloud table "${t}"`)
        } else {
            for (const t of ddl)
                if (!CLOUD_TABLES.has(t))
                    problems.push(`${file}: cloud journal runs DDL on non-cloud table "${t}"`)
            for (const t of data)
                if (!CLOUD_TABLES.has(t) && !CLOUD_DATA_ALLOWED_CORE_TABLES.has(t))
                    problems.push(`${file}: cloud journal writes data into core table "${t}"`)
        }
    }
    return problems
}

const main = () => {
    // The contract/cloud journals ride the private composition; a tree
    // without them (the open-source edition) has nothing to check there.
    // The core journal stays required everywhere.
    const optional = (dir, kind) =>
        existsSync(dir) ? checkJournal(dir, kind) : []
    const problems = [
        ...checkJournal('apps/api/drizzle', 'core'),
        ...optional('apps/api/drizzle-contract', 'core'),
        ...optional('apps/api-cloud/drizzle-cloud', 'cloud')
    ]
    if (problems.length > 0) {
        for (const p of problems) console.error(`migration-ownership: ${p}`)
        process.exit(1)
    }
    console.log('migration-ownership: core and cloud journals respect the §4.1 boundary')
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main()
