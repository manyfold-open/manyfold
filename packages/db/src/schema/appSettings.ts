import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const appSettings = pgTable('app_settings', {
    key: text('key').primaryKey(),
    valueJson: jsonb('value_json').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type AppSetting = typeof appSettings.$inferSelect
export type NewAppSetting = typeof appSettings.$inferInsert
