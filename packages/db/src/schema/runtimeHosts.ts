import {
    bigint,
    boolean,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { spritesAccounts } from './spritesAccounts'

// sandbox-only: one measurement of the whole sprite VM, taken inside the VM.
// vmUsedBytes is the rootfs df reading — sprites.dev bills per-VM rootfs, so
// this (not a per-agent sum) is what the storage meter aggregates. homes are
// per-framework config dirs (~/.claude …) shared by that framework's agents on
// the VM; workspaces are the per-agent `<mountPath>/<agentId>` dirs. Both list
// only the dirs that actually returned a reading, so a missing entry means
// "not measured" rather than 0.
//
// 'stale' is the parser's "nothing came back" verdict and is never persisted —
// a failed measurement leaves the previous row untouched.
export interface SandboxStorageBreakdown {
    vmUsedBytes: number
    homes: { framework: string; bytes: number }[]
    workspaces: { agentId: string; bytes: number }[]
    measuredVia: 'df' | 'du' | 'stale'
}

export interface DetectedFramework {
    framework:
        | 'claude-code'
        | 'codex'
        | 'gemini-cli'
        | 'openclaw'
        | 'hermes'
    version: string | null
    path: string
}

export const runtimeHosts = pgTable(
    'runtime_hosts',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        // Discriminator: 'daemon' = registered local machine, 'sandbox' = sprite
        // VM. Both share this machine table so one host can carry many
        // per-framework agent_runtimes. Defaults to 'daemon' so the existing
        // daemon register/heartbeat inserts need no change.
        kind: text('kind', {
            enum: ['daemon', 'sandbox']
        })
            .notNull()
            .default('daemon'),
        // daemon-only; null for sandbox hosts (the unique index below treats
        // null as distinct so many sandbox rows per user coexist).
        daemonUuid: text('daemon_uuid'),
        name: text('name').notNull(),
        hostname: text('hostname'),
        os: text('os'),
        arch: text('arch'),
        cliVersion: text('cli_version'),
        startupMethod: text('startup_method', {
            enum: [
                'launchd-user',
                'launchd-system',
                'systemd-user',
                'systemd-system',
                'manual'
            ]
        }),
        homeDir: text('home_dir'),
        workspaceBaseDir: text('workspace_base_dir'),
        skillsDir: text('skills_dir'),
        detectedFrameworks: jsonb('detected_frameworks')
            .$type<DetectedFramework[]>()
            .notNull()
            .default([]),
        clientFeatures: jsonb('client_features')
            .$type<string[]>()
            .notNull()
            .default([]),
        terminalPty: boolean('terminal_pty'),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
        rpcInstanceId: text('rpc_instance_id'),
        rpcInbox: text('rpc_inbox'),
        rpcConnectedAt: timestamp('rpc_connected_at', { withTimezone: true }),
        rpcLastSeenAt: timestamp('rpc_last_seen_at', { withTimezone: true }),
        lastIp: text('last_ip'),
        status: text('status', {
            enum: ['active', 'offline', 'revoked']
        })
            .notNull()
            .default('active'),
        // sandbox-only (kind='sandbox'): the sprite VM identity + owning account.
        // Null for daemon hosts.
        accountId: text('account_id').references(() => spritesAccounts.id, {
            onDelete: 'set null'
        }),
        spriteName: text('sprite_name'),
        spriteId: text('sprite_id'),
        // Whose identity the VM's persisted shell profile defaults to (bare
        // interactive shells only — per-agent auth is injected per-exec).
        primaryAgentId: text('primary_agent_id'),
        // sandbox-only: the VM running/warm/cold state. Host-level source of
        // truth for concurrency counters (a sandbox can run with zero agents);
        // null until the first status sync writes it.
        spriteStatus: text('sprite_status', {
            enum: ['cold', 'warm', 'running']
        }),
        // sandbox-only: opt-in terminal, off by default globally. Enabling
        // injects the user's api.full token per terminal session.
        terminalEnabled: boolean('terminal_enabled').notNull().default(false),
        // sandbox-only: a SECOND, separate consent — off by default. Enabling
        // lets a terminal session carry the agent's model-provider credentials
        // so the framework CLI's interactive TUI can resume a chat session.
        // Deliberately not folded into terminal_enabled: that one exposes the
        // user's own api.full token, this one exposes a provider key the API
        // otherwise only ever returns masked, so the two are consented apart.
        // Only claude-code needs it — codex logs in on-disk at bootstrap.
        terminalModelCredentials: boolean('terminal_model_credentials')
            .notNull()
            .default(false),
        // sandbox-only: when the host last became agent-less (0 runtimes). Null
        // while occupied; set on emptying or standalone create. The reaper
        // deletes the VM once this is older than the 7-day cutoff.
        emptiedAt: timestamp('emptied_at', { withTimezone: true }),
        // sandbox-only: quarantine window after this VM's exec endpoint failed a
        // readiness probe. Automatic co-residence selection skips the host until
        // it passes; explicit attach still targets it. Persisted (not in-request)
        // because the failure that motivated it — one sprite backend 502ing every
        // exec handshake — otherwise re-selects the same VM on the very next
        // create. Null = never quarantined; past = cooled down.
        execCooldownUntil: timestamp('exec_cooldown_until', {
            withTimezone: true
        }),
        // sandbox-only: watermark = start of the still-unaccrued `running`
        // interval for active-duration metering. Set when the VM is observed or
        // committed running, advanced + settled into sandbox_active_durations on
        // each status sync, cleared (null) when not running. Compare-and-swapped
        // so concurrent API instances don't double-count. See
        // SandboxActiveDurationService.
        // precision 3 is load-bearing: the CAS compares this column against a
        // JS Date (ms). A µs value (e.g. from SQL now()) can never equal a ms
        // param, which permanently wedges the watermark — the column itself
        // must round every writer to ms.
        activeAccrualSince: timestamp('active_accrual_since', {
            withTimezone: true,
            precision: 3
        }),
        // sandbox-only: latest whole-VM storage measurement (see
        // SandboxStorageBreakdown). storageBytes is the meter-feeding value —
        // the storage quota sums this per host, matching sprites.dev's per-VM
        // rootfs billing.
        storageBytes: bigint('storage_bytes', { mode: 'number' }),
        storageMeasuredAt: timestamp('storage_measured_at', {
            withTimezone: true
        }),
        storageBreakdown: jsonb('storage_breakdown')
            .$type<SandboxStorageBreakdown>(),
        // The platform created and owns this host — it is not a machine the
        // user registered. Phase 3 sprite runners are daemon hosts we bring up
        // inside the user's own sprite, and `daemon register` additionally
        // creates one agent_runtime per framework it detects there. Without
        // this flag all of that shows up in the user's runtime list as if they
        // could build agents on it. Hidden from user-facing lists; admin
        // surfaces still see it.
        managed: boolean('managed').notNull().default(false),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userUuidUnique: uniqueIndex('runtime_hosts_user_uuid_unique').on(
            table.userId,
            table.daemonUuid
        )
    })
)

export type RuntimeHostRow = typeof runtimeHosts.$inferSelect
export type NewRuntimeHostRow = typeof runtimeHosts.$inferInsert
