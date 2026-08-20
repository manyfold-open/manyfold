import type {
    AgentSummary,
    UsageBucket,
    UsageEventSummary,
    UsageSummary,
    UsageSummaryByModel,
    UsageTimeSeriesPoint,
    UsageTopAgent
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import { useI18n, type TFn } from '@/lib/i18n'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useApiClient } from '@/lib/apiClient'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import {
    daysAgoIso,
    fmt,
    fmtCost,
    fmtTokens,
    formatHourLabel,
    formatShortDate,
    hoursAgoIso
} from '@/lib/usageFormat'
import UsageEventsTable from '@/components/UsageEventsTable'

type RangeKey = '5h' | '1d' | '7d' | '30d' | '90d'

const RANGES: {
    key: RangeKey
    bucket: UsageBucket
    from: () => string
}[] = [
    { key: '5h', bucket: 'hour', from: () => hoursAgoIso(5) },
    { key: '1d', bucket: 'hour', from: () => hoursAgoIso(24) },
    { key: '7d', bucket: 'day', from: () => daysAgoIso(6) },
    { key: '30d', bucket: 'day', from: () => daysAgoIso(29) },
    { key: '90d', bucket: 'day', from: () => daysAgoIso(89) }
]

const rangeLabel = (range: RangeKey, t: TFn): string => {
    switch (range) {
        case '5h':
            return t('web.usage.range5Hours')
        case '1d':
            return t('web.usage.range24Hours')
        case '7d':
            return t('web.usage.range7Days')
        case '30d':
            return t('web.usage.range30Days')
        case '90d':
            return t('web.usage.range90Days')
    }
}

const RECENT_LIMIT = 6
const CHART_HEIGHT = 132
const Y_AXIS_WIDTH = 48
const Y_AXIS_GAP = 12

const pill = (active: boolean): string =>
    [
        'rounded-pill text-ui px-3 py-1.5 transition-colors',
        active
            ? 'bg-strong text-strong-fg'
            : 'bg-surface-subtle text-muted shadow-ring-light hover:text-fg'
    ].join(' ')

interface ModelRow {
    model: string | null
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    eventCount: number
}

const addCost = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0)

const aggregateByModel = (rows: UsageSummaryByModel[]): ModelRow[] => {
    const byModel = new Map<string, ModelRow>()
    for (const row of rows) {
        const key = row.model ?? 'unknown'
        const current = byModel.get(key)
        if (current) {
            current.inputTokens += row.inputTokens
            current.outputTokens += row.outputTokens
            current.eventCount += row.eventCount
            current.costUsd = addCost(current.costUsd, row.costUsd)
        } else {
            byModel.set(key, {
                model: row.model,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                costUsd: row.costUsd,
                eventCount: row.eventCount
            })
        }
    }
    return [...byModel.values()].sort((a, b) => {
        const byCost = (b.costUsd ?? 0) - (a.costUsd ?? 0)
        if (byCost !== 0) return byCost
        return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
    })
}

const sharePct = (value: number, max: number): number =>
    max > 0 ? (value / max) * 100 : 0

const axisIndexes = (n: number): number[] => {
    if (n <= 1) return [0]
    const raw = [
        0,
        Math.round((n - 1) / 3),
        Math.round((2 * (n - 1)) / 3),
        n - 1
    ]
    return [...new Set(raw)]
}

const ShareBar: FC<{ pct: number }> = ({ pct }) => (
    <div
        className='bg-info/55 mt-1.5 h-[3px] rounded-full'
        style={{ width: `${pct === 0 ? 0 : Math.max(pct, 1.5).toFixed(1)}%` }}
    />
)

const StatCard: FC<{
    label: string
    value: string | null
    loading: boolean
}> = ({ label, value, loading }) => (
    <div className='settings-stat-card'>
        <div className='settings-stat-label'>{label}</div>
        {loading && value === null ? (
            <Ghost variant='title' className='mt-3 w-24' />
        ) : (
            <div className='settings-stat-value'>{value ?? '—'}</div>
        )}
    </div>
)

const UsageChart: FC<{
    points: UsageTimeSeriesPoint[]
    bucket: UsageBucket
}> = ({ points, bucket }): ReactNode => {
    const { t } = useI18n()
    const [mode, setMode] = useState<'tokens' | 'cost'>('tokens')
    if (points.length === 0)
        return (
            <EmptyState
                kind='no-results'
                tier='line'
                body={t('web.emptyState.usageNoActivity')}
                className='py-10 text-center'
            />
        )
    const maxTokens = Math.max(
        1,
        ...points.map((p) => p.inputTokens + p.outputTokens)
    )
    const maxCost = Math.max(0, ...points.map((p) => p.costUsd ?? 0))
    const costMode = mode === 'cost'
    const noCost = costMode && maxCost <= 0
    const axisMax = costMode ? (maxCost > 0 ? maxCost : 1) : maxTokens
    const axisLabel = (v: number): string =>
        costMode ? fmtCost(v) : fmtTokens(v)
    const timeLabel = (iso: string): string =>
        bucket === 'hour' ? formatHourLabel(iso) : formatShortDate(iso)
    const bucketStamp = (iso: string): string =>
        bucket === 'hour'
            ? `${formatShortDate(iso)} ${formatHourLabel(iso)}`
            : formatShortDate(iso)

    return (
        <div>
            <div className='mb-4 flex items-center justify-between gap-3'>
                <div className='flex gap-2'>
                    <button
                        type='button'
                        onClick={() => setMode('tokens')}
                        className={pill(!costMode)}
                    >
                        {t('web.usage.tokens')}
                    </button>
                    <button
                        type='button'
                        onClick={() => setMode('cost')}
                        className={pill(costMode)}
                    >
                        {t('web.usage.cost')}
                    </button>
                </div>
                {!costMode && (
                    <div className='text-caption text-muted flex items-center gap-4'>
                        <span className='flex items-center gap-1.5'>
                            <span className='bg-info inline-block h-2.5 w-2.5 rounded-[2px]' />
                            {t('web.usage.input')}
                        </span>
                        <span className='flex items-center gap-1.5'>
                            <span className='bg-info/40 inline-block h-2.5 w-2.5 rounded-[2px]' />
                            {t('web.usage.output')}
                        </span>
                    </div>
                )}
            </div>

            {noCost ? (
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.emptyState.usageNoCostTitle')}
                    body={t('web.emptyState.usageNoCostBody')}
                />
            ) : (
                <>
                    <div className='flex' style={{ gap: Y_AXIS_GAP }}>
                        <div
                            className='text-caption text-subtle flex shrink-0 flex-col justify-between text-right tabular-nums'
                            style={{
                                height: CHART_HEIGHT,
                                width: Y_AXIS_WIDTH
                            }}
                        >
                            <span>{axisLabel(axisMax)}</span>
                            <span>{axisLabel(axisMax / 2)}</span>
                            <span>0</span>
                        </div>
                        <div
                            className='relative flex-1'
                            style={{ height: CHART_HEIGHT }}
                        >
                            <div className='border-divider/40 absolute inset-x-0 top-0 border-t border-dashed' />
                            <div className='border-divider/40 absolute inset-x-0 top-1/2 border-t border-dashed' />
                            <div className='border-divider absolute inset-x-0 bottom-0 border-t' />
                            <div className='absolute inset-0 flex items-end gap-0.5'>
                                {points.map((point) => {
                                    const title = t('web.usage.chartTooltip', {
                                        date: bucketStamp(point.bucket),
                                        input: fmtTokens(point.inputTokens),
                                        output: fmtTokens(point.outputTokens),
                                        cost: fmtCost(point.costUsd)
                                    })
                                    if (costMode) {
                                        const c = point.costUsd ?? 0
                                        const h =
                                            c > 0
                                                ? Math.max(
                                                      2,
                                                      Math.round(
                                                          (c / axisMax) *
                                                              CHART_HEIGHT
                                                      )
                                                  )
                                                : 0
                                        return (
                                            <ShortcutTooltip
                                                key={point.bucket}
                                                label={title}
                                                placement='top'
                                                className='min-w-0 flex-1'
                                            >
                                                <div
                                                    className='bg-info w-full rounded-t-[3px]'
                                                    style={{
                                                        height: `${h}px`
                                                    }}
                                                />
                                            </ShortcutTooltip>
                                        )
                                    }
                                    const total =
                                        point.inputTokens + point.outputTokens
                                    const totalH =
                                        total > 0
                                            ? Math.max(
                                                  2,
                                                  Math.round(
                                                      (total / maxTokens) *
                                                          CHART_HEIGHT
                                                  )
                                              )
                                            : 0
                                    const inputH =
                                        total > 0
                                            ? Math.round(
                                                  (point.inputTokens / total) *
                                                      totalH
                                              )
                                            : 0
                                    const outputH = Math.max(0, totalH - inputH)
                                    return (
                                        <ShortcutTooltip
                                            key={point.bucket}
                                            label={title}
                                            placement='top'
                                            className='min-w-0 flex-1'
                                        >
                                            <div className='flex w-full flex-col overflow-hidden rounded-t-[3px]'>
                                                <div
                                                    className='bg-info/40 w-full'
                                                    style={{
                                                        height: `${outputH}px`
                                                    }}
                                                />
                                                <div
                                                    className='bg-info w-full'
                                                    style={{
                                                        height: `${inputH}px`
                                                    }}
                                                />
                                            </div>
                                        </ShortcutTooltip>
                                    )
                                })}
                            </div>
                        </div>
                    </div>

                    <div
                        className='text-caption text-subtle mt-2 flex justify-between'
                        style={{ paddingLeft: Y_AXIS_WIDTH + Y_AXIS_GAP }}
                    >
                        {axisIndexes(points.length).map((i) => (
                            <span key={points[i].bucket}>
                                {timeLabel(points[i].bucket)}
                            </span>
                        ))}
                    </div>
                </>
            )}
        </div>
    )
}

const Usage: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [range, setRange] = useState<RangeKey>('30d')
    const activeRange = useMemo(
        () => RANGES.find((r) => r.key === range) ?? RANGES[0],
        [range]
    )
    const from = useMemo(() => activeRange.from(), [activeRange])
    const bucket = activeRange.bucket

    const [summary, setSummary] = useState<UsageSummary | null>(null)
    const [series, setSeries] = useState<UsageTimeSeriesPoint[]>([])
    const [topAgents, setTopAgents] = useState<UsageTopAgent[]>([])
    const [recent, setRecent] = useState<UsageEventSummary[]>([])
    const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map())
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        client.agents
            .list()
            .then((rows) => {
                const names = new Map<string, string>()
                for (const row of rows as AgentSummary[])
                    names.set(row.id, row.name ?? row.id)
                setAgentNames(names)
            })
            .catch(() => {
                // best-effort — recent events fall back to agent id
            })
    }, [client])

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        Promise.all([
            client.usage.summary({ from }),
            client.usage.timeseries({ from, bucket }),
            client.usage.topAgents({ from, limit: 20 }),
            client.usage.events({ from, limit: RECENT_LIMIT })
        ])
            .then(([s, ts, a, ev]) => {
                if (cancelled) return
                setSummary(s)
                setSeries(ts)
                setTopAgents(a)
                setRecent(ev.items)
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, from, bucket])

    const activeRangeLabel = rangeLabel(activeRange.key, t)

    const modelRows = useMemo(
        () => aggregateByModel(summary?.byModel ?? []),
        [summary]
    )
    const modelCostMax = modelRows.reduce(
        (m, row) => Math.max(m, row.costUsd ?? 0),
        0
    )
    const modelTokenMax = modelRows.reduce(
        (m, row) => Math.max(m, row.inputTokens + row.outputTokens),
        0
    )
    const agentCostMax = topAgents.reduce(
        (m, row) => Math.max(m, row.costUsd ?? 0),
        0
    )
    const agentTokenMax = topAgents.reduce(
        (m, row) => Math.max(m, row.inputTokens + row.outputTokens),
        0
    )
    const hasUsage = (summary?.eventCount ?? 0) > 0

    const agentLabel = (id: string | null): string =>
        id ? (agentNames.get(id) ?? id.slice(0, 8)) : '—'

    return (
        <div className='settings-page'>
            <SettingsPageHeader title={t('web.usage.title')} />
            {error && <div className='workbench-alert-error mb-6'>{error}</div>}

            <section className='settings-section'>
                <div className='mb-4 flex items-center justify-between gap-4'>
                    <h2 className='settings-section-label mb-0'>
                        {t('web.usage.overview')}
                    </h2>
                    <div className='flex flex-wrap justify-end gap-2'>
                        {RANGES.map((r) => (
                            <button
                                key={r.key}
                                type='button'
                                onClick={() => setRange(r.key)}
                                className={pill(r.key === range)}
                            >
                                {rangeLabel(r.key, t)}
                            </button>
                        ))}
                    </div>
                </div>
                <div className='settings-stat-grid xl:grid-cols-4'>
                    <StatCard
                        label={t('web.usage.cost')}
                        value={summary ? fmtCost(summary.totalCostUsd) : null}
                        loading={loading}
                    />
                    <StatCard
                        label={t('web.usage.inputTokens')}
                        value={
                            summary ? fmtTokens(summary.totalInputTokens) : null
                        }
                        loading={loading}
                    />
                    <StatCard
                        label={t('web.usage.outputTokens')}
                        value={
                            summary
                                ? fmtTokens(summary.totalOutputTokens)
                                : null
                        }
                        loading={loading}
                    />
                    <StatCard
                        label={t('web.usage.events')}
                        value={summary ? fmt(summary.eventCount) : null}
                        loading={loading}
                    />
                </div>
                {(loading || hasUsage) && (
                    <div className='settings-card mt-4 px-5 py-5'>
                        {loading && series.length === 0 ? (
                            <Ghost variant='block' className='h-28 w-full' />
                        ) : (
                            <UsageChart points={series} bucket={bucket} />
                        )}
                    </div>
                )}
            </section>

            {!loading && !hasUsage && !error && (
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.emptyState.usageRangeTitle', {
                        range: activeRangeLabel
                    })}
                    body={t('web.emptyState.usageRangeBody')}
                />
            )}

            {hasUsage && (
                <section className='settings-section'>
                    <h2 className='settings-section-label'>
                        {t('web.usage.byModel')}
                    </h2>
                    <div className='settings-card overflow-x-auto px-5 py-4'>
                        <table className='w-full text-left'>
                            <thead>
                                <tr className='text-ui text-muted border-b'>
                                    <th className='py-2 font-normal'>
                                        {t('web.usage.model')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.input')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.output')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.cost')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.events')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {modelRows.map((m) => (
                                    <tr
                                        key={m.model ?? 'unknown'}
                                        className='text-ui text-fg border-b last:border-0'
                                    >
                                        <td className='py-2'>
                                            <div className='font-mono text-sm'>
                                                {m.model ?? '—'}
                                            </div>
                                            <ShareBar
                                                pct={
                                                    modelCostMax > 0
                                                        ? sharePct(
                                                              m.costUsd ?? 0,
                                                              modelCostMax
                                                          )
                                                        : sharePct(
                                                              m.inputTokens +
                                                                  m.outputTokens,
                                                              modelTokenMax
                                                          )
                                                }
                                            />
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmtTokens(m.inputTokens)}
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmtTokens(m.outputTokens)}
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmtCost(m.costUsd)}
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmt(m.eventCount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {hasUsage && topAgents.length > 0 && (
                <section className='settings-section'>
                    <h2 className='settings-section-label'>
                        {t('web.usage.byAgent')}
                    </h2>
                    <div className='settings-card overflow-x-auto px-5 py-4'>
                        <table className='w-full text-left'>
                            <thead>
                                <tr className='text-ui text-muted border-b'>
                                    <th className='py-2 font-normal'>
                                        {t('web.usage.agent')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.input')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.output')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.cost')}
                                    </th>
                                    <th className='py-2 text-right font-normal'>
                                        {t('web.usage.events')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {topAgents.map((a) => (
                                    <tr
                                        key={a.agentId}
                                        className='text-ui text-fg border-b last:border-0'
                                    >
                                        <td className='py-2'>
                                            <span className='flex items-center gap-2'>
                                                {a.framework && (
                                                    <ShortcutTooltip
                                                        label={frameworkLabel(
                                                            a.framework
                                                        )}
                                                        className='shrink-0'
                                                    >
                                                        <span className='flex'>
                                                            <FrameworkLogo
                                                                framework={
                                                                    a.framework
                                                                }
                                                                size={18}
                                                            />
                                                        </span>
                                                    </ShortcutTooltip>
                                                )}
                                                <Link
                                                    to={`/agents/${a.agentId}/chat`}
                                                    className='text-link hover:underline'
                                                >
                                                    {a.name ?? a.agentId}
                                                </Link>
                                            </span>
                                            <ShareBar
                                                pct={
                                                    agentCostMax > 0
                                                        ? sharePct(
                                                              a.costUsd ?? 0,
                                                              agentCostMax
                                                          )
                                                        : sharePct(
                                                              a.inputTokens +
                                                                  a.outputTokens,
                                                              agentTokenMax
                                                          )
                                                }
                                            />
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmtTokens(a.inputTokens)}
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmtTokens(a.outputTokens)}
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmtCost(a.costUsd)}
                                        </td>
                                        <td className='py-2 text-right tabular-nums'>
                                            {fmt(a.eventCount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {hasUsage && (
                <section className='settings-section'>
                    <div className='mb-3 flex items-center justify-between gap-4'>
                        <h2 className='settings-section-label mb-0'>
                            {t('web.usage.recentEvents')}
                        </h2>
                        <Link
                            to='/settings/usage/events'
                            className='text-ui text-link hover:underline'
                        >
                            {t('web.usage.viewAllEvents')}
                        </Link>
                    </div>
                    <UsageEventsTable
                        items={recent}
                        resolveAgentName={agentLabel}
                    />
                </section>
            )}
        </div>
    )
}

export default Usage
