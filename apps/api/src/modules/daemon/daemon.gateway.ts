import {
    auditAction,
    DAEMON_FEATURE_EXEC_RESUME,
    DAEMON_MIN_CLI_VERSION,
    isCliVersionTooOld,
    DaemonClientProcess,
    DaemonWsFrame
} from '@manyfold/shared'
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket as WsClient } from 'ws'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { agentRuntimes, auditLogs, type Database } from '@manyfold/db'
import { Inject } from '@nestjs/common'
import { DRIZZLE } from '@/db/tokens'
import { DaemonTokenService } from './daemon-token.service'
import { DaemonHostService } from './daemon-host.service'
import { DaemonRegistryService } from './daemon-registry.service'
import { DaemonExecResumeService } from './daemon-exec-resume.service'
import {
    daemonClientProcessFields,
    parseDaemonClientProcess
} from './daemon-client-process'

const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 35_000
const HELLO_TIMEOUT_MS = 10_000
type HelloFrame = Extract<DaemonWsFrame, { type: 'hello' }>
interface HelloDecision {
    accepted: boolean
    clientProcess?: DaemonClientProcess
}

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
        const authorization = req.headers?.authorization
        const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]
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
        if (isCliVersionTooOld(host.cliVersion, DAEMON_MIN_CLI_VERSION)) {
            socket.close(
                4406,
                `daemon CLI ${DAEMON_MIN_CLI_VERSION} or newer required; run mf update`
            )
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
        let helloSeen = false
        let clientProcess: DaemonClientProcess | undefined
        let bufferedHello: HelloFrame | null = null
        let acceptedClientFeatures: string[] = []
        let acceptHello!: (accepted: boolean) => void
        const helloReady = new Promise<boolean>((resolve) => {
            acceptHello = resolve
        })
        const helloTimer = setTimeout(() => {
            acceptHello(false)
            try {
                socket.close(4408, 'daemon hello required')
            } catch {}
        }, HELLO_TIMEOUT_MS)

        const handleHelloVersion = (frame: HelloFrame): HelloDecision => {
            const accepted = !isCliVersionTooOld(
                frame.cliVersion,
                DAEMON_MIN_CLI_VERSION
            )
            if (accepted && !helloSeen) {
                clientProcess = parseDaemonClientProcess(frame.clientProcess)
                helloSeen = true
            }
            acceptHello(accepted)
            if (!accepted)
                socket.close(
                    4406,
                    `daemon CLI ${DAEMON_MIN_CLI_VERSION} or newer required; run mf update`
                )
            return { accepted, clientProcess }
        }

        const handleHelloWhenReady = (frame: HelloFrame): void => {
            acceptedClientFeatures = Array.isArray(frame.clientFeatures)
                ? frame.clientFeatures.filter((feature) =>
                    typeof feature === 'string' && /^[-a-z0-9._:]{1,80}$/i.test(feature)
                ).slice(0, 64)
                : []
            if (!registered) {
                bufferedHello = frame
                return
            }
            const evidence = this.registry.recordHelloForSocket(
                host.id, socket, acceptedClientFeatures
            )
            if (!evidence) return
            if (frame.inflightStreams === undefined) return
            void this.resumeService
                .handleInflightStreams(host.id, frame.inflightStreams, evidence)
                .catch((err) =>
                    this.log.warn(
                        `daemon.ws.resume_failed daemonId=${host.id} ${(err as Error).message}`
                    )
                )
        }

        const handleMessage = (raw: unknown): void => {
            void this.handleFrame(
                host.id,
                socket,
                raw,
                armPongDeadline,
                handleHelloWhenReady,
                handleHelloVersion
            ).catch((err: unknown) => {
                this.log.warn(
                    `daemon.ws.frame_failed daemonId=${host.id} ${(err as Error).message}`
                )
                try {
                    socket.close(1011, 'frame failed')
                } catch {}
            })
        }
        socket.off('message', earlyMessageListener)
        socket.on('message', handleMessage)
        for (const queued of earlyMessages) handleMessage(queued)
        socket.on('close', () => {
            acceptHello(false)
            stopTimers()
            void this.registry
                .unregister(host.id, socket)
                .catch((err: unknown) => {
                    this.log.warn(
                        `daemon.ws.unregister_failed daemonId=${host.id} ${(err as Error).message}`
                    )
                })
        })
        socket.on('error', (err) => {
            this.log.warn(
                `daemon.ws.error daemonId=${host.id} userId=${host.userId} cliVersion=${host.cliVersion ?? 'unknown'} hostname=${host.hostname ?? 'unknown'} ${(err as Error).message}`
            )
        })

        const helloAccepted = await helloReady
        clearTimeout(helloTimer)
        if (!helloAccepted || socket.readyState !== 1) return

        await this.registry.register({
            daemonId: host.id,
            userId: host.userId,
            cliVersion: host.cliVersion,
            hostname: host.hostname,
            clientProcess,
            clientFeatures: acceptedClientFeatures,
            socket
        })
        if (socket.readyState !== 1) return
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

        if (bufferedHello) {
            const pending = bufferedHello
            bufferedHello = null
            handleHelloWhenReady(pending)
        }

        armPongDeadline()
        pingTimer = setInterval(() => {
            const ping: DaemonWsFrame = { type: 'ping' }
            try {
                socket.send(JSON.stringify(ping))
            } catch {}
        }, PING_INTERVAL_MS)
    }

    // What a restarted daemon reports once about the execs it inherited and
    // about a self-update it had to undo (ADR-0029 §4/§5): logged and kept
    // as audit rows on the daemon, since neither has a user request behind it.
    private async recordHelloReports(
        daemonId: string,
        frame: HelloFrame
    ): Promise<void> {
        const recovery = frame.recovery
        if (
            recovery &&
            typeof recovery === 'object' &&
            ['adopted', 'completed', 'crashed'].every(
                (key) =>
                    typeof (recovery as unknown as Record<string, unknown>)[
                        key
                    ] === 'number'
            )
        ) {
            this.log.log(
                `daemon.ws.hello.recovery daemonId=${daemonId} adopted=${recovery.adopted} completed=${recovery.completed} crashed=${recovery.crashed}`
            )
            await this.audit(auditAction.DAEMON_EXEC_RECOVERED, daemonId, {
                adopted: recovery.adopted,
                completed: recovery.completed,
                crashed: recovery.crashed
            })
        }
        const rollback = frame.rollback
        if (
            rollback &&
            typeof rollback === 'object' &&
            typeof rollback.fromVersion === 'string' &&
            typeof rollback.toVersion === 'string' &&
            typeof rollback.reason === 'string'
        ) {
            this.log.warn(
                `daemon.ws.hello.rollback daemonId=${daemonId} from=${rollback.fromVersion} to=${rollback.toVersion} reason=${JSON.stringify(rollback.reason.slice(0, 200))}`
            )
            await this.audit(auditAction.DAEMON_UPGRADE_ROLLED_BACK, daemonId, {
                fromVersion: rollback.fromVersion.slice(0, 64),
                toVersion: rollback.toVersion.slice(0, 64),
                reason: rollback.reason.slice(0, 500),
                at: typeof rollback.at === 'string' ? rollback.at.slice(0, 40) : null
            })
        }
    }

    private async audit(
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: null,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `failed to write audit ${action}/${subject}: ${(err as Error).message}`
            )
        }
    }

    private async handleFrame(
        daemonId: string,
        socket: WsClient,
        raw: unknown,
        armPongDeadline: () => void,
        handleAcceptedHello: (frame: HelloFrame) => void,
        handleHelloVersion: (frame: HelloFrame) => HelloDecision
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
            case 'hello': {
                const hello = handleHelloVersion(frame)
                if (!hello.accepted) return
                handleAcceptedHello(frame)
                const features = Array.isArray(frame.clientFeatures)
                    ? frame.clientFeatures
                          .filter(
                              (value) =>
                                  typeof value === 'string' &&
                                  /^[-a-z0-9._:]{1,80}$/i.test(value)
                          )
                          .slice(0, 64)
                          .join(',')
                    : ''
                const inventory =
                    frame.inflightStreams === undefined
                        ? 'missing'
                        : Array.isArray(frame.inflightStreams)
                          ? 'present'
                          : 'invalid'
                this.log.log(
                    `daemon.ws.hello daemonId=${daemonId} inflightStreams=${Array.isArray(frame.inflightStreams) ? frame.inflightStreams.length : 'unknown'} inventory=${inventory} clientFeatures=${features} ${daemonClientProcessFields(hello.clientProcess)}`
                )
                void this.recordHelloReports(daemonId, frame)
                // Missing inventory means enumeration failed, never an empty
                // stream set. Preserve resumable turns until the next hello.
                if (frame.inflightStreams === undefined) {
                    this.log.warn(
                        `daemon.ws.hello daemonId=${daemonId} omitted inflightStreams (enumeration failed); skipping stream reconcile`
                    )
                    return
                }
                return
            }
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
