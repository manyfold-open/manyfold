import { createHash } from 'node:crypto'
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    hostDaemons,
    runtimeHosts,
    serviceLeases,
    userConnections,
    jsonbMerge,
    type Agent,
    type Database,
    type AgentRuntimeRow,
    type HostDaemonRow,
    type RuntimeHostRow,
    type UserConnectionRow
} from '@manyfold/db'
import {
    createObjectId,
    DAEMON_FEATURE_FS_CONFIG_COMMIT,
    mcpConfigFromExtras
} from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import {
    DaemonRegistryService,
    storedConfigConnectionToken,
    type DaemonHelloEvidence
} from './daemon-registry.service'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Reader = Pick<Database, 'select'>
export const DAEMON_CONFIG_LEASE_MS = 120_000
export const daemonConfigLeaseName = (hostId: string): string =>
    `daemon-config:${hostId}`
export const configDigest = (value: unknown): string =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class DaemonConfigDeliveryError extends Error {
    constructor(
        readonly reason:
            | 'busy'
            | 'offline'
            | 'superseded'
            | 'changed'
            | 'unsupported'
            | 'failed'
            | 'persistence'
            | 'cancelled'
    ) {
        super(`daemon configuration ${reason}`)
        this.name = 'DaemonConfigDeliveryError'
    }
}
export interface DaemonConfigSnapshot {
    agent: Agent
    runtime: AgentRuntimeRow
    // The machine the agent's runtime lives on (ADR-0037): its daemon is
    // the delivery target and its declared home is where config lands.
    host: RuntimeHostRow
    homeDir: string | null
    connections: UserConnectionRow[]
    revision(kind: 'mcp' | 'context', version?: number): string
}

const isDeliverableHost = (host: RuntimeHostRow): boolean =>
    host.status !== 'retired' && host.status !== 'deleting'

export const readDaemonConfigSnapshot = async (
    db: Reader,
    agentId: string,
    lock = false
): Promise<DaemonConfigSnapshot> => {
    const query = db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
    const [agent] = await (lock ? query.for('update') : query)
    if (!agent) throw new DaemonConfigDeliveryError('unsupported')
    const runtimeQuery = db
        .select()
        .from(agentRuntimes)
        .where(
            and(
                eq(agentRuntimes.id, agent.runtimeId),
                eq(agentRuntimes.userId, agent.userId)
            )
        )
        .limit(1)
    const [runtime] = await (lock ? runtimeQuery.for('share') : runtimeQuery)
    // An external runtime has no machine and nothing to deliver to.
    if (!runtime?.hostId) throw new DaemonConfigDeliveryError('unsupported')
    const hostQuery = db
        .select()
        .from(runtimeHosts)
        .where(
            and(
                eq(runtimeHosts.id, runtime.hostId),
                eq(runtimeHosts.userId, agent.userId)
            )
        )
        .limit(1)
    const [host] = await (lock ? hostQuery.for('share') : hostQuery)
    if (!host) throw new DaemonConfigDeliveryError('unsupported')
    const refs = [
        'githubConnectionId',
        'cloudflareConnectionId',
        'composioConnectionId'
    ].map(
        (key) =>
            [
                key,
                typeof agent.extras[key] === 'string'
                    ? (agent.extras[key] as string)
                    : null
            ] as const
    )
    const ids = refs.flatMap(([, value]) => (value ? [value] : []))
    let connections: UserConnectionRow[] = []
    if (ids.length) {
        const connectionQuery = db
            .select()
            .from(userConnections)
            .where(
                and(
                    eq(userConnections.userId, agent.userId),
                    inArray(userConnections.id, ids)
                )
            )
        connections = await (lock
            ? connectionQuery.for('share')
            : connectionQuery)
    }
    connections.sort((a, b) => a.id.localeCompare(b.id))
    const target = [
        agent.id,
        agent.userId,
        agent.framework,
        host.id,
        agent.runtimeId,
        host.homeDir,
        agent.workspacePath ?? agent.mountPath
    ]
    return {
        agent,
        runtime,
        host,
        homeDir: host.homeDir,
        connections,
        revision: (kind, version) => {
            const included =
                kind === 'mcp'
                    ? connections.filter(
                          (row) =>
                              row.id === agent.extras.composioConnectionId &&
                              row.provider === 'composio'
                      )
                    : connections
            const source = included.map((row) => [
                row.id,
                row.provider,
                row.externalId,
                row.displayName,
                row.metadata,
                row.revokedAt,
                row.updatedAt,
                ...(kind === 'mcp'
                    ? [row.secretCiphertext, row.keyVersion]
                    : [])
            ])
            const mcp = Object.entries(mcpConfigFromExtras(agent.extras)).sort(
                ([a], [b]) => a.localeCompare(b)
            )
            return configDigest([
                kind,
                version ?? 1,
                target,
                kind === 'mcp'
                    ? [mcp, agent.extras.composioConnectionId ?? null]
                    : refs,
                source
            ])
        }
    }
}

export interface DaemonConfigAttempt {
    generation: string
    holderId: string
    signal: AbortSignal
    protectedWrites: boolean
    expectedConnection: string | undefined
    assertCurrent(): Promise<void>
    publish(
        snapshot: DaemonConfigSnapshot,
        kind: 'mcp' | 'context',
        patch: Record<string, unknown>,
        version?: number
    ): Promise<boolean>
}

export interface DaemonConfigDeliveryOptions {
    automatic?: boolean
    evidence?: DaemonHelloEvidence
    signal?: AbortSignal
}

@Injectable()
export class DaemonConfigDeliveryService implements OnModuleDestroy {
    private readonly active = new Map<
        string,
        { abort: AbortController; done: Promise<unknown> }
    >()
    private stopping = false
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly registry: DaemonRegistryService
    ) {}

    async onModuleDestroy(): Promise<void> {
        this.stopping = true
        for (const { abort } of this.active.values()) abort.abort()
        await Promise.allSettled(
            [...this.active.values()].map(({ done }) => done)
        )
    }

    private transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
            )
            return work(tx)
        })
    }

    // The agent's host through its runtime: the routing key for every
    // delivery (ADR-0037 R9).
    private async hostIdFor(agent: Agent): Promise<string | null> {
        const [row] = await this.db
            .select({ hostId: agentRuntimes.hostId })
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.id, agent.runtimeId),
                    eq(agentRuntimes.userId, agent.userId)
                )
            )
            .limit(1)
        return row?.hostId ?? null
    }

    async deliver<T>(
        agent: Agent,
        work: (
            snapshot: DaemonConfigSnapshot,
            attempt: DaemonConfigAttempt
        ) => Promise<T>,
        options: DaemonConfigDeliveryOptions = {}
    ): Promise<T> {
        if (this.stopping) throw new DaemonConfigDeliveryError('cancelled')
        const hostId = await this.hostIdFor(agent)
        if (!hostId) throw new DaemonConfigDeliveryError('unsupported')
        const holderId = createObjectId('daemonConfigAttempt')
        const abort = new AbortController()
        const cancel = () => abort.abort()
        if (options.signal?.aborted)
            throw new DaemonConfigDeliveryError('cancelled')
        options.signal?.addEventListener('abort', cancel, { once: true })
        const run = this.run(agent, hostId, holderId, abort, work, options)
        this.active.set(holderId, { abort, done: run })
        try {
            return await run
        } finally {
            this.active.delete(holderId)
            options.signal?.removeEventListener('abort', cancel)
        }
    }

    // The host row and its daemon connection, locked for share so a retire
    // or a lease change waits on the delivery's writes.
    private async lockHost(
        tx: Tx,
        hostId: string,
        userId: string
    ): Promise<{ host: RuntimeHostRow; daemon: HostDaemonRow | null } | null> {
        const [host] = await tx
            .select()
            .from(runtimeHosts)
            .where(
                and(eq(runtimeHosts.id, hostId), eq(runtimeHosts.userId, userId))
            )
            .for('share')
        if (!host) return null
        const [daemon] = await tx
            .select()
            .from(hostDaemons)
            .where(eq(hostDaemons.hostId, hostId))
            .for('share')
        return { host, daemon: daemon ?? null }
    }

    private async run<T>(
        agent: Agent,
        hostId: string,
        holderId: string,
        abort: AbortController,
        work: (
            snapshot: DaemonConfigSnapshot,
            attempt: DaemonConfigAttempt
        ) => Promise<T>,
        options: DaemonConfigDeliveryOptions
    ): Promise<T> {
        const name = daemonConfigLeaseName(hostId)
        const claimed = await this.transaction(async (tx) => {
            const locked = await this.lockHost(tx, hostId, agent.userId)
            if (!locked) throw new DaemonConfigDeliveryError('unsupported')
            const { host, daemon } = locked
            if (!isDeliverableHost(host) || abort.signal.aborted)
                throw new DaemonConfigDeliveryError('cancelled')
            if (
                options.evidence &&
                !this.registry.isCurrentHelloEvidence(hostId, options.evidence)
            )
                throw new DaemonConfigDeliveryError('superseded')
            const token = daemon ? storedConfigConnectionToken(daemon) : undefined
            if (daemon?.rpcInstanceId && !token)
                throw new DaemonConfigDeliveryError('unsupported')
            if (
                options.automatic &&
                (!token ||
                    this.registry.localConfigConnectionToken(hostId) !== token)
            )
                throw new DaemonConfigDeliveryError('superseded')
            const [row] = await tx
                .insert(serviceLeases)
                .values({
                    name,
                    holderId,
                    acquiredAt: sql`clock_timestamp()`,
                    updatedAt: sql`clock_timestamp()`,
                    expiresAt: sql`clock_timestamp() + ${DAEMON_CONFIG_LEASE_MS} * interval '1 millisecond'`
                })
                .onConflictDoUpdate({
                    target: serviceLeases.name,
                    set: {
                        holderId,
                        acquiredAt: sql`greatest(clock_timestamp(), ${serviceLeases.acquiredAt} + interval '1 microsecond')`,
                        updatedAt: sql`clock_timestamp()`,
                        expiresAt: sql`clock_timestamp() + ${DAEMON_CONFIG_LEASE_MS} * interval '1 millisecond'`
                    },
                    setWhere: sql`${serviceLeases.expiresAt} <= clock_timestamp()`
                })
                .returning({
                    generation: sql<string>`(extract(epoch from ${serviceLeases.acquiredAt}) * 1000000)::numeric(30,0)::text`
                })
            if (!row) throw new DaemonConfigDeliveryError('busy')
            return { ...row, host, daemon }
        })
        const expectedConnection = claimed.daemon
            ? storedConfigConnectionToken(claimed.daemon)
            : undefined
        const liveFeatures = this.registry.currentHelloFeatures(
            hostId,
            options.evidence
        )
        const protectedWrites = (
            liveFeatures ??
            claimed.daemon?.clientFeatures ??
            []
        ).includes(DAEMON_FEATURE_FS_CONFIG_COMMIT)
        const assertCurrent = async () => {
            if (abort.signal.aborted)
                throw new DaemonConfigDeliveryError('cancelled')
            if (!expectedConnection) throw new DaemonConfigDeliveryError('offline')
            if (
                options.evidence &&
                !this.registry.isCurrentHelloEvidence(hostId, options.evidence)
            )
                throw new DaemonConfigDeliveryError('superseded')
            const [row] = await this.transaction(async (tx) =>
                tx
                    .select({ name: serviceLeases.name })
                    .from(serviceLeases)
                    .innerJoin(runtimeHosts, eq(runtimeHosts.id, hostId))
                    .innerJoin(hostDaemons, eq(hostDaemons.hostId, hostId))
                    .where(
                        and(
                            eq(serviceLeases.name, name),
                            eq(serviceLeases.holderId, holderId),
                            sql`${serviceLeases.expiresAt} > clock_timestamp()`,
                            eq(runtimeHosts.userId, agent.userId),
                            sql`${runtimeHosts.status} not in ('retired', 'deleting')`,
                            eq(
                                hostDaemons.rpcInstanceId,
                                claimed.daemon!.rpcInstanceId!
                            ),
                            eq(hostDaemons.rpcConnectionToken, expectedConnection)
                        )
                    )
            )
            if (!row) {
                abort.abort()
                throw new DaemonConfigDeliveryError('superseded')
            }
        }
        const deadline = setTimeout(() => abort.abort(), 90_000)
        deadline.unref()
        const stopRetirement = this.registry.onConnectionRetired(
            (id, token) => {
                if (
                    id === hostId &&
                    options.evidence?.connectionToken === token
                )
                    abort.abort()
            }
        )
        try {
            const snapshot = await this.transaction((tx) =>
                readDaemonConfigSnapshot(tx, agent.id)
            )
            if (
                snapshot.agent.userId !== agent.userId ||
                snapshot.host.id !== hostId
            )
                throw new DaemonConfigDeliveryError('changed')
            return await work(snapshot, {
                generation: claimed.generation,
                holderId,
                signal: abort.signal,
                protectedWrites,
                expectedConnection,
                assertCurrent,
                publish: (source, kind, patch, version) =>
                    this.transaction(async (tx) => {
                        // Match admission's host-before-lease lock order.
                        const locked = await this.lockHost(
                            tx,
                            hostId,
                            agent.userId
                        )
                        if (
                            !locked ||
                            !isDeliverableHost(locked.host) ||
                            locked.daemon?.rpcInstanceId !==
                                claimed.daemon?.rpcInstanceId ||
                            (locked.daemon
                                ? storedConfigConnectionToken(locked.daemon)
                                : undefined) !== expectedConnection
                        )
                            return false
                        const [lease] = await tx
                            .select()
                            .from(serviceLeases)
                            .where(
                                and(
                                    eq(serviceLeases.name, name),
                                    eq(serviceLeases.holderId, holderId),
                                    sql`${serviceLeases.expiresAt} > clock_timestamp()`
                                )
                            )
                            .for('update')
                        if (
                            !lease ||
                            abort.signal.aborted ||
                            (options.evidence &&
                                !this.registry.isCurrentHelloEvidence(
                                    hostId,
                                    options.evidence
                                ))
                        )
                            return false
                        const latest = await readDaemonConfigSnapshot(
                            tx,
                            source.agent.id,
                            true
                        )
                        if (
                            latest.revision(kind, version) !==
                            source.revision(kind, version)
                        )
                            return false
                        await tx
                            .update(agents)
                            .set({ extras: jsonbMerge(agents.extras, patch) })
                            .where(eq(agents.id, source.agent.id))
                        return true
                    })
            })
        } finally {
            clearTimeout(deadline)
            stopRetirement()
            await this.transaction(async (tx) => {
                await tx
                    .update(serviceLeases)
                    .set({
                        expiresAt: sql`clock_timestamp()`,
                        updatedAt: sql`clock_timestamp()`
                    })
                    .where(
                        and(
                            eq(serviceLeases.name, name),
                            eq(serviceLeases.holderId, holderId)
                        )
                    )
            })
        }
    }
}
