import { customType, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'

// drizzle 0.36 has no built-in bytea type.
const bytea = customType<{ data: Buffer }>({
    dataType: () => 'bytea'
})

// One small (≤512KB, client-resized) image per user. Kept out of `users` so
// ordinary user selects never drag the blob along; storage is the database on
// purpose — the platform's S3 config is optional and the chat-upload disk
// fallback is TTL-swept, while an avatar must survive both.
export const userAvatars = pgTable('user_avatars', {
    userId: text('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    bytes: bytea('bytes').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type UserAvatar = typeof userAvatars.$inferSelect
export type NewUserAvatar = typeof userAvatars.$inferInsert
