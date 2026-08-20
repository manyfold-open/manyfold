import { sql } from 'drizzle-orm'
import {
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'

export interface UserConnectionMetadata {
    accountType?: string
    accountName?: string
    repositorySelection?: string
    scopes?: string[]
}

export const userConnections = pgTable(
    'user_connections',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        provider: text('provider', {
            enum: ['github', 'cloudflare', 'composio']
        }).notNull(),
        kind: text('kind', {
            enum: [
                'github_app_installation',
                'cloudflare_api_token',
                'composio_consumer_key'
            ]
        }).notNull(),
        displayName: text('display_name').notNull(),
        // installation_id (github) / selected account id (cloudflare). Null only
        // for transient/partial rows; the active-unique index requires it.
        externalId: text('external_id'),
        // GitHub App rows store NO token (minted ~1h on demand); Cloudflare rows
        // store the encrypted API token.
        secretCiphertext: text('secret_ciphertext'),
        keyVersion: integer('key_version').notNull().default(1),
        metadata: jsonb('metadata').$type<UserConnectionMetadata>(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userIdx: index('user_connections_user_idx').on(table.userId),
        activeExternalUnique: uniqueIndex('user_connections_active_external_unique')
            .on(table.userId, table.provider, table.externalId)
            .where(
                sql`${table.externalId} is not null and ${table.revokedAt} is null`
            )
    })
)

export type UserConnectionRow = typeof userConnections.$inferSelect
export type NewUserConnectionRow = typeof userConnections.$inferInsert
