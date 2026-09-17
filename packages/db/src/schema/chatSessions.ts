import {
    check,
    index,
    integer,
    pgTable,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { agents } from './agents'

export const chatSessions = pgTable(
    'chat_sessions',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        title: text('title'),
        frameworkSessionRef: text('framework_session_ref'),
        // Atomic per-session turn lock: holds the assistant message id of the
        // currently-running turn (null when idle). Claimed via compare-and-set at
        // turn start and cleared when that message gets a done/error stream event,
        // so at most one turn runs per session across API instances.
        inflightMessageId: text('inflight_message_id'),
        // How far into the framework's own transcript for frameworkSessionRef
        // the cloud already reaches: the count of newline-terminated lines the
        // file had when the API's last turn on it settled (or the last sync
        // consumed it). The runtime-session sync appends only what lies past
        // it. Null until a turn on the ref settles, and again whenever the ref
        // moves — a new file has no covered prefix — which sends the next sync
        // back to the content diff.
        runtimeSyncCursor: integer('runtime_sync_cursor'),
        // The Manyfold-opened terminal that currently owns this session's
        // writes: set while it runs the framework's own TUI on the session's
        // ref, so no turn may dispatch into the same transcript. The CHECK
        // below keeps it and inflightMessageId mutually exclusive in the
        // database, so an instance still on older code gets a constraint
        // error instead of a double occupancy (ADR-0029 §1).
        holderTerminalId: text('holder_terminal_id'),
        holderAcquiredAt: timestamp('holder_acquired_at', {
            withTimezone: true
        }),
        // Set by the same statement that releases the holder: what the
        // terminal wrote has not been imported yet, and no turn may run until
        // it is or the import is abandoned — a codex turn would otherwise
        // push runtimeSyncCursor past those lines forever (ADR-0029 §2).
        importPendingSince: timestamp('import_pending_since', {
            withTimezone: true
        }),
        // Only sessions created from a transcript a Manyfold-opened terminal
        // wrote carry a value (ADR-0029 §3); every other way a session starts
        // leaves it null.
        origin: text('origin', { enum: ['terminal'] }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userAgentIdx: index('chat_sessions_user_agent_idx').on(
            table.userId,
            table.agentId
        ),
        updatedAtIdIdx: index('chat_sessions_updated_at_id_idx').on(
            table.updatedAt,
            table.id
        ),
        turnXorHolder: check(
            'chat_sessions_turn_xor_holder',
            sql`${table.inflightMessageId} is null or ${table.holderTerminalId} is null`
        ),
        holderPair: check(
            'chat_sessions_holder_pair',
            sql`(${table.holderTerminalId} is null) = (${table.holderAcquiredAt} is null)`
        )
    })
)

export type ChatSession = typeof chatSessions.$inferSelect
export type NewChatSession = typeof chatSessions.$inferInsert
