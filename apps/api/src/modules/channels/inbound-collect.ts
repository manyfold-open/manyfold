import type { ChannelDeliveryRow } from '@manyfold/db'
import type {
    NormalizedInboundAttachment,
    NormalizedInboundEvent
} from './channel-provider'

// Decode a stored inbound delivery's eventJson back into a normalized event.
// Field-by-field: stored JSON is untrusted (schema may drift across versions),
// so anything malformed returns null and the caller drops the row.
export const parseStoredInboundEvent = (
    value: unknown
): NormalizedInboundEvent | null => {
    if (!value || typeof value !== 'object') return null
    const event = value as Partial<NormalizedInboundEvent>
    if (typeof event.providerEventId !== 'string') return null
    if (typeof event.chatId !== 'string') return null
    if (event.chatType !== 'private' && event.chatType !== 'group') return null
    if (typeof event.senderId !== 'string') return null
    if (typeof event.text !== 'string') return null
    if (typeof event.isMention !== 'boolean') return null
    return {
        providerEventId: event.providerEventId,
        chatId: event.chatId,
        chatType: event.chatType,
        senderId: event.senderId,
        senderName:
            typeof event.senderName === 'string' || event.senderName === null
                ? event.senderName
                : null,
        text: event.text,
        attachments: parseStoredInboundAttachments(event.attachments),
        threadId:
            typeof event.threadId === 'string' || event.threadId === null
                ? event.threadId
                : null,
        isMention: event.isMention,
        messageId:
            typeof event.messageId === 'string' || event.messageId === null
                ? event.messageId
                : null,
        replyToMessageId:
            typeof event.replyToMessageId === 'string' ||
            event.replyToMessageId === null
                ? event.replyToMessageId
                : null,
        replyTargetId:
            typeof event.replyTargetId === 'string' ||
            event.replyTargetId === null
                ? event.replyTargetId
                : null,
        // Preserve the fresh-thread skip across replay/drain.
        threadFresh: event.threadFresh === true ? true : undefined,
        // Preserve command-invocation semantics: a recovered unknown native
        // command must still get help, never reach the agent as chat.
        commandInvocation: event.commandInvocation === true ? true : undefined,
        raw: event.raw ?? {}
    }
}

const parseStoredInboundAttachments = (
    value: unknown
): NormalizedInboundAttachment[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const out: NormalizedInboundAttachment[] = []
    for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const attachment = item as Partial<NormalizedInboundAttachment>
        if (typeof attachment.url !== 'string') continue
        if (typeof attachment.name !== 'string') continue
        out.push({
            url: attachment.url,
            name: attachment.name,
            contentType:
                typeof attachment.contentType === 'string'
                    ? attachment.contentType
                    : null,
            size:
                typeof attachment.size === 'number' ? attachment.size : null
        })
    }
    return out.length > 0 ? out : undefined
}

export interface CollectComposition {
    carrierId: bigint
    mergedIds: bigint[]
    eventJson: Record<string, unknown>
    summaryText: string
}

const COLLECT_SUMMARY_MAX = 200

// Merge the queue's maximal parseable, text-only prefix into ONE turn instead
// of replaying each queued message as its own turn. The carrier is the LAST
// message of the prefix so reply anchoring (replyTargetId/messageId) points at
// the newest message; texts stay in arrival order. Rows with attachments (or
// unparseable rows) end the prefix — they replay individually so attachment
// handling and invalid-row dropping keep their existing per-row paths.
// Returns null when there is nothing to merge (0 or 1 usable rows).
export const composeCollectedInbound = (
    rows: ChannelDeliveryRow[]
): CollectComposition | null => {
    const prefix: Array<{ row: ChannelDeliveryRow; event: NormalizedInboundEvent }> =
        []
    for (const row of rows) {
        const event = parseStoredInboundEvent(row.eventJson)
        if (!event) break
        if ((event.attachments?.length ?? 0) > 0) break
        prefix.push({ row, event })
    }
    if (prefix.length < 2) return null
    const carrier = prefix[prefix.length - 1]
    const senders = new Set(prefix.map((entry) => entry.event.senderId))
    const lines = prefix.map((entry, index) => {
        const label =
            senders.size > 1
                ? `[${entry.event.senderName ?? entry.event.senderId}] `
                : ''
        return `${index + 1}. ${label}${entry.event.text}`
    })
    const text = `[${prefix.length} messages arrived while a turn was running — answering together]\n${lines.join('\n')}`
    const merged: NormalizedInboundEvent = { ...carrier.event, text }
    return {
        carrierId: carrier.row.id,
        mergedIds: prefix.slice(0, -1).map((entry) => entry.row.id),
        eventJson: merged as unknown as Record<string, unknown>,
        summaryText:
            text.length <= COLLECT_SUMMARY_MAX
                ? text
                : `${text.slice(0, COLLECT_SUMMARY_MAX - 1)}…`
    }
}
