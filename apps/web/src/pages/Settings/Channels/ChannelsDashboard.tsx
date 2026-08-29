import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import type { ChannelActivityReport, ChannelSummary } from '@manyfold/shared'
import {
    CardHeader,
    DashboardViewToggle,
    MetaRow
} from '@/components/DashboardCard'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import { relative } from '@/components/RuntimeDetailPanel'
import Breadcrumb from '@/components/Breadcrumb'
import { CreateMenu, type CreateMenuOption } from '@/components/CreateMenu'
import {
    buildChannelActivityRows,
    type ChannelActivityVM
} from '@/lib/channelsDashboardData'
import {
    CHANNEL_DOT,
    ChannelProviderIcon,
    channelLabel
} from '@/lib/channelMeta'
import {
    CHANNELS_DASHBOARD_VIEW_KEY,
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

const ChannelsDashboard: FC<{
    channels: ChannelSummary[]
    report: ChannelActivityReport | null
    loading: boolean
    createOptions: readonly CreateMenuOption[]
    onSelect: (id: string) => void
}> = ({ channels, report, loading, createOptions, onSelect }): ReactNode => {
    const { t } = useI18n()
    const [view, setView] = useState<DashboardView>(() =>
        readDashboardView(CHANNELS_DASHBOARD_VIEW_KEY)
    )
    const changeView = (next: DashboardView): void => {
        setView(next)
        writeDashboardView(CHANNELS_DASHBOARD_VIEW_KEY, next)
    }

    const rows = buildChannelActivityRows(channels, report)
    // The server resolves the window against the deployment's delivery
    // retention, so the label tracks configuration rather than a hardcoded 30.
    const days = report?.windowDays ?? 30
    const messagesLabel = t('web.channelsDashboard.messagesWindow', { days })
    const messagesHint = t('web.channelsDashboard.messagesWindowHint', { days })

    const statusLead = (row: ChannelActivityVM): ReactNode => (
        <span className='flex items-center gap-2'>
            <span
                className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    CHANNEL_DOT[row.channel.status]
                ].join(' ')}
            />
            <ChannelProviderIcon
                provider={row.channel.provider}
                className='h-5 w-5 shrink-0'
            />
        </span>
    )

    // A pending first load ghosts; a failed one shows an em-dash. Rendering 0
    // would claim the channel is quiet, which is a different statement.
    const count = (value: number | null): ReactNode => {
        if (value !== null) return fmt(value)
        return loading ? <Ghost variant='cap' className='w-8' /> : '—'
    }

    const lastMessage = (row: ChannelActivityVM): ReactNode =>
        row.lastMessageAt
            ? relative(row.lastMessageAt)
            : t('web.channelsDashboard.noMessages')

    const statusLabel = (row: ChannelActivityVM): string =>
        t(`web.channels.settings.status.${row.channel.status}`)

    const renderCard = (row: ChannelActivityVM): ReactNode => (
        <button
            key={row.channel.id}
            type='button'
            onClick={() => onSelect(row.channel.id)}
            className='settings-card hover:bg-surface-hover flex flex-col gap-3 p-4 text-left transition-colors'
        >
            <CardHeader
                lead={statusLead(row)}
                label={row.channel.label}
                aside={
                    <span className='tag tag-neutral shrink-0'>
                        {channelLabel(row.channel.provider)}
                    </span>
                }
            />
            <span className='flex flex-col gap-1.5'>
                <MetaRow label={t('web.channels.settings.statusLabel')}>
                    {statusLabel(row)}
                </MetaRow>
                <MetaRow label={messagesLabel}>
                    <span title={messagesHint}>{count(row.messageCount)}</span>
                    {row.inboundCount !== null &&
                        row.outboundCount !== null && (
                            <span className='text-subtle'>
                                {t('web.channelsDashboard.inOut', {
                                    inbound: row.inboundCount,
                                    outbound: row.outboundCount
                                })}
                            </span>
                        )}
                </MetaRow>
                <MetaRow label={t('web.channelsDashboard.lastMessage')}>
                    {lastMessage(row)}
                </MetaRow>
                <MetaRow label={t('web.channels.settings.fields.agent')}>
                    {row.channel.agent.name}
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
                            {t('web.channelsDashboard.colChannel')}
                        </th>
                        <th className={headCell}>
                            {t('web.channels.settings.statusLabel')}
                        </th>
                        <th className={headCellRight} title={messagesHint}>
                            {messagesLabel}
                        </th>
                        <th className={headCell}>
                            {t('web.channelsDashboard.lastMessage')}
                        </th>
                        <th className={headCell}>
                            {t('web.channels.settings.fields.agent')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr
                            key={row.channel.id}
                            onClick={() => onSelect(row.channel.id)}
                            className='hover:bg-surface-hover cursor-pointer transition-colors'
                        >
                            <td className='text-ui text-fg px-4 py-3'>
                                <span className='flex items-center gap-2'>
                                    {statusLead(row)}
                                    <span className='truncate'>
                                        {row.channel.label}
                                    </span>
                                </span>
                            </td>
                            <td className={bodyCell}>{statusLabel(row)}</td>
                            <td
                                className={bodyCellRight}
                                title={
                                    row.inboundCount !== null &&
                                    row.outboundCount !== null
                                        ? t('web.channelsDashboard.inOut', {
                                              inbound: row.inboundCount,
                                              outbound: row.outboundCount
                                          })
                                        : messagesHint
                                }
                            >
                                {count(row.messageCount)}
                            </td>
                            <td className={bodyCell}>{lastMessage(row)}</td>
                            <td className={bodyCell}>
                                {row.channel.agent.name}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )

    return (
        <div className='settings-page'>
            {/* Breadcrumb, not a page title: on mobile the rail is a
                separate screen, so the first crumb is how you get back to
                it. */}
            <div className='mb-4 flex flex-wrap items-center justify-between gap-2'>
                <Breadcrumb
                    items={[
                        {
                            label: t('web.channels.settings.channels'),
                            to: '/settings/channels'
                        },
                        { label: t('web.channelsDashboard.heading') }
                    ]}
                />
                <div className='flex items-center gap-2'>
                    <DashboardViewToggle
                        value={view}
                        onChange={changeView}
                        ariaLabel={t('web.channelsDashboard.heading')}
                    />
                    <CreateMenu
                        options={createOptions}
                        variant='inline'
                        triggerLabel={t('web.channels.settings.newChannel')}
                        sheetTitle={t('web.channels.settings.newChannel')}
                    />
                </div>
            </div>
            {rows.length === 0 ? (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    title={t('web.emptyState.channelsTitle')}
                    body={t('web.emptyState.channelsBody')}
                />
            ) : (
                <>
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

export default ChannelsDashboard
