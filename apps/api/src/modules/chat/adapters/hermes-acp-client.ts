import { Logger } from '@nestjs/common'
import {
    acpEventsFromNotification,
    asTimeouts,
    decodeAcpSessionState,
    decodePermissionRequest,
    isFatalStderrLine,
    pickAutoApproveOptionId,
    pickRejectOptionId,
    pickStderrErrorLine,
    ACP_PROTOCOL_VERSION
} from '@manyfold/shared'
import type {
    AcpEvent,
    AcpRequestTimeouts,
    AcpSessionState,
    JsonRpcNotification
} from '@manyfold/shared'
import type {
    ExecStreamResult,
    InteractiveExecHandle
} from './exec-driver'

// Re-exported so hermes.adapter and the ACP tests keep importing them from
// here (the pure decoders moved to @manyfold/shared).
export type {
    AcpEvent,
    AcpRequestTimeouts,
    AcpSessionState
} from '@manyfold/shared'
export {
    acpEventsFromFrame,
    acpEventsFromNotification,
    acpModelMatches
} from '@manyfold/shared'

interface PendingRequest {
    resolve: (result: unknown) => void
    reject: (err: Error) => void
    method: string
    // Rearms the inactivity budget. Called for every frame the child produces.
    touch: () => void
}

interface JsonRpcResponse {
    jsonrpc: '2.0'
    id: number | string
    result?: unknown
    error?: { code?: number; message?: string; data?: unknown }
}

interface JsonRpcAgentRequest {
    jsonrpc: '2.0'
    id: number | string
    method: string
    params?: Record<string, unknown>
}

const PROTOCOL_VERSION = ACP_PROTOCOL_VERSION
const ACP_DEFAULT_CMD = ['hermes', 'acp', '--accept-hooks']
export const HERMES_ACP_CMD = ACP_DEFAULT_CMD

// hermes predates the request-carried options array, so its headless
// auto-approve keeps the legacy id for builds that advertise none.
const HERMES_LEGACY_AUTO_APPROVE_OPTION_ID = 'approve_for_session'

// The same ACP JSON-RPC core over any InteractiveExecHandle (sprite exec,
// pod exec). The daemon runtime keeps its client inside the CLI
// (turn.start/acp-turn.ts) so the turn survives an API restart; this class is
// the API-side client for runtimes where no daemon can own the turn — those
// turns are non-resumable by construction, exactly like the transport.
export class HermesAcpTurn {
    private readonly log: Logger
    private readonly transport: InteractiveExecHandle
    private readonly onEvent: (ev: AcpEvent) => void
    private readonly pending = new Map<number, PendingRequest>()
    private readonly closeGraceMs: number
    private readonly permissionPolicy: 'auto' | 'interactive'
    private readonly permissionTimeoutMs: number
    private readonly permissionKeepAliveMs: number
    // Asks forwarded to the user and not yet answered, keyed by the agent's
    // own JSON-RPC id (stringified — it is the requestId on the wire).
    private readonly pendingPermissions = new Map<
        string,
        {
            id: number | string
            options: Array<{ optionId: string; name: string; kind: string }>
            timer: NodeJS.Timeout | null
        }
    >()
    // While a human is deciding, the child is silent BY DESIGN — the idle
    // budget must not read that as a hang (240s default vs minutes of human
    // latency), so the pending asks tick the budget themselves.
    private permissionKeepAlive: NodeJS.Timeout | null = null
    private stdoutBuffer = ''
    private stderrTail: string[] = []
    private nextId = 1
    private sessionId: string | null = null
    private lastSessionState: AcpSessionState | null = null
    private closed = false
    private exitError: Error | null = null

    constructor(opts: {
        transport: InteractiveExecHandle
        onEvent: (ev: AcpEvent) => void
        logger?: Logger
        closeGraceMs?: number
        permissionPolicy?: 'auto' | 'interactive'
        permissionTimeoutMs?: number
        permissionKeepAliveMs?: number
    }) {
        this.transport = opts.transport
        this.onEvent = opts.onEvent
        this.log = opts.logger ?? new Logger(HermesAcpTurn.name)
        this.closeGraceMs = opts.closeGraceMs ?? 5_000
        this.permissionPolicy = opts.permissionPolicy ?? 'auto'
        this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 300_000
        this.permissionKeepAliveMs = opts.permissionKeepAliveMs ?? 15_000
        void this.pumpStdout()
        void this.pumpStderr()
        // #561's lesson, moved to the transport boundary: ANY transport
        // failure must settle every pending request through its reject (which
        // clears both timers), never leave a timer armed against a promise
        // nobody holds.
        this.transport.result
            .then((r) => this.handleExecExit(r))
            .catch((err: unknown) =>
                this.handleExecExit(undefined, err as Error)
            )
    }

    get currentSessionId(): string | null {
        return this.sessionId
    }

    // The models/modes state from the last session/new|resume response, or
    // null on hermes builds that predate it.
    get sessionState(): AcpSessionState | null {
        return this.lastSessionState
    }

    private async pumpStdout(): Promise<void> {
        try {
            for await (const chunk of this.transport.stdout)
                this.ingestStdout(chunk)
        } catch {
            // transport.result carries the failure
        }
    }

    private async pumpStderr(): Promise<void> {
        try {
            for await (const chunk of this.transport.stderr)
                this.ingestStderr(chunk)
        } catch {
            // transport.result carries the failure
        }
    }

    private ingestStderr(chunk: string): void {
        const trimmed = chunk.trim()
        if (!trimmed) return
        // Counts as activity too: a long silent tool call may produce nothing
        // on stdout while hermes still logs progress here. A chatty-but-wedged
        // child is caught by the max-duration budget instead.
        this.touchPending()
        this.log.debug(`[hermes:stderr] ${trimmed}`)
        for (const rawLine of trimmed.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line) continue
            this.stderrTail.push(line)
            if (this.stderrTail.length > 80) this.stderrTail.shift()
            // Hermes does NOT exit on LLM auth/4xx errors — it stays in ACP
            // mode and never sends a session/prompt response, so our await
            // would hang for the full prompt timeout. Surface fatal stderr
            // lines as an inline error event so the UI sees the real reason
            // immediately, and reject pending RPCs so the adapter stops
            // waiting.
            if (!this.exitError && isFatalStderrLine(line)) {
                const tail = this.stderrTail.slice(-12).join('\n').trim()
                const detail = tail
                    ? `${line}\n--- hermes stderr (tail) ---\n${tail}`
                    : line
                this.exitError = new Error(detail)
                this.onEvent({ type: 'error', message: line, detail })
                for (const [, p] of this.pending) p.reject(this.exitError)
                this.pending.clear()
            }
        }
    }

    private handleExecExit(
        result: ExecStreamResult | undefined,
        err?: Error
    ): void {
        if (this.closed) return
        const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null
        const tail = this.stderrTail.slice(-12).join('\n').trim()
        const summary = pickStderrErrorLine(this.stderrTail)
        const reason =
            err?.message ??
            summary ??
            (exitCode !== null
                ? `hermes acp exited with code ${exitCode}`
                : 'hermes acp exited unexpectedly')
        const detail = tail
            ? `${reason}\n--- hermes stderr (tail) ---\n${tail}`
            : reason
        this.exitError = new Error(detail)
        for (const [, p] of this.pending) p.reject(this.exitError)
        this.pending.clear()
    }

    private ingestStdout(chunk: string): void {
        this.stdoutBuffer += chunk
        let nl = this.stdoutBuffer.indexOf('\n')
        while (nl !== -1) {
            const line = this.stdoutBuffer.slice(0, nl).trim()
            this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1)
            if (line) this.handleLine(line)
            nl = this.stdoutBuffer.indexOf('\n')
        }
    }

    // Every frame the child produces is proof the turn is alive —
    // session/update notifications ARE the answer streaming in. Rearming here
    // is what turns the pending request's budget into an INACTIVITY budget
    // instead of a deadline.
    private touchPending(): void {
        for (const [, p] of this.pending) p.touch()
    }

    private handleLine(line: string): void {
        let frame: Record<string, unknown>
        try {
            frame = JSON.parse(line) as Record<string, unknown>
        } catch {
            return
        }
        this.touchPending()
        if ('id' in frame && ('result' in frame || 'error' in frame)) {
            this.handleResponse(frame as unknown as JsonRpcResponse)
            return
        }
        if ('id' in frame && 'method' in frame) {
            this.handleAgentRequest(frame as unknown as JsonRpcAgentRequest)
            return
        }
        if ('method' in frame) {
            this.handleNotification(frame as unknown as JsonRpcNotification)
        }
    }

    private handleResponse(resp: JsonRpcResponse): void {
        const id =
            typeof resp.id === 'string' ? Number(resp.id) : (resp.id as number)
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        if (resp.error) {
            const msg = resp.error.message ?? `hermes ${pending.method} failed`
            pending.reject(new Error(msg))
            return
        }
        pending.resolve(resp.result)
    }

    private handleNotification(note: JsonRpcNotification): void {
        for (const ev of acpEventsFromNotification(note)) this.onEvent(ev)
    }

    private handleAgentRequest(req: JsonRpcAgentRequest): void {
        if (
            req.method === 'session/request_permission' &&
            this.permissionPolicy === 'interactive'
        ) {
            const event = decodePermissionRequest(req.id, req.params)
            const key = event.requestId
            const timer = setTimeout(
                () => this.expirePermission(key),
                this.permissionTimeoutMs
            )
            this.pendingPermissions.set(key, {
                id: req.id,
                options: event.options,
                timer
            })
            if (!this.permissionKeepAlive) {
                this.permissionKeepAlive = setInterval(
                    () => this.touchPending(),
                    this.permissionKeepAliveMs
                )
                if (typeof this.permissionKeepAlive.unref === 'function')
                    this.permissionKeepAlive.unref()
            }
            this.onEvent(event)
            return
        }
        // Headless — auto-approve permission asks; reply method-not-found for
        // anything else so the agent doesn't block.
        const response: Record<string, unknown> = {
            jsonrpc: '2.0',
            id: req.id
        }
        if (req.method === 'session/request_permission') {
            response.result = {
                outcome: {
                    outcome: 'selected',
                    optionId: pickAutoApproveOptionId(
                        req.params,
                        HERMES_LEGACY_AUTO_APPROVE_OPTION_ID
                    )
                }
            }
        } else {
            response.error = {
                code: -32601,
                message: `method not found: ${req.method}`
            }
        }
        this.writeLine(JSON.stringify(response))
    }

    // Delivers the user's answer to a pending ask. 'unknown' = never seen,
    // already answered, or already expired — the caller turns that into 409.
    respondPermission(
        requestId: string,
        optionId: string
    ): 'delivered' | 'unknown' {
        const pending = this.pendingPermissions.get(requestId)
        if (!pending) return 'unknown'
        this.settlePermission(requestId, pending, {
            outcome: 'selected',
            optionId
        })
        return 'delivered'
    }

    get pendingPermissionIds(): string[] {
        return [...this.pendingPermissions.keys()]
    }

    private expirePermission(requestId: string): void {
        const pending = this.pendingPermissions.get(requestId)
        if (!pending) return
        const rejectId = pickRejectOptionId(pending.options)
        this.settlePermission(
            requestId,
            pending,
            rejectId
                ? { outcome: 'timeout', optionId: rejectId }
                : { outcome: 'timeout', optionId: null }
        )
    }

    private settlePermission(
        requestId: string,
        pending: {
            id: number | string
            options: Array<{ optionId: string; name: string; kind: string }>
            timer: NodeJS.Timeout | null
        },
        answer: {
            outcome: 'selected' | 'timeout' | 'cancelled'
            optionId: string | null
        }
    ): void {
        if (pending.timer) clearTimeout(pending.timer)
        this.pendingPermissions.delete(requestId)
        if (this.pendingPermissions.size === 0 && this.permissionKeepAlive) {
            clearInterval(this.permissionKeepAlive)
            this.permissionKeepAlive = null
        }
        this.writeLine(
            JSON.stringify({
                jsonrpc: '2.0',
                id: pending.id,
                result: {
                    outcome: answer.optionId
                        ? { outcome: 'selected', optionId: answer.optionId }
                        : { outcome: 'cancelled' }
                }
            })
        )
        this.onEvent({
            type: 'permission_resolution',
            requestId,
            outcome: answer.outcome,
            optionId: answer.optionId
        })
    }

    private cancelPendingPermissions(): void {
        for (const [requestId, pending] of [...this.pendingPermissions])
            this.settlePermission(requestId, pending, {
                outcome: 'cancelled',
                optionId: null
            })
    }

    // Enqueue-only: a dead transport surfaces via `result` rejecting, which
    // handleExecExit routes through every pending entry's reject. That is the
    // whole #561 contract with none of the per-write failure plumbing.
    private writeLine(line: string): void {
        this.transport.write(Buffer.from(`${line}\n`, 'utf8'))
    }

    async request<T = unknown>(
        method: string,
        params: Record<string, unknown>,
        timeouts: number | AcpRequestTimeouts
    ): Promise<T> {
        if (this.closed) throw new Error('hermes acp turn already closed')
        if (this.exitError) throw this.exitError
        const { idleTimeoutMs, maxDurationMs } = asTimeouts(timeouts)
        const id = this.nextId++
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
        const promise = new Promise<T>((resolve, reject) => {
            let idleTimer: NodeJS.Timeout | null = null
            let maxTimer: NodeJS.Timeout | null = null
            const clearTimers = (): void => {
                if (idleTimer) clearTimeout(idleTimer)
                if (maxTimer) clearTimeout(maxTimer)
            }
            const fail = (message: string): void => {
                clearTimers()
                this.pending.delete(id)
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
            }
            maxTimer = setTimeout(
                () =>
                    fail(
                        `hermes ${method} was still streaming when it hit its ${maxDurationMs}ms maximum duration`
                    ),
                maxDurationMs
            )
            armIdle()
            this.pending.set(id, {
                method,
                touch: armIdle,
                resolve: (v) => {
                    clearTimers()
                    resolve(v as T)
                },
                reject: (e) => {
                    clearTimers()
                    reject(e)
                }
            })
        })
        this.writeLine(frame)
        return promise
    }

    async initialize(timeoutMs: number): Promise<Record<string, unknown>> {
        return this.request<Record<string, unknown>>(
            'initialize',
            {
                protocolVersion: PROTOCOL_VERSION,
                clientInfo: {
                    name: 'manyfold-acp-adapter',
                    version: '0.1.0'
                },
                clientCapabilities: {}
            },
            timeoutMs
        )
    }

    async newSession(args: {
        cwd: string
        timeoutMs: number
    }): Promise<string> {
        const result = (await this.request<Record<string, unknown>>(
            'session/new',
            {
                cwd: args.cwd,
                mcpServers: []
            },
            args.timeoutMs
        )) as { sessionId?: string }
        const sid = result?.sessionId
        if (!sid || typeof sid !== 'string')
            throw new Error('hermes session/new returned no sessionId')
        this.sessionId = sid
        this.lastSessionState = decodeAcpSessionState(result)
        return sid
    }

    async resumeSession(args: {
        cwd: string
        sessionId: string
        timeoutMs: number
    }): Promise<string> {
        const result = (await this.request<Record<string, unknown>>(
            'session/resume',
            {
                cwd: args.cwd,
                sessionId: args.sessionId,
                mcpServers: []
            },
            args.timeoutMs
        )) as { sessionId?: string }
        const resolvedId =
            (typeof result?.sessionId === 'string' && result.sessionId) ||
            args.sessionId
        this.sessionId = resolvedId
        this.lastSessionState = decodeAcpSessionState(result)
        return resolvedId
    }

    // Switches the persisted session model. hermes accepts anything here and
    // fails at inference instead — the only real failures are -32601 (a build
    // that predates model switching) and transport death. Wrapped so the
    // method name survives into the error: hermes's own -32601 message does
    // not carry it, and the adapter classifies on it.
    async setModel(args: { modelId: string; timeoutMs: number }): Promise<void> {
        if (!this.sessionId)
            throw new Error('hermes session/set_model called without sessionId')
        try {
            await this.request('session/set_model', {
                sessionId: this.sessionId,
                modelId: args.modelId
            }, args.timeoutMs)
        } catch (err) {
            throw new Error(
                `hermes session/set_model failed: ${(err as Error).message}`
            )
        }
        if (this.lastSessionState)
            this.lastSessionState = {
                ...this.lastSessionState,
                currentModelId: args.modelId
            }
    }

    // Best-effort: an unknown mode id silently normalizes to `default`
    // upstream (which asks MORE, never less), and a -32601 build simply keeps
    // asking — so a failure here must never kill the turn.
    async setMode(args: { modeId: string; timeoutMs: number }): Promise<void> {
        if (!this.sessionId) return
        try {
            await this.request(
                'session/set_mode',
                { sessionId: this.sessionId, modeId: args.modeId },
                args.timeoutMs
            )
        } catch (err) {
            this.log.warn(
                `hermes session/set_mode ${args.modeId} failed: ${(err as Error).message}`
            )
        }
    }

    // The only streaming call, so it takes the split budgets rather than a
    // single number — the handshake calls above keep their short fixed one.
    async prompt(args: {
        prompt: string
        timeouts: AcpRequestTimeouts
    }): Promise<Record<string, unknown> | undefined> {
        if (!this.sessionId)
            throw new Error('hermes session/prompt called without sessionId')
        return this.request<Record<string, unknown>>(
            'session/prompt',
            {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text: args.prompt }]
            },
            args.timeouts
        )
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        // Answer open asks as cancelled BEFORE the EOF: a child blocked on an
        // unanswered ask would otherwise sit out the whole grace window.
        this.cancelPendingPermissions()
        this.transport.endInput()
        // A child that ignores stdin EOF must not park the caller (and its
        // terminal event) for the whole transport budget: give it a short
        // grace, then tear the transport down.
        let graceTimer: NodeJS.Timeout | null = null
        const settled = await Promise.race([
            this.transport.result.then(
                () => true,
                () => true
            ),
            new Promise<boolean>((resolve) => {
                graceTimer = setTimeout(
                    () => resolve(false),
                    this.closeGraceMs
                )
            })
        ])
        if (graceTimer) clearTimeout(graceTimer)
        if (!settled) {
            this.transport.abort()
            await this.transport.result.catch(() => {})
        }
        for (const [, p] of this.pending)
            p.reject(new Error('hermes acp turn closed'))
        this.pending.clear()
    }

    // Deliberately effective even after close(): a cancel that lands while
    // close() is inside its grace window must still reach the transport, or
    // the turn is uncancellable for the rest of the wait.
    abort(): void {
        this.cancelPendingPermissions()
        this.transport.abort()
        if (this.closed) return
        this.closed = true
        for (const [, p] of this.pending)
            p.reject(new Error('hermes acp turn aborted'))
        this.pending.clear()
    }
}