// The framework-neutral half of the ACP (Agent Client Protocol) client: the
// event union and the pure JSON-RPC decoders, with no I/O, no Logger and no
// transport. Both ACP clients import from here — the API-side one
// (apps/api .../hermes-acp-client.ts, which owns the InteractiveExecHandle) and
// the daemon-side one (apps/cli .../daemon/acp-turn.ts, which owns a
// ChildProcess plus the ExecStream durability contract) — so a live turn and a
// replayed turn are decoded by exactly one copy of this logic and cannot drift.

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
          type: 'tool_result'
          toolCallId: string
          status: 'completed' | 'failed'
          result: string | null
      }
    | {
          type: 'permission_request'
          requestId: string
          toolCallId: string | null
          title: string
          detail: string | null
          options: Array<{ optionId: string; name: string; kind: string }>
      }
    | {
          type: 'permission_resolution'
          requestId: string
          outcome: 'selected' | 'timeout' | 'cancelled'
          optionId: string | null
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
export const asTimeouts = (
    timeouts: number | AcpRequestTimeouts
): AcpRequestTimeouts =>
    typeof timeouts === 'number'
        ? { idleTimeoutMs: timeouts, maxDurationMs: timeouts }
        : timeouts

export interface JsonRpcNotification {
    jsonrpc: '2.0'
    method: string
    params?: Record<string, unknown>
}

export const ACP_PROTOCOL_VERSION = 1

// Pick the auto-approve answer from the request's OWN options. The previous
// hardcoded 'approve_for_session' matches no option id current hermes builds
// advertise, and an unknown id maps to DENY on both of its approval bridges —
// so the headless auto-approve was silently rejecting every file edit.
// Broadest grant first: with the ask suppressed, re-asking per call is noise.
// Seen on hermes-agent 0.20.6 [2026-08-29]: terminal-command asks offer
// allow_once / allow_session / allow_always / deny / deny_always; edit asks
// offer only allow_once / deny, and approval is the literal comparison
// option_id == "allow_once".
// The legacy fallback id is per-framework (hermes predates the options array
// with 'approve_for_session'; a framework that always advertises options wants
// null), so it is a parameter rather than a constant.
export const pickAutoApproveOptionId = (
    params: Record<string, unknown> | undefined,
    legacyFallbackOptionId: string | null = null
): string | null => {
    const options = params?.['options']
    if (Array.isArray(options)) {
        const rows = options.filter(
            (o): o is Record<string, unknown> => !!o && typeof o === 'object'
        )
        const byKind = (kind: string): string | null => {
            for (const o of rows) {
                if (o['kind'] === kind && typeof o['optionId'] === 'string')
                    return o['optionId']
            }
            return null
        }
        const allowAny = (): string | null => {
            for (const o of rows) {
                const kind = o['kind']
                if (
                    typeof kind === 'string' &&
                    kind.startsWith('allow') &&
                    typeof o['optionId'] === 'string'
                )
                    return o['optionId']
            }
            return null
        }
        const picked =
            byKind('allow_always') ?? byKind('allow_once') ?? allowAny()
        if (picked) return picked
    }
    // No parseable options: keep the caller's legacy id so builds that predate
    // the options array behave as before.
    return legacyFallbackOptionId
}

// The reject the deny-on-timeout (and cancel) paths answer with. Mirrors
// hermes's own timeout behavior: reject_once first, any reject second.
export const pickRejectOptionId = (
    options: Array<{ optionId: string; kind: string }>
): string | null => {
    const once = options.find((o) => o.kind === 'reject_once')
    if (once) return once.optionId
    const any = options.find((o) => o.kind.startsWith('reject'))
    return any?.optionId ?? null
}

// Rendering data for a session/request_permission ask, shared by the
// interactive client and the daemon-frame decoder so a replayed request
// renders exactly like the live one did.
// Seen on hermes-agent 0.20.6 [2026-08-29]: params carry {options[],
// toolCall:{toolCallId, title, kind, status, content:[{type:'diff', path,
// newText} | ...], rawInput:{tool|command, arguments}}}.
export const decodePermissionRequest = (
    requestId: string | number,
    params: Record<string, unknown> | undefined
): Extract<AcpEvent, { type: 'permission_request' }> => {
    const toolCall = (params?.['toolCall'] ?? {}) as Record<string, unknown>
    const options: Array<{ optionId: string; name: string; kind: string }> = []
    const rawOptions = params?.['options']
    if (Array.isArray(rawOptions)) {
        for (const item of rawOptions) {
            if (!item || typeof item !== 'object') continue
            const rec = item as Record<string, unknown>
            if (typeof rec['optionId'] !== 'string') continue
            options.push({
                optionId: rec['optionId'],
                name:
                    typeof rec['name'] === 'string'
                        ? rec['name']
                        : rec['optionId'],
                kind: typeof rec['kind'] === 'string' ? rec['kind'] : ''
            })
        }
    }
    const title =
        typeof toolCall['title'] === 'string' && toolCall['title']
            ? toolCall['title']
            : 'Permission requested'
    let detail: string | null = null
    const rawInput = toolCall['rawInput']
    if (rawInput && typeof rawInput === 'object') {
        const cmd = (rawInput as Record<string, unknown>)['command']
        if (typeof cmd === 'string' && cmd) detail = cmd
    }
    if (!detail) {
        const content = toolCall['content']
        if (Array.isArray(content)) {
            const paths = content
                .map((item) =>
                    item && typeof item === 'object'
                        ? (item as Record<string, unknown>)['path']
                        : null
                )
                .filter((p): p is string => typeof p === 'string' && !!p)
            if (paths.length > 0) detail = paths.join('\n')
        }
    }
    return {
        type: 'permission_request',
        requestId: String(requestId),
        toolCallId:
            typeof toolCall['toolCallId'] === 'string'
                ? toolCall['toolCallId']
                : null,
        title,
        detail,
        options
    }
}

// The daemon publishes its permission RESOLUTIONS into the exec buffer as
// synthetic notification lines under this method, so an exec.resume replay
// reproduces resolution state through exactly this decoder.
export const MANYFOLD_PERMISSION_RESOLUTION_METHOD =
    '_manyfold/permission_resolution'

// Superset decoder over raw JSON-RPC frames: session/update notifications,
// the agent's session/request_permission REQUESTS (which have an id and are
// invisible to acpEventsFromNotification), and the synthetic resolution
// notifications above. The daemon drains decode replayed streams with this,
// so live and recovered turns cannot diverge.
export const acpEventsFromFrame = (
    frame: Record<string, unknown>
): AcpEvent[] => {
    if (
        'id' in frame &&
        frame['method'] === 'session/request_permission' &&
        frame['id'] !== undefined &&
        frame['id'] !== null
    )
        return [
            decodePermissionRequest(
                frame['id'] as string | number,
                frame['params'] as Record<string, unknown> | undefined
            )
        ]
    if (frame['method'] === MANYFOLD_PERMISSION_RESOLUTION_METHOD) {
        const params = (frame['params'] ?? {}) as Record<string, unknown>
        const requestId = params['requestId']
        const outcome = params['outcome']
        if (typeof requestId !== 'string') return []
        return [
            {
                type: 'permission_resolution',
                requestId,
                outcome:
                    outcome === 'timeout' || outcome === 'cancelled'
                        ? outcome
                        : 'selected',
                optionId:
                    typeof params['optionId'] === 'string'
                        ? params['optionId']
                        : null
            }
        ]
    }
    if ('id' in frame && ('result' in frame || 'error' in frame)) return []
    return acpEventsFromNotification(frame as unknown as JsonRpcNotification)
}

// Session state an ACP agent attaches to its session/new|load|resume
// responses: for hermes, model ids are `provider:model` in its own provider
// naming, mode ids are its edit-approval policies (default / accept_edits /
// dont_ask).
export interface AcpSessionState {
    currentModelId: string | null
    modelIds: string[]
    currentModeId: string | null
    modeIds: string[]
}

export const decodeAcpSessionState = (
    result: Record<string, unknown> | undefined
): AcpSessionState | null => {
    if (!result) return null
    const models = result['models']
    const modes = result['modes']
    const state: AcpSessionState = {
        currentModelId: null,
        modelIds: [],
        currentModeId: null,
        modeIds: []
    }
    let any = false
    if (models && typeof models === 'object') {
        const m = models as Record<string, unknown>
        if (typeof m['currentModelId'] === 'string') {
            state.currentModelId = m['currentModelId']
            any = true
        }
        const available = m['availableModels']
        if (Array.isArray(available)) {
            for (const item of available) {
                const id = (item as Record<string, unknown> | null)?.['modelId']
                if (typeof id === 'string' && id) state.modelIds.push(id)
            }
            any = true
        }
    }
    if (modes && typeof modes === 'object') {
        const m = modes as Record<string, unknown>
        if (typeof m['currentModeId'] === 'string') {
            state.currentModeId = m['currentModeId']
            any = true
        }
        const available = m['availableModes']
        if (Array.isArray(available)) {
            for (const item of available) {
                const id = (item as Record<string, unknown> | null)?.['id']
                if (typeof id === 'string' && id) state.modeIds.push(id)
            }
            any = true
        }
    }
    return any ? state : null
}

// `provider:model` vs a bare model id. endsWith rather than a prefix strip:
// model ids themselves can contain colons (ollama tags), so splitting on the
// first colon would mangle them.
export const acpModelMatches = (
    currentModelId: string | null,
    bareModel: string
): boolean =>
    currentModelId !== null &&
    (currentModelId === bareModel ||
        currentModelId.endsWith(`:${bareModel}`))

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
        case 'tool_call_update': {
            const toolCallId = String(data['toolCallId'] ?? '')
            const status = String(data['status'] ?? '')
            // Only terminal statuses become tool results; pending/in_progress
            // progress frames carry no outcome yet.
            if (!toolCallId || (status !== 'completed' && status !== 'failed'))
                return []
            return [
                {
                    type: 'tool_result',
                    toolCallId,
                    status,
                    result: extractToolResultText(data)
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

// A tool_call_update carries its outcome twice: `rawOutput` (the verbatim
// tool result, omitted for tools hermes renders itself) and `content[]`
// blocks. Prefer rawOutput; fall back to the blocks' text. Diff blocks (file
// edits) reduce to the touched path — the new file body is already in the
// tool_call's input.
// Measured on hermes-agent 0.20.6 [2026-08-29]: content items are
// {type:'content', content:{type:'text', text}} and {type:'diff', path,
// newText}; rawOutput is a plain string when present.
const extractToolResultText = (
    data: Record<string, unknown>
): string | null => {
    const raw = data['rawOutput']
    if (typeof raw === 'string' && raw.length > 0) return raw
    const content = data['content']
    if (!Array.isArray(content)) return null
    const parts: string[] = []
    for (const item of content) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        if (rec['type'] === 'content') {
            const inner = rec['content']
            if (inner && typeof inner === 'object') {
                const text = (inner as Record<string, unknown>)['text']
                if (typeof text === 'string' && text) parts.push(text)
            }
        } else if (rec['type'] === 'diff') {
            const path = rec['path']
            if (typeof path === 'string' && path) parts.push(`edited ${path}`)
        }
    }
    return parts.length > 0 ? parts.join('\n') : null
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
export const pickStderrErrorLine = (lines: string[]): string | null => {
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
const FATAL_STDERR_PATTERNS = [/\bAborting\b/i, /Non-retryable.*error/i]
export const isFatalStderrLine = (line: string): boolean =>
    FATAL_STDERR_PATTERNS.some((re) => re.test(line))
