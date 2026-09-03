import type {
    FC,
    KeyboardEvent as ReactKeyboardEvent,
    PointerEvent as ReactPointerEvent,
    ReactNode
} from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { SdkAgent } from '@manyfold/sdk'
import {
    ChevronDownIcon,
    ChevronUpIcon,
    CloseIcon,
    PlusIcon,
    TerminalIcon
} from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useTheme } from '@/lib/theme'
import { useFontSize } from '@/lib/fontSize'
import type { FontSizeMode } from '@/lib/fontSize'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import { isUpstreamTerminalSessionInfo } from '@/lib/terminalSession'

export type TerminalConnectionStatus =
    | 'connecting'
    | 'open'
    | 'closed'
    | 'error'

// What a session connects to: an agent's shell (the dock tabs) or a bare host
// shell addressed by runtime (the runtime page's sign-in terminal).
export interface TerminalSessionTarget {
    id: string
    agentId?: string
    runtimeId?: string
    cwdPath?: string
    cwdRootId?: string
}

export interface TerminalTabModel {
    agentId: string
    agentName: string
    cwdLabel?: string
    cwdPath?: string
    cwdRootId?: string
    framework: SdkAgent['framework']
    id: string
    index: number
    runtime: SdkAgent['runtime']
    status: TerminalConnectionStatus
}

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

interface TerminalSessionProps {
    active: boolean
    getToken: () => Promise<string>
    onStatusChange: (tabId: string, status: TerminalConnectionStatus) => void
    tab: TerminalSessionTarget
    // Typed into the shell once, on its first output (the prompt). Any
    // earlier and the daemon's PTY is not open yet to receive it.
    initialInput?: string
}

const lightTheme = {
    background: '#ecf0f3',
    foreground: '#0a0c0f',
    cursor: '#0a0c0f',
    selectionBackground: 'rgba(74, 94, 114, 0.22)',
    black: '#0a0c0f',
    red: '#c0584c',
    green: '#3d7f70',
    yellow: '#8a7855',
    blue: '#4a5e72',
    magenta: '#7f5f78',
    cyan: '#4e7a76',
    white: '#e4e7ea',
    brightBlack: '#525861',
    brightWhite: '#f3f6f8'
}

/* The --text-code rung per display mode (styles.css). Mirrored as numbers
   because xterm's fontSize is a number, not a CSS value. */
const terminalFontSize: Record<FontSizeMode, number> = {
    compact: 11,
    default: 12,
    large: 13
}

const darkTheme = {
    background: '#1b1b1f',
    foreground: '#f4f4f5',
    cursor: '#f4f4f5',
    selectionBackground: 'rgba(88, 166, 255, 0.26)',
    black: '#0f0f11',
    red: '#ff8b80',
    green: '#6ee7a8',
    yellow: '#facc15',
    blue: '#58a6ff',
    magenta: '#f56bb8',
    cyan: '#67e8f9',
    white: '#f4f4f5',
    brightBlack: '#9e9ea6',
    brightWhite: '#ffffff'
}

// The wire frame for keystrokes: a 0x00 tag byte, then UTF-8.
const encodeTerminalInput = (data: string): Uint8Array => {
    const encoded = new TextEncoder().encode(data)
    const frame = new Uint8Array(encoded.length + 1)
    frame[0] = 0x00
    frame.set(encoded, 1)
    return frame
}

const buildWsUrl = (
    tab: TerminalSessionTarget,
    token: string,
    cols: number,
    rows: number
): string => {
    const base = import.meta.env.VITE_API_URL ?? '/api'
    const params = new URLSearchParams({
        token,
        cols: String(cols),
        rows: String(rows)
    })
    if (tab.runtimeId) params.set('runtimeId', tab.runtimeId)
    else if (tab.agentId) params.set('agentId', tab.agentId)
    if (tab.cwdPath) params.set('cwdPath', tab.cwdPath)
    if (tab.cwdRootId) params.set('cwdRootId', tab.cwdRootId)

    if (base.startsWith('http://') || base.startsWith('https://')) {
        const url = new URL(base)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.pathname = `${url.pathname.replace(/\/$/, '')}/terminal`
        url.search = `?${params.toString()}`
        return url.toString()
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = `${base.replace(/\/$/, '')}/terminal`
    return `${protocol}//${window.location.host}${path}?${params.toString()}`
}

const statusLabel = (status: TerminalConnectionStatus, t: TFn): string => {
    switch (status) {
        case 'connecting':
            return t('web.terminal.statusConnecting')
        case 'open':
            return t('web.terminal.statusOpen')
        case 'closed':
            return t('web.terminal.statusClosed')
        default:
            return t('web.terminal.statusError')
    }
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

export const TerminalSession: FC<TerminalSessionProps> = ({
    active,
    getToken,
    onStatusChange,
    tab,
    initialInput
}): ReactNode => {
    const { t } = useI18n()
    const { theme } = useTheme()
    const { fontSize } = useFontSize()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const activeRef = useRef(active)
    const disposedRef = useRef(false)
    const connectIdRef = useRef(0)
    const getTokenRef = useRef(getToken)
    const onStatusChangeRef = useRef(onStatusChange)
    const themeRef = useRef(theme)
    const fontSizeRef = useRef(fontSize)
    const retriesRef = useRef(0)
    const reconnectTimerRef = useRef<number | null>(null)
    const initialInputRef = useRef(initialInput)
    // Once per mount, not per connection: a reconnect must not re-run it.
    const initialInputSentRef = useRef(false)
    const [status, setStatus] = useState<TerminalConnectionStatus>('connecting')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [limitedTerminal, setLimitedTerminal] = useState(false)
    const [attempt, setAttempt] = useState(0)

    getTokenRef.current = getToken
    onStatusChangeRef.current = onStatusChange
    themeRef.current = theme
    fontSizeRef.current = fontSize

    const setConnectionStatus = useCallback(
        (
            next: TerminalConnectionStatus,
            message: string | null = null
        ): void => {
            if (disposedRef.current) return
            setStatus(next)
            setErrorMessage(message)
            onStatusChangeRef.current(tab.id, next)
        },
        [tab.id]
    )

    const disconnect = useCallback((): void => {
        if (reconnectTimerRef.current !== null) {
            window.clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
        }
        const ws = wsRef.current
        wsRef.current = null
        if (!ws) return
        try {
            ws.close(1000, 'client disposed')
        } catch {}
    }, [])

    const fitTerminal = useCallback((): void => {
        if (!activeRef.current) return
        const fit = fitRef.current
        const term = terminalRef.current
        if (!fit || !term) return
        try {
            fit.fit()
        } catch {}

        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        try {
            ws.send(
                JSON.stringify({
                    type: 'resize',
                    cols: term.cols,
                    rows: term.rows
                })
            )
        } catch {}
    }, [])

    const connect = useCallback(async (): Promise<void> => {
        const term = terminalRef.current
        const fit = fitRef.current
        if (!term || !fit) return

        disconnect()
        const connectId = connectIdRef.current + 1
        connectIdRef.current = connectId
        setLimitedTerminal(false)
        setConnectionStatus('connecting')

        const token = await getTokenRef.current()
        if (disposedRef.current || connectId !== connectIdRef.current) return
        if (!token) {
            setConnectionStatus('error', t('web.terminal.noAuthToken'))
            term.write('\r\n\x1b[31m[error] no auth token\x1b[0m\r\n')
            return
        }

        let dim = fit.proposeDimensions()
        if (!dim) dim = { cols: 80, rows: 24 }

        const ws = new WebSocket(buildWsUrl(tab, token, dim.cols, dim.rows))
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        ws.onopen = (): void => {
            if (disposedRef.current || wsRef.current !== ws) return
            if (activeRef.current) {
                fitTerminal()
                term.focus()
            }
        }

        ws.onmessage = (event: MessageEvent): void => {
            if (disposedRef.current || wsRef.current !== ws) return
            if (typeof event.data === 'string') {
                handleTerminalTextFrame(
                    event.data,
                    term,
                    setConnectionStatus,
                    () => {
                        retriesRef.current = 0
                        setConnectionStatus('open')
                        if (activeRef.current) {
                            fitTerminal()
                            term.focus()
                        }
                    },
                    () => setLimitedTerminal(true)
                )
                return
            }

            const flushInitialInput = (): void => {
                const input = initialInputRef.current
                if (!input || initialInputSentRef.current) return
                initialInputSentRef.current = true
                try {
                    ws.send(encodeTerminalInput(input))
                } catch {}
            }
            if (event.data instanceof Blob) {
                void event.data.arrayBuffer().then((buffer) => {
                    if (disposedRef.current || wsRef.current !== ws) return
                    term.write(new Uint8Array(buffer))
                    flushInitialInput()
                })
                return
            }

            term.write(new Uint8Array(event.data as ArrayBuffer))
            flushInitialInput()
        }

        ws.onerror = (): void => {
            if (disposedRef.current || wsRef.current !== ws) return
            setConnectionStatus('error', t('web.terminal.wsError'))
        }

        ws.onclose = (event: CloseEvent): void => {
            if (disposedRef.current || wsRef.current !== ws) return
            setConnectionStatus('closed')
            const recoverable =
                event.code === 1012 ||
                event.code === 1011 ||
                event.code === 1006
            if (!recoverable) return
            if (retriesRef.current >= 3) return
            retriesRef.current += 1
            const delay = 500 + Math.random() * 1000
            reconnectTimerRef.current = window.setTimeout(() => {
                reconnectTimerRef.current = null
                if (disposedRef.current) return
                setAttempt((value) => value + 1)
            }, delay)
        }
    }, [
        disconnect,
        fitTerminal,
        setConnectionStatus,
        t,
        tab.agentId,
        tab.runtimeId,
        tab.cwdPath,
        tab.cwdRootId
    ])

    useEffect(() => {
        const el = containerRef.current
        if (!el) return

        disposedRef.current = false
        const term = new Terminal({
            cursorBlink: true,
            fontFamily:
                '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace',
            fontSize: terminalFontSize[fontSizeRef.current],
            lineHeight: 1.25,
            scrollback: 5000,
            theme: themeRef.current === 'dark' ? darkTheme : lightTheme
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(el)
        terminalRef.current = term
        fitRef.current = fit

        term.onData((data): void => {
            const ws = wsRef.current
            if (!ws || ws.readyState !== WebSocket.OPEN) return
            ws.send(encodeTerminalInput(data))
        })

        term.onResize(({ cols, rows }): void => {
            const ws = wsRef.current
            if (!ws || ws.readyState !== WebSocket.OPEN) return
            try {
                ws.send(JSON.stringify({ type: 'resize', cols, rows }))
            } catch {}
        })

        const observer = new ResizeObserver(() => {
            fitTerminal()
        })
        observer.observe(el)

        requestAnimationFrame(() => {
            fitTerminal()
        })

        return (): void => {
            disposedRef.current = true
            observer.disconnect()
            disconnect()
            term.dispose()
            terminalRef.current = null
            fitRef.current = null
        }
    }, [disconnect, fitTerminal])

    useEffect(() => {
        void connect()
        return disconnect
    }, [attempt, connect, disconnect])

    useEffect(() => {
        activeRef.current = active
        if (!active) return
        requestAnimationFrame(() => {
            fitTerminal()
            terminalRef.current?.focus()
        })
    }, [active, fitTerminal])

    useEffect(() => {
        const term = terminalRef.current
        if (!term) return
        term.options.theme = theme === 'dark' ? darkTheme : lightTheme
    }, [theme])

    useEffect(() => {
        const term = terminalRef.current
        if (!term) return
        term.options.fontSize = terminalFontSize[fontSize]
        fitTerminal()
    }, [fitTerminal, fontSize])

    return (
        <div
            className={[
                'absolute inset-0 min-h-0',
                active ? 'block' : 'hidden'
            ].join(' ')}
        >
            {status === 'open' && limitedTerminal && (
                <div className='text-caption absolute right-3 top-2 z-10 flex h-7 max-w-[calc(100%-1.5rem)] items-center rounded-md bg-[#f59e0b]/10 px-2.5 text-[#b45309] backdrop-blur'>
                    <span className='min-w-0 truncate'>
                        {t('web.terminal.limitedPty')}
                    </span>
                </div>
            )}
            {status !== 'open' && (
                <div className='text-caption text-subtle bg-surface/90 shadow-ring-light absolute right-3 top-2 z-10 flex h-7 max-w-[calc(100%-1.5rem)] items-center gap-3 rounded-md px-2.5 backdrop-blur'>
                    <span className='min-w-0 truncate'>
                        {statusLabel(status, t)}
                        {errorMessage ? `: ${errorMessage}` : ''}
                    </span>
                    {(status === 'closed' || status === 'error') && (
                        <button
                            type='button'
                            onClick={() => setAttempt((value) => value + 1)}
                            className='text-caption text-fg hover:bg-soft inline-flex h-5 shrink-0 items-center rounded-md px-1.5 font-medium transition-colors'
                        >
                            {t('web.terminal.reconnect')}
                        </button>
                    )}
                </div>
            )}
            <div
                ref={containerRef}
                className='mf-terminal bg-surface h-full w-full overflow-hidden'
            />
        </div>
    )
}

const handleTerminalTextFrame = (
    frame: string,
    term: Terminal,
    setConnectionStatus: (
        status: TerminalConnectionStatus,
        message?: string | null
    ) => void,
    onUpstreamOpen: () => void,
    onLimitedTerminal: () => void
): void => {
    try {
        const msg = JSON.parse(frame) as {
            type?: string
            message?: string
            exit_code?: number
            session_id?: string
            terminal_pty?: boolean | null
        }
        if (msg.type === 'session_info') {
            if (isUpstreamTerminalSessionInfo(msg)) onUpstreamOpen()
            if (msg.terminal_pty === false) onLimitedTerminal()
            return
        }
        if (msg.type === 'error' && msg.message) {
            setConnectionStatus('error', msg.message)
            term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`)
            return
        }
        if (msg.type === 'exit') {
            term.write(
                `\r\n\x1b[33m[session ended exit=${msg.exit_code ?? 0}]\x1b[0m\r\n`
            )
        }
    } catch {}
}

export default TerminalDock
