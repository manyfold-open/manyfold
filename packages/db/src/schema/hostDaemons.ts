import {
    boolean,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { runtimeHosts } from './runtimeHosts'
import { daemonTokens } from './daemonTokens'

export interface DetectedFramework {
    framework:
        | 'claude-code'
        | 'codex'
        | 'gemini-cli'
        | 'pi'
        | 'antigravity-cli'
        | 'openclaw'
        | 'hermes'
    version: string | null
    path: string
    // Set by the API on an entry it probed itself, never by a daemon; mirrors
    // DetectedFramework.probedAt in @manyfold/shared.
    probedAt?: string
    // openclaw only: the resident gateway the daemon discovered on the host
    // (never started). Mirrors DetectedOpenclawGateway in @manyfold/shared,
    // restated here because the db package cannot depend on shared. The API
    // reads it to admit or refuse an openclaw ACP turn, so the column's type
    // has to carry it.
    gateway?: {
        port: number | null
        reachable: boolean | null
        checkedAt: string
    }
}

// The one `mf daemon` connection a host has (ADR-0037): identity, version,
// capabilities, software inventory, presence and RPC routing. Keyed by the
// host, so the routing key IS the host id and there is no second daemon
// identity. Absent row = never registered; a stale last_seen_at = offline.
// The 15s heartbeat writes only this table — the host row carries lifecycle
// and metering and is never touched by presence traffic.
export const hostDaemons = pgTable(
    'host_daemons',
    {
        hostId: text('host_id')
            .primaryKey()
            .references(() => runtimeHosts.id, { onDelete: 'cascade' }),
        // Denormalised from the host so the (user, daemon uuid) uniqueness a
        // re-registering self-owned computer relies on is one index.
        userId: text('user_id').notNull(),
        // The identity the daemon persisted in its own config dir. A local
        // host is found again by it; a hosted host is found by its bound
        // token, and a fresh uuid simply replaces the connection.
        daemonUuid: text('daemon_uuid').notNull(),
        tokenId: text('token_id').references(() => daemonTokens.id, {
            onDelete: 'set null'
        }),
        hostname: text('hostname'),
        os: text('os'),
        arch: text('arch'),
        cliVersion: text('cli_version'),
        // herdr's version on the machine (ADR-0031); null = not installed.
        herdrVersion: text('herdr_version'),
        startupMethod: text('startup_method', {
            enum: [
                'launchd-user',
                'launchd-system',
                'systemd-user',
                'systemd-system',
                'manual',
                'container'
            ]
        }),
        clientFeatures: jsonb('client_features')
            .$type<string[]>()
            .notNull()
            .default([]),
        terminalPty: boolean('terminal_pty'),
        // Software inventory as the daemon reports it. On a local host each
        // entry is mirrored into an agent_runtimes row; on a hosted host it
        // only informs install/upgrade decisions and never creates one.
        detectedFrameworks: jsonb('detected_frameworks')
            .$type<DetectedFramework[]>()
            .notNull()
            .default([]),
        registeredAt: timestamp('registered_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
        lastIp: text('last_ip'),
        rpcInstanceId: text('rpc_instance_id'),
        // Issuer instance + opaque connection UUID. Timestamps are not identities.
        rpcConnectionToken: text('rpc_connection_token'),
        rpcInbox: text('rpc_inbox'),
        rpcConnectedAt: timestamp('rpc_connected_at', { withTimezone: true }),
        rpcLastSeenAt: timestamp('rpc_last_seen_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userUuidUnique: uniqueIndex('host_daemons_user_uuid_unique').on(
            table.userId,
            table.daemonUuid
        )
    })
)

export type HostDaemonRow = typeof hostDaemons.$inferSelect
export type NewHostDaemonRow = typeof hostDaemons.$inferInsert
