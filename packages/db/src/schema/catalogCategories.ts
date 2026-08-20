import {
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'

export const catalogCategories = pgTable(
    'catalog_categories',
    {
        id: text('id').primaryKey(),
        domain: text('domain', { enum: ['skill', 'mcp'] }).notNull(),
        name: text('name').notNull(),
        sortOrder: integer('sort_order').notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        domainNameUnique: uniqueIndex('catalog_categories_domain_name_unique').on(
            table.domain,
            table.name
        )
    })
)

export type CatalogCategoryRow = typeof catalogCategories.$inferSelect
export type NewCatalogCategoryRow = typeof catalogCategories.$inferInsert
