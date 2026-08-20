import { sql } from 'drizzle-orm'
import {
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { librarySkills } from './librarySkills'
import { users } from './users'

// The row id (lss_…) doubles as the unlisted share URL slug: 74 random bits
// plus rate limiting make enumeration infeasible, and unlike credentials a
// hash buys nothing — the content the id unlocks lives in the same database.
export const librarySkillShares = pgTable(
    'library_skill_shares',
    {
        id: text('id').primaryKey(),
        librarySkillId: text('library_skill_id')
            .notNull()
            .references(() => librarySkills.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        importCount: integer('import_count').notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        activeSkillUnique: uniqueIndex('library_skill_shares_active_skill_uq')
            .on(table.librarySkillId)
            .where(sql`${table.revokedAt} is null`)
    })
)

export type LibrarySkillShareRow = typeof librarySkillShares.$inferSelect
export type NewLibrarySkillShareRow = typeof librarySkillShares.$inferInsert
