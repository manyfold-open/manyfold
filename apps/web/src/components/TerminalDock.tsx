import type {
    FC,
    KeyboardEvent as ReactKeyboardEvent,
    PointerEvent as ReactPointerEvent,
    ReactNode
} from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    ChevronDownIcon,
    ChevronUpIcon,
    CloseIcon,
    PlusIcon,
    TerminalIcon
} from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import TerminalSession from '@/components/TerminalSession'
import type {
    TerminalConnectionStatus,
    TerminalTabModel
} from '@/components/TerminalSession'
import { useI18n } from '@/lib/i18n'

interface TerminalDockProps {
    activeTabId: string | null
    canCreateTerminal: boolean
    getToken: () => Promise<string>
    onCloseDock: () => void
    onCloseTab: (tabId: string) => void
    onCreateTerminal: () => void
    onSelectTab: (tabId: string) => void
    onStatusChange: (tabId: string, status: TerminalConnectionStatus) => void
    tabs: TerminalTabModel[]
}

const statusDotClass = (status: TerminalConnectionStatus): string => {
    switch (status) {
        case 'open':
            return 'bg-workflow-develop'
        case 'connecting':
            return 'bg-[#f59e0b]'
        case 'closed':
            return 'bg-placeholder'
        default:
            return 'bg-workflow-ship'
    }
}

const DOCK_HEIGHT_STORAGE_KEY = 'nca:terminal-dock-height'
const DOCK_MINIMIZED_STORAGE_KEY = 'nca:terminal-dock-minimized'
const MIN_DOCK_HEIGHT = 224
const MAIN_RESERVE_PX = 120
const KEYBOARD_STEP = 32
const KEYBOARD_LARGE_STEP = 128

const readStoredDockMinimized = (): boolean => {
    if (typeof window === 'undefined') return false
    try {
        return window.localStorage.getItem(DOCK_MINIMIZED_STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max)

const readStoredDockHeight = (): number | null => {
    if (typeof window === 'undefined') return null
    try {
        const raw = window.localStorage.getItem(DOCK_HEIGHT_STORAGE_KEY)
        if (!raw) return null
        const parsed = Number.parseFloat(raw)
        if (!Number.isFinite(parsed) || parsed <= 0) return null
        return parsed
    } catch {
        return null
    }
}

const getDefaultDockHeight = (): number => {
    if (typeof window === 'undefined') return 368
    return Math.min(window.innerHeight * 0.38, 368)
}

const getMaxDockHeight = (parent: HTMLElement | null): number => {
    const parentHeight =
        parent?.getBoundingClientRect().height ??
        (typeof window === 'undefined' ? 0 : window.innerHeight)
    const max = parentHeight - MAIN_RESERVE_PX
    return Math.max(MIN_DOCK_HEIGHT, max)
}

const TerminalDock: FC<TerminalDockProps> = ({
    activeTabId,
    canCreateTerminal,
    getToken,
    onCloseDock,
    onCloseTab,
    onCreateTerminal,
    onSelectTab,
    onStatusChange,
    tabs
}): ReactNode => {
    const { t } = useI18n()
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]
    const sectionRef = useRef<HTMLElement | null>(null)
    const [dockHeight, setDockHeight] = useState<number>(
        () => readStoredDockHeight() ?? getDefaultDockHeight()
    )
    const [minimized, setMinimized] = useState<boolean>(() =>
        readStoredDockMinimized()
    )

    const toggleMinimized = useCallback((): void => {
        setMinimized((current) => {
            const next = !current
            if (typeof window !== 'undefined') {
                try {
                    window.localStorage.setItem(
                        DOCK_MINIMIZED_STORAGE_KEY,
                        next ? '1' : '0'
                    )
                } catch {}
            }
            return next
        })
    }, [])

    const persistDockHeight = useCallback((value: number): void => {
        if (typeof window === 'undefined') return
        try {
            window.localStorage.setItem(
                DOCK_HEIGHT_STORAGE_KEY,
                String(Math.round(value))
            )
        } catch {}
    }, [])

    useEffect(() => {
        const handleResize = (): void => {
            setDockHeight((current) => {
                const max = getMaxDockHeight(
                    sectionRef.current?.parentElement ?? null
                )
                return clamp(current, MIN_DOCK_HEIGHT, max)
            })
        }
        handleResize()
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    const startResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (event.button !== 0 && event.pointerType !== 'touch') return
            event.preventDefault()
            event.stopPropagation()
            const handle = event.currentTarget
            const parent = sectionRef.current?.parentElement ?? null
            const max = getMaxDockHeight(parent)
            handle.setPointerCapture(event.pointerId)

            const startY = event.clientY
            const startHeight = dockHeight
            let nextHeight = startHeight
            const previousCursor = document.body.style.cursor
            const previousUserSelect = document.body.style.userSelect
            document.body.style.cursor = 'row-resize'
            document.body.style.userSelect = 'none'

            const onMove = (moveEvent: PointerEvent): void => {
                const dy = moveEvent.clientY - startY
                nextHeight = clamp(startHeight - dy, MIN_DOCK_HEIGHT, max)
                setDockHeight(nextHeight)
            }

            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                if (handle.hasPointerCapture(event.pointerId))
                    handle.releasePointerCapture(event.pointerId)
                document.body.style.cursor = previousCursor
                document.body.style.userSelect = previousUserSelect
                persistDockHeight(nextHeight)
            }

            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
            window.addEventListener('pointercancel', onUp)
        },
        [dockHeight, persistDockHeight]
    )

    const onHandleKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLDivElement>): void => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP
            const direction = event.key === 'ArrowUp' ? 1 : -1
            const max = getMaxDockHeight(
                sectionRef.current?.parentElement ?? null
            )
            setDockHeight((current) => {
                const next = clamp(
                    current + direction * step,
                    MIN_DOCK_HEIGHT,
                    max
                )
                persistDockHeight(next)
                return next
            })
        },
        [persistDockHeight]
    )

    if (tabs.length === 0 || !activeTab) return null

    return (
        <section
            ref={sectionRef}
            className='border-divider/80 bg-main/95 flex shrink-0 flex-col border-t backdrop-blur'
            style={{ height: minimized ? undefined : `${dockHeight}px` }}
        >
            {!minimized && (
                <div
                    role='separator'
                    aria-orientation='horizontal'
                    aria-label={t('web.terminal.resizePanel')}
                    aria-valuemin={MIN_DOCK_HEIGHT}
                    aria-valuenow={Math.round(dockHeight)}
                    tabIndex={0}
                    onPointerDown={startResize}
                    onKeyDown={onHandleKeyDown}
                    className='hover:bg-divider/40 focus-visible:bg-divider/40 group flex h-1.5 shrink-0 cursor-row-resize touch-none select-none items-center justify-center transition-colors focus-visible:outline-none'
                >
                    <span className='bg-divider/0 group-hover:bg-divider group-focus-visible:bg-divider h-0.5 w-12 rounded-full transition-colors' />
                </div>
            )}
            <div className='border-divider/80 flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3'>
                <div className='mf-terminal-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5'>
                    {tabs.map((tab) => {
                        const active = tab.id === activeTab.id
                        return (
                            <div
                                key={tab.id}
                                className={[
                                    'text-caption group flex h-8 min-w-[9rem] max-w-[14rem] shrink-0 items-center overflow-hidden rounded-md font-medium transition-colors',
                                    active
                                        ? 'bg-soft text-fg shadow-ring-light'
                                        : 'text-muted hover:bg-soft/70 hover:text-fg'
                                ].join(' ')}
                            >
                                <ShortcutTooltip
                                    label={tab.cwdPath ?? tab.agentName}
                                    placement='top'
                                    className='h-full min-w-0 flex-1'
                                >
                                    <button
                                        type='button'
                                        onClick={() => onSelectTab(tab.id)}
                                        className='flex h-full w-full min-w-0 items-center gap-2 px-2.5 text-left'
                                    >
                                        <TerminalIcon className='h-3.5 w-3.5 shrink-0' />
                                        <span
                                            className={[
                                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                                statusDotClass(tab.status)
                                            ].join(' ')}
                                            aria-hidden='true'
                                        />
                                        <span className='min-w-0 flex-1 truncate'>
                                            {tab.cwdLabel ??
                                                `${tab.agentName} #${tab.index}`}
                                        </span>
                                    </button>
                                </ShortcutTooltip>
                                <ShortcutTooltip
                                    label={t('web.terminal.closeTab')}
                                    placement='top'
                                    className='shrink-0'
                                >
                                    <button
                                        type='button'
                                        aria-label={t(
                                            'web.terminal.closeTabAria',
                                            {
                                                index: tab.index
                                            }
                                        )}
                                        onClick={(event) => {
                                            event.stopPropagation()
                                            onCloseTab(tab.id)
                                        }}
                                        className='text-placeholder rounded-pill hover:bg-surface-hover mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center opacity-0 transition-colors focus:opacity-100 group-hover:opacity-100'
                                    >
                                        <CloseIcon className='h-3.5 w-3.5' />
                                    </button>
                                </ShortcutTooltip>
                            </div>
                        )
                    })}
                    <ShortcutTooltip
                        label={t('web.terminal.openAnother')}
                        placement='top'
                        className='shrink-0'
                    >
                        <button
                            type='button'
                            aria-label={t('web.terminal.openAnother')}
                            disabled={!canCreateTerminal}
                            onClick={onCreateTerminal}
                            className='text-muted hover:bg-surface-hover rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40'
                        >
                            <PlusIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                </div>

                <div className='flex shrink-0 items-center gap-2'>
                    <ShortcutTooltip
                        label={
                            minimized
                                ? t('web.terminal.restore')
                                : t('web.terminal.minimize')
                        }
                        placement='top'
                    >
                        <button
                            type='button'
                            aria-label={
                                minimized
                                    ? t('web.terminal.restore')
                                    : t('web.terminal.minimize')
                            }
                            aria-pressed={minimized}
                            onClick={toggleMinimized}
                            className='text-placeholder hover:bg-surface-hover rounded-pill inline-flex h-8 w-8 items-center justify-center transition-colors'
                        >
                            {minimized ? (
                                <ChevronUpIcon className='h-4 w-4' />
                            ) : (
                                <ChevronDownIcon className='h-4 w-4' />
                            )}
                        </button>
                    </ShortcutTooltip>
                    <ShortcutTooltip
                        label={t('web.terminal.closePanel')}
                        placement='top'
                    >
                        <button
                            type='button'
                            aria-label={t('web.terminal.closePanel')}
                            onClick={onCloseDock}
                            className='text-placeholder hover:bg-surface-hover rounded-pill inline-flex h-8 w-8 items-center justify-center transition-colors'
                        >
                            <CloseIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                </div>
            </div>

            <div
                className={[
                    'bg-surface relative min-h-0 flex-1',
                    minimized ? 'hidden' : ''
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                {tabs.map((tab) => (
                    <TerminalSession
                        key={tab.id}
                        active={tab.id === activeTab.id}
                        getToken={getToken}
                        onStatusChange={onStatusChange}
                        tab={tab}
                    />
                ))}
            </div>
        </section>
    )
}

export default TerminalDock
