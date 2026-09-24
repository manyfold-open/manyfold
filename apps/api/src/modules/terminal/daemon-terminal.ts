import type {
    DaemonAuthContextRef,
    DaemonHerdrFramework,
    DaemonHerdrOpenPayload,
    DaemonHerdrOpenResult,
    DaemonPtyAuthLogin
} from '@manyfold/shared'
import {
    HERDR_LAUNCH_FAILED_CODE,
    envTextFromExtras,
    envTextToRecord,
    isObjectId
} from '@manyfold/shared'
import {
    BadGatewayException,
    Injectable,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { WebSocket as WsClient } from 'ws'
import type { Agent } from '@manyfold/db'
import { authContextRefFor } from '@/modules/agents/model-config/runtime-auth-selection'
import {
    DaemonRegistryService,
    DaemonRpcResponseError
} from '@/modules/daemon/daemon-registry.service'
import { ConnectionsService } from '@/modules/connections/connections.service'
import {
    ApiTokenService,
    API_TOKEN_SCOPE_FULL
} from '@/modules/auth/api-token.service'

import { piPlatformViewPrepare } from '@/modules/agents/credentials/pi-agent-dir'
import type { ResolvedTerminalResume } from '@/modules/terminal/terminal-resume.service'
import type { TerminalCloseCause } from '@/modules/terminal/terminal-holder.service'
import { terminalIdentityEnv } from '@/modules/terminal/terminal-env'

export interface DaemonTerminalRequest {
    agent: Agent
    // The terminal's durable identity (ADR-0029 §1), injected as
    // MF_TERMINAL_ID so the CLI session hooks report from this shell.
    terminalId?: string | null
    cols: number
    cwd?: string
    rows: number
    resume?: ResolvedTerminalResume | null
    client: WsClient
    onClose: (cause: TerminalCloseCause) => void
    // The terminal's durable identity learns its token and its process
    // handle (the pty stream refId) from here, so any API instance can later
    // close the pty through the daemon (ADR-0029 §1).
    onToken?: (tokenId: string) => void
    onHandle?: (refId: string) => void
    // A terminal the daemon owns (ADR-0029 §6): the pty is opened under this
    // id and the stream is one attachment to it. The daemon attaches to the
    // terminal if it still has it (the shell keeps the token it was spawned
    // with, `boundTokenId`) or spawns one under the id, and says which in
    // its first event; the browser's close then detaches instead of
    // killing, and the terminal's hold stays with its row.
    ownedTerminalId?: string | null
    boundTokenId?: string | null
}

// A shell on the machine itself, addressed by host instead of agent. It gets
// no agent env and no user API token: its one job is running a coding CLI's
// own sign-in from the runtime page, which needs neither, so the shell holds
// nothing worth leaking. cwd is left to the daemon (its home directory).
export interface DaemonHostTerminalRequest {
    daemonId: string
    cols: number
    rows: number
    client: WsClient
    onClose: () => void
}

// Same posture as the sprites terminal: the session acts as the USER, so it
// carries a short-lived api.full token injected per session, hard-deleted on
// close, with the TTL bounding exposure if the delete is lost.
const TERMINAL_TOKEN_TTL_SECONDS = 12 * 60 * 60

const TERMINAL_BASE_ENV = {
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    COLORTERM: 'truecolor'
}

const PTY_CLOSE_TIMEOUT_MS = 5_000
// herdr creates the tab, waits for its shell, starts the agent (up to a
// minute for a cold CLI) and labels it before the daemon answers.
const HERDR_OPEN_TIMEOUT_MS = 90_000
const HERDR_FOCUS_TIMEOUT_MS = 10_000
// Links, two small files and a lock: milliseconds, on a machine that answers.
const PI_VIEW_PREPARE_TIMEOUT_MS = 15_000

// Hand a chat session to herdr on the agent's machine (ADR-0031): the same
// env a pty would carry, one unary call instead of a stream.
export interface DaemonHerdrOpenRequest {
    agent: Agent
    terminalId: string
    framework: DaemonHerdrFramework
    resume: ResolvedTerminalResume
    title: string
    // The chat session the TUI resumes; the daemon keeps one herdr tab per
    // conversation with it.
    chatSessionId?: string
    cwd?: string
    // The agent's own daemon when absent; a sandbox's runner daemon for a
    // sprites agent (ADR-0031).
    daemonId?: string
    onToken?: (tokenId: string) => void
}

@Injectable()
export class DaemonTerminal {
    private readonly log = new Logger(DaemonTerminal.name)

    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly connections: ConnectionsService,
        private readonly apiTokens: ApiTokenService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, the identity env carries no API URL.
        @Optional() private readonly config?: ConfigService
    ) {}

    async tunnel(req: DaemonTerminalRequest): Promise<void> {
        const { agent, cols, cwd, rows, resume, client, onClose } = req
        if (!agent.daemonId)
            throw new NotFoundException('daemon agent missing daemonId')
        const daemonId = agent.daemonId
        // Same per-session env a sprites terminal gets (#781): the agent's env
        // text plus its connection tokens, resolved fresh so nothing lands on
        // the machine's own profile.
        const connectionEnv = await this.connections.resolveAgentEnv({
            userId: agent.userId,
            extras: agent.extras
        })
        const terminalToken = await this.apiTokens.mint({
            userId: agent.userId,
            name: `terminal ${daemonId}`,
            scopes: [API_TOKEN_SCOPE_FULL],
            expiresInSeconds: TERMINAL_TOKEN_TTL_SECONDS,
            tokenKind: 'terminal'
        })
        const dropToken = (tokenId: string): void => {
            void this.apiTokens
                .hardDelete({ tokenId, userId: agent.userId })
                .catch(() => {})
        }
        // Which token the shell actually carries is only known once the
        // daemon says whether it attached or spawned: an attached shell
        // keeps the one it was spawned with, and the fresh one is dropped
        // unused; a spawned shell carries the fresh one, which then binds to
        // the row in place of any earlier one.
        const ownedTerminalId = req.ownedTerminalId ?? null
        let tokenInUse = terminalToken.tokenId
        if (!ownedTerminalId) req.onToken?.(terminalToken.tokenId)
        const onAttach = (mode: 'attached' | 'spawned'): void => {
            if (mode === 'spawned') {
                req.onToken?.(terminalToken.tokenId)
                if (req.boundTokenId && req.boundTokenId !== terminalToken.tokenId)
                    dropToken(req.boundTokenId)
                return
            }
            dropToken(terminalToken.tokenId)
            if (req.boundTokenId) tokenInUse = req.boundTokenId
        }
        const dropTerminalToken = (): void => dropToken(tokenInUse)
        const authContext = authContextRefFor(agent)
        await this.openPty({
            daemonId,
            cwd: cwd ?? agent.workspacePath ?? agent.mountPath,
            env: this.agentTerminalEnv(
                agent,
                connectionEnv,
                resume ?? null,
                req.terminalId ?? null,
                terminalToken.plaintext
            ),
            ...(resume?.command.length ? { command: resume.command } : {}),
            // A profile-bound agent's shell runs inside that profile's
            // context (the daemon composes it and holds the lock while the
            // shell is open), so `claude`/`codex` typed there answer as the
            // agent's account, not the machine's.
            ...(authContext
                ? { authSelection: { mode: 'profile' as const, ...authContext } }
                : {}),
            cols,
            rows,
            client,
            onClose,
            onHandle: req.onHandle,
            ...(ownedTerminalId
                ? { terminalId: ownedTerminalId, onAttach }
                : {}),
            release: dropTerminalToken
        })
    }

    // The env every Manyfold-opened terminal on a daemon gets, browser pty
    // and herdr pane alike: the agent's env text, its connection tokens, the
    // resume's own variables, then the platform block on top. Resume
    // credentials sit under the platform's own vars, so a session can never
    // rebind MF_API_TOKEN or TERM.
    private agentTerminalEnv(
        agent: Agent,
        connectionEnv: Record<string, string>,
        resume: ResolvedTerminalResume | null,
        terminalId: string | null,
        tokenPlaintext: string
    ): Record<string, string> {
        return {
            ...envTextToRecord(envTextFromExtras(agent.extras)),
            ...connectionEnv,
            ...(resume?.env ?? {}),
            ...terminalIdentityEnv({
                config: this.config,
                agentId: agent.id,
                terminalId,
                tokenPlaintext
            }),
            ...TERMINAL_BASE_ENV
        }
    }

    // Open the session's TUI in a herdr pane on the agent's machine
    // (ADR-0031). The terminal token is minted here like a pty's and bound
    // to the row through onToken; a launch the daemon refuses drops it
    // again, and the caller ends the row.
    async openInHerdr(req: DaemonHerdrOpenRequest): Promise<DaemonHerdrOpenResult> {
        const { agent } = req
        const daemonId = req.daemonId ?? agent.daemonId
        if (!daemonId)
            throw new NotFoundException('agent has no daemon to open herdr on')
        const connectionEnv = await this.connections.resolveAgentEnv({
            userId: agent.userId,
            extras: agent.extras
        })
        const terminalToken = await this.apiTokens.mint({
            userId: agent.userId,
            name: `terminal ${daemonId}`,
            scopes: [API_TOKEN_SCOPE_FULL],
            expiresInSeconds: TERMINAL_TOKEN_TTL_SECONDS,
            tokenKind: 'terminal'
        })
        req.onToken?.(terminalToken.tokenId)
        const authContext = authContextRefFor(agent)
        const cwd = req.cwd ?? agent.workspacePath ?? agent.mountPath
        const payload: DaemonHerdrOpenPayload = {
            terminalId: req.terminalId,
            framework: req.framework,
            command: req.resume.command,
            ...(cwd ? { cwd } : {}),
            env: this.agentTerminalEnv(
                agent,
                connectionEnv,
                req.resume,
                req.terminalId,
                terminalToken.plaintext
            ),
            title: req.title,
            agentName: agent.name,
            ...(req.chatSessionId ? { chatSessionId: req.chatSessionId } : {}),
            ...(authContext
                ? { authSelection: { mode: 'profile' as const, ...authContext } }
                : {})
        }
        try {
            const result = await this.registry.rpc({
                daemonId,
                method: 'terminal.herdr.open',
                payload: payload as unknown as Record<string, unknown>,
                timeoutMs: HERDR_OPEN_TIMEOUT_MS
            })
            return herdrOpenResultOf(result)
        } catch (err) {
            void this.apiTokens
                .hardDelete({
                    tokenId: terminalToken.tokenId,
                    userId: agent.userId
                })
                .catch(() => {})
            throw err
        }
    }

    // Build a pi platform view on the daemon (piPlatformViewPrepare) and
    // return its path: herdr's pi is started on it rather than through it.
    async preparePiView(
        daemonId: string,
        resumeEnv: Record<string, string>
    ): Promise<string> {
        const prepare = piPlatformViewPrepare(resumeEnv)
        let stdout = ''
        let stderr = ''
        const stream = this.registry.streamRpc({
            daemonId,
            method: 'exec.start',
            payload: {
                cmd: prepare.cmd,
                env: prepare.env,
                timeoutMs: PI_VIEW_PREPARE_TIMEOUT_MS
            },
            timeoutMs: PI_VIEW_PREPARE_TIMEOUT_MS + 5_000,
            onEvent: (kind, data) => {
                if (kind === 'stdout') stdout += data
                else if (kind === 'stderr') stderr += data
            }
        })
        const result = await stream.result
        const exitCode = Number(
            (result as { exitCode?: number } | undefined)?.exitCode ?? 0
        )
        const viewPath = stdout.trim().split('\n').pop()?.trim() ?? ''
        if (exitCode !== 0 || !viewPath.startsWith('/'))
            throw new BadGatewayException({
                code: HERDR_LAUNCH_FAILED_CODE,
                message: `pi's platform view could not be built (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`
            })
        return viewPath
    }

    // Raise the session's pane in herdr again (ADR-0031).
    async focusHerdr(daemonId: string, terminalId: string): Promise<boolean> {
        const result = await this.registry.rpc({
            daemonId,
            method: 'terminal.herdr.focus',
            payload: { terminalId },
            timeoutMs: HERDR_FOCUS_TIMEOUT_MS
        })
        return result?.focused === true
    }

    // Close a pty this instance may not own the stream of (a takeover, the
    // user's release from the chat view, the lease reaper): the broker
    // rewrites the refId for a daemon connected to a peer instance, and the
    // daemon's ack proves the process is gone.
    async closePty(daemonId: string, handle: string): Promise<void> {
        await this.registry.rpc({
            daemonId,
            method: 'pty.close',
            // An owned terminal is addressed by its own id (ADR-0029 §6), a
            // stream-bound pty by the stream's refId.
            payload: isObjectId(handle, 'terminalSession')
                ? { terminalId: handle }
                : { refId: handle },
            timeoutMs: PTY_CLOSE_TIMEOUT_MS
        })
    }

    async tunnelHost(req: DaemonHostTerminalRequest): Promise<void> {
        await this.openPty({
            daemonId: req.daemonId,
            cwd: undefined,
            env: { ...TERMINAL_BASE_ENV },
            cols: req.cols,
            rows: req.rows,
            client: req.client,
            onClose: req.onClose,
            release: () => {}
        })
    }

    // A runtime auth profile sign-in: the daemon composes argv and the
    // credential-context env from the ids (DAEMON_FEATURE_AUTH_PROFILES), so
    // this sends no command, no cwd and only the terminal base env.
    async tunnelAuthLogin(
        req: DaemonHostTerminalRequest & { authLogin: DaemonPtyAuthLogin }
    ): Promise<void> {
        await this.openPty({
            daemonId: req.daemonId,
            cwd: undefined,
            env: { ...TERMINAL_BASE_ENV },
            authLogin: req.authLogin,
            cols: req.cols,
            rows: req.rows,
            client: req.client,
            onClose: req.onClose,
            release: () => {}
        })
    }

    private async openPty(args: {
        daemonId: string
        cwd: string | undefined
        env: Record<string, string>
        // Run the TUI resume as the shell's argv instead of a bare login shell.
        command?: string[]
        authLogin?: DaemonPtyAuthLogin
        authSelection?: { mode: 'profile' } & DaemonAuthContextRef
        cols: number
        rows: number
        client: WsClient
        onClose: (cause: TerminalCloseCause) => void
        onHandle?: (refId: string) => void
        terminalId?: string
        onAttach?: (mode: 'attached' | 'spawned') => void
        release: () => void
    }): Promise<void> {
        const {
            daemonId,
            cwd,
            env,
            command,
            authLogin,
            authSelection,
            cols,
            rows,
            client,
            onClose,
            onHandle,
            terminalId,
            onAttach,
            release
        } = args
        let closed = false
        let stream: ReturnType<DaemonRegistryService['streamRpc']>
        try {
            stream = this.registry.streamRpc({
                daemonId,
                method: 'pty.open',
                payload: {
                    ...(cwd ? { cwd } : {}),
                    cols,
                    rows,
                    // Only sent to daemons declaring DAEMON_FEATURE_PTY_COMMAND
                    // (checked by the gateway) — an older one would drop it and
                    // open a plain shell under a UI that promised a resume.
                    ...(command?.length ? { command } : {}),
                    ...(authLogin ? { authLogin } : {}),
                    ...(authSelection ? { authSelection } : {}),
                    ...(terminalId ? { terminalId } : {}),
                    env
                },
                timeoutMs: 24 * 3600 * 1000,
                onEvent: (kind, data) => {
                    if (closed) return
                    if (kind === 'pty.attach') {
                        // First on the stream, before any output: the tab
                        // resets its screen so the daemon's snapshot lands
                        // on a blank one.
                        const mode = attachModeOf(data)
                        if (!mode) return
                        onAttach?.(mode)
                        try {
                            client.send(
                                JSON.stringify({ type: 'attached', mode })
                            )
                        } catch {}
                        return
                    }
                    if (kind !== 'pty.out') return
                    try {
                        client.send(Buffer.from(data, 'base64'), {
                            binary: true
                        })
                    } catch {}
                }
            })
        } catch (err) {
            client.send(
                JSON.stringify({
                    type: 'error',
                    message: (err as Error).message
                })
            )
            try {
                client.close(4503, 'daemon unavailable')
            } catch {}
            release()
            onClose('tunnel-failed')
            return
        }
        // An owned terminal's handle is its id, set by the gateway up front.
        if (!terminalId) onHandle?.(stream.refId)

        client.on('message', (raw, isBinary) => {
            if (closed) return
            if (isBinary) {
                const buf = Buffer.isBuffer(raw)
                    ? raw
                    : Buffer.from(raw as ArrayBuffer)
                if (buf.length === 0) return
                const payload = buf[0] === 0x00 ? buf.subarray(1) : buf
                if (payload.length === 0) return
                this.registry
                    .rpc({
                        daemonId,
                        method: 'pty.input',
                        payload: {
                            refId: stream.refId,
                            data: payload.toString('base64')
                        },
                        timeoutMs: 5_000
                    })
                    .catch((err) =>
                        this.log.warn(
                            `pty.input failed for daemon ${daemonId}: ${(err as Error).message}`
                        )
                    )
                return
            }
            try {
                const msg = JSON.parse(raw.toString())
                if (msg.type === 'resize') {
                    this.registry
                        .rpc({
                            daemonId,
                            method: 'pty.resize',
                            payload: {
                                refId: stream.refId,
                                cols: msg.cols,
                                rows: msg.rows
                            },
                            timeoutMs: 5_000
                        })
                        .catch(() => {})
                }
            } catch {}
        })

        // The browser went away: close the pty and wait for the daemon's ack
        // before releasing anything this terminal holds, so a hold is only
        // ever released over a process known to be dead (ADR-0029 §1). A
        // daemon that cannot answer gets the fire-and-forget cancel instead
        // and the release goes ahead: it will not outlive its tunnel.
        const cleanup = (): void => {
            if (closed) return
            closed = true
            // The daemon keeps an owned terminal for the next attachment
            // (ADR-0029 §6): the cancel detaches, nothing is killed and the
            // shell keeps its token.
            if (terminalId) {
                stream.cancel()
                onClose('detached')
                return
            }
            void this.closePty(daemonId, stream.refId)
                .catch((err: Error) =>
                    this.log.warn(
                        `pty.close failed for daemon ${daemonId}: ${err.message}`
                    )
                )
                .finally(() => {
                    stream.cancel()
                    release()
                    onClose('client-closed')
                })
        }
        client.on('close', cleanup)
        client.on('error', cleanup)

        // How the pty ended on its own: the shell exited (its transcript is
        // settled), the daemon refused the open, or the daemon's connection
        // dropped under a pty that may well still be running — that last
        // case keeps the terminal's hold for the lease to decide. An owned
        // terminal's stream also ends when another attachment takes the
        // terminal over: the tab is told, and the terminal lives on.
        let endCause: TerminalCloseCause = 'exit'
        stream.result
            .then((payload) => {
                if (terminalId && payload?.detached === true)
                    endCause = 'detached'
            })
            .catch((err) => {
                endCause =
                    err instanceof DaemonRpcResponseError
                        ? 'tunnel-failed'
                        : 'daemon-lost'
                this.log.warn(
                    `pty.open ended for daemon ${daemonId}: ${(err as Error).message}`
                )
                try {
                    if (!closed && client.readyState === client.OPEN)
                        client.send(
                            JSON.stringify({
                                type: 'error',
                                message: (err as Error).message
                            })
                        )
                } catch {}
            })
            .finally(() => {
                if (!closed) {
                    closed = true
                    if (endCause === 'detached') {
                        try {
                            client.close(4409, 'terminal attached elsewhere')
                        } catch {}
                        onClose(endCause)
                        return
                    }
                    try {
                        client.close(1000, 'pty closed')
                    } catch {}
                    release()
                    onClose(endCause)
                }
            })
    }
}

const herdrOpenResultOf = (
    result: Record<string, unknown> | undefined
): DaemonHerdrOpenResult => {
    const text = (value: unknown): string =>
        typeof value === 'string' ? value : ''
    return {
        paneId: text(result?.paneId),
        tabId: text(result?.tabId),
        workspaceId: text(result?.workspaceId),
        focused: result?.focused === true
    }
}

const attachModeOf = (data: string): 'attached' | 'spawned' | null => {
    try {
        const mode = (JSON.parse(data) as { mode?: unknown }).mode
        return mode === 'attached' || mode === 'spawned' ? mode : null
    } catch {
        return null
    }
}
