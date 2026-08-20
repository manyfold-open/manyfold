import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

interface Props {
    text: string
    streaming?: boolean
    compact?: boolean
}

const AUTO_CLOSE_MS = 1000
const TICK_MS = 200

const ThinkingBlock: FC<Props> = ({
    text,
    streaming = false,
    compact = false
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(streaming)
    const [userToggled, setUserToggled] = useState(false)
    const [now, setNow] = useState(() => Date.now())
    const startedAt = useRef<number>(Date.now())
    const endedAt = useRef<number | null>(null)
    const wasStreaming = useRef<boolean>(streaming)

    useEffect(() => {
        if (!streaming) return
        const id = setInterval(() => setNow(Date.now()), TICK_MS)
        return () => clearInterval(id)
    }, [streaming])

    useEffect(() => {
        if (wasStreaming.current && !streaming) {
            endedAt.current = Date.now()
            if (!userToggled) {
                const id = setTimeout(() => setOpen(false), AUTO_CLOSE_MS)
                return () => clearTimeout(id)
            }
        }
        wasStreaming.current = streaming
    }, [streaming, userToggled])

    useEffect(() => {
        if (streaming && !userToggled) setOpen(true)
    }, [streaming, userToggled])

    const elapsedMs = streaming
        ? now - startedAt.current
        : endedAt.current
          ? endedAt.current - startedAt.current
          : null

    const headerLabel = streaming
        ? `${t('web.chat.thinking')} ${elapsedMs ? formatElapsed(elapsedMs) : ''}`.trim()
        : elapsedMs
          ? t('web.chat.thoughtFor', { elapsed: formatElapsed(elapsedMs) })
          : t('web.chat.thought')

    const onToggle = (): void => {
        setUserToggled(true)
        setOpen(!open)
    }

    return (
        <div
            className={
                compact
                    ? 'my-0.5'
                    : 'shadow-ring-light bg-surface-subtle my-2 rounded-md'
            }
        >
            <button
                type='button'
                onClick={onToggle}
                className={[
                    'flex w-full items-center gap-2 rounded-md text-left transition-colors',
                    compact
                        ? 'text-subtle hover:text-fg px-1 py-0.5'
                        : 'hover:bg-surface-hover px-3 py-1.5'
                ].join(' ')}
            >
                {open ? (
                    <ChevronDownIcon
                        className={[
                            'h-3.5 w-3.5 shrink-0',
                            compact ? 'text-current' : 'text-subtle'
                        ].join(' ')}
                    />
                ) : (
                    <ChevronRightIcon
                        className={[
                            'h-3.5 w-3.5 shrink-0',
                            compact ? 'text-current' : 'text-subtle'
                        ].join(' ')}
                    />
                )}
                <span
                    className={[
                        'text-caption font-mono',
                        compact ? 'text-current' : 'text-subtle'
                    ].join(' ')}
                >
                    {compact ? 'thought' : 'thinking'}
                </span>
                <span
                    className={`text-ui min-w-0 flex-1 truncate ${streaming ? 'text-muted animate-pulse' : compact ? 'text-current' : 'text-fg'}`}
                >
                    {headerLabel}
                </span>
            </button>
            {open && (
                <div
                    className={
                        compact
                            ? 'px-6 py-1'
                            : 'border-divider border-t px-3 py-2.5'
                    }
                >
                    <pre className='text-caption text-muted max-h-[40vh] overflow-auto font-mono break-words whitespace-pre-wrap'>
                        {text || ' '}
                    </pre>
                </div>
            )}
        </div>
    )
}

const formatElapsed = (ms: number): string => {
    if (ms < 1000) return ''
    const s = ms / 1000
    if (s < 10) return `${s.toFixed(1)}s`
    if (s < 60) return `${Math.round(s)}s`
    const m = Math.floor(s / 60)
    const r = Math.round(s % 60)
    return `${m}m${r}s`
}

export default ThinkingBlock
