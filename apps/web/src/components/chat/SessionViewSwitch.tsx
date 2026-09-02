import type { FC, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { MessageCircleIcon, TerminalIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

export type SessionViewMode = 'chat' | 'terminal'

interface SessionViewSwitchProps {
    mode: SessionViewMode
    terminalDisabledReason: string | null
    onSelect: (mode: SessionViewMode) => void
}

const SEGMENT_BASE =
    'text-caption inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 font-medium transition-colors'

/* Both representations of one session, so per DESIGN.md §8.13 this is a tab
   (it swaps an adjacent panel) and not a value list: filled active chip with
   the working-surface ring, no trailing check. */
const SessionViewSwitch: FC<SessionViewSwitchProps> = ({
    mode,
    onSelect,
    terminalDisabledReason
}): ReactNode => {
    const { t } = useI18n()
    const terminalBlocked = terminalDisabledReason !== null

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        if (mode === 'chat' && !terminalBlocked) onSelect('terminal')
        else if (mode === 'terminal') onSelect('chat')
    }

    const segmentClass = (active: boolean): string =>
        [
            SEGMENT_BASE,
            active
                ? 'bg-surface text-fg shadow-ring-light'
                : 'text-muted hover:bg-surface-hover'
        ].join(' ')

    const terminalTab = (
        <button
            type='button'
            role='tab'
            aria-selected={mode === 'terminal'}
            tabIndex={mode === 'terminal' ? 0 : -1}
            disabled={terminalBlocked}
            onClick={() => onSelect('terminal')}
            className={[
                segmentClass(mode === 'terminal'),
                terminalBlocked ? 'cursor-not-allowed opacity-45' : ''
            ]
                .filter(Boolean)
                .join(' ')}
        >
            <TerminalIcon className='h-3.5 w-3.5 shrink-0' />
            <span>{t('web.sessionView.terminal')}</span>
        </button>
    )

    return (
        <div
            role='tablist'
            aria-label={t('web.sessionView.label')}
            onKeyDown={onKeyDown}
            className='bg-soft shadow-ring-light inline-flex shrink-0 gap-1 rounded-md p-1'
        >
            <button
                type='button'
                role='tab'
                aria-selected={mode === 'chat'}
                tabIndex={mode === 'chat' ? 0 : -1}
                onClick={() => onSelect('chat')}
                className={segmentClass(mode === 'chat')}
            >
                <MessageCircleIcon className='h-3.5 w-3.5 shrink-0' />
                <span>{t('web.sessionView.chat')}</span>
            </button>
            {terminalBlocked ? (
                <ShortcutTooltip
                    label={terminalDisabledReason}
                    placement='bottom-end'
                >
                    {terminalTab}
                </ShortcutTooltip>
            ) : (
                terminalTab
            )}
        </div>
    )
}

export default SessionViewSwitch
