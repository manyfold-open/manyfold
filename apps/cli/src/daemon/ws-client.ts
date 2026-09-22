import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import {
    DAEMON_CLIENT_FEATURES,
    type DaemonInflightStream,
    type DaemonOwnedTerminal,
    type DaemonRpcMethod,
    type DaemonStreamKind,
    type DaemonWsFrame
} from '@manyfold/shared'
import { enumerateInflightForHello, gcStaleBuffers } from './exec-buffer'
import { recoverFileExecs } from './exec-files'
import { listOwnedTerminals } from './owned-terminals'
import { listHerdrTerminals } from './herdr'

export interface RpcContext {
    refId: string
    sendEvent: (kind: DaemonStreamKind, data: string, seq?: number) => void
    onCancel: (handler: () => void) => void
    isCurrentConnection?: () => boolean
}

export type RpcHandler = (
    method: DaemonRpcMethod,
    payload: Record<string, unknown>,
    ctx: RpcContext
) => Promise<{ ok: boolean; error?: string; payload?: Record<string, unknown> }>

export interface WsClientOptions {
    apiUrl: string
    token: string
    daemonUuid: string
    cliVersion: string
    clientInstanceId?: string
    onWelcome?: (frame: Extract<DaemonWsFrame, { type: 'welcome' }>) => void
    onConnected?: () => void
    onDisconnected?: (reason: string) => void
    handleRpc?: RpcHandler
    log?: (msg: string) => void
    // Runtime-computed capabilities ride here; absent, the constant list. A
    // getter when they can change while the daemon runs (herdr installed
    // after start, ADR-0031): each hello reads the current set.
    clientFeatures?: string[] | (() => string[])
    // One-shot reports for the hello (exec recovery, an update rollback);
    // called per hello, so the caller decides what is still worth sending.
    helloExtras?: () => Pick<
        Extract<DaemonWsFrame, { type: 'hello' }>,
        'recovery' | 'rollback'
    >
}

const PING_INTERVAL_MS = 25_000
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 30_000
// The exec buffer used to be swept once, at start(), so a daemon that stayed up
// for weeks never reclaimed anything: buffers (each holding a whole turn's
// output) piled up on the user's disk and every reconnect re-enumerated them.
const GC_INTERVAL_MS = 60 * 60 * 1000
const CLIENT_INSTANCE_ID = randomUUID()

const currentClientFeatures = (
    features: WsClientOptions['clientFeatures']
): string[] =>
    typeof features === 'function'
        ? features()
        : (features ?? DAEMON_CLIENT_FEATURES)

export class DaemonWsClient {
    private ws: WebSocket | null = null
    private pingTimer: NodeJS.Timeout | null = null
    private reconnectTimer: NodeJS.Timeout | null = null
    private gcTimer: NodeJS.Timeout | null = null
    private backoffMs = BACKOFF_INITIAL_MS
    private stopped = true

    constructor(private readonly opts: WsClientOptions) {}

    start(): void {
        if (!this.stopped) return
        this.stopped = false
        this.backoffMs = BACKOFF_INITIAL_MS
        // Recovery completes BEFORE the first dial, synchronously: an adopted
        // exec's profile lease is re-stamped in there, and nothing may be
        // dispatched onto that profile until it is (ADR-0029 §4).
        try {
            const recovered = recoverFileExecs((message) => this.log(message))
            if (recovered.adopted + recovered.completed + recovered.crashed > 0)
                this.log(
                    `exec-files recovery adopted=${recovered.adopted} completed=${recovered.completed} crashed=${recovered.crashed}`
                )
            this.sweepBuffers()
        } catch (err) {
            this.log(`exec-buffer recovery failed: ${(err as Error).message}`)
        }
        this.gcTimer = setInterval(() => this.sweepBuffers(), GC_INTERVAL_MS)
        this.gcTimer.unref?.()
        this.connect()
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        if (this.gcTimer) {
            clearInterval(this.gcTimer)
            this.gcTimer = null
        }
        const ws = this.ws
        this.cleanupSocket(ws)
        if (ws) this.opts.onDisconnected?.('client stop')
    }

    // Never let a sweep failure take the daemon down: the buffer is a cache,
    // and a disk error here must not stop it from serving turns.
    private sweepBuffers(): void {
        try {
            const removed = gcStaleBuffers()
            if (removed > 0) this.log(`exec-buffer gc removed ${removed}`)
        } catch (err) {
            this.log(`exec-buffer gc failed: ${(err as Error).message}`)
        }
    }

    private log(msg: string): void {
        this.opts.log?.(msg)
    }

    private connect(): void {
        if (this.stopped || this.ws) return
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        const wsUrl = this.opts.apiUrl.replace(/^http/, 'ws')
        const url = `${wsUrl}/daemon/ws`
        let ws: WebSocket
        try {
            ws = new WebSocket(url, {
                headers: { Authorization: `Bearer ${this.opts.token}` }
            })
        } catch (err) {
            this.log(`ws connect failed: ${(err as Error).message}`)
            this.scheduleReconnect()
            return
        }
        this.ws = ws
        const cancelHandlers = new Map<string, () => void>()

        ws.on('open', () => {
            if (this.stopped || this.ws !== ws) return
            this.log('ws connected')
            this.backoffMs = BACKOFF_INITIAL_MS
            // Present-but-empty and absent mean different things to the
            // server (hello.inflight-authoritative): an empty list is proof
            // the daemon holds no streams, while a failed enumeration must
            // NOT masquerade as one — the server would converge every open
            // turn stamped on this daemon as unresumable.
            let inflightStreams: DaemonInflightStream[] | null = null
            try {
                inflightStreams = enumerateInflightForHello()
            } catch (err) {
                this.log(
                    `inflight enumeration failed: ${(err as Error).message}`
                )
            }
            // Same rule for the terminals this daemon owns (ADR-0029 §6).
            let terminals: DaemonOwnedTerminal[] | null = null
            try {
                terminals = [
                    ...listOwnedTerminals().map(
                        ({ terminalId, attached, startedAt }) => ({
                            terminalId,
                            attached,
                            startedAt
                        })
                    ),
                    ...listHerdrTerminals()
                ]
            } catch (err) {
                this.log(
                    `terminal enumeration failed: ${(err as Error).message}`
                )
            }
            const hello: DaemonWsFrame = {
                type: 'hello',
                daemonUuid: this.opts.daemonUuid,
                cliVersion: this.opts.cliVersion,
                clientProcess: {
                    instanceId:
                        this.opts.clientInstanceId ?? CLIENT_INSTANCE_ID,
                    pid: process.pid
                },
                clientFeatures: currentClientFeatures(this.opts.clientFeatures),
                ...(inflightStreams !== null ? { inflightStreams } : {}),
                ...(terminals !== null ? { terminals } : {}),
                ...(this.opts.helloExtras?.() ?? {})
            }
            if (inflightStreams !== null && inflightStreams.length > 0)
                this.log(
                    `sending hello inflightStreams=${inflightStreams.length}`
                )
            try {
                ws.send(JSON.stringify(hello))
            } catch (err) {
                this.log(`hello send failed: ${(err as Error).message}`)
            }
            this.opts.onConnected?.()
            let lastPingTick = Date.now()
            this.pingTimer = setInterval(() => {
                if (this.stopped || this.ws !== ws) return
                const now = Date.now()
                if (now - lastPingTick > PING_INTERVAL_MS * 2) {
                    this.log(
                        `clock jump detected (gap=${now - lastPingTick}ms); forcing reconnect`
                    )
                    try {
                        ws.close()
                    } catch {}
                    return
                }
                lastPingTick = now
                const ping: DaemonWsFrame = { type: 'ping' }
                try {
                    ws.send(JSON.stringify(ping))
                } catch {}
            }, PING_INTERVAL_MS)
        })

        ws.on('message', (raw) => {
            if (this.stopped || this.ws !== ws) return
            void this.handleFrame(ws, raw, cancelHandlers).catch((err) =>
                this.log(`frame error: ${(err as Error).message}`)
            )
        })

        ws.on('close', (code, reason) => {
            if (this.stopped || this.ws !== ws) return
            const why = `code=${code} reason=${reason.toString()}`
            this.log(`ws closed ${why}`)
            if (code === 4400 && reason.toString() === 'missing token')
                this.log(
                    'daemon header authentication was not accepted; upgrade the API and ensure the proxy forwards Authorization'
                )
            this.cleanupSocket(ws)
            this.opts.onDisconnected?.(why)
            this.scheduleReconnect()
        })

        ws.on('error', (err) => {
            if (this.stopped || this.ws !== ws) return
            this.log(`ws error: ${err.message}`)
        })
    }

    private async handleFrame(
        ws: WebSocket,
        raw: unknown,
        cancelHandlers: Map<string, () => void>
    ): Promise<void> {
        let frame: DaemonWsFrame
        try {
            const text =
                typeof raw === 'string'
                    ? raw
                    : Buffer.isBuffer(raw)
                      ? raw.toString('utf8')
                      : ''
            frame = JSON.parse(text) as DaemonWsFrame
        } catch {
            return
        }
        switch (frame.type) {
            case 'welcome':
                this.opts.onWelcome?.(frame)
                return
            case 'ping': {
                const pong: DaemonWsFrame = { type: 'pong' }
                try {
                    ws.send(JSON.stringify(pong))
                } catch {}
                return
            }
            case 'pong':
                return
            case 'push': {
                const handler = this.opts.handleRpc
                let result: Awaited<ReturnType<RpcHandler>>
                if (!handler)
                    result = { ok: false, error: 'no rpc handler registered' }
                else {
                    const ctx: RpcContext = {
                        refId: frame.refId,
                        isCurrentConnection: () =>
                            !this.stopped &&
                            this.ws === ws &&
                            ws.readyState === WebSocket.OPEN,
                        sendEvent: (kind, data, seq) => {
                            if (
                                this.stopped ||
                                this.ws !== ws ||
                                ws.readyState !== WebSocket.OPEN
                            )
                                throw new Error('ws not open')
                            const ev: DaemonWsFrame = {
                                type: 'event',
                                refId: frame.refId,
                                kind,
                                data,
                                ...(seq !== undefined ? { seq } : {})
                            }
                            ws.send(JSON.stringify(ev))
                        },
                        onCancel: (h) => cancelHandlers.set(frame.refId, h)
                    }
                    try {
                        result = await handler(frame.method, frame.payload, ctx)
                    } catch (err) {
                        result = {
                            ok: false,
                            error: (err as Error).message
                        }
                    } finally {
                        cancelHandlers.delete(frame.refId)
                    }
                }
                const ack: DaemonWsFrame = {
                    type: 'ack',
                    refId: frame.refId,
                    ok: result.ok,
                    error: result.error,
                    payload: result.payload
                }
                try {
                    ws.send(JSON.stringify(ack))
                } catch {}
                return
            }
            case 'cancel': {
                const handler = cancelHandlers.get(frame.refId)
                if (handler) {
                    try {
                        handler()
                    } catch {}
                    cancelHandlers.delete(frame.refId)
                }
                return
            }
            default:
                return
        }
    }

    private cleanupSocket(ws: WebSocket | null): void {
        if (this.ws !== ws) return
        this.ws = null
        if (this.pingTimer) {
            clearInterval(this.pingTimer)
            this.pingTimer = null
        }
        if (ws) {
            try {
                ws.close()
            } catch {}
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.ws || this.reconnectTimer) return
        const delay = Math.min(this.backoffMs, BACKOFF_MAX_MS)
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
        this.log(`reconnecting in ${delay}ms`)
        const timer = setTimeout(() => {
            if (this.reconnectTimer !== timer) return
            this.reconnectTimer = null
            this.connect()
        }, delay)
        this.reconnectTimer = timer
    }
}
