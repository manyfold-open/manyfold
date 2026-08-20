import { sql } from 'drizzle-orm'
import {
    index,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'

export const authIdentities = pgTable(
    'auth_identities',
    {
        provider: text('provider', {
            enum: ['oidc', 'google', 'email', 'netmind']
        }).notNull(),
        subject: text('subject').notNull(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        email: text('email').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        pk: primaryKey({ columns: [table.provider, table.subject] }),
        userIdx: index('auth_identities_user_idx').on(table.userId),
        // At most one email identity per account — the change-email swap is
        // the only thing that rotates it. Enforced at the DB so a race
        // between an OAuth login and a swap can't leave two email rows.
        oneEmailPerUser: uniqueIndex('auth_identities_one_email_per_user')
            .on(table.userId)
            .where(sql`${table.provider} = 'email'`)
    })
)

export type AuthIdentity = typeof authIdentities.$inferSelect
export type NewAuthIdentity = typeof authIdentities.$inferInsert
