// Agent Settings is a sibling route of the chat, so opening it unmounts the
// message list and returning mounts a fresh one that knows nothing about where
// the reader was (#725). This remembers the position per account + agent +
// session so the return lands where they left, and models "at the bottom" as a
// position of its own — a raw scrollTop cannot say whether the reader was
// pinned to the newest message or merely near it, and the pixel is meaningless
// once older pages prepend or a stream grows the transcript.

const storageKey = 'nca.chat.scrollPosition.v1'

export const CHAT_SCROLL_MAX_ENTRIES = 40
export const CHAT_SCROLL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 96
export const CHAT_SCROLL_ANCHOR_MAX_PAGE_LOADS = 4

const maxMessageIdLength = 128
const maxScopePartLength = 200
const maxStoredKeyLength = maxScopePartLength * 9 * 3 + 2
const maxAnchorOffsetPx = 50_000

export interface ChatScrollAnchor {
    messageId: string
    offset: number
}

export type ChatScrollPosition =
    | { mode: 'bottom' }
    | { mode: 'anchor'; anchor: ChatScrollAnchor }

export const CHAT_SCROLL_BOTTOM: ChatScrollPosition = { mode: 'bottom' }

export interface ChatScrollScope {
    accountKey: string | null | undefined
    agentId: string | null | undefined
    sessionId: string | null | undefined
}

// Every part must be present: a missing account (auth still hydrating, or
// signed out) has to fail closed rather than share one unscoped slot, which
// would hand the next account this one's reading position.
export const chatScrollScopeKey = ({
    accountKey,
    agentId,
    sessionId
}: ChatScrollScope): string | null => {
    const parts = [accountKey, agentId, sessionId]
    const usable = parts.every(
        (part) =>
            typeof part === 'string' &&
            part.length > 0 &&
            part.length <= maxScopePartLength
    )
    if (!usable) return null
    try {
        const key = parts
            .map((part) => encodeURIComponent(part as string))
            .join('|')
        return key.length <= maxStoredKeyLength ? key : null
    } catch {
        return null
    }
}

export interface ChatScrollEntry {
    position: ChatScrollPosition
    updatedAt: number
}

export type ChatScrollStore = Record<string, ChatScrollEntry>

const readAnchor = (
    value: Record<string, unknown>
): ChatScrollAnchor | null => {
    const { messageId, offset } = value
    if (
        typeof messageId !== 'string' ||
        messageId.length === 0 ||
        messageId.length > maxMessageIdLength
    )
        return null
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return null
    if (Math.abs(offset) > maxAnchorOffsetPx) return null
    return { messageId, offset: Math.round(offset) }
}

const readEntry = (value: unknown, now: number): ChatScrollEntry | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null
    const record = value as Record<string, unknown>
    const { mode, updatedAt } = record
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt))
        return null
    if (updatedAt > now || now - updatedAt > CHAT_SCROLL_MAX_AGE_MS) return null
    if (mode === 'bottom')
        return {
            position: CHAT_SCROLL_BOTTOM,
            updatedAt: Math.round(updatedAt)
        }
    if (mode !== 'anchor') return null
    const anchor = readAnchor(record)
    if (!anchor) return null
    return {
        position: { mode: 'anchor', anchor },
        updatedAt: Math.round(updatedAt)
    }
}

// Everything here came back from localStorage, which any script on the origin
// and any earlier build could have written, so nothing is trusted: unknown
// shapes, stale entries and oversized values are dropped instead of repaired.
export const parseChatScrollStore = (
    raw: string | null | undefined,
    now: number
): ChatScrollStore => {
    if (!raw || !Number.isFinite(now)) return {}
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return {}
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return {}
    const store = Object.create(null) as ChatScrollStore
    for (const [key, value] of Object.entries(parsed)) {
        if (key.length === 0 || key.length > maxStoredKeyLength) continue
        const entry = readEntry(value, now)
        if (entry) store[key] = entry
    }
    return Object.fromEntries(
        Object.entries(store)
            .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
            .slice(0, CHAT_SCROLL_MAX_ENTRIES)
    )
}

export const serializeChatScrollStore = (store: ChatScrollStore): string =>
    JSON.stringify(
        Object.fromEntries(
            Object.entries(store).map(([key, entry]) => [
                key,
                entry.position.mode === 'anchor'
                    ? {
                          mode: 'anchor',
                          messageId: entry.position.anchor.messageId,
                          offset: entry.position.anchor.offset,
                          updatedAt: entry.updatedAt
                      }
                    : { mode: 'bottom', updatedAt: entry.updatedAt }
            ])
        )
    )

// One entry per conversation the reader visited, so the map is bounded by the
// oldest entries falling off rather than by hoping they stop opening chats.
export const withChatScrollPosition = (
    store: ChatScrollStore,
    key: string,
    position: ChatScrollPosition,
    now: number
): ChatScrollStore => {
    const next: ChatScrollStore = {
        ...store,
        [key]: { position, updatedAt: now }
    }
    const keys = Object.keys(next)
    if (keys.length <= CHAT_SCROLL_MAX_ENTRIES) return next
    const evicted = keys
        .filter((candidate) => candidate !== key)
        .sort((left, right) => next[right].updatedAt - next[left].updatedAt)
        .slice(CHAT_SCROLL_MAX_ENTRIES - 1)
    for (const candidate of evicted) delete next[candidate]
    return next
}

const readStore = (now: number): ChatScrollStore | null => {
    if (typeof window === 'undefined') return null
    try {
        return parseChatScrollStore(
            window.localStorage.getItem(storageKey),
            now
        )
    } catch {
        return null
    }
}

export const readChatScrollPosition = (
    key: string | null,
    now: number = Date.now()
): ChatScrollPosition | null => {
    if (!key || key.length > maxStoredKeyLength) return null
    return readStore(now)?.[key]?.position ?? null
}

export const writeChatScrollPosition = (
    key: string | null,
    position: ChatScrollPosition | null,
    now: number = Date.now()
): void => {
    if (
        !key ||
        key.length > maxStoredKeyLength ||
        !position ||
        !Number.isFinite(now) ||
        typeof window === 'undefined'
    )
        return
    try {
        const store = readStore(now)
        if (!store) return
        window.localStorage.setItem(
            storageKey,
            serializeChatScrollStore(
                withChatScrollPosition(store, key, position, now)
            )
        )
    } catch {
        // A full or blocked storage only costs the next return its position.
    }
}

export interface ChatViewportMetrics {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
}

export const isChatViewportAtBottom = (metrics: ChatViewportMetrics): boolean =>
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <
    CHAT_SCROLL_BOTTOM_THRESHOLD_PX

export interface ChatMessageOffset {
    messageId: string
    top: number
}

// `top` is each message's offset from the top of the viewport, so the anchor is
// the last message the top edge has already crossed. Storing which message that
// is, and how far past it the reader had scrolled, survives the reflows a raw
// offset does not: a prepended page, a taller streamed block, a re-rendered
// composer.
export const captureChatScrollPosition = (
    metrics: ChatViewportMetrics,
    messages: readonly ChatMessageOffset[]
): ChatScrollPosition | null => {
    // A detached or unmeasured viewport reports zeroes, which read as "at the
    // bottom" and would overwrite a real position on the way out.
    if (metrics.clientHeight <= 0 || metrics.scrollHeight <= 0) return null
    if (isChatViewportAtBottom(metrics)) return CHAT_SCROLL_BOTTOM
    const seen = new Set<string>()
    const measured = messages.filter((message) => {
        if (
            !chatMessageAnchorId(message.messageId) ||
            !Number.isFinite(message.top) ||
            seen.has(message.messageId)
        )
            return false
        seen.add(message.messageId)
        return true
    })
    if (measured.length === 0) return null
    let anchor = measured[0]
    for (const message of measured) {
        if (message.top <= 0) anchor = message
    }
    const offset = Math.round(anchor.top)
    if (Math.abs(offset) > maxAnchorOffsetPx) return null
    return { mode: 'anchor', anchor: { messageId: anchor.messageId, offset } }
}

export const chatMessageAnchorId = (messageId: string): string | null =>
    messageId.length > 0 && messageId.length <= maxMessageIdLength
        ? messageId
        : null

export const chatAnchorScrollTop = (
    metrics: ChatViewportMetrics,
    anchorTop: number,
    offset: number
): number => {
    const target = metrics.scrollTop + (anchorTop - offset)
    const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
    return Math.min(Math.max(target, 0), max)
}

export interface ChatAnchorSearch {
    anchorFound: boolean
    loadedPages: number
    hasMore: boolean
    loadingOlder: boolean
}

export interface ChatScrollRestorationState {
    positioned: boolean
    pending: {
        anchor: ChatScrollAnchor
        loadedPages: number
    } | null
}

export const CHAT_SCROLL_RESTORE_COMMAND = {
    none: 0,
    applyAnchor: 1,
    loadOlder: 2,
    pinBottom: 3
} as const

export type ChatScrollRestoreCommand =
    (typeof CHAT_SCROLL_RESTORE_COMMAND)[keyof typeof CHAT_SCROLL_RESTORE_COMMAND]

export interface ChatScrollRestorationTransition {
    state: ChatScrollRestorationState
    command: ChatScrollRestoreCommand
}

export interface ChatScrollScopeHandoff {
    changed: boolean
    captureScopeKey: string | null
    state: ChatScrollRestorationState
}

export const unpositionedChatScrollRestoration =
    (): ChatScrollRestorationState => ({
        positioned: false,
        pending: null
    })

export const beginChatScrollRestoration = (
    position: ChatScrollPosition
): ChatScrollRestorationTransition =>
    position.mode === 'bottom'
        ? {
              state: { positioned: true, pending: null },
              command: CHAT_SCROLL_RESTORE_COMMAND.pinBottom
          }
        : {
              state: {
                  positioned: false,
                  pending: { anchor: position.anchor, loadedPages: 0 }
              },
              command: CHAT_SCROLL_RESTORE_COMMAND.none
          }

export const handoffChatScrollScope = (
    currentScopeKey: string | null,
    nextScopeKey: string | null,
    state: ChatScrollRestorationState
): ChatScrollScopeHandoff =>
    currentScopeKey === nextScopeKey
        ? { changed: false, captureScopeKey: null, state }
        : {
              changed: true,
              captureScopeKey:
                  currentScopeKey && state.positioned && !state.pending
                      ? currentScopeKey
                      : null,
              state: unpositionedChatScrollRestoration()
          }

export const advanceChatScrollRestoration = (
    state: ChatScrollRestorationState,
    search: Omit<ChatAnchorSearch, 'loadedPages'>
): ChatScrollRestorationTransition => {
    const pending = state.pending
    if (!pending) return { state, command: CHAT_SCROLL_RESTORE_COMMAND.none }
    if (search.anchorFound)
        return {
            state: { positioned: true, pending: null },
            command: CHAT_SCROLL_RESTORE_COMMAND.applyAnchor
        }
    if (search.loadingOlder)
        return { state, command: CHAT_SCROLL_RESTORE_COMMAND.pinBottom }
    if (
        !search.hasMore ||
        pending.loadedPages >= CHAT_SCROLL_ANCHOR_MAX_PAGE_LOADS
    )
        return {
            state: { positioned: true, pending: null },
            command: CHAT_SCROLL_RESTORE_COMMAND.pinBottom
        }
    return {
        state: {
            positioned: false,
            pending: {
                anchor: pending.anchor,
                loadedPages: pending.loadedPages + 1
            }
        },
        command: CHAT_SCROLL_RESTORE_COMMAND.loadOlder
    }
}

export const shouldRestoreChatScrollScope = ({
    scopeKey,
    restoredScopeKey,
    loadedAgentId,
    activeAgentId,
    loadedSessionId,
    activeSessionId
}: {
    scopeKey: string | null
    restoredScopeKey: string | null
    loadedAgentId: string | null
    activeAgentId: string | null
    loadedSessionId: string | null
    activeSessionId: string | null
}): boolean =>
    Boolean(
        scopeKey &&
        loadedAgentId === activeAgentId &&
        loadedSessionId === activeSessionId &&
        restoredScopeKey !== scopeKey
    )
