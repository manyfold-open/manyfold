import { Logger } from '@nestjs/common'
import type {
    ExecStreamResult,
    InteractiveExecHandle
} from './exec-driver'

export type AcpEvent =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | {
          type: 'tool_call'
          toolCallId: string
          toolName: string
          input: Record<string, unknown> | null
      }
    | {
          type: 'usage_update'
          usage: Record<string, unknown>
      }
    | { type: 'turn_end'; usage: Record<string, unknown> | null }
    // `message` is the fatal line for display; `detail` adds the stderr tail
    // for classifiers that need context the single line may not carry (the
    // managed 503 body can print on a different line than the Aborting
    // marker).
    | { type: 'error'; message: string; detail?: string }

interface PendingRequest {
    resolve: (result: unknown) => void
    reject: (err: Error) => void
    method: string
    // Rearms the inactivity budget. Called for every frame the child produces.
    touch: () => void
}

// #556: `session/prompt` is a LONG-LIVED request — it streams the whole answer
// as session/update notifications and only resolves at the end. A single
// response deadline over it is a wall-clock cap on the turn, not a hang
// detector, so a turn that was still emitting was truncated. Splitting it lets
// silence and total duration fail for their own reasons.
export interface AcpRequestTimeouts {
    idleTimeoutMs: number
    maxDurationMs: number
}

// A bare number keeps meaning "one budget for both", which is right for the
// short handshake calls where nothing streams.
const asTimeouts = (
    timeouts: number | AcpRequestTimeouts
): AcpRequestTimeouts =>
    typeof timeouts === 'number'
        ? { idleTimeoutMs: timeouts, maxDurationMs: timeouts }
        : timeouts

interface JsonRpcResponse {
    jsonrpc: '2.0'
    id: number | string
    result?: unknown
    error?: { code?: number; message?: string; data?: unknown }
}

export interface JsonRpcNotification {
    jsonrpc: '2.0'
    method: string
    params?: Record<string, unknown>
}

interface JsonRpcAgentRequest {
    jsonrpc: '2.0'
    id: number | string
    method: string
    params?: Record<string, unknown>
}

const PROTOCOL_VERSION = 1
const ACP_DEFAULT_CMD = ['hermes', 'acp', '--accept-hooks']
export const HERMES_ACP_CMD = ACP_DEFAULT_CMD

// The notification -> chat-event mapping, exported so a REPLAY of a buffered
// ACP stream is decoded by exactly this code rather than a second copy that can
// drift. A resumed turn must produce the same events the live turn did, or
// recovery quietly changes the answer.
export const acpEventsFromNotification = (
    note: JsonRpcNotification
): AcpEvent[] => {
    if (
        note.method !== 'session/update' &&
        note.method !== 'session/notification'
    )
        return []
    const params = note.params ?? {}
    const updateRaw = params['update']
    if (!updateRaw || typeof updateRaw !== 'object') return []
    const { kind, data } = normalizeUpdate(updateRaw as Record<string, unknown>)
    if (!kind) return []
    switch (kind) {
        case 'agent_message_chunk': {
            const text = extractContentText(data)
            return text ? [{ type: 'text', text }] : []
        }
        case 'agent_thought_chunk': {
            const text = extractContentText(data)
            return text ? [{ type: 'thinking', text }] : []
        }
        case 'tool_call': {
            const toolCallId = String(data['toolCallId'] ?? '')
            if (!toolCallId) return []
            return [
                {
                    type: 'tool_call',
                    toolCallId,
                    toolName: String(data['name'] ?? data['title'] ?? 'tool'),
                    input: (data['rawInput'] ??
                        data['input'] ??
                        data['parameters'] ??
                        null) as Record<string, unknown> | null
                }
            ]
        }
        case 'usage_update':
            return [{ type: 'usage_update', usage: data }]
        case 'turn_end':
            return [
                {
                    type: 'turn_end',
                    usage:
                        (data['usage'] as Record<string, unknown> | undefined) ??
                        null
                }
            ]
        default:
            return []
    }
}


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
    private stdoutBuffer = ''
    private stderrTail: string[] = []
    private nextId = 1
    private sessionId: string | null = null
    private closed = false
    private exitError: Error | null = null

    constructor(opts: {
        transport: InteractiveExecHandle
        onEvent: (ev: AcpEvent) => void
        logger?: Logger
        closeGraceMs?: number
    }) {
        this.transport = opts.transport
        this.onEvent = opts.onEvent
        this.log = opts.logger ?? new Logger(HermesAcpTurn.name)
        this.closeGraceMs = opts.closeGraceMs ?? 5_000
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
                    optionId: 'approve_for_session'
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
        return resolvedId
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
        this.transport.abort()
        if (this.closed) return
        this.closed = true
        for (const [, p] of this.pending)
            p.reject(new Error('hermes acp turn aborted'))
        this.pending.clear()
    }
}

const normalizeUpdate = (
    update: Record<string, unknown>
): { kind: string; data: Record<string, unknown> } => {
    const sessionUpdate = update['sessionUpdate']
    if (typeof sessionUpdate === 'string')
        return { kind: normalizeUpdateKind(sessionUpdate), data: update }
    const typ = update['type']
    if (typeof typ === 'string')
        return { kind: normalizeUpdateKind(typ), data: update }
    const keys = Object.keys(update)
    if (keys.length === 1) {
        const k = keys[0]
        const v = update[k]
        return {
            kind: normalizeUpdateKind(k),
            data: (typeof v === 'object' && v && !Array.isArray(v)
                ? (v as Record<string, unknown>)
                : {}) as Record<string, unknown>
        }
    }
    return { kind: '', data: update }
}

const normalizeUpdateKind = (raw: string): string => {
    const key = raw
        .trim()
        .replace(/[_-]/g, '')
        .toLowerCase()
    switch (key) {
        case 'agentmessagechunk':
            return 'agent_message_chunk'
        case 'agentthoughtchunk':
            return 'agent_thought_chunk'
        case 'toolcall':
            return 'tool_call'
        case 'toolcallupdate':
            return 'tool_call_update'
        case 'usageupdate':
            return 'usage_update'
        case 'turnend':
        case 'endturn':
            return 'turn_end'
        default:
            return ''
    }
}

const extractContentText = (data: Record<string, unknown>): string => {
    const content = data['content']
    if (!content || typeof content !== 'object') return ''
    const c = content as Record<string, unknown>
    const text = c['text']
    return typeof text === 'string' ? text : ''
}

// Find the most informative stderr line — hermes writes a mix of "✓ booted"
// progress lines and the actual API/HTTP/auth error. Skip noise and prefer
// lines that mention an error class or HTTP status.
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

// Lines that mean "the prompt will never complete normally". `Aborting`
// covers hermes's own decision to give up on retries; HTTP 4xx and the
// Non-retryable banner cover provider-side denials. We intentionally do NOT
// fire on transient warnings (attempt 1/3) so hermes's retry loop still gets
// a chance.
const FATAL_STDERR_PATTERNS = [
    /\bAborting\b/i,
    /Non-retryable.*error/i
]
const isFatalStderrLine = (line: string): boolean =>
    FATAL_STDERR_PATTERNS.some((re) => re.test(line))
