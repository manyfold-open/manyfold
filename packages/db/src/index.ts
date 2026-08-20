import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export { schema }
export * from './schema'
export * from './jsonb'

export type Database = ReturnType<typeof createDb>

export interface CreateDbOptions {
    // postgres.js pool size; omitted = postgres.js default (10)
    max?: number
    // shows up in pg_stat_activity.application_name for diagnostics
    applicationName?: string
}

export const createDb = (url: string, opts: CreateDbOptions = {}) => {
    const client = postgres(url, {
        // Keep it, but not for either story usually told about it: it is a
        // blanket "name nothing on this client", and its reach is narrower
        // than it looks.
        //
        // Not pooler compatibility — whether anything sits in front of the
        // Fly Managed Postgres cluster is an OPEN question, and the way to
        // settle it is in docs/engineering/database.md. Not what protects
        // the partial index chat_stream_events_message_terminal_idx either,
        // which is the next guess once the pooler story dies.
        //
        // Measured on local pg 17.10 [2026-08-10] against drizzle-orm 0.36.4
        // and postgres.js 3.4.9: drizzle submits DATA statements through
        // postgres.js's unsafe(), which pins prepare: false per query and
        // wins over this option (connection.js:232) — even drizzle's own
        // .prepare(name), whose name the adapter drops (session.js:78). 200
        // executions of latestInflightMessageId leave pg_prepared_statements
        // empty under BOTH settings, so this option cannot change how a
        // repository query is planned. Forced into the cache as a tagged
        // template that same statement still took a custom plan 200/200
        // times under the default plan_cache_mode.
        //
        // What it does reach: transaction control, which postgres.js emits
        // as tagged templates (savepoint / rollback / commit), tagged calls
        // on $client — here the LISTEN/NOTIFY fallback in the chat and
        // sprite buses — and anything that names a statement in future.
        // Measured the same day: a drizzle transaction with a nested
        // savepoint leaves `commit` and `savepoint "s0"` in the cache with
        // prepare: true, and nothing at all with prepare: false.
        prepare: false,
        ...(opts.max !== undefined ? { max: opts.max } : {}),
        ...(opts.applicationName
            ? { connection: { application_name: opts.applicationName } }
            : {})
    })
    return drizzle(client, { schema })
}
