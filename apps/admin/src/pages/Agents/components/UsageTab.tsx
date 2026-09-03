import type {
    UsageEventSummary,
    UsageSummary,
    UsageTimeSeriesPoint
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getLocale } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { Card, CardBody, Heading } from '@/ui'

interface UsageTabProps {
    scope: 'agent' | 'runtime'
    id: string
}

const daysAgoIso = (days: number): string => {
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString()
}

const formatNumber = (n: number): string =>
    new Intl.NumberFormat(getLocale()).format(n)

const formatCost = (n: number | null): string =>
    n === null
        ? '—'
        : new Intl.NumberFormat(getLocale(), {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 4
          }).format(n)

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleString(getLocale())

const StatBox: FC<{ label: string; value: ReactNode; mono?: boolean }> = ({
    label,
    value,
    mono
}): ReactNode => (
    <div className='border-border rounded-md border px-2 py-1.5'>
        <dt className='text-caption-sm text-body font-normal'>{label}</dt>
        <dd
            className={[
                'text-body text-heading tnum mt-1',
                mono ? 'font-mono' : ''
            ].join(' ')}
        >
            {value}
        </dd>
    </div>
)

const BarChart: FC<{ points: UsageTimeSeriesPoint[] }> = ({
    points
}): ReactNode => {
    const max = Math.max(
        1,
        ...points.map((p) => p.inputTokens + p.outputTokens)
    )
    const width = 560
    const barW = Math.max(6, Math.floor(width / Math.max(1, points.length)) - 4)
    const height = 120
    return (
        <svg
            width='100%'
            viewBox={`0 0 ${width} ${height + 24}`}
            preserveAspectRatio='xMidYMid meet'
            className='mt-2'
        >
            {points.map((p, i) => {
                const total = p.inputTokens + p.outputTokens
                const h = Math.round((total / max) * height)
                const x = i * (barW + 4)
                const y = height - h
                return (
                    <g key={p.bucket}>
                        <rect
                            x={x}
                            y={y}
                            width={barW}
                            height={h}
                            fill='#533afd'
                            opacity={0.85}
                        >
                            <title>
                                {new Date(p.bucket).toLocaleDateString(
                                    getLocale()
                                )}{' '}
                                · in {formatNumber(p.inputTokens)} · out{' '}
                                {formatNumber(p.outputTokens)}
                            </title>
                        </rect>
                    </g>
                )
            })}
        </svg>
    )
}

const UsageTab: FC<UsageTabProps> = ({ scope, id }): ReactNode => {
    const client = useApiClient()
    const { isAdmin, loading: userLoading } = useCurrentUser()
    const api = useMemo(
        () => (isAdmin ? client.admin.usage : client.usage),
        [client, isAdmin]
    )
    const from = useMemo(() => daysAgoIso(6), [])
    const query = useMemo(
        () => ({
            from,
            ...(scope === 'agent' ? { agentId: id } : { runtimeId: id })
        }),
        [from, scope, id]
    )

    const [summary, setSummary] = useState<UsageSummary | null>(null)
    const [series, setSeries] = useState<UsageTimeSeriesPoint[]>([])
    const [events, setEvents] = useState<UsageEventSummary[]>([])
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (userLoading) return
        setError(null)
        Promise.all([
            api.summary(query),
            api.timeseries({ ...query, bucket: 'day' }),
            api.events({ ...query, limit: 50 })
        ])
            .then(([s, ts, ev]) => {
                setSummary(s)
                setSeries(ts)
                setEvents(ev.items)
            })
            .catch((e: Error) => setError(e.message))
    }, [api, query, userLoading])

    if (error)
        return (
            <Card
                elevation='flat'
                className='border-accent-ruby/30 bg-accent-ruby/5 p-2'
            >
                <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                    {error}
                </pre>
            </Card>
        )

    return (
        <div className='space-y-2'>
            <Card elevation='ambient'>
                <CardBody>
                    <Heading level={3} className='mb-2'>
                        Usage (last 7 days)
                    </Heading>
                    <dl className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                        <StatBox
                            label='Input tokens'
                            value={
                                summary
                                    ? formatNumber(summary.totalInputTokens)
                                    : '—'
                            }
                        />
                        <StatBox
                            label='Output tokens'
                            value={
                                summary
                                    ? formatNumber(summary.totalOutputTokens)
                                    : '—'
                            }
                        />
                        <StatBox
                            label='Cost'
                            value={
                                summary ? formatCost(summary.totalCostUsd) : '—'
                            }
                        />
                        <StatBox
                            label='Events'
                            value={summary ? summary.eventCount : '—'}
                        />
                    </dl>
                    {series.length > 0 && <BarChart points={series} />}
                </CardBody>
            </Card>

            {summary && summary.byModel.length > 0 && (
                <Card elevation='ambient'>
                    <CardBody>
                        <Heading level={4} className='mb-3'>
                            By model
                        </Heading>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full text-left'>
                                <thead className='border-border text-caption-sm text-body border-b'>
                                    <tr>
                                        <th className='px-3 py-2 font-normal'>
                                            Model
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Framework
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Input
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Output
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Cache r/w
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Cost
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Events
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {summary.byModel.map((m) => (
                                        <tr
                                            key={`${m.framework}:${m.runtimeKind}:${m.model ?? 'unknown'}`}
                                            className='text-caption text-heading'
                                        >
                                            <td className='px-3 py-2 font-mono'>
                                                {m.model ?? '—'}
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {m.framework}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(m.inputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(m.outputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(
                                                    m.cacheReadTokens
                                                )}
                                                {' / '}
                                                {formatNumber(
                                                    m.cacheCreationTokens
                                                )}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatCost(m.costUsd)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {m.eventCount}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </CardBody>
                </Card>
            )}

            <Card elevation='ambient'>
                <CardBody>
                    <Heading level={4} className='mb-3'>
                        Recent events
                    </Heading>
                    {events.length === 0 ? (
                        <p className='text-caption text-body'>No events yet.</p>
                    ) : (
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full text-left'>
                                <thead className='border-border text-caption-sm text-body border-b'>
                                    <tr>
                                        <th className='px-3 py-2 font-normal'>
                                            Time
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Model
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Input
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Output
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Cost
                                        </th>
                                        <th className='px-3 py-2 text-right font-normal'>
                                            Latency
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {events.map((e) => (
                                        <tr
                                            key={e.id}
                                            className='text-caption text-heading'
                                        >
                                            <td className='tnum px-3 py-2'>
                                                {formatDate(e.createdAt)}
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {e.model ?? '—'}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(e.inputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(e.outputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatCost(e.costUsd)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {e.totalMs !== null
                                                    ? `${e.totalMs}ms`
                                                    : '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardBody>
            </Card>
        </div>
    )
}

export default UsageTab
