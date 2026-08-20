import assert from 'node:assert/strict'
import test from 'node:test'

import {
    adminDatabaseName,
    assertManagedTarget,
    assertScratchDatabaseName,
    inheritedAuditScratchUrl,
    SCRATCH_PREFIX,
    scratchDatabaseName,
    scratchDatabaseUrl,
    validateScratchAdminEnv,
    withScratchDatabase,
    type ScratchSql
} from '../scripts/scratch-db'

// #722's destructive retention harness creates and drops a database of its own
// every run, so its guards and its cleanup are the safety boundary — not the
// regex sweep in scripts/check-test-safety.mjs, which only sees whether a file
// mentions RUN_PG_E2E. These run in the default suite, with a fake client, so
// the boundary is gated on every PR rather than only on the weekly PG audit.
const ADMIN = 'postgres://postgres:postgres@127.0.0.1:55432/postgres'

const withEnv = async (
    env: Record<string, string | undefined>,
    body: () => Promise<void>
): Promise<void> => {
    const previous = Object.fromEntries(
        Object.keys(env).map((key) => [key, process.env[key]])
    )
    Object.assign(process.env, env)
    for (const [key, value] of Object.entries(env))
        if (value === undefined) delete process.env[key]
    try {
        await body()
    } finally {
        for (const [key, value] of Object.entries(previous))
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
    }
}

interface Recorder {
    statements: string[]
    ended: number
    connected: string[]
    operations: string[]
}

const fakeClient = (
    recorder: Recorder,
    failCreate?: Error
): ((url: string) => ScratchSql) => {
    return (url: string): ScratchSql => {
        recorder.connected.push(url)
        recorder.operations.push(`connect:${url}`)
        return {
            unsafe: async (statement: string): Promise<unknown> => {
                recorder.statements.push(statement)
                recorder.operations.push(`sql:${statement}`)
                if (failCreate && statement.startsWith('CREATE DATABASE'))
                    throw failCreate
                return []
            },
            end: async (): Promise<void> => {
                recorder.ended += 1
                recorder.operations.push('end')
            }
        }
    }
}

const recorder = (): Recorder => ({
    statements: [],
    ended: 0,
    connected: [],
    operations: []
})

test('the scratch guard requires an explicit marker and a loopback admin URL', () => {
    assert.equal(
        validateScratchAdminEnv({
            PG_TEST_SCRATCH: '1',
            PG_TEST_ADMIN_URL: ADMIN
        }).hostname,
        '127.0.0.1'
    )
    assert.throws(
        () => validateScratchAdminEnv({ PG_TEST_ADMIN_URL: ADMIN }),
        /PG_TEST_SCRATCH=1/
    )
    assert.throws(
        () => validateScratchAdminEnv({ PG_TEST_SCRATCH: '1' }),
        /PG_TEST_ADMIN_URL is required/
    )
    assert.throws(
        () =>
            validateScratchAdminEnv({
                PG_TEST_SCRATCH: '1',
                PG_TEST_ADMIN_URL: 'postgres://postgres@db.example.com/postgres'
            }),
        /loopback host/
    )
    assert.throws(
        () =>
            validateScratchAdminEnv({
                PG_TEST_SCRATCH: '1',
                PG_TEST_ADMIN_URL: 'postgres://postgres@[::1]:5432/postgres'
            }),
        /loopback host/
    )
    assert.throws(
        () =>
            validateScratchAdminEnv({
                PG_TEST_SCRATCH: '1',
                PG_TEST_ADMIN_URL: 'mysql://root@127.0.0.1/postgres'
            }),
        /postgres:\/\//
    )
    assert.throws(
        () =>
            validateScratchAdminEnv({
                PG_TEST_SCRATCH: '1',
                PG_TEST_ADMIN_URL: 'not a url'
            }),
        /valid PostgreSQL URL/
    )
})

test('no crafted name can widen the databases CREATE and DROP are given', () => {
    // The shared workspace database, the maintenance database and a statement
    // break are all the same failure: a name the prefix does not anchor.
    for (const hostile of [
        'nca',
        'postgres',
        'template1',
        'manyfold_pgtest',
        'manyfold_PGTEST_ret_1',
        'manyfold_pgtest_ret_1"; DROP DATABASE nca; --',
        'manyfold_pgtest_ret_1; drop database nca',
        `${SCRATCH_PREFIX}${'x'.repeat(64)}`
    ])
        assert.throws(
            () => assertScratchDatabaseName(hostile),
            /refusing to manage database/,
            hostile
        )

    const longest = `${SCRATCH_PREFIX}${'x'.repeat(63 - SCRATCH_PREFIX.length)}`
    assert.equal(assertScratchDatabaseName(longest), longest)
    assert.throws(
        () => assertScratchDatabaseName(`${longest}x`),
        /exceeds 63 bytes/
    )

    const name = scratchDatabaseName('ret')
    assert.equal(assertScratchDatabaseName(name), name)
    assert.match(name, /^manyfold_pgtest_ret_[0-9]+_[0-9a-f]{12}$/)
    assert.notEqual(name, scratchDatabaseName('ret'))
})

test('an inherited neighbour must be the exact audit database on the admin authority', () => {
    const name = 'manyfold_pgtest_audit_42_aabbccddeeff'
    const safe = `postgres://postgres:postgres@127.0.0.1:55432/${name}`
    const env = {
        PG_TEST_SCRATCH: '1',
        PG_TEST_ADMIN_URL: ADMIN,
        DATABASE_URL: safe
    }
    assert.equal(inheritedAuditScratchUrl(env), safe)
    assert.equal(
        inheritedAuditScratchUrl({
            ...env,
            PG_TEST_ADMIN_URL:
                'postgresql://postgres:postgres@127.0.0.1:55432/postgres',
            DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:55432/${name}`
        }),
        `postgresql://postgres:postgres@127.0.0.1:55432/${name}`
    )

    for (const unrelated of [
        `postgres://postgres:postgres@db.example.com:55432/${name}`,
        `postgres://postgres:postgres@127.0.0.1:6432/${name}`,
        `postgres://other:postgres@127.0.0.1:55432/${name}`,
        `postgres://postgres:other@127.0.0.1:55432/${name}`,
        `postgres://postgres:postgres@localhost:55432/${name}`,
        `${safe}?application_name=unrelated`,
        'postgres://postgres:postgres@127.0.0.1:55432/manyfold_pgtest_ret_42_aabbccddeeff',
        'postgres://postgres:postgres@127.0.0.1:55432/manyfold_pgtest_audit',
        'postgres://postgres:postgres@127.0.0.1:55432/%6danyfold_pgtest_audit_42_aabbccddeeff'
    ])
        assert.equal(
            inheritedAuditScratchUrl({ ...env, DATABASE_URL: unrelated }),
            null,
            unrelated
        )
})

test('the admin connection can never be asked to drop its own database', () => {
    const nested = new URL(
        'postgres://postgres:postgres@127.0.0.1:55432/manyfold_pgtest_audit_7_aabbccddeeff'
    )
    assert.equal(
        adminDatabaseName(nested),
        'manyfold_pgtest_audit_7_aabbccddeeff'
    )
    assert.throws(
        () => assertManagedTarget(nested, adminDatabaseName(nested)),
        /admin connection's own database/
    )
    const child = scratchDatabaseName('ret')
    assert.equal(assertManagedTarget(nested, child), child)
    assert.equal(
        scratchDatabaseUrl(nested, child),
        `postgres://postgres:postgres@127.0.0.1:55432/${child}`
    )
})

test('the lifecycle creates, migrates, runs and drops in that order', async () => {
    const rec = recorder()
    await withEnv(
        { PG_TEST_SCRATCH: '1', PG_TEST_ADMIN_URL: ADMIN },
        async () => {
            const name = await withScratchDatabase(
                'ret',
                async (target) => {
                    rec.operations.push('body')
                    return target.name
                },
                {
                    connect: fakeClient(rec),
                    migrate: async (url) => {
                        rec.operations.push(`migrate:${url}`)
                    }
                }
            )
            assert.deepEqual(
                rec.connected,
                [ADMIN],
                'admin connection, not the target'
            )
            assert.deepEqual(rec.statements, [
                `CREATE DATABASE "${name}"`,
                `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`
            ])
            assert.deepEqual(rec.operations, [
                `connect:${ADMIN}`,
                `sql:CREATE DATABASE "${name}"`,
                `migrate:postgres://postgres:postgres@127.0.0.1:55432/${name}`,
                'body',
                `sql:DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
                'end'
            ])
            assert.equal(rec.ended, 1, 'the admin connection is released last')
        }
    )
})

test('a failing body, migration or construction still drops the database', async () => {
    await withEnv(
        { PG_TEST_SCRATCH: '1', PG_TEST_ADMIN_URL: ADMIN },
        async () => {
            for (const failing of ['body', 'migrate'] as const) {
                const rec = recorder()
                const boom = new Error(`${failing} failed`)
                await assert.rejects(
                    withScratchDatabase(
                        'ret',
                        async () => {
                            if (failing === 'body') throw boom
                        },
                        {
                            connect: fakeClient(rec),
                            migrate: async () => {
                                if (failing === 'migrate') throw boom
                            }
                        }
                    ),
                    (err: unknown) => err === boom
                )
                assert.equal(rec.statements.length, 2, failing)
                assert.match(
                    rec.statements[1],
                    /^DROP DATABASE IF EXISTS "/,
                    failing
                )
                assert.match(rec.statements[1], /WITH \(FORCE\)$/, failing)
                assert.equal(rec.ended, 1, failing)
            }
        }
    )
})

test('cleanup failures do not hide the original body failure', async () => {
    const rec = recorder()
    const bodyFailure = new Error('body failed')
    const dropFailure = new Error('drop failed')
    const endFailure = new Error('end failed')
    await withEnv(
        { PG_TEST_SCRATCH: '1', PG_TEST_ADMIN_URL: ADMIN },
        async () => {
            await assert.rejects(
                withScratchDatabase(
                    'ret',
                    async () => {
                        throw bodyFailure
                    },
                    {
                        connect: (url) => {
                            rec.connected.push(url)
                            rec.operations.push(`connect:${url}`)
                            return {
                                unsafe: async (statement) => {
                                    rec.statements.push(statement)
                                    rec.operations.push(`sql:${statement}`)
                                    if (statement.startsWith('DROP DATABASE'))
                                        throw dropFailure
                                    return []
                                },
                                end: async () => {
                                    rec.ended += 1
                                    rec.operations.push('end')
                                    throw endFailure
                                }
                            }
                        },
                        migrate: async () => {}
                    }
                ),
                (error: unknown) => {
                    assert.ok(error instanceof AggregateError)
                    assert.deepEqual(error.errors, [
                        bodyFailure,
                        dropFailure,
                        endFailure
                    ])
                    assert.match(
                        error.message,
                        /body failed; drop failed; end failed/
                    )
                    return true
                }
            )
        }
    )
    assert.equal(rec.statements.length, 2)
    assert.equal(rec.ended, 1)
})

test('a database this run did not create is never dropped', async () => {
    const rec = recorder()
    const clash = new Error('database already exists')
    await withEnv(
        { PG_TEST_SCRATCH: '1', PG_TEST_ADMIN_URL: ADMIN },
        async () => {
            await assert.rejects(
                withScratchDatabase(
                    'ret',
                    async () => {
                        throw new Error('body must not run')
                    },
                    {
                        connect: fakeClient(rec, clash),
                        migrate: async () => {
                            throw new Error('migrate must not run')
                        }
                    }
                ),
                (err: unknown) => err === clash
            )
        }
    )
    assert.equal(rec.statements.length, 1, 'the failed CREATE and nothing else')
    assert.equal(rec.ended, 1)
})

test('the lifecycle refuses to run at all without the scratch marker', async () => {
    const rec = recorder()
    await withEnv(
        { PG_TEST_SCRATCH: undefined, PG_TEST_ADMIN_URL: ADMIN },
        async () => {
            await assert.rejects(
                withScratchDatabase('ret', async () => {}, {
                    connect: fakeClient(rec),
                    migrate: async () => {}
                }),
                /PG_TEST_SCRATCH=1/
            )
        }
    )
    assert.deepEqual(rec.connected, [], 'no connection is opened')
    assert.deepEqual(rec.statements, [])
})
