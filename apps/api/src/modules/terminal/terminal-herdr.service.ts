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
    type SessionHerdrOpenResponse
} from '@manyfold/shared'
import type { RuntimeHostRow } from '@manyfold/db'
import { AgentsService } from '@/modules/agents/agents.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAuthProfilesService } from '@/modules/agent-runtimes/auth/runtime-auth-profiles.service'
import {
    assertHostHonoursAuthContext,
    authContextRefFor,
    effectiveModelConfigSource
} from '@/modules/agents/model-config/runtime-auth-selection'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { SessionHeldByTerminalError } from '@/modules/chat/chat.service'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { DaemonRpcResponseError } from '@/modules/daemon/daemon-registry.service'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
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
    'codex'
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

// Hand a chat session to herdr on the agent's own machine (ADR-0031). The
// gates are the browser terminal's, minus the browser: the agent runs on a
// self-owned daemon that is online and advertises herdr, the session has a
// CLI ref and no running turn, the hold is taken as the last fallible step
// before anything starts, and a launch herdr refuses gives the hold back.
@Injectable()
export class TerminalHerdrService {
    private readonly log = new Logger(TerminalHerdrService.name)

    constructor(
        private readonly agents: AgentsService,
        private readonly daemonHosts: DaemonHostService,
        private readonly chatRepo: ChatRepository,
        private readonly resume: TerminalResumeService,
        private readonly terminals: TerminalSessionsRepository,
        private readonly holder: TerminalHolderService,
        private readonly daemon: DaemonTerminal,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, a sprites agent cannot be handed off.
        @Optional()
        private readonly runtimeAuth?: RuntimeAuthProfilesService,
        @Optional()
        private readonly runtimes?: AgentRuntimesService
    ) {}

    async open(
        userId: string,
        agentId: string,
        sessionId: string,
        body: SessionHerdrOpenRequest
    ): Promise<SessionHerdrOpenResponse> {
        const { agent, host, sandbox } = await this.herdrHost(userId, agentId)
        const session = await this.chatRepo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        if (!isHerdrFramework(agent.framework))
            throw unavailable(
                'herdr can only resume Claude Code and Codex conversations'
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
        const authContext = authContextRefFor(agent)
        if (authContext)
            assertHostHonoursAuthContext(
                authContext,
                host,
                agent.runtime === 'sprites' ? 'this sandbox' : 'this machine'
            )

        const runtimeLocalAgent =
            effectiveModelConfigSource(agent) === 'runtime-local'
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
                agent.runtime === 'daemon' ||
                runtimeLocalAgent ||
                sandbox?.terminalModelCredentials === true,
            injectModelCredentials:
                agent.runtime === 'sprites' && !runtimeLocalAgent
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

        // The row first, addressed by its own id so any instance can close
        // the pane through the daemon; then the hold, the last step that may
        // fail before anything runs (ADR-0029 §1).
        const row = await this.terminals.create({
            userId,
            agentId,
            runtime: agent.runtime === 'sprites' ? 'sprites' : 'daemon',
            hostId: agent.hostId ?? null,
            runtimeId: agent.runtimeId ?? null,
            client: 'herdr',
            daemonId: host.id
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
                agent: agent as Agent,
                terminalId: row.id,
                framework: agent.framework,
                resume: resolution.resume,
                title,
                chatSessionId: sessionId,
                daemonId: host.id,
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
        const { agent } = await this.herdrHost(userId, agentId)
        const session = await this.chatRepo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        if (!session.holderTerminalId || session.holderClient !== 'herdr')
            throw unavailable('this conversation is not open in herdr')
        const row = await this.terminals.findById(session.holderTerminalId)
        if (!row || row.endedAt || row.agentId !== agentId)
            throw unavailable('this conversation is not open in herdr')
        const daemonId = row.daemonId ?? agent.daemonId
        if (!daemonId)
            throw unavailable('this conversation is not open in herdr')
        try {
            const focused = await this.daemon.focusHerdr(daemonId, row.id)
            return { focused }
        } catch (err) {
            throw herdrLaunchError(err)
        }
    }

    // The agent, owned and running, and the daemon that can hand its sessions
    // to herdr: the agent's own on a self-owned computer, or the sandbox's
    // runner for a sprites agent (woken if asleep). Either must be online and
    // advertise herdr.
    private async herdrHost(
        userId: string,
        agentId: string
    ): Promise<{
        agent: Agent
        host: RuntimeHostRow
        sandbox: RuntimeHostRow | null
    }> {
        const rows = await this.agents.listForUser(userId)
        const agent = rows.find((r) => r.agent.id === agentId)?.agent
        if (!agent) throw new NotFoundException('agent not found for this user')
        if (agent.status !== 'running')
            throw unavailable(
                `agent is ${agent.status}; herdr is only available when running`
            )
        let host: RuntimeHostRow | null = null
        let sandbox: RuntimeHostRow | null = null
        if (agent.runtime === 'daemon' && agent.daemonId) {
            host = await this.daemonHosts.findById(agent.daemonId)
            if (!host) throw unavailable('the computer is no longer registered')
            if (!this.daemonHosts.isOnline(host))
                throw new ServiceUnavailableException({
                    code: HERDR_UNAVAILABLE_CODE,
                    message: 'the computer is offline; start its daemon first'
                })
        } else if (agent.runtime === 'sprites' && agent.runtimeId) {
            if (!this.runtimeAuth || !this.runtimes)
                throw unavailable('herdr is not available for sandboxes here')
            sandbox = agent.hostId
                ? await this.runtimes.findHostById(agent.hostId)
                : null
            if (!sandbox?.herdrVersion)
                throw unavailable(
                    'herdr is not installed in this sandbox; install it from the Update Center'
                )
            // The pane's shell gets a full-scope terminal token, as the
            // browser terminal's does, and the viewer is a terminal: the
            // sandbox's terminal opt-in covers both, and nothing is woken
            // for a sandbox that has not given it.
            if (!sandbox.terminalEnabled)
                throw unavailable(
                    'the terminal is disabled for this sandbox; enable it first'
                )
            const resolved = await this.runtimeAuth.resolveRuntimeHost(
                userId,
                agent.runtimeId,
                { wake: true }
            )
            if (!resolved.host || resolved.availability !== 'ok')
                throw new ServiceUnavailableException({
                    code: HERDR_UNAVAILABLE_CODE,
                    message: `the sandbox runner is not ready (${resolved.availability}); try again in a moment`
                })
            host = resolved.host
        } else {
            throw unavailable(
                'this agent does not run on a self-owned computer or a sandbox'
            )
        }
        const features = host.clientFeatures ?? []
        if (
            !features.includes(DAEMON_FEATURE_HERDR_TERMINAL) ||
            !features.includes(DAEMON_FEATURE_PTY_COMMAND)
        )
            throw unavailable(
                agent.runtime === 'sprites'
                    ? 'the sandbox runner cannot reach herdr yet; upgrade its Manyfold CLI'
                    : 'herdr is not available on this computer; install herdr and update the Manyfold CLI'
            )
        return { agent: agent as Agent, host, sandbox }
    }
}
