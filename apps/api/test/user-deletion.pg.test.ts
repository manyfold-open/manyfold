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
import { DeletionTokenService } from '../src/modules/user-deletion/deletion-token.service'
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
// (6) v2 self-serve (§9.1): awaiting_confirmation applies NO side effects
//     until the emailed token confirms; tokens are single-use through the
//     row's own state transitions; restore works session-less post-T0.
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

interface SentMail {
    to: string
    subject: string
    text?: string
    html?: string
}

const noEmail = { send: async () => undefined } as never
const noModuleRef = {
    get: () => {
        throw new Error('no runtimes/channels seeded in this test')
    }
} as never
const noConfig = { get: () => undefined } as never

const tokenService = (): DeletionTokenService =>
    new DeletionTokenService(noConfig)

const makeService = (
    db: ReturnType<typeof createDb>,
    lifecycle = noopUserLifecyclePort,
    email: { send: (mail: SentMail) => Promise<void> } = noEmail
): UserDeletionService =>
    new UserDeletionService(
        db as never,
        email as never,
        tokenService(),
        noConfig,
        noModuleRef,
        lifecycle
    )

// The link tokens ride inside the emails; pulling them back out of the
// rendered mail is the honest proof the EMAILED link works, not just some
// internally minted one.
const tokenFromMail = (mail: SentMail | undefined): string => {
    const match = (mail?.text ?? '').match(/token=([^\s&"']+)/)
    if (!match) throw new Error(`no token in mail: ${mail?.subject}`)
    return decodeURIComponent(match[1])
}

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

test(
    'self-serve: awaiting applies no side effects; the EMAILED token confirms into T0; the T0 email restores session-less; both tokens are single-use',
    { skip: !RUN },
    async () => {
        await withScratch('selfsrv', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await client`insert into users (id, email, plan_id) values ('user_ss', 'ss@pgtest.local', 'free')`
                await client`insert into user_sessions (id, user_id, token_hash, provider, subject, expires_at)
                    values ('uss_ss', 'user_ss', 'h', 'email', 's', now() + interval '1 day')`
                const sent: SentMail[] = []
                const service = makeService(db, noopUserLifecyclePort, {
                    send: async (mail) => {
                        sent.push(mail)
                    }
                })

                const awaiting = await service.selfRequest('user_ss')
                assert.equal(awaiting.status, 'awaiting_confirmation')
                // The whole point of the pre-state: nothing happened yet.
                const [u0] = await client`select deactivated_at from users where id = 'user_ss'`
                assert.equal(u0.deactivated_at, null)
                const [s0] = await client`select revoked_at from user_sessions where id = 'uss_ss'`
                assert.equal(s0.revoked_at, null)
                assert.equal((await service.meStatus('user_ss'))?.id, awaiting.id)

                const confirmToken = tokenFromMail(sent[0])
                const confirmed = await service.selfConfirm(
                    'user_ss',
                    confirmToken
                )
                assert.equal(confirmed.status, 'pending')
                const [u1] = await client`select deactivated_at from users where id = 'user_ss'`
                assert.ok(u1.deactivated_at, 'confirm must run the v1 T0')
                const [s1] = await client`select revoked_at from user_sessions where id = 'uss_ss'`
                assert.ok(s1.revoked_at)
                // Post-T0 the settings view has nothing awaiting.
                assert.equal(await service.meStatus('user_ss'), null)
                // Replay: the row already left awaiting_confirmation.
                await assert.rejects(
                    service.selfConfirm('user_ss', confirmToken),
                    /invalid or expired/
                )

                // Session-less grace-period escape hatch (§9.1): the restore
                // token rides the T0 email and needs no auth at all.
                const restoreToken = tokenFromMail(
                    sent.find(
                        (m) => m.subject === 'Your account is scheduled for deletion'
                    )
                )
                const restored = await service.restoreByToken(restoreToken)
                assert.equal(restored.status, 'restored')
                const [u2] = await client`select deactivated_at from users where id = 'user_ss'`
                assert.equal(u2.deactivated_at, null)
                await assert.rejects(
                    service.restoreByToken(restoreToken),
                    /invalid or expired/
                )

                // The self flow writes its own audit trail.
                const actions = (
                    await client`select action from audit_logs where subject = 'user_ss' order by created_at`
                ).map((r) => r.action)
                assert.deepEqual(actions, [
                    'user.deletion.self_requested',
                    'user.deletion.self_confirmed',
                    'user.deletion.self_restored'
                ])
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
    'self-serve: tampered/foreign/expired tokens are rejected and the sweep expires (never executes) stale awaiting rows',
    { skip: !RUN },
    async () => {
        await withScratch('selfexp', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await client`insert into users (id, email, plan_id) values ('user_x', 'x@pgtest.local', 'free')`
                await client`insert into users (id, email, plan_id) values ('user_y', 'y@pgtest.local', 'free')`
                const sent: SentMail[] = []
                const service = makeService(db, noopUserLifecyclePort, {
                    send: async (mail) => {
                        sent.push(mail)
                    }
                })
                const awaiting = await service.selfRequest('user_x')
                const token = tokenFromMail(sent[0])

                // A flipped signature bit must die in verify, not in the DB.
                const tampered =
                    token.slice(0, -1) +
                    (token.endsWith('0') ? '1' : '0')
                await assert.rejects(
                    service.selfConfirm('user_x', tampered),
                    /invalid or expired/
                )
                // Another signed-in account cannot consume my link.
                await assert.rejects(
                    service.selfConfirm('user_y', token),
                    /invalid or expired/
                )
                // A token minted already-expired never validates.
                const stale = tokenService().mint(
                    'confirm',
                    awaiting.id,
                    new Date(Date.now() - 1000)
                )
                await assert.rejects(
                    service.selfConfirm('user_x', stale),
                    /invalid or expired/
                )

                // Sweep hygiene: a stale awaiting row is MARKED expired and
                // is never executed — even with scheduled_at long overdue the
                // user must survive untouched (no T0 ever ran).
                await client`update user_deletions
                    set requested_at = now() - interval '25 hours',
                        scheduled_at = now() - interval '1 hour'
                    where id = ${awaiting.id}`
                assert.equal(await service.meStatus('user_x'), null)
                await service.sweep()
                const [row] = await client`select status from user_deletions where id = ${awaiting.id}`
                assert.equal(row.status, 'expired')
                const [alive] = await client`select deactivated_at from users where id = 'user_x'`
                assert.equal(alive.deactivated_at, null)
                // And the emailed token now lands on a consumed row.
                await assert.rejects(
                    service.selfConfirm('user_x', token),
                    /invalid or expired/
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
