import {
    integer,
    foreignKey,
    bigint,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentRuntimes } from './agentRuntimes'
import { userModelProviders } from './userModelProviders'
import { runtimeAuthProfiles } from './runtimeAuthProfiles'

export type FileRootTransport = 'pod-exec'

export interface FileRoot {
    id: string
    label: string
    path: string
    writable: boolean
    transport?: FileRootTransport
}

export interface AgentStorageBreakdown {
    formatVersion?: 1
    workspaceBytes: number
    homeBytes: number | null
    totalBytes: number | null
    measuredVia: 'df' | 'du' | 'stale'
}

// The agent's own lifecycle (ADR-0036). Whether it can run right now is not
// stored: it derives from its runtime's install state, the host's lifecycle
// and the host daemon's presence (agentAvailable in @manyfold/shared).
export type AgentLifecycleStatus = 'pending' | 'ready' | 'failed'

export const agents = pgTable(
    'agents',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        // No enum: an edition registers frameworks the core does not know
        // (ADR-0034).
        framework: text('framework').notNull(),
        status: text('status', {
            enum: ['pending', 'ready', 'failed']
        })
            .notNull()
            .default('pending')
            .$type<AgentLifecycleStatus>(),
        // The one execution home. Machine, provider and daemon are one hop
        // away through the runtime's host; nothing is copied here.
        runtimeId: text('runtime_id')
            .notNull()
            .references(() => agentRuntimes.id, {
                onDelete: 'cascade'
            }),
        internalId: text('internal_id').notNull(),
        model: text('model'),
        // FK declared below under its historical hand-written name: deployed
        // databases hold the constraint under that name (it predates the
        // drizzle baseline), and renaming buys nothing but schema/DB drift.
        modelProviderId: text('model_provider_id'),
        // Explicit runtime-local auth binding (runtime auth profiles). NULL =
        // ambient: the host's native sign-in, as before. RESTRICT on purpose —
        // deleting a profile must never silently move an agent onto another
        // account; the service unbinds first or refuses.
        runtimeAuthProfileId: text('runtime_auth_profile_id').references(
            () => runtimeAuthProfiles.id,
            { onDelete: 'restrict' }
        ),
        // CAS token for binding updates: two tabs cannot overwrite each other.
        runtimeAuthBindingVersion: integer('runtime_auth_binding_version')
            .notNull()
            .default(0),
        extras: jsonb('extras')
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        workspacePath: text('workspace_path'),
        mountPath: text('mount_path').notNull().default('/workspace'),
        storageBytes: bigint('storage_bytes', { mode: 'number' }),
        storageMeasuredAt: timestamp('storage_measured_at', {
            withTimezone: true
        }),
        storageBreakdown: jsonb('storage_breakdown').$type<AgentStorageBreakdown>(),
        fileRoots: jsonb('file_roots')
            .$type<FileRoot[]>()
            .notNull()
            .default([]),
        currentPhase: text('current_phase'),
        failureReason: text('failure_reason'),
        startedAt: timestamp('started_at', { withTimezone: true }),
        lastBootstrappedAt: timestamp('last_bootstrapped_at', {
            withTimezone: true
        }),
        lastReconciledAt: timestamp('last_reconciled_at', {
            withTimezone: true
        }),
        // Last time a prompt (user turn) was sent to this agent. Distinct from
        // the started/bootstrapped/reconciled trio, which reconcile re-stamps
        // on every liveness observation and so never reflects real usage.
        lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        runtimeInternalUnique: uniqueIndex('agents_runtime_internal_unique').on(
            table.runtimeId,
            table.internalId
        ),
        modelProviderIdx: index('agents_model_provider_idx').on(
            table.modelProviderId
        ),
        modelProviderFk: foreignKey({
            columns: [table.modelProviderId],
            foreignColumns: [userModelProviders.id],
            name: 'agents_model_provider_id_fkey'
        }).onDelete('set null'),
        runtimeIdx: index('agents_runtime_id_idx').on(table.runtimeId),
        runtimeAuthProfileIdx: index('agents_runtime_auth_profile_idx').on(
            table.runtimeAuthProfileId
        )
    })
)

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
