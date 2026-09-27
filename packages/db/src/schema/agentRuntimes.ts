import {
    boolean,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { runtimeHosts } from './runtimeHosts'

// One framework installed on one host (ADR-0037). Where it runs, who owns the
// machine and how it is reached are all facts of the host row, never copied
// here: kind, provider identity and daemon connection are derived through
// host_id. The single exception is an external-API framework, which has no
// machine at all and keeps host_id null.
export type AgentRuntimeInstallStatus = 'installing' | 'ready' | 'failed'

export const agentRuntimes = pgTable(
    'agent_runtimes',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        // Display label, user-renamable; defaults to `<host name>-<framework>`.
        // Never an address — every lookup goes through art_ ids.
        name: text('name').notNull(),
        // No enum: an edition registers frameworks the core does not know
        // (ADR-0034).
        framework: text('framework').notNull(),
        // RESTRICT: a host is deleted only after its runtimes are gone, in the
        // same transaction that removed them.
        hostId: text('host_id').references(() => runtimeHosts.id, {
            onDelete: 'restrict'
        }),
        // Install state only. Availability is derived (runtimeAvailable in
        // @manyfold/shared) from this, the host's lifecycle and its daemon's
        // presence; nothing here flips on a daemon going away.
        status: text('status', {
            enum: ['installing', 'ready', 'failed']
        })
            .notNull()
            .default('installing')
            .$type<AgentRuntimeInstallStatus>(),
        currentPhase: text('current_phase'),
        failureReason: text('failure_reason'),
        // The framework's data root on the machine.
        mountPath: text('mount_path').notNull().default('/workspace'),
        capabilitiesJson: jsonb('capabilities_json')
            .$type<Record<string, unknown>>()
            .default({}),
        primaryAgentId: text('primary_agent_id'),
        // Pre-selected runtime auth profile for NEW agents only; changing it
        // never rebinds existing ones. No FK for the same reason as
        // primaryAgentId (runtimeAuthProfiles imports this table); the service
        // validates ownership and clears it when the profile is removed.
        defaultAuthProfileId: text('default_auth_profile_id'),
        controlUiEnabled: boolean('control_ui_enabled').notNull().default(true),
        dashboardEnabled: boolean('dashboard_enabled').notNull().default(false),
        // Dashboard toggle progress: 'enabling@<ISO>' | 'disabling@<ISO>' |
        // 'error:<reason>' | null (steady).
        dashboardState: text('dashboard_state'),
        serviceStatus: text('service_status', {
            enum: ['unknown', 'starting', 'ready', 'stopped']
        })
            .notNull()
            .default('unknown'),
        // When service_status was last asserted (boot report or platform
        // start/stop write).
        serviceStatusAt: timestamp('service_status_at', { withTimezone: true }),
        lastBootstrappedAt: timestamp('last_bootstrapped_at', {
            withTimezone: true
        }),
        // Installed agent-framework CLI version (e.g. claude/codex/gemini
        // --version output), probed at install / upgrade / manual refresh or
        // reported by the host's daemon inventory. Null = never probed.
        frameworkVersion: text('framework_version'),
        frameworkVersionCheckedAt: timestamp('framework_version_checked_at', {
            withTimezone: true
        }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        // Deliberately non-unique: names are display labels, not addresses.
        userNameIdx: index('agent_runtimes_user_name_idx').on(
            table.userId,
            table.name
        ),
        // One runtime per (host, framework), no status predicate: a failed
        // install keeps its slot and a retry reuses the row. External runtimes
        // (host_id null) are one-per-agent and do not take part.
        hostFrameworkUnique: uniqueIndex('agent_runtimes_host_framework_uq')
            .on(table.hostId, table.framework)
            .where(sql`${table.hostId} is not null`),
        hostIdx: index('agent_runtimes_host_id_idx').on(table.hostId)
    })
)

export type AgentRuntimeRow = typeof agentRuntimes.$inferSelect
export type NewAgentRuntimeRow = typeof agentRuntimes.$inferInsert
