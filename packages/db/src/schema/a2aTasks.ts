import {
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agents } from './agents'
import { chatSessions } from './chatSessions'
import { chatMessages } from './chatMessages'

export const a2aTasks = pgTable(
    'a2a_tasks',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        targetAgentId: text('target_agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        callerAgentId: text('caller_agent_id').references(() => agents.id, {
            onDelete: 'set null'
        }),
        externalSubject: text('external_subject'),
        contextId: text('context_id').notNull(),
        chatSessionId: text('chat_session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        clientMessageId: text('client_message_id').notNull(),
        userMessageId: text('user_message_id').references(
            () => chatMessages.id,
            { onDelete: 'set null' }
        ),
        assistantMessageId: text('assistant_message_id').references(
            () => chatMessages.id,
            { onDelete: 'set null' }
        ),
        state: text('state', {
            enum: [
                'submitted',
                'working',
                'input-required',
                'completed',
                'canceled',
                'failed',
                'rejected',
                'auth-required',
                'unknown'
            ]
        })
            .notNull()
            .default('submitted'),
        artifactJson: jsonb('artifact_json').$type<Record<string, unknown>>(),
        errorJson: jsonb('error_json').$type<Record<string, unknown>>(),
        usageJson: jsonb('usage_json').$type<Record<string, unknown>>(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true })
    },
    (table) => ({
        targetCreatedIdx: index('a2a_tasks_target_created_idx').on(
            table.targetAgentId,
            table.createdAt
        ),
        contextIdx: index('a2a_tasks_context_idx').on(table.contextId),
        callerIdx: index('a2a_tasks_caller_idx').on(table.callerAgentId),
        clientMessageUnique: uniqueIndex(
            'a2a_tasks_session_client_message_uq'
        ).on(table.chatSessionId, table.clientMessageId)
    })
)

export type A2aTask = typeof a2aTasks.$inferSelect
export type NewA2aTask = typeof a2aTasks.$inferInsert
