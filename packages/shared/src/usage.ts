import type { AgentFramework, AgentRuntime } from './constants'

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
    runtimeKind: AgentRuntime
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
    runtimeKind: AgentRuntime
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
    runtimeKind: AgentRuntime | null
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
    runtimeKind: AgentRuntime
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
