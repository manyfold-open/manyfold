import {
    index,
    integer,
    pgTable,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { users } from './users'

export const emailVerifications = pgTable(
    'email_verifications',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        email: text('email').notNull(),
        purpose: text('purpose', {
            enum: [
                'email_verify',
                'password_reset',
                'email_change',
                'password_setup',
                'reauth'
            ]
        }).notNull(),
        codeHash: text('code_hash').notNull(),
        attempts: integer('attempts').notNull().default(0),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        consumedAt: timestamp('consumed_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        emailPurposeIdx: index('email_verifications_email_purpose_idx').on(
            table.email,
            table.purpose
        ),
        expiresIdx: index('email_verifications_expires_idx').on(table.expiresAt)
    })
)

export type EmailVerification = typeof emailVerifications.$inferSelect
export type NewEmailVerification = typeof emailVerifications.$inferInsert
