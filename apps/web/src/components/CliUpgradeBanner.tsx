import type { DaemonHostSummary } from '@manyfold/shared'
import type { FC } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { CLI_UPGRADE_LEARN_HOW_URL } from '@/lib/chatAgents'
import { useI18n } from '@/lib/i18n'

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
                <a
                    href={CLI_UPGRADE_LEARN_HOW_URL}
                    target='_blank'
                    rel='noreferrer'
                    aria-label={label}
                    className='bg-danger-bg text-fg shadow-ring-light inline-flex h-7 w-7 items-center justify-center rounded-pill text-xs font-medium'
                >
                    !
                </a>
            </ShortcutTooltip>
        )
    }
    return (
        <div className='bg-danger-bg text-fg shadow-ring-light mx-2 mb-2 rounded-md px-3 py-2'>
            <p className='text-caption font-medium'>{label}</p>
            <p className='text-caption mt-0.5 break-words'>
                {t('web.cliUpgrade.instructions')}
            </p>
            <a
                href={CLI_UPGRADE_LEARN_HOW_URL}
                target='_blank'
                rel='noreferrer'
                className='text-caption text-link mt-1 inline-block hover:underline'
            >
                {t('web.cliUpgrade.learnHow')}
            </a>
        </div>
    )
}

export default CliUpgradeBanner
