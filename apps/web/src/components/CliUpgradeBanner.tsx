import type { DaemonHostSummary } from '@manyfold/shared'
import type { FC } from 'react'
import { Link } from 'react-router-dom'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useI18n } from '@/lib/i18n'
import { updatesPath } from '@/lib/updateCenter'

type Props = {
    daemons: DaemonHostSummary[]
    collapsed?: boolean
}

const CliUpgradeBanner: FC<Props> = ({ daemons, collapsed = false }) => {
    const { t } = useI18n()
    const stale = daemons.filter((d) => d.needsUpgrade)
    if (stale.length === 0) return null
    const label =
        stale.length === 1
            ? t('web.cliUpgrade.one')
            : t('web.cliUpgrade.many', { count: stale.length })
    if (collapsed) {
        return (
            <ShortcutTooltip label={label} placement='right' className='mx-auto mb-2'>
                <Link
                    to={updatesPath('cli')}
                    aria-label={label}
                    className='bg-danger-bg text-fg shadow-ring-light inline-flex h-7 w-7 items-center justify-center rounded-pill text-xs font-medium'
                >
                    !
                </Link>
            </ShortcutTooltip>
        )
    }
    return (
        <div className='bg-danger-bg text-fg shadow-ring-light mx-2 mb-2 rounded-md px-3 py-2'>
            <p className='text-caption font-medium'>{label}</p>
            <Link
                to={updatesPath('cli')}
                className='text-caption text-link mt-1 inline-block hover:underline'
            >
                {t('web.updates.reviewCta')}
            </Link>
        </div>
    )
}

export default CliUpgradeBanner
