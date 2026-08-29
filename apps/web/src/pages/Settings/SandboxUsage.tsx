import type {
    SandboxUsageBreakdown,
    SandboxUsageHost
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import { useApiClient } from '@/lib/apiClient'
import { useI18n, type TFn } from '@/lib/i18n'
import { frameworkLabel, FrameworkLogo } from '@/lib/frameworkMeta'
import {
    fmt,
    formatDuration,
    formatLocalDateTime,
    usagePeriodLine
} from '@/lib/usageFormat'
import {
    formatBytesDecimal,
    hostStorageRows,
    sharePct,
    type SandboxStorageRow
} from '@/lib/sandboxUsageRows'
import { BILLING_SURFACE } from '@/edition-capabilities'

const BYTES_PER_GB = 1_000_000_000

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

const storageGbLabel = (bytes: number): string =>
    `${(Math.round((bytes / BYTES_PER_GB) * 100) / 100).toFixed(2)} GB`

const activeHoursLabel = (seconds: number): string =>
    `${fmt(Math.round((seconds / 3600) * 10) / 10)} h`

const rowLabel = (row: SandboxStorageRow, t: TFn): string => {
    if (row.kind === 'other') return t('web.sandboxUsage.systemOther')
    if (row.kind === 'home' && row.framework)
        return frameworkLabel(row.framework)
    return row.label
}

const StorageRow: FC<{ row: SandboxStorageRow }> = ({ row }) => {
    const { t } = useI18n()
    return (
        <tr className='text-ui border-divider/60 border-t'>
            <td className='px-4 py-3'>
                <div className='flex items-center gap-2'>
                    {row.framework && (
                        <FrameworkLogo framework={row.framework} size={16} />
                    )}
                    <span className={row.kind === 'other' ? 'text-muted' : ''}>
                        {rowLabel(row, t)}
                    </span>
                    {row.kind === 'workspace' && (
                        <span className='text-caption text-subtle'>
                            {t('web.sandboxUsage.tagWorkspace')}
                        </span>
                    )}
                    {row.kind === 'home' && (
                        <span className='text-caption text-subtle'>
                            {t('web.sandboxUsage.tagHomeShared')}
                        </span>
                    )}
                </div>
            </td>
            <td className='text-muted px-4 py-3 text-right font-mono tabular-nums'>
                {formatBytesDecimal(row.bytes)}
            </td>
            <td className='w-32 px-4 py-3'>
                <ShareBar pct={row.pct} />
            </td>
        </tr>
    )
}

const HostStorageCard: FC<{ host: SandboxUsageHost }> = ({ host }) => {
    const { t } = useI18n()
    const rows = hostStorageRows(host)
    const measured = host.storageMeasured
    return (
        <div className='settings-card mb-4 overflow-x-auto'>
            <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pb-2 pt-4'>
                <div className='flex items-baseline gap-2'>
                    <span className='text-ui text-fg font-medium'>
                        {host.name}
                    </span>
                    {host.spriteStatus && (
                        <span className='text-caption text-subtle'>
                            {host.spriteStatus}
                        </span>
                    )}
                </div>
                <div className='text-caption text-muted font-mono tabular-nums'>
                    {t('web.sandboxUsage.vmDiskUsed', {
                        value: formatBytesDecimal(host.storageBytes)
                    })}
                    {host.storageMeasuredAt
                        ? ` · ${t('web.sandboxUsage.measuredAt', {
                              time: formatLocalDateTime(host.storageMeasuredAt)
                          })}`
                        : ''}
                </div>
            </div>
            {measured ? (
                <table className='w-full min-w-[28rem] text-left'>
                    <tbody>
                        {rows.map((row) => (
                            <StorageRow key={row.key} row={row} />
                        ))}
                    </tbody>
                </table>
            ) : (
                <div className='text-ui text-muted border-divider/60 border-t px-4 py-3'>
                    {t('web.sandboxUsage.notMeasured')}
                </div>
            )}
        </div>
    )
}

const GHOST_ROWS = [0, 1, 2]

const hoursGhostRows = (): ReactNode =>
    GHOST_ROWS.map((row) => (
        <tr key={`ghost-${row}`} className='border-divider/60 border-t'>
            <td className='px-4 py-3'>
                <Ghost variant='cap' className='w-28' />
            </td>
            <td className='px-4 py-3'>
                <Ghost variant='cap' className='w-14' />
            </td>
            <td className='px-4 py-3'>
                <Ghost variant='cap' className='w-16' />
            </td>
            <td className='px-4 py-3'>
                <Ghost variant='cap' className='w-20' />
            </td>
        </tr>
    ))

const SandboxUsage: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [data, setData] = useState<SandboxUsageBreakdown | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true)
        setError(null)
        try {
            setData(await client.runtimeAccess.sandboxUsage())
        } catch (e) {
            setData(null)
            setError((e as Error).message)
        } finally {
            setLoading(false)
        }
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const empty =
        data !== null &&
        data.hosts.length === 0 &&
        data.deletedHosts.length === 0

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                breadcrumb={[
                    // Two ways in: the billing page (cloud only) and the
                    // runtimes dashboard. The crumb names whichever parent
                    // this edition actually has — pointing at billing on a
                    // self-hosted build would land on a redirect.
                    BILLING_SURFACE
                        ? {
                              label: t('web.settingsLayout.planAndBilling'),
                              to: '/settings/plan-and-billing'
                          }
                        : {
                              label: t('web.settingsLayout.runtimes'),
                              to: '/settings/runtimes'
                          },
                    { label: t('web.sandboxUsage.title') }
                ]}
                title={t('web.sandboxUsage.title')}
                description={t('web.sandboxUsage.subtitle')}
            />

            {error && (
                <div className='workbench-alert-error mb-6'>
                    {t('web.sandboxUsage.loadError')} {error}
                </div>
            )}

            <section className='settings-section'>
                <div className='settings-stat-grid'>
                    <StatCard
                        label={t('web.sandboxUsage.statStorage')}
                        value={
                            data ? storageGbLabel(data.storageBytesTotal) : null
                        }
                        loading={loading}
                    />
                    <StatCard
                        label={t('web.sandboxUsage.statActiveHours')}
                        value={
                            data ? activeHoursLabel(data.activeSecondsTotal) : null
                        }
                        loading={loading}
                    />
                    <StatCard
                        label={t('web.sandboxUsage.statSandboxes')}
                        value={data ? fmt(data.hosts.length) : null}
                        loading={loading}
                    />
                </div>
                {data && (
                    <div className='text-caption text-muted mt-2'>
                        {usagePeriodLine(data.usagePeriod, t)}
                    </div>
                )}
            </section>

            {empty ? (
                <section className='settings-section'>
                    <EmptyState
                        kind='all-clear'
                        tier='stack'
                        title={t('web.emptyState.sandboxUsageTitle')}
                    />
                </section>
            ) : (
                <>
                    <section className='settings-section'>
                        <div className='settings-card-label mb-1'>
                            {t('web.sandboxUsage.storageSectionTitle')}
                        </div>
                        <p className='settings-card-copy mb-4'>
                            {t('web.sandboxUsage.storageSectionBody')}
                        </p>
                        {data === null ? (
                            <div
                                className='settings-card p-4'
                                aria-busy={loading}
                            >
                                <Ghost variant='cap' className='w-40' />
                            </div>
                        ) : (
                            data.hosts.map((host) => (
                                <HostStorageCard
                                    key={host.hostId}
                                    host={host}
                                />
                            ))
                        )}
                    </section>

                    <section className='settings-section'>
                        <div className='settings-card-label mb-1'>
                            {t('web.sandboxUsage.hoursSectionTitle')}
                        </div>
                        <p className='settings-card-copy mb-4'>
                            {t('web.sandboxUsage.hoursSectionBody')}
                        </p>
                        <div
                            className='settings-card overflow-x-auto'
                            aria-busy={loading}
                        >
                            <table className='w-full min-w-[32rem] text-left'>
                                <thead className='workbench-table-head'>
                                    <tr>
                                        <th className='px-4 py-3 font-medium'>
                                            {t('web.sandboxUsage.colSandbox')}
                                        </th>
                                        <th className='px-4 py-3 font-medium'>
                                            {t('web.sandboxUsage.colStatus')}
                                        </th>
                                        <th className='px-4 py-3 text-right font-medium'>
                                            {t('web.sandboxUsage.colActive')}
                                        </th>
                                        <th className='w-32 px-4 py-3 font-medium'>
                                            {t('web.sandboxUsage.colShare')}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data === null && hoursGhostRows()}
                                    {data?.hosts.map((host) => (
                                        <tr
                                            key={host.hostId}
                                            className='text-ui border-divider/60 border-t'
                                        >
                                            <td className='px-4 py-3'>
                                                {host.name}
                                            </td>
                                            <td className='text-muted px-4 py-3'>
                                                {host.spriteStatus ?? '—'}
                                            </td>
                                            <td className='text-muted px-4 py-3 text-right font-mono tabular-nums'>
                                                {formatDuration(
                                                    host.activeSecondsThisPeriod *
                                                        1000
                                                )}
                                            </td>
                                            <td className='w-32 px-4 py-3'>
                                                <ShareBar
                                                    pct={sharePct(
                                                        host.activeSecondsThisPeriod,
                                                        data.activeSecondsTotal
                                                    )}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                    {data?.deletedHosts.map((host) => (
                                        <tr
                                            key={host.hostId}
                                            className='text-ui border-divider/60 text-muted border-t'
                                        >
                                            <td className='px-4 py-3'>
                                                {t(
                                                    'web.sandboxUsage.deletedSandbox'
                                                )}{' '}
                                                <span className='text-caption font-mono'>
                                                    {host.hostId.slice(0, 12)}…
                                                </span>
                                            </td>
                                            <td className='px-4 py-3'>—</td>
                                            <td className='px-4 py-3 text-right font-mono tabular-nums'>
                                                {formatDuration(
                                                    host.activeSecondsThisPeriod *
                                                        1000
                                                )}
                                            </td>
                                            <td className='w-32 px-4 py-3'>
                                                <ShareBar
                                                    pct={sharePct(
                                                        host.activeSecondsThisPeriod,
                                                        data.activeSecondsTotal
                                                    )}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {data !== null && data.deletedHosts.length > 0 && (
                            <p className='text-caption text-muted mt-2'>
                                {t('web.sandboxUsage.deletedNote')}
                            </p>
                        )}
                    </section>
                </>
            )}
        </div>
    )
}

export default SandboxUsage
