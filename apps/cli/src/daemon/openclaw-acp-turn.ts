import { spawn, type ChildProcess } from 'node:child_process'
import type {
    DaemonOpenclawAcpTurnPayload,
    DaemonTurnFinalPayload,
    OpenclawTurnUsage
} from '@manyfold/shared'
import {
    decodeOpenclawTurnUsage,
    isFatalStderrLine,
    OPENCLAW_ACP_DIALECT,
    pickAutoApproveOptionId as pickAutoApproveOptionIdShared,
    pickRejectOptionId,
    pickStderrErrorLine
} from '@manyfold/shared'
import type { RpcContext } from './ws-client'
import { ExecStream, execStreams } from './exec-buffer'
import { permissionResponders, type TurnAck } from './acp-turn'

// The openclaw half of turn.start over ACP (ADR-0027). The daemon spawns
// `openclaw acp` against the HOST's own resident gateway — discovered, never
// started — and is the ACP client, exactly like the hermes runner. Three
// things differ from hermes and are all pinned by OPENCLAW_ACP_DIALECT:
// continuity is the gateway session KEY (`_meta.sessionKey` on every
// session/new; never session/resume), the bridge suppresses its cwd prefix
// (`_meta.prefixCwd:false`), and the approval/model levers are gateway-side
// session fields the daemon patches in-box BEFORE the bridge starts, not ACP
// options. The bridge is url-less: an explicit --url makes openclaw refuse the
// config credentials, so it resolves the gateway (port + token) from the box's
// own openclaw.json.
//
// stdout is published PER LINE, one event per JSON-RPC frame, so the API
// decodes the replayed stream immune to chunk boundaries — same contract as
// hermes.

const ACP_CMD = ['openclaw', 'acp', '--no-prefix-cwd']
const ACP_PROTOCOL_VERSION = 1
const DEFAULT_TURN_TIMEOUT_MS = 240_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000
const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000
const KILL_ESCALATION_MS = 5_000
const GATEWAY_CALL_TIMEOUT_MS = 20_000
const USAGE_WINDOW = 60
const USAGE_WINDOW_WIDE = 400

// openclaw always advertises its options array, so no legacy fallback id.
const pickAutoApproveOptionId = (
    params: Record<string, unknown> | undefined
): string => pickAutoApproveOptionIdShared(params, null) as string

interface PendingRequest {
    method: string
    resolve: (result: Record<string, unknown> | undefined) => void
    reject: (err: Error) => void
    touch: () => void
}

interface AcpTimeouts {
    idleTimeoutMs: number
    maxDurationMs: number
}

// One in-box `openclaw gateway call <method>` — url-less, so it authenticates
// from the same config the bridge uses. Resolves the parsed result object, or
// null on any failure (a usage read-back must never fail a turn).
const gatewayCall = (
    method: string,
    params: Record<string, unknown>,
    env: NodeJS.ProcessEnv
): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
        const child = spawn(
            'openclaw',
            [
                'gateway',
                'call',
                method,
                '--params',
                JSON.stringify(params),
                '--json',
                '--timeout',
                String(GATEWAY_CALL_TIMEOUT_MS)
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let out = ''
        let settled = false
        const finish = (value: Record<string, unknown> | null): void => {
            if (settled) return
            settled = true
            resolve(value)
        }
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL')
            } catch {}
            finish(null)
        }, GATEWAY_CALL_TIMEOUT_MS + 2_000)
        timer.unref?.()
        child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
        child.on('error', () => finish(null))
        child.on('close', (code) => {
            clearTimeout(timer)
            if (code !== 0) return finish(null)
            const start = out.indexOf('{')
            const end = out.lastIndexOf('}')
            if (start === -1 || end <= start) return finish(null)
            try {
                finish(JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>)
            } catch {
                finish(null)
            }
        })
    })

export const runOpenclawAcpTurn = (args: {
    payload: DaemonOpenclawAcpTurnPayload
    cwd: string
    ctx: RpcContext
    registerChild: (child: ChildProcess, stream: ExecStream) => void
    releaseChild: () => void
}): Promise<TurnAck> => {
    const { payload, ctx, cwd } = args
    const env = { ...process.env }
    const stream = new ExecStream({
        refId: ctx.refId,
        method: 'turn.start',
        payload: {
            framework: 'openclaw',
            transport: 'acp',
            cmd: ACP_CMD,
            dir: cwd,
            sessionKey: payload.sessionKey
        }
    })
    execStreams.set(ctx.refId, stream)

    const interactivePermissions = payload.permissionMode === 'default'
    const handshakeTimeoutMs =
        payload.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    const legacyTurnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS
    const promptTimeouts: AcpTimeouts = {
        idleTimeoutMs: payload.idleTimeoutMs ?? legacyTurnTimeoutMs,
        maxDurationMs: payload.maxDurationMs ?? legacyTurnTimeoutMs
    }
    const permissionTimeoutMs =
        payload.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS

    let child: ChildProcess | null = null
    const pending = new Map<number, PendingRequest>()
    let nextId = 1
    let cancelled = false
    let fatalError: Error | null = null
    const stderrTail: string[] = []

    const settleAll = (err: Error): void => {
        for (const [, p] of pending) p.reject(err)
        pending.clear()
    }
    const killChild = (): void => {
        try {
            child?.kill('SIGTERM')
        } catch {}
        setTimeout(() => {
            try {
                child?.kill('SIGKILL')
            } catch {}
        }, KILL_ESCALATION_MS).unref()
    }
    const writeLine = (line: string): void => {
        if (!child?.stdin || child.stdin.writableEnded)
            throw new Error('openclaw stdin closed')
        child.stdin.write(`${line}\n`)
    }

    const request = (
        method: string,
        params: Record<string, unknown>,
        timeouts: number | AcpTimeouts
    ): Promise<Record<string, unknown> | undefined> => {
        const { idleTimeoutMs, maxDurationMs } =
            typeof timeouts === 'number'
                ? { idleTimeoutMs: timeouts, maxDurationMs: timeouts }
                : timeouts
        const id = nextId++
        return new Promise((resolve, reject) => {
            let idleTimer: ReturnType<typeof setTimeout> | null = null
            let maxTimer: ReturnType<typeof setTimeout> | null = null
            const clearTimers = (): void => {
                if (idleTimer) clearTimeout(idleTimer)
                if (maxTimer) clearTimeout(maxTimer)
            }
            const fail = (message: string): void => {
                clearTimers()
                pending.delete(id)
                reject(new Error(message))
            }
            const armIdle = (): void => {
                if (idleTimer) clearTimeout(idleTimer)
                idleTimer = setTimeout(
                    () =>
                        fail(
                            `openclaw ${method} produced no output for ${idleTimeoutMs}ms`
                        ),
                    idleTimeoutMs
                )
                idleTimer.unref?.()
            }
            maxTimer = setTimeout(
                () =>
                    fail(
                        `openclaw ${method} was still streaming when it hit its ${maxDurationMs}ms maximum duration`
                    ),
                maxDurationMs
            )
            maxTimer.unref?.()
            armIdle()
            pending.set(id, {
                method,
                touch: armIdle,
                resolve: (v) => {
                    clearTimers()
                    resolve(v)
                },
                reject: (e) => {
                    clearTimers()
                    reject(e)
                }
            })
            try {
                writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
            } catch (err) {
                clearTimers()
                pending.delete(id)
                reject(err as Error)
            }
        })
    }

    const touchPending = (): void => {
        for (const [, p] of pending) p.touch()
    }

    const pendingPermissions = new Map<
        string,
        {
            id: number | string
            timer: NodeJS.Timeout
            rejectOptionId: string | null
        }
    >()
    let permissionKeepAlive: NodeJS.Timeout | null = null

    const settlePermission = (
        requestId: string,
        outcome: 'selected' | 'timeout' | 'cancelled',
        optionId: string | null
    ): void => {
        const entry = pendingPermissions.get(requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        pendingPermissions.delete(requestId)
        if (pendingPermissions.size === 0 && permissionKeepAlive) {
            clearInterval(permissionKeepAlive)
            permissionKeepAlive = null
        }
        // The resolution rides the buffer BEFORE the child reply so a replay
        // shows the settlement ahead of any post-approval output — the live
        // order. Uses the dialect's resolution method so the API decodes it.
        safePublish(
            'stdout',
            `${JSON.stringify({
                jsonrpc: '2.0',
                method: '_manyfold/permission_resolution',
                params: { requestId, outcome, optionId }
            })}\n`
        )
        try {
            writeLine(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: entry.id,
                    result: {
                        outcome: optionId
                            ? { outcome: 'selected', optionId }
                            : { outcome: 'cancelled' }
                    }
                })
            )
        } catch {}
    }
    const cancelPendingPermissions = (): void => {
        for (const requestId of [...pendingPermissions.keys()])
            settlePermission(requestId, 'cancelled', null)
    }

    const respondToAgent = (frame: Record<string, unknown>): void => {
        if (
            frame.method === 'session/request_permission' &&
            interactivePermissions &&
            frame.id !== undefined &&
            frame.id !== null
        ) {
            const params = frame.params as Record<string, unknown> | undefined
            const rawOptions = Array.isArray(params?.options)
                ? (params!.options as Array<Record<string, unknown>>)
                : []
            const options = rawOptions
                .filter((o) => o && typeof o.optionId === 'string')
                .map((o) => ({
                    optionId: o.optionId as string,
                    kind: typeof o.kind === 'string' ? o.kind : ''
                }))
            const requestId = String(frame.id)
            const rejectOptionId = pickRejectOptionId(options)
            const timer = setTimeout(() => {
                settlePermission(requestId, 'timeout', rejectOptionId)
            }, permissionTimeoutMs)
            pendingPermissions.set(requestId, {
                id: frame.id as number | string,
                timer,
                rejectOptionId
            })
            if (!permissionKeepAlive) {
                permissionKeepAlive = setInterval(() => touchPending(), 15_000)
                permissionKeepAlive.unref()
            }
            // No reply yet — the request frame is already durable in the buffer
            // (every stdout line is), which is what surfaces the card.
            return
        }
        // Headless: auto-approve asks, refuse anything else, so the agent never
        // blocks on a client that renders no UI.
        const response: Record<string, unknown> = {
            jsonrpc: '2.0',
            id: frame.id as number | string
        }
        if (frame.method === 'session/request_permission')
            response.result = {
                outcome: {
                    outcome: 'selected',
                    optionId: pickAutoApproveOptionId(
                        frame.params as Record<string, unknown> | undefined
                    )
                }
            }
        else
            response.error = {
                code: -32601,
                message: `method not found: ${String(frame.method)}`
            }
        try {
            writeLine(JSON.stringify(response))
        } catch {}
    }

    const handleLine = (line: string): void => {
        let frame: Record<string, unknown>
        try {
            frame = JSON.parse(line) as Record<string, unknown>
        } catch {
            return
        }
        touchPending()
        if ('id' in frame && ('result' in frame || 'error' in frame)) {
            const id =
                typeof frame.id === 'string' ? Number(frame.id) : (frame.id as number)
            const req = pending.get(id)
            if (!req) return
            pending.delete(id)
            const err = frame.error as { message?: string } | undefined
            if (err)
                req.reject(new Error(err.message ?? `openclaw ${req.method} failed`))
            else req.resolve(frame.result as Record<string, unknown> | undefined)
            return
        }
        if ('id' in frame && 'method' in frame) respondToAgent(frame)
        // Notifications need no routing here: the API decodes them from the
        // (replayed) stream.
    }

    const safePublish = (kind: 'stdout' | 'stderr', data: string): void => {
        if (stream.status !== 'running') return
        try {
            stream.publish(kind, data)
        } catch (err) {
            try {
                child?.kill('SIGKILL')
            } catch {}
            console.error(
                `turn buffer publish failed for ${ctx.refId}: ${(err as Error).message}`
            )
        }
    }

    const readUsageBack = async (): Promise<{
        usage?: OpenclawTurnUsage
        usageStatus: string
    }> => {
        const read = async (
            limit: number
        ): Promise<ReturnType<typeof decodeOpenclawTurnUsage>> => {
            const result = await gatewayCall(
                'sessions.get',
                { key: payload.sessionKey, limit },
                env
            )
            if (!result) return { status: 'invalid' }
            return decodeOpenclawTurnUsage(result, payload.prompt, { limit })
        }
        let decoded = await read(USAGE_WINDOW)
        if (decoded.status === 'no_user_message' && decoded.windowFull)
            decoded = await read(USAGE_WINDOW_WIDE)
        return decoded.status === 'ok'
            ? { usage: decoded.usage, usageStatus: 'ok' }
            : { usageStatus: decoded.status }
    }

    const complete = (final: DaemonTurnFinalPayload, ok: boolean, error?: string): void => {
        stream.complete(
            {
                ok,
                payload: final as unknown as Record<string, unknown>,
                ...(error ? { error } : {})
            },
            cancelled ? 'aborted' : 'completed'
        )
    }

    const drive = async (): Promise<void> => {
        // Pre-patch the session in-box for the ask mode / model pick BEFORE the
        // bridge starts: the ACP options cannot set execAsk or the model, so a
        // gateway RPC on the deterministic key must. A patch failure is not
        // fatal — the turn still runs, it just runs unpatched (no approval /
        // default model), which is strictly the pre-existing behaviour.
        if (payload.patch && (payload.patch.execAsk || payload.patch.model)) {
            const params: Record<string, unknown> = { key: payload.sessionKey }
            if (payload.patch.execAsk) params.execAsk = payload.patch.execAsk
            if (payload.patch.model) params.model = payload.patch.model
            await gatewayCall('sessions.patch', params, env).catch(() => null)
        }

        child = spawn(ACP_CMD[0], ACP_CMD.slice(1), {
            cwd,
            env: {
                ...env,
                OPENCLAW_HIDE_BANNER: '1',
                OPENCLAW_SUPPRESS_NOTES: '1'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        })
        child.stdin?.on('error', () => {})
        args.registerChild(child, stream)

        let stdoutBuf = ''
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
            stdoutBuf += chunk
            let nl = stdoutBuf.indexOf('\n')
            while (nl !== -1) {
                const line = stdoutBuf.slice(0, nl).trim()
                stdoutBuf = stdoutBuf.slice(nl + 1)
                nl = stdoutBuf.indexOf('\n')
                if (!line) continue
                // Buffer first, then route: completion is written by handleLine
                // resolving the prompt, and by then the line that did it must
                // already be durable.
                safePublish('stdout', `${line}\n`)
                handleLine(line)
            }
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
            safePublish('stderr', chunk)
            if (chunk.trim()) touchPending()
            for (const rawLine of chunk.split(/\r?\n/)) {
                const line = rawLine.trim()
                if (!line) continue
                stderrTail.push(line)
                if (stderrTail.length > 80) stderrTail.shift()
                if (!fatalError && isFatalStderrLine(line)) {
                    const tail = stderrTail.slice(-12).join('\n').trim()
                    fatalError = new Error(
                        tail
                            ? `${line}\n--- openclaw stderr (tail) ---\n${tail}`
                            : line
                    )
                    settleAll(fatalError)
                    killChild()
                }
            }
        })
        child.on('error', (err) => {
            safePublish('stderr', `[spawn error] ${err.message}\n`)
            const e = new Error(`openclaw acp spawn failed: ${err.message}`)
            if (!fatalError) fatalError = e
            settleAll(e)
        })
        child.on('close', (code) => {
            const reason =
                fatalError ??
                new Error(
                    pickStderrErrorLine(stderrTail) ??
                        `openclaw acp exited with code ${code ?? 'unknown'}`
                )
            settleAll(reason)
        })

        if (interactivePermissions)
            permissionResponders.set(ctx.refId, (requestId, optionId) => {
                if (!pendingPermissions.has(requestId)) return 'unknown'
                settlePermission(requestId, 'selected', optionId)
                return 'delivered'
            })

        try {
            await request(
                'initialize',
                {
                    protocolVersion: ACP_PROTOCOL_VERSION,
                    clientInfo: {
                        name: 'manyfold-daemon-adapter',
                        version: '0.1.0'
                    },
                    clientCapabilities: {}
                },
                handshakeTimeoutMs
            )
            // Continuity is the gateway session's, keyed by _meta.sessionKey —
            // the ACP sessionId is disposable — so every turn is a fresh
            // session/new on the same key. Never session/resume.
            const created = await request(
                'session/new',
                {
                    cwd,
                    mcpServers: [],
                    ...(OPENCLAW_ACP_DIALECT.sessionMeta?.(payload.sessionKey) ?? {})
                },
                handshakeTimeoutMs
            )
            const sessionId =
                created && typeof created.sessionId === 'string'
                    ? created.sessionId
                    : null
            if (!sessionId)
                throw new Error('openclaw session/new returned no sessionId')
            const result = await request(
                'session/prompt',
                {
                    sessionId,
                    prompt: [{ type: 'text', text: payload.prompt }],
                    ...(OPENCLAW_ACP_DIALECT.promptMeta ?? {})
                },
                promptTimeouts
            )
            // The ACP stream carries no usage; read it back from the gateway
            // transcript. Best-effort — never fails the turn.
            const usageRead: {
                usage?: OpenclawTurnUsage
                usageStatus: string
            } = await readUsageBack().catch(() => ({ usageStatus: 'error' }))
            const final: DaemonTurnFinalPayload = {
                stopReason:
                    result && typeof result.stopReason === 'string'
                        ? result.stopReason
                        : 'completed',
                sessionId,
                ...(result ? { result } : {}),
                ...(usageRead.usage ? { usage: usageRead.usage } : {}),
                usageStatus: usageRead.usageStatus
            }
            complete(final, true)
        } catch (err) {
            complete(
                { stopReason: null, sessionId: null },
                false,
                (err as Error).message
            )
        } finally {
            permissionResponders.delete(ctx.refId)
            cancelPendingPermissions()
            // openclaw ignores stdin EOF, so the SIGTERM escalation — not the
            // EOF — is what ends the bridge. (The API's remote-exec path cannot
            // signal, which is why it wraps the bridge in cat/kill; the daemon
            // owns the child and signals it directly.)
            try {
                child?.stdin?.end()
            } catch {}
            setTimeout(() => {
                try {
                    child?.kill('SIGTERM')
                } catch {}
            }, 500).unref()
            setTimeout(() => {
                try {
                    child?.kill('SIGKILL')
                } catch {}
            }, KILL_ESCALATION_MS).unref()
            args.releaseChild()
        }
    }

    ctx.onCancel(() => {
        cancelled = true
        cancelPendingPermissions()
        settleAll(new Error('cancelled'))
        killChild()
    })

    return new Promise((resolveAck) => {
        let settled = false
        stream.subscribe((kind, data, seq) => {
            if (kind === '__done__') {
                if (settled) return
                settled = true
                try {
                    resolveAck(JSON.parse(data) as TurnAck)
                } catch {
                    resolveAck({ ok: false, error: 'invalid final payload' })
                }
                return
            }
            ctx.sendEvent(kind, data, seq)
        }, 0)
        void drive()
    })
}
