import type {
    SdkUserSummary,
    UsageSummary,
    UsageTopAgent,
    UsageTopUser
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import type { SdkAgent, SdkUser } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import { Card, CardBody, Heading } from '@/ui'

const RECENT_LIMIT = 5

const sortByCreatedDesc = <T extends { createdAt: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const startOfTodayIso = (): string => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
}

const msAgoIso = (ms: number): string => new Date(Date.now() - ms).toISOString()

type RangeKey = '1h' | 'today' | '24h' | '3d' | '7d' | '30d'

interface RangeOption {
    key: RangeKey
    label: string
    heading: string
    from: () => string
}

const RANGE_OPTIONS: readonly RangeOption[] = [
    {
        key: '1h',
        label: 'Last 1 hour',
        heading: 'last 1 hour',
        from: () => msAgoIso(HOUR_MS)
    },
    {
        key: 'today',
        label: 'Today',
        heading: 'today',
        from: startOfTodayIso
    },
    {
        key: '24h',
        label: 'Last 24 hours',
        heading: 'last 24 hours',
        from: () => msAgoIso(DAY_MS)
    },
    {
        key: '3d',
        label: 'Last 3 days',
        heading: 'last 3 days',
        from: () => msAgoIso(3 * DAY_MS)
    },
    {
        key: '7d',
        label: 'Last 7 days',
        heading: 'last 7 days',
        from: () => msAgoIso(7 * DAY_MS)
    },
    {
        key: '30d',
        label: 'Last 30 days',
        heading: 'last 30 days',
        from: () => msAgoIso(30 * DAY_MS)
    }
] as const

const formatNumber = (n: number): string =>
    new Intl.NumberFormat(getLocale()).format(n)

const formatCost = (n: number | null): string =>
    n === null
        ? '—'
        : new Intl.NumberFormat(getLocale(), {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 2
          }).format(n)

const StatCard: FC<{ label: string; value: ReactNode; sub?: string }> = ({
    label,
    value,
    sub
}): ReactNode => (
    <Card elevation='ambient'>
        <CardBody>
            <p className='text-caption-sm text-body font-normal'>{label}</p>
            <p className='text-h3 text-heading tnum mt-1 font-light'>{value}</p>
            {sub && <p className='text-caption-sm text-body mt-1'>{sub}</p>}
        </CardBody>
    </Card>
)

const Dashboard: FC = (): ReactNode => {
    const client = useApiClient()
    const { isAdmin } = useCurrentUser()
    const [me, setMe] = useState<SdkUser | null>(null)
    const [summary, setSummary] = useState<UsageSummary | null>(null)
    const [topUsers, setTopUsers] = useState<UsageTopUser[]>([])
    const [topAgents, setTopAgents] = useState<UsageTopAgent[]>([])
    const [users, setUsers] = useState<SdkUserSummary[]>([])
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [error, setError] = useState<string | null>(null)
    const [range, setRange] = useState<RangeKey>('1h')
    const activeRange = useMemo(
        () => RANGE_OPTIONS.find((r) => r.key === range) ?? RANGE_OPTIONS[0],
        [range]
    )
    const from = useMemo(() => activeRange.from(), [activeRange])

    useEffect(() => {
        client.auth
            .me()
            .then(setMe)
            .catch((e: Error) => setError(e.message))
    }, [client])

    useEffect(() => {
        const usageApi = isAdmin ? client.admin.usage : client.usage
        usageApi
            .summary({ from })
            .then(setSummary)
            .catch(() => {
                // usage is best-effort on dashboard
            })
        if (isAdmin) {
            client.admin.usage
                .topUsers({ from, limit: 5 })
                .then(setTopUsers)
                .catch(() => {
                    // best-effort
                })
            client.admin.usage
                .topAgents({ from, limit: 5 })
                .then(setTopAgents)
                .catch(() => {
                    // best-effort
                })
            client.admin.users
                .list()
                .then(setUsers)
                .catch(() => {
                    // best-effort
                })
            client.admin.agents
                .list()
                .then(setAgents)
                .catch(() => {
                    // best-effort
                })
        }
    }, [client, isAdmin, from])

    const recentUsers = useMemo(
        () => sortByCreatedDesc(users).slice(0, RECENT_LIMIT),
        [users]
    )
    const recentAgents = useMemo(
        () => sortByCreatedDesc(agents).slice(0, RECENT_LIMIT),
        [agents]
    )
    const userEmailById = useMemo(() => {
        const map: Record<string, string> = {}
        for (const u of users) map[u.id] = u.email
        return map
    }, [users])

    return (
        <div className='mx-auto max-w-none'>
            <Heading level={2} className='mb-2'>
                {t('admin.dashboard.title')}
            </Heading>
            <p className='admin-page-description mb-3'>
                {me
                    ? `${t('admin.dashboard.welcome')}, ${me.email}`
                    : t('common.loading')}
            </p>

            <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
                <Heading level={4}>Usage · {activeRange.heading}</Heading>
                <div className='flex items-center gap-2'>
                    <label
                        htmlFor='dashboard-range-filter'
                        className='text-caption-sm text-label'
                    >
                        Range:
                    </label>
                    <select
                        id='dashboard-range-filter'
                        className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                        value={range}
                        onChange={(e): void =>
                            setRange(e.target.value as RangeKey)
                        }
                    >
                        {RANGE_OPTIONS.map((r) => (
                            <option key={r.key} value={r.key}>
                                {r.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            <div className='mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4'>
                <StatCard
                    label='Input tokens'
                    value={
                        summary ? formatNumber(summary.totalInputTokens) : '—'
                    }
                />
                <StatCard
                    label='Output tokens'
                    value={
                        summary ? formatNumber(summary.totalOutputTokens) : '—'
                    }
                />
                <StatCard
                    label='Cost (USD)'
                    value={summary ? formatCost(summary.totalCostUsd) : '—'}
                />
                <StatCard
                    label='Events'
                    value={summary ? summary.eventCount : '—'}
                />
            </div>

            {isAdmin && topUsers.length > 0 && (
                <div className='mb-3'>
                    <Heading level={4} className='mb-3'>
                        Top users (by cost, {activeRange.heading})
                    </Heading>
                    <Card elevation='ambient' className='overflow-hidden'>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full text-left'>
                                <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                    <tr>
                                        <th className='px-3 py-2 font-normal'>
                                            User
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
                                            Events
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {topUsers.map((u) => (
                                        <tr
                                            key={u.userId}
                                            className='text-caption text-heading'
                                        >
                                            <td className='px-3 py-2 font-mono'>
                                                {u.email ?? u.userId}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(u.inputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(u.outputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatCost(u.costUsd)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {u.eventCount}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </div>
            )}

            {isAdmin && topAgents.length > 0 && (
                <div className='mb-3'>
                    <Heading level={4} className='mb-3'>
                        Top agents (by cost, {activeRange.heading})
                    </Heading>
                    <Card elevation='ambient' className='overflow-hidden'>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full text-left'>
                                <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                    <tr>
                                        <th className='px-3 py-2 font-normal'>
                                            Agent
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Framework
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Owner
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
                                            Events
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {topAgents.map((a) => (
                                        <tr
                                            key={a.agentId}
                                            className='text-caption text-heading'
                                        >
                                            <td className='px-3 py-2'>
                                                <Link
                                                    to={adminRoutes.agent(
                                                        a.agentId
                                                    )}
                                                    className='text-brand hover:text-brand-hover'
                                                >
                                                    {a.name ?? a.agentId}
                                                </Link>
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {a.framework ?? '—'}
                                                {a.runtimeKind
                                                    ? ` · ${a.runtimeKind}`
                                                    : ''}
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {a.userEmail ?? a.userId}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(a.inputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatNumber(a.outputTokens)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {formatCost(a.costUsd)}
                                            </td>
                                            <td className='tnum px-3 py-2 text-right'>
                                                {a.eventCount}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </div>
            )}

            {isAdmin && recentUsers.length > 0 && (
                <div className='mb-3'>
                    <Heading level={4} className='mb-3'>
                        Recent users
                    </Heading>
                    <Card elevation='ambient' className='overflow-hidden'>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full text-left'>
                                <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                    <tr>
                                        <th className='px-3 py-2 font-normal'>
                                            Email
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Role
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Joined
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {recentUsers.map((u) => (
                                        <tr
                                            key={u.id}
                                            className='text-caption text-heading'
                                        >
                                            <td className='px-3 py-2 font-mono'>
                                                <Link
                                                    to={adminRoutes.accountUser(
                                                        u.id
                                                    )}
                                                    className='text-brand hover:text-brand-hover'
                                                >
                                                    {u.email}
                                                </Link>
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {u.role}
                                            </td>
                                            <td className='tnum px-3 py-2'>
                                                {new Date(
                                                    u.createdAt
                                                ).toLocaleString(getLocale())}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </div>
            )}

            {isAdmin && recentAgents.length > 0 && (
                <div className='mb-3'>
                    <Heading level={4} className='mb-3'>
                        Recent agents
                    </Heading>
                    <Card elevation='ambient' className='overflow-hidden'>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full text-left'>
                                <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                    <tr>
                                        <th className='px-3 py-2 font-normal'>
                                            Agent
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Framework
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Owner
                                        </th>
                                        <th className='px-3 py-2 font-normal'>
                                            Created
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {recentAgents.map((a) => (
                                        <tr
                                            key={a.id}
                                            className='text-caption text-heading'
                                        >
                                            <td className='px-3 py-2'>
                                                <Link
                                                    to={adminRoutes.agent(a.id)}
                                                    className='text-brand hover:text-brand-hover'
                                                >
                                                    {a.name}
                                                </Link>
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {a.framework}
                                                {a.runtime
                                                    ? ` · ${a.runtime}`
                                                    : ''}
                                            </td>
                                            <td className='px-3 py-2 font-mono'>
                                                {userEmailById[a.userId] ??
                                                    a.userId}
                                            </td>
                                            <td className='tnum px-3 py-2'>
                                                {new Date(
                                                    a.createdAt
                                                ).toLocaleString(getLocale())}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </div>
            )}

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mt-2'
                >
                    <CardBody>
                        <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                            {error}
                        </pre>
                    </CardBody>
                </Card>
            )}
        </div>
    )
}

export default Dashboard