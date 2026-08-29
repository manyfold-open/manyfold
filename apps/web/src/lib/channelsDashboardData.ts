import type { ChannelActivityReport, ChannelSummary } from '@manyfold/shared'

export interface ChannelActivityVM {
    channel: ChannelSummary
    // null means the activity report is not loaded (or its fetch failed).
    // Rendering 0 there would claim a quiet channel, which is a different
    // statement from "we could not read the counts".
    messageCount: number | null
    inboundCount: number | null
    outboundCount: number | null
    // From channel_sessions, which is never pruned — so a channel can have a
    // last message far outside the count's window.
    lastMessageAt: string | null
}

const laterOf = (a: string | null, b: string | null): string | null => {
    if (!a) return b
    if (!b) return a
    return Date.parse(a) >= Date.parse(b) ? a : b
}

export const buildChannelActivityRows = (
    channels: ChannelSummary[],
    report: ChannelActivityReport | null
): ChannelActivityVM[] => {
    const byId = new Map((report?.rows ?? []).map((r) => [r.channelId, r]))
    return channels
        .map((channel) => {
            const row = report ? byId.get(channel.id) : undefined
            if (!report)
                return {
                    channel,
                    messageCount: null,
                    inboundCount: null,
                    outboundCount: null,
                    lastMessageAt: null
                }
            const inboundCount = row?.inboundCount ?? 0
            const outboundCount = row?.outboundCount ?? 0
            return {
                channel,
                messageCount: inboundCount + outboundCount,
                inboundCount,
                outboundCount,
                lastMessageAt: laterOf(
                    row?.lastInboundAt ?? null,
                    row?.lastOutboundAt ?? null
                )
            }
        })
        .sort((a, b) => {
            // Busiest-most-recent first; never-used channels sink to the
            // bottom rather than interleaving by id.
            if (a.lastMessageAt && b.lastMessageAt)
                return Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)
            if (a.lastMessageAt) return -1
            if (b.lastMessageAt) return 1
            return a.channel.label.localeCompare(b.channel.label)
        })
}
