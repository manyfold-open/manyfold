import type { SandboxUsageBreakdown } from '@manyfold/shared'
import type { FC } from 'react'
import { useI18n } from '@/lib/i18n'
import { formatLocalDateTime } from '@/lib/usageFormat'

const SandboxStorageFreshness: FC<{ report: SandboxUsageBreakdown | null }> = ({
    report
}) => {
    const { t } = useI18n()
    const freshness = report?.storageFreshness
    const label =
        report?.hosts.length === 0
            ? t('web.sandboxUsage.storageEmpty')
            : freshness?.state === 'fresh'
              ? t('web.sandboxUsage.freshnessFresh')
              : freshness?.state === 'stale'
                ? t('web.sandboxUsage.freshnessStale')
                : freshness?.state === 'partial'
                  ? t('web.sandboxUsage.freshnessPartial', {
                        count: freshness.unmeasuredHosts
                    })
                  : t('web.sandboxUsage.freshnessUnknown')
    return (
        <div
            className='text-caption text-muted mt-2 flex flex-wrap gap-x-2 gap-y-1'
            data-storage-freshness={freshness?.state ?? 'unknown'}
        >
            <span>{label}</span>
            {freshness?.oldestMeasuredAt && (
                <time dateTime={freshness.oldestMeasuredAt}>
                    {t('web.sandboxUsage.oldestMeasured', {
                        time: formatLocalDateTime(freshness.oldestMeasuredAt)
                    })}
                </time>
            )}
        </div>
    )
}

export default SandboxStorageFreshness
