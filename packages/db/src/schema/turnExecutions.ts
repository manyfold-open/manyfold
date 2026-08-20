import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { chatSessions } from './chatSessions'
import { chatMessages } from './chatMessages'

// Durable per-turn execution record + lease. One row per assistant turn whose
// execution outlives the request that started it: a sprite/external relay, or a
// daemon-carried turn that a reconnecting daemon can ask to resume. Makes "who
// is relaying this turn, and to what remote exec" a cross-instance-visible fact
// instead of the in-memory-only runningAdapters map + exec-session closure, so
// a fresh API instance can adopt a turn orphaned by a deploy/crash/auto-stop.
// The session turn lock (chat_sessions.inflight_message_id) still admits one
// turn per session; this row tracks that turn's execution and ownership.
// A row is not by itself an invitation to adopt: the sweep only claims the
// runtimes listAdoptableTurnExecutions selects, and a daemon row exists so a
// resume has something to fence against, not so a sweep can replay it.
export const turnExecutions = pgTable(
    'turn_executions',
    {
        messageId: text('message_id')
            .primaryKey()
            .references(() => chatMessages.id, { onDelete: 'cascade' }),
        sessionId: text('session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        agentId: text('agent_id').notNull(),
        runtime: text('runtime', {
            enum: ['sprites', 'daemon', 'k8s', 'external']
        }).notNull(),
        // The sprite exec handle needed for cross-process re-attach. sprite_name
        // is set at turn start; exec_session_id lands once the session_info
        // frame arrives (may briefly be null between start and first output).
        spriteName: text('sprite_name'),
        execSessionId: text('exec_session_id'),
        // The external runtime's twin of (sprite_name, exec_session_id): the
        // handles that let a fresh instance ask the upstream API what happened
        // to a turn it never saw. Both land mid-stream (the first Dify chunk
        // that carries them, the first task-bearing A2A frame), so a turn
        // orphaned before then has neither and is honestly unrecoverable. The
        // conversation/context id is NOT duplicated here — it is already the
        // session's framework_session_ref.
        upstreamTaskId: text('upstream_task_id'),
        upstreamMessageId: text('upstream_message_id'),
        ownerId: text('owner_id').notNull(),
        // Fencing token. The initial stamp creates generation 1; every later
        // ownership transition (adoption or daemon resume claim) bumps it in
        // the same UPDATE that moves owner_id,
        // so it is monotonic per turn and never reused. owner_id alone cannot
        // fence: the SAME instance legitimately re-owns a turn (an adoption
        // that hands over to the matched daemon resume next to it), and a
        // process that lost the turn mid-write still believes it is the owner
        // it always was. Carried by the writer and re-checked inside every
        // owned write, so a stale carrier's events, checkpoints, source rows
        // and terminal are rejected by Postgres rather than by whether the
        // stale process happens to notice.
        generation: integer('generation').notNull().default(1),
        leaseExpiresAt: timestamp('lease_expires_at', {
            withTimezone: true
        }).notNull(),
        state: text('state', {
            enum: ['running', 'handoff', 'adopting', 'done', 'failed']
        }).notNull(),
        adoptCount: integer('adopt_count').notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        // The adoption sweep scans for non-terminal turns whose lease lapsed;
        // the partial index keeps it off the (growing) terminal rows.
        adoptableIdx: index('turn_executions_adoptable_idx')
            .on(table.leaseExpiresAt)
            .where(sql`${table.state} in ('running', 'handoff', 'adopting')`),
        sessionIdx: index('turn_executions_session_idx').on(table.sessionId)
    })
)

export type TurnExecutionRow = typeof turnExecutions.$inferSelect
export type NewTurnExecutionRow = typeof turnExecutions.$inferInsert
