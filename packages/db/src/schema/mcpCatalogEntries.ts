import { sql } from 'drizzle-orm'
import {
    boolean,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { catalogCategories } from './catalogCategories'

export const mcpCatalogEntries = pgTable(
    'mcp_catalog_entries',
    {
        id: text('id').primaryKey(),
        slug: text('slug').notNull(),
        name: text('name').notNull(),
        description: text('description').notNull(),
        longDescription: text('long_description'),
        iconUrl: text('icon_url'),
        homepageUrl: text('homepage_url').notNull(),
        transport: text('transport', { enum: ['http', 'stdio'] }).notNull(),
        url: text('url'),
        headers: jsonb('headers').$type<Record<string, string>>(),
        command: text('command'),
        args: jsonb('args').$type<string[]>(),
        env: jsonb('env').$type<Record<string, string>>(),
        tags: jsonb('tags')
            .$type<string[]>()
            .notNull()
            .default(sql`'[]'::jsonb`),
        categoryId: text('category_id').references(
            () => catalogCategories.id,
            { onDelete: 'set null' }
        ),
        featured: boolean('featured').notNull().default(false),
        sortOrder: integer('sort_order').notNull().default(0),
        isActive: boolean('is_active').notNull().default(true),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        slugUnique: uniqueIndex('mcp_catalog_entries_slug_unique').on(
            table.slug
        )
    })
)

export type McpCatalogEntryRow = typeof mcpCatalogEntries.$inferSelect
export type NewMcpCatalogEntryRow = typeof mcpCatalogEntries.$inferInsert
