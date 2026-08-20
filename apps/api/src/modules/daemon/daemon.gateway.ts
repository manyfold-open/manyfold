import {
    DAEMON_FEATURE_EXEC_RESUME,
    DAEMON_FEATURE_HELLO_INFLIGHT,
    DaemonInflightStream,
    DaemonWsFrame
} from '@manyfold/shared'
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket as WsClient } from 'ws'
import { eq } from 'drizzle-orm'
import { agentRuntimes, type Database } from '@manyfold/db'
import { Inject } from '@nestjs/common'
import { DRIZZLE } from '@/db/tokens'
import { DaemonTokenService } from './daemon-token.service'
import { DaemonHostService } from './daemon-host.service'
import { DaemonRegistryService } from './daemon-registry.service'
import { DaemonExecResumeService } from './daemon-exec-resume.service'

interface DaemonWsQuery {
    token?: string
}

const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 35_000

@Injectable()
export class DaemonGateway implements OnModuleInit {
    private readonly log = new Logger(DaemonGateway.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly adapterHost: HttpAdapterHost,
        private readonly tokens: DaemonTokenService,
        private readonly hosts: DaemonHostService,
        private readonly registry: DaemonRegistryService,
        private readonly resumeService: DaemonExecResumeService
    ) {}

    onModuleInit(): void {
        const adapter = this.adapterHost.httpAdapter as unknown as {
            getInstance: () => FastifyInstance
        }
        const fastify = adapter.getInstance()

        fastify.get(
            '/api/daemon/ws',
            { websocket: true },
            (socket: WsClient, req: FastifyRequest) => {
                const earlyMessages: unknown[] = []
                const earlyMessageListener = (raw: unknown): void => {
                    earlyMessages.push(raw)
                }
                socket.on('message', earlyMessageListener)
                void this.handleConnection(
                    socket,
                    req,
                    earlyMessages,
                    earlyMessageListener
                ).catch((err) => {
                    const message = (err as Error).message
                    this.log.warn(`daemon.ws.handle_failed ${message}`)
                    try {
                        socket.close(1011, 'handler failed')
                    } catch {}
                })
            }
        )

        this.log.log('registered WS route GET /api/daemon/ws')
    }

    private async handleConnection(
        socket: WsClient,
        req: FastifyRequest,
        earlyMessages: unknown[],
        earlyMessageListener: (raw: unknown) => void
    ): Promise<void> {
        const query = (req.query ?? {}) as DaemonWsQuery
        const token = query.token?.trim()
        if (!token) {
            socket.close(4400, 'missing token')
            return
        }

        let auth
        try {
            auth = await this.tokens.verify(token)
        } catch (err) {
            this.log.warn(`daemon.ws.auth_failed ${(err as Error).message}`)
            socket.close(4401, 'unauthorized')
            return
        }
        if (!auth.daemonId) {
            socket.close(4409, 'token not bound; call /register first')
            return
        }

        const host = await this.hosts.findById(auth.daemonId)
        if (!host || host.userId !== auth.userId) {
            socket.close(4404, 'daemon not found')
            return
        }
        if (host.status === 'revoked') {
            socket.close(4403, 'daemon revoked')
            return
        }

        const runtimes = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.daemonId, host.id))

        let pongTimer: NodeJS.Timeout | null = null
        let pingTimer: NodeJS.Timeout | null = null

        const armPongDeadline = (): void => {
            if (pongTimer) clearTimeout(pongTimer)
            pongTimer = setTimeout(() => {
                this.log.warn(
                    `daemon.ws.pong_timeout daemonId=${host.id} userId=${host.userId} cliVersion=${host.cliVersion ?? 'unknown'} hostname=${host.hostname ?? 'unknown'}`
                )
                try {
                    socket.close(4000, 'pong timeout')
                } catch {}
            }, PONG_TIMEOUT_MS)
        }

        const stopTimers = (): void => {
            if (pongTimer) clearTimeout(pongTimer)
            if (pingTimer) clearInterval(pingTimer)
        }

        let registered = false
        let bufferedInflight: DaemonInflightStream[] | null = null

        const handleInflightWhenReady = (
            streams: DaemonInflightStream[]
        ): void => {
            if (!registered) {
                bufferedInflight = streams
                return
            }
            const evidence = this.registry.recordHelloForSocket(host.id, socket)
            if (!evidence) return
            void this.resumeService
                .handleInflightStreams(host.id, streams, evidence)
                .catch((err) =>
                    this.log.warn(
                        `daemon.ws.resume_failed daemonId=${host.id} ${(err as Error).message}`
                    )
                )
        }

        socket.off('message', earlyMessageListener)
        socket.on('message', (raw: unknown) => {
            void this.handleFrame(
                host.id,
                socket,
                raw,
                armPongDeadline,
                handleInflightWhenReady
            )
        })
        for (const queued of earlyMessages)
            void this.handleFrame(
                host.id,
                socket,
                queued,
                armPongDeadline,
                handleInflightWhenReady
            )
        socket.on('close', () => {
            stopTimers()
            void this.registry.unregister(host.id, socket)
        })
        socket.on('error', (err) => {
            this.log.warn(
                `daemon.ws.error daemonId=${host.id} userId=${host.userId} cliVersion=${host.cliVersion ?? 'unknown'} hostname=${host.hostname ?? 'unknown'} ${(err as Error).message}`
            )
        })

        await this.registry.register({
            daemonId: host.id,
            userId: host.userId,
            cliVersion: host.cliVersion,
            hostname: host.hostname,
            socket
        })
        registered = true

        const welcome: DaemonWsFrame = {
            type: 'welcome',
            daemonId: host.id,
            serverTime: new Date().toISOString(),
            runtimeIds: runtimes.map((r) => r.id),
            serverFeatures: [DAEMON_FEATURE_EXEC_RESUME]
        }
        socket.send(JSON.stringify(welcome))

        await this.hosts.touchLastSeen(host.id)

        if (bufferedInflight) {
            const pending = bufferedInflight
            bufferedInflight = null
            handleInflightWhenReady(pending)
        }

        armPongDeadline()
        pingTimer = setInterval(() => {
            const ping: DaemonWsFrame = { type: 'ping' }
            try {
                socket.send(JSON.stringify(ping))
            } catch {}
        }, PING_INTERVAL_MS)
    }

    private async handleFrame(
        daemonId: string,
        socket: WsClient,
        raw: unknown,
        armPongDeadline: () => void,
        handleInflightStreams: (streams: DaemonInflightStream[]) => void
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
            case 'hello':
                if (frame.inflightStreams && frame.inflightStreams.length > 0)
                    this.log.log(
                        `daemon.ws.hello daemonId=${daemonId} inflightStreams=${frame.inflightStreams.length} clientFeatures=${(frame.clientFeatures ?? []).join(',')}`
                    )
                // A client that always sends the field (even empty) omits it
                // only when enumeration FAILED — treating that as "no streams"
                // would converge every open turn on this daemon as
                // unresumable. Legacy clients omit it for empty too, so for
                // them absence keeps its old meaning.
                if (
                    frame.inflightStreams === undefined &&
                    (frame.clientFeatures ?? []).includes(
                        DAEMON_FEATURE_HELLO_INFLIGHT
                    )
                ) {
                    this.log.warn(
                        `daemon.ws.hello daemonId=${daemonId} omitted inflightStreams (enumeration failed); skipping stream reconcile`
                    )
                    return
                }
                handleInflightStreams(frame.inflightStreams ?? [])
                return
            case 'ping': {
                const pong: DaemonWsFrame = { type: 'pong' }
                try {
                    socket.send(JSON.stringify(pong))
                } catch {}
                return
            }
            case 'pong':
                armPongDeadline()
                await this.registry.touchConnection(daemonId)
                return
            case 'ack':
                this.registry.handleAck(daemonId, frame)
                return
            case 'event':
                this.registry.handleEvent(daemonId, frame)
                return
            default:
                return
        }
    }
}
