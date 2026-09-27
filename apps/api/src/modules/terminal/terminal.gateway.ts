import {
    Optional,
    BadRequestException,
    Injectable,
    Logger,
    OnModuleInit
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket as WsClient } from 'ws'
import type { Agent, RuntimeHostRow } from '@manyfold/db'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { principalScopes } from '@/modules/auth/auth-principal'
import { AgentsService } from '@/modules/agents/agents.service'
import { RuntimeAuthProfilesService } from '@/modules/agent-runtimes/auth/runtime-auth-profiles.service'
import {
    assertHostHonoursAuthContext,
    authContextRefFor,
    effectiveModelConfigSource
} from '@/modules/agents/model-config/runtime-auth-selection'
import { SpritesTerminal } from '@/modules/terminal/sprites-terminal'
import {
    TerminalResumeService,
    type TerminalResumeOutcome
} from '@/modules/terminal/terminal-resume.service'
import {
    DAEMON_FEATURE_HERDR_TERMINAL,
    DAEMON_FEATURE_PTY_COMMAND,
    DAEMON_FEATURE_PTY_TERMINAL,
    isRuntimeUsable
} from '@manyfold/shared'
import { K8sTerminal } from '@/modules/terminal/k8s-terminal'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import {
    TerminalSessionsRepository,
    TERMINAL_LEASE_RENEW_MS
} from '@/modules/terminal/terminal-sessions.repository'
import {
    TerminalHolderService,
    type TerminalCloseCause
} from '@/modules/terminal/terminal-holder.service'
import { buildStatusBanner } from '@/modules/terminal/status-banner'
import {
    FilesContextBuilder,
    resolveSafePath
} from '@/modules/agents/files/files-context'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'

interface TerminalQuery {
    agentId?: string
    sandboxId?: string
    runtimeId?: string
    operationId?: string
    token?: string
    cols?: string
    cwdPath?: string
    cwdRootId?: string
    resumeChatSessionId?: string
    // The terminal a reconnecting tab replaces (ADR-0029 §1): its process is
    // killed and its hold released before this one resumes, so an API
    // restart never leaves the user's own reconnect facing `session-held`.
    prevTerminalId?: string
    rows?: string
    // `herdr`: the shell runs herdr's TUI (ADR-0031) so the browser shows the
    // runtime's herdr — with the session's pane already focused by the
    // handoff — instead of a login shell or the framework TUI. No hold is
    // taken: the pane herdr hosts has its own terminal row.
    viewer?: string
}

const SANDBOX_TERMINAL_CWD = '/home/sprite'

const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 35_000

// How the shell reaches the machine (ADR-0037): the host's daemon whenever
// it is online and owns terminals, else the provider's own exec channel.
type TerminalTransport = 'daemon' | 'sprites' | 'k8s'

@Injectable()
export class TerminalGateway implements OnModuleInit {
    private readonly log = new Logger(TerminalGateway.name)

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        private readonly bearerAuth: BearerAuthService,
        private readonly agents: AgentsService,
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly sprites: SpritesTerminal,
        private readonly k8s: K8sTerminal,
        private readonly daemon: DaemonTerminal,
        private readonly files: FilesContextBuilder,
        private readonly resume: TerminalResumeService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, the operationId branch reports unavailable.
        @Optional()
        private readonly runtimeAuth?: RuntimeAuthProfilesService,
        // Same rule. Absent (tests), agent terminals get no durable row and a
        // resume is never applied: without a holder it could double-write.
        @Optional()
        private readonly terminals?: TerminalSessionsRepository,
        @Optional()
        private readonly holder?: TerminalHolderService
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
        const runtimeId = query.runtimeId?.trim()
        const operationId = query.operationId?.trim()
        const token = query.token?.trim()
        const cols = clampDim(query.cols, 80, 20, 500)
        const rows = clampDim(query.rows, 24, 5, 200)

        if (!token || (!agentId && !sandboxId && !runtimeId && !operationId)) {
            sendError(
                socket,
                'missing token or agentId/sandboxId/runtimeId/operationId'
            )
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
        // Runtime auth profile sign-in: addressed by the login operation the
        // API minted; the daemon runs the vendor sign-in inside that profile's
        // credential context and the outcome is reconciled when it closes.
        if (operationId && !agentId) {
            await this.handleAuthLoginSession(socket, {
                operationId,
                userId: auth.userId,
                cols,
                rows
            })
            return
        }
        // Bare-runtime terminal: the runtime page's sign-in shell, addressed
        // by runtime so it works with zero agents on the host.
        if (runtimeId && !agentId) {
            await this.handleRuntimeSession(socket, {
                runtimeId,
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

        const ctx = await this.agents.contextForCaller(
            agentId,
            auth.userId,
            false
        )
        if (!ctx) {
            sendError(socket, 'agent not found for this user')
            socket.close(4404, 'not found')
            return
        }
        const { agent, host, placement } = ctx
        if (placement === 'external' || !host) {
            sendError(socket, 'external-runtime agents have no terminal')
            socket.close(4404, 'not supported')
            return
        }
        // The one admission rule (ADR-0037): an installed runtime on a ready
        // host. A hosted machine that is asleep is admitted — the exec that
        // opens the shell is what wakes it.
        if (!isRuntimeUsable(ctx.availability)) {
            sendError(
                socket,
                `agent is ${ctx.availability}; terminal is only available when the runtime is ready`
            )
            socket.close(4409, 'not running')
            return
        }
        // Opt-in terminal: off by default for every hosted machine (incl.
        // existing agents). Enable it on the host first; doing so authorizes
        // the per-session user api.full token the shell carries.
        let modelCredentialsAllowed = false
        if (host.kind === 'hosted') {
            if (!host.terminalEnabled) {
                sendError(
                    socket,
                    'terminal is disabled for this sandbox; enable it first'
                )
                socket.close(4403, 'terminal disabled')
                return
            }
            modelCredentialsAllowed = host.terminalModelCredentials
        }
        const herdrViewer = query.viewer?.trim() === 'herdr'

        // The daemon keeps its terminals (ADR-0029 §6): the pty is addressed
        // by the row's id, a reconnect attaches to it, and the daemon's
        // inventory, not this tunnel's lease, is its proof of life. Whenever
        // the host's daemon is online and owns terminals it is preferred over
        // the provider's exec channel; a local machine has nothing else.
        const daemonFeatures = ctx.daemon?.clientFeatures ?? []
        const daemonOwnsTerminals =
            ctx.daemonOnline && daemonFeatures.includes(DAEMON_FEATURE_PTY_TERMINAL)
        const transport: TerminalTransport =
            host.kind === 'local' || daemonOwnsTerminals
                ? 'daemon'
                : placement === 'k8s'
                  ? 'k8s'
                  : 'sprites'
        // A daemon runs against the CLI sign-in that already lives on the
        // machine, but it does need to be new enough to run a command as its
        // shell's argv, or it would open a plain shell while the UI promised
        // a resumed session.
        const daemonCanResume =
            transport === 'daemon' &&
            daemonFeatures.includes(DAEMON_FEATURE_PTY_COMMAND)
        // A herdr viewer is a plain process the browser watches: killed with
        // its socket (never daemon-owned), and never a resume of anything.
        const ownedTerminals =
            !herdrViewer && transport === 'daemon' && daemonOwnsTerminals
        if (herdrViewer) {
            const available =
                daemonCanResume &&
                daemonFeatures.includes(DAEMON_FEATURE_HERDR_TERMINAL) &&
                !!ctx.daemon?.herdrVersion
            if (!available) {
                sendError(socket, 'herdr is not available on this runtime')
                socket.close(4409, 'herdr unavailable')
                return
            }
        }
        const resumeSupported = transport === 'sprites' || daemonCanResume
        const runtimeLocalAgent =
            effectiveModelConfigSource(agent, placement) === 'runtime-local'
        const resumeSessionId = query.resumeChatSessionId?.trim()
        // Open straight into the framework TUI for this chat session when the
        // client asked for it. The client sends only the session id — the argv
        // is built here from the session's own framework_session_ref so no
        // caller can choose what runs on the machine.
        const resolution =
            resumeSessionId && resumeSupported && !herdrViewer
                ? await this.resume.resolve({
                      agentId: agent.id,
                      userId: agent.userId,
                      runtimeId: agent.runtimeId,
                      framework: agent.framework,
                      chatSessionId: resumeSessionId,
                      // Hosted machines are shared ground and the key is the
                      // platform's to hand out, so they gate it; a local
                      // machine's own on-disk sign-in needs no such consent,
                      // and neither does a runtime-local agent, whose TUI
                      // runs on the runtime's own sign-in (or its profile's).
                      modelCredentialsAllowed:
                          host.kind === 'local' ||
                          runtimeLocalAgent ||
                          modelCredentialsAllowed,
                      injectModelCredentials:
                          host.kind === 'hosted' && !runtimeLocalAgent,
                      workspacePath: agent.workspacePath,
                      model: agent.model
                  })
                : null
        let resume = herdrViewer
            ? { command: ['herdr'], env: {} }
            : (resolution?.resume ?? null)
        // Only when a resume was asked for: a runtime with no resume path never
        // consults the service, and "unavailable" is the honest word for it.
        let resumeOutcome: TerminalResumeOutcome | null =
            resumeSessionId && !herdrViewer
                ? (resolution?.outcome ?? 'unavailable')
                : null

        let cwd: string | undefined
        try {
            cwd = await this.resolveCwd(
                agent,
                query.cwdRootId,
                query.cwdPath
            )
        } catch (err) {
            sendError(socket, (err as Error).message)
            socket.close(4400, 'bad cwd')
            return
        }
        const terminalCwd =
            cwd ?? this.files.defaultTerminalCwd(agent, placement)

        const terminalPty =
            transport === 'daemon' ? (ctx.daemon?.terminalPty ?? null) : null

        // Attach first (ADR-0029 §6): a terminal the daemon still owns — the
        // one this tab had before its reconnect, or the one holding the very
        // session it wants — is attached to, hold and all, instead of being
        // opened again.
        const prevTerminalId = query.prevTerminalId?.trim() || null
        const reused =
            ownedTerminals && this.holder
                ? await this.holder.reusableTerminal({
                      userId: agent.userId,
                      agentId: agent.id,
                      sessionId: resumeSessionId || null,
                      prevTerminalId
                  })
                : null
        // Every check has passed: the terminal gets its durable identity, a
        // reconnect retires the terminal it replaces, and a resume takes the
        // session's writes as the LAST fallible step — a lost acquire still
        // opens the terminal, as a plain shell (ADR-0029 §1).
        const terminalRow =
            reused ??
            (this.terminals && transport !== 'k8s'
                ? await this.terminals.create({
                      userId: agent.userId,
                      agentId: agent.id,
                      runtime: transport,
                      hostId: host.id,
                      runtimeId: agent.runtimeId
                  })
                : null)
        const terminalId = terminalRow?.id ?? null
        // An owned terminal is addressed by its row id from the start, so any
        // instance can close it before the daemon has said a word.
        if (ownedTerminals && terminalId && !reused && this.terminals)
            await this.terminals.setHandle(terminalId, terminalId)
        if (prevTerminalId && prevTerminalId !== reused?.id && this.holder)
            await this.holder
                .supersede(prevTerminalId, auth.userId)
                .catch((err: Error) =>
                    this.log.warn(
                        `terminal.supersede_failed prev=${prevTerminalId}: ${err.message}`
                    )
                )
        if (resume && resumeSessionId && !herdrViewer) {
            const ref = resolution?.ref ?? null
            // A reused terminal already holds this very session.
            const outcome = reused
                ? 'applied'
                : terminalId && this.holder && ref
                  ? await this.holder.acquire({
                        terminalId,
                        userId: agent.userId,
                        agentId: agent.id,
                        sessionId: resumeSessionId,
                        expectedRef: ref
                    })
                  : 'unavailable'
            if (outcome !== 'applied') resume = null
            resumeOutcome = outcome
        }
        const finishTerminal = (cause: TerminalCloseCause): void => {
            if (!terminalId) return
            // A reused terminal that could not be reached is still the
            // daemon's; its inventory decides, not a failed tunnel.
            if (cause === 'tunnel-failed' && reused) cause = 'daemon-lost'
            void this.holder
                ?.finish(terminalId, cause)
                .catch((err: Error) =>
                    this.log.warn(
                        `terminal.finish_failed terminal=${terminalId}: ${err.message}`
                    )
                )
        }

        try {
            socket.send(
                JSON.stringify({
                    type: 'session_info',
                    agent_id: agent.id,
                    runtime: placement,
                    framework: agent.framework,
                    cwd: terminalCwd,
                    cols,
                    rows,
                    ...(transport === 'daemon'
                        ? { terminal_pty: terminalPty }
                        : {}),
                    // The client cannot predict this: the gate is decided here
                    // at connect (and again on every reconnect), against state
                    // its own stream view lags or leads.
                    ...(resumeOutcome ? { resume: resumeOutcome } : {}),
                    ...(herdrViewer ? { viewer: 'herdr' } : {}),
                    // Sent back as prevTerminalId on the tab's reconnect.
                    ...(terminalId ? { terminal_id: terminalId } : {})
                })
            )
            socket.send(Buffer.from(buildStatusBanner(ctx), 'utf8'), {
                binary: true
            })
        } catch {}

        const connectedAt = Date.now()
        this.attachHeartbeat(socket, `agent=${agent.id}`)
        // An owned terminal's lease is renewed on the daemon's inventory.
        if (terminalId && !ownedTerminals) this.attachLease(socket, terminalId)

        const onClose = (cause: TerminalCloseCause): void => {
            const durationMs = Date.now() - connectedAt
            this.log.log(
                `terminal.closed agent=${agent.id} runtime=${placement} transport=${transport} cause=${cause} durationMs=${durationMs}`
            )
            finishTerminal(cause)
        }

        try {
            // A profile-bound agent: refuse a host that cannot honour the
            // context rather than open a shell under the wrong sign-in.
            const authContext = authContextRefFor(agent, placement)
            if (authContext && transport === 'daemon')
                assertHostHonoursAuthContext(
                    authContext,
                    ctx.daemon,
                    'this machine'
                )
            const extraEnv =
                authContext && transport !== 'daemon'
                    ? await this.runtimeAuth?.sessionEnvForAgent(ctx)
                    : undefined
            if (authContext && transport !== 'daemon' && !extraEnv)
                assertHostHonoursAuthContext(authContext, null, 'this sandbox')
            if (transport === 'sprites') {
                await this.sprites.tunnel({
                    userId: agent.userId,
                    sessionKey: agent.id,
                    host,
                    mountPath: agent.mountPath,
                    extras: agent.extras,
                    ...(extraEnv ? { extraEnv } : {}),
                    agentId: agent.id,
                    terminalId,
                    cols,
                    cwd: terminalCwd,
                    rows,
                    resume,
                    client: socket,
                    onClose,
                    onToken: this.terminalRecorder(terminalId, 'token'),
                    onHandle: this.terminalRecorder(terminalId, 'handle')
                })
            } else if (transport === 'daemon') {
                await this.daemon.tunnel({
                    agent,
                    hostId: host.id,
                    placement,
                    terminalId,
                    cols,
                    cwd: terminalCwd,
                    rows,
                    resume,
                    client: socket,
                    onClose,
                    onToken: this.terminalRecorder(terminalId, 'token'),
                    onHandle: this.terminalRecorder(terminalId, 'handle'),
                    ...(ownedTerminals && terminalId
                        ? {
                              ownedTerminalId: terminalId,
                              boundTokenId: reused?.tokenId ?? null
                          }
                        : {})
                })
            } else {
                await this.k8s.tunnel({
                    agent,
                    host,
                    cols,
                    cwd: terminalCwd,
                    rows,
                    client: socket,
                    onClose: () => onClose('client-closed')
                })
            }
            // The browser may have gone before the driver attached its close
            // listener; a hold must not wait for the lease reaper over that.
            if (socket.readyState !== socket.OPEN)
                finishTerminal('client-closed')
        } catch (err) {
            const message = (err as Error).message
            this.log.warn(`terminal.tunnel_failed ${message}`)
            sendError(socket, message)
            try {
                socket.close(1011, 'tunnel failed')
            } catch {}
            finishTerminal('tunnel-failed')
        }
    }

    private terminalRecorder(
        terminalId: string | null,
        field: 'token' | 'handle'
    ): ((value: string) => void) | undefined {
        if (!terminalId || !this.terminals) return undefined
        const terminals = this.terminals
        return (value) => {
            void (
                field === 'token'
                    ? terminals.bindToken(terminalId, value)
                    : terminals.setHandle(terminalId, value)
            ).catch((err: Error) =>
                this.log.warn(
                    `terminal.record_failed terminal=${terminalId} field=${field}: ${err.message}`
                )
            )
        }
    }

    // The lease is the terminal's proof of life for every other instance.
    // Zero rows on renewal means the row was ended under this tunnel (a
    // takeover or the reaper): stop serving instead of writing over whoever
    // owns the session now. 4410 is not one of the codes the tab reconnects
    // on, so a superseded terminal does not fight its successor.
    private attachLease(socket: WsClient, terminalId: string): void {
        const terminals = this.terminals
        if (!terminals) return
        const timer = setInterval(() => {
            void terminals
                .renewLease(terminalId)
                .then((alive) => {
                    if (alive) return
                    this.log.warn(`terminal.lease.lost terminal=${terminalId}`)
                    try {
                        socket.close(4410, 'terminal superseded')
                    } catch {}
                })
                .catch((err: Error) =>
                    this.log.warn(
                        `terminal.lease.renew_failed terminal=${terminalId}: ${err.message}`
                    )
                )
        }, TERMINAL_LEASE_RENEW_MS)
        socket.on('close', () => clearInterval(timer))
    }

    // Bare-sandbox terminal: addressed by the host, no agent. Resolves the
    // host, enforces the opt-in gate, then tunnels with a host-derived target
    // (the user api.full token is minted per-session by SpritesTerminal). A
    // hosted machine on a pod provider gets its daemon's host shell instead.
    private async handleSandboxSession(
        socket: WsClient,
        args: { sandboxId: string; userId: string; cols: number; rows: number }
    ): Promise<void> {
        const host = await this.hosts.findForUser(args.userId, args.sandboxId)
        if (!host || host.kind !== 'hosted' || host.status !== 'ready') {
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
        if (host.providerRef?.kind !== 'sprites') {
            await this.tunnelHostShell(socket, host, args)
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
                host,
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

    // Bare-runtime terminal: resolves the runtime to its host. A hosted
    // machine reuses the bare-sandbox flow (same opt-in gate); a local machine
    // gets a host shell with no agent env. An external runtime has no host
    // shell to offer.
    private async handleRuntimeSession(
        socket: WsClient,
        args: { runtimeId: string; userId: string; cols: number; rows: number }
    ): Promise<void> {
        const ctx = await this.runtimeContext.forRuntime(args.runtimeId)
        if (!ctx || ctx.runtime.userId !== args.userId) {
            sendError(socket, 'runtime not found for this user')
            socket.close(4404, 'not found')
            return
        }
        const host = ctx.host
        if (!host || host.userId !== args.userId) {
            sendError(socket, 'this runtime has no host terminal')
            socket.close(4404, 'not supported')
            return
        }
        if (host.kind === 'hosted') {
            await this.handleSandboxSession(socket, {
                sandboxId: host.id,
                userId: args.userId,
                cols: args.cols,
                rows: args.rows
            })
            return
        }
        if (host.status !== 'ready') {
            sendError(socket, 'daemon host not found for this user')
            socket.close(4404, 'not found')
            return
        }
        await this.tunnelHostShell(socket, host, {
            ...args,
            runtime: ctx
        })
    }

    // A shell on the machine itself through its daemon: no agent env, no user
    // API token (DaemonTerminal.tunnelHost). Used by a local runtime's sign-in
    // shell and by a hosted pod's bare terminal.
    private async tunnelHostShell(
        socket: WsClient,
        host: RuntimeHostRow,
        args: { cols: number; rows: number; runtime?: RuntimeContext }
    ): Promise<void> {
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (!this.hostDaemons.isOnline(daemon)) {
            sendError(socket, 'the machine is offline; start its daemon first')
            socket.close(4409, 'offline')
            return
        }
        const runtime = args.runtime
        try {
            socket.send(
                JSON.stringify({
                    type: 'session_info',
                    ...(runtime
                        ? {
                              runtime_id: runtime.runtime.id,
                              runtime: runtime.placement,
                              framework: runtime.runtime.framework
                          }
                        : { sandbox_id: host.id, runtime: 'k8s' }),
                    cwd: host.homeDir,
                    cols: args.cols,
                    rows: args.rows,
                    terminal_pty: daemon?.terminalPty ?? null
                })
            )
        } catch {}

        const connectedAt = Date.now()
        const label = runtime ? `runtime=${runtime.runtime.id}` : `host=${host.id}`
        this.attachHeartbeat(socket, label)
        const onClose = (): void => {
            this.log.log(
                `terminal.closed ${label} host_kind=${host.kind} durationMs=${Date.now() - connectedAt}`
            )
        }
        try {
            await this.daemon.tunnelHost({
                daemonId: host.id,
                cols: args.cols,
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

    private async handleAuthLoginSession(
        socket: WsClient,
        args: {
            operationId: string
            userId: string
            cols: number
            rows: number
        }
    ): Promise<void> {
        if (!this.runtimeAuth) {
            sendError(socket, 'runtime auth profiles are unavailable')
            socket.close(4404, 'not supported')
            return
        }
        const runtimeAuth = this.runtimeAuth
        let target: Awaited<
            ReturnType<RuntimeAuthProfilesService['loginTarget']>
        >
        try {
            target = await runtimeAuth.loginTarget(
                args.userId,
                args.operationId
            )
        } catch (err) {
            sendError(socket, (err as Error).message)
            socket.close(4404, 'not found')
            return
        }
        try {
            socket.send(
                JSON.stringify({
                    type: 'session_info',
                    runtime_id: target.runtime.id,
                    runtime: target.placement,
                    framework: target.runtime.framework,
                    auth_operation_id: args.operationId,
                    cwd: target.host.homeDir,
                    cols: args.cols,
                    rows: args.rows,
                    terminal_pty: target.daemon.terminalPty ?? null
                })
            )
        } catch {}
        const connectedAt = Date.now()
        this.attachHeartbeat(socket, `auth-login=${args.operationId}`)
        const onClose = (): void => {
            this.log.log(
                `terminal.closed auth_operation=${args.operationId} durationMs=${Date.now() - connectedAt}`
            )
            void runtimeAuth.reconcileLogin(args.userId, args.operationId)
        }
        try {
            await this.daemon.tunnelAuthLogin({
                daemonId: target.host.id,
                authLogin: target.authLogin,
                cols: args.cols,
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
