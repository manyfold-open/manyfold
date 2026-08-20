import type { QuotaWarningEvent } from '@manyfold/shared'
import type { FC } from 'react'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'

type Props = {
    warnings: QuotaWarningEvent[]
    onDismiss: (code: string) => void
}

const toGb = (bytes: number): number =>
    Math.round((bytes / 1_000_000_000) * 100) / 100

const copyFor = (event: QuotaWarningEvent, t: TFn): string => {
    const pct = event.limit > 0
        ? Math.min(100, Math.round((event.usage / event.limit) * 100))
        : 0
    switch (event.code) {
        case 'storage': {
            const usedGb = toGb(event.usage)
            const maxGb = Math.round(event.limit / 1_000_000_000)
            return t('web.quota.storageWarning', {
                pct,
                plan: event.planName,
                used: usedGb,
                max: maxGb
            })
        }
        case 'provisioned':
            return t('web.quota.provisionedWarning', {
                pct,
                plan: event.planName,
                used: event.usage,
                max: event.limit
            })
        case 'concurrent':
            return t('web.quota.concurrentWarning', {
                pct,
                plan: event.planName,
                used: event.usage,
                max: event.limit
            })
        case 'wholesale_soft':
            return t('web.quota.wholesaleWarning', {
                pct,
                used: event.usage,
                max: event.limit
            })
        case 'active_hours':
            return t('web.quota.activeHoursWarning', {
                pct,
                plan: event.planName,
                used: Math.round(event.usage * 10) / 10,
                max: event.limit
            })
        case 'channels':
            return t('web.quota.channelsWarning', {
                plan: event.planName,
                used: event.usage,
                max: event.limit
            })
        case 'automations':
            return t('web.quota.automationsWarning', {
                plan: event.planName,
                used: event.usage,
                max: event.limit
            })
        case 'automation_runs':
            return t('web.quota.automationRunsWarning', {
                pct,
                plan: event.planName,
                used: event.usage,
                max: event.limit
            })
        case 'api_requests':
            return t('web.quota.apiRequestsWarning', {
                pct,
                plan: event.planName,
                used: event.usage,
                max: event.limit
            })
    }
}

const toneFor = (event: QuotaWarningEvent): string => {
    if (event.code === 'wholesale_soft') return 'bg-info-bg text-fg'
    const ratio = event.limit > 0 ? event.usage / event.limit : 0
    return ratio >= 0.95 ? 'bg-danger-bg text-fg' : 'bg-info-bg text-fg'
}

const QuotaBanner: FC<Props> = ({ warnings, onDismiss }) => {
    const { t } = useI18n()
    if (warnings.length === 0) return null
    return (
        <div className='flex flex-col gap-2 px-4 pt-3'>
            {warnings.map((w) => (
                <div
                    key={`${w.code}:${w.at}`}
                    role='status'
                    className={`shadow-ring-light rounded-md px-4 py-3 ${toneFor(w)}`}
                >
                    <div className='flex flex-wrap items-start justify-between gap-3'>
                        <p className='text-ui'>{copyFor(w, t)}</p>
                        <button
                            type='button'
                            onClick={() => onDismiss(w.code)}
                            className='text-caption text-muted hover:text-fg shrink-0'
                            aria-label={t('common.dismiss')}
                        >
                            {t('common.dismiss')}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    )
}

export default QuotaBanner
