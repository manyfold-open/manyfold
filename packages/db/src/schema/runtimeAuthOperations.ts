import {
    index,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentRuntimes } from './agentRuntimes'
import { runtimeAuthProfiles } from './runtimeAuthProfiles'

// One host-auth mutation (login / logout / remove) as a durable, idempotent
// record: the API mints it before touching the host, the host journals the
// same id, and a lost ack is resolved by re-reading the host's journal rather
// than by calling the vendor again. Carries result codes only — never an
// OAuth code, token, or vendor error body.
export const runtimeAuthOperations = pgTable(
    'runtime_auth_operations',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        runtimeId: text('runtime_id')
            .notNull()
            .references(() => agentRuntimes.id, { onDelete: 'cascade' }),
        profileId: text('profile_id')
            .notNull()
            .references(() => runtimeAuthProfiles.id, { onDelete: 'cascade' }),
        kind: text('kind', { enum: ['login', 'logout', 'remove'] }).notNull(),
        status: text('status', {
            enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled']
        })
            .notNull()
            .default('pending'),
        // Client-supplied idempotency key; a retry with the same key returns
        // the same operation instead of starting a second vendor flow.
        requestId: text('request_id'),
        resultCode: text('result_code'),
        error: text('error'),
        revoke: text('revoke', { enum: ['revoked', 'local-only', 'unknown'] }),
        deadlineAt: timestamp('deadline_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        profileIdx: index('runtime_auth_operations_profile_idx').on(
            table.profileId
        ),
        requestUnique: uniqueIndex(
            'runtime_auth_operations_profile_kind_request_uq'
        ).on(table.profileId, table.kind, table.requestId)
    })
)

export type RuntimeAuthOperationRow = typeof runtimeAuthOperations.$inferSelect
export type NewRuntimeAuthOperationRow =
    typeof runtimeAuthOperations.$inferInsert
