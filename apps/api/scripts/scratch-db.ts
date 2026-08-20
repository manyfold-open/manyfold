import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'

export const SCRATCH_PREFIX = 'manyfold_pgtest_'

// Postgres truncates identifiers at NAMEDATALEN-1 and truncation is silent, so
// a name that overflows would be CREATEd under one spelling and DROPped under
// another — the leak this lifecycle exists to prevent.
const MAX_IDENTIFIER_BYTES = 63

const loopbackHosts = new Set(['localhost', '127.0.0.1'])

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

export interface ScratchSql {
    unsafe: (statement: string) => Promise<unknown>
    end: () => Promise<void>
}

export interface ScratchDeps {
    connect?: (url: string) => ScratchSql
    migrate?: (url: string) => Promise<void>
    log?: (message: string) => void
}

export interface ScratchDatabase {
    name: string
    url: string
}

export function validateScratchAdminEnv(env: NodeJS.ProcessEnv): URL {
    if (env.PG_TEST_SCRATCH !== '1')
        throw new Error(
            'PG_TEST_SCRATCH=1 is required because this command creates and drops a database'
        )

    if (!env.PG_TEST_ADMIN_URL) throw new Error('PG_TEST_ADMIN_URL is required')

    let url: URL
    try {
        url = new URL(env.PG_TEST_ADMIN_URL)
    } catch {
        throw new Error('PG_TEST_ADMIN_URL must be a valid PostgreSQL URL')
    }

    if (!['postgres:', 'postgresql:'].includes(url.protocol))
        throw new Error(
            'PG_TEST_ADMIN_URL must use postgres:// or postgresql://'
        )
    if (!loopbackHosts.has(url.hostname))
        throw new Error('PG_TEST_ADMIN_URL must target a loopback host')

    return url
}

// The only name CREATE/DROP are ever given. Anchored on the prefix and closed
// to [a-z0-9_], so no url-supplied or interpolated value can widen the DROP
// into a quote break, a second statement or a neighbouring database.
export function assertScratchDatabaseName(name: string): string {
    if (!name.startsWith(SCRATCH_PREFIX))
        throw new Error(
            `refusing to manage database ${JSON.stringify(name)}: name must start with ${SCRATCH_PREFIX}`
        )
    if (!/^[a-z0-9_]+$/.test(name))
        throw new Error(
            `refusing to manage database ${JSON.stringify(name)}: name must match /^[a-z0-9_]+$/`
        )
    if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES)
        throw new Error(
            `refusing to manage database ${JSON.stringify(name)}: name exceeds ${MAX_IDENTIFIER_BYTES} bytes`
        )
    return name
}

// Unique per call, not per process: node --test runs files as concurrent child
// processes and one process can hold several scratch databases at once, so a
// pid or a clock reading alone is not a unique name.
export function scratchDatabaseName(role: string): string {
    return assertScratchDatabaseName(
        `${SCRATCH_PREFIX}${role}_${process.pid}_${randomBytes(6).toString('hex')}`
    )
}

export function scratchDatabaseUrl(admin: URL, name: string): string {
    const url = new URL(admin)
    url.pathname = `/${assertScratchDatabaseName(name)}`
    return url.toString()
}

// The database the admin connection itself is attached to. DROP DATABASE
// cannot target it, and a nested caller may attach the admin connection to an
// outer scratch database other suites still use, so it is refused by name
// rather than left to the randomness in scratchDatabaseName().
export function adminDatabaseName(admin: URL): string {
    return admin.pathname.replace(/^\//, '')
}

export function assertManagedTarget(admin: URL, name: string): string {
    assertScratchDatabaseName(name)
    if (name === adminDatabaseName(admin))
        throw new Error(
            `refusing to manage database ${JSON.stringify(name)}: it is the admin connection's own database`
        )
    return name
}

const auditScratchNamePattern = /^manyfold_pgtest_audit_[0-9]+_[0-9a-f]{12}$/

export function inheritedAuditScratchUrl(
    env: NodeJS.ProcessEnv
): string | null {
    const inherited = env.DATABASE_URL
    if (!inherited) return null

    let candidate: URL
    try {
        candidate = new URL(inherited)
    } catch {
        return null
    }

    const name = adminDatabaseName(candidate)
    try {
        assertScratchDatabaseName(name)
    } catch {
        return null
    }
    if (!auditScratchNamePattern.test(name)) return null

    const admin = validateScratchAdminEnv(env)
    const expected = new URL(scratchDatabaseUrl(admin, name))
    for (const field of [
        'protocol',
        'username',
        'password',
        'hostname',
        'port',
        'pathname',
        'search',
        'hash'
    ] as const)
        if (candidate[field] !== expected[field]) return null
    return candidate.toString()
}

const spawnMigrate = (url: string): void => {
    // The private tree migrates through the CLOUD entrypoint (its pg suite
    // covers commercial tables, which only exist after the cloud journal
    // runs); the open-source tree has only the core entrypoint. Presence of
    // the cloud workspace decides, like every other edition seam.
    const cloudDir = join(process.cwd(), '..', 'api-cloud')
    const entryDir = existsSync(cloudDir) ? cloudDir : process.cwd()
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/db/migrate.ts'],
        {
            cwd: entryDir,
            env: {
                ...process.env,
                DATABASE_URL: url,
                // Scratch database + this checkout = the fleet runs the
                // switch by definition; the §4.2 contract journal opts in.
                // (No-op through the core entrypoint.)
                MF_CONTRACT_MIGRATIONS: 'apply'
            },
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024
        }
    )
    if (result.error) throw result.error
    if (result.status !== 0)
        throw new Error(
            `${entryDir} src/db/migrate.ts exited with ${result.status ?? 'no status'}: ${result.stderr ?? ''}`
        )
}

// Creates a migrated throwaway database, hands it to `body`, and drops it —
// on success, on an assertion failure, and on a failure inside body's own
// construction, which is the path a fixture insert or a service constructor
// takes. Ordering is load-bearing: body's own clients are closed by body, the
// drop uses WITH (FORCE) so a connection body leaked cannot pin the database,
// and the admin connection is the last thing released. A create that failed
// drops nothing: the name may belong to a database this call did not make. If
// cleanup also fails, the original failure remains first in an AggregateError.
export async function withScratchDatabase<T>(
    role: string,
    body: (database: ScratchDatabase) => Promise<T>,
    deps: ScratchDeps = {}
): Promise<T> {
    const admin = validateScratchAdminEnv(process.env)
    const name = assertManagedTarget(admin, scratchDatabaseName(role))

    const connect = deps.connect ?? ((url) => postgres(url, { max: 1 }))
    const migrate =
        deps.migrate ??
        (async (url: string): Promise<void> => {
            spawnMigrate(url)
        })
    const log = deps.log ?? ((): void => {})

    const sql = connect(admin.toString())
    let created = false
    let result!: T
    const errors: unknown[] = []
    try {
        await sql.unsafe(`CREATE DATABASE "${assertScratchDatabaseName(name)}"`)
        created = true
        log(`Created scratch database ${name}`)
        const url = scratchDatabaseUrl(admin, name)
        await migrate(url)
        result = await body({ name, url })
    } catch (error) {
        errors.push(error)
    }

    if (created) {
        try {
            await sql.unsafe(
                `DROP DATABASE IF EXISTS "${assertScratchDatabaseName(name)}" WITH (FORCE)`
            )
            log(`Dropped scratch database ${name}`)
        } catch (error) {
            errors.push(error)
        }
    }

    try {
        await sql.end()
    } catch (error) {
        errors.push(error)
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
        throw new AggregateError(
            errors,
            `scratch database lifecycle failed: ${errors.map(errorText).join('; ')}`
        )
    return result
}
