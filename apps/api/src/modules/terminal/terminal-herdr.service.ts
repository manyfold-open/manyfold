import {
    BadGatewayException,
    ConflictException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import type { Agent } from '@manyfold/db'
import {
    CHAT_SESSION_TURN_IN_FLIGHT_CODE,
    DAEMON_FEATURE_HERDR_TERMINAL,
    DAEMON_FEATURE_PTY_COMMAND,
    HERDR_LAUNCH_FAILED_CODE,
    HERDR_NOT_RUNNING_CODE,
    HERDR_UNAVAILABLE_CODE,
    type DaemonHerdrFramework,
    type SessionHerdrFocusResponse,
    type SessionHerdrOpenRequest,
    type SessionHerdrOpenResponse,
    herdrFrameworksFor
} from '@manyfold/shared'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import { isRuntimeUsable } from '@manyfold/shared'
import { AgentsService } from '@/modules/agents/agents.service'
import { HostDaemonAccess } from '@/modules/agents/adapters/host-daemon-access'
import {
    assertHostHonoursAuthContext,
    authContextRefFor,
    effectiveModelConfigSource
} from '@/modules/agents/model-config/runtime-auth-selection'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { SessionHeldByTerminalError } from '@/modules/chat/chat.service'
import { DaemonRpcResponseError } from '@/modules/daemon/daemon-registry.service'
import type { RuntimeContext } from '@/modules/hosts/runtime-context.service'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import {
    PI_PLATFORM_VIEW_ENV,
    piPlatformDirect
} from '@/modules/agents/credentials/pi-agent-dir'
import {
    AGY_PLATFORM_VIEW_ENV,
    antigravityPlatformDirect
} from '@/modules/agents/credentials/antigravity-app-dir'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'
import { terminalResumeNeedsModelCredentials } from '@/modules/terminal/terminal-resume-command'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'
import { TerminalSessionsRepository } from '@/modules/terminal/terminal-sessions.repository'

// The label herdr shows for the session: what the web displays, else the
// session's own title, else the agent's name. Bounded and stripped of
// control characters, since it lands in a terminal's title bar.
const TITLE_MAX_LENGTH = 120

const HERDR_FRAMEWORKS: readonly DaemonHerdrFramework[] = [
    'claude-code',
    'codex',
    'pi',
    'antigravity-cli'
]

const isHerdrFramework = (value: string): value is DaemonHerdrFramework =>
    (HERDR_FRAMEWORKS as readonly string[]).includes(value)

const isControlCharacter = (ch: string): boolean => {
    const code = ch.charCodeAt(0)
    return code < 0x20 || code === 0x7f
}

const cleanTitle = (value: unknown): string =>
    typeof value === 'string'
        ? [...value]
              .map((ch) => (isControlCharacter(ch) ? ' ' : ch))
              .join('')
              .trim()
              .slice(0, TITLE_MAX_LENGTH)
        : ''

const unavailable = (message: string): ConflictException =>
    new ConflictException({ code: HERDR_UNAVAILABLE_CODE, message })

// What the daemon's refusal becomes for the caller. The daemon's ack carries
// one string with the code before the colon (herdr.ts); anything else on
// the wire — a timeout, a daemon that is not connected — is the computer
// not answering.
const herdrLaunchError = (err: unknown): HttpException => {
    if (err instanceof HttpException) return err
    if (err instanceof DaemonRpcResponseError) {
        const [code, ...rest] = err.message.split(':')
        const message = rest.join(':').trim() || err.message
        if (code.trim() === HERDR_NOT_RUNNING_CODE)
            return new ServiceUnavailableException({
                code: HERDR_NOT_RUNNING_CODE,
                message
            })
        return new BadGatewayException({
            code: HERDR_LAUNCH_FAILED_CODE,
            message: rest.length ? message : err.message
        })
    }
    return new ServiceUnavailableException({
        code: HERDR_UNAVAILABLE_CODE,
        message: 'the computer did not answer; check that its daemon is online'
    })
}

// Hand a chat session to herdr on the agent's machine (ADR-0031). The gates
// are the browser terminal's, minus the browser: the machine's daemon is
// online and advertises herdr, the session has a CLI ref and no running
// turn, the hold is taken as the last fallible step before anything starts,
// and a launch herdr refuses gives the hold back.
@Injectable()
export class TerminalHerdrService {
    private readonly log = new Logger(TerminalHerdrService.name)

    constructor(
        private readonly agents: AgentsService,
        private readonly chatRepo: ChatRepository,
        private readonly resume: TerminalResumeService,
        private readonly terminals: TerminalSessionsRepository,
        private readonly holder: TerminalHolderService,
        private readonly daemon: DaemonTerminal,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, a sleeping hosted machine cannot be woken for
        // the handoff.
        @Optional()
        private readonly hostAccess?: HostDaemonAccess
    ) {}

    async open(
        userId: string,
        agentId: string,
        sessionId: string,
        body: SessionHerdrOpenRequest
    ): Promise<SessionHerdrOpenResponse> {
        const { agent, host, daemon, placement, sandbox } =
            await this.herdrHost(userId, agentId)
        const session = await this.chatRepo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        if (!isHerdrFramework(agent.framework))
            throw unavailable(
                'herdr can only resume Claude Code, Codex, Pi and Antigravity CLI conversations'
            )
        // The host's CLI must know the framework's herdr kind too.
        if (
            !herdrFrameworksFor(daemon.clientFeatures ?? []).includes(
                agent.framework
            )
        )
            throw unavailable(
                sandbox
                    ? 'the sandbox runner cannot start this framework in herdr yet; upgrade its Manyfold CLI'
                    : 'update the Manyfold CLI on this computer to hand this framework to herdr'
            )
        // The resume below refuses such a sandbox too, but only as "nothing
        // to resume"; say what the user can change.
        if (
            sandbox &&
            terminalResumeNeedsModelCredentials(agent.framework) &&
            !sandbox.terminalModelCredentials
        )
            throw unavailable(
                'turn on model credentials in the terminal for this sandbox first; the TUI resumes the conversation with them'
            )
        // A profile-bound agent's TUI must answer as that account, which
        // only a host that honours the context can arrange.
        const authContext = authContextRefFor(agent, placement)
        if (authContext)
            assertHostHonoursAuthContext(
                authContext,
                daemon,
                sandbox ? 'this sandbox' : 'this machine'
            )

        const runtimeLocalAgent =
            effectiveModelConfigSource(agent, placement) === 'runtime-local'
        const resolution = await this.resume.resolve({
            agentId: agent.id,
            runtimeId: agent.runtimeId,
            framework: agent.framework,
            chatSessionId: sessionId,
            // A self-owned machine's own sign-in is what the TUI uses, so
            // there is no consent to ask for, and a runtime-local agent's TUI
            // runs on the runtime's own sign-in (or its profile's); a sandbox
            // hands the platform's credentials to the TUI only when it opted
            // in, as the browser terminal does.
            modelCredentialsAllowed:
                !sandbox ||
                runtimeLocalAgent ||
                sandbox.terminalModelCredentials === true,
            injectModelCredentials: !!sandbox && !runtimeLocalAgent,
            model: agent.model
        })
        if (resolution.outcome === 'turn-in-flight')
            throw new ConflictException({
                code: CHAT_SESSION_TURN_IN_FLIGHT_CODE,
                message: 'this conversation is still being answered'
            })
        if (!resolution.resume || !resolution.ref)
            throw unavailable(
                'this conversation has no CLI session to resume yet'
            )
        // A pi TUI on the platform's key runs on the platform view, which a
        // browser TUI's command builds on its way to pi; herdr runs pi by
        // name, so the view is built first and herdr's pi pointed at it.
        let resume = resolution.resume
        if (
            agent.framework === 'pi' &&
            resume.env[PI_PLATFORM_VIEW_ENV] !== undefined
        ) {
            try {
                resume = piPlatformDirect(
                    resume,
                    await this.daemon.preparePiView(host.id, resume.env)
                )
            } catch (err) {
                throw herdrLaunchError(err)
            }
        }
        // agy the same way: herdr's `agy` kind runs agy by name, pointed at
        // the view by the flag its prepare step prints.
        if (
            agent.framework === 'antigravity-cli' &&
            resume.env[AGY_PLATFORM_VIEW_ENV] !== undefined
        ) {
            try {
                resume = antigravityPlatformDirect(
                    resume,
                    await this.daemon.prepareAntigravityView(
                        host.id,
                        resume.env,
                        agent.workspacePath ?? agent.mountPath ?? null
                    )
                )
            } catch (err) {
                throw herdrLaunchError(err)
            }
        }

        // The row first, addressed by its own id so any instance can close
        // the pane through the daemon; then the hold, the last step that may
        // fail before anything runs (ADR-0029 §1).
        const row = await this.terminals.create({
            userId,
            agentId,
            runtime: 'daemon',
            hostId: host.id,
            runtimeId: agent.runtimeId,
            client: 'herdr'
        })
        await this.terminals.setHandle(row.id, row.id)
        const outcome = await this.holder.acquire({
            terminalId: row.id,
            userId,
            agentId,
            sessionId,
            expectedRef: resolution.ref,
            client: 'herdr'
        })
        if (outcome !== 'applied') {
            await this.holder.finish(row.id, 'tunnel-failed')
            if (outcome === 'session-held')
                throw new SessionHeldByTerminalError()
            if (outcome === 'turn-in-flight')
                throw new ConflictException({
                    code: CHAT_SESSION_TURN_IN_FLIGHT_CODE,
                    message: 'this conversation is still being answered'
                })
            throw unavailable('the conversation could not be handed over')
        }

        const title =
            cleanTitle(body.title) || cleanTitle(session.title) || agent.name
        try {
            const herdr = await this.daemon.openInHerdr({
                agent,
                terminalId: row.id,
                framework: agent.framework,
                resume,
                title,
                chatSessionId: sessionId,
                hostId: host.id,
                placement,
                onToken: (tokenId) => {
                    void this.terminals
                        .bindToken(row.id, tokenId)
                        .catch((err: Error) =>
                            this.log.warn(
                                `terminal.herdr.token_bind_failed terminal=${row.id}: ${err.message}`
                            )
                        )
                }
            })
            this.log.log(
                `terminal.herdr.opened terminal=${row.id} agent=${agent.id} session=${sessionId} pane=${herdr.paneId}`
            )
            return { terminalId: row.id, herdr }
        } catch (err) {
            this.log.warn(
                `terminal.herdr.open_failed terminal=${row.id} agent=${agent.id}: ${(err as Error).message}`
            )
            // Nothing runs in herdr: the row ends as failed and the hold goes
            // back with the import the release always runs.
            await this.holder.finish(row.id, 'tunnel-failed')
            throw herdrLaunchError(err)
        }
    }

    async focus(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<SessionHerdrFocusResponse> {
        const { host } = await this.herdrHost(userId, agentId)
        const session = await this.chatRepo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        if (!session.holderTerminalId || session.holderClient !== 'herdr')
            throw unavailable('this conversation is not open in herdr')
        const row = await this.terminals.findById(session.holderTerminalId)
        if (!row || row.endedAt || row.agentId !== agentId)
            throw unavailable('this conversation is not open in herdr')
        const daemonId = row.hostId ?? host.id
        try {
            const focused = await this.daemon.focusHerdr(daemonId, row.id)
            return { focused }
        } catch (err) {
            throw herdrLaunchError(err)
        }
    }

    // The agent, owned and usable, and the daemon of its machine that can
    // hand its sessions to herdr (ADR-0036): a local computer's own daemon,
    // or a hosted machine's (woken if asleep). Either must be online and
    // advertise herdr.
    private async herdrHost(
        userId: string,
        agentId: string
    ): Promise<{
        agent: Agent
        host: RuntimeHostRow
        daemon: HostDaemonRow
        placement: RuntimeContext['placement']
        sandbox: RuntimeHostRow | null
    }> {
        const ctx = await this.agents.contextForCaller(agentId, userId, false)
        if (!ctx) throw new NotFoundException('agent not found for this user')
        const { agent, host, placement } = ctx
        if (!host)
            throw unavailable('this agent does not run on a machine')
        // A local computer whose daemon is away is the one state the user
        // can fix themselves; say so before the generic refusal.
        if (ctx.availability === 'offline')
            throw new ServiceUnavailableException({
                code: HERDR_UNAVAILABLE_CODE,
                message: 'the computer is offline; start its daemon first'
            })
        if (!isRuntimeUsable(ctx.availability))
            throw unavailable(
                `agent is ${ctx.availability}; herdr is only available when its runtime is ready`
            )
        let daemon = ctx.daemon
        if (host.kind === 'hosted') {
            // The pane's shell gets a full-scope terminal token, as the
            // browser terminal's does, and the viewer is a terminal: the
            // machine's terminal opt-in covers both, and nothing is woken
            // for a machine that has not given it.
            if (!host.terminalEnabled)
                throw unavailable(
                    'the terminal is disabled for this sandbox; enable it first'
                )
            if (!ctx.daemonOnline) {
                const ensured = await this.hostAccess?.ensure({
                    host,
                    daemon,
                    placement,
                    agentId: agent.id,
                    wake: true
                })
                if (!ensured?.online || !ensured.daemon)
                    throw new ServiceUnavailableException({
                        code: HERDR_UNAVAILABLE_CODE,
                        message: `the sandbox runner is not ready (${ensured?.fallbackReason ?? 'unavailable'}); try again in a moment`
                    })
                daemon = ensured.daemon
            }
        } else if (!ctx.daemonOnline || !daemon)
            throw new ServiceUnavailableException({
                code: HERDR_UNAVAILABLE_CODE,
                message: 'the computer is offline; start its daemon first'
            })
        if (!daemon) throw unavailable('the computer is no longer registered')
        if (!daemon.herdrVersion)
            throw unavailable(
                host.kind === 'hosted'
                    ? 'herdr is not installed in this sandbox; install it from the Update Center'
                    : 'herdr is not available on this computer; install herdr and update the Manyfold CLI'
            )
        const features = daemon.clientFeatures ?? []
        if (
            !features.includes(DAEMON_FEATURE_HERDR_TERMINAL) ||
            !features.includes(DAEMON_FEATURE_PTY_COMMAND)
        )
            throw unavailable(
                host.kind === 'hosted'
                    ? 'the sandbox runner cannot reach herdr yet; upgrade its Manyfold CLI'
                    : 'herdr is not available on this computer; install herdr and update the Manyfold CLI'
            )
        return {
            agent,
            host,
            daemon,
            placement,
            sandbox: host.kind === 'hosted' ? host : null
        }
    }
}
