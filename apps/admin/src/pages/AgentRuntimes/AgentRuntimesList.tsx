import { isExternal } from '@manyfold/shared'
import type {
    AgentRuntimeStatus,
    AgentRuntimeSummary,
    SdkUserSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useTableSort, type SortAccessors } from '@/lib/useTableSort'
import { adminRoutes } from '@/routes'
import {
    Badge,
    Button,
    ButtonLink,
    Card,
    Heading,
    SortHeader,
    type BadgeTone
} from '@/ui'

const statusTone: Record<AgentRuntimeStatus, BadgeTone> = {
    pending: 'warning',
    ready: 'success',
    failed: 'error',
    stopped: 'neutral'
}

type RuntimesSortKey =
    | 'name'
    | 'framework'
    | 'kind'
    | 'status'
    | 'agents'
    | 'createdAt'

const sortAccessors: SortAccessors<AgentRuntimeSummary, RuntimesSortKey> = {
    name: (r) => r.name,
    framework: (r) => r.framework,
    kind: (r) => r.kind,
    status: (r) => r.status,
    agents: (r) => r.agentsCount,
    createdAt: (r) => r.createdAt
}

const AgentRuntimesList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const { isAdmin, loading } = useCurrentUser()
    const [rows, setRows] = useState<AgentRuntimeSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [userMap, setUserMap] = useState<Record<string, SdkUserSummary>>({})
    const [busyId, setBusyId] = useState<string | null>(null)
    const [keepAliveBusyId, setKeepAliveBusyId] = useState<string | null>(null)
    const [ownerFilter, setOwnerFilter] = useState<string>('')

    const refresh = useCallback((): void => {
        if (loading) return
        setError(null)
        const api = isAdmin ? client.admin.agentRuntimes : client.agentRuntimes
        api.list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client, isAdmin, loading])

    useEffect(refresh, [refresh])

    useEffect(() => {
        if (!isAdmin) return
        client.admin.users
            .list()
            .then((list) => {
                const map: Record<string, SdkUserSummary> = {}
                for (const u of list) map[u.id] = u
                setUserMap(map)
            })
            .catch(() => {
                // owner column falls back to userId
            })
    }, [client, isAdmin])

    const onDelete = async (row: AgentRuntimeSummary): Promise<void> => {
        if (!window.confirm(t('admin.agentRuntimes.actions.deleteConfirm')))
            return
        setBusyId(row.id)
        try {
            const api = isAdmin
                ? client.admin.agentRuntimes
                : client.agentRuntimes
            await api.delete(row.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const supportsKeepAlive = (row: AgentRuntimeSummary): boolean =>
        row.kind === 'sprites' && !isExternal(row.framework)

    const onToggleKeepAlive = async (
        row: AgentRuntimeSummary
    ): Promise<void> => {
        setKeepAliveBusyId(row.id)
        setError(null)
        try {
            const api = isAdmin
                ? client.admin.agentRuntimes
                : client.agentRuntimes
            const next = await api.setKeepAlive(row.id, !row.keepAliveEnabled)
            setRows((prev) =>
                prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev
            )
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setKeepAliveBusyId(null)
        }
    }

    const locationOf = (row: AgentRuntimeSummary): string => {
        if (row.kind === 'sprites') return row.spriteName ?? '—'
        if (row.kind === 'k8s') return row.ingressHost ?? row.namespace ?? '—'
        return '—'
    }

    const ownerOptions = useMemo(() => {
        if (!rows) return [] as Array<{ id: string; label: string }>
        const seen = new Set<string>()
        const options: Array<{ id: string; label: string }> = []
        for (const r of rows) {
            if (seen.has(r.userId)) continue
            seen.add(r.userId)
            options.push({
                id: r.userId,
                label: userMap[r.userId]?.email ?? r.userId
            })
        }
        return options.sort((a, b) => a.label.localeCompare(b.label))
    }, [rows, userMap])

    const filteredRows = useMemo(() => {
        if (!rows) return [] as AgentRuntimeSummary[]
        if (!ownerFilter) return rows
        return rows.filter((r) => r.userId === ownerFilter)
    }, [rows, ownerFilter])

    const {
        sorted: sortedRows,
        sortKey,
        direction,
        toggle
    } = useTableSort<AgentRuntimeSummary, RuntimesSortKey>(
        filteredRows,
        sortAccessors,
        'createdAt',
        'desc'
    )

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-2'>
                        {t('admin.agentRuntimes.title')}
                    </Heading>
                    <p className='admin-page-description max-w-2xl'>
                        {t('admin.agentRuntimes.subtitle')}
                    </p>
                </div>
                <ButtonLink variant='primary' to={adminRoutes.agentNew}>
                    {t('admin.agentRuntimes.newButton')}
                </ButtonLink>
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

            {rows === null && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {rows && rows.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description mb-2'>
                        {t('admin.agentRuntimes.empty')}
                    </p>
                    <ButtonLink variant='primary' to={adminRoutes.agentNew}>
                        {t('admin.agentRuntimes.newButton')}
                    </ButtonLink>
                </div>
            )}

            {rows && rows.length > 0 && (
                <>
                    {isAdmin && (
                        <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-2'>
                            <label
                                htmlFor='runtime-owner-filter'
                                className='text-caption-sm text-label'
                            >
                                {t('admin.agentRuntimes.cols.owner')}:
                            </label>
                            <select
                                id='runtime-owner-filter'
                                className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                                value={ownerFilter}
                                onChange={(e): void =>
                                    setOwnerFilter(e.target.value)
                                }
                            >
                                <option value=''>
                                    {t('admin.agents.filters.all')}
                                </option>
                                {ownerOptions.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                            {ownerFilter && (
                                <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={(): void => setOwnerFilter('')}
                                >
                                    {t('admin.agents.filters.clear')}
                                </Button>
                            )}
                        </div>
                    )}
                    <Card elevation='ambient' className='overflow-hidden'>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full min-w-[1200px] text-left'>
                                <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b tracking-wider uppercase'>
                                    <tr>
                                        <SortHeader
                                            sortKey='name'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            {t('admin.agentRuntimes.cols.name')}
                                        </SortHeader>
                                        {isAdmin && (
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t(
                                                    'admin.agentRuntimes.cols.owner'
                                                )}
                                            </th>
                                        )}
                                        <SortHeader
                                            sortKey='framework'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            {t(
                                                'admin.agentRuntimes.cols.framework'
                                            )}
                                        </SortHeader>
                                        <SortHeader
                                            sortKey='kind'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            {t('admin.agentRuntimes.cols.kind')}
                                        </SortHeader>
                                        <SortHeader
                                            sortKey='status'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            {t(
                                                'admin.agentRuntimes.cols.status'
                                            )}
                                        </SortHeader>
                                        <SortHeader
                                            sortKey='agents'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            {t(
                                                'admin.agentRuntimes.cols.agents'
                                            )}
                                        </SortHeader>
                                        <th className='px-2 py-1.5 font-normal'>
                                            {t(
                                                'admin.agentRuntimes.cols.keepAlive'
                                            )}
                                        </th>
                                        <th className='px-2 py-1.5 font-normal'>
                                            {t(
                                                'admin.agentRuntimes.cols.location'
                                            )}
                                        </th>
                                        <SortHeader
                                            sortKey='createdAt'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            {t(
                                                'admin.agentRuntimes.cols.createdAt'
                                            )}
                                        </SortHeader>
                                        <th className='px-2 py-1.5 text-right font-normal' />
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {sortedRows.map((r) => (
                                    <tr
                                        key={r.id}
                                        className='text-caption text-heading hover:bg-surface-muted cursor-pointer transition-colors'
                                        onClick={(): void =>
                                            navigate(adminRoutes.runtime(r.id))
                                        }
                                    >
                                        <td className='px-2 py-1.5'>
                                            {r.name}
                                            <div className='text-caption-sm text-body mt-1 font-mono'>
                                                {r.id}
                                            </div>
                                        </td>
                                        {isAdmin && (
                                            <td className='px-2 py-1.5 font-mono'>
                                                {userMap[r.userId]?.email ??
                                                    r.userId}
                                            </td>
                                        )}
                                        <td className='px-2 py-1.5 font-mono'>
                                            {r.framework}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            {t(
                                                `admin.agentRuntimes.kind.${r.kind}`
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge tone={statusTone[r.status]}>
                                                {t(
                                                    `admin.agentRuntimes.status.${r.status}`
                                                )}
                                            </Badge>
                                            {r.failureReason && (
                                                <p className='text-caption-sm text-accent-ruby mt-1 max-w-md truncate font-mono'>
                                                    {r.failureReason}
                                                </p>
                                            )}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            <span className='text-brand hover:text-brand-hover'>
                                                {r.agentsCount}
                                            </span>
                                        </td>
                                        <td
                                            className='px-2 py-1.5 whitespace-nowrap'
                                            onClick={(e): void => {
                                                e.stopPropagation()
                                            }}
                                        >
                                            {supportsKeepAlive(r) ? (
                                                <div className='flex items-center gap-2'>
                                                    <Badge
                                                        tone={
                                                            r.keepAliveEnabled
                                                                ? 'success'
                                                                : 'neutral'
                                                        }
                                                    >
                                                        {r.keepAliveEnabled
                                                            ? 'on'
                                                            : 'off'}
                                                    </Badge>
                                                    <Button
                                                        variant='neutral'
                                                        size='sm'
                                                        disabled={
                                                            keepAliveBusyId ===
                                                            r.id
                                                        }
                                                        onClick={(): void => {
                                                            void onToggleKeepAlive(
                                                                r
                                                            )
                                                        }}
                                                    >
                                                        {keepAliveBusyId === r.id
                                                            ? t(
                                                                  'admin.agentRuntimes.actions.keepAliveSaving'
                                                              )
                                                            : r.keepAliveEnabled
                                                              ? t(
                                                                    'admin.agentRuntimes.actions.keepAliveDisable'
                                                                )
                                                              : t(
                                                                    'admin.agentRuntimes.actions.keepAliveEnable'
                                                                )}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <span className='text-body'>
                                                    —
                                                </span>
                                            )}
                                        </td>
                                        <td className='max-w-xs truncate px-2 py-1.5 font-mono'>
                                            {locationOf(r)}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {new Date(
                                                r.createdAt
                                            ).toLocaleString(getLocale())}
                                        </td>
                                        <td
                                            className='px-2 py-1.5 text-right whitespace-nowrap'
                                            onClick={(e): void => {
                                                e.stopPropagation()
                                            }}
                                        >
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                disabled={busyId === r.id}
                                                onClick={(): void => {
                                                    void onDelete(r)
                                                }}
                                            >
                                                {t(
                                                    'admin.agentRuntimes.actions.delete'
                                                )}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>
                </>
            )}
        </div>
    )
}

export default AgentRuntimesList