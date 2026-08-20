import type { FC, ReactNode } from 'react'
import type { ToolStatus } from '@/components/chat/utils/pairToolBlocks'
import { StatusTag } from '@/components/Tag'
import { useI18n } from '@/lib/i18n'

interface Props {
    status: ToolStatus
    elapsedMs?: number
}

const ToolStatusBadge: FC<Props> = ({ status, elapsedMs }): ReactNode => {
    const { t } = useI18n()
    if (status === 'completed') {
        return elapsedMs ? (
            <span className='text-caption text-subtle font-mono'>
                {formatElapsed(elapsedMs)}
            </span>
        ) : null
    }

    if (status === 'running') return null

    return (
        <StatusTag
            tone='error'
            label={
                status === 'denied'
                    ? t('web.chat.denied')
                    : t('web.chat.failed')
            }
        />
    )
}

const formatElapsed = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`
    const s = ms / 1000
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
    const m = Math.floor(s / 60)
    const r = Math.round(s % 60)
    return `${m}m${r}s`
}

export default ToolStatusBadge
