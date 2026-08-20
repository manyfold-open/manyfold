import type { ChannelSessionWithChatTitle } from '../channels.repository'

export function matchSession(
    items: ChannelSessionWithChatTitle[],
    query: string
): ChannelSessionWithChatTitle | null {
    if (items.length === 0) return null
    const trimmed = query.trim()
    if (trimmed === '') return null

    const numeric = Number.parseInt(trimmed, 10)
    if (
        !Number.isNaN(numeric) &&
        /^\d+$/.test(trimmed) &&
        numeric >= 1 &&
        numeric <= items.length
    )
        return items[numeric - 1]

    const lower = trimmed.toLowerCase()

    for (const item of items) {
        const name = item.session.displayName
        if (name && name.toLowerCase() === lower) return item
    }

    if (lower.startsWith('chs_')) {
        for (const item of items) {
            if (item.session.id.startsWith(trimmed)) return item
        }
    }

    if (lower.startsWith('cts_')) {
        for (const item of items) {
            if (item.session.chatSessionId.startsWith(trimmed)) return item
        }
    }

    for (const item of items) {
        const name = item.session.displayName
        if (name && name.toLowerCase().startsWith(lower)) return item
    }

    for (const item of items) {
        const title = item.chatTitle
        if (title && title.toLowerCase().includes(lower)) return item
    }

    return null
}
