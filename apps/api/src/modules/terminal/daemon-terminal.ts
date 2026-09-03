import {
    envTextFromExtras,
    envTextToRecord
} from '@manyfold/shared'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { WebSocket as WsClient } from 'ws'
import type { Agent } from '@manyfold/db'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { ConnectionsService } from '@/modules/connections/connections.service'
import {
    ApiTokenService,
    API_TOKEN_SCOPE_FULL
} from '@/modules/auth/api-token.service'

export interface DaemonTerminalRequest {
    agent: Agent
    cols: number
    cwd?: string
    rows: number
    client: WsClient
    onClose: () => void
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

@Injectable()
export class DaemonTerminal {
    private readonly log = new Logger(DaemonTerminal.name)

    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly connections: ConnectionsService,
        private readonly apiTokens: ApiTokenService
    ) {}

    async tunnel(req: DaemonTerminalRequest): Promise<void> {
        const { agent, cols, cwd, rows, client, onClose } = req
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
        const dropTerminalToken = (): void => {
            void this.apiTokens
                .hardDelete({
                    tokenId: terminalToken.tokenId,
                    userId: agent.userId
                })
                .catch(() => {})
        }
        await this.openPty({
            daemonId,
            cwd: cwd ?? agent.workspacePath ?? agent.mountPath,
            env: {
                ...envTextToRecord(envTextFromExtras(agent.extras)),
                ...connectionEnv,
                MF_AGENT_ID: agent.id,
                MF_API_TOKEN: terminalToken.plaintext,
                ...TERMINAL_BASE_ENV
            },
            cols,
            rows,
            client,
            onClose,
            release: dropTerminalToken
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

    private async openPty(args: {
        daemonId: string
        cwd: string | undefined
        env: Record<string, string>
        cols: number
        rows: number
        client: WsClient
        onClose: () => void
        release: () => void
    }): Promise<void> {
        const { daemonId, cwd, env, cols, rows, client, onClose, release } =
            args
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
            onClose()
            return
        }

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

        const cleanup = (): void => {
            if (closed) return
            closed = true
            stream.cancel()
            release()
            onClose()
        }
        client.on('close', cleanup)
        client.on('error', cleanup)

        stream.result
            .catch((err) => {
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
                    onClose()
                }
            })
    }
}
