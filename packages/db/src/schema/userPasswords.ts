import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'

export const userPasswords = pgTable('user_passwords', {
    userId: text('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type UserPassword = typeof userPasswords.$inferSelect
export type NewUserPassword = typeof userPasswords.$inferInsert
