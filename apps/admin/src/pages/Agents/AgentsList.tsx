import type {
    AgentFramework,
    AgentRuntimeSummary,
    AgentStatus,
    SdkUserSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import type { SdkAgent } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useTableSort, type SortAccessors } from '@/lib/useTableSort'
import { adminRoutes } from '@/routes'
import { Badge, type BadgeTone, Button, Card, Heading, SortHeader } from '@/ui'

const statusTone: Record<AgentStatus, BadgeTone> = {
    pending: 'warning',
    running: 'success',
    stopped: 'neutral',
    failed: 'error'
}

const ALL_FRAMEWORKS: AgentFramework[] = [
    'claude-code',
    'codex',
    'gemini-cli',
    'openclaw',
    'hermes',
    'narranexus'
]
const ALL_STATUSES: AgentStatus[] = ['pending', 'running', 'stopped', 'failed']

type AgentsSortKey =
    | 'name'
    | 'owner'
    | 'framework'
    | 'model'
    | 'status'
    | 'createdAt'

const AgentsList: FC = (): ReactNode => {
    const client = useApiClient()
    const { isAdmin, loading } = useCurrentUser()
    const [agents, setAgents] = useState<SdkAgent[] | null>(null)
    const [runtimes, setRuntimes] = useState<AgentRuntimeSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [userMap, setUserMap] = useState<Record<string, SdkUserSummary>>({})

    const [frameworkFilter, setFrameworkFilter] = useState<Set<AgentFramework>>(
        new Set()
    )
    const [runtimeFilter, setRuntimeFilter] = useState<string>('')
    const [statusFilter, setStatusFilter] = useState<Set<AgentStatus>>(
        new Set()
    )

    useEffect(() => {
        if (loading) return
        const api = isAdmin ? client.admin.agents : client.agents
        api.list()
            .then(setAgents)
            .catch((e: Error) => setError(e.message))
        const rtApi = isAdmin
            ? client.admin.agentRuntimes
            : client.agentRuntimes
        rtApi
            .list()
            .then(setRuntimes)
            .catch(() => {
                // runtime filter falls back to empty list
            })
    }, [client, isAdmin, loading])

    useEffect(() => {
        if (!isAdmin) return
        client.admin.users
            .list()
            .then((rows) => {
                const map: Record<string, SdkUserSummary> = {}
                for (const u of rows) map[u.id] = u
                setUserMap(map)
            })
            .catch(() => {
                // owner column will fall back to userId
            })
    }, [client, isAdmin])

    const filtered = useMemo(() => {
        if (!agents) return null
        return agents.filter((a) => {
            if (frameworkFilter.size && !frameworkFilter.has(a.framework))
                return false
            if (runtimeFilter && a.runtimeId !== runtimeFilter) return false
            if (statusFilter.size && !statusFilter.has(a.status)) return false
            return true
        })
    }, [agents, frameworkFilter, runtimeFilter, statusFilter])

    const runtimeMap = useMemo(() => {
        const map: Record<string, AgentRuntimeSummary> = {}
        for (const r of runtimes) map[r.id] = r
        return map
    }, [runtimes])

    const sortAccessors = useMemo<SortAccessors<SdkAgent, AgentsSortKey>>(
        () => ({
            name: (a) => a.name,
            owner: (a) => userMap[a.userId]?.email ?? a.userId,
            framework: (a) => a.framework,
            model: (a) => a.model,
            status: (a) => a.status,
            createdAt: (a) => a.createdAt
        }),
        [userMap]
    )

    const sortInput = useMemo(() => filtered ?? [], [filtered])
    const {
        sorted: sortedAgents,
        sortKey,
        direction,
        toggle: toggleSort
    } = useTableSort<SdkAgent, AgentsSortKey>(
        sortInput,
        sortAccessors,
        'createdAt',
        'desc'
    )

    const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
    }

    const filtersActive =
        frameworkFilter.size > 0 ||
        runtimeFilter !== '' ||
        statusFilter.size > 0

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-center justify-between'>
                <Heading level={2}>{t('admin.agents.title')}</Heading>
            </div>

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {agents === null && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {agents && agents.length > 0 && (
                <>
                    <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-2'>
                        <div className='flex flex-wrap items-center gap-2'>
                            <span className='text-caption-sm text-label'>
                                {t('admin.agents.filters.framework')}:
                            </span>
                            {ALL_FRAMEWORKS.map((fw) => {
                                const active = frameworkFilter.has(fw)
                                return (
                                    <button
                                        key={fw}
                                        type='button'
                                        onClick={(): void =>
                                            setFrameworkFilter((s) =>
                                                toggleSet(s, fw)
                                            )
                                        }
                                        className={`text-caption-sm rounded-full border px-2.5 py-0.5 whitespace-nowrap transition-colors ${
                                            active
                                                ? 'border-brand bg-brand-subtle text-brand'
                                                : 'border-border text-body hover:border-brand/40'
                                        }`}
                                    >
                                        {fw}
                                    </button>
                                )
                            })}
                        </div>
                        <div className='flex items-center gap-2'>
                            <label
                                htmlFor='runtime-filter'
                                className='text-caption-sm text-label'
                            >
                                {t('admin.agents.filters.runtime')}:
                            </label>
                            <select
                                id='runtime-filter'
                                className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                                value={runtimeFilter}
                                onChange={(e): void =>
                                    setRuntimeFilter(e.target.value)
                                }
                            >
                                <option value=''>
                                    {t('admin.agents.filters.all')}
                                </option>
                                {runtimes.map((r) => (
                                    <option key={r.id} value={r.id}>
                                        {r.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className='flex flex-wrap items-center gap-2'>
                            <span className='text-caption-sm text-label'>
                                {t('admin.agents.filters.status')}:
                            </span>
                            {ALL_STATUSES.map((s) => {
                                const active = statusFilter.has(s)
                                return (
                                    <button
                                        key={s}
                                        type='button'
                                        onClick={(): void =>
                                            setStatusFilter((cur) =>
                                                toggleSet(cur, s)
                                            )
                                        }
                                        className={`text-caption-sm rounded-full border px-2.5 py-0.5 whitespace-nowrap transition-colors ${
                                            active
                                                ? 'border-brand bg-brand-subtle text-brand'
                                                : 'border-border text-body hover:border-brand/40'
                                        }`}
                                    >
                                        {t(`admin.agents.status.${s}`)}
                                    </button>
                                )
                            })}
                        </div>
                        {filtersActive && (
                            <Button
                                variant='ghost'
                                size='sm'
                                onClick={(): void => {
                                    setFrameworkFilter(new Set())
                                    setRuntimeFilter('')
                                    setStatusFilter(new Set())
                                }}
                            >
                                {t('admin.agents.filters.clear')}
                            </Button>
                        )}
                    </div>

                    {filtered && filtered.length === 0 ? (
                        <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                            <p className='admin-page-description'>
                                {t('common.loading') /* reuse no-rows string */}
                            </p>
                        </div>
                    ) : (
                        <Card elevation='ambient' className='overflow-hidden'>
                            <div className='overflow-x-auto'>
                                <table className='admin-table w-full min-w-[1080px] text-left'>
                                    <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                        <tr>
                                            <SortHeader
                                                sortKey='name'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggleSort}
                                            >
                                                {t('admin.agents.cols.name')}
                                            </SortHeader>
                                            {isAdmin && (
                                                <SortHeader
                                                    sortKey='owner'
                                                    activeKey={sortKey}
                                                    direction={direction}
                                                    onToggle={toggleSort}
                                                >
                                                    {t(
                                                        'admin.agents.cols.owner'
                                                    )}
                                                </SortHeader>
                                            )}
                                            <SortHeader
                                                sortKey='framework'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggleSort}
                                            >
                                                {t(
                                                    'admin.agents.cols.framework'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='model'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggleSort}
                                            >
                                                {t('admin.agents.cols.model')}
                                            </SortHeader>
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t('admin.agents.cols.cluster')}
                                            </th>
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t('admin.agents.cols.runtime')}
                                            </th>
                                            <SortHeader
                                                sortKey='status'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggleSort}
                                            >
                                                {t('admin.agents.cols.status')}
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='createdAt'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggleSort}
                                            >
                                                {t(
                                                    'admin.agents.cols.createdAt'
                                                )}
                                            </SortHeader>
                                        </tr>
                                    </thead>
                                    <tbody className='divide-border divide-y'>
                                        {sortedAgents.map((a) => (
                                            <tr
                                                key={a.id}
                                                className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                            >
                                                <td className='px-2 py-1.5'>
                                                    <Link
                                                        to={adminRoutes.agent(
                                                            a.id
                                                        )}
                                                        className='text-brand hover:text-brand-hover block'
                                                    >
                                                        {a.name}
                                                        <div className='text-caption-sm text-body mt-1 font-mono'>
                                                            {a.internalId}
                                                        </div>
                                                    </Link>
                                                </td>
                                                {isAdmin && (
                                                    <td className='px-2 py-1.5 font-mono'>
                                                        {userMap[a.userId]
                                                            ?.email ?? a.userId}
                                                    </td>
                                                )}
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {a.framework}
                                                </td>
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {a.model ?? '—'}
                                                </td>
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {a.runtime === 'k8s'
                                                        ? (a.clusterName ??
                                                          (a.clusterId
                                                              ? `${a.clusterId} (deleted)`
                                                              : '—'))
                                                        : '—'}
                                                </td>
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {a.runtimeId ? (
                                                        <Link
                                                            to={adminRoutes.runtime(
                                                                a.runtimeId
                                                            )}
                                                            className='text-brand hover:text-brand-hover block'
                                                        >
                                                            <div>
                                                                {runtimeMap[
                                                                    a.runtimeId
                                                                ]?.name ?? '—'}
                                                            </div>
                                                            <div className='text-caption-sm text-body mt-1'>
                                                                {a.runtimeId}
                                                            </div>
                                                        </Link>
                                                    ) : (
                                                        <span className='text-body'>
                                                            —
                                                        </span>
                                                    )}
                                                </td>
                                                <td className='px-2 py-1.5'>
                                                    <Badge
                                                        tone={
                                                            statusTone[a.status]
                                                        }
                                                    >
                                                        {t(
                                                            `admin.agents.status.${a.status}`
                                                        )}
                                                    </Badge>
                                                </td>
                                                <td className='tnum px-2 py-1.5'>
                                                    {new Date(
                                                        a.createdAt
                                                    ).toLocaleString(
                                                        getLocale()
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    )}
                </>
            )}

            {agents && agents.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description'>
                        {t('admin.agents.empty')}
                    </p>
                </div>
            )}
        </div>
    )
}

export default AgentsList