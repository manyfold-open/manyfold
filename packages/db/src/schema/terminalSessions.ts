import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { agents } from './agents'
import { apiTokens } from './apiTokens'

// One row per terminal Manyfold opened on an agent's runtime (a sprites exec
// session or a daemon pty). It is the terminal's durable identity: the process
// handle lets any API instance kill it, the lease proves the tunnel that owns
// it is still alive, and the identity snapshot lets the import that follows a
// release tell whether the transcript can still be reached (ADR-0029 §1).
export const terminalSessions = pgTable(
    'terminal_sessions',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        runtime: text('runtime', { enum: ['sprites', 'daemon'] }).notNull(),
        // Where this terminal shows its TUI: the browser terminal over the
        // API tunnel, or a herdr pane on the daemon's machine (ADR-0031).
        // Rows that predate the column were all browser terminals.
        client: text('client', { enum: ['web', 'herdr'] })
            .notNull()
            .default('web'),
        // Snapshot of the agent's runtime identity when the terminal opened,
        // deliberately not foreign keys: a host that has since been replaced
        // must still compare unequal to the agent's current one.
        hostId: text('host_id'),
        runtimeId: text('runtime_id'),
        // The chat session this terminal resumed and held. Kept after release
        // so the pending import knows which terminal wrote the transcript.
        heldSessionId: text('held_session_id'),
        // sprites: the vendor exec session id; daemon: the pty stream refId.
        // Null until the upstream reports it.
        processHandle: text('process_handle'),
        tokenId: text('token_id').references(() => apiTokens.id, {
            onDelete: 'set null'
        }),
        leaseExpiresAt: timestamp('lease_expires_at', {
            withTimezone: true
        }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        endedAt: timestamp('ended_at', { withTimezone: true }),
        endedReason: text('ended_reason', {
            enum: ['closed', 'superseded', 'reclaimed', 'released', 'failed']
        })
    },
    (table) => ({
        liveLeaseIdx: index('terminal_sessions_live_lease_idx')
            .on(table.leaseExpiresAt)
            .where(sql`${table.endedAt} is null`),
        endedPair: check(
            'terminal_sessions_ended_pair',
            sql`(${table.endedAt} is null) = (${table.endedReason} is null)`
        )
    })
)

export type TerminalSessionRow = typeof terminalSessions.$inferSelect
export type NewTerminalSessionRow = typeof terminalSessions.$inferInsert
