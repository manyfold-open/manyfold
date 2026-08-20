import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react'
import type { FC, ReactNode } from 'react'
import { createPortal } from 'react-dom'

const HOVER_DELAY_MS = 500

type TooltipPlacement =
    | 'bottom'
    | 'bottom-end'
    | 'bottom-start'
    | 'right'
    | 'top'

interface ShortcutTooltipProps {
    children: ReactNode
    className?: string
    disabled?: boolean
    label?: string
    placement?: TooltipPlacement
    shortcut?: string
}

interface TooltipPosition {
    left: number
    top: number
    ready: boolean
}

const viewportPadding = 8
const tooltipGap = 8

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max)

const ShortcutTooltip: FC<ShortcutTooltipProps> = ({
    children,
    className,
    disabled = false,
    label,
    placement = 'bottom',
    shortcut
}): ReactNode => {
    const [open, setOpen] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const rootRef = useRef<HTMLSpanElement | null>(null)
    const tooltipRef = useRef<HTMLSpanElement | null>(null)
    const [position, setPosition] = useState<TooltipPosition>({
        left: 0,
        top: 0,
        ready: false
    })

    const cancel = (): void => {
        if (timer.current !== null) {
            clearTimeout(timer.current)
            timer.current = null
        }
    }

    useEffect(() => cancel, [])

    useEffect(() => {
        if (disabled) {
            cancel()
            setOpen(false)
        }
    }, [disabled])

    const updatePosition = useCallback((): void => {
        if (
            typeof window === 'undefined' ||
            !rootRef.current ||
            !tooltipRef.current
        ) {
            return
        }

        const rootRect = rootRef.current.getBoundingClientRect()
        const tooltipRect = tooltipRef.current.getBoundingClientRect()
        const maxLeft = window.innerWidth - viewportPadding - tooltipRect.width
        const maxTop = window.innerHeight - viewportPadding - tooltipRect.height

        let left = rootRect.left + rootRect.width / 2 - tooltipRect.width / 2
        let top = rootRect.bottom + tooltipGap

        if (placement === 'bottom-start') {
            left = rootRect.left
        } else if (placement === 'bottom-end') {
            left = rootRect.right - tooltipRect.width
        } else if (placement === 'right') {
            left = rootRect.right + tooltipGap
            top = rootRect.top + rootRect.height / 2 - tooltipRect.height / 2
        } else if (placement === 'top') {
            top = rootRect.top - tooltipGap - tooltipRect.height
        }

        setPosition({
            left: clamp(
                left,
                viewportPadding,
                Math.max(viewportPadding, maxLeft)
            ),
            top: clamp(top, viewportPadding, Math.max(viewportPadding, maxTop)),
            ready: true
        })
    }, [placement])

    useLayoutEffect(() => {
        if (!open) {
            setPosition((current) =>
                current.ready ? { ...current, ready: false } : current
            )
            return
        }

        updatePosition()

        const handleViewportChange = (): void => {
            updatePosition()
        }

        window.addEventListener('resize', handleViewportChange)
        document.addEventListener('scroll', handleViewportChange, true)

        return () => {
            window.removeEventListener('resize', handleViewportChange)
            document.removeEventListener('scroll', handleViewportChange, true)
        }
    }, [open, updatePosition])

    if (!label) return children

    return (
        <span
            ref={rootRef}
            className={['group/tooltip relative inline-flex', className ?? '']
                .join(' ')
                .trim()}
            onMouseEnter={() => {
                if (disabled) return
                timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS)
            }}
            onMouseLeave={() => {
                cancel()
                setOpen(false)
            }}
            onFocus={() => {
                if (disabled) return
                setOpen(true)
            }}
            onBlur={() => {
                cancel()
                setOpen(false)
            }}
        >
            {children}
            {typeof document !== 'undefined' &&
                createPortal(
                    <span
                        ref={tooltipRef}
                        role='tooltip'
                        className={[
                            'bg-surface-elevated text-fg shadow-ring-light text-caption rounded-xs pointer-events-none fixed z-[90] hidden max-w-[18rem] items-center gap-2 px-2.5 py-1.5 font-medium transition-opacity duration-100 md:inline-flex',
                            open && position.ready ? 'opacity-100' : 'opacity-0'
                        ].join(' ')}
                        style={{
                            left: position.left,
                            top: position.top
                        }}
                    >
                        <span className='truncate'>{label}</span>
                        {shortcut && (
                            <span className='bg-soft text-muted shadow-ring-light rounded-xs px-1.5 py-0.5 font-mono text-[0.68rem] leading-none'>
                                {shortcut}
                            </span>
                        )}
                    </span>,
                    document.body
                )}
        </span>
    )
}

export default ShortcutTooltip
