const BASE_URL = 'https://dify.manyfold.ai'
const APP_CODE = '1vLBqtzT1YrNCxD0'
const UID_KEY = 'mf-support-uid'

// The Chatflow's Start node does not declare page_* variables yet, so Dify drops
// anything we put in `inputs`. Until it does, the same context rides along in the
// first query as a strippable comment. Flip to false once Start declares them.
const SEND_CONTEXT_IN_QUERY = true
const CONTEXT_PATTERN = /\n*<!--mf-page [^>]*-->\s*$/

export type RetrieverResource = {
    document_name?: string
    dataset_name?: string
    score?: string | number
    position?: string | number
}

export type PageContext = {
    page_url: string
    page_title: string
    page_locale: string
}

export type StreamEvent = {
    event?: string
    conversation_id?: string
    message_id?: string
    id?: string
    task_id?: string
    answer?: string
    code?: string
    message?: string
    metadata?: { retriever_resources?: RetrieverResource[] }
    data?: {
        outputs?: { answer?: string }
        status?: string
    }
}

export type HistoryItem = {
    id: string
    query: string
    answer: string
    feedback?: { rating?: 'like' | 'dislike' | null } | null
    retriever_resources?: RetrieverResource[]
    error?: string | null
}

export class SupportApiError extends Error {
    readonly status: number
    readonly code: string

    constructor(status: number, code: string, message: string) {
        super(message)
        this.name = 'SupportApiError'
        this.status = status
        this.code = code
    }
}

const randomId = (): string => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID)
        return crypto.randomUUID()
    const bytes = new Uint8Array(16)
    if (typeof crypto !== 'undefined' && crypto.getRandomValues)
        crypto.getRandomValues(bytes)
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const ensureUid = (): string => {
    try {
        const existing = localStorage.getItem(UID_KEY)
        if (existing) return existing
        const created = randomId()
        localStorage.setItem(UID_KEY, created)
        return created
    } catch {
        return randomId()
    }
}

// Dify 1.15 wants the passport JWT in X-App-Passport, not Authorization.
const authHeaders = (passport: string): Record<string, string> => ({
    'X-App-Code': APP_CODE,
    'X-App-Passport': passport
})

const readError = async (res: Response): Promise<SupportApiError> => {
    let code = ''
    let message = ''
    try {
        const body = (await res.json()) as { code?: string; message?: string }
        code = body.code ?? ''
        message = body.message ?? ''
    } catch {
        code = ''
    }
    return new SupportApiError(res.status, code, message || res.statusText)
}

export const fetchPassport = async (
    uid: string,
    signal?: AbortSignal
): Promise<string> => {
    const url = `${BASE_URL}/api/passport?user_id=${encodeURIComponent(uid)}`
    const res = await fetch(url, { headers: { 'X-App-Code': APP_CODE }, signal })
    if (!res.ok) throw await readError(res)
    const body = (await res.json()) as { access_token?: string }
    if (!body.access_token) throw new SupportApiError(res.status, '', 'no token')
    return body.access_token
}

export const fetchHistory = async (
    passport: string,
    conversationId: string,
    signal?: AbortSignal
): Promise<HistoryItem[]> => {
    const url = `${BASE_URL}/api/messages?conversation_id=${encodeURIComponent(
        conversationId
    )}&limit=50`
    const res = await fetch(url, { headers: authHeaders(passport), signal })
    if (!res.ok) throw await readError(res)
    const body = (await res.json()) as { data?: HistoryItem[] }
    return body.data ?? []
}

export const sendFeedback = async (
    passport: string,
    messageId: string,
    rating: 'like' | 'dislike' | null
): Promise<void> => {
    const res = await fetch(
        `${BASE_URL}/api/messages/${encodeURIComponent(messageId)}/feedbacks`,
        {
            method: 'POST',
            headers: { ...authHeaders(passport), 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        }
    )
    if (!res.ok) throw await readError(res)
}

export const stopTask = async (
    passport: string,
    taskId: string,
    uid: string
): Promise<void> => {
    await fetch(
        `${BASE_URL}/api/chat-messages/${encodeURIComponent(taskId)}/stop`,
        {
            method: 'POST',
            headers: { ...authHeaders(passport), 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: uid })
        }
    ).catch(() => undefined)
}

export const appendPageContext = (
    query: string,
    context: PageContext
): string => {
    if (!SEND_CONTEXT_IN_QUERY) return query
    const payload = JSON.stringify({
        url: context.page_url,
        title: context.page_title,
        locale: context.page_locale
    })
    return `${query}\n\n<!--mf-page ${payload}-->`
}

export const stripPageContext = (text: string): string =>
    text.replace(CONTEXT_PATTERN, '')

// Query/hash are dropped rather than sent: docs URLs carry nothing the agent
// needs and this keeps any stray param out of a third party's logs.
export const readPageContext = (locale: string): PageContext => ({
    page_url: `${window.location.origin}${window.location.pathname}`,
    page_title: document.title,
    page_locale: locale
})

const readFrames = async function* (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal
): AsyncGenerator<string> {
    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let data: string[] = []
    const flush = (): string | null => {
        if (!data.length) return null
        const joined = data.join('\n')
        data = []
        return joined || null
    }
    try {
        while (!signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let cut = buffer.indexOf('\n')
            while (cut !== -1) {
                const line = buffer.slice(0, cut).replace(/\r$/, '')
                buffer = buffer.slice(cut + 1)
                if (line === '') {
                    const frame = flush()
                    if (frame) yield frame
                } else if (!line.startsWith(':')) {
                    const colon = line.indexOf(':')
                    const field = colon === -1 ? line : line.slice(0, colon)
                    if (field === 'data') {
                        const raw = colon === -1 ? '' : line.slice(colon + 1)
                        data.push(raw.startsWith(' ') ? raw.slice(1) : raw)
                    }
                }
                cut = buffer.indexOf('\n')
            }
        }
        const tail = flush()
        if (tail) yield tail
    } finally {
        reader.cancel().catch(() => undefined)
    }
}

export const streamChat = async function* (input: {
    passport: string
    uid: string
    query: string
    conversationId: string
    context: PageContext
    isFirstMessage: boolean
    signal: AbortSignal
}): AsyncGenerator<StreamEvent> {
    const query = input.isFirstMessage
        ? appendPageContext(input.query, input.context)
        : input.query
    const res = await fetch(`${BASE_URL}/api/chat-messages`, {
        method: 'POST',
        headers: {
            ...authHeaders(input.passport),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            inputs: { ...input.context },
            query,
            response_mode: 'streaming',
            conversation_id: input.conversationId,
            files: []
        }),
        signal: input.signal
    })
    if (!res.ok) throw await readError(res)
    if (!res.body) throw new SupportApiError(res.status, '', 'no response body')
    for await (const frame of readFrames(res.body, input.signal)) {
        let parsed: StreamEvent
        try {
            parsed = JSON.parse(frame) as StreamEvent
        } catch {
            continue
        }
        yield parsed
    }
}