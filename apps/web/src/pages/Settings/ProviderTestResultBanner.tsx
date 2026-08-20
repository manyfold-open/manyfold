import type { ProviderTestStatus } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { timeAgo } from '@/lib/timeAgo'
import { useI18n } from '@/lib/i18n'

interface Props {
    status: ProviderTestStatus
    message: string | null
    models: string[] | null
    testedAt?: string | null
    latencyMs?: number | null
}

const ProviderTestResultBanner: FC<Props> = ({
    status,
    message,
    models,
    testedAt,
    latencyMs
}): ReactNode => {
    const { t } = useI18n()
    const [expanded, setExpanded] = useState(false)
    const count = models?.length ?? 0
    const when = testedAt ? timeAgo(testedAt) : null
    const latency = typeof latencyMs === 'number' ? `${latencyMs}ms` : null

    if (status === 'error') {
        return (
            <div className='workbench-alert-error'>
                <div className='text-caption font-mono'>
                    {t('web.providerTest.testFailed')}
                    {message ? ` · ${message}` : ''}
                    {when ? ` · ${when}` : ''}
                </div>
            </div>
        )
    }

    return (
        <div className='workbench-note'>
            <div className='text-caption flex flex-wrap items-center gap-x-2 gap-y-1 font-mono'>
                <span>{t('web.providerTest.testedOk')}</span>
                <span className='text-muted'>·</span>
                <span>{t('web.providerTest.models', { count })}</span>
                {latency && (
                    <>
                        <span className='text-muted'>·</span>
                        <span>{latency}</span>
                    </>
                )}
                {when && (
                    <>
                        <span className='text-muted'>·</span>
                        <span>{when}</span>
                    </>
                )}
                {count > 0 && (
                    <>
                        <span className='text-muted'>·</span>
                        <button
                            type='button'
                            onClick={() => setExpanded((v) => !v)}
                            className='text-link hover:text-fg underline-offset-2 hover:underline'
                        >
                            {expanded
                                ? t('web.providerTest.hideModels')
                                : t('web.providerTest.viewModels', { count })}
                        </button>
                    </>
                )}
            </div>
            {expanded && count > 0 && (
                <ul className='text-caption text-muted mt-2 max-h-48 overflow-auto font-mono'>
                    {models!.map((id) => (
                        <li key={id} className='truncate'>
                            {id}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

export default ProviderTestResultBanner
