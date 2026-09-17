import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { terminalSessions } from './terminalSessions'

// One row per framework session a CLI's own SessionStart hook reported from
// a Manyfold-opened terminal (ADR-0029 §3). A ref the terminal was opened on
// or adopted is bound to its chat session; a ref that started fresh in the
// terminal stays unbound until the terminal ends, when a non-empty transcript
// becomes a chat session of its own. Cascades with the terminal row, so the
// lease reaper's retention prunes these too.
export const terminalSessionRefs = pgTable(
    'terminal_session_refs',
    {
        id: text('id').primaryKey(),
        terminalId: text('terminal_id')
            .notNull()
            .references(() => terminalSessions.id, { onDelete: 'cascade' }),
        framework: text('framework').notNull(),
        sessionRef: text('session_ref').notNull(),
        // How the first SessionStart said the session began.
        source: text('source').notNull(),
        cwd: text('cwd'),
        chatSessionId: text('chat_session_id'),
        firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        lastEvent: text('last_event', { enum: ['start', 'end'] }).notNull(),
        lastEventAt: timestamp('last_event_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        // Stamped when the terminal's end dealt with an unbound ref, with what
        // became of it; bound refs are settled by the session they belong to.
        settledAt: timestamp('settled_at', { withTimezone: true }),
        settledOutcome: text('settled_outcome', {
            enum: ['created', 'empty', 'duplicate', 'unreadable', 'skipped']
        })
    },
    (table) => ({
        terminalRefIdx: uniqueIndex(
            'terminal_session_refs_terminal_ref_idx'
        ).on(table.terminalId, table.sessionRef)
    })
)

export type TerminalSessionRefRow = typeof terminalSessionRefs.$inferSelect
export type NewTerminalSessionRefRow = typeof terminalSessionRefs.$inferInsert
