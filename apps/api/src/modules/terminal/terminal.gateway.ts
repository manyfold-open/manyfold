import { narraNexusBaseWorkingPath } from '@manyfold/shared'
import {
    BadRequestException,
    Injectable,
    Logger,
    OnModuleInit
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket as WsClient } from 'ws'
import type { Agent } from '@manyfold/db'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { principalScopes } from '@/modules/auth/auth-principal'
import { AgentsService } from '@/modules/agents/agents.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { SpritesTerminal } from '@/modules/terminal/sprites-terminal'
import { K8sTerminal } from '@/modules/terminal/k8s-terminal'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { buildStatusBanner } from '@/modules/terminal/status-banner'
import { HOME_ROOT_ID } from '@/modules/agents/bootstrap/file-roots'
import {
    FilesContextBuilder,
    resolveSafePath
} from '@/modules/agents/files/files-context'

interface TerminalQuery {
    agentId?: string
    sandboxId?: string
    token?: string
    cols?: string
    cwdPath?: string
    cwdRootId?: string
    rows?: string
}

const SANDBOX_TERMINAL_CWD = '/home/sprite'

const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 35_000

@Injectable()
export class TerminalGateway implements OnModuleInit {
    private readonly log = new Logger(TerminalGateway.name)

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        private readonly bearerAuth: BearerAuthService,
        private readonly agents: AgentsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly sprites: SpritesTerminal,
        private readonly k8s: K8sTerminal,
        private readonly daemon: DaemonTerminal,
        private readonly daemonHosts: DaemonHostService,
        private readonly files: FilesContextBuilder
    ) {}

    onModuleInit(): void {
        const adapter = this.adapterHost.httpAdapter as unknown as {
            getInstance: () => FastifyInstance
        }
        const fastify = adapter.getInstance()

        fastify.get(
            '/api/terminal',
            { websocket: true },
            (socket: WsClient, req: FastifyRequest) => {
                void this.handleConnection(socket, req).catch((err) => {
                    const message = (err as Error).message
                    this.log.warn(`terminal.handle_failed ${message}`)
                    try {
                        if (socket.readyState === socket.OPEN)
                            socket.send(
                                JSON.stringify({
                                    type: 'error',
                                    message
                                })
                            )
                    } catch {}
                    try {
                        socket.close(1011, 'handler failed')
                    } catch {}
                })
            }
        )

        this.log.log('registered WS route GET /api/terminal')
    }

    private async handleConnection(
        socket: WsClient,
        req: FastifyRequest
    ): Promise<void> {
        const query = (req.query ?? {}) as TerminalQuery
        const agentId = query.agentId?.trim()
        const sandboxId = query.sandboxId?.trim()
        const token = query.token?.trim()
        const cols = clampDim(query.cols, 80, 20, 500)
        const rows = clampDim(query.rows, 24, 5, 200)

        if (!token || (!agentId && !sandboxId)) {
            sendError(socket, 'missing token or agentId/sandboxId')
            socket.close(4400, 'bad request')
            return
        }

        let auth
        try {
            auth = await this.bearerAuth.verifyBearerToken(token)
        } catch (err) {
            sendError(socket, `auth failed: ${(err as Error).message}`)
            socket.close(4401, 'unauthorized')
            return
        }

        if (auth.kind !== 'human-session') {
            const scopes = principalScopes(auth)
            const ok =
                scopes.includes('api.full') || scopes.includes('terminal:edit')
            if (!ok) {
                sendError(socket, 'token missing scope: one of [terminal:edit]')
                socket.close(4401, 'unauthorized')
                return
            }
        }

        // Bare-sandbox terminal: no agent, addressed by sandboxId. Lean flow —
        // host resolve + opt-in gate + user-token tunnel.
        if (sandboxId && !agentId) {
            await this.handleSandboxSession(socket, {
                sandboxId,
                userId: auth.userId,
                cols,
                rows
            })
            return
        }
        if (!agentId) {
            sendError(socket, 'missing agentId')
            socket.close(4400, 'bad request')
            return
        }

        const rows_ = await this.agents.listForUser(auth.userId)
        const agent = rows_.find((r) => r.agent.id === agentId)?.agent
        if (!agent) {
            sendError(socket, 'agent not found for this user')
            socket.close(4404, 'not found')
            return
        }
        if (agent.status !== 'running') {
            sendError(
                socket,
                `agent is ${agent.status}; terminal is only available when running`
            )
            socket.close(4409, 'not running')
            return
        }
        if (agent.runtime === 'external') {
            sendError(socket, 'external-runtime agents have no terminal')
            socket.close(4404, 'not supported')
            return
        }
        // Opt-in terminal: off by default for every sandbox (incl. existing
        // agents). Enable it on the sandbox first; doing so authorizes the
        // per-session user api.full token injected by SpritesTerminal.
        if (agent.runtime === 'sprites') {
            const host = agent.hostId
                ? await this.runtimes.findHostById(agent.hostId)
                : null
            if (!host?.terminalEnabled) {
                sendError(
                    socket,
                    'terminal is disabled for this sandbox; enable it first'
                )
                socket.close(4403, 'terminal disabled')
                return
            }
        }

        let cwd: string | undefined
        try {
            cwd = await this.resolveCwd(
                agent as Agent,
                query.cwdRootId,
                query.cwdPath
            )
        } catch (err) {
            sendError(socket, (err as Error).message)
            socket.close(4400, 'bad cwd')
            return
        }
        const terminalCwd = cwd ?? defaultTerminalCwd(agent as Agent)

        let terminalPty: boolean | null = null
        if (agent.runtime === 'daemon' && agent.daemonId) {
            const host = await this.daemonHosts.findById(agent.daemonId)
            terminalPty = host?.terminalPty ?? null
        }

        try {
            socket.send(
                JSON.stringify({
                    type: 'session_info',
                    agent_id: agent.id,
                    runtime: agent.runtime,
                    framework: agent.framework,
                    cwd: terminalCwd,
                    cols,
                    rows,
                    ...(agent.runtime === 'daemon'
                        ? { terminal_pty: terminalPty }
                        : {})
                })
            )
            socket.send(Buffer.from(buildStatusBanner(agent), 'utf8'), {
                binary: true
            })
        } catch {}

        const connectedAt = Date.now()
        this.attachHeartbeat(socket, `agent=${agent.id}`)

        const onClose = (): void => {
            const durationMs = Date.now() - connectedAt
            this.log.log(
                `terminal.closed agent=${agent.id} runtime=${agent.runtime} durationMs=${durationMs}`
            )
        }

        try {
            if (agent.runtime === 'sprites') {
                await this.sprites.tunnel({
                    userId: agent.userId,
                    sessionKey: agent.id,
                    accountId: agent.accountId,
                    spriteName: agent.spriteName,
                    hostId: agent.hostId,
                    mountPath: agent.mountPath,
                    extras: agent.extras,
                    agentId: agent.id,
                    cols,
                    cwd: terminalCwd,
                    rows,
                    client: socket,
                    onClose
                })
            } else if (agent.runtime === 'daemon') {
                await this.daemon.tunnel({
                    agent: agent as Agent,
                    cols,
                    cwd: terminalCwd,
                    rows,
                    client: socket,
                    onClose
                })
            } else {
                await this.k8s.tunnel({
                    agent: agent as Agent,
                    cols,
                    cwd: terminalCwd,
                    rows,
                    client: socket,
                    onClose
                })
            }
        } catch (err) {
            const message = (err as Error).message
            this.log.warn(`terminal.tunnel_failed ${message}`)
            sendError(socket, message)
            try {
                socket.close(1011, 'tunnel failed')
            } catch {}
        }
    }

    // Bare-sandbox terminal: addressed by sandboxId, no agent. Resolves the host,
    // enforces the opt-in gate, then tunnels with a host-derived target (the
    // user api.full token is minted per-session by SpritesTerminal).
    private async handleSandboxSession(
        socket: WsClient,
        args: { sandboxId: string; userId: string; cols: number; rows: number }
    ): Promise<void> {
        const host = await this.runtimes.findHostById(args.sandboxId)
        if (
            !host ||
            host.userId !== args.userId ||
            host.kind !== 'sandbox' ||
            host.status !== 'active' ||
            !host.spriteName
        ) {
            sendError(socket, 'sandbox not found for this user')
            socket.close(4404, 'not found')
            return
        }
        if (!host.terminalEnabled) {
            sendError(
                socket,
                'terminal is disabled for this sandbox; enable it first'
            )
            socket.close(4403, 'terminal disabled')
            return
        }
        try {
            socket.send(
                JSON.stringify({
                    type: 'session_info',
                    sandbox_id: host.id,
                    runtime: 'sprites',
                    cwd: SANDBOX_TERMINAL_CWD,
                    cols: args.cols,
                    rows: args.rows
                })
            )
        } catch {}

        const connectedAt = Date.now()
        this.attachHeartbeat(socket, `sandbox=${host.id}`)
        const onClose = (): void => {
            this.log.log(
                `terminal.closed sandbox=${host.id} durationMs=${Date.now() - connectedAt}`
            )
        }
        try {
            await this.sprites.tunnel({
                userId: host.userId,
                sessionKey: host.id,
                accountId: host.accountId,
                spriteName: host.spriteName,
                hostId: host.id,
                mountPath: SANDBOX_TERMINAL_CWD,
                extras: {},
                cols: args.cols,
                cwd: SANDBOX_TERMINAL_CWD,
                rows: args.rows,
                client: socket,
                onClose
            })
        } catch (err) {
            const message = (err as Error).message
            this.log.warn(`terminal.tunnel_failed ${message}`)
            sendError(socket, message)
            try {
                socket.close(1011, 'tunnel failed')
            } catch {}
        }
    }

    private attachHeartbeat(socket: WsClient, label: string): void {
        let pongTimer: NodeJS.Timeout | null = null
        let pingTimer: NodeJS.Timeout | null = null
        const armPong = (): void => {
            if (pongTimer) clearTimeout(pongTimer)
            pongTimer = setTimeout(() => {
                this.log.warn(`terminal.pong_timeout ${label}`)
                try {
                    socket.close(1011, 'pong timeout')
                } catch {}
            }, PONG_TIMEOUT_MS)
        }
        const stop = (): void => {
            if (pongTimer) clearTimeout(pongTimer)
            if (pingTimer) clearInterval(pingTimer)
            pongTimer = null
            pingTimer = null
        }
        socket.on('pong', armPong)
        socket.on('close', stop)
        armPong()
        pingTimer = setInterval(() => {
            try {
                socket.ping()
            } catch {}
        }, PING_INTERVAL_MS)
    }

    private async resolveCwd(
        agent: Agent,
        rootId: string | undefined,
        rawPath: string | undefined
    ): Promise<string | undefined> {
        const path = rawPath?.trim()
        if (!path) return undefined
        const ctx = await this.files.build(agent, rootId?.trim() || undefined)
        const abs = resolveSafePath(ctx.mountPath, path)
        const stat = await ctx.stat(abs)
        if (!stat)
            throw new BadRequestException(`terminal cwd not found: ${path}`)
        if (stat.entry.type !== 'dir')
            throw new BadRequestException(
                `terminal cwd must be a directory: ${path}`
            )
        return abs
    }
}

export const defaultTerminalCwd = (agent: Agent): string => {
    if (agent.framework === 'narranexus') {
        const homeRoot = Array.isArray(agent.fileRoots)
            ? agent.fileRoots.find((root) => root.id === HOME_ROOT_ID)
            : null
        if (homeRoot?.path) return homeRoot.path
        return narraNexusBaseWorkingPath(agent.runtime).replace(
            /\/workspaces$/,
            ''
        )
    }
    if (agent.runtime === 'daemon' && agent.workspacePath)
        return agent.workspacePath
    return agent.mountPath
}

const sendError = (socket: WsClient, message: string): void => {
    try {
        if (socket.readyState === socket.OPEN)
            socket.send(JSON.stringify({ type: 'error', message }))
    } catch {}
}

const clampDim = (
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number
): number => {
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, Math.floor(n)))
}
