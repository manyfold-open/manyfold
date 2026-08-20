import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Shared hash chokepoint: every bearer hash (external api_tokens and agent
// runtime tokens) belongs to exactly one credential, so a hash can never
// resolve in two token tables. Both token tables FK into this on token_hash.
export const tokenCredentials = pgTable('token_credentials', {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind', { enum: ['external', 'runtime'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type TokenCredential = typeof tokenCredentials.$inferSelect
export type NewTokenCredential = typeof tokenCredentials.$inferInsert
