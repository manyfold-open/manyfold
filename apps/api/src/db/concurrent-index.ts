export interface ConcurrentIndexSpec {
    table: string
    index: string
    create: string
}

export interface ConcurrentIndexState {
    tableExists: boolean
    // null when nothing of that name exists; else pg_index.indisvalid
    indexIsValid: boolean | null
}

export type ConcurrentIndexAction =
    | 'skip_absent_table'
    | 'skip_valid'
    | 'create'
    | 'rebuild_invalid'

// Indexes that must be built with CREATE INDEX CONCURRENTLY on an existing
// database. Two facts force this out of the migration files:
//
// 1. drizzle's migrator wraps the ENTIRE migration set in one transaction
//    (drizzle-orm/pg-core/dialect.js: `session.transaction(...)`), and
//    Postgres refuses CONCURRENTLY inside a transaction block.
// 2. A plain CREATE INDEX takes a SHARE lock, which blocks every INSERT on
//    the table until the build finishes. On chat_stream_events — the largest
//    and most write-hot table in the schema, growing unbounded while
//    compaction ships default-off — a blocked insert also blocks the terminal
//    transaction that clears chat_sessions.inflight_message_id and closes
//    turn_executions, so a slow build stalls every in-flight turn in the
//    fleet, not just writes.
//
// So they are built here, on the raw client, before the migrator opens its
// transaction. The generated migration keeps its plain CREATE INDEX IF NOT
// EXISTS: on a fresh database the table does not exist yet, this step skips,
// and the migration creates the index inline on an empty table for free. On
// an existing database this step built it already and the migration no-ops.
export const CONCURRENT_INDEXES: ConcurrentIndexSpec[] = [
    {
        table: 'chat_stream_events',
        index: 'chat_stream_events_message_terminal_idx',
        create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_stream_events_message_terminal_idx" ON "chat_stream_events" USING btree ("message_id") WHERE "chat_stream_events"."event_type" in ('done', 'error')`
    },
    {
        table: 'chat_message_sources',
        index: 'chat_message_sources_raw_pending_idx',
        create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_message_sources_raw_pending_idx" ON "chat_message_sources" USING btree ("created_at","id") WHERE "chat_message_sources"."raw_cleared_at" is null`
    }
]

// A CREATE INDEX CONCURRENTLY that fails or is interrupted — the Fly release
// command being killed mid-build is the realistic way — leaves the index
// behind marked invalid. The planner never uses an invalid index, but every
// writer still maintains it, and a later CREATE INDEX ... IF NOT EXISTS
// silently skips it because the NAME exists. Left alone it is pure cost that
// no re-run would ever clear, so an invalid index is dropped and rebuilt.
export const planConcurrentIndex = (
    state: ConcurrentIndexState
): ConcurrentIndexAction => {
    if (!state.tableExists) return 'skip_absent_table'
    if (state.indexIsValid === null) return 'create'
    return state.indexIsValid ? 'skip_valid' : 'rebuild_invalid'
}
