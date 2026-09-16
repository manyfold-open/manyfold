import type { RuntimeAccessSummary } from '@manyfold/shared'
import { useEffect, useState, type FC } from 'react'
import { Ghost } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { resourceUsageRows } from '@/lib/resourceUsageRows'
import { formatBytesDecimal } from '@/lib/sandboxUsageRows'
import { fmt, utcDateLabel } from '@/lib/usageFormat'

const ResourceUsageSummary: FC<{ access: RuntimeAccessSummary }> = ({
    access
}) => {
    const { t } = useI18n()
    const end = new Date(Date.parse(access.usagePeriod.end) - 1).toISOString()
    return (
        <>
            <div className='mb-3 flex flex-wrap items-baseline justify-between gap-2'>
                <h2 className='settings-section-label mb-0'>
                    {t('web.planAndBilling.planTitle')}: {access.plan.name}
                </h2>
                <span className='text-caption text-muted'>
                    {utcDateLabel(access.usagePeriod.start)} /{' '}
                    {utcDateLabel(end)} (UTC)
                </span>
            </div>
            <dl className='grid gap-x-8 sm:grid-cols-2'>
                {resourceUsageRows(access).map((row) => {
                    const format = (value: number): string =>
                        row.unit === 'bytes'
                            ? formatBytesDecimal(value)
                            : row.unit === 'hours'
                              ? `${fmt(value)} h`
                              : fmt(value)
                    return (
                        <div
                            key={row.labelKey}
                            className='border-divider/60 text-ui grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b py-2.5'
                        >
                            <dt className='text-muted'>{t(row.labelKey)}</dt>
                            <dd className='text-fg text-right tabular-nums'>
                                {row.used === null ? '-' : format(row.used)}
                                <span className='text-muted'>
                                    {' '}
                                    /{' '}
                                    {row.limit === null
                                        ? t('web.planAndBilling.quotaUnlimited')
                                        : format(row.limit)}
                                </span>
                            </dd>
                        </div>
                    )
                })}
                <div className='border-divider/60 text-ui grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b py-2.5'>
                    <dt className='text-muted'>
                        {t('web.planAndBilling.retentionLabel')}
                    </dt>
                    <dd className='text-fg text-right tabular-nums'>
                        {access.plan.messageHistoryRetentionDays === null
                            ? t('web.planAndBilling.retentionValueUnlimited')
                            : t('web.planAndBilling.retentionValueDays', {
                                  days: fmt(
                                      access.plan.messageHistoryRetentionDays
                                  )
                              })}
                    </dd>
                </div>
            </dl>
        </>
    )
}

const SelfHostedResourceUsage: FC = () => {
    const client = useApiClient()
    const { t } = useI18n()
    const [access, setAccess] = useState<RuntimeAccessSummary | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        let active = true
        setError(null)
        void client.runtimeAccess.summary().then(
            (result) => {
                if (active) setAccess(result)
            },
            (failure) => {
                if (active) setError(apiErrorMessage(failure))
            }
        )
        return () => {
            active = false
        }
    }, [client, attempt])

    return (
        <section
            className='settings-section'
            aria-busy={!access && !error}
            data-testid='selfhost-resource-usage'
        >
            {error ? (
                <div
                    className='workbench-alert-error flex flex-wrap items-center justify-between gap-3'
                    role='alert'
                >
                    <span>{error}</span>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        onClick={() => setAttempt((value) => value + 1)}
                    >
                        {t('common.retry')}
                    </button>
                </div>
            ) : access ? (
                <ResourceUsageSummary access={access} />
            ) : (
                <Ghost variant='block' className='h-48 w-full' />
            )}
        </section>
    )
}

export default SelfHostedResourceUsage
