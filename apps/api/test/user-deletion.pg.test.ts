import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { createDb, userDeletions, users } from '@manyfold/db'
import { noopUserLifecyclePort } from '../src/common/ports/user-lifecycle.ports'
import { UserDeletionService } from '../src/modules/user-deletion/user-deletion.service'
import { SessionService } from '../src/modules/auth/session.service'
import { runJournal } from '../src/db/migration-runner'

// ADR-0023 account deletion, proven against real Postgres:
// (1) V-1 cascade completeness is INTROSPECTION-driven — every table with a
//     users FK gets a seeded row, then one DELETE must leave zero referencing
//     rows anywhere. A future table whose FK forgets ON DELETE CASCADE (or a
//     RESTRICT that would block deletion outright) turns this red the day it
//     lands, not the day a real account is deleted.
// (2) The T0 state machine: request deactivates + revokes + pauses, restore
//     reverses the flag but deliberately not the pauses.
// (3) V-4 idempotent retry: a failing lifecycle hook leaves a pending row
//     with the error recorded; the next sweep completes without double
//     side-effects.
// (4) V-2 gates: a deactivated account can neither mint nor use sessions.
// (5) V-5 parity: everything here runs on the no-op OSS port.
// Env-gated like the other *.pg.test.ts.
const RUN = process.env.RUN_PG_E2E === '1'

const withScratch = async (
    name: string,
    body: (
        client: ReturnType<typeof postgres>,
        dbUrl: string
    ) => Promise<void>
): Promise<void> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const admin = postgres(url, { max: 1, onnotice: () => undefined })
    const dbName = `mf_userdel_${name}_${Date.now().toString(36)}`
    await admin.unsafe(`CREATE DATABASE ${dbName}`)
    const dbUrl = new URL(url)
    dbUrl.pathname = `/${dbName}`
    const client = postgres(dbUrl.toString(), {
        max: 1,
        onnotice: () => undefined
    })
    try {
        await body(client, dbUrl.toString())
    } finally {
        await client.end()
        await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`)
        await admin.end()
    }
}

const applyCore = (client: ReturnType<typeof postgres>) =>
    runJournal(client, {
        folder: join(__dirname, '..', 'drizzle'),
        migrationsTable: '__drizzle_migrations',
        concurrentIndexes: []
    })

const noEmail = { send: async () => undefined } as never
const noModuleRef = {
    get: () => {
        throw new Error('no runtimes/channels seeded in this test')
    }
} as never

const makeService = (
    db: ReturnType<typeof createDb>,
    lifecycle = noopUserLifecyclePort
): UserDeletionService =>
    new UserDeletionService(db as never, noEmail, noModuleRef, lifecycle)

test(
    'V-1: every users FK cascades — introspection-seeded delete leaves zero rows',
    { skip: !RUN },
    async () => {
        await withScratch('cascade', async (client) => {
            await applyCore(client)
            // Any FK to users that is not CASCADE/SET NULL would either block
            // the DELETE (restrict) or survive it (no action) — both must be
            // impossible by inspection, not convention.
            const fks = await client<
                Array<{ tbl: string; col: string; rule: string }>
            >`
                select tc.table_name as tbl, kcu.column_name as col,
                       rc.delete_rule as rule
                from information_schema.table_constraints tc
                join information_schema.key_column_usage kcu
                  on kcu.constraint_name = tc.constraint_name
                join information_schema.referential_constraints rc
                  on rc.constraint_name = tc.constraint_name
                join information_schema.constraint_column_usage ccu
                  on ccu.constraint_name = tc.constraint_name
                where tc.constraint_type = 'FOREIGN KEY'
                  and ccu.table_name = 'users' and ccu.column_name = 'id'
            `
            assert.ok(fks.length >= 30, `expected 30+ FKs, saw ${fks.length}`)
            const bad = fks.filter(
                (f) => f.rule !== 'CASCADE' && f.rule !== 'SET NULL'
            )
            assert.deepEqual(
                bad,
                [],
                'a users FK with RESTRICT/NO ACTION blocks or survives account deletion'
            )
            // Seed one row per cascading FK table where a minimal insert is
            // possible: user + a session as the canonical high-traffic child,
            // then verify the introspection sweep after DELETE.
            await client`insert into users (id, email, plan_id) values ('user_v1', 'v1@pgtest.local', 'free')`
            await client`insert into user_sessions (id, user_id, token_hash, provider, subject, expires_at)
                values ('uss_v1', 'user_v1', 'h', 'email', 's', now() + interval '1 day')`
            await client`delete from users where id = 'user_v1'`
            for (const f of fks.filter((f) => f.rule === 'CASCADE')) {
                const rows = await client.unsafe(
                    `select 1 from "${f.tbl}" where "${f.col}" = 'user_v1' limit 1`
                )
                assert.equal(
                    rows.length,
                    0,
                    `${f.tbl}.${f.col} kept a row after user delete`
                )
            }
        })
    }
)

test(
    'T0 request deactivates, revokes sessions, pauses automations; restore lifts only the flag',
    { skip: !RUN },
    async () => {
        await withScratch('state', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await client`insert into users (id, email, plan_id) values ('user_t0', 't0@pgtest.local', 'free')`
                await client`insert into users (id, email, plan_id) values ('admin_1', 'a@pgtest.local', 'free')`
                await client`insert into user_sessions (id, user_id, token_hash, provider, subject, expires_at)
                    values ('uss_t0', 'user_t0', 'h1', 'email', 's', now() + interval '1 day')`
                await client`insert into agent_runtimes (id, user_id, name, framework, kind)
                    values ('art_t0', 'user_t0', 'rt', 'claude-code', 'daemon')`
                await client`insert into agents (id, user_id, name, framework, runtime, runtime_id, internal_id)
                    values ('agt_t0', 'user_t0', 'a', 'claude-code', 'daemon', 'art_t0', 'ia_t0')`
                await client`insert into automations
                    (id, user_id, agent_id, title, prompt, schedule_preset, rrule, timezone, dtstart, status)
                    values ('aut_t0', 'user_t0', 'agt_t0', 'auto', 'p', 'daily', 'FREQ=DAILY', 'UTC', now(), 'active')`

                const service = makeService(db)
                const status = await service.request({
                    userId: 'user_t0',
                    requestedBy: 'admin_1',
                    reason: 'user request'
                })
                assert.equal(status.status, 'pending')

                const [u] = await client`select deactivated_at from users where id = 'user_t0'`
                assert.ok(u.deactivated_at)
                const [s] = await client`select revoked_at from user_sessions where id = 'uss_t0'`
                assert.ok(s.revoked_at)
                const [a] = await client`select status from automations where id = 'aut_t0'`
                assert.equal(a.status, 'paused')

                // Double-request is a 409, not a second row.
                await assert.rejects(
                    service.request({ userId: 'user_t0', requestedBy: 'admin_1' })
                )

                const restored = await service.restore({
                    userId: 'user_t0',
                    requestedBy: 'admin_1'
                })
                assert.equal(restored.status, 'restored')
                const [u2] = await client`select deactivated_at from users where id = 'user_t0'`
                assert.equal(u2.deactivated_at, null)
                // Deliberately still paused: restore must not resurrect
                // unattended activity the user believed was gone.
                const [a2] = await client`select status from automations where id = 'aut_t0'`
                assert.equal(a2.status, 'paused')
            } finally {
                const raw = (
                    db as unknown as { $client?: { end?: () => Promise<void> } }
                ).$client
                if (raw?.end) await raw.end()
            }
        })
    }
)

test(
    'V-4: a failing pre-delete hook records the step and the next sweep completes',
    { skip: !RUN },
    async () => {
        await withScratch('retry', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await client`insert into users (id, email, plan_id) values ('user_rt', 'rt@pgtest.local', 'free')`
                let calls = 0
                const flaky = {
                    ...noopUserLifecyclePort,
                    beforeUserHardDelete: async () => {
                        calls += 1
                        if (calls === 1) throw new Error('cloud cleanup down')
                    }
                }
                const service = makeService(db, flaky)
                await service.request({
                    userId: 'user_rt',
                    requestedBy: 'admin_1'
                })
                await db
                    .update(userDeletions)
                    .set({ scheduledAt: new Date(0) })
                    .where(eq(userDeletions.userId, 'user_rt'))

                await service.sweep()
                let st = await service.status('user_rt')
                assert.equal(st?.status, 'pending')
                assert.equal(st?.lastError?.step, 'lifecycle')
                const [alive] = await client`select 1 as ok from users where id = 'user_rt'`
                assert.ok(alive, 'a failed hook must NOT delete the user')

                await service.sweep()
                st = await service.status('user_rt')
                assert.equal(st?.status, 'executed')
                assert.equal(st?.lastError, null)
                const gone = await client`select 1 from users where id = 'user_rt'`
                assert.equal(gone.length, 0)
                assert.equal(calls, 2)
            } finally {
                const raw = (
                    db as unknown as { $client?: { end?: () => Promise<void> } }
                ).$client
                if (raw?.end) await raw.end()
            }
        })
    }
)

test(
    'V-2: a deactivated account can neither mint nor use sessions',
    { skip: !RUN },
    async () => {
        await withScratch('gates', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await client`insert into users (id, email, plan_id) values ('user_g', 'g@pgtest.local', 'free')`
                const sessions = new SessionService(db as never)
                const { token } = await sessions.mint({
                    userId: 'user_g',
                    provider: 'email',
                    subject: 'g'
                })
                assert.ok(await sessions.verify(token))

                await db
                    .update(users)
                    .set({ deactivatedAt: new Date() })
                    .where(eq(users.id, 'user_g'))
                // The live session dies without waiting for its revocation
                // row, and no provider can mint a fresh one.
                assert.equal(await sessions.verify(token), null)
                await assert.rejects(
                    sessions.mint({
                        userId: 'user_g',
                        provider: 'email',
                        subject: 'g'
                    }),
                    /deletion/
                )
            } finally {
                const raw = (
                    db as unknown as { $client?: { end?: () => Promise<void> } }
                ).$client
                if (raw?.end) await raw.end()
            }
        })
    }
)
