import WebSocket from 'ws'
import {
    DAEMON_CLIENT_FEATURES,
    type DaemonInflightStream,
    type DaemonRpcMethod,
    type DaemonStreamKind,
    type DaemonWsFrame
} from '@manyfold/shared'
import {
    enumerateInflightForHello,
    gcStaleBuffers,
    recoverCrashedBuffers
} from './exec-buffer'

export interface RpcContext {
    refId: string
    sendEvent: (kind: DaemonStreamKind, data: string, seq?: number) => void
    onCancel: (handler: () => void) => void
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
    onWelcome?: (frame: Extract<DaemonWsFrame, { type: 'welcome' }>) => void
    onConnected?: () => void
    onDisconnected?: (reason: string) => void
    handleRpc?: RpcHandler
    log?: (msg: string) => void
}

const PING_INTERVAL_MS = 25_000
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 30_000
// The exec buffer used to be swept once, at start(), so a daemon that stayed up
// for weeks never reclaimed anything: buffers (each holding a whole turn's
// output) piled up on the user's disk and every reconnect re-enumerated them.
const GC_INTERVAL_MS = 60 * 60 * 1000

export class DaemonWsClient {
    private ws: WebSocket | null = null
    private pingTimer: NodeJS.Timeout | null = null
    private reconnectTimer: NodeJS.Timeout | null = null
    private gcTimer: NodeJS.Timeout | null = null
    private backoffMs = BACKOFF_INITIAL_MS
    private stopped = false
    private cancelHandlers = new Map<string, () => void>()

    constructor(private readonly opts: WsClientOptions) {}

    start(): void {
        this.stopped = false
        try {
            recoverCrashedBuffers()
            this.sweepBuffers()
        } catch (err) {
            this.log(`exec-buffer recovery failed: ${(err as Error).message}`)
        }
        this.gcTimer = setInterval(() => this.sweepBuffers(), GC_INTERVAL_MS)
        this.gcTimer.unref?.()
        this.connect()
    }

    stop(): void {
        this.stopped = true
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        if (this.gcTimer) {
            clearInterval(this.gcTimer)
            this.gcTimer = null
        }
        this.cleanupSocket('client stop')
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
        const wsUrl = this.opts.apiUrl.replace(/^http/, 'ws')
        const url = `${wsUrl}/daemon/ws?token=${encodeURIComponent(
            this.opts.token
        )}`
        const ws = new WebSocket(url)
        this.ws = ws

        ws.on('open', () => {
            this.log(`ws connected ${url}`)
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
            const hello: DaemonWsFrame = {
                type: 'hello',
                daemonUuid: this.opts.daemonUuid,
                cliVersion: this.opts.cliVersion,
                clientFeatures: DAEMON_CLIENT_FEATURES,
                ...(inflightStreams !== null ? { inflightStreams } : {})
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
            void this.handleFrame(ws, raw).catch((err) =>
                this.log(`frame error: ${(err as Error).message}`)
            )
        })

        ws.on('close', (code, reason) => {
            const why = `code=${code} reason=${reason.toString()}`
            this.log(`ws closed ${why}`)
            this.cleanupSocket(why)
            this.opts.onDisconnected?.(why)
            this.scheduleReconnect()
        })

        ws.on('error', (err) => {
            this.log(`ws error: ${err.message}`)
        })
    }

    private async handleFrame(ws: WebSocket, raw: unknown): Promise<void> {
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
                        sendEvent: (kind, data, seq) => {
                            if (ws.readyState !== WebSocket.OPEN)
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
                        onCancel: (h) => this.cancelHandlers.set(frame.refId, h)
                    }
                    try {
                        result = await handler(frame.method, frame.payload, ctx)
                    } catch (err) {
                        result = {
                            ok: false,
                            error: (err as Error).message
                        }
                    } finally {
                        this.cancelHandlers.delete(frame.refId)
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
                const handler = this.cancelHandlers.get(frame.refId)
                if (handler) {
                    try {
                        handler()
                    } catch {}
                    this.cancelHandlers.delete(frame.refId)
                }
                return
            }
            default:
                return
        }
    }

    private cleanupSocket(_reason: string): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer)
            this.pingTimer = null
        }
        if (this.ws) {
            try {
                this.ws.close()
            } catch {}
            this.ws = null
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped) return
        const delay = Math.min(this.backoffMs, BACKOFF_MAX_MS)
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
        this.log(`reconnecting in ${delay}ms`)
        this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
}
