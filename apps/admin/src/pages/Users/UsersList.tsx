import type { SdkUserSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useTableSort, type SortAccessors } from '@/lib/useTableSort'
import { adminRoutes } from '@/routes'
import { Badge, ButtonLink, Card, Heading, SortHeader } from '@/ui'
import { useManagedBalances } from './useManagedBalances'
import UsersCreditSettingsCard from './UsersCreditSettingsCard'
import { formatCost, formatNumber, roleTone } from './userFormatters'

type UsersSortKey =
    | 'email'
    | 'role'
    | 'planId'
    | 'createdAt'
    | 'lastMessageToAgentAt'

const sortAccessors: SortAccessors<SdkUserSummary, UsersSortKey> = {
    email: (u) => u.email,
    role: (u) => u.role,
    planId: (u) => u.planId,
    createdAt: (u) => u.createdAt,
    lastMessageToAgentAt: (u) => u.lastMessageToAgentAt
}

const UsersList: FC = (): ReactNode => {
    const client = useApiClient()
    const [rows, setRows] = useState<SdkUserSummary[] | null>(null)
    const balances = useManagedBalances()
    const [error, setError] = useState<string | null>(null)

    const sortInput = useMemo(() => rows ?? [], [rows])
    const {
        sorted: sortedRows,
        sortKey,
        direction,
        toggle
    } = useTableSort<SdkUserSummary, UsersSortKey>(
        sortInput,
        sortAccessors,
        'createdAt',
        'desc'
    )

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.users
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client])

    useEffect(refresh, [refresh])

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    {t('admin.users.title')}
                </Heading>
                <p className='admin-page-description max-w-2xl'>
                    {t('admin.users.subtitle')}
                </p>
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

            <UsersCreditSettingsCard />

            {rows === null && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {rows && rows.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description'>
                        {t('admin.users.empty')}
                    </p>
                </div>
            )}

            {rows && rows.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[1200px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                <tr>
                                    <SortHeader
                                        sortKey='email'
                                        activeKey={sortKey}
                                        direction={direction}
                                        onToggle={toggle}
                                    >
                                        {t('admin.users.cols.email')}
                                    </SortHeader>
                                    <SortHeader
                                        sortKey='role'
                                        activeKey={sortKey}
                                        direction={direction}
                                        onToggle={toggle}
                                    >
                                        {t('admin.users.cols.role')}
                                    </SortHeader>
                                    <SortHeader
                                        sortKey='planId'
                                        activeKey={sortKey}
                                        direction={direction}
                                        onToggle={toggle}
                                    >
                                        Plan
                                    </SortHeader>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Runtime usage
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Usage (this period)
                                    </th>
                                    <SortHeader
                                        sortKey='lastMessageToAgentAt'
                                        activeKey={sortKey}
                                        direction={direction}
                                        onToggle={toggle}
                                    >
                                        Last message
                                    </SortHeader>
                                    <SortHeader
                                        sortKey='createdAt'
                                        activeKey={sortKey}
                                        direction={direction}
                                        onToggle={toggle}
                                    >
                                        {t('admin.users.cols.joinedAt')}
                                    </SortHeader>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {sortedRows.map((u) => {
                                    const statefulOver =
                                        u.statefulSandboxUsage >
                                        u.statefulSandboxLimit

                                    return (
                                        <tr
                                            key={u.id}
                                            className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                        >
                                            <td className='px-2 py-1.5 font-mono'>
                                                <Link
                                                    to={adminRoutes.accountUser(
                                                        u.id
                                                    )}
                                                    className='hover:text-brand'
                                                >
                                                    {u.email}
                                                </Link>
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <Badge tone={roleTone[u.role]}>
                                                    {t(
                                                        `admin.users.roles.${u.role}`
                                                    )}
                                                </Badge>
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <span className='text-caption text-heading'>
                                                    {u.planName}
                                                </span>
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <div className='text-caption text-heading'>
                                                    Stateful{' '}
                                                    {u.statefulSandboxUsage}/
                                                    {u.statefulSandboxLimit}
                                                    {statefulOver && (
                                                        <span className='text-accent-ruby'>
                                                            {' '}
                                                            over
                                                        </span>
                                                    )}
                                                </div>
                                                <div className='text-caption-sm text-body'>
                                                    Always-online runtimes{' '}
                                                    {u.alwaysOnlineRuntimesUsed}
                                                    {' · agents '}
                                                    {u.alwaysOnlineAgentsUsed}
                                                    {' · bonus '}
                                                    {u.alwaysOnlineRuntimeBonus}
                                                </div>
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <div className='text-caption text-heading'>
                                                    Spend{' '}
                                                    {formatCost(
                                                        u.monthlyModelSpendUsd
                                                    )}
                                                </div>
                                                <div className='text-caption-sm text-body'>
                                                    API{' '}
                                                    {formatNumber(
                                                        u.monthlyApiRequests
                                                    )}
                                                    /
                                                    {u.monthlyApiRequestLimit ===
                                                    null
                                                        ? '∞'
                                                        : formatNumber(
                                                              u.monthlyApiRequestLimit
                                                          )}
                                                    {balances !== null && (
                                                        <>
                                                            {' · bal '}
                                                            {formatCost(
                                                                balances.get(
                                                                    u.id
                                                                ) ?? null
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                            <td className='tnum px-2 py-1.5'>
                                                {u.lastMessageToAgentAt
                                                    ? new Date(
                                                          u.lastMessageToAgentAt
                                                      ).toLocaleString(
                                                          getLocale()
                                                      )
                                                    : '—'}
                                            </td>
                                            <td className='tnum px-2 py-1.5'>
                                                {new Date(
                                                    u.createdAt
                                                ).toLocaleString(getLocale())}
                                            </td>
                                            <td className='whitespace-nowrap px-2 py-1.5 text-right'>
                                                <ButtonLink
                                                    variant='ghost'
                                                    size='sm'
                                                    to={adminRoutes.accountUser(
                                                        u.id
                                                    )}
                                                >
                                                    View details
                                                </ButtonLink>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}
        </div>
    )
}

export default UsersList
