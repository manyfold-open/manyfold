import type { ApiTokenSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import Breadcrumb from '@/components/Breadcrumb'
import {
    CardHeader,
    DashboardViewToggle,
    MetaRow
} from '@/components/DashboardCard'
import EmptyState from '@/components/EmptyState'
import { PlusIcon } from '@/components/icons'
import { relative } from '@/components/RuntimeDetailPanel'
import {
    API_TOKEN_STATUS_DOT,
    apiTokenExpiryLabel,
    apiTokenStatus,
    apiTokenStatusLabelKey
} from '@/lib/apiTokenStatus'
import {
    API_TOKENS_DASHBOARD_VIEW_KEY,
    readDashboardView,
    writeDashboardView,
    type DashboardView
} from '@/lib/dashboardView'
import { useI18n } from '@/lib/i18n'
import { fmt } from '@/lib/usageFormat'

const headCell = 'px-4 py-3 font-medium'
const headCellRight = 'px-4 py-3 text-right font-medium'
const bodyCell = 'text-ui text-muted px-4 py-3'
const bodyCellRight = 'text-ui text-muted px-4 py-3 text-right tabular-nums'

const ApiTokensDashboard: FC<{
    tokens: ApiTokenSummary[]
    onSelect: (id: string) => void
}> = ({ tokens, onSelect }): ReactNode => {
    const { t } = useI18n()
    const [view, setView] = useState<DashboardView>(() =>
        readDashboardView(API_TOKENS_DASHBOARD_VIEW_KEY)
    )
    const changeView = (next: DashboardView): void => {
        setView(next)
        writeDashboardView(API_TOKENS_DASHBOARD_VIEW_KEY, next)
    }

    const rows = tokens.map((token) => ({
        token,
        status: apiTokenStatus(token)
    }))
    const counts = {
        active: rows.filter((r) => r.status === 'active').length,
        expired: rows.filter((r) => r.status === 'expired').length,
        revoked: rows.filter((r) => r.status === 'revoked').length,
        neverUsed: rows.filter((r) => !r.token.lastUsedAt).length
    }

    const statusLabel = (row: (typeof rows)[number]): string =>
        t(apiTokenStatusLabelKey(row.status))

    const lead = (row: (typeof rows)[number]): ReactNode => (
        <span
            className={[
                'h-2 w-2 shrink-0 rounded-full',
                API_TOKEN_STATUS_DOT[row.status]
            ].join(' ')}
        />
    )

    const lastUsed = (row: (typeof rows)[number]): string =>
        row.token.lastUsedAt
            ? relative(row.token.lastUsedAt)
            : t('web.apiTokens.never')

    // relative() only speaks about the past — it returns an em-dash for any
    // future timestamp, which is every expiry that has not fired yet.
    const expiry = (row: (typeof rows)[number]): string =>
        apiTokenExpiryLabel(row.token, t)

    const renderCard = (row: (typeof rows)[number]): ReactNode => (
        <button
            key={row.token.id}
            type='button'
            onClick={() => onSelect(row.token.id)}
            className='settings-card hover:bg-surface-hover flex flex-col gap-3 p-4 text-left transition-colors'
        >
            <CardHeader
                lead={lead(row)}
                label={row.token.name}
                aside={
                    <span className='tag tag-neutral shrink-0'>
                        {statusLabel(row)}
                    </span>
                }
            />
            <span className='flex flex-col gap-1.5'>
                <MetaRow label={t('web.apiTokens.scopesTitle')}>
                    {fmt(row.token.scopes.length)}
                </MetaRow>
                <MetaRow label={t('web.apiTokens.lastUsed')}>
                    {lastUsed(row)}
                </MetaRow>
                <MetaRow label={t('web.apiTokens.expires')}>
                    {expiry(row)}
                </MetaRow>
            </span>
        </button>
    )

    const renderTable = (): ReactNode => (
        <div className='settings-card overflow-x-auto'>
            <table className='w-full min-w-[36rem] text-left'>
                <thead className='workbench-table-head'>
                    <tr>
                        <th className={headCell}>
                            {t('web.apiTokens.colToken')}
                        </th>
                        <th className={headCell}>
                            {t('web.apiTokens.statusLabel')}
                        </th>
                        <th className={headCellRight}>
                            {t('web.apiTokens.scopesTitle')}
                        </th>
                        <th className={headCell}>
                            {t('web.apiTokens.lastUsed')}
                        </th>
                        <th className={headCell}>
                            {t('web.apiTokens.expires')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr
                            key={row.token.id}
                            onClick={() => onSelect(row.token.id)}
                            className='hover:bg-surface-hover cursor-pointer transition-colors'
                        >
                            <td className='text-ui text-fg px-4 py-3'>
                                <span className='flex items-center gap-2'>
                                    {lead(row)}
                                    <span className='truncate'>
                                        {row.token.name}
                                    </span>
                                </span>
                            </td>
                            <td className={bodyCell}>{statusLabel(row)}</td>
                            <td className={bodyCellRight}>
                                {fmt(row.token.scopes.length)}
                            </td>
                            <td className={bodyCell}>{lastUsed(row)}</td>
                            <td className={bodyCell}>{expiry(row)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )

    return (
        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
            {/* Breadcrumb, not a page title: on mobile the rail is a separate
                screen, so the first crumb is how you get back to it. */}
            <div className='mb-4 flex flex-wrap items-center justify-between gap-2'>
                <Breadcrumb
                    items={[
                        {
                            label: t('web.apiTokens.title'),
                            to: '/settings/api-tokens'
                        },
                        { label: t('web.apiTokens.dashboardHeading') }
                    ]}
                />
                <div className='flex items-center gap-2'>
                    <DashboardViewToggle
                        value={view}
                        onChange={changeView}
                        ariaLabel={t('web.apiTokens.dashboardHeading')}
                    />
                    <Link
                        to='/settings/api-tokens/new'
                        className='workbench-button-secondary h-8 gap-1.5 px-3'
                    >
                        <PlusIcon className='h-3.5 w-3.5' />
                        {t('web.apiTokens.create')}
                    </Link>
                </div>
            </div>

            {rows.length === 0 ? (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    title={t('web.apiTokens.emptyTitle')}
                    body={t('web.apiTokens.emptyBody')}
                />
            ) : (
                <>
                    <div className='mb-4 flex flex-wrap gap-2'>
                        <span className='tag tag-neutral tabular-nums'>
                            {t('web.apiTokens.countActive', {
                                count: counts.active
                            })}
                        </span>
                        {counts.expired > 0 && (
                            <span className='tag tag-neutral tabular-nums'>
                                {t('web.apiTokens.countExpired', {
                                    count: counts.expired
                                })}
                            </span>
                        )}
                        {counts.revoked > 0 && (
                            <span className='tag tag-neutral tabular-nums'>
                                {t('web.apiTokens.countRevoked', {
                                    count: counts.revoked
                                })}
                            </span>
                        )}
                        {counts.neverUsed > 0 && (
                            <span className='tag tag-neutral tabular-nums'>
                                {t('web.apiTokens.countNeverUsed', {
                                    count: counts.neverUsed
                                })}
                            </span>
                        )}
                    </div>
                    {view === 'grid' ? (
                        <div className='grid gap-3 sm:grid-cols-2'>
                            {rows.map(renderCard)}
                        </div>
                    ) : (
                        renderTable()
                    )}
                </>
            )}
        </div>
    )
}

export default ApiTokensDashboard
