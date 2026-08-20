export interface OpenclawJsonParseResult {
    texts: string[]
    toolUses: Array<{
        tool: string
        callId: string | null
        input: Record<string, unknown> | null
    }>
    sessionId: string | null
    model: string | null
    usage: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    } | null
    errorMessage: string | null
}

interface OpenclawFinalResult {
    payloads?: Array<{ text?: string }>
    meta?: {
        agentMeta?: Record<string, unknown>
        durationMs?: number
    }
}

interface OpenclawStreamingEvent {
    type?: string
    sessionId?: string
    text?: string
    tool?: string
    callId?: string
    input?: Record<string, unknown>
    usage?: Record<string, unknown>
    phase?: string
    error?: {
        name?: string
        data?: { message?: string }
        message?: string
    }
    message?: string
}

const emptyResult = (): OpenclawJsonParseResult => ({
    texts: [],
    toolUses: [],
    sessionId: null,
    model: null,
    usage: null,
    errorMessage: null
})

const parseUsage = (
    raw: unknown
): OpenclawJsonParseResult['usage'] | null => {
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const num = (...keys: string[]): number | undefined => {
        for (const k of keys) {
            const v = obj[k]
            if (typeof v === 'number') return v
        }
        return undefined
    }
    const usage: NonNullable<OpenclawJsonParseResult['usage']> = {}
    const prompt = num('prompt_tokens', 'inputTokens', 'input_tokens')
    const completion = num(
        'completion_tokens',
        'outputTokens',
        'output_tokens'
    )
    const cacheRead = num(
        'cache_read_input_tokens',
        'cacheReadTokens',
        'cache_read'
    )
    const cacheCreate = num(
        'cache_creation_input_tokens',
        'cacheWriteTokens',
        'cache_creation'
    )
    if (prompt !== undefined) usage.prompt_tokens = prompt
    if (completion !== undefined) usage.completion_tokens = completion
    if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead
    if (cacheCreate !== undefined)
        usage.cache_creation_input_tokens = cacheCreate
    if (
        usage.prompt_tokens === undefined &&
        usage.completion_tokens === undefined &&
        usage.cache_read_input_tokens === undefined &&
        usage.cache_creation_input_tokens === undefined
    )
        return null
    usage.total_tokens =
        (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    return usage
}

const tryParseFinalResult = (
    raw: string
): OpenclawFinalResult | null => {
    const trimmed = raw.trimStart()
    if (!trimmed.startsWith('{')) return null
    try {
        const parsed = JSON.parse(trimmed) as OpenclawFinalResult
        if (!parsed.payloads && !parsed.meta?.durationMs) return null
        return parsed
    } catch {
        return null
    }
}

const tryParseWholeBuffer = (
    buf: string
): OpenclawFinalResult | null => {
    const trimmed = buf.trim()
    if (!trimmed) return null
    const direct = tryParseFinalResult(trimmed)
    if (direct) return direct
    const lines = trimmed.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].length > 0 && lines[i][0] === '{') {
            const candidate = lines.slice(i).join('\n').trim()
            return tryParseFinalResult(candidate)
        }
    }
    return null
}

const applyFinalResult = (
    result: OpenclawFinalResult,
    out: OpenclawJsonParseResult
): void => {
    for (const p of result.payloads ?? []) {
        if (typeof p.text === 'string' && p.text.length > 0)
            out.texts.push(p.text)
    }
    const agentMeta = result.meta?.agentMeta
    if (agentMeta) {
        const sid = agentMeta['sessionId']
        if (typeof sid === 'string' && sid) out.sessionId = sid
        const mdl = agentMeta['model']
        if (typeof mdl === 'string' && mdl.trim()) out.model = mdl.trim()
        const usage = parseUsage(agentMeta['usage'])
        if (usage) out.usage = usage
    }
}

const errorMessageFromEvent = (
    ev: OpenclawStreamingEvent
): string => {
    if (ev.error) {
        if (ev.error.data?.message) return ev.error.data.message
        if (ev.error.message) return ev.error.message
        if (ev.error.name) return ev.error.name
    }
    if (ev.text) return ev.text
    if (ev.message) return ev.message
    return 'unknown openclaw error'
}

const applyStreamingEvent = (
    ev: OpenclawStreamingEvent,
    out: OpenclawJsonParseResult
): void => {
    if (ev.sessionId) out.sessionId = ev.sessionId
    switch (ev.type) {
        case 'text':
            if (ev.text) out.texts.push(ev.text)
            break
        case 'tool_use':
            out.toolUses.push({
                tool: ev.tool ?? '',
                callId: ev.callId ?? null,
                input: ev.input ?? null
            })
            break
        case 'error':
            out.errorMessage = errorMessageFromEvent(ev)
            break
        case 'lifecycle': {
            const phase = ev.phase ?? ''
            if (
                phase === 'error' ||
                phase === 'failed' ||
                phase === 'cancelled'
            )
                out.errorMessage = errorMessageFromEvent(ev)
            break
        }
        case 'step_finish': {
            const usage = parseUsage(ev.usage)
            if (usage) out.usage = usage
            break
        }
        default:
            break
    }
}

const tryParseStreamingEvent = (
    line: string
): OpenclawStreamingEvent | null => {
    if (line.length === 0 || line[0] !== '{') return null
    try {
        const parsed = JSON.parse(line) as OpenclawStreamingEvent
        if (typeof parsed.type !== 'string' || parsed.type.length === 0)
            return null
        return parsed
    } catch {
        return null
    }
}

export const parseOpenclawJsonOutput = (
    raw: string
): OpenclawJsonParseResult => {
    const out = emptyResult()
    if (!raw.trim()) return out

    const wholeBuffer = tryParseWholeBuffer(raw)
    if (wholeBuffer) {
        applyFinalResult(wholeBuffer, out)
        return out
    }

    let sawEvent = false
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        const ev = tryParseStreamingEvent(line)
        if (ev) {
            sawEvent = true
            applyStreamingEvent(ev, out)
            continue
        }
        const single = tryParseFinalResult(line)
        if (single) {
            sawEvent = true
            applyFinalResult(single, out)
        }
    }

    if (!sawEvent) {
        const trimmed = raw.trim()
        if (trimmed) out.texts.push(trimmed)
    }

    return out
}
