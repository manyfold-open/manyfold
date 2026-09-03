import {
    envTextFromExtras,
    envTextToRecord
} from '@manyfold/shared'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { WebSocket as WsClient } from 'ws'
import { WebSocket as UpstreamWs } from 'ws'
import { createClient } from '@manyfold/sprites'
import {
    ApiTokenService,
    API_TOKEN_SCOPE_FULL
} from '@/modules/auth/api-token.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { SpriteStorageService } from '@/modules/agents/sprite-storage/sprite-storage.service'
import { SpritesSessionRegistry } from '@/modules/agents/sprite-sessions/sprite-sessions.registry'
import { SpriteStatusSyncService } from '@/modules/agents/sprite-status/sprite-status-sync.service'
import { ConnectionsService } from '@/modules/connections/connections.service'
import type { ResolvedTerminalResume } from '@/modules/terminal/terminal-resume.service'

export interface SpritesTerminalRequest {
    // Either an agent terminal or a bare-sandbox terminal. sessionKey is the
    // registry key (agent.id or host.id); agentId is set only for agent
    // terminals (it drives MF_AGENT_ID + close-time storage measurement).
    userId: string
    sessionKey: string
    accountId: string | null
    spriteName: string | null
    hostId: string | null
    mountPath: string
    extras: Record<string, unknown>
    agentId?: string
    cols: number
    cwd?: string
    rows: number
    // Set to open straight into a framework TUI instead of a bare login
    // shell. The argv is built server-side by TerminalResumeService.
    resume?: ResolvedTerminalResume | null
    client: WsClient
    onClose: () => void
}

// The interactive terminal runs as the USER, so it carries a short-lived
// api.full token injected per-session (never on the VM profile). TTL bounds
// exposure if the close-time delete or the process is lost.
const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

/* A login shell, or the resume argv followed by one. `exec bash -il` rather
   than letting the shell end: quitting the TUI then drops the user into the
   interactive shell they would otherwise have had, instead of closing the
   websocket out from under them. Running the command AS the shell's argv is
   what keeps this race-free — there is no "is the prompt ready yet" guess,
   which is the only reliable way to inject a command into a fresh pty. */
export const terminalShellCommand = (
    resume?: { command: string[] } | null
): string[] => {
    if (!resume?.command.length) return ['bash', '-il']
    const quoted = resume.command.map(shellQuote).join(' ')
    return ['bash', '-ilc', `${quoted}; exec bash -il`]
}

const TERMINAL_TOKEN_TTL_SECONDS = 12 * 60 * 60
const TERMINAL_HANDSHAKE_RETRY_DELAYS_MS = [250, 750] as const

export const terminalHandshakeRetryDelayMs = (
    status: number,
    attempt: number
): number | null => {
    if (status !== 502 && status !== 503 && status !== 504) return null
    return TERMINAL_HANDSHAKE_RETRY_DELAYS_MS[attempt - 1] ?? null
}

@Injectable()
export class SpritesTerminal {
    private readonly log = new Logger(SpritesTerminal.name)

    constructor(
        private readonly accounts: SpritesAccountsService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly spriteStorage: SpriteStorageService,
        private readonly sessionRegistry: SpritesSessionRegistry,
        private readonly apiTokens: ApiTokenService,
        private readonly spriteStatusSync: SpriteStatusSyncService,
        private readonly connections: ConnectionsService
    ) {}

    async tunnel(req: SpritesTerminalRequest): Promise<void> {
        const {
            userId,
            sessionKey,
            accountId,
            spriteName,
            hostId,
            mountPath,
            extras,
            agentId,
            cols,
            cwd,
            rows,
            resume,
            client,
            onClose
        } = req
        if (!accountId || !spriteName || !hostId)
            throw new NotFoundException(
                'sprites terminal target missing accountId, spriteName or hostId'
            )
        await this.runtimeAccess.reserveActiveSlot({ userId, hostId })

        const account = await this.accounts.getById(accountId)
        if (!account)
            throw new NotFoundException(
                `sprites account ${accountId} not found`
            )
        const token = this.accounts.decryptToken(account)
        const spritesClient = createClient({ token })

        // The interactive terminal acts as the USER, not the agent: mint a
        // short-lived api.full token and inject it per-session only (never on the
        // shared VM profile, which co-resident agents would read). Hard-deleted
        // on close (kind 'terminal' so it never pollutes the PAT list and the
        // reaper can sweep any tail); TTL bounds exposure if the delete is lost.
        const terminalToken = await this.apiTokens.mint({
            userId,
            name: `terminal ${spriteName}`,
            scopes: [API_TOKEN_SCOPE_FULL],
            expiresInSeconds: TERMINAL_TOKEN_TTL_SECONDS,
            tokenKind: 'terminal'
        })
        const connectionEnv = await this.connections.resolveAgentEnv({
            userId,
            extras
        })
        const url = buildSpritesTerminalExecUrl(
            spritesClient.wsBaseUrl,
            spriteName,
            {
                cmd: terminalShellCommand(resume),
                dir: cwd ?? mountPath,
                cols,
                rows,
                env: {
                    ...envTextToRecord(envTextFromExtras(extras)),
                    ...connectionEnv,
                    ...(agentId ? { MF_AGENT_ID: agentId } : {}),
                    ...(resume?.env ?? {}),
                    MF_API_TOKEN: terminalToken.plaintext,
                    TERM: 'xterm-256color',
                    LANG: 'C.UTF-8',
                    COLORTERM: 'truecolor'
                }
            }
        )
        const headers = spritesClient.authHeaderForInternalUse()

        const pendingBinary: Buffer[] = []
        const pendingText: string[] = []

        let unregister: (() => void) | null = null
        let upstream: UpstreamWs | null = null
        let retryTimer: NodeJS.Timeout | null = null
        let handshakeAttempt = 0
        let cleaned = false

        const cleanup = (code = 1000, reason = ''): void => {
            if (cleaned) return
            cleaned = true
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = null
            try {
                unregister?.()
            } catch {}
            unregister = null
            const activeUpstream = upstream
            upstream = null
            try {
                if (activeUpstream?.readyState === UpstreamWs.OPEN)
                    activeUpstream.close(code, reason)
                else if (activeUpstream?.readyState === UpstreamWs.CONNECTING)
                    activeUpstream.terminate()
            } catch {}
            try {
                if (client.readyState === client.OPEN)
                    client.close(code, reason)
            } catch {}
            if (agentId) void this.spriteStorage.measureIfDue(agentId)
            void this.apiTokens
                .hardDelete({ tokenId: terminalToken.tokenId, userId })
                .catch(() => {})
            onClose()
        }

        unregister = this.sessionRegistry.register(sessionKey, {
            kind: 'terminal',
            close: (reason) => cleanup(4001, reason)
        })

        const connectUpstream = (): void => {
            if (cleaned) return
            handshakeAttempt += 1
            const candidate = new UpstreamWs(url, { headers })
            upstream = candidate
            let rejected = false

            candidate.on('unexpected-response', (request, response) => {
                rejected = true
                response.resume()
                try {
                    request.destroy()
                } catch {}
                if (candidate !== upstream || cleaned) return

                const status = response.statusCode ?? 0
                const delay = terminalHandshakeRetryDelayMs(
                    status,
                    handshakeAttempt
                )
                if (delay !== null && client.readyState === client.OPEN) {
                    this.log.warn(
                        `sprites.terminal.handshake_retry sprite=${spriteName} status=${status} attempt=${handshakeAttempt}`
                    )
                    upstream = null
                    retryTimer = setTimeout(() => {
                        retryTimer = null
                        connectUpstream()
                    }, delay)
                    return
                }

                const message = `sprites terminal handshake failed: HTTP ${status || 'unknown'}`
                this.log.warn(
                    `sprites.terminal.handshake_failed sprite=${spriteName} status=${status} attempts=${handshakeAttempt}`
                )
                try {
                    client.send(JSON.stringify({ type: 'error', message }))
                } catch {}
                cleanup(1011, 'upstream handshake failed')
            })

            candidate.on('open', () => {
                if (candidate !== upstream || cleaned) {
                    try {
                        candidate.close(1000, 'terminal closed')
                    } catch {}
                    return
                }
                this.log.debug(`sprites.terminal.open sprite=${spriteName}`)
                // The VM is now executing: flip status onto the fast cadence so the
                // running→warm release is reconciled within ~3s, not up to ~30s.
                // Agent terminals publish `running`; bare-sandbox terminals only poke
                // (reserveActiveSlot already wrote the host `running`).
                if (agentId)
                    void this.spriteStatusSync.markSpriteRunning(agentId)
                else this.spriteStatusSync.pokeAccount(accountId)
                try {
                    candidate.send(
                        JSON.stringify({ type: 'resize', cols, rows })
                    )
                } catch {}
                for (const buf of pendingBinary) {
                    try {
                        candidate.send(buf, { binary: true })
                    } catch {}
                }
                pendingBinary.length = 0
                for (const text of pendingText) {
                    try {
                        candidate.send(text)
                    } catch {}
                }
                pendingText.length = 0
            })

            candidate.on('message', (data, isBinary) => {
                if (candidate !== upstream || cleaned) return
                if (!isBinary) {
                    const text = data.toString()
                    try {
                        client.send(text)
                    } catch {}
                    try {
                        const msg = JSON.parse(text) as {
                            type?: string
                            exit_code?: number
                        }
                        if (msg.type === 'exit') cleanup(1000, 'exit')
                    } catch {}
                    return
                }
                const buf = toBuffer(data)
                if (buf.length === 0) return
                try {
                    client.send(buf, { binary: true })
                } catch {}
            })

            candidate.on('error', (err) => {
                if (rejected || candidate !== upstream || cleaned) return
                this.log.warn(`sprites.terminal.error ${err.message}`)
                try {
                    client.send(
                        JSON.stringify({ type: 'error', message: err.message })
                    )
                } catch {}
                cleanup(1011, 'upstream error')
            })

            candidate.on('close', (code, reason) => {
                if (rejected || candidate !== upstream || cleaned) return
                this.log.debug(
                    `sprites.terminal.close sprite=${spriteName} code=${code} reason=${reason.toString()}`
                )
                cleanup(1000, 'upstream closed')
            })
        }

        client.on('message', (data, isBinary) => {
            const activeUpstream = upstream
            if (isBinary) {
                const buf = toBuffer(data)
                if (buf.length === 0) return
                const payload = buf[0] === 0x00 ? buf.subarray(1) : buf
                if (payload.length === 0) return
                if (activeUpstream?.readyState !== UpstreamWs.OPEN) {
                    pendingBinary.push(payload)
                    return
                }
                try {
                    activeUpstream.send(payload, { binary: true })
                } catch {}
            } else {
                const text = data.toString()
                if (activeUpstream?.readyState !== UpstreamWs.OPEN) {
                    pendingText.push(text)
                    return
                }
                try {
                    activeUpstream.send(text)
                } catch {}
            }
        })

        client.on('close', () => cleanup(1000, 'client closed'))
        client.on('error', () => cleanup(1011, 'client error'))

        connectUpstream()
    }
}

export interface SpritesTerminalExecUrlOpts {
    cmd: string[]
    dir: string
    cols: number
    rows: number
    env?: Record<string, string>
}

const toBuffer = (data: Buffer | ArrayBuffer | Buffer[] | string): Buffer => {
    if (Buffer.isBuffer(data)) return data
    if (Array.isArray(data)) return Buffer.concat(data)
    if (typeof data === 'string') return Buffer.from(data, 'utf8')
    return Buffer.from(data as ArrayBuffer)
}

export const buildSpritesTerminalExecUrl = (
    wsBaseUrl: string,
    spriteName: string,
    opts: SpritesTerminalExecUrlOpts
): string => {
    const params = new URLSearchParams()
    params.append('path', opts.cmd[0])
    for (const arg of opts.cmd) params.append('cmd', arg)
    params.append('dir', opts.dir)
    params.append('stdin', 'true')
    params.append('tty', 'true')
    params.append('rows', String(opts.rows))
    params.append('cols', String(opts.cols))
    for (const [k, v] of Object.entries(opts.env ?? {}))
        params.append('env', `${k}=${v}`)
    return `${wsBaseUrl}/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`
}
