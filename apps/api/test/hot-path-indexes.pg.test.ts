import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { createDb, schema, type Database } from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// #607: the daemon poll endpoints, the sandbox listings' per-host occupancy
// subquery and the daemon token listing were seq-scanning agents /
// agent_runtimes / daemon_tokens on every request. Proves the five hot-path
// indexes exist once the migration chain (0164) has run — schema drift or a
// silently skipped migration (#445) surfaces here instead of in production
// plans. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const EXPECTED: Array<[table: string, index: string]> = [
    ['agents', 'agents_daemon_id_idx'],
    ['agents', 'agents_host_id_idx'],
    ['agent_runtimes', 'agent_runtimes_daemon_id_idx'],
    ['daemon_tokens', 'daemon_tokens_daemon_id_idx'],
    ['daemon_tokens', 'daemon_tokens_user_id_idx']
]

test('hot-path indexes exist after migrations (#607)', { skip: !RUN }, async () => {
    const url = process.env.DATABASE_URL
    assert.ok(url, 'DATABASE_URL must be set')
    const db = createDb(url)
    try {
        const rows = (await db.execute(sql`
            select tablename, indexname from pg_indexes
            where schemaname = 'public'
        `)) as unknown as Array<{ tablename: string; indexname: string }>
        const have = new Set(rows.map((r) => `${r.tablename}.${r.indexname}`))
        for (const [table, index] of EXPECTED)
            assert.ok(have.has(`${table}.${index}`), `missing ${table}.${index}`)
    } finally {
        const client = (
            db as unknown as { $client?: { end?: () => Promise<void> } }
        ).$client
        if (client?.end) await client.end()
    }
})

// Existence is not usability. #685 added a PARTIAL index,
// chat_stream_events_message_terminal_idx ON (message_id) WHERE event_type in
// ('done','error'), and a partial index is only usable when the planner can
// prove the query implies its predicate. noTerminalStreamEvent() builds that
// predicate with drizzle's inArray(), which emits `event_type in ($3, $4)` —
// parameters, not literals — so a GENERIC plan has no values to reason about
// and falls back to the pre-#685 behaviour: read every event row of the
// message and filter.
//
// A generic plan can only come from a CACHED plan, so the invariant that
// actually protects the hot path is that this probe is never served from one.
// Two independent things hold that today, both measured on local pg 17.10
// [2026-08-10] with drizzle-orm 0.36.4 and postgres.js 3.4.9: drizzle submits
// through postgres.js's unsafe(), which never server-side-prepares (200
// executions leave pg_prepared_statements empty whatever packages/db sets
// `prepare` to); and forced into the cache as a tagged template, the same
// statement still took a custom plan 200/200 times under the default
// plan_cache_mode. `prepare: false` in packages/db is NOT what protects this.
//
// The two tests below split that: the first asserts the outcome (no generic
// plan is ever used for the probe), which is what would actually hurt; the
// second pins the hazard itself, so the index/predicate coupling stays
// visible and reddens if a Postgres upgrade learns the implication, if
// drizzle stops parameterising the list, or if the index predicate drifts.
//
// In the second, sequential scans are disabled so the assertion is about
// which index the planner CAN use, not about cost at whatever cardinality
// the target database happens to hold. Without that it could not run on the
// empty scratch database CI migrates, where a seq scan is the honest choice.
const TERMINAL_INDEX = 'chat_stream_events_message_terminal_idx'

// Only our own constants reach this, and none of them contains a quote; the
// escape is here so a future caller cannot make it a concatenation hazard.
const literal = (value: unknown): string =>
    `'${String(value).replace(/'/g, "''")}'`

// The statement latestInflightMessageId actually sends, taken off the driver
// rather than rebuilt here — a rebuild would keep passing after the real
// query stopped matching it.
const captureInflightProbe = async (
    url: string
): Promise<{ text: string; params: unknown[] }> => {
    const sent: Array<{ text: string; params: unknown[] }> = []
    let recording = false
    const client = postgres(url, {
        prepare: false,
        max: 1,
        debug: (_connection, query, params) => {
            if (recording) sent.push({ text: query, params })
        }
    })
    const repo = new ChatRepository(
        drizzle(client, { schema }) as unknown as Database
    )
    try {
        // postgres.js runs a one-off pg_type lookup on its first
        // parameterised query, which is not part of the probe.
        await repo.latestInflightMessageId('cts_planprobe_warmup')
        recording = true
        await repo.latestInflightMessageId('cts_planprobe')
        recording = false
    } finally {
        await client.end()
    }
    assert.equal(sent.length, 1, `expected one statement: ${sent.length}`)
    return sent[0]
}

// The outcome gate. Runs the probe through the production factory more times
// than the five custom plans Postgres builds before it will even consider a
// generic one, then reads the plan cache from that same backend (max: 1 pins
// it). Green means no generic plan was used — either because nothing cached
// the statement or because `auto` kept choosing custom. Both are fine; a
// generic plan is not, and that is exactly what this fails on.
test('the terminal probe is never served by a cached generic plan', { skip: !RUN }, async () => {
    const url = process.env.DATABASE_URL
    assert.ok(url, 'DATABASE_URL must be set')
    // Nothing cached is a truthful pass here, so the catalog filter must be
    // the statement itself — captured off the driver, then matched by
    // equality. A filter assembled from fragments can drift out of step with
    // the query (fragments that are each present but reordered still miss a
    // LIKE), and a filter that matches nothing turns this green while
    // watching nothing.
    const emitted = await captureInflightProbe(url)
    const db = createDb(url, { max: 1 })
    const repo = new ChatRepository(db)
    try {
        for (let i = 0; i < 12; i++)
            await repo.latestInflightMessageId('cts_plancache_probe')
        const cached = (await db.execute(sql`
            select generic_plans, custom_plans, statement
            from pg_prepared_statements
            where statement = ${emitted.text}
        `)) as unknown as Array<{
            generic_plans: string
            custom_plans: string
            statement: string
        }>
        for (const row of cached)
            assert.equal(
                Number(row.generic_plans),
                0,
                `the terminal probe took a generic plan (${row.generic_plans} generic / ${row.custom_plans} custom):\n${row.statement}`
            )
    } finally {
        const client = (
            db as unknown as { $client?: { end?: () => Promise<void> } }
        ).$client
        if (client?.end) await client.end()
    }
})

test('a generic plan cannot use the terminal-probe partial index', { skip: !RUN }, async () => {
    const url = process.env.DATABASE_URL
    assert.ok(url, 'DATABASE_URL must be set')
    const probe = await captureInflightProbe(url)
    // The whole reason a generic plan is blind here.
    assert.match(probe.text, /"event_type" in \(\$\d+, \$\d+\)/)
    const db = createDb(url, { max: 1 })
    try {
        // One transaction, so `set local` cannot leak into a later statement
        // on this connection. The PREPARE is session-scoped and survives the
        // commit; what disposes of it is client.end() below.
        const plans = await db.transaction(async (tx) => {
            await tx.execute(sql.raw(`prepare probe as ${probe.text}`))
            await tx.execute(sql.raw('set local enable_seqscan = off'))
            const args = probe.params.map(literal).join(', ')
            const explain = async (mode: string): Promise<string> => {
                await tx.execute(
                    sql.raw(`set local plan_cache_mode = ${mode}`)
                )
                const rows = (await tx.execute(
                    sql.raw(`explain (costs off) execute probe (${args})`)
                )) as unknown as Array<Record<string, string>>
                return rows.map((row) => Object.values(row)[0]).join('\n')
            }
            return {
                generic: await explain('force_generic_plan'),
                custom: await explain('force_custom_plan')
            }
        })
        assert.ok(
            plans.custom.includes(TERMINAL_INDEX),
            `a custom plan must reach the partial index:\n${plans.custom}`
        )
        assert.ok(
            !plans.generic.includes(TERMINAL_INDEX),
            `a generic plan reached the partial index, so the hazard this pins is gone:\n${plans.generic}`
        )
        // And it pays for that by filtering event_type at runtime, which is
        // the cost #685 removed.
        assert.match(plans.generic, /Filter: \(event_type = ANY \(ARRAY\[\$/)
    } finally {
        const client = (
            db as unknown as { $client?: { end?: () => Promise<void> } }
        ).$client
        if (client?.end) await client.end()
    }
})
