import { spawn, type ChildProcess } from 'node:child_process'
import type { DaemonHermesTurnPayload, DaemonTurnFinalPayload } from '@manyfold/shared'
import type { RpcContext } from './ws-client'
import { ExecStream, execStreams } from './exec-buffer'

// The daemon is the ACP client. The earlier shape — the API speaking ACP over a
// forwarded exec pipe — could not survive an API restart BY CONSTRUCTION: ACP
// is client-driven, so losing the client ends the turn no matter what the
// child wants. Here the whole conversation lives in this process; the API only
// reads the stream (live, or replayed via exec.resume), so its restarts are
// invisible to the turn.
//
// stdout is published to the buffer PER LINE, one event per JSON-RPC frame,
// not per chunk like exec.start: the API decodes the replayed stream line by
// line, and one-frame-per-event makes that immune to chunk boundaries.

const ACP_DEFAULT_CMD = ['hermes', 'acp', '--accept-hooks']
const ACP_PROTOCOL_VERSION = 1
const DEFAULT_TURN_TIMEOUT_MS = 240_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000
const KILL_ESCALATION_MS = 5_000

// Ported from the API's hermes-acp-client, which learned these on production
// traffic: hermes does NOT exit on provider auth/4xx failures — it stays in
// ACP mode and never answers session/prompt, so without this the turn would
// sit out its whole timeout on an error hermes already printed. Transient
// warnings (retry attempts) intentionally do not match.
const FATAL_STDERR_PATTERNS = [/\bAborting\b/i, /Non-retryable.*error/i]
const STDERR_ERROR_HINTS = [
    /HTTP\s+\d{3}/i,
    /AuthenticationError/i,
    /API key/i,
    /Aborting/i,
    /Non-retryable/i,
    /\bERROR\b/,
    /Traceback/i,
    /Exception/i
]

const pickStderrErrorLine = (lines: string[]): string | null => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim()
        if (!line) continue
        if (STDERR_ERROR_HINTS.some((re) => re.test(line))) return line
    }
    return null
}

// Ported from the API's hermes-acp-client (pickAutoApproveOptionId): the old
// hardcoded 'approve_for_session' matches no option id current hermes builds
// advertise, and an unknown id maps to DENY on both of hermes's approval
// bridges — the headless auto-approve was silently rejecting every file edit.
// Seen on hermes-agent 0.20.6 [2026-08-29]: terminal-command asks offer
// allow_once / allow_session / allow_always / deny / deny_always; edit asks
// offer only allow_once / deny.
const pickAutoApproveOptionId = (
    params: Record<string, unknown> | undefined
): string => {
    const options = params?.options
    if (Array.isArray(options)) {
        const rows = options.filter(
            (o): o is Record<string, unknown> => !!o && typeof o === 'object'
        )
        const byKind = (kind: string): string | null => {
            for (const o of rows) {
                if (o.kind === kind && typeof o.optionId === 'string')
                    return o.optionId
            }
            return null
        }
        const allowAny = (): string | null => {
            for (const o of rows) {
                if (
                    typeof o.kind === 'string' &&
                    o.kind.startsWith('allow') &&
                    typeof o.optionId === 'string'
                )
                    return o.optionId
            }
            return null
        }
        const picked =
            byKind('allow_always') ?? byKind('allow_once') ?? allowAny()
        if (picked) return picked
    }
    return 'approve_for_session'
}

interface PendingRequest {
    method: string
    resolve: (result: Record<string, unknown> | undefined) => void
    reject: (err: Error) => void
    // Rearms the inactivity budget. Called for every frame the child produces.
    touch: () => void
}

// #556: `session/prompt` streams the whole answer as session/update
// notifications and only resolves at the end, so one response deadline over it
// was a wall-clock cap on the turn rather than a hang detector — an ACP
// conversation still emitting got truncated. idle restarts on activity; the
// ceiling is separate. Handshake calls keep a single short budget.
interface AcpTimeouts {
    idleTimeoutMs: number
    maxDurationMs: number
}

export interface TurnAck {
    ok: boolean
    payload?: Record<string, unknown>
    error?: string
}

export const runAcpTurn = (args: {
    payload: DaemonHermesTurnPayload
    cwd: string
    ctx: RpcContext
    registerChild: (child: ChildProcess, stream: ExecStream) => void
    releaseChild: () => void
}): Promise<TurnAck> => {
    const { payload, ctx, cwd } = args
    const stream = new ExecStream({
        refId: ctx.refId,
        method: 'turn.start',
        // env stays out of meta.json: it can carry credentials, and nothing
        // ever reads it back out of the buffer.
        payload: {
            framework: payload.framework,
            cmd: payload.cmd ?? ACP_DEFAULT_CMD,
            dir: cwd,
            sessionId: payload.sessionId ?? null
        }
    })
    execStreams.set(ctx.refId, stream)

    const cmd = payload.cmd?.length ? payload.cmd : ACP_DEFAULT_CMD
    const child = spawn(cmd[0], cmd.slice(1), {
        cwd,
        env: {
            ...process.env,
            HERMES_YOLO_MODE: '1',
            ...(payload.env ?? {})
        },
        stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin?.on('error', () => {})
    args.registerChild(child, stream)

    const pending = new Map<number, PendingRequest>()
    let nextId = 1
    let sessionId: string | null = null
    let cancelled = false
    let fatalError: Error | null = null
    const stderrTail: string[] = []

    const settleAll = (err: Error): void => {
        for (const [, p] of pending) p.reject(err)
        pending.clear()
    }

    const killChild = (): void => {
        try {
            child.kill('SIGTERM')
        } catch {}
        setTimeout(() => {
            try {
                child.kill('SIGKILL')
            } catch {}
        }, KILL_ESCALATION_MS).unref()
    }

    const writeLine = (line: string): void => {
        if (!child.stdin || child.stdin.writableEnded)
            throw new Error('hermes stdin closed')
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
                            `hermes ${method} produced no output for ${idleTimeoutMs}ms`
                        ),
                    idleTimeoutMs
                )
                idleTimer.unref?.()
            }
            maxTimer = setTimeout(
                () =>
                    fail(
                        `hermes ${method} was still streaming when it hit its ${maxDurationMs}ms maximum duration`
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

    // Every frame the child produces is proof the turn is alive — the
    // session/update notifications this process deliberately does not route ARE
    // the answer streaming in. Rearming here is what makes the pending
    // request's budget an INACTIVITY budget instead of a deadline.
    const touchPending = (): void => {
        for (const [, p] of pending) p.touch()
    }

    const respondToAgent = (frame: Record<string, unknown>): void => {
        // Headless: auto-approve permission asks and refuse everything else,
        // so the agent never blocks on a client that cannot render UI.
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
                typeof frame.id === 'string'
                    ? Number(frame.id)
                    : (frame.id as number)
            const req = pending.get(id)
            if (!req) return
            pending.delete(id)
            const err = frame.error as { message?: string } | undefined
            if (err) req.reject(new Error(err.message ?? `hermes ${req.method} failed`))
            else req.resolve(frame.result as Record<string, unknown> | undefined)
            return
        }
        if ('id' in frame && 'method' in frame) respondToAgent(frame)
        // Notifications need no routing here: the API decodes them from the
        // (replayed) stream. This process only drives the request/response
        // dance and the child's lifecycle.
    }

    const safePublish = (kind: 'stdout' | 'stderr', data: string): void => {
        if (stream.status !== 'running') return
        try {
            stream.publish(kind, data)
        } catch (err) {
            // publish() already completed the stream as crashed; make sure the
            // child does not keep generating into a log nobody can read.
            try {
                child.kill('SIGKILL')
            } catch {}
            console.error(
                `turn buffer publish failed for ${ctx.refId}: ${(err as Error).message}`
            )
        }
    }

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
        // Counts as activity too: a long silent tool call may produce nothing on
        // stdout while hermes still logs progress here. A chatty-but-wedged
        // child is caught by the max-duration budget instead.
        if (chunk.trim()) touchPending()
        for (const rawLine of chunk.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line) continue
            stderrTail.push(line)
            if (stderrTail.length > 80) stderrTail.shift()
            if (!fatalError && FATAL_STDERR_PATTERNS.some((re) => re.test(line))) {
                const tail = stderrTail.slice(-12).join('\n').trim()
                fatalError = new Error(
                    tail ? `${line}\n--- hermes stderr (tail) ---\n${tail}` : line
                )
                settleAll(fatalError)
                killChild()
            }
        }
    })

    child.on('error', (err) => {
        safePublish('stderr', `[spawn error] ${err.message}\n`)
        const e = new Error(`hermes acp spawn failed: ${err.message}`)
        if (!fatalError) fatalError = e
        settleAll(e)
    })
    child.on('close', (code) => {
        // The child ending while requests are pending means the turn died;
        // reject the waiters with the most informative stderr line so the
        // failure names its cause instead of a bare timeout.
        const reason =
            fatalError ??
            new Error(
                pickStderrErrorLine(stderrTail) ??
                    `hermes acp exited with code ${code ?? 'unknown'}`
            )
        settleAll(reason)
    })

    ctx.onCancel(() => {
        cancelled = true
        settleAll(new Error('cancelled'))
        killChild()
    })

    const handshakeTimeoutMs =
        payload.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    // An API that predates the split sends only timeoutMs; it then backs both
    // budgets, and because the max clock starts first the payload degenerates
    // to exactly the single absolute cap it used to mean.
    const legacyTurnTimeoutMs = payload.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    const promptTimeouts: AcpTimeouts = {
        idleTimeoutMs: payload.idleTimeoutMs ?? legacyTurnTimeoutMs,
        maxDurationMs: payload.maxDurationMs ?? legacyTurnTimeoutMs
    }

    const sessionIdFrom = (
        result: Record<string, unknown> | undefined
    ): string | null =>
        result && typeof result.sessionId === 'string' && result.sessionId
            ? result.sessionId
            : null

    // Ported from the API's hermes-acp-client (decodeAcpSessionState /
    // acpModelMatches): the models/modes state hermes attaches to its
    // session/new|resume responses, and the `provider:model` vs bare-id
    // comparison (endsWith, not a prefix strip — model ids can contain
    // colons themselves).
    interface SessionState {
        currentModelId: string | null
        modelIds: string[]
        currentModeId: string | null
        modeIds: string[]
    }
    const decodeSessionState = (
        result: Record<string, unknown> | undefined
    ): SessionState | null => {
        if (!result) return null
        const models = result.models as Record<string, unknown> | undefined
        const modes = result.modes as Record<string, unknown> | undefined
        if (!models && !modes) return null
        const ids = (value: unknown, key: string): string[] =>
            Array.isArray(value)
                ? value
                      .map((item) =>
                          item && typeof item === 'object'
                              ? (item as Record<string, unknown>)[key]
                              : null
                      )
                      .filter((v): v is string => typeof v === 'string' && !!v)
                : []
        return {
            currentModelId:
                typeof models?.currentModelId === 'string'
                    ? models.currentModelId
                    : null,
            modelIds: ids(models?.availableModels, 'modelId'),
            currentModeId:
                typeof modes?.currentModeId === 'string'
                    ? modes.currentModeId
                    : null,
            modeIds: ids(modes?.availableModes, 'id')
        }
    }
    const modelMatches = (current: string | null, bare: string): boolean =>
        current !== null && (current === bare || current.endsWith(`:${bare}`))

    let sessionState: SessionState | null = null

    const drive = async (): Promise<void> => {
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
            if (payload.sessionId) {
                try {
                    const res = await request(
                        'session/resume',
                        {
                            cwd,
                            sessionId: payload.sessionId,
                            mcpServers: []
                        },
                        handshakeTimeoutMs
                    )
                    sessionId = sessionIdFrom(res) ?? payload.sessionId
                    sessionState = decodeSessionState(res)
                } catch {
                    const res = await request(
                        'session/new',
                        { cwd, mcpServers: [] },
                        handshakeTimeoutMs
                    )
                    sessionId = sessionIdFrom(res)
                    sessionState = decodeSessionState(res)
                }
            } else {
                const res = await request(
                    'session/new',
                    { cwd, mcpServers: [] },
                    handshakeTimeoutMs
                )
                sessionId = sessionIdFrom(res)
                sessionState = decodeSessionState(res)
            }
            if (!sessionId)
                throw new Error('hermes session/new returned no sessionId')
            // Reconcile the session's persisted model with the payload's
            // choice. State known -> diff (an untouched session costs no
            // RPC). State unknown (old hermes build) -> only a REQUIRED
            // switch attempts it, where failing loudly beats answering with
            // a model the user did not pick; a reconcile-only target is the
            // agent default, which such a build already runs.
            if (payload.modelOverride) {
                const shouldSet = sessionState
                    ? !modelMatches(
                          sessionState.currentModelId,
                          payload.modelOverride
                      )
                    : payload.modelOverrideRequired === true
                if (shouldSet) {
                    try {
                        await request(
                            'session/set_model',
                            {
                                sessionId,
                                modelId: payload.modelOverride
                            },
                            handshakeTimeoutMs
                        )
                    } catch (err) {
                        throw new Error(
                            `hermes session/set_model failed: ${(err as Error).message}`
                        )
                    }
                    if (sessionState)
                        sessionState = {
                            ...sessionState,
                            currentModelId: payload.modelOverride
                        }
                }
            }
            const result = await request(
                'session/prompt',
                {
                    sessionId,
                    prompt: [{ type: 'text', text: payload.prompt }]
                },
                promptTimeouts
            )
            const final: DaemonTurnFinalPayload = {
                // A string here is the API's licence to emit `done`; the prompt
                // call resolving IS the agent finishing, so default the reason
                // rather than leave completion unprovable.
                stopReason:
                    result && typeof result.stopReason === 'string'
                        ? result.stopReason
                        : 'completed',
                sessionId,
                ...(result ? { result } : {}),
                ...(sessionState
                    ? {
                          models: {
                              currentModelId: sessionState.currentModelId,
                              modelIds: sessionState.modelIds
                          },
                          modes: {
                              currentModeId: sessionState.currentModeId,
                              modeIds: sessionState.modeIds
                          }
                      }
                    : {})
            }
            stream.complete(
                { ok: true, payload: final as unknown as Record<string, unknown> },
                'completed'
            )
        } catch (err) {
            stream.complete(
                {
                    ok: false,
                    payload: { stopReason: null, sessionId },
                    error: (err as Error).message
                },
                cancelled ? 'aborted' : 'completed'
            )
        } finally {
            // The conversation is over either way. EOF lets hermes exit on its
            // own; the escalation covers a child that lingers.
            try {
                child.stdin?.end()
            } catch {}
            setTimeout(() => {
                try {
                    child.kill('SIGTERM')
                } catch {}
            }, 2_000).unref()
            setTimeout(() => {
                try {
                    child.kill('SIGKILL')
                } catch {}
            }, KILL_ESCALATION_MS + 2_000).unref()
            args.releaseChild()
        }
    }

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
