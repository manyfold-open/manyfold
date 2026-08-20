import { apiPaths } from '@manyfold/shared'
import type {
    UsageBucket,
    UsageEventsPage,
    UsageQuery,
    UsageSessionSummary,
    UsageSummary,
    UsageTimeSeriesPoint,
    UsageTopAgent,
    UsageTopUser
} from '@manyfold/shared'

export interface UsageListEventsOptions extends UsageQuery {
    cursor?: string
    limit?: number
}

export interface UsageClient {
    summary: (query?: UsageQuery) => Promise<UsageSummary>
    timeseries: (
        query?: UsageQuery & { bucket?: UsageBucket }
    ) => Promise<UsageTimeSeriesPoint[]>
    events: (query?: UsageListEventsOptions) => Promise<UsageEventsPage>
    sessions: (query?: UsageQuery) => Promise<UsageSessionSummary[]>
    topAgents: (opts?: {
        from?: string
        to?: string
        limit?: number
    }) => Promise<UsageTopAgent[]>
}

export interface AdminUsageClient extends UsageClient {
    topUsers: (opts?: {
        from?: string
        to?: string
        limit?: number
    }) => Promise<UsageTopUser[]>
}

type RequestFn = <T>(path: string) => Promise<T>

const buildQueryString = (q: Record<string, unknown>): string => {
    const parts: string[] = []
    for (const [key, value] of Object.entries(q)) {
        if (value === undefined || value === null || value === '') continue
        parts.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
        )
    }
    return parts.length ? `?${parts.join('&')}` : ''
}

interface UsagePaths {
    summary: string
    timeseries: string
    events: string
    sessions: string
    topAgents: string
}

const buildUsage = (paths: UsagePaths, request: RequestFn): UsageClient => ({
    summary: (query) =>
        request<UsageSummary>(
            `${paths.summary}${buildQueryString((query ?? {}) as Record<string, unknown>)}`
        ),
    timeseries: (query) =>
        request<UsageTimeSeriesPoint[]>(
            `${paths.timeseries}${buildQueryString((query ?? {}) as Record<string, unknown>)}`
        ),
    events: (query) =>
        request<UsageEventsPage>(
            `${paths.events}${buildQueryString((query ?? {}) as Record<string, unknown>)}`
        ),
    sessions: (query) =>
        request<UsageSessionSummary[]>(
            `${paths.sessions}${buildQueryString((query ?? {}) as Record<string, unknown>)}`
        ),
    topAgents: (opts) =>
        request<UsageTopAgent[]>(
            `${paths.topAgents}${buildQueryString((opts ?? {}) as Record<string, unknown>)}`
        )
})

export const buildUsageClient = (request: RequestFn): UsageClient =>
    buildUsage(
        {
            summary: apiPaths.USAGE_SUMMARY,
            timeseries: apiPaths.USAGE_TIMESERIES,
            events: apiPaths.USAGE_EVENTS,
            sessions: apiPaths.USAGE_SESSIONS,
            topAgents: apiPaths.USAGE_TOP_AGENTS
        },
        request
    )

export const buildAdminUsageClient = (
    request: RequestFn
): AdminUsageClient => ({
    ...buildUsage(
        {
            summary: apiPaths.ADMIN_USAGE_SUMMARY,
            timeseries: apiPaths.ADMIN_USAGE_TIMESERIES,
            events: apiPaths.ADMIN_USAGE_EVENTS,
            sessions: apiPaths.ADMIN_USAGE_SESSIONS,
            topAgents: apiPaths.ADMIN_USAGE_TOP_AGENTS
        },
        request
    ),
    topUsers: (opts) =>
        request<UsageTopUser[]>(
            `${apiPaths.ADMIN_USAGE_TOP_USERS}${buildQueryString((opts ?? {}) as Record<string, unknown>)}`
        )
})
