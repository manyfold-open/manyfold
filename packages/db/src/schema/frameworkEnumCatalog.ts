import { sql } from 'drizzle-orm'
import {
    boolean,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'

export const frameworkEnumCatalog = pgTable(
    'framework_enum_catalog',
    {
        id: text('id').primaryKey(),
        framework: text('framework', {
            enum: ['claude-code', 'codex', 'gemini-cli']
        }).notNull(),
        enumKey: text('enum_key', {
            enum: ['effort', 'speed', 'intelligence']
        }).notNull(),
        value: text('value').notNull(),
        displayName: text('display_name').notNull(),
        sortOrder: integer('sort_order').notNull().default(0),
        isActive: boolean('is_active').notNull().default(true),
        isDefault: boolean('is_default').notNull().default(false),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        valueUnique: uniqueIndex(
            'framework_enum_catalog_framework_key_value_unique'
        ).on(table.framework, table.enumKey, table.value),
        defaultUnique: uniqueIndex(
            'framework_enum_catalog_default_unique'
        )
            .on(table.framework, table.enumKey)
            .where(sql`${table.isDefault} = true`),
        activeIdx: index('framework_enum_catalog_active_idx').on(
            table.framework,
            table.enumKey,
            table.isActive
        )
    })
)

export type FrameworkEnumCatalogRow = typeof frameworkEnumCatalog.$inferSelect
export type NewFrameworkEnumCatalogRow =
    typeof frameworkEnumCatalog.$inferInsert
