import type { NewChatMessage, NewChatMessageSource } from '@manyfold/db'

// A recovered message is already stored iff one of its source rows' stable
// source_event_key is present. Filtering by that (not by the random message id)
// makes appendRecoveredMessages idempotent — re-firing the terminal→chat sync,
// concurrently or not, can never insert the same terminal message twice.
export const dedupRecoveredRowsBySourceKey = (
    rows: NewChatMessage[],
    sources: NewChatMessageSource[],
    existingSourceKeys: Set<string>
): { messageRows: NewChatMessage[]; sourceRows: NewChatMessageSource[] } => {
    const skipMessageIds = new Set<string>()
    for (const source of sources)
        if (
            source.messageId != null &&
            source.sourceEventKey != null &&
            existingSourceKeys.has(source.sourceEventKey)
        )
            skipMessageIds.add(source.messageId)
    return {
        messageRows: rows.filter((row) => !skipMessageIds.has(row.id)),
        sourceRows: sources.filter(
            (source) =>
                source.messageId == null ||
                !skipMessageIds.has(source.messageId)
        )
    }
}
