import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const spritesAccounts = pgTable('sprites_accounts', {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    orgSlug: text('org_slug').notNull(),
    orgId: text('org_id').notNull(),
    tokenId: text('token_id').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyVersion: integer('token_key_version').notNull().default(1),
    status: text('status', { enum: ['enabled', 'disabled'] })
        .notNull()
        .default('enabled'),
    priority: integer('priority').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type SpritesAccount = typeof spritesAccounts.$inferSelect
export type NewSpritesAccount = typeof spritesAccounts.$inferInsert
