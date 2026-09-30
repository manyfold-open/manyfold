import {
    bigint,
    boolean,
    check,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    index
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { runtimeProviders } from './runtimeProviders'

// hosted-only: one measurement of the whole machine, taken inside it.
// vmUsedBytes is the rootfs df reading — sprites.dev bills per-VM rootfs, so
// this (not a per-agent sum) is what the storage meter aggregates. homes are
// per-framework config dirs (~/.claude …) shared by that framework's agents on
// the machine; workspaces are the per-agent `<mountPath>/<agentId>` dirs. Both
// list only the dirs that actually returned a reading, so a missing entry
// means "not measured" rather than 0.
//
// 'stale' is the parser's "nothing came back" verdict and is never persisted —
// a failed measurement leaves the previous row untouched.
export interface SandboxStorageBreakdown {
    formatVersion?: 1
    vmUsedBytes: number
    homes: { framework: string; bytes: number; path?: string; agentIds?: string[]; attributedBytes?: number | null }[]
    workspaces: { agentId: string; bytes: number; attributedBytes?: number | null }[]
    attributionComplete?: boolean
    measuredVia: 'df' | 'du' | 'stale'
}

// ADR-0037: who owns the machine. `local` is a computer the user registered
// with their own `mf daemon`; `hosted` is a machine the platform provisioned
// on a runtime provider and whose daemon the platform brings up. Only
// provisioning code writes `hosted`; nothing a registering daemon reports
// participates in the decision.
export type RuntimeHostKind = 'local' | 'hosted'

// Lifecycle, distinct from power and from daemon presence.
//   provisioning: the provider is still creating the machine or its daemon
//                 has not registered yet
//   ready:        usable
//   failed:       provisioning failed (failure_reason says why)
//   deleting:     remote destroy requested but not yet confirmed
//   retired:      the user revoked it — token revoked, registration and
//                 WebSocket refused, only permanent deletion is left
export type RuntimeHostStatus =
    | 'provisioning'
    | 'ready'
    | 'failed'
    | 'deleting'
    | 'retired'

// hosted-only power observation as the provider adapter maps it (sprites:
// running / warm / cold → running / suspended / stopped).
export type RuntimeHostPowerState =
    | 'running'
    | 'suspended'
    | 'stopped'
    | 'unknown'

// Provider-defined machine identity and placement. Opaque to the core; the
// adapter for `provider_id`'s kind is the only reader and writer. Typed here
// so the two adapters that exist share one declaration.
export interface SpritesProviderRef {
    kind: 'sprites'
    spriteName: string
    spriteId: string | null
    // The public URL the sprite reports; its hostname carries the
    // organisation's suffix, so it is not derived from the name.
    url?: string | null
}

export interface K8sProviderRef {
    kind: 'k8s'
    namespace: string
    ingressHost: string | null
    podPhase: string | null
}

export type RuntimeHostProviderRef = SpritesProviderRef | K8sProviderRef

// The keep-awake switch's hold on the machine (ADR-0038), as the platform last
// confirmed it: when the task it holds expires unless renewed, when a hold or a
// release was last proven, and why the last attempt failed. null = no task the
// platform knows to be live.
export interface KeepAwakeLease {
    expiresAt: string | null
    verifiedAt: string | null
    lastError: string | null
}

export const runtimeHosts = pgTable(
    'runtime_hosts',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        kind: text('kind', { enum: ['local', 'hosted'] })
            .notNull()
            .$type<RuntimeHostKind>(),
        // hosted-only. RESTRICT: a provider that still owns machines cannot
        // be deleted.
        providerId: text('provider_id').references(() => runtimeProviders.id, {
            onDelete: 'restrict'
        }),
        providerRef: jsonb('provider_ref').$type<RuntimeHostProviderRef>(),
        // Display name; user-renamable. hosted defaults to a platform name
        // (`sandbox-NNN`), local to what the daemon reported.
        name: text('name').notNull(),
        status: text('status', {
            enum: ['provisioning', 'ready', 'failed', 'deleting', 'retired']
        })
            .notNull()
            .$type<RuntimeHostStatus>(),
        failureReason: text('failure_reason'),
        // Fence for provider mutations (create / bootstrap / destroy): every
        // adapter call is idempotent on (host, generation), and a callback
        // carrying an older generation is dropped.
        generation: integer('generation').notNull().default(0),
        powerState: text('power_state', {
            enum: ['running', 'suspended', 'stopped', 'unknown']
        }).$type<RuntimeHostPowerState>(),
        powerChangedAt: timestamp('power_changed_at', { withTimezone: true }),
        // The machine's filesystem contract, declared by its daemon at
        // registration (ADR-0014).
        homeDir: text('home_dir'),
        workspaceBaseDir: text('workspace_base_dir'),
        skillsDir: text('skills_dir'),
        // Capacity, provider-neutral; null on local hosts.
        cpuMillicores: integer('cpu_millicores'),
        memoryMb: integer('memory_mb'),
        diskGb: integer('disk_gb'),
        region: text('region'),
        // hosted-only: keep the machine running. The single keep-alive
        // switch; service processes are the daemon's service manifest's job.
        keepAwake: boolean('keep_awake').notNull().default(false),
        keepAwakeLease: jsonb('keep_awake_lease').$type<KeepAwakeLease>(),
        // hosted-only: opt-in terminal, off by default globally. Enabling
        // injects the user's api.full token per terminal session.
        terminalEnabled: boolean('terminal_enabled').notNull().default(false),
        // hosted-only: a SECOND, separate consent — off by default. Enabling
        // lets a terminal session carry the agent's model-provider credentials
        // so the framework CLI's interactive TUI can resume a chat session.
        terminalModelCredentials: boolean('terminal_model_credentials')
            .notNull()
            .default(false),
        // hosted-only: when the host last became agent-less (0 runtimes).
        // Null while occupied; set on emptying or standalone create. The
        // reaper deletes the machine once this is older than the 7-day cutoff.
        emptiedAt: timestamp('emptied_at', { withTimezone: true }),
        // hosted-only: quarantine window after the machine's exec endpoint
        // failed a readiness probe. Automatic co-residence selection skips the
        // host until it passes; explicit attach still targets it.
        execCooldownUntil: timestamp('exec_cooldown_until', {
            withTimezone: true
        }),
        // hosted-only: watermark = start of the still-unaccrued `running`
        // interval for active-duration metering. Compare-and-swapped so
        // concurrent API instances don't double-count. precision 3 is
        // load-bearing: the CAS compares this column against a JS Date (ms).
        activeAccrualSince: timestamp('active_accrual_since', {
            withTimezone: true,
            precision: 3
        }),
        // hosted-only: latest whole-machine storage measurement.
        storageBytes: bigint('storage_bytes', { mode: 'number' }),
        storageMeasuredAt: timestamp('storage_measured_at', {
            withTimezone: true
        }),
        storageBreakdown: jsonb('storage_breakdown')
            .$type<SandboxStorageBreakdown>(),
        storageAttemptId: text('storage_attempt_id'),
        storageLeaseUntil: timestamp('storage_lease_until', { withTimezone: true }),
        storageRetryAt: timestamp('storage_retry_at', { withTimezone: true }),
        storageFailureCount: integer('storage_failure_count').notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        storageAttemptLease: check('runtime_hosts_storage_attempt_lease', sql`(${table.storageAttemptId} is null) = (${table.storageLeaseUntil} is null)`),
        storageFailuresNonnegative: check('runtime_hosts_storage_failures_nonnegative', sql`${table.storageFailureCount} >= 0`),
        // Only hosted hosts carry a provider; a local host never does.
        providerByKind: check(
            'runtime_hosts_provider_by_kind',
            sql`(${table.kind} = 'hosted') = (${table.providerId} is not null)`
        ),
        userKindIdx: index('runtime_hosts_user_kind_idx').on(
            table.userId,
            table.kind
        ),
        providerIdx: index('runtime_hosts_provider_id_idx').on(table.providerId)
    })
)

export type RuntimeHostRow = typeof runtimeHosts.$inferSelect
export type NewRuntimeHostRow = typeof runtimeHosts.$inferInsert
