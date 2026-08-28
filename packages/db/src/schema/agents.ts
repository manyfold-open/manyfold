import {
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
import { spritesAccounts } from './spritesAccounts'
import { k8sClusters } from './k8sClusters'
import { runtimeHosts } from './runtimeHosts'
import { agentRuntimes } from './agentRuntimes'
import { userModelProviders } from './userModelProviders'

export type FileRootTransport = 'dufs' | 'pod-exec'

export interface FileRoot {
    id: string
    label: string
    path: string
    writable: boolean
    transport?: FileRootTransport
}

export interface AgentStorageBreakdown {
    workspaceBytes: number
    homeBytes: number
    totalBytes: number
    measuredVia: 'df' | 'du' | 'stale'
}

export const agents = pgTable(
    'agents',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        framework: text('framework', {
            enum: [
                'openclaw',
                'hermes',
                'narranexus',
                'claude-code',
                'codex',
                'gemini-cli',
                'dify',
                'langflow',
                'a2a'
            ]
        }).notNull(),
        runtime: text('runtime', {
            enum: ['sprites', 'k8s', 'daemon', 'external']
        }).notNull(),
        status: text('status', {
            enum: ['pending', 'running', 'stopped', 'failed']
        })
            .notNull()
            .default('pending'),
        spriteStatus: text('sprite_status', {
            enum: ['cold', 'warm', 'running']
        }),
        k8sPodPhase: text('k8s_pod_phase'),
        accountId: text('account_id').references(() => spritesAccounts.id, {
            onDelete: 'set null'
        }),
        clusterId: text('cluster_id').references(() => k8sClusters.id, {
            onDelete: 'set null'
        }),
        daemonId: text('daemon_id').references(() => runtimeHosts.id, {
            onDelete: 'set null'
        }),
        // Denormalized machine FK (= runtime.hostId) so per-host occupancy and
        // active-slot counts avoid a join. Mirrors the existing daemonId denorm.
        hostId: text('host_id').references(() => runtimeHosts.id, {
            onDelete: 'set null'
        }),
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
        extras: jsonb('extras')
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        workspacePath: text('workspace_path'),
        spriteName: text('sprite_name'),
        spriteId: text('sprite_id'),
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
        namespace: text('namespace'),
        ingressHost: text('ingress_host'),
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
        // Daemon-scoped agent counts: GET /api/daemon/me and /api/daemon/hosts
        // group agents by daemon on every daemon poll (#607).
        daemonIdx: index('agents_daemon_id_idx').on(table.daemonId),
        // Per-host occupancy: the sandbox listings count agents per host via a
        // correlated subquery on host_id, once per sandbox row (#607).
        hostIdx: index('agents_host_id_idx').on(table.hostId)
    })
)

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
