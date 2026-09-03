import { WebSocket } from 'ws'
import { classifyHttpStatus, SpritesError } from './errors'
import type { SpritesClient } from './client'
import type { ExecOptions, ExecResult, SpritesLogger } from './types'

const DEFAULT_EXEC_TIMEOUT_MS = 60_000

// capture:'tail' result-buffer bounds (chars). Streaming consumers read full
// output from the iterators; the result buffer only feeds error messages.
const STDOUT_TAIL_CHARS = 8 * 1024
const STDERR_TAIL_CHARS = 16 * 1024

// Producer/consumer decoupling bound: when the consumer (per-chunk awaited DB
// writes) lags the socket by this much queued text, pause the socket instead
// of buffering without limit; resume once drained below the low water mark.
const QUEUE_HIGH_WATER_BYTES = 4 * 1024 * 1024
const QUEUE_LOW_WATER_BYTES = 1024 * 1024

const silentLogger: SpritesLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
}

export interface ExecStreamHandle {
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    result: Promise<ExecResult>
    abort: () => void
    // Close the socket WITHOUT killing the process (abort best-effort kills).
    // The session keeps running detached (max_run_after_disconnect applies);
    // used by turn adoption to walk away from an attach it must not destroy
    // (foreign session, alignment bail). Settles result with a rejection.
    detach: () => void
}

// Probed 2026-07-07 (see skill wss.md): attaching `?id=<session>` replays the
// FULL stdout history from byte 0 as a clean prefix, then live frames follow
// and exit is delivered normally. stderr is NOT in the scrollback (gap output
// lost — diagnostics only), and a session whose process exits with no client
// attached is reaped immediately (attach answers `{"error":"session not
// found"}`), so a result produced entirely inside a drop gap is unrecoverable
// here and falls back to the transport-error path — tagged
// `reason: 'exec_session_gone'` so callers can recover from the framework's
// on-disk session log instead of retrying the dead attach target.
const REATTACH_DELAYS_MS = [500, 2000, 5000]
const DEFAULT_REATTACH_ATTEMPTS = 3
const INITIAL_CONNECT_DELAYS_MS = [300, 600, 1200]
const DEFAULT_INITIAL_CONNECT_ATTEMPTS = 3

// Both entry points (fresh exec + cross-process attach) share the same ~500
// lines of socket/reattach/settle machinery; only the initial connection kind,
// the URL, the stdin pump and a few seed values differ. Those differences are
// normalised into this params object so the body below is written once.
interface RunExecStreamParams {
    mode: 'fresh' | 'attach'
    freshUrl?: string
    timeoutMs: number
    keepAliveMs?: number
    livenessTimeoutMs?: number
    binary: boolean
    tailCapture: boolean
    tty: boolean
    cols?: number
    rows?: number
    reattachEnabled: boolean
    maxReattachAttempts: number
    initialConnectRetryEnabled: boolean
    maxInitialConnectAttempts: number
    sessionId?: string
    skipReplayBytes: number
    stdinEofSent: boolean
    onSessionId?: (sessionId: string) => void
    startStdin?: (
        ws: WebSocket,
        onError: (err: Error) => void,
        onEofSent: () => void
    ) => void
}

const runExecStream = (
    client: SpritesClient,
    spriteName: string,
    params: RunExecStreamParams,
    logger: SpritesLogger
): ExecStreamHandle => {
    const timeoutMs = params.timeoutMs
    const keepAliveMs = params.keepAliveMs
    const livenessTimeoutMs = params.livenessTimeoutMs
    const headers = client.authHeaderForInternalUse()
    const reattachEnabled = params.reattachEnabled
    const maxReattachAttempts = params.maxReattachAttempts
    const initialConnectRetryEnabled = params.initialConnectRetryEnabled
    const maxInitialConnectAttempts = params.maxInitialConnectAttempts

    // Shared socket backpressure: either queue crossing its high water pauses
    // the socket; both draining below low resumes it. While intentionally
    // paused no frames or pongs arrive, so the liveness watchdog is parked —
    // it would otherwise false-fire on silence we caused ourselves.
    let pressure = 0
    const onQueueHigh = (): void => {
        pressure += 1
        if (pressure !== 1 || settled) return
        try {
            currentWs.pause()
        } catch {}
        if (livenessTimer) {
            clearTimeout(livenessTimer)
            livenessTimer = null
        }
        logger.debug('sprites.exec.backpressure.pause', { spriteName })
    }
    const onQueueLow = (): void => {
        pressure -= 1
        if (pressure !== 0 || settled) return
        try {
            currentWs.resume()
        } catch {}
        armLiveness()
        logger.debug('sprites.exec.backpressure.resume', { spriteName })
    }
    const queuePressureOpts = {
        highWaterBytes: QUEUE_HIGH_WATER_BYTES,
        lowWaterBytes: QUEUE_LOW_WATER_BYTES,
        sizeOf: (chunk: string) => chunk.length,
        onHigh: onQueueHigh,
        onLow: onQueueLow
    }
    const stdoutQueue = new AsyncQueue<string>(queuePressureOpts)
    const stderrQueue = new AsyncQueue<string>(queuePressureOpts)
    // The decoders live across reconnects: the replay skip is byte-exact, so
    // feeding the post-skip remainder to the SAME streaming decoder means a
    // multibyte char split across the drop still decodes intact.
    const stdoutDecoder = new TextDecoder('utf-8', { fatal: false })
    const stderrDecoder = new TextDecoder('utf-8', { fatal: false })
    const binary = params.binary
    const decodeStdout = (payload: Buffer): string =>
        binary
            ? payload.toString('latin1')
            : stdoutDecoder.decode(payload, { stream: true })
    const decodeStderr = (payload: Buffer): string =>
        binary
            ? payload.toString('latin1')
            : stderrDecoder.decode(payload, { stream: true })

    let exitCode: number | undefined
    let sessionId = params.sessionId
    let stdoutConcat = ''
    let stderrConcat = ''
    let settled = false
    let stdinEofSent = params.stdinEofSent
    // Raw 0x01 payload bytes already consumed; an attach replays the full
    // history, so exactly this many bytes are skipped before decoding resumes.
    let seenStdoutRawBytes = 0
    let skipReplayBytes = params.skipReplayBytes
    // Fires onSessionId exactly once across the fresh connect + any reattach —
    // every session_info after the first is a no-op for the callback.
    let sessionIdReported = false
    let reattachAttempts = 0
    // Lifetime reconnect count: unlike reattachAttempts (reset to 0 on every
    // successful attach so each detach gets a fresh retry budget), this only
    // grows, so close/refusal telemetry reflects how many drops this exec rode.
    let totalReattaches = 0
    let connOpenedAt: number | undefined
    let reattachTimer: ReturnType<typeof setTimeout> | null = null
    let initialConnectAttempts = 0
    let initialConnectTimer: ReturnType<typeof setTimeout> | null = null

    const tailCapture = params.tailCapture
    const appendStdout = (text: string): void => {
        stdoutConcat += text
        if (tailCapture && stdoutConcat.length > STDOUT_TAIL_CHARS)
            stdoutConcat = stdoutConcat.slice(-STDOUT_TAIL_CHARS)
    }
    const appendStderr = (text: string): void => {
        stderrConcat += text
        if (tailCapture && stderrConcat.length > STDERR_TAIL_CHARS)
            stderrConcat = stderrConcat.slice(-STDERR_TAIL_CHARS)
    }

    let resolveResult!: (value: ExecResult) => void
    let rejectResult!: (err: Error) => void
    const result = new Promise<ExecResult>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
    })
    // The same failure also surfaces through the stdout/stderr queues, and
    // callers may attach to `result` only after consuming the stream — a
    // rejection landing in that window must not become an unhandledRejection.
    // Real awaiters still observe the rejection normally.
    result.catch(() => {})

    let keepAliveTimer: ReturnType<typeof setInterval> | null = null
    let livenessTimer: ReturnType<typeof setTimeout> | null = null

    // Absolute wall-clock backstop; spans reconnects and is never reset.
    const timer = setTimeout(() => {
        if (settled) return
        failClientSide(
            'timeout',
            new SpritesError(
                'transient',
                `execSpriteStream timed out after ${timeoutMs}ms`,
                undefined,
                undefined,
                {
                    execPhase:
                        connOpenedAt === undefined ? 'pre_open' : 'post_open'
                }
            )
        )
    }, timeoutMs)

    const stopSocketTimers = (): void => {
        if (keepAliveTimer) clearInterval(keepAliveTimer)
        if (livenessTimer) clearTimeout(livenessTimer)
        keepAliveTimer = null
        livenessTimer = null
    }

    const clearTimers = (): void => {
        clearTimeout(timer)
        stopSocketTimers()
        if (reattachTimer) {
            clearTimeout(reattachTimer)
            reattachTimer = null
        }
        if (initialConnectTimer) {
            clearTimeout(initialConnectTimer)
            initialConnectTimer = null
        }
    }

    const armLiveness = (): void => {
        if (settled || livenessTimeoutMs === undefined) return
        if (livenessTimer) clearTimeout(livenessTimer)
        livenessTimer = setTimeout(() => {
            if (settled) return
            const err = new SpritesError(
                'transient',
                `execSpriteStream connection lost (no response for ${livenessTimeoutMs}ms)`,
                undefined,
                undefined,
                { execPhase: 'post_open' }
            )
            try {
                currentWs.close(1000, 'liveness')
            } catch {}
            handleDrop(err, false)
        }, livenessTimeoutMs)
    }

    const settleSuccess = (): void => {
        if (settled) return
        settled = true
        clearTimers()
        if (!binary) {
            const tailOut = stdoutDecoder.decode()
            if (tailOut) {
                appendStdout(tailOut)
                stdoutQueue.push(tailOut)
            }
            const tailErr = stderrDecoder.decode()
            if (tailErr) {
                appendStderr(tailErr)
                stderrQueue.push(tailErr)
            }
        }
        stdoutQueue.end()
        stderrQueue.end()
        if (typeof exitCode === 'number') {
            resolveResult({
                exitCode,
                stdout: stdoutConcat,
                stderr: stderrConcat,
                sessionId
            })
        } else {
            rejectResult(
                new SpritesError(
                    'transient',
                    'execSpriteStream closed without exit code'
                )
            )
        }
    }

    const settleFail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimers()
        stdoutQueue.fail(err)
        stderrQueue.fail(err)
        rejectResult(err)
    }

    const settleExit = (): void => {
        if (settled) return
        settleSuccess()
        try {
            if (currentWs.readyState === WebSocket.OPEN)
                currentWs.close(1000, 'exit')
        } catch {}
    }

    const canReattach = (): boolean =>
        reattachEnabled &&
        !settled &&
        typeof exitCode !== 'number' &&
        sessionId !== undefined &&
        stdinEofSent &&
        reattachAttempts < maxReattachAttempts

    // A dropped socket either schedules an attach to the still-running
    // session, or surfaces exactly what it surfaced before this feature:
    // close-without-exit rejects via settleSuccess, errors via settleFail.
    const handleDrop = (err: Error, fromClose: boolean): void => {
        if (settled) return
        stopSocketTimers()
        if (canReattach()) {
            scheduleReattach(err)
            return
        }
        if (fromClose) settleSuccess()
        else settleFail(err)
    }

    const scheduleReattach = (err: Error): void => {
        if (reattachTimer || settled) return
        const attempt = reattachAttempts
        reattachAttempts += 1
        totalReattaches += 1
        const delay =
            REATTACH_DELAYS_MS[
                Math.min(attempt, REATTACH_DELAYS_MS.length - 1)
            ] + Math.floor(Math.random() * 250)
        logger.warn('sprites.exec.reattach.scheduled', {
            spriteName,
            sessionId,
            attempt: attempt + 1,
            maxAttempts: maxReattachAttempts,
            delayMs: delay,
            failureClass: errorClass(err)
        })
        reattachTimer = setTimeout(() => {
            reattachTimer = null
            if (settled) return
            skipReplayBytes = seenStdoutRawBytes
            openSocket(true)
        }, delay)
        if (typeof reattachTimer.unref === 'function') reattachTimer.unref()
    }

    const scheduleInitialConnectRetry = (err: Error, attach: boolean): void => {
        if (initialConnectTimer || settled) return
        const attempt = initialConnectAttempts
        initialConnectAttempts += 1
        const delay =
            INITIAL_CONNECT_DELAYS_MS[
                Math.min(attempt, INITIAL_CONNECT_DELAYS_MS.length - 1)
            ] + Math.floor(Math.random() * 250)
        logger.warn('sprites.exec.initial_connect_retry.scheduled', {
            spriteName,
            attempt: attempt + 1,
            maxAttempts: maxInitialConnectAttempts,
            delayMs: delay,
            failureClass: errorClass(err)
        })
        initialConnectTimer = setTimeout(() => {
            initialConnectTimer = null
            if (settled) return
            openSocket(attach)
        }, delay)
        if (typeof initialConnectTimer.unref === 'function')
            initialConnectTimer.unref()
    }

    let currentWs!: WebSocket

    const openSocket = (attach: boolean): void => {
        const target = attach
            ? `${client.wsBaseUrl}/sprites/${encodeURIComponent(spriteName)}/exec?id=${encodeURIComponent(sessionId ?? '')}`
            : params.freshUrl!
        const ws = new WebSocket(target, { headers })
        currentWs = ws

        ws.on('open', () => {
            if (ws !== currentWs || settled) return
            connOpenedAt = Date.now()
            logger.debug(
                attach ? 'sprites.exec.reattach.open' : 'sprites.exec.open',
                { spriteName, sessionId }
            )
            if (keepAliveMs !== undefined) {
                keepAliveTimer = setInterval(() => {
                    if (settled) return
                    try {
                        currentWs.ping()
                    } catch {}
                }, keepAliveMs)
                if (typeof keepAliveTimer.unref === 'function')
                    keepAliveTimer.unref()
            }
            // A backpressure pause outlives the socket it paused: the new
            // socket starts paused too (liveness stays parked) until the
            // consumer drains below the low water mark.
            if (pressure > 0) {
                try {
                    ws.pause()
                } catch {}
            } else {
                armLiveness()
            }
            if (attach) return
            if (params.tty && params.cols && params.rows) {
                try {
                    ws.send(
                        JSON.stringify({
                            type: 'resize',
                            cols: params.cols,
                            rows: params.rows
                        })
                    )
                } catch {}
            }
            params.startStdin?.(
                ws,
                (err) => failClientSide('stdin_error', err),
                () => {
                    stdinEofSent = true
                }
            )
        })

        ws.on('message', (data, isBinary) => {
            if (ws !== currentWs || settled) return
            armLiveness()
            if (!isBinary) {
                const text = data.toString()
                try {
                    const msg = JSON.parse(text) as {
                        type?: string
                        session_id?: string
                        exit_code?: number
                        error?: string
                    }
                    if (typeof msg.error === 'string') {
                        // Attach refused — the probe (see comment above) showed a
                        // session whose process exited while detached is reaped,
                        // so retrying cannot succeed. Fail now; the caller's
                        // retryable error / recovery path takes over. The wire
                        // string is matched HERE, next to the probe doc, so
                        // callers branch on the structured `reason` instead.
                        const gone = /session not found/i.test(msg.error)
                        logger.warn('sprites.exec.reattach.refused', {
                            spriteName,
                            sessionId,
                            reconnects: totalReattaches,
                            failureClass: gone
                                ? 'session_gone'
                                : 'attach_refused'
                        })
                        try {
                            ws.close(1000, 'attach-refused')
                        } catch {}
                        settleFail(
                            new SpritesError(
                                'transient',
                                gone
                                    ? 'execSpriteStream attach failed: session not found'
                                    : 'execSpriteStream attach refused',
                                undefined,
                                undefined,
                                {
                                    ...(gone
                                        ? { reason: 'exec_session_gone' }
                                        : {}),
                                    ...(sessionId
                                        ? { execSessionId: sessionId }
                                        : {})
                                }
                            )
                        )
                        return
                    }
                    if (msg.type === 'session_info' && msg.session_id) {
                        sessionId = msg.session_id
                        if (!sessionIdReported) {
                            sessionIdReported = true
                            try {
                                params.onSessionId?.(msg.session_id)
                            } catch (err) {
                                logger.warn(
                                    'sprites.exec.on_session_id.failed',
                                    {
                                        spriteName,
                                        sessionId,
                                        failureClass: errorClass(err)
                                    }
                                )
                            }
                        }
                        if (attach) {
                            // Successful attach: a later drop gets a fresh
                            // retry budget (the platform re-arms the detach
                            // window per connection).
                            reattachAttempts = 0
                            logger.info('sprites.exec.reattach.success', {
                                spriteName,
                                sessionId,
                                replayedBytes: seenStdoutRawBytes
                            })
                        }
                    }
                    if (
                        msg.type === 'exit' &&
                        typeof msg.exit_code === 'number'
                    ) {
                        exitCode = msg.exit_code
                        settleExit()
                    }
                } catch {
                    logger.debug('sprites.exec.frame.text', {
                        bytes: Buffer.byteLength(text)
                    })
                }
                return
            }
            const buf = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data as ArrayBuffer)
            if (buf.length === 0) return
            if (params.tty) {
                if (buf[0] === 0x03 && buf.length <= 2) {
                    exitCode = buf.length === 2 ? buf[1] : 0
                    settleExit()
                    return
                }
                const text = decodeStdout(buf)
                if (text) {
                    appendStdout(text)
                    stdoutQueue.push(text)
                }
                return
            }
            const kind = buf[0]
            let payload = buf.subarray(1)
            if (kind === 0x01) {
                if (skipReplayBytes > 0) {
                    const n = Math.min(skipReplayBytes, payload.length)
                    skipReplayBytes -= n
                    payload = payload.subarray(n)
                    if (payload.length === 0) return
                }
                seenStdoutRawBytes += payload.length
                const text = decodeStdout(payload)
                if (text) {
                    appendStdout(text)
                    stdoutQueue.push(text)
                }
            } else if (kind === 0x02) {
                const text = decodeStderr(payload)
                if (text) {
                    appendStderr(text)
                    stderrQueue.push(text)
                }
            } else if (kind === 0x03 && payload.length >= 1) {
                exitCode = payload[0]
                settleExit()
            }
        })

        ws.on('pong', () => {
            if (ws !== currentWs || settled) return
            armLiveness()
        })

        // A non-101 upgrade response (e.g. 401/403 on a revoked account token)
        // lands here instead of 'error'. Without this listener ws would emit a
        // generic 'error' ("Unexpected server response: 401") that the handler
        // below blindly wraps as 'transient' — the opposite of the REST path,
        // where 401 is 'auth'. Classify from the real status so callers can
        // tell an auth failure from a retryable blip. Never reattach: the
        // socket never opened, so there is no session to resume.
        ws.on('unexpected-response', (req, res) => {
            res.resume()
            try {
                req.destroy()
            } catch {}
            if (ws !== currentWs || settled) return
            const status = res.statusCode ?? 0
            logger.warn('sprites.exec.unexpected_response', { status })
            const code = status ? classifyHttpStatus(status) : 'transient'
            const err = new SpritesError(
                code,
                `execSpriteStream handshake failed: HTTP ${status}`,
                status || undefined,
                undefined,
                { execPhase: 'pre_open' }
            )
            if (
                initialConnectRetryEnabled &&
                code === 'transient' &&
                connOpenedAt === undefined &&
                initialConnectAttempts < maxInitialConnectAttempts
            ) {
                scheduleInitialConnectRetry(err, attach)
                return
            }
            settleFail(err)
        })

        ws.on('error', (err) => {
            if (ws !== currentWs || settled) return
            logger.warn('sprites.exec.error', {
                failureClass: errorClass(err)
            })
            const sprErr = new SpritesError(
                'transient',
                'execSpriteStream transport error',
                undefined,
                undefined,
                {
                    execPhase:
                        connOpenedAt === undefined ? 'pre_open' : 'post_open'
                }
            )
            if (
                initialConnectRetryEnabled &&
                connOpenedAt === undefined &&
                initialConnectAttempts < maxInitialConnectAttempts
            ) {
                scheduleInitialConnectRetry(sprErr, attach)
                return
            }
            handleDrop(sprErr, false)
        })

        ws.on('close', (code) => {
            if (ws !== currentWs || settled) return
            // info (not debug): one line per connection per exec (normally 1 per
            // turn) preserves the operational close code without recording the
            // peer-controlled close reason. spritesLoggerFor drops debug.
            logger.info('sprites.exec.close', {
                spriteName,
                sessionId,
                code,
                exitCode,
                attach,
                reconnects: totalReattaches,
                connAgeMs:
                    connOpenedAt !== undefined
                        ? Date.now() - connOpenedAt
                        : undefined
            })
            // A failed initial connect emits 'error' then a synchronous
            // 'close' (ws emitErrorAndClose): when the error handler just
            // scheduled a retry, this close must not settle it away.
            if (initialConnectTimer && connOpenedAt === undefined) return
            if (typeof exitCode === 'number') {
                settleSuccess()
                return
            }
            handleDrop(
                new SpritesError(
                    'transient',
                    'execSpriteStream closed without exit code'
                ),
                true
            )
        })
    }

    // Client-initiated terminations must explicitly kill the remote process,
    // because closing the socket does not stop it. With
    // maxRunAfterDisconnectSeconds it survives the whole detach window, and
    // without the option it survives indefinitely — Seen on prod [2026-09-03]:
    // two `cat` sessions left by a cancelled upload were still `is_active`
    // three days later, which pinned the sprite `running` and billed active
    // hours the entire time. So this is NOT gated on the detach option.
    // Transient failures (liveness, transport error, server close) still never
    // kill — surviving those is what reattach and the detach window are for,
    // and the API-side session reaper is the backstop for what they orphan.
    const bestEffortKill = (reason: string): void => {
        if (typeof exitCode === 'number') return
        if (!sessionId) {
            // session_info not received yet, so there is nothing addressable to
            // kill; the reaper collects it if the process outlives us
            logger.warn('sprites.exec.kill.skipped', { spriteName, reason })
            return
        }
        void client
            .killExecSession(spriteName, sessionId)
            .catch((err: unknown) =>
                logger.warn('sprites.exec.kill.failed', {
                    spriteName,
                    sessionId,
                    reason,
                    failureClass: errorClass(err)
                })
            )
    }

    // Kill, close, settle — in that order, for every termination this client
    // decides on itself (timeout, abort, a stdin pump that failed mid-body).
    // A path that only settles orphans the remote process: that is exactly how
    // the leaked `cat` sessions above got there, since the stdin error handler
    // used to be settleFail on its own.
    const failClientSide = (reason: string, err: Error): void => {
        if (settled) return
        bestEffortKill(reason)
        try {
            currentWs.close(1000, reason)
        } catch {}
        settleFail(err)
    }

    const abort = (): void => {
        failClientSide(
            'abort',
            new SpritesError('transient', 'execSpriteStream aborted')
        )
    }

    const detach = (): void => {
        if (settled) return
        // Settle BEFORE closing so the onclose handler can never schedule a
        // reattach (canReattach requires !settled). No kill: the process keeps
        // running detached exactly as if the client connection dropped.
        settleFail(new SpritesError('transient', 'execSpriteStream detached'))
        try {
            currentWs.close(1000, 'detach')
        } catch {}
    }

    openSocket(params.mode === 'attach')

    return {
        stdout: stdoutQueue,
        stderr: stderrQueue,
        result,
        abort,
        detach
    }
}

const errorClass = (err: unknown): string =>
    err instanceof SpritesError
        ? `SpritesError:${err.code}`
        : err instanceof Error && err.name
          ? err.name
          : typeof err

export const execSpriteStream = (
    client: SpritesClient,
    spriteName: string,
    opts: ExecOptions,
    logger: SpritesLogger = silentLogger
): ExecStreamHandle => {
    if (!opts.cmd?.length)
        throw new Error('execSpriteStream requires a non-empty cmd array')
    return runExecStream(
        client,
        spriteName,
        {
            mode: 'fresh',
            freshUrl: buildExecUrl(client.wsBaseUrl, spriteName, opts),
            timeoutMs: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
            keepAliveMs: opts.keepAliveMs,
            livenessTimeoutMs: opts.livenessTimeoutMs,
            binary: opts.binary === true,
            tailCapture: opts.capture === 'tail',
            tty: opts.tty === true,
            cols: opts.cols,
            rows: opts.rows,
            reattachEnabled: opts.reattach !== undefined && opts.tty !== true,
            maxReattachAttempts:
                opts.reattach?.maxAttempts ?? DEFAULT_REATTACH_ATTEMPTS,
            initialConnectRetryEnabled: opts.initialConnectRetry !== undefined,
            maxInitialConnectAttempts:
                opts.initialConnectRetry?.maxAttempts ??
                DEFAULT_INITIAL_CONNECT_ATTEMPTS,
            skipReplayBytes: 0,
            stdinEofSent: false,
            onSessionId: opts.onSessionId,
            startStdin: (ws, onError, onEofSent) =>
                void pumpStdin(ws, opts, onError, onEofSent)
        },
        logger
    )
}

interface AsyncQueuePressure<T> {
    highWaterBytes?: number
    lowWaterBytes?: number
    sizeOf?: (value: T) => number
    onHigh?: () => void
    onLow?: () => void
}

class AsyncQueue<T> implements AsyncIterable<T> {
    private readonly items: T[] = []
    private readonly waiters: Array<{
        resolve: (v: IteratorResult<T>) => void
        reject: (e: Error) => void
    }> = []
    private ended = false
    private error: Error | null = null
    private queuedBytes = 0
    private overHigh = false

    constructor(private readonly pressure: AsyncQueuePressure<T> = {}) {}

    push(value: T): void {
        if (this.ended) return
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve({ value, done: false })
        else {
            this.items.push(value)
            this.noteQueued(value)
        }
    }

    end(): void {
        if (this.ended) return
        this.ended = true
        while (this.waiters.length)
            this.waiters
                .shift()!
                .resolve({ value: undefined as never, done: true })
    }

    fail(err: Error): void {
        if (this.ended) return
        this.ended = true
        this.error = err
        while (this.waiters.length) this.waiters.shift()!.reject(err)
    }

    private noteQueued(value: T): void {
        const { sizeOf, highWaterBytes, onHigh } = this.pressure
        if (!sizeOf || highWaterBytes === undefined) return
        this.queuedBytes += sizeOf(value)
        if (!this.overHigh && this.queuedBytes >= highWaterBytes) {
            this.overHigh = true
            onHigh?.()
        }
    }

    private noteDequeued(value: T): void {
        const { sizeOf, highWaterBytes, lowWaterBytes, onLow } = this.pressure
        if (!sizeOf || highWaterBytes === undefined) return
        this.queuedBytes = Math.max(0, this.queuedBytes - sizeOf(value))
        if (this.overHigh && this.queuedBytes <= (lowWaterBytes ?? 0)) {
            this.overHigh = false
            onLow?.()
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: (): Promise<IteratorResult<T>> => {
                if (this.items.length) {
                    const value = this.items.shift()!
                    this.noteDequeued(value)
                    return Promise.resolve({ value, done: false })
                }
                if (this.error) return Promise.reject(this.error)
                if (this.ended)
                    return Promise.resolve({
                        value: undefined as never,
                        done: true
                    })
                return new Promise<IteratorResult<T>>((resolve, reject) => {
                    this.waiters.push({ resolve, reject })
                })
            }
        }
    }
}

const buildExecUrl = (
    wsBaseUrl: string,
    spriteName: string,
    opts: ExecOptions
): string => {
    const params = new URLSearchParams()
    const [path, ...args] = opts.cmd
    params.append('path', path)
    for (const arg of opts.cmd) params.append('cmd', arg)
    void args
    if (opts.env) {
        for (const [k, v] of Object.entries(opts.env))
            params.append('env', `${k}=${v}`)
    }
    if (opts.dir) params.append('dir', opts.dir)
    if (opts.tty) {
        params.append('tty', 'true')
        if (opts.rows) params.append('rows', String(opts.rows))
        if (opts.cols) params.append('cols', String(opts.cols))
    }
    if (
        typeof opts.maxRunAfterDisconnectSeconds === 'number' &&
        Number.isFinite(opts.maxRunAfterDisconnectSeconds) &&
        opts.maxRunAfterDisconnectSeconds > 0
    )
        params.append(
            'max_run_after_disconnect',
            `${Math.ceil(opts.maxRunAfterDisconnectSeconds)}s`
        )
    params.append('stdin', 'true')
    return `${wsBaseUrl}/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`
}

const STDIN_CHUNK_BYTES = 32 * 1024

const encodeStdinPayload = (payload: Buffer): Buffer => {
    const frame = Buffer.allocUnsafe(payload.length + 1)
    frame[0] = 0x00
    payload.copy(frame, 1)
    return frame
}

const sendAwait = (ws: WebSocket, data: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        ws.send(data, (err?: Error) => {
            if (err) reject(err)
            else resolve()
        })
    })

const pumpStdin = async (
    ws: WebSocket,
    opts: ExecOptions,
    onError: (err: Error) => void,
    // Reconnect eligibility: a drop before stdin fully reached the process is
    // not resumable (an attach cannot resend it), so the caller only allows
    // reattach once the EOF marker went out.
    onEofSent?: () => void
): Promise<void> => {
    const stdin = opts.stdin
    try {
        if (stdin === undefined || stdin === null) {
            if (!opts.tty) {
                await sendAwait(ws, Buffer.from([0x04]))
                onEofSent?.()
            }
            return
        }
        if (typeof stdin === 'string') {
            if (opts.tty) {
                if (stdin.length > 0)
                    await sendAwait(ws, Buffer.from(stdin, 'utf8'))
                return
            }
            const buf = Buffer.from(stdin, 'utf8')
            for (let off = 0; off < buf.length; off += STDIN_CHUNK_BYTES) {
                const slice = buf.subarray(off, off + STDIN_CHUNK_BYTES)
                await sendAwait(ws, encodeStdinPayload(slice))
            }
            await sendAwait(ws, Buffer.from([0x04]))
            onEofSent?.()
            return
        }
        if (Buffer.isBuffer(stdin)) {
            if (opts.tty) {
                if (stdin.length > 0) await sendAwait(ws, stdin)
                return
            }
            for (let off = 0; off < stdin.length; off += STDIN_CHUNK_BYTES) {
                const slice = stdin.subarray(off, off + STDIN_CHUNK_BYTES)
                await sendAwait(ws, encodeStdinPayload(slice))
            }
            await sendAwait(ws, Buffer.from([0x04]))
            onEofSent?.()
            return
        }
        for await (const chunk of stdin) {
            if (!Buffer.isBuffer(chunk)) continue
            if (opts.tty) {
                if (chunk.length > 0) await sendAwait(ws, chunk)
                continue
            }
            for (let off = 0; off < chunk.length; off += STDIN_CHUNK_BYTES) {
                const slice = chunk.subarray(off, off + STDIN_CHUNK_BYTES)
                await sendAwait(ws, encodeStdinPayload(slice))
            }
        }
        if (!opts.tty) {
            await sendAwait(ws, Buffer.from([0x04]))
            onEofSent?.()
        }
    } catch (err) {
        onError(
            err instanceof Error
                ? err
                : new Error(`stdin pump failed: ${String(err)}`)
        )
    }
}
