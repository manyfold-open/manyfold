import {
    ensureUid,
    fetchHistory,
    fetchPassport,
    SupportApiError,
    sendFeedback,
    stopTask,
    streamChat,
    stripPageContext,
    type HistoryItem,
    type PageContext,
    type RetrieverResource,
    type StreamEvent
} from './difyClient'

const CONVERSATION_KEY = 'mf-support-conversation'
const PENDING_KEY = 'mf-support-pending'
// Dify writes the message row as soon as the turn starts but only fills `answer`
// when the workflow finishes (~10s for this Chatflow), so a turn interrupted by
// a navigation has to be waited out rather than fetched once.
const SETTLE_INTERVAL_MS = 2000
const SETTLE_MAX_MS = 45000

export type Rating = 'like' | 'dislike' | null

export type Message = {
    role: 'user' | 'assistant'
    text: string
    messageId: string | null
    sources: RetrieverResource[]
    rating: Rating
    streaming: boolean
    stopped: boolean
    failed: boolean
}

export type ErrorKey = 'generic' | 'offline' | 'unavailable' | null
export type Announcement = '' | 'answering' | 'ready' | 'stopped' | 'error'

export type SupportState = {
    status: 'idle' | 'loading' | 'ready' | 'unavailable'
    messages: Message[]
    streaming: boolean
    error: ErrorKey
    announcement: Announcement
}

let state: SupportState = {
    status: 'idle',
    messages: [],
    streaming: false,
    error: null,
    announcement: ''
}

const listeners = new Set<() => void>()

export const getState = (): SupportState => state

export const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

const set = (patch: Partial<SupportState>): void => {
    state = { ...state, ...patch }
    listeners.forEach((listener) => listener())
}

const readStored = (key: string): string | null => {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

const writeStored = (key: string, value: string | null): void => {
    try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch {
        /* storage unavailable */
    }
}

const readPending = (): boolean => {
    try {
        return sessionStorage.getItem(PENDING_KEY) === '1'
    } catch {
        return false
    }
}

const writePending = (pending: boolean): void => {
    try {
        if (pending) sessionStorage.setItem(PENDING_KEY, '1')
        else sessionStorage.removeItem(PENDING_KEY)
    } catch {
        /* storage unavailable */
    }
}

// A navigation cancels the in-flight fetch and the rejection lands while the
// document is still alive, so the stream teardown has to tell "the page is
// leaving" apart from "the request actually failed".
let unloading = false

// Back/forward cache hands the same realm back, so leaving is a state to reset
// and not a one-way latch: left latched, every later failure reads as an unload
// and the panel stays streaming with no error, no Retry and a Stop that has no
// controller to abort. Reset on any `pageshow` — persisted or not, the document
// is live again — and settle the turn the freeze interrupted. Queued stream work
// must not compete with history, and init() does not run a second time.
const restoreFromFreeze = (): void => {
    unloading = false
    if (!state.streaming) return
    const active = controller
    controller = null
    active?.abort()
    writePending(false)
    // Without a conversation id the turn is unreachable from history, so the
    // only honest recovery is to surface it as failed and let Retry re-ask.
    if (!conversationId) {
        patchLast({ streaming: false, failed: true })
        set({ streaming: false, error: 'generic', announcement: 'error' })
        return
    }
    set({ streaming: false, announcement: 'answering' })
    patchLast({ streaming: true })
    void settleHistory()
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
        unloading = true
    })
    window.addEventListener('pageshow', restoreFromFreeze)
}

let uid = ''
let passport: string | null = null
let conversationId = ''
let controller: AbortController | null = null
let currentTaskId = ''
let lastQuery = ''
let initialized = false

const ensurePassport = async (force = false): Promise<string> => {
    if (passport && !force) return passport
    passport = await fetchPassport(uid)
    return passport
}

const withAuthRetry = async <T>(
    run: (token: string) => Promise<T>
): Promise<T> => {
    const token = await ensurePassport()
    try {
        return await run(token)
    } catch (error) {
        if (error instanceof SupportApiError && error.status === 401)
            return run(await ensurePassport(true))
        throw error
    }
}

const emptyAssistant = (): Message => ({
    role: 'assistant',
    text: '',
    messageId: null,
    sources: [],
    rating: null,
    streaming: true,
    stopped: false,
    failed: false
})

const expandHistory = (items: HistoryItem[]): Message[] =>
    items.flatMap((item) => [
        {
            role: 'user' as const,
            text: stripPageContext(item.query ?? ''),
            messageId: null,
            sources: [],
            rating: null,
            streaming: false,
            stopped: false,
            failed: false
        },
        {
            role: 'assistant' as const,
            text: item.answer ?? '',
            messageId: item.id,
            sources: item.retriever_resources ?? [],
            rating: item.feedback?.rating ?? null,
            streaming: false,
            stopped: false,
            failed: Boolean(item.error)
        }
    ])

const patchLast = (patch: Partial<Message>): void => {
    const messages = state.messages.slice()
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    messages[messages.length - 1] = { ...last, ...patch }
    set({ messages })
}

const loadHistory = async (): Promise<void> => {
    if (!conversationId) return
    const items = await withAuthRetry((token) =>
        fetchHistory(token, conversationId)
    )
    set({ messages: expandHistory(items) })
}

export const init = async (): Promise<void> => {
    if (initialized) return
    initialized = true
    uid = ensureUid()
    conversationId = readStored(CONVERSATION_KEY) ?? ''
    set({ status: 'loading', error: null })
    try {
        await ensurePassport()
    } catch {
        set({ status: 'unavailable', error: 'unavailable' })
        return
    }
    if (!conversationId) {
        set({ status: 'ready' })
        return
    }
    const settling = readPending()
    try {
        await loadHistory()
        set({ status: 'ready' })
    } catch (error) {
        if (error instanceof SupportApiError && error.status === 404) {
            conversationId = ''
            writeStored(CONVERSATION_KEY, null)
            set({ status: 'ready', messages: [] })
        } else {
            set({ status: 'ready', error: 'generic' })
        }
    }
    // A send that was in flight when the page unloaded still finishes server-side.
    // The row is already back from loadHistory with an empty answer, so show it as
    // pending and poll until the workflow lands.
    if (settling) {
        writePending(false)
        const last = state.messages[state.messages.length - 1]
        if (last && last.role === 'assistant' && !last.text) {
            patchLast({ streaming: true })
            set({ announcement: 'answering' })
            void settleHistory()
        }
    }
}

const settleHistory = async (): Promise<void> => {
    const deadline = Date.now() + SETTLE_MAX_MS
    while (Date.now() < deadline) {
        await new Promise((resolve) => {
            window.setTimeout(resolve, SETTLE_INTERVAL_MS)
        })
        // A new question started here wins; its optimistic messages must not be
        // clobbered by a history refresh.
        if (state.streaming) return
        try {
            await loadHistory()
        } catch {
            return
        }
        const last = state.messages[state.messages.length - 1]
        if (last && last.role === 'assistant' && last.text) {
            set({ announcement: 'ready' })
            return
        }
        patchLast({ streaming: true })
    }
    patchLast({ streaming: false })
}

const applyEvent = (event: StreamEvent, accumulated: string): string => {
    if (event.conversation_id && !conversationId) {
        conversationId = event.conversation_id
        writeStored(CONVERSATION_KEY, conversationId)
    }
    if (event.task_id) currentTaskId = event.task_id
    switch (event.event) {
        case 'message':
        case 'agent_message': {
            const next = accumulated + (event.answer ?? '')
            patchLast({ text: next })
            return next
        }
        case 'message_replace': {
            const next = event.answer ?? ''
            patchLast({ text: next })
            return next
        }
        case 'message_end': {
            patchLast({
                messageId: event.message_id ?? event.id ?? null,
                sources: event.metadata?.retriever_resources ?? []
            })
            return accumulated
        }
        case 'workflow_finished': {
            const final = event.data?.outputs?.answer
            if (typeof final === 'string' && final && final !== accumulated) {
                patchLast({ text: final })
                return final
            }
            return accumulated
        }
        default:
            return accumulated
    }
}

const runStream = async (
    text: string,
    context: PageContext,
    attempt: number
): Promise<void> => {
    const active = new AbortController()
    controller = active
    currentTaskId = ''
    let accumulated = ''
    let sawEvent = false
    try {
        const token = await ensurePassport()
        for await (const event of streamChat({
            passport: token,
            uid,
            query: text,
            conversationId,
            context,
            isFirstMessage: conversationId === '',
            signal: active.signal
        })) {
            if (active.signal.aborted) return
            sawEvent = true
            if (event.event === 'error')
                throw new SupportApiError(200, event.code ?? '', event.message ?? '')
            accumulated = applyEvent(event, accumulated)
        }
        if (active.signal.aborted) return
        patchLast({ streaming: false })
        set({ streaming: false, announcement: 'ready' })
        writePending(false)
    } catch (error) {
        if (active.signal.aborted || unloading) return
        if (!sawEvent && attempt === 0 && error instanceof SupportApiError) {
            if (error.status === 401) {
                passport = null
                return runStream(text, context, 1)
            }
            if (error.status === 404) {
                conversationId = ''
                writeStored(CONVERSATION_KEY, null)
                return runStream(text, context, 1)
            }
        }
        const offline =
            typeof navigator !== 'undefined' && navigator.onLine === false
        patchLast({ streaming: false, failed: true })
        set({
            streaming: false,
            error: offline ? 'offline' : 'generic',
            announcement: 'error'
        })
        // Frames already arrived, so the workflow is probably still running and
        // will persist its answer; leave the pending marker for the next load.
        if (!sawEvent) writePending(false)
    } finally {
        if (controller === active) controller = null
    }
}

export const send = async (
    text: string,
    context: PageContext
): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || state.streaming) return
    lastQuery = trimmed
    writePending(true)
    set({
        messages: [
            ...state.messages,
            {
                role: 'user',
                text: trimmed,
                messageId: null,
                sources: [],
                rating: null,
                streaming: false,
                stopped: false,
                failed: false
            },
            emptyAssistant()
        ],
        streaming: true,
        error: null,
        announcement: 'answering'
    })
    await runStream(trimmed, context, 0)
}

export const retry = async (context: PageContext): Promise<void> => {
    if (!lastQuery || state.streaming) return
    const messages = state.messages.slice()
    while (messages.length && messages[messages.length - 1].role === 'assistant')
        messages.pop()
    if (messages.length && messages[messages.length - 1].role === 'user')
        messages.pop()
    set({ messages, error: null })
    await send(lastQuery, context)
}

export const stop = (): void => {
    if (!controller) return
    const taskId = currentTaskId
    controller.abort()
    controller = null
    patchLast({ streaming: false, stopped: true })
    set({ streaming: false, announcement: 'stopped' })
    writePending(false)
    if (taskId && passport) void stopTask(passport, taskId, uid)
}

export const rate = async (index: number, rating: Rating): Promise<void> => {
    const target = state.messages[index]
    if (!target || target.role !== 'assistant' || !target.messageId) return
    const next = target.rating === rating ? null : rating
    const previous = target.rating
    const messages = state.messages.slice()
    messages[index] = { ...target, rating: next }
    set({ messages })
    try {
        await withAuthRetry((token) =>
            sendFeedback(token, target.messageId as string, next)
        )
    } catch {
        const reverted = state.messages.slice()
        const current = reverted[index]
        if (current) reverted[index] = { ...current, rating: previous }
        set({ messages: reverted })
    }
}

export const newChat = (): void => {
    if (controller) {
        controller.abort()
        controller = null
    }
    conversationId = ''
    lastQuery = ''
    writeStored(CONVERSATION_KEY, null)
    writePending(false)
    set({ messages: [], streaming: false, error: null, announcement: '' })
}

export const clearError = (): void => {
    if (state.error) set({ error: null })
}