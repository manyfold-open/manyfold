import type { AgentFramework, RuntimePlacement } from './constants'

export type CostSource = 'upstream' | 'table' | 'unknown'

export interface ChatUsage {
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    costSource: CostSource
    isFallbackModel?: boolean
    firstTokenMs: number | null
    totalMs: number | null
}

export type UsageBucket = 'hour' | 'day'

export interface UsageQuery {
    from?: string
    to?: string
    framework?: AgentFramework
    runtimeId?: string
    agentId?: string
    sessionId?: string
    userId?: string
}

export interface UsageSummaryByModel {
    model: string | null
    framework: AgentFramework
    runtimeKind: RuntimePlacement
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    eventCount: number
    fallbackEventCount: number
    isFallback: boolean
}

export interface UsageSummary {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheCreationTokens: number
    totalCostUsd: number | null
    eventCount: number
    fallbackEventCount: number
    byModel: UsageSummaryByModel[]
}

export interface UsageTimeSeriesPoint {
    bucket: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    eventCount: number
    fallbackEventCount: number
}

export interface UsageEventSummary {
    id: string
    userId: string
    agentId: string | null
    runtimeId: string | null
    sessionId: string | null
    messageId: string | null
    framework: AgentFramework
    runtimeKind: RuntimePlacement
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    costSource: CostSource
    isFallbackModel: boolean
    firstTokenMs: number | null
    totalMs: number | null
    createdAt: string
}

export interface UsageEventsPage {
    items: UsageEventSummary[]
    nextCursor: string | null
}

export interface UsageTopUser {
    userId: string
    email: string | null
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    eventCount: number
}

export interface UsageTopAgent {
    agentId: string
    name: string | null
    framework: AgentFramework | null
    runtimeKind: RuntimePlacement | null
    userId: string
    userEmail: string | null
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    eventCount: number
}

export interface UsageSessionSummary {
    sessionId: string
    agentId: string | null
    runtimeId: string | null
    framework: AgentFramework
    runtimeKind: RuntimePlacement
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    eventCount: number
    fallbackEventCount: number
    startedAt: string
    lastActivityAt: string
}

// ISO 8601 as the usage filters take it: a date, or a date and a time with an
// optional zone, where a time without one is UTC. Parsed by hand: Date.parse
// takes '1' for 2001, rolls 2026-02-30 into March, and engines differ on the
// rest.
const USAGE_INSTANT =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/

export const parseUsageInstant = (value: string): Date | null => {
    const match = USAGE_INSTANT.exec(value)
    if (!match) return null
    const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '', zone] = match
    const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(
        Number
    )
    if (hour > 23 || minute > 59 || second > 59) return null
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    )
        return null
    date.setUTCHours(
        hour,
        minute,
        second,
        Number(fraction.padEnd(3, '0').slice(0, 3))
    )
    if (!zone || zone === 'Z') return date
    const zoneHours = Number(zone.slice(1, 3))
    const zoneMinutes = Number(zone.slice(-2))
    if (zoneHours > 23 || zoneMinutes > 59) return null
    const offset = (zoneHours * 60 + zoneMinutes) * 60_000
    return new Date(date.getTime() - (zone[0] === '-' ? -offset : offset))
}
