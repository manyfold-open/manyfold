import {
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'

export interface LibrarySkillOrigin {
    type: 'manual' | 'github' | 'archive' | 'catalog' | 'share'
    url?: string
    catalogSkillId?: string
    filename?: string
    shareId?: string
}

export const librarySkills = pgTable(
    'library_skills',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        description: text('description'),
        content: text('content').notNull(),
        origin: jsonb('origin').$type<LibrarySkillOrigin>(),
        contentHash: text('content_hash').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userNameUnique: uniqueIndex('library_skills_user_name_unique').on(
            table.userId,
            table.name
        )
    })
)

export const librarySkillFiles = pgTable(
    'library_skill_files',
    {
        id: text('id').primaryKey(),
        librarySkillId: text('library_skill_id')
            .notNull()
            .references(() => librarySkills.id, { onDelete: 'cascade' }),
        path: text('path').notNull(),
        content: text('content').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        skillPathUnique: uniqueIndex(
            'library_skill_files_skill_path_unique'
        ).on(table.librarySkillId, table.path)
    })
)

export type LibrarySkillRow = typeof librarySkills.$inferSelect
export type NewLibrarySkillRow = typeof librarySkills.$inferInsert
export type LibrarySkillFileRow = typeof librarySkillFiles.$inferSelect
export type NewLibrarySkillFileRow = typeof librarySkillFiles.$inferInsert
