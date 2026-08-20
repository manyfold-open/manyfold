import { sql } from 'drizzle-orm'
import {
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'

export interface FrameworkModelCapabilities {
    fast?: boolean
    longContext?: boolean
}

export const frameworkModelCatalog = pgTable(
    'framework_model_catalog',
    {
        id: text('id').primaryKey(),
        framework: text('framework', {
            enum: ['claude-code', 'codex', 'gemini-cli']
        }).notNull(),
        modelKey: text('model_key').notNull(),
        kind: text('kind', {
            enum: ['model', 'alias']
        }).notNull(),
        displayName: text('display_name').notNull(),
        capabilities: jsonb('capabilities')
            .$type<FrameworkModelCapabilities>()
            .notNull()
            .default({}),
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
        modelKeyUnique: uniqueIndex(
            'framework_model_catalog_framework_key_unique'
        ).on(table.framework, table.modelKey),
        defaultUnique: uniqueIndex(
            'framework_model_catalog_default_unique'
        )
            .on(table.framework, table.kind)
            .where(sql`${table.isDefault} = true`),
        activeIdx: index('framework_model_catalog_active_idx').on(
            table.framework,
            table.isActive
        )
    })
)

export type FrameworkModelCatalogRow = typeof frameworkModelCatalog.$inferSelect
export type NewFrameworkModelCatalogRow =
    typeof frameworkModelCatalog.$inferInsert
