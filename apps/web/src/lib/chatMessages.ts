import type { ChatMessage } from '@manyfold/shared'

export const compareChatMessages = (
    a: Pick<ChatMessage, 'createdAt' | 'id'>,
    b: Pick<ChatMessage, 'createdAt' | 'id'>
): number => {
    const timeDiff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    if (timeDiff !== 0) return timeDiff
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
}

export const mergeMessagesById = (
    current: ChatMessage[],
    incoming: ChatMessage[]
): ChatMessage[] => {
    const byId = new Map<string, ChatMessage>()
    for (const message of current) byId.set(message.id, message)
    for (const message of incoming) byId.set(message.id, message)
    return [...byId.values()].sort(compareChatMessages)
}

export const mergeLatestMessages = (
    current: ChatMessage[],
    latest: ChatMessage[]
): ChatMessage[] => {
    if (latest.length === 0) return current
    const earliestLatest = latest[0]
    const older = current.filter(
        (message) => compareChatMessages(message, earliestLatest) < 0
    )
    return mergeMessagesById(older, latest)
}

export const applyRegeneratedUserMessage = (
    current: ChatMessage[],
    targetMessageId: string,
    replacement: ChatMessage,
    deletedMessageIds: string[]
): ChatMessage[] => {
    const index = current.findIndex((message) => message.id === targetMessageId)
    if (index !== -1) return [...current.slice(0, index), replacement]

    const deleted = new Set(deletedMessageIds)
    return mergeMessagesById(
        current.filter((message) => !deleted.has(message.id)),
        [replacement]
    )
}
