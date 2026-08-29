import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import type { UserModelProviderSummary } from '@manyfold/shared'
import { lookupBuiltIn } from '@manyfold/shared'
import {
    CardHeader,
    DashboardViewToggle,
    MetaRow
} from '@/components/DashboardCard'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import { relative } from '@/components/RuntimeDetailPanel'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import { PlusIcon } from '@/components/icons'
import {
    MODEL_PROVIDERS_DASHBOARD_VIEW_KEY,
    readDashboardView,
    writeDashboardView,
    type DashboardView
} from '@/lib/dashboardView'
import { useI18n } from '@/lib/i18n'
import {
    buildSpendRows,
    spendTotals,
    totalTokens,
    type SpendRow,
    type SpendWindow
} from '@/lib/modelProviderSpend'
import { fmt, fmtCost, fmtTokens } from '@/lib/usageFormat'
import { BuiltInLogo } from '@/pages/Settings/ModelProviders'

const WINDOWS: SpendWindow[] = ['7d', '30d', 'all']

const pill = (active: boolean): string =>
    [
        'rounded-pill text-caption px-2.5 py-1 transition-colors',
        active
            ? 'bg-strong text-strong-fg'
            : 'bg-surface-subtle text-muted shadow-ring-light hover:text-fg'
    ].join(' ')

const headCell = 'px-4 py-3 font-medium'
const headCellRight = 'px-4 py-3 text-right font-medium'
const bodyCell = 'text-ui text-muted px-4 py-3'
const bodyCellRight = 'text-ui text-muted px-4 py-3 text-right tabular-nums'

const rowLead = (row: SpendRow): ReactNode => {
    const entry = row.provider?.builtInId
        ? lookupBuiltIn(row.provider.builtInId)
        : null
    return (
        <span className='flex h-5 w-5 shrink-0 items-center justify-center'>
            {entry ? (
                <BuiltInLogo entry={entry} />
            ) : (
                <span className='text-caption text-muted font-mono'>
                    {(row.provider?.providerName ?? '?')
                        .charAt(0)
                        .toUpperCase()}
                </span>
            )}
        </span>
    )
}

const ModelProvidersDashboard: FC<{
    providers: UserModelProviderSummary[]
    report: Parameters<typeof buildSpendRows>[1]
    loading: boolean
    window: SpendWindow
    onWindowChange: (next: SpendWindow) => void
    onSelect: (id: string) => void
    onNewProvider: () => void
}> = ({
    providers,
    report,
    loading,
    window: spendWindow,
    onWindowChange,
    onSelect,
    onNewProvider
}): ReactNode => {
    const { t } = useI18n()
    const [view, setView] = useState<DashboardView>(() =>
        readDashboardView(MODEL_PROVIDERS_DASHBOARD_VIEW_KEY)
    )
    const changeView = (next: DashboardView): void => {
        setView(next)
        writeDashboardView(MODEL_PROVIDERS_DASHBOARD_VIEW_KEY, next)
    }

    const rows = buildSpendRows(providers, report)
    const totals = spendTotals(rows)

    const windowLabel = (value: SpendWindow): string => {
        if (value === '7d') return t('web.usage.range7Days')
        if (value === '30d') return t('web.usage.range30Days')
        return t('web.modelProvidersDashboard.windowAll')
    }

    // A pending first load shows a ghost; a failed one shows an em-dash. What
    // it must never show is $0.00, which would read as "you spent nothing".
    const cost = (
        value: number | null,
        usage: SpendRow['usage']
    ): ReactNode => {
        if (!usage)
            return loading ? <Ghost variant='cap' className='w-12' /> : '—'
        return fmtCost(value)
    }

    const unpricedTag = (usage: SpendRow['usage']): ReactNode =>
        usage && usage.unpricedEventCount > 0 ? (
            <span
                className='tag tag-neutral shrink-0'
                title={t('web.modelProvidersDashboard.unpricedHint')}
            >
                {t('web.modelProvidersDashboard.unpriced', {
                    count: usage.unpricedEventCount
                })}
            </span>
        ) : null

    const nameOf = (row: SpendRow): string =>
        row.provider?.providerName ??
        t('web.modelProvidersDashboard.unattributed')

    const renderCard = (row: SpendRow): ReactNode => {
        const body = (
            <>
                <CardHeader
                    lead={rowLead(row)}
                    label={nameOf(row)}
                    aside={unpricedTag(row.usage)}
                />
                <span className='flex flex-col gap-1.5'>
                    <MetaRow label={t('web.modelProvidersDashboard.spend')}>
                        {cost(row.usage?.costUsd ?? null, row.usage)}
                    </MetaRow>
                    <MetaRow label={t('web.modelProvidersDashboard.tokens')}>
                        {row.usage ? fmtTokens(totalTokens(row.usage)) : '—'}
                    </MetaRow>
                    <MetaRow label={t('web.modelProvidersDashboard.requests')}>
                        {row.usage ? fmt(row.usage.eventCount) : '—'}
                    </MetaRow>
                    <MetaRow label={t('web.modelProvidersDashboard.lastUsed')}>
                        {row.usage?.lastUsedAt
                            ? relative(row.usage.lastUsedAt)
                            : t('web.modelProviders.notYetUsed')}
                    </MetaRow>
                </span>
            </>
        )
        const className =
            'settings-card flex flex-col gap-3 p-4 text-left transition-colors'
        // The unattributed group has no provider page to open.
        if (!row.provider)
            return (
                <div
                    key={row.key}
                    className={className}
                    title={t('web.modelProvidersDashboard.unattributedHint')}
                >
                    {body}
                </div>
            )
        return (
            <button
                key={row.key}
                type='button'
                onClick={() => onSelect(row.provider!.id)}
                className={`${className} hover:bg-surface-hover`}
            >
                {body}
            </button>
        )
    }

    const renderTable = (): ReactNode => (
        <div className='settings-card overflow-x-auto'>
            <table className='w-full min-w-[36rem] text-left'>
                <thead className='workbench-table-head'>
                    <tr>
                        <th className={headCell}>
                            {t('web.modelProvidersDashboard.colProvider')}
                        </th>
                        <th className={headCellRight}>
                            {t('web.modelProvidersDashboard.spend')}
                        </th>
                        <th className={headCellRight}>
                            {t('web.modelProvidersDashboard.tokens')}
                        </th>
                        <th className={headCellRight}>
                            {t('web.modelProvidersDashboard.requests')}
                        </th>
                        <th className={headCell}>
                            {t('web.modelProvidersDashboard.lastUsed')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr
                            key={row.key}
                            onClick={
                                row.provider
                                    ? () => onSelect(row.provider!.id)
                                    : undefined
                            }
                            className={
                                row.provider
                                    ? 'hover:bg-surface-hover cursor-pointer transition-colors'
                                    : undefined
                            }
                        >
                            <td className='text-ui text-fg px-4 py-3'>
                                <span className='flex items-center gap-2'>
                                    {rowLead(row)}
                                    <span className='truncate'>
                                        {nameOf(row)}
                                    </span>
                                    {unpricedTag(row.usage)}
                                </span>
                            </td>
                            <td className={bodyCellRight}>
                                {cost(row.usage?.costUsd ?? null, row.usage)}
                            </td>
                            <td className={bodyCellRight}>
                                {row.usage
                                    ? fmtTokens(totalTokens(row.usage))
                                    : '—'}
                            </td>
                            <td className={bodyCellRight}>
                                {row.usage ? fmt(row.usage.eventCount) : '—'}
                            </td>
                            <td className={bodyCell}>
                                {row.usage?.lastUsedAt
                                    ? relative(row.usage.lastUsedAt)
                                    : t('web.modelProviders.notYetUsed')}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                title={t('web.modelProvidersDashboard.heading')}
                actions={
                    <DashboardViewToggle
                        value={view}
                        onChange={changeView}
                        ariaLabel={t('web.modelProvidersDashboard.heading')}
                    />
                }
            />
            <div className='mb-4 flex flex-wrap items-center gap-2'>
                {WINDOWS.map((value) => (
                    <button
                        key={value}
                        type='button'
                        aria-pressed={spendWindow === value}
                        onClick={() => onWindowChange(value)}
                        className={pill(spendWindow === value)}
                    >
                        {windowLabel(value)}
                    </button>
                ))}
                <span className='min-w-2 flex-1' />
                <span className='text-caption text-muted'>
                    {t('web.modelProvidersDashboard.total')}
                </span>
                <span className='text-ui text-fg tabular-nums'>
                    {report ? fmtCost(totals.costUsd) : '—'}
                </span>
                {report && totals.unpricedEventCount > 0 && (
                    <span
                        className='tag tag-neutral'
                        title={t('web.modelProvidersDashboard.unpricedHint')}
                    >
                        {t('web.modelProvidersDashboard.unpriced', {
                            count: totals.unpricedEventCount
                        })}
                    </span>
                )}
                <button
                    type='button'
                    onClick={onNewProvider}
                    className='workbench-button-secondary h-8 gap-1.5 px-3'
                >
                    <PlusIcon className='h-3.5 w-3.5' />
                    {t('web.modelProviders.newProviderButton')}
                </button>
            </div>
            {rows.length === 0 ? (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    title={t('web.modelProviders.emptyTitle')}
                    body={t('web.modelProviders.emptyBody')}
                    action={{
                        label: t('web.modelProviders.newProvider'),
                        onClick: onNewProvider
                    }}
                />
            ) : view === 'grid' ? (
                <div className='grid gap-3 sm:grid-cols-2'>
                    {rows.map(renderCard)}
                </div>
            ) : (
                renderTable()
            )}
        </div>
    )
}

export default ModelProvidersDashboard
