import type {
    SandboxQuotaTimeseriesPoint,
    SandboxQuotaTimeseriesRange,
    SandboxQuotaUserRow,
    SandboxQuotaUsersPage,
    SandboxQuotasOverview
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import SpritesWholesaleCapSettingsPage from '@/pages/SpritesWholesaleCapSettings'
import { adminRoutes } from '@/routes'
import { Button, Card, Heading } from '@/ui'

const toGb = (bytes: number): string =>
    `${(Math.round((bytes / 1_000_000_000) * 100) / 100).toFixed(2)}`

const formatRelative = (iso: string | null): string => {
    if (!iso) return '—'
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 0) return iso
    const sec = Math.round(ms / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.round(min / 60)
    if (hr < 48) return `${hr}h ago`
    const day = Math.round(hr / 24)
    return `${day}d ago`
}

const ranges: SandboxQuotaTimeseriesRange[] = ['24h', '7d', '30d']

const OverviewCards: FC<{ overview: SandboxQuotasOverview | null }> = ({
    overview
}) => {
    if (!overview) return null
    const ratio =
        overview.wholesaleCap > 0
            ? Math.min(1, overview.orgActive / overview.wholesaleCap)
            : 0
    const softRatio =
        overview.wholesaleCap > 0
            ? overview.softCap / overview.wholesaleCap
            : 0
    const barColor =
        ratio >= 0.95
            ? 'bg-accent-ruby'
            : ratio >= softRatio
              ? 'bg-accent-lemon'
              : 'bg-success'
    return (
        <div className='grid gap-3 md:grid-cols-3 mb-4'>
            <Card elevation='ambient' className='p-3'>
                <div className='text-caption-sm text-body'>
                    Wholesale capacity
                </div>
                <div className='text-body mt-1'>
                    <span className='font-mono'>{overview.orgActive}</span> /{' '}
                    <span className='font-mono'>{overview.wholesaleCap}</span>{' '}
                    active
                </div>
                <div
                    aria-hidden='true'
                    className='mt-2 h-2 w-full rounded-full bg-surface-muted relative'
                >
                    <div
                        className={`h-full rounded-full transition-[width] ${barColor}`}
                        style={{
                            width: `${ratio === 0 ? 0 : Math.max(2, ratio * 100)}%`
                        }}
                    />
                    <div
                        className='absolute top-0 h-full w-0.5 bg-heading/40'
                        style={{ left: `${Math.min(100, softRatio * 100)}%` }}
                        title={`Soft threshold ${overview.softThresholdPct}%`}
                    />
                </div>
                <div className='text-caption-sm text-body mt-1'>
                    Soft threshold:{' '}
                    <span className='font-mono'>
                        {overview.softThresholdPct}%
                    </span>{' '}
                    (cap{' '}
                    <span className='font-mono'>{overview.softCap}</span>)
                </div>
            </Card>
            <Card elevation='ambient' className='p-3'>
                <div className='text-caption-sm text-body'>Provisioned</div>
                <div className='text-body mt-1 font-mono'>
                    {overview.orgProvisioned}
                </div>
                <div className='text-caption-sm text-body mt-2'>
                    Cold{' '}
                    <span className='font-mono'>{overview.orgCold}</span> ·
                    Warm{' '}
                    <span className='font-mono'>{overview.orgWarm}</span> ·
                    Active{' '}
                    <span className='font-mono'>{overview.orgActive}</span>
                </div>
            </Card>
            <Card elevation='ambient' className='p-3'>
                <div className='text-caption-sm text-body'>Total storage</div>
                <div className='text-body mt-1'>
                    <span className='font-mono'>
                        {toGb(overview.orgStorageBytes)}
                    </span>{' '}
                    GB
                </div>
            </Card>
        </div>
    )
}

const TimeseriesChart: FC<{
    points: SandboxQuotaTimeseriesPoint[]
}> = ({ points }) => {
    if (points.length === 0)
        return (
            <p className='text-caption-sm text-body'>
                No snapshots yet. Snapshots accumulate hourly.
            </p>
        )
    const max = Math.max(
        ...points.map((p) => p.orgActive + p.orgWarm + p.orgCold),
        1
    )
    return (
        <div className='flex h-32 items-end gap-0.5'>
            {points.map((p) => {
                const total = p.orgActive + p.orgWarm + p.orgCold
                const heightPct = (total / max) * 100
                const activePct =
                    total > 0 ? (p.orgActive / total) * 100 : 0
                const warmPct = total > 0 ? (p.orgWarm / total) * 100 : 0
                return (
                    <div
                        key={p.at}
                        className='flex-1 flex-col flex-shrink-0'
                        title={`${new Date(p.at).toLocaleString()} · active=${p.orgActive} warm=${p.orgWarm} cold=${p.orgCold}`}
                        style={{ height: `${heightPct}%`, minWidth: 2 }}
                    >
                        <div
                            className='w-full bg-success'
                            style={{ height: `${activePct}%` }}
                        />
                        <div
                            className='w-full bg-accent-lemon'
                            style={{ height: `${warmPct}%` }}
                        />
                        <div
                            className='w-full bg-surface-muted'
                            style={{
                                height: `${100 - activePct - warmPct}%`
                            }}
                        />
                    </div>
                )
            })}
        </div>
    )
}

const SandboxQuotas: FC = (): ReactNode => {
    const client = useApiClient()
    const [overview, setOverview] = useState<SandboxQuotasOverview | null>(
        null
    )
    const [usersPage, setUsersPage] = useState<SandboxQuotaUsersPage | null>(
        null
    )
    const [usersAccum, setUsersAccum] = useState<SandboxQuotaUserRow[]>([])
    const [range, setRange] = useState<SandboxQuotaTimeseriesRange>('24h')
    const [timeseries, setTimeseries] = useState<SandboxQuotaTimeseriesPoint[]>(
        []
    )
    const [error, setError] = useState<string | null>(null)

    const loadOverview = useCallback(async (): Promise<void> => {
        try {
            const next = await client.admin.sandboxQuotas.overview()
            setOverview(next)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [client])

    const loadFirstUsers = useCallback(async (): Promise<void> => {
        try {
            const next = await client.admin.sandboxQuotas.listUsers({
                limit: 50
            })
            setUsersPage(next)
            setUsersAccum(next.users)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [client])

    const loadMore = useCallback(async (): Promise<void> => {
        if (!usersPage?.nextCursor) return
        try {
            const next = await client.admin.sandboxQuotas.listUsers({
                cursor: usersPage.nextCursor,
                limit: 50
            })
            setUsersPage(next)
            setUsersAccum((prev) => [...prev, ...next.users])
        } catch (err) {
            setError((err as Error).message)
        }
    }, [client, usersPage?.nextCursor])

    const loadTimeseries = useCallback(
        async (r: SandboxQuotaTimeseriesRange): Promise<void> => {
            try {
                const next = await client.admin.sandboxQuotas.timeseries(r)
                setTimeseries(next.points)
            } catch (err) {
                setError((err as Error).message)
            }
        },
        [client]
    )

    useEffect(() => {
        void loadOverview()
        void loadFirstUsers()
        const id = setInterval(() => {
            void loadOverview()
        }, 30_000)
        return () => clearInterval(id)
    }, [loadOverview, loadFirstUsers])

    useEffect(() => {
        void loadTimeseries(range)
    }, [loadTimeseries, range])

    const sortedUsers = useMemo(
        () =>
            [...usersAccum].sort(
                (a, b) =>
                    b.concurrentActive - a.concurrentActive ||
                    b.storageBytes - a.storageBytes
            ),
        [usersAccum]
    )

    return (
        <div className='mx-auto max-w-6xl'>
            <Heading level={2} className='mb-2'>
                Sandbox capacity
            </Heading>
            <p className='admin-page-description mb-3'>
                Org-wide sandbox utilization, capacity policy, and per-user
                quota visibility.
            </p>
            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-3 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            <OverviewCards overview={overview} />

            <div className='mb-4 max-w-3xl'>
                <SpritesWholesaleCapSettingsPage
                    embedded
                    onSaved={() => void loadOverview()}
                />
            </div>

            <Card elevation='ambient' className='p-3 mb-4'>
                <div className='mb-2 flex items-center justify-between'>
                    <Heading level={3}>Org sprite state over time</Heading>
                    <div className='flex gap-1'>
                        {ranges.map((r) => (
                            <Button
                                key={r}
                                variant={range === r ? 'primary' : 'ghost'}
                                onClick={() => setRange(r)}
                            >
                                {r}
                            </Button>
                        ))}
                    </div>
                </div>
                <TimeseriesChart points={timeseries} />
                <div className='text-caption-sm text-body mt-2'>
                    Stacked: green = active · amber = warm · soft = cold
                </div>
            </Card>

            <Card elevation='ambient' className='p-3'>
                <Heading level={3} className='mb-2'>
                    Per-user utilization
                </Heading>
                <div className='overflow-x-auto'>
                    <table className='w-full text-caption-sm'>
                        <thead>
                            <tr className='border-border border-b text-left'>
                                <th className='py-2 pr-3'>User</th>
                                <th className='py-2 pr-3'>Plan</th>
                                <th className='py-2 pr-3 text-right'>Active</th>
                                <th className='py-2 pr-3 text-right'>
                                    Provisioned
                                </th>
                                <th className='py-2 pr-3 text-right'>
                                    Storage (GB)
                                </th>
                                <th className='py-2 pr-3 text-right'>
                                    Active hrs (period)
                                </th>
                                <th className='py-2 pr-3'>Last active</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedUsers.map((u) => (
                                <tr
                                    key={u.userId}
                                    className='border-border border-b'
                                >
                                    <td className='py-2 pr-3'>
                                        <Link
                                            to={adminRoutes.accountUser(
                                                u.userId
                                            )}
                                            className='text-brand hover:underline'
                                        >
                                            {u.email || u.userId}
                                        </Link>
                                    </td>
                                    <td className='py-2 pr-3 font-mono'>
                                        {u.planName}
                                    </td>
                                    <td className='py-2 pr-3 text-right font-mono'>
                                        {u.concurrentActive}
                                    </td>
                                    <td className='py-2 pr-3 text-right font-mono'>
                                        {u.provisioned}
                                    </td>
                                    <td className='py-2 pr-3 text-right font-mono'>
                                        {toGb(u.storageBytes)}
                                    </td>
                                    <td className='py-2 pr-3 text-right font-mono'>
                                        {u.activeHoursThisPeriod.toFixed(1)}
                                    </td>
                                    <td className='py-2 pr-3'>
                                        {formatRelative(u.lastActiveAt)}
                                    </td>
                                </tr>
                            ))}
                            {sortedUsers.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={7}
                                        className='text-body py-3 text-center'
                                    >
                                        No users yet.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {usersPage?.nextCursor && (
                    <div className='mt-2 flex justify-center'>
                        <Button
                            variant='ghost'
                            onClick={() => void loadMore()}
                        >
                            Load more
                        </Button>
                    </div>
                )}
            </Card>
        </div>
    )
}

export default SandboxQuotas