import {
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentRuntimes } from './agentRuntimes'

// A vendor sign-in held on a runtime's host in its own credential context,
// selectable per agent. This row is safe metadata only: identity fields the
// host reported, lifecycle, and a generation counter the host bumps. Tokens,
// API keys and host paths never land here — the host store is the credential
// authority and the profile id is its lookup key.
export const runtimeAuthProfiles = pgTable(
    'runtime_auth_profiles',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        runtimeId: text('runtime_id')
            .notNull()
            .references(() => agentRuntimes.id, { onDelete: 'cascade' }),
        framework: text('framework', {
            enum: ['claude-code', 'codex', 'gemini-cli']
        }).notNull(),
        label: text('label').notNull(),
        authMethod: text('auth_method', {
            enum: ['subscription', 'api-key']
        }).notNull(),
        lifecycle: text('lifecycle', {
            enum: [
                'pending',
                'ready',
                'signed-out',
                'deleting',
                'deleted',
                'error'
            ]
        })
            .notNull()
            .default('pending'),
        credentialStatus: text('credential_status', {
            enum: [
                'unknown',
                'valid',
                'refresh-required',
                'reauth-required',
                'missing'
            ]
        })
            .notNull()
            .default('unknown'),
        credentialGeneration: integer('credential_generation')
            .notNull()
            .default(0),
        vendor: text('vendor'),
        vendorUserId: text('vendor_user_id'),
        vendorAccountId: text('vendor_account_id'),
        // PII with a length cap enforced by the API parser; never logged.
        email: text('email'),
        displayName: text('display_name'),
        organization: text('organization'),
        plan: text('plan'),
        checkedAt: timestamp('checked_at', { withTimezone: true }),
        lastErrorCode: text('last_error_code'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        deletedAt: timestamp('deleted_at', { withTimezone: true })
    },
    (table) => ({
        runtimeIdx: index('runtime_auth_profiles_runtime_idx').on(
            table.runtimeId
        ),
        // Lets agents.runtime_auth_profile_id be checked against the agent's
        // runtime in one FK-shaped predicate (profile belongs to this runtime).
        runtimeProfileUnique: uniqueIndex(
            'runtime_auth_profiles_runtime_id_id_uq'
        ).on(table.runtimeId, table.id)
    })
)

export type RuntimeAuthProfileRow = typeof runtimeAuthProfiles.$inferSelect
export type NewRuntimeAuthProfileRow = typeof runtimeAuthProfiles.$inferInsert
