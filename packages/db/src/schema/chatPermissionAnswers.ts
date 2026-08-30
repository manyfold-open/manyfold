import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { chatMessages } from './chatMessages'

// The durable half of answering a hermes permission_request when the API
// instance that received the answer is not the one holding the blocked ACP
// client. The answer lands here (ON CONFLICT DO NOTHING — the composite PK is
// what makes a second answer a 409, not a race), a pg NOTIFY wakes the peers,
// and the holder's converge tick sweeps this table as the lost-NOTIFY
// fallback — the same durable-plus-bus contract cancel uses.
export const chatPermissionAnswers = pgTable(
    'chat_permission_answers',
    {
        messageId: text('message_id')
            .notNull()
            .references(() => chatMessages.id, { onDelete: 'cascade' }),
        requestId: text('request_id').notNull(),
        optionId: text('option_id').notNull(),
        userId: text('user_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        pk: primaryKey({ columns: [table.messageId, table.requestId] })
    })
)

export type ChatPermissionAnswerRow = typeof chatPermissionAnswers.$inferSelect
export type NewChatPermissionAnswerRow =
    typeof chatPermissionAnswers.$inferInsert
