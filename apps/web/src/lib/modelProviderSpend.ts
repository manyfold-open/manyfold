import type {
    UserModelProviderSummary,
    UserModelProviderUsage,
    UserModelProviderUsageReport
} from '@manyfold/shared'
import { daysAgoIso } from '@/lib/usageFormat'

export type SpendWindow = '7d' | '30d' | 'all'

export interface SpendRow {
    key: string
    // null is the unattributed group: spend from turns whose agent had no
    // provider bound, or whose provider row has since been deleted.
    provider: UserModelProviderSummary | null
    // null means the report is not loaded (or its fetch failed) — distinct
    // from a provider that exists but has never been used, which carries a
    // zeroed usage. Rendering these two the same way is the bug this type
    // exists to prevent.
    usage: UserModelProviderUsage | null
}

const emptyUsage: UserModelProviderUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    unpricedEventCount: 0,
    eventCount: 0,
    lastUsedAt: null
}

// The repo's window convention is inclusive of today: "last 7 days" is today
// plus the six before it, matching Usage.tsx and the admin providers table.
export const spendWindowFrom = (window: SpendWindow): string | undefined => {
    if (window === 'all') return undefined
    return daysAgoIso(window === '7d' ? 6 : 29)
}

export const totalTokens = (usage: UserModelProviderUsage): number =>
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens

// Cost first, biggest spender at the top. A group whose cost is unknown
// sorts below every priced one but above the providers that were never used
// in the window, so the rows a reader must interpret stay together.
const compareRows = (a: SpendRow, b: SpendRow): number => {
    const rank = (row: SpendRow): number => {
        if (!row.usage || row.usage.eventCount === 0) return 2
        return row.usage.costUsd === null ? 1 : 0
    }
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const cost = (b.usage?.costUsd ?? 0) - (a.usage?.costUsd ?? 0)
    if (cost !== 0) return cost
    const events = (b.usage?.eventCount ?? 0) - (a.usage?.eventCount ?? 0)
    if (events !== 0) return events
    return (a.provider?.providerName ?? '').localeCompare(
        b.provider?.providerName ?? ''
    )
}

export const buildSpendRows = (
    providers: UserModelProviderSummary[],
    report: UserModelProviderUsageReport | null
): SpendRow[] => {
    const byId = new Map(
        (report?.rows ?? [])
            .filter((r) => r.modelProviderId !== null)
            .map((r) => [r.modelProviderId as string, r.usage])
    )
    const rows: SpendRow[] = providers.map((provider) => ({
        key: provider.id,
        provider,
        usage: report ? (byId.get(provider.id) ?? emptyUsage) : null
    }))
    const unattributed = report?.rows.find((r) => r.modelProviderId === null)
    // Only worth a row when it actually carries spend — an empty one would be
    // a permanent unexplained card on every account.
    if (unattributed && unattributed.usage.eventCount > 0)
        rows.push({
            key: 'unattributed',
            provider: null,
            usage: unattributed.usage
        })
    return rows.sort(compareRows)
}

export interface SpendTotals {
    costUsd: number | null
    unpricedEventCount: number
    eventCount: number
}

export const spendTotals = (rows: SpendRow[]): SpendTotals => {
    let costUsd: number | null = null
    let unpricedEventCount = 0
    let eventCount = 0
    for (const row of rows) {
        if (!row.usage) continue
        if (row.usage.costUsd !== null)
            costUsd = (costUsd ?? 0) + row.usage.costUsd
        unpricedEventCount += row.usage.unpricedEventCount
        eventCount += row.usage.eventCount
    }
    return { costUsd, unpricedEventCount, eventCount }
}
