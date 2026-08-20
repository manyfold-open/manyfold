import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
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
        )
    })
)

export type ChatSession = typeof chatSessions.$inferSelect
export type NewChatSession = typeof chatSessions.$inferInsert
