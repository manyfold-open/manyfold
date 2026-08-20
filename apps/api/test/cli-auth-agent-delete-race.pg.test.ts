import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    agentRuntimes,
    agents,
    cliAuthSessions,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ApiTokenService } from '../src/modules/auth/api-token.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import { CliAuthService } from '../src/modules/auth/cli-auth.service'

// CliAuthService.start() preflights the requested agent with a SELECT, then
// INSERTs a cli_auth_sessions row whose requested_agent_id FKs that agent. An
// agent deleted between those two statements turns the INSERT into a real
// PostgreSQL 23503, which start() has to map to the same 404 the preflight
// would have produced. The in-memory FakeDb suite
// (cli-auth.service.grant.test.ts) only ever reaches the preflight branch — no
// fake raises 23503 — so the catch-side mapping is proved here and nowhere
// else. Env-gated like the other PostgreSQL suites: run with
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

// A test-only view of the real Database that lets the harness act in the gap
// between the preflight SELECT resolving and the INSERT being issued. Only
// `select` is wrapped; every other member — `insert` above all — is the
// untouched driver, so the failing INSERT is a real one against real
// PostgreSQL rather than anything this file simulates.
const afterFirstSelect = (
    db: Database,
    hook: (rows: unknown[]) => Promise<void>
): Database => {
    let armed = true

    const wrapChain = (node: object): object =>
        new Proxy(node, {
            get(target, prop) {
                const value = Reflect.get(target, prop, target)
                if (typeof value !== 'function') return value
                const fn = value as (...args: unknown[]) => unknown
                // Drizzle builders are thenable: awaiting one is what actually
                // runs the statement, so `then` is the join point.
                if (prop !== 'then')
                    return (...args: unknown[]) => {
                        const result = fn.apply(target, args)
                        return result !== null && typeof result === 'object'
                            ? wrapChain(result as object)
                            : result
                    }
                return (
                    onFulfilled?: ((rows: unknown[]) => unknown) | null,
                    onRejected?: ((err: unknown) => unknown) | null
                ) =>
                    (
                        fn.call(target, (rows: unknown[]) => rows) as Promise<
                            unknown[]
                        >
                    )
                        .then(async (rows) => {
                            if (armed) {
                                armed = false
                                await hook(rows)
                            }
                            return rows
                        })
                        .then(onFulfilled, onRejected)
            }
        })

    return new Proxy(db, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target)
            if (typeof value !== 'function') return value
            const fn = value as (...args: unknown[]) => unknown
            if (prop !== 'select') return fn.bind(target)
            return (...args: unknown[]) =>
                wrapChain(fn.apply(target, args) as object)
        }
    })
}

interface Harness {
    db: Database
    deleter: Database
    suffix: string
    agentId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const suffix = randomBytes(8).toString('hex')
    // Two independent pools. The service writes through `db`; the interleaved
    // DELETE commits on `deleter`. Deleting on the service's own connection
    // would prove nothing about a concurrent writer.
    const db = createDb(url, {
        max: 1,
        applicationName: `cli-auth-race-service-${suffix}`
    })
    const deleter = createDb(url, {
        max: 1,
        applicationName: `cli-auth-race-deleter-${suffix}`
    })
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agent_pgtest_${suffix}`

    try {
        await db
            .insert(users)
            .values({ id: userId, email: `${suffix}@pgtest.local` })
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId,
            name: `pgtest-runtime-${suffix}`,
            framework: 'claude-code',
            kind: 'sprites'
        })
        await db.insert(agents).values({
            id: agentId,
            userId,
            name: 'pgtest-agent',
            framework: 'claude-code',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${agentId}`
        })

        return {
            db,
            deleter,
            suffix,
            agentId,
            close: () => closeHarness(db, deleter, userId)
        }
    } catch (error) {
        try {
            await closeHarness(db, deleter, userId)
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'CLI auth race harness setup and cleanup failed'
            )
        }
        throw error
    }
}

const endClient = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const closeHarness = async (
    db: Database,
    deleter: Database,
    userId: string
): Promise<void> => {
    const errors: unknown[] = []
    try {
        // Deleting the user cascades agents and agent_runtimes, and any
        // cli_auth_sessions row cascades from its requested agent.
        await db.delete(users).where(eq(users.id, userId))
    } catch (error) {
        errors.push(error)
    }

    const closed = await Promise.allSettled([endClient(db), endClient(deleter)])
    for (const result of closed)
        if (result.status === 'rejected') errors.push(result.reason)

    if (errors.length > 0)
        throw new AggregateError(errors, 'CLI auth race harness cleanup failed')
}

const cliAuth = (db: Database): CliAuthService =>
    new CliAuthService(
        db,
        new ConfigService({ MF_WEB_URL: 'https://web.test' }),
        new ApiTokenService(db),
        new CliAuthRateLimitService()
    )

test('start maps a real 23503 to 404 when the agent is deleted between preflight and insert', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        const seen: { preflight: unknown[] | null; deleted: number } = {
            preflight: null,
            deleted: 0
        }
        const raced = afterFirstSelect(h.db, async (rows) => {
            seen.preflight = rows
            const gone = await h.deleter
                .delete(agents)
                .where(eq(agents.id, h.agentId))
                .returning({ id: agents.id })
            seen.deleted = gone.length
        })

        await assert.rejects(
            cliAuth(raced).start({
                requestedScopes: ['channels:read'],
                requestedAgentId: h.agentId
            }),
            (err: unknown) => {
                assert.ok(
                    err instanceof NotFoundException,
                    'FK violation must surface as NotFoundException'
                )
                assert.equal(err.getStatus(), 404)
                assert.match(err.message, /requested agent not found/)
                return true
            }
        )

        // Without these two the test would false-green on the preflight 404.
        // The agent was still visible when start() checked it, and the DELETE
        // committed on the other connection before the INSERT ran, so the only
        // route left to a NotFoundException is start()'s `code === '23503'`
        // catch — the rejection above is the mapped FK violation.
        assert.deepEqual(
            seen.preflight,
            [{ id: h.agentId }],
            'preflight SELECT must have observed the agent as existing'
        )
        assert.equal(
            seen.deleted,
            1,
            'the interleaved DELETE must have committed'
        )

        // start() swallows the driver error, so pin the code the mapping keys
        // on by replaying the same insert shape against the same missing agent.
        await assert.rejects(
            h.db.insert(cliAuthSessions).values({
                id: `cli_pgtest_${h.suffix}`,
                userCode: `PGTEST-${h.suffix}`,
                expiresAt: new Date(Date.now() + 60_000),
                requestedAgentId: h.agentId
            }),
            (err: unknown) => (err as { code?: string }).code === '23503'
        )

        const residue = await h.db
            .select({ id: cliAuthSessions.id })
            .from(cliAuthSessions)
            .where(eq(cliAuthSessions.requestedAgentId, h.agentId))
        assert.equal(
            residue.length,
            0,
            'a failed start() must leave no cli_auth_sessions row behind'
        )
    } finally {
        await h.close()
    }
})

test('start persists the grant session when no delete interleaves', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        // Same wrapper, no interleaved DELETE: proves the proxy forwards the
        // real INSERT untouched, so the 404 above is the race and not a
        // harness that quietly broke the write path.
        let observed = -1
        const watched = afterFirstSelect(h.db, async (rows) => {
            observed = rows.length
        })

        const started = await cliAuth(watched).start({
            requestedScopes: ['channels:read'],
            requestedAgentId: h.agentId
        })
        assert.equal(observed, 1, 'preflight SELECT must run through the proxy')

        const [row] = await h.db
            .select({
                id: cliAuthSessions.id,
                requestedAgentId: cliAuthSessions.requestedAgentId
            })
            .from(cliAuthSessions)
            .where(eq(cliAuthSessions.id, started.requestId))
        assert.equal(
            row?.requestedAgentId,
            h.agentId,
            'the proxy must not disturb the real INSERT'
        )
    } finally {
        await h.close()
    }
})
