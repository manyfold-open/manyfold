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

import type { ResolvedTerminalResume } from '@/modules/terminal/terminal-resume.service'

export interface DaemonTerminalRequest {
    agent: Agent
    cols: number
    cwd?: string
    rows: number
    resume?: ResolvedTerminalResume | null
    client: WsClient
    onClose: () => void
}

// Same posture as the sprites terminal: the session acts as the USER, so it
// carries a short-lived api.full token injected per session, hard-deleted on
// close, with the TTL bounding exposure if the delete is lost.
const TERMINAL_TOKEN_TTL_SECONDS = 12 * 60 * 60

@Injectable()
export class DaemonTerminal {
    private readonly log = new Logger(DaemonTerminal.name)

    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly connections: ConnectionsService,
        private readonly apiTokens: ApiTokenService
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
        const dropTerminalToken = (): void => {
            void this.apiTokens
                .hardDelete({
                    tokenId: terminalToken.tokenId,
                    userId: agent.userId
                })
                .catch(() => {})
        }
        let closed = false
        let stream: ReturnType<DaemonRegistryService['streamRpc']>
        try {
            stream = this.registry.streamRpc({
                daemonId,
                method: 'pty.open',
                payload: {
                    cwd: cwd ?? agent.workspacePath ?? agent.mountPath,
                    cols,
                    rows,
                    // Only sent to daemons declaring DAEMON_FEATURE_PTY_COMMAND
                    // (checked by the gateway) — an older one would drop it and
                    // open a plain shell under a UI that promised a resume.
                    ...(resume?.command.length
                        ? { command: resume.command }
                        : {}),
                    env: {
                        ...envTextToRecord(envTextFromExtras(agent.extras)),
                        ...connectionEnv,
                        ...(resume?.env ?? {}),
                        MF_AGENT_ID: agent.id,
                        MF_API_TOKEN: terminalToken.plaintext,
                        TERM: 'xterm-256color',
                        LANG: 'C.UTF-8',
                        COLORTERM: 'truecolor'
                    }
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
            dropTerminalToken()
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
            dropTerminalToken()
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
                    dropTerminalToken()
                    onClose()
                }
            })
    }
}
