import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const oauthStates = pgTable(
    'oauth_states',
    {
        id: text('id').primaryKey(),
        provider: text('provider', {
            enum: ['google', 'oidc']
        }).notNull(),
        stateHash: text('state_hash').notNull().unique(),
        codeVerifier: text('code_verifier').notNull(),
        redirectAfter: text('redirect_after'),
        linkUserId: text('link_user_id'),
        // Mint time of the session that started a link-mode flow. A reauth
        // proof is only issued when the re-consented identity predates this,
        // so a hijacked session can't link (or re-link) an account it just
        // added and have it vouch for itself.
        linkSessionAt: timestamp('link_session_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        consumedAt: timestamp('consumed_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        expiresIdx: index('oauth_states_expires_idx').on(table.expiresAt)
    })
)

export type OauthState = typeof oauthStates.$inferSelect
export type NewOauthState = typeof oauthStates.$inferInsert
