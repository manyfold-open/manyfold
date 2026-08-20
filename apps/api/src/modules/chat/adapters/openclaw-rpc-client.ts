import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { WebSocket } from 'ws'

export interface OpenclawRpcClientOptions {
    url: string
    token?: string | null
    password?: string | null
    logger?: Logger
}

export type OpenclawEventListener = (event: string, payload: unknown) => void

interface PendingCall {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

interface ConnectFrame {
    type: 'req'
    id: string
    method: 'connect'
    params: Record<string, unknown>
}

const DEFAULT_RPC_TIMEOUT_MS = 160_000
const CONNECT_GRACE_MS = 500
// A gateway that accepts the websocket but never answers the connect frame
// (and never closes) would otherwise hang the caller forever.
const CONNECT_TIMEOUT_MS = 15_000
const HEARTBEAT_MS = 30_000

export class OpenclawRpcClient {
    private readonly log: Logger
    private ws: WebSocket | null = null
    private connected = false
    private connectId: string | null = null
    private connectSent = false
    private readonly pendingCalls = new Map<string, PendingCall>()
    private readonly eventListeners = new Set<OpenclawEventListener>()
    private heartbeatTimer: NodeJS.Timeout | null = null
    private connectResolve: ((value: unknown) => void) | null = null
    private connectReject: ((err: Error) => void) | null = null

    constructor(private readonly options: OpenclawRpcClientOptions) {
        this.log = options.logger ?? new Logger(OpenclawRpcClient.name)
    }

    async connect(): Promise<unknown> {
        if (this.ws) this.disconnect()
        const auth = this.options.token || this.options.password || ''
        const wsUrl = auth
            ? `${this.options.url}?auth=${encodeURIComponent(auth)}`
            : this.options.url

        return new Promise<unknown>((resolve, reject) => {
            const deadline = setTimeout(() => {
                this.failConnect(
                    new Error(
                        `openclaw-rpc connect timed out after ${CONNECT_TIMEOUT_MS}ms`
                    )
                )
            }, CONNECT_TIMEOUT_MS)
            this.connectResolve = (value) => {
                clearTimeout(deadline)
                resolve(value)
            }
            this.connectReject = (err) => {
                clearTimeout(deadline)
                reject(err)
            }

            try {
                this.ws = new WebSocket(wsUrl)
            } catch (err) {
                reject(err as Error)
                return
            }

            this.ws.on('open', () => {
                this.connectId = `connect-${Date.now()}`
                this.connectSent = false
                // Token-only auth: send connect immediately without waiting
                // for connect.challenge. We don't sign device identity, so the
                // nonce isn't useful for us anyway.
                setTimeout(() => {
                    if (!this.connectSent) {
                        void this.sendConnect().catch((e) =>
                            this.failConnect(e as Error)
                        )
                    }
                }, CONNECT_GRACE_MS)
            })

            this.ws.on('message', (data) => {
                this.handleMessage(data.toString())
            })

            this.ws.on('close', () => {
                this.handleDisconnect()
            })

            this.ws.on('error', (err) => {
                this.log.warn(`openclaw-rpc ws error: ${err.message}`)
                this.failConnect(err)
            })
        })
    }

    disconnect(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        if (this.ws) {
            try {
                this.ws.close()
            } catch {
                /* ignore */
            }
            this.ws = null
        }
        this.connected = false
        for (const pending of this.pendingCalls.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('openclaw-rpc disconnected'))
        }
        this.pendingCalls.clear()
        this.eventListeners.clear()
    }

    isConnected(): boolean {
        return this.connected
    }

    onEvent(listener: OpenclawEventListener): () => void {
        this.eventListeners.add(listener)
        return () => {
            this.eventListeners.delete(listener)
        }
    }

    call<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('openclaw-rpc not connected'))
                return
            }
            const id = `rpc-${randomUUID()}`
            const frame = { type: 'req', id, method, params: params ?? {} }
            const timer = setTimeout(() => {
                this.pendingCalls.delete(id)
                reject(new Error(`openclaw-rpc "${method}" timed out`))
            }, timeoutMs)
            this.pendingCalls.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
                timer
            })
            try {
                this.ws.send(JSON.stringify(frame))
            } catch (err) {
                clearTimeout(timer)
                this.pendingCalls.delete(id)
                reject(err as Error)
            }
        })
    }

    private failConnect(err: Error): void {
        if (this.connectReject) {
            const reject = this.connectReject
            this.connectResolve = null
            this.connectReject = null
            reject(err)
        }
    }

    private async sendConnect(): Promise<void> {
        if (
            this.connectSent ||
            !this.ws ||
            this.ws.readyState !== WebSocket.OPEN
        )
            return
        this.connectSent = true
        const params = await this.buildConnectParams()
        const frame: ConnectFrame = {
            type: 'req',
            id: this.connectId as string,
            method: 'connect',
            params
        }
        this.ws.send(JSON.stringify(frame))
    }

    private async buildConnectParams(): Promise<Record<string, unknown>> {
        // OpenClaw accepts token-only auth without device signing.
        // Sending a fresh ed25519 device fingerprint triggers device pairing
        // ("pairing required: device is not approved yet"), so omit it.
        return {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: 'cli',
                displayName: 'Manyfold Backend',
                version: process.env.npm_package_version ?? '0.0.1',
                platform: process.platform,
                mode: 'cli'
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
            caps: ['tool-events'],
            commands: [],
            permissions: {},
            auth: {
                token: this.options.token ?? '',
                password: this.options.password ?? ''
            },
            locale: 'en-US',
            userAgent: 'Manyfold-Backend/0.0.1'
        }
    }

    private handleMessage(text: string): void {
        let frame: { type?: string; [k: string]: unknown }
        try {
            frame = JSON.parse(text)
        } catch (err) {
            this.log.warn(
                `openclaw-rpc malformed message: ${(err as Error).message}`
            )
            return
        }
        if (frame.type === 'event') {
            const eventName = String(frame.event ?? '')
            const payload = frame.payload
            if (eventName === 'connect.challenge') {
                // We don't device-sign, so we can ignore the nonce.
                // The 500ms grace timer in `connect()` will trigger sendConnect.
                return
            }
            for (const listener of this.eventListeners) {
                try {
                    listener(eventName, payload)
                } catch (err) {
                    this.log.warn(
                        `openclaw-rpc event listener threw: ${(err as Error).message}`
                    )
                }
            }
            return
        }
        if (frame.type === 'res') {
            const id = String(frame.id ?? '')
            if (id && id === this.connectId) {
                this.handleConnectResponse(frame)
                return
            }
            const pending = this.pendingCalls.get(id)
            if (!pending) return
            this.pendingCalls.delete(id)
            clearTimeout(pending.timer)
            if (frame.ok === true) {
                pending.resolve(frame.payload)
            } else {
                const err = frame.error as
                    | { message?: string; code?: string }
                    | undefined
                pending.reject(
                    new Error(
                        err?.message
                            ? `${err.code ?? 'rpc_error'}: ${err.message}`
                            : 'openclaw-rpc call failed'
                    )
                )
            }
        }
    }

    private handleConnectResponse(frame: Record<string, unknown>): void {
        this.connectId = null
        if (frame.ok === true) {
            this.connected = true
            this.startHeartbeat()
            const resolve = this.connectResolve
            this.connectResolve = null
            this.connectReject = null
            resolve?.(frame.payload)
        } else {
            const err = frame.error as
                | { message?: string; code?: string }
                | undefined
            const message = err?.message ?? 'openclaw connect rejected'
            this.failConnect(new Error(message))
            try {
                this.ws?.close()
            } catch {
                /* ignore */
            }
        }
    }

    private handleDisconnect(): void {
        this.connected = false
        this.connectSent = false
        this.connectId = null
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        for (const pending of this.pendingCalls.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('openclaw-rpc connection closed'))
        }
        this.pendingCalls.clear()
        this.failConnect(new Error('openclaw-rpc connection closed'))
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                this.call('health', {}, 15_000).catch(() => {
                    /* swallow */
                })
            }
        }, HEARTBEAT_MS)
    }
}
