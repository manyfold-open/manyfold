import { Logger } from '@nestjs/common'
import type { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'

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
    | { type: 'error'; message: string }

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

export class HermesAcpClient {
    private readonly log: Logger
    private readonly registry: DaemonRegistryService
    private readonly daemonId: string
    private readonly onEvent: (ev: AcpEvent) => void
    private readonly pending = new Map<number, PendingRequest>()
    private execRefId: string | null = null
    private execResult: Promise<Record<string, unknown> | undefined> | null =
        null
    private execCancel: (() => void) | null = null
    private stdoutBuffer = ''
    private stderrTail: string[] = []
    private nextId = 1
    private sessionId: string | null = null
    private closed = false
    private exitError: Error | null = null

    constructor(opts: { registry: DaemonRegistryService; daemonId: string; onEvent: (ev: AcpEvent) => void; logger?: Logger }) {
        this.registry = opts.registry
        this.daemonId = opts.daemonId
        this.onEvent = opts.onEvent
        this.log = opts.logger ?? new Logger(HermesAcpClient.name)
    }

    get currentSessionId(): string | null {
        return this.sessionId
    }

    async start(opts: {
        cmd?: string[]
        env?: Record<string, string>
        cwd?: string
        timeoutMs: number
        refIdOverride?: string
    }): Promise<void> {
        const cmd = opts.cmd ?? ACP_DEFAULT_CMD
        const env: Record<string, string> = {
            HERMES_YOLO_MODE: '1',
            ...(opts.env ?? {})
        }
        const payload: Record<string, unknown> = {
            cmd,
            env,
            keepStdinOpen: true,
            timeoutMs: opts.timeoutMs
        }
        if (opts.cwd) payload.dir = opts.cwd
        const stream = this.registry.streamRpc({
            daemonId: this.daemonId,
            method: 'exec.start',
            payload,
            timeoutMs: opts.timeoutMs + 10_000,
            onEvent: (kind, data) => {
                if (kind === 'stdout') this.ingestStdout(data)
                else if (kind === 'stderr') this.ingestStderr(data)
            },
            ...(opts.refIdOverride ? { refIdOverride: opts.refIdOverride } : {})
        })
        this.execRefId = stream.refId
        this.execResult = stream.result
        this.execCancel = stream.cancel
        // If the child exits while we're still mid-conversation, the JSON-RPC
        // pending requests will never get a response. Surface that as a hard
        // failure on every pending request (with the stderr tail) so callers
        // see why `session/prompt` didn't return instead of timing out.
        stream.result
            .then((ack) => this.handleExecExit(ack))
            .catch((err) => this.handleExecExit(undefined, err))
    }

    private ingestStderr(chunk: string): void {
        const trimmed = chunk.trim()
        if (!trimmed) return
        // Counts as activity too: a long silent tool call may produce nothing on
        // stdout while hermes still logs progress here. A chatty-but-wedged
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
                this.onEvent({ type: 'error', message: line })
                for (const [, p] of this.pending) p.reject(this.exitError)
                this.pending.clear()
            }
        }
    }

    private handleExecExit(
        ack: Record<string, unknown> | undefined,
        err?: Error
    ): void {
        if (this.closed) return
        const exitCode =
            typeof ack?.exitCode === 'number' ? ack.exitCode : null
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

    // Every frame the child produces is proof the turn is alive — session/update
    // notifications ARE the answer streaming in. Rearming here is what turns the
    // pending request's budget into an INACTIVITY budget instead of a deadline.
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
            void this.handleAgentRequest(
                frame as unknown as JsonRpcAgentRequest
            )
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
            const msg =
                resp.error.message ?? `hermes ${pending.method} failed`
            pending.reject(new Error(msg))
            return
        }
        pending.resolve(resp.result)
    }

    private handleNotification(note: JsonRpcNotification): void {
        for (const ev of acpEventsFromNotification(note)) this.onEvent(ev)
    }

    private async handleAgentRequest(
        req: JsonRpcAgentRequest
    ): Promise<void> {
        // Headless daemon — auto-approve permission asks; reply
        // method-not-found for anything else so the agent doesn't block.
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
        await this.writeLine(JSON.stringify(response)).catch((err) =>
            this.log.warn(
                `reply to agent request ${req.method} failed: ${(err as Error).message}`
            )
        )
    }

    private async writeLine(line: string): Promise<void> {
        if (!this.execRefId) throw new Error('hermes acp child not started')
        const data = Buffer.from(`${line}\n`, 'utf8').toString('base64')
        const res = await this.registry.rpc({
            daemonId: this.daemonId,
            method: 'exec.input',
            payload: {
                refId: this.execRefId,
                data,
                encoding: 'base64'
            },
            timeoutMs: 10_000
        })
        if (res && typeof res === 'object' && 'error' in res && res.error)
            throw new Error(String(res.error))
    }

    async request<T = unknown>(
        method: string,
        params: Record<string, unknown>,
        timeouts: number | AcpRequestTimeouts
    ): Promise<T> {
        if (this.closed)
            throw new Error('hermes acp client already closed')
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
        try {
            await this.writeLine(frame)
        } catch (err) {
            // #561: route the write error through the entry's reject — it
            // clears both timers and settles the SAME promise we return.
            // Deleting the map entry alone left the timers armed against a
            // promise request() never returned, and their late reject became
            // an unhandledRejection that main.ts escalates to a fatal exit.
            // A missing entry means the promise already settled (child exit,
            // fatal stderr or abort raced the write), so returning it still
            // surfaces that original failure instead of a second bare one.
            const entry = this.pending.get(id)
            this.pending.delete(id)
            entry?.reject(err as Error)
        }
        return promise
    }

    async initialize(timeoutMs: number): Promise<Record<string, unknown>> {
        const result = await this.request<Record<string, unknown>>(
            'initialize',
            {
                protocolVersion: PROTOCOL_VERSION,
                clientInfo: {
                    name: 'manyfold-daemon-adapter',
                    version: '0.1.0'
                },
                clientCapabilities: {}
            },
            timeoutMs
        )
        return result
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
        if (this.execRefId) {
            await this.registry
                .rpc({
                    daemonId: this.daemonId,
                    method: 'exec.eof',
                    payload: { refId: this.execRefId },
                    timeoutMs: 5_000
                })
                .catch(() => {})
        }
        if (this.execResult) {
            await this.execResult.catch(() => {})
        }
        for (const [, p] of this.pending)
            p.reject(new Error('hermes acp client closed'))
        this.pending.clear()
    }

    abort(): void {
        if (this.execCancel) {
            try {
                this.execCancel()
            } catch {}
        }
        for (const [, p] of this.pending)
            p.reject(new Error('hermes acp client aborted'))
        this.pending.clear()
        this.closed = true
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
