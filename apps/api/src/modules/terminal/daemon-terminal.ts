import type {
    DaemonAuthContextRef, DaemonPtyAuthLogin } from '@manyfold/shared'
import {
    envTextFromExtras,
    envTextToRecord
} from '@manyfold/shared'
import {
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
        req.onToken?.(terminalToken.tokenId)
        const dropTerminalToken = (): void => {
            void this.apiTokens
                .hardDelete({
                    tokenId: terminalToken.tokenId,
                    userId: agent.userId
                })
                .catch(() => {})
        }
        const authContext = authContextRefFor(agent)
        await this.openPty({
            daemonId,
            cwd: cwd ?? agent.workspacePath ?? agent.mountPath,
            env: {
                ...envTextToRecord(envTextFromExtras(agent.extras)),
                ...connectionEnv,
                // Resume credentials sit under the platform's own vars: a
                // session must not be able to rebind MF_API_TOKEN or TERM.
                ...(resume?.env ?? {}),
                ...terminalIdentityEnv({
                    config: this.config,
                    agentId: agent.id,
                    terminalId: req.terminalId,
                    tokenPlaintext: terminalToken.plaintext
                }),
                ...TERMINAL_BASE_ENV
            },
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
            release: dropTerminalToken
        })
    }

    // Close a pty this instance may not own the stream of (a takeover, the
    // user's release from the chat view, the lease reaper): the broker
    // rewrites the refId for a daemon connected to a peer instance, and the
    // daemon's ack proves the process is gone.
    async closePty(daemonId: string, refId: string): Promise<void> {
        await this.registry.rpc({
            daemonId,
            method: 'pty.close',
            payload: { refId },
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
                    env
                },
                timeoutMs: 24 * 3600 * 1000,
                onEvent: (kind, data) => {
                    if (kind !== 'pty.out') return
                    if (closed) return
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
        onHandle?.(stream.refId)

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
        // case keeps the terminal's hold for the lease to decide.
        let endCause: TerminalCloseCause = 'exit'
        stream.result
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
                    try {
                        client.close(1000, 'pty closed')
                    } catch {}
                    release()
                    onClose(endCause)
                }
            })
    }
}
