import kleur from 'kleur'
import {
    runtimePlacementLabel,
    type RuntimePlacement,
    type UsageBucket,
    type UsageEventsPage,
    type UsageSessionSummary,
    type UsageSummary,
    type UsageTimeSeriesPoint,
    type UsageTopAgent
} from '@manyfold/shared'
import { ago, plural } from '@/commands/doctor/describe'
import { formatTable } from '@/table'

// Each formatter returns no lines for no rows; the command says so on stderr.

const count = (n: number): string => n.toLocaleString('en-US')

// As the web's usage page shows it. An unknown cost stays unknown, not zero.
const usd = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4
})
const cost = (value: number | null): string =>
    value === null ? 'unknown' : usd.format(value)

const seconds = (ms: number | null): string =>
    ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`

// The column has no constraint in the database, so a kind this CLI does not
// know prints as itself.
const runtimeOf = (kind: RuntimePlacement): string =>
    runtimePlacementLabel(kind) ?? kind

const modelOf = (model: string | null, fallback: boolean): string =>
    `${model ?? '—'}${fallback ? '*' : ''}`

const FALLBACK_NOTE = kleur.dim(
    '* includes events whose runtime reported no model; they are priced as this one, so their cost is an estimate'
)

export const formatSummary = (summary: UsageSummary): string[] => {
    if (summary.eventCount === 0) return []
    const lines = [
        [
            summary.totalCostUsd === null
                ? 'cost unknown'
                : usd.format(summary.totalCostUsd),
            plural(summary.eventCount, 'event'),
            `tokens ${count(summary.totalInputTokens)} in, ${count(summary.totalOutputTokens)} out, ${count(summary.totalCacheReadTokens)} cache read, ${count(summary.totalCacheCreationTokens)} cache write`
        ].join(' · '),
        '',
        ...formatTable(
            [
                'MODEL',
                'FRAMEWORK',
                'RUNTIME',
                'IN',
                'OUT',
                'CACHE READ',
                'COST',
                'EVENTS'
            ],
            summary.byModel.map((row) => [
                modelOf(row.model, row.fallbackEventCount > 0),
                row.framework,
                runtimeOf(row.runtimeKind),
                count(row.inputTokens),
                count(row.outputTokens),
                count(row.cacheReadTokens),
                cost(row.costUsd),
                count(row.eventCount)
            ])
        )
    ]
    if (summary.byModel.some((row) => row.fallbackEventCount > 0))
        lines.push('', FALLBACK_NOTE)
    return lines
}

export const formatTimeseries = (
    points: UsageTimeSeriesPoint[],
    bucket: UsageBucket
): string[] =>
    points.length === 0
        ? []
        : formatTable(
              [
                  bucket === 'hour' ? 'HOUR (UTC)' : 'DAY (UTC)',
                  'IN',
                  'OUT',
                  'CACHE READ',
                  'COST',
                  'EVENTS'
              ],
              points.map((point) => [
                  bucket === 'hour'
                      ? `${point.bucket.slice(0, 10)} ${point.bucket.slice(11, 16)}`
                      : point.bucket.slice(0, 10),
                  count(point.inputTokens),
                  count(point.outputTokens),
                  count(point.cacheReadTokens),
                  cost(point.costUsd),
                  count(point.eventCount)
              ])
          )

export const formatEvents = (page: UsageEventsPage): string[] => {
    if (page.items.length === 0) return []
    const lines = formatTable(
        [
            'TIME (UTC)',
            'FRAMEWORK',
            'MODEL',
            'IN',
            'OUT',
            'CACHE READ',
            'COST',
            'FIRST TOKEN',
            'TOTAL'
        ],
        page.items.map((event) => [
            event.createdAt.slice(0, 19).replace('T', ' '),
            event.framework,
            modelOf(event.model, event.isFallbackModel),
            count(event.inputTokens),
            count(event.outputTokens),
            count(event.cacheReadTokens),
            cost(event.costUsd),
            seconds(event.firstTokenMs),
            seconds(event.totalMs)
        ])
    )
    if (page.items.some((event) => event.isFallbackModel))
        lines.push('', FALLBACK_NOTE)
    return lines
}

export const formatSessions = (
    sessions: UsageSessionSummary[],
    now: number
): string[] =>
    sessions.length === 0
        ? []
        : formatTable(
              [
                  'SESSION',
                  'AGENT',
                  'FRAMEWORK',
                  'IN',
                  'OUT',
                  'COST',
                  'EVENTS',
                  'LAST ACTIVITY'
              ],
              sessions.map((session) => [
                  session.sessionId,
                  session.agentId ?? '—',
                  session.framework,
                  count(session.inputTokens),
                  count(session.outputTokens),
                  cost(session.costUsd),
                  count(session.eventCount),
                  ago(session.lastActivityAt, now) ?? '—'
              ])
          )

export const formatTopAgents = (agents: UsageTopAgent[]): string[] =>
    agents.length === 0
        ? []
        : formatTable(
              ['NAME', 'ID', 'FRAMEWORK', 'IN', 'OUT', 'COST', 'EVENTS'],
              agents.map((agent) => [
                  agent.name ?? '—',
                  agent.agentId,
                  agent.framework ?? '—',
                  count(agent.inputTokens),
                  count(agent.outputTokens),
                  cost(agent.costUsd),
                  count(agent.eventCount)
              ])
          )
