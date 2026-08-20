import {
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { spritesAccounts } from './spritesAccounts'
import { k8sClusters } from './k8sClusters'
import { runtimeHosts } from './runtimeHosts'

export const agentRuntimes = pgTable(
    'agent_runtimes',
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
        kind: text('kind', {
            enum: ['sprites', 'k8s', 'daemon', 'external']
        }).notNull(),
        status: text('status', {
            enum: ['pending', 'ready', 'failed', 'stopped']
        })
            .notNull()
            .default('pending'),
        currentPhase: text('current_phase'),
        failureReason: text('failure_reason'),
        accountId: text('account_id').references(() => spritesAccounts.id, {
            onDelete: 'set null'
        }),
        spriteName: text('sprite_name'),
        spriteId: text('sprite_id'),
        clusterId: text('cluster_id').references(() => k8sClusters.id, {
            onDelete: 'set null'
        }),
        daemonId: text('daemon_id').references(() => runtimeHosts.id, {
            onDelete: 'set null'
        }),
        // Unified machine FK (runtime_hosts row, kind daemon|sandbox). For daemon
        // runtimes this equals daemonId; for sprites it points at the sandbox VM
        // host so one VM can carry many per-framework runtimes. daemonId is kept
        // as a redundant daemon-only FK (the daemon RPC route id); not retired.
        hostId: text('host_id').references(() => runtimeHosts.id, {
            onDelete: 'set null'
        }),
        homeDir: text('home_dir'),
        workspaceBaseDir: text('workspace_base_dir'),
        capabilitiesJson: jsonb('capabilities_json')
            .$type<Record<string, unknown>>()
            .default({}),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
        namespace: text('namespace'),
        ingressHost: text('ingress_host'),
        mountPath: text('mount_path').notNull().default('/workspace'),
        primaryAgentId: text('primary_agent_id'),
        controlUiEnabled: boolean('control_ui_enabled').notNull().default(true),
        dashboardEnabled: boolean('dashboard_enabled').notNull().default(false),
        // Dashboard toggle state machine + CAS mutex. Grammar:
        // 'enabling@<ISO>' | 'disabling@<ISO>' | 'error:<reason>' | NULL (steady).
        // The claim timestamp lives INSIDE the value because updatedAt is
        // refreshed by unrelated writes (service reports) and can't detect
        // stale in-flight toggles.
        dashboardState: text('dashboard_state'),
        keepAliveEnabled: boolean('keep_alive_enabled').notNull().default(false),
        serviceStatus: text('service_status', {
            enum: ['unknown', 'starting', 'ready', 'stopped']
        })
            .notNull()
            .default('unknown'),
        // When service_status was last asserted (sprite boot report or platform
        // start/stop write); lastSeenAt stays daemon-owned (daemon-runtime-sync)
        // — two timestamps, two owners.
        serviceStatusAt: timestamp('service_status_at', { withTimezone: true }),
        // skuId NULL = legacy grandfathered runtime (pre-container-purchase model). UI treats these as read-only.
        // Opaque cloud-owned id, deliberately WITHOUT an FK to container_skus:
        // that table lives in the cloud journal and core → cloud constraints
        // are forbidden (editions §4.1; the historical FK — onDelete set null —
        // was dropped in 0175, so sku deletion no longer nulls this column).
        skuId: text('sku_id'),
        cpuMillicores: integer('cpu_millicores'),
        memoryMb: integer('memory_mb'),
        diskGb: integer('disk_gb'),
        region: text('region'),
        purchasedAt: timestamp('purchased_at', { withTimezone: true }),
        startedAt: timestamp('started_at', { withTimezone: true }),
        lastBootstrappedAt: timestamp('last_bootstrapped_at', {
            withTimezone: true
        }),
        // Installed agent-framework CLI version (e.g. claude/codex/gemini
        // --version output), probed at bootstrap / upgrade / manual refresh.
        // Null = never probed. checkedAt drives the "refresh" freshness hint.
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
        // Deliberately non-unique: names are display labels, not addresses
        // (every lookup goes through art_ ids), and auto-generated labels
        // derive from host names which are themselves not unique. Kept as an
        // index because it is the only user_id-prefixed one on this table.
        userNameIdx: index('agent_runtimes_user_name_idx').on(
            table.userId,
            table.name
        ),
        // At most one live runtime per (sandbox host, framework): co-residence
        // puts different frameworks on one VM, never two of the same. Backstops
        // ensureSandboxHost against concurrent creates racing the capacity check.
        spriteHostFrameworkUnique: uniqueIndex(
            'agent_runtimes_sprite_host_framework_uq'
        )
            .on(table.hostId, table.framework)
            .where(
                sql`${table.kind} = 'sprites' and ${table.status} not in ('failed', 'stopped')`
            ),
        // Daemon runtime listings: /api/daemon/me, /api/daemon/hosts and the
        // heartbeat runtime sync all load runtimes by daemon_id (#607).
        daemonIdx: index('agent_runtimes_daemon_id_idx').on(table.daemonId)
    })
)

export type AgentRuntimeRow = typeof agentRuntimes.$inferSelect
export type NewAgentRuntimeRow = typeof agentRuntimes.$inferInsert
