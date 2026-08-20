import type { FC, ReactNode } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { chatStreamStore, useStreamSnapshot } from '@/lib/chatStreamStore'
import { useI18n } from '@/lib/i18n'

interface Props {
    agentId: string
    sessionId: string
    className?: string
    label?: string
}

const SessionStreamingDot: FC<Props> = ({
    agentId,
    sessionId,
    className,
    label
}): ReactNode => {
    const { t } = useI18n()
    const displayLabel = label ?? t('web.chat.generating')
    const key = chatStreamStore.keyOf(agentId, sessionId)
    const snapshot = useStreamSnapshot(key)
    const active =
        snapshot.status === 'connecting' ||
        snapshot.status === 'streaming' ||
        snapshot.status === 'suspended'
    if (!active) return null
    return (
        <ShortcutTooltip label={displayLabel} className='shrink-0'>
            <span
                role='status'
                aria-label={displayLabel}
                className={[
                    'bg-workflow-develop h-2 w-2 shrink-0 animate-pulse rounded-full',
                    className ?? ''
                ]
                    .join(' ')
                    .trim()}
            />
        </ShortcutTooltip>
    )
}

export default SessionStreamingDot
