import type {
    DaemonClientProcess,
    DaemonRpcMethod,
    DaemonStreamKind,
    DaemonWsFrame
} from '@manyfold/shared'
import { createHash, randomUUID } from 'node:crypto'
import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { WebSocket as WsClient } from 'ws'
import postgres from 'postgres'
import { and, eq, gt, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    type RuntimeHostRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { configString } from '@/common/config-alias'
import { daemonClientProcessFields } from './daemon-client-process'

export interface StreamRpcCallbacks {
    onEvent?: (kind: DaemonStreamKind, data: string, seq?: number) => void
}

export class DaemonRpcResponseError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DaemonRpcResponseError'
    }
}

interface PendingRpc {
    resolve: (payload: Record<string, unknown> | undefined) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
    onEvent?: StreamRpcCallbacks['onEvent']
}

interface DaemonConnection {
    token: string
    helloOrder: number
    clientFeatures?: string[]
    daemonId: string
    userId: string
    cliVersion: string | null
    hostname: string | null
    clientProcess?: DaemonClientProcess
    socket: WsClient
    pending: Map<string, PendingRpc>
    connectedAt: Date
}

export interface DaemonHelloEvidence {
    connectionToken: string
    helloOrder: number
}

export const storedConfigConnectionToken = (
    host: Pick<RuntimeHostRow, 'rpcInstanceId' | 'rpcConnectionToken'>
): string | undefined => {
    const token = host.rpcConnectionToken
    if (!token || !host.rpcInstanceId) return undefined
    const separator = token.lastIndexOf(':')
    return token.slice(0, separator) === host.rpcInstanceId &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token.slice(separator + 1))
        ? token : undefined
}

interface RemotePendingRpc {
    resolve: (payload: Record<string, unknown> | undefined) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
    ownerInbox: string
    onEvent?: StreamRpcCallbacks['onEvent']
}

interface ForwardedStream {
    localRefId: string
    cancel: () => void
    publishChain: Promise<void>
}

interface BrokerChunkBuffer {
    chunks: Buffer[]
    received: number
    total: number
    timer: NodeJS.Timeout
}

interface BrokerEnvelope {
    version: 1
    id: string
    seq: number
    total: number
    data: string
}

type BrokerMessage =
    | {
          type: 'request' | 'config-request'
          requestId: string
          replyInbox: string
          daemonId: string
          method: DaemonRpcMethod
          payload: Record<string, unknown>
          timeoutMs?: number
          stream: boolean
          refIdOverride?: string
          expectedConnection?: string
      }
    | {
          type: 'response'
          requestId: string
          ok: boolean
          error?: string
          errorSource?: 'daemon'
          payload?: Record<string, unknown>
      }
    | {
          type: 'event'
          requestId: string
          kind: DaemonStreamKind
          data: string
          seq?: number
      }
    | {
          type: 'cancel'
          requestId: string
          daemonId: string
      }
    | {
          type: 'disconnect'
          daemonId: string
          reason: string
      }

export interface BrokerAdapter {
    isOnline(daemonId: string): boolean | Promise<boolean>
    rpc(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
    }): Promise<Record<string, unknown> | undefined>
}

@Injectable()
export class DaemonRegistryService
    implements BrokerAdapter, OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(DaemonRegistryService.name)
    private readonly conns = new Map<string, DaemonConnection>()
    private readonly remotePending = new Map<string, RemotePendingRpc>()
    private readonly forwardedStreams = new Map<string, ForwardedStream>()
    private readonly brokerChunks = new Map<string, BrokerChunkBuffer>()
    private readonly instanceId: string
    private readonly inbox: string
    private brokerSql: ReturnType<typeof postgres> | null = null
    private brokerUnlisten: (() => Promise<void>) | null = null
    private readonly connectionRetirementListeners = new Set<
        (daemonId: string, connectionToken: string) => void
    >()
    private readonly retiredConnections = new WeakSet<DaemonConnection>()
    private readonly helloListeners = new Set<
        (daemonId: string, userId: string, evidence: DaemonHelloEvidence) => void
    >()
    private readonly connectionMutations = new Map<string, Promise<void>>()
    private stopping = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService
    ) {
        this.instanceId =
            configString(this.config, ['MF_API_INSTANCE_ID']) ||
            process.env.FLY_MACHINE_ID ||
            process.env.HOSTNAME ||
            randomUUID()
        this.inbox = brokerChannel(this.instanceId)
    }

    async onModuleInit(): Promise<void> {
        const url = this.config.get<string>('DATABASE_URL')
        if (!url) return
        await this.releaseOwnRpcLeases().catch((err) =>
            this.log.warn(
                `daemon rpc lease release on boot failed: ${(err as Error).message}`
            )
        )
        this.brokerSql = postgres(url, { max: 2, prepare: false })
        const listen = await this.brokerSql.listen(this.inbox, (raw) => {
            void this.handleBrokerEnvelope(raw).catch((err) =>
                this.log.warn(
                    `daemon rpc broker message failed: ${(err as Error).message}`
                )
            )
        })
        this.brokerUnlisten = () => listen.unlisten()
        this.log.log(
            `daemon rpc broker listening instance=${this.instanceId} inbox=${this.inbox}`
        )
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true
        for (const conn of this.conns.values())
            this.notifyConnectionRetired(conn)
        this.connectionRetirementListeners.clear()
        this.helloListeners.clear()
        for (const [requestId, pending] of this.remotePending) {
            clearTimeout(pending.timer)
            pending.reject(new Error('daemon rpc broker shutting down'))
            this.remotePending.delete(requestId)
        }
        for (const [, buffer] of this.brokerChunks) clearTimeout(buffer.timer)
        this.brokerChunks.clear()
        while (this.connectionMutations.size)
            await Promise.allSettled([...this.connectionMutations.values()])
        if (this.brokerUnlisten) await this.brokerUnlisten().catch(() => {})
        if (this.brokerSql)
            await this.brokerSql.end({ timeout: 5 }).catch(() => {})
    }

    async register(args: {
        daemonId: string
        userId: string
        cliVersion: string | null
        hostname: string | null
        clientProcess?: DaemonClientProcess
        clientFeatures?: string[]
        socket: WsClient
    }): Promise<void> {
        if (this.stopping) throw new Error('daemon registry shutting down')
        const existing = this.conns.get(args.daemonId)
        if (existing) {
            this.notifyConnectionRetired(existing)
            try {
                existing.socket.close(4000, 'replaced by new connection')
            } catch {}
            this.failPending(existing, 'connection replaced')
        }
        this.conns.set(args.daemonId, {
            token: randomUUID(),
            helloOrder: 0,
            clientFeatures: args.clientFeatures,
            daemonId: args.daemonId,
            userId: args.userId,
            cliVersion: args.cliVersion,
            hostname: args.hostname,
            clientProcess: args.clientProcess,
            socket: args.socket,
            pending: new Map(),
            connectedAt: new Date()
        })
        const connection = this.conns.get(args.daemonId)!
        await this.mutateConnection(args.daemonId, async () => {
            if (this.stopping || this.conns.get(args.daemonId) !== connection)
                return
            await this.markConnected(
                args.daemonId,
                connection.connectedAt,
                args.clientFeatures,
                connection.token
            )
        })
        const replacementKind = !existing
            ? 'none'
            : existing.clientProcess && args.clientProcess
              ? existing.clientProcess.instanceId ===
                args.clientProcess.instanceId
                  ? 'same-client'
                  : 'different-client'
              : 'unknown'
        this.log.log(
            `daemon connected daemonId=${args.daemonId} userId=${args.userId} cliVersion=${args.cliVersion ?? 'unknown'} hostname=${args.hostname ?? 'unknown'} ${daemonClientProcessFields(args.clientProcess)} localReplacement=${Boolean(existing)} replacementKind=${replacementKind}`
        )
    }

    async unregister(daemonId: string, socket: WsClient): Promise<void> {
        const conn = this.conns.get(daemonId)
        if (!conn || conn.socket !== socket) return
        this.failPending(conn, 'connection closed')
        this.conns.delete(daemonId)
        this.notifyConnectionRetired(conn)
        await this.clearConnectionLease(daemonId, conn.token)
        this.log.log(
            `daemon disconnected daemonId=${daemonId} userId=${conn.userId} cliVersion=${conn.cliVersion ?? 'unknown'} hostname=${conn.hostname ?? 'unknown'} ${daemonClientProcessFields(conn.clientProcess)}`
        )
    }

    disconnect(daemonId: string, reason = 'daemon disconnected'): void {
        void this.disconnectAsync(daemonId, reason)
    }

    async touchConnection(daemonId: string): Promise<void> {
        if (!this.conns.has(daemonId)) return
        const now = new Date()
        await this.db
            .update(runtimeHosts)
            .set({
                rpcLastSeenAt: now,
                lastSeenAt: now,
                status: 'active',
                updatedAt: now
            })
            .where(
                and(
                    eq(runtimeHosts.id, daemonId),
                    eq(runtimeHosts.rpcInstanceId, this.instanceId)
                )
            )
    }

    // clearConnectionLease only runs on an orderly disconnect. A crash never
    // reaches it — `process.exit` on an unhandled rejection, OOM, SIGKILL — so
    // runtime_hosts keeps naming the dead process as the holder of sockets it
    // no longer has. That record is not self-healing: the broker inbox is
    // derived from the machine id, so the restarted process re-subscribes to
    // the SAME inbox and keeps answering relayed pushes with `is not connected`
    // for as long as the 45s lease still looks fresh.
    //
    // Staging 2026-08-03 lost two codex turns to exactly that: the crash and
    // the daemon's reconnect were 18s apart, well inside the lease, so a turn
    // dispatched from the peer instance was relayed to the corpse's inbox.
    //
    // A process that has just booted holds no daemon sockets, full stop. So
    // disown them here — before the inbox is subscribed, and before app.listen
    // lets any daemon reconnect, which is the only ordering that guarantees we
    // never serve a request against a lease we cannot honour.
    //
    // rpc_* columns only: status / last_seen_at are the presence sweep's, and
    // batch-flipping agents to stopped on every boot would fight it.
    private async releaseOwnRpcLeases(): Promise<void> {
        const released = await this.db
            .update(runtimeHosts)
            .set(RELEASED_RPC_LEASE())
            .where(eq(runtimeHosts.rpcInstanceId, this.instanceId))
            .returning({ id: runtimeHosts.id })
        if (released.length > 0)
            this.log.log(
                `daemon rpc released ${released.length} stale lease(s) left by instance=${this.instanceId}: ${released.map((r) => r.id).join(',')}`
            )
    }

    private async releaseOwnRpcLease(daemonId: string): Promise<void> {
        await this.mutateConnection(daemonId, async () => {
            if (this.conns.has(daemonId)) return
            await this.db
                .update(runtimeHosts)
                .set(RELEASED_RPC_LEASE())
                .where(
                    and(
                        eq(runtimeHosts.id, daemonId),
                        eq(runtimeHosts.rpcInstanceId, this.instanceId)
                    )
                )
        })
    }

    private async disconnectAsync(
        daemonId: string,
        reason = 'daemon disconnected'
    ): Promise<void> {
        const conn = this.conns.get(daemonId)
        if (!conn) {
            await this.publishRemoteDisconnect(daemonId, reason)
            return
        }
        this.disconnectLocal(daemonId, reason)
        await this.clearConnectionLease(daemonId, conn.token)
    }

    private disconnectLocal(
        daemonId: string,
        reason = 'daemon disconnected'
    ): void {
        const conn = this.conns.get(daemonId)
        if (!conn) return
        this.failPending(conn, reason)
        this.conns.delete(daemonId)
        this.notifyConnectionRetired(conn)
        try {
            conn.socket.close(4001, reason.slice(0, 120))
        } catch {}
        this.log.log(`daemon forcibly disconnected daemonId=${daemonId}`)
    }

    isOnline(daemonId: string): boolean {
        return this.conns.has(daemonId)
    }

    onConnectionRetired(
        listener: (daemonId: string, connectionToken: string) => void
    ): () => void {
        this.connectionRetirementListeners.add(listener)
        return () => {
            this.connectionRetirementListeners.delete(listener)
        }
    }

    private notifyConnectionRetired(conn: DaemonConnection): void {
        if (this.retiredConnections.has(conn)) return
        this.retiredConnections.add(conn)
        for (const listener of this.connectionRetirementListeners) {
            try {
                listener(conn.daemonId, conn.token)
            } catch (error) {
                this.log.warn(
                    `daemon connection retirement listener failed: ${(error as Error).message}`
                )
            }
        }
    }

    recordHelloForSocket(
        daemonId: string,
        socket: WsClient,
        clientFeatures?: string[]
    ): DaemonHelloEvidence | null {
        const conn = this.conns.get(daemonId)
        if (!conn || conn.socket !== socket) return null
        conn.helloOrder += 1
        const evidence = {
            connectionToken: conn.token,
            helloOrder: conn.helloOrder
        }
        if (clientFeatures) {
            conn.clientFeatures = clientFeatures
            for (const listener of this.helloListeners) {
                try { listener(daemonId, conn.userId, evidence) }
                catch { this.log.warn('daemon configuration hello listener failed') }
            }
        }
        return evidence
    }

    onHelloAccepted(listener: (daemonId: string, userId: string, evidence: DaemonHelloEvidence) => void): () => void {
        this.helloListeners.add(listener)
        return () => { this.helloListeners.delete(listener) }
    }

    currentHelloFeatures(daemonId: string, evidence?: DaemonHelloEvidence): string[] | null {
        if (evidence && !this.isCurrentHelloEvidence(daemonId, evidence)) return null
        return this.conns.get(daemonId)?.clientFeatures ?? null
    }

    currentHelloEvidence(daemonId: string): DaemonHelloEvidence | null {
        const conn = this.conns.get(daemonId)
        if (!conn || conn.helloOrder === 0) return null
        return {
            connectionToken: conn.token,
            helloOrder: conn.helloOrder
        }
    }

    isCurrentHelloEvidence(
        daemonId: string,
        evidence: DaemonHelloEvidence | null
    ): evidence is DaemonHelloEvidence {
        const conn = this.conns.get(daemonId)
        return (
            evidence !== null &&
            conn?.token === evidence.connectionToken &&
            conn.helloOrder === evidence.helloOrder
        )
    }

    // Whether the LIVE connection has a pending rpc for this refId. A turn
    // dispatch pins refId == daemonExecRef (turn.start refIdOverride) and
    // streamRpcLocal registers the pending entry before the frame is sent, so
    // a false here proves no dispatch for this ref reached — or can still
    // reach — the daemon over the current socket: a push rejected by an
    // earlier generation's `connection replaced` never re-enters this map.
    hasPendingRef(daemonId: string, refId: string): boolean {
        return this.conns.get(daemonId)?.pending.has(refId) ?? false
    }

    // Identity of the CURRENT local socket generation for a daemon, in the
    // same shape the host row's rpc lease encodes (`instance:connectedAtMs`).
    // Telemetry-only: lets a dispatch-recovery outcome be correlated with the
    // generation the runner resolution originally aimed at (#619).
    localConnectionGeneration(daemonId: string): string | null {
        const conn = this.conns.get(daemonId)
        return conn ? `${this.instanceId}:${conn.connectedAt.getTime()}` : null
    }

    localConfigConnectionToken(daemonId: string): string | undefined {
        const conn = this.conns.get(daemonId)
        return conn ? `${this.instanceId}:${conn.token}` : undefined
    }

    handleAck(
        daemonId: string,
        frame: Extract<DaemonWsFrame, { type: 'ack' }>
    ): void {
        const conn = this.conns.get(daemonId)
        if (!conn) return
        const pending = conn.pending.get(frame.refId)
        if (!pending) return
        clearTimeout(pending.timer)
        conn.pending.delete(frame.refId)
        if (frame.ok) pending.resolve(frame.payload)
        else
            pending.reject(
                new DaemonRpcResponseError(frame.error ?? 'rpc failed')
            )
    }

    handleEvent(
        daemonId: string,
        frame: Extract<DaemonWsFrame, { type: 'event' }>
    ): void {
        const conn = this.conns.get(daemonId)
        if (!conn) return
        const pending = conn.pending.get(frame.refId)
        if (!pending?.onEvent) return
        try {
            pending.onEvent(frame.kind, frame.data, frame.seq)
        } catch {}
    }

    cancel(daemonId: string, refId: string): void {
        const conn = this.conns.get(daemonId)
        if (!conn) return
        const cancelFrame: DaemonWsFrame = { type: 'cancel', refId }
        try {
            conn.socket.send(JSON.stringify(cancelFrame))
        } catch {}
        const pending = conn.pending.get(refId)
        if (pending) {
            clearTimeout(pending.timer)
            conn.pending.delete(refId)
            pending.reject(new Error('cancelled'))
        }
    }

    streamRpc(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
        onEvent: StreamRpcCallbacks['onEvent']
        refIdOverride?: string
        expectedConnection?: string
    }): {
        refId: string
        result: Promise<Record<string, unknown> | undefined>
        cancel: () => void
    } {
        if (!this.conns.has(args.daemonId)) return this.remoteStreamRpc(args)
        return this.streamRpcLocal(args)
    }

    private streamRpcLocal(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
        onEvent: StreamRpcCallbacks['onEvent']
        refIdOverride?: string
        expectedConnection?: string
    }): {
        refId: string
        result: Promise<Record<string, unknown> | undefined>
        cancel: () => void
    } {
        const conn = this.conns.get(args.daemonId)
        if (!conn) throw new Error(`daemon ${args.daemonId} is not connected`)
        if (
            args.expectedConnection &&
            args.expectedConnection !== this.localConfigConnectionToken(args.daemonId)
        ) throw new Error('daemon configuration superseded')
        const refId = args.refIdOverride ?? randomUUID()
        const frame: DaemonWsFrame = {
            type: 'push',
            refId,
            method: args.method,
            payload: args.payload
        }
        const result = new Promise<Record<string, unknown> | undefined>(
            (resolve, reject) => {
                const timer = setTimeout(() => {
                    conn.pending.delete(refId)
                    reject(new Error(`rpc ${args.method} timed out`))
                }, args.timeoutMs ?? 600_000)
                conn.pending.set(refId, {
                    resolve,
                    reject,
                    timer,
                    onEvent: args.onEvent
                })
                try {
                    conn.socket.send(JSON.stringify(frame))
                } catch (err) {
                    conn.pending.delete(refId)
                    clearTimeout(timer)
                    reject(err as Error)
                }
            }
        )
        return {
            refId,
            result,
            cancel: () => this.cancel(args.daemonId, refId)
        }
    }

    async rpc(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
        expectedConnection?: string
    }): Promise<Record<string, unknown> | undefined> {
        if (!this.conns.has(args.daemonId)) return this.remoteRpc(args)
        return this.rpcLocal(args)
    }

    private async rpcLocal(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
        expectedConnection?: string
    }): Promise<Record<string, unknown> | undefined> {
        const conn = this.conns.get(args.daemonId)
        if (!conn) throw new Error(`daemon ${args.daemonId} is not connected`)
        if (
            args.expectedConnection &&
            args.expectedConnection !== this.localConfigConnectionToken(args.daemonId)
        ) throw new Error('daemon configuration superseded')
        const refId = randomUUID()
        const frame: DaemonWsFrame = {
            type: 'push',
            refId,
            method: args.method,
            payload: args.payload
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pending.delete(refId)
                reject(new Error(`rpc ${args.method} timed out`))
            }, args.timeoutMs ?? 30_000)
            conn.pending.set(refId, { resolve, reject, timer })
            try {
                conn.socket.send(JSON.stringify(frame))
            } catch (err) {
                conn.pending.delete(refId)
                clearTimeout(timer)
                reject(err as Error)
            }
        })
    }

    private async remoteRpc(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
        expectedConnection?: string
    }): Promise<Record<string, unknown> | undefined> {
        const stream = this.remoteStreamRpc({
            ...args,
            onEvent: undefined
        })
        return stream.result
    }

    private remoteStreamRpc(args: {
        daemonId: string
        method: DaemonRpcMethod
        payload: Record<string, unknown>
        timeoutMs?: number
        onEvent: StreamRpcCallbacks['onEvent']
        refIdOverride?: string
        expectedConnection?: string
    }): {
        refId: string
        result: Promise<Record<string, unknown> | undefined>
        cancel: () => void
    } {
        const requestId = randomUUID()
        let ownerInbox: string | null = null
        const timeoutMs = args.timeoutMs ?? (args.onEvent ? 600_000 : 30_000)
        const result = new Promise<Record<string, unknown> | undefined>(
            (resolve, reject) => {
                const timer = setTimeout(() => {
                    this.remotePending.delete(requestId)
                    reject(new Error(`rpc ${args.method} timed out`))
                    if (ownerInbox)
                        void this.publishBrokerMessage(ownerInbox, {
                            type: 'cancel',
                            requestId,
                            daemonId: args.daemonId
                        }).catch(() => {})
                }, timeoutMs)
                this.remotePending.set(requestId, {
                    resolve,
                    reject,
                    timer,
                    ownerInbox: '',
                    onEvent: args.onEvent
                })
                void this.resolveRemoteInbox(args.daemonId)
                    .then((inbox) => {
                        ownerInbox = inbox
                        const pending = this.remotePending.get(requestId)
                        if (!pending) return
                        pending.ownerInbox = inbox
                        return this.publishBrokerMessage(inbox, {
                            type: args.expectedConnection ? 'config-request' : 'request',
                            requestId,
                            replyInbox: this.inbox,
                            daemonId: args.daemonId,
                            method: args.method,
                            payload: args.payload,
                            timeoutMs,
                            stream: !!args.onEvent || !!args.expectedConnection,
                            expectedConnection: args.expectedConnection,
                            ...(args.refIdOverride
                                ? { refIdOverride: args.refIdOverride }
                                : {})
                        })
                    })
                    .catch((err) => {
                        clearTimeout(timer)
                        this.remotePending.delete(requestId)
                        reject(err as Error)
                    })
            }
        )
        return {
            refId: requestId,
            result,
            cancel: () => {
                const pending = this.remotePending.get(requestId)
                if (!pending) return
                clearTimeout(pending.timer)
                this.remotePending.delete(requestId)
                pending.reject(new Error('cancelled'))
                if (pending.ownerInbox)
                    void this.publishBrokerMessage(pending.ownerInbox, {
                        type: 'cancel',
                        requestId,
                        daemonId: args.daemonId
                    }).catch(() => {})
            }
        }
    }

    private async resolveRemoteInbox(daemonId: string): Promise<string> {
        const cutoff = new Date(Date.now() - DAEMON_RPC_LEASE_MS)
        const [host] = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, daemonId),
                    eq(runtimeHosts.status, 'active'),
                    gt(runtimeHosts.rpcLastSeenAt, cutoff)
                )
            )
            .limit(1)
        if (!host?.rpcInbox)
            throw new Error(
                `daemon ${daemonId} is offline; no active websocket`
            )
        if (host.rpcInbox === this.inbox && !this.conns.has(daemonId))
            throw new Error(
                `daemon ${daemonId} websocket lease is stale on this api instance`
            )
        return host.rpcInbox
    }

    private async markConnected(daemonId: string, now = new Date(), clientFeatures?: string[], token?: string): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({
                rpcInstanceId: this.instanceId,
                rpcConnectionToken: token ? `${this.instanceId}:${token}` : null,
                rpcInbox: this.inbox,
                rpcConnectedAt: now,
                ...(clientFeatures ? { clientFeatures } : {}),
                rpcLastSeenAt: now,
                lastSeenAt: now,
                status: 'active',
                updatedAt: now
            })
            .where(eq(runtimeHosts.id, daemonId))
    }

    private async mutateConnection(
        daemonId: string,
        work: () => Promise<void>
    ): Promise<void> {
        // A newer connection must wait for already-issued identity writes;
        // checking the local token cannot cancel SQL queued in PostgreSQL.
        const pending = (this.connectionMutations.get(daemonId) ?? Promise.resolve())
            .catch(() => {})
            .then(work)
        this.connectionMutations.set(daemonId, pending)
        try {
            await pending
        } finally {
            if (this.connectionMutations.get(daemonId) === pending)
                this.connectionMutations.delete(daemonId)
        }
    }

    private async clearConnectionLease(daemonId: string, token?: string): Promise<void> {
        await this.mutateConnection(daemonId, async () => {
            if (this.conns.has(daemonId)) return
            await this.db.transaction(async (tx) => {
                const now = new Date()
                const [host] = await tx
                    .update(runtimeHosts)
                    .set({
                        ...RELEASED_RPC_LEASE(),
                        status: sql`case when ${runtimeHosts.status} = 'active' then 'offline' else ${runtimeHosts.status} end`,
                        updatedAt: now
                    })
                    .where(
                        and(
                            eq(runtimeHosts.id, daemonId),
                            eq(runtimeHosts.rpcInstanceId, this.instanceId),
                            token
                                ? eq(runtimeHosts.rpcConnectionToken, `${this.instanceId}:${token}`)
                                : undefined
                        )
                    )
                    .returning({ id: runtimeHosts.id })
                if (!host) return
                // Keep the host row locked until its dependent status writes
                // finish, so another API cannot take over between them.
                await tx
                    .update(agentRuntimes)
                    .set({ status: 'stopped', updatedAt: now })
                    .where(eq(agentRuntimes.daemonId, daemonId))
                await tx
                    .update(agents)
                    .set({
                        status: 'stopped',
                        failureReason: 'daemon disconnected',
                        updatedAt: now
                    })
                    .where(eq(agents.daemonId, daemonId))
            })
        })
    }

    private async publishRemoteDisconnect(
        daemonId: string,
        reason: string
    ): Promise<void> {
        const inbox = await this.resolveRemoteInbox(daemonId).catch(() => null)
        if (!inbox || inbox === this.inbox) return
        await this.publishBrokerMessage(inbox, {
            type: 'disconnect',
            daemonId,
            reason
        })
    }

    private async handleBrokerEnvelope(raw: string): Promise<void> {
        const envelope = JSON.parse(raw) as BrokerEnvelope
        if (envelope.version !== 1) return
        let buffer = this.brokerChunks.get(envelope.id)
        if (!buffer) {
            buffer = {
                chunks: new Array<Buffer>(envelope.total),
                received: 0,
                total: envelope.total,
                timer: setTimeout(() => {
                    this.brokerChunks.delete(envelope.id)
                }, BROKER_CHUNK_TTL_MS)
            }
            this.brokerChunks.set(envelope.id, buffer)
        }
        if (!buffer.chunks[envelope.seq]) {
            buffer.chunks[envelope.seq] = Buffer.from(envelope.data, 'base64')
            buffer.received += 1
        }
        if (buffer.received < buffer.total) return
        clearTimeout(buffer.timer)
        this.brokerChunks.delete(envelope.id)
        const message = JSON.parse(
            Buffer.concat(buffer.chunks).toString('utf8')
        ) as BrokerMessage
        await this.handleBrokerMessage(message)
    }

    private async handleBrokerMessage(message: BrokerMessage): Promise<void> {
        switch (message.type) {
            case 'request':
            case 'config-request':
                await this.handleBrokerRequest(message)
                return
            case 'response':
                this.handleBrokerResponse(message)
                return
            case 'event':
                this.remotePending
                    .get(message.requestId)
                    ?.onEvent?.(message.kind, message.data, message.seq)
                return
            case 'cancel':
                this.forwardedStreams.get(message.requestId)?.cancel()
                return
            case 'disconnect': {
                const token = this.conns.get(message.daemonId)?.token
                this.disconnectLocal(message.daemonId, message.reason)
                await this.clearConnectionLease(message.daemonId, token)
                return
            }
        }
    }

    private async handleBrokerRequest(
        message: Extract<BrokerMessage, { type: 'request' | 'config-request' }>
    ): Promise<void> {
        try {
            if (
                message.type === 'config-request' &&
                (typeof message.expectedConnection !== 'string' || !message.expectedConnection)
            ) throw new Error('daemon configuration unsupported')
            if (message.stream) {
                const stream = this.streamRpcLocal({
                    daemonId: message.daemonId,
                    method: message.method,
                    payload: this.rewriteForwardedPayload(
                        message.method,
                        message.payload
                    ),
                    timeoutMs: message.timeoutMs,
                    refIdOverride: message.refIdOverride,
                    expectedConnection: message.expectedConnection,
                    onEvent: (kind, data, seq) => {
                        const forwarded = this.forwardedStreams.get(
                            message.requestId
                        )
                        if (!forwarded) return
                        forwarded.publishChain = forwarded.publishChain
                            .then(() =>
                                this.publishBrokerMessage(message.replyInbox, {
                                    type: 'event',
                                    requestId: message.requestId,
                                    kind,
                                    data,
                                    ...(seq !== undefined ? { seq } : {})
                                })
                            )
                            .catch((err) =>
                                this.log.warn(
                                    `daemon rpc broker event publish failed: ${(err as Error).message}`
                                )
                            )
                    }
                })
                this.forwardedStreams.set(message.requestId, {
                    localRefId: stream.refId,
                    cancel: stream.cancel,
                    publishChain: Promise.resolve()
                })
                const payload = await stream.result
                await this.forwardedStreams
                    .get(message.requestId)
                    ?.publishChain.catch(() => {})
                this.forwardedStreams.delete(message.requestId)
                await this.publishBrokerMessage(message.replyInbox, {
                    type: 'response',
                    requestId: message.requestId,
                    ok: true,
                    payload
                })
                return
            }
            const payload = await this.rpcLocal({
                daemonId: message.daemonId,
                method: message.method,
                payload: this.rewriteForwardedPayload(
                    message.method,
                    message.payload
                ),
                timeoutMs: message.timeoutMs,
                expectedConnection: message.expectedConnection
            })
            await this.publishBrokerMessage(message.replyInbox, {
                type: 'response',
                requestId: message.requestId,
                ok: true,
                payload
            })
        } catch (err) {
            this.forwardedStreams.delete(message.requestId)
            // The lease named us and we do not hold the socket. The requester
            // cannot repair that record — it will just re-resolve to us and
            // bounce again until the lease ages out. Only the named holder can
            // disown it, so do that now and let the next resolve find whoever
            // actually has the daemon (or fail as genuinely offline).
            if (!this.conns.has(message.daemonId))
                await this.releaseOwnRpcLease(message.daemonId).catch((e) =>
                    this.log.warn(
                        `daemon rpc lease release failed daemonId=${message.daemonId}: ${(e as Error).message}`
                    )
                )
            await this.publishBrokerMessage(message.replyInbox, {
                type: 'response',
                requestId: message.requestId,
                ok: false,
                error: (err as Error).message,
                ...(err instanceof DaemonRpcResponseError
                    ? { errorSource: 'daemon' as const }
                    : {})
            })
        }
    }

    private rewriteForwardedPayload(
        method: DaemonRpcMethod,
        payload: Record<string, unknown>
    ): Record<string, unknown> {
        if (
            method !== 'pty.input' &&
            method !== 'pty.resize' &&
            method !== 'pty.close'
        )
            return payload
        const refId = String(payload.refId ?? '')
        const forwarded = this.forwardedStreams.get(refId)
        if (!forwarded) return payload
        return { ...payload, refId: forwarded.localRefId }
    }

    private handleBrokerResponse(
        message: Extract<BrokerMessage, { type: 'response' }>
    ): void {
        const pending = this.remotePending.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.remotePending.delete(message.requestId)
        if (message.ok) pending.resolve(message.payload)
        else
            pending.reject(
                message.errorSource === 'daemon'
                    ? new DaemonRpcResponseError(message.error ?? 'rpc failed')
                    : new Error(message.error ?? 'rpc failed')
            )
    }

    private async publishBrokerMessage(
        channel: string,
        message: BrokerMessage
    ): Promise<void> {
        if (!this.brokerSql) throw new Error('daemon rpc broker is not running')
        const messageId = randomUUID()
        const body = Buffer.from(JSON.stringify(message), 'utf8')
        const total = Math.max(1, Math.ceil(body.length / BROKER_CHUNK_BYTES))
        for (let seq = 0; seq < total; seq += 1) {
            const chunk = body.subarray(
                seq * BROKER_CHUNK_BYTES,
                (seq + 1) * BROKER_CHUNK_BYTES
            )
            const envelope: BrokerEnvelope = {
                version: 1,
                id: messageId,
                seq,
                total,
                data: chunk.toString('base64')
            }
            await this.brokerSql.notify(channel, JSON.stringify(envelope))
        }
    }

    private failPending(conn: DaemonConnection, reason: string): void {
        for (const [refId, p] of conn.pending) {
            clearTimeout(p.timer)
            p.reject(new Error(reason))
            conn.pending.delete(refId)
        }
    }
}

const RELEASED_RPC_LEASE = (): {
    rpcInstanceId: null
    rpcConnectionToken: null
    rpcInbox: null
    rpcConnectedAt: null
    rpcLastSeenAt: null
    updatedAt: Date
} => ({
    rpcInstanceId: null,
    rpcConnectionToken: null,
    rpcInbox: null,
    rpcConnectedAt: null,
    rpcLastSeenAt: null,
    updatedAt: new Date()
})

const DAEMON_RPC_LEASE_MS = 45_000
const BROKER_CHUNK_BYTES = 4500
const BROKER_CHUNK_TTL_MS = 30_000

const brokerChannel = (value: string): string =>
    `nca_daemon_rpc_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
