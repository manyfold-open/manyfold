import type { FC, ReactNode } from 'react'
import { ArrowLeftIcon } from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useI18n } from '@/lib/i18n'

// Rail exit shared by every full-screen area (Settings, Customize, agent
// settings). The label is a constant, identical in all three, because the agent
// it returns to is auto-named: at the rail's 200px minimum "adventurous-mayfly-
// 2095" truncates away the digits that are the only thing telling two agents
// apart, and the destination is a place the reader left seconds ago — the name
// was reassurance, not information, bought with the widest line in the rail.
// It stays reachable on hover. Naming the destination is worth it again only if
// agents get names their owner chose.
const AreaBackLink: FC<{
    onBack: () => void
    target: 'chat' | 'workspace'
    agentName?: string | null
}> = ({ onBack, target, agentName = null }): ReactNode => {
    const { direction, t } = useI18n()
    const button = (
        <button type='button' onClick={onBack} className='settings-back-link'>
            <ArrowLeftIcon
                className={
                    direction === 'rtl'
                        ? 'h-3.5 w-3.5 shrink-0 rotate-180'
                        : 'h-3.5 w-3.5 shrink-0'
                }
            />
            {target === 'chat'
                ? t('web.settingsLayout.backToChat')
                : t('web.settingsLayout.backToWorkspace')}
        </button>
    )

    if (target !== 'chat' || !agentName) return button

    return (
        <ShortcutTooltip
            label={t('web.settingsLayout.backToChatWith', { name: agentName })}
            placement='bottom-start'
            className='block w-full'
        >
            {button}
        </ShortcutTooltip>
    )
}

export default AreaBackLink
