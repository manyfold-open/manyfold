import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { SdkAgent } from '@manyfold/sdk'
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

export interface TerminalTabModel {
    agentId: string
    agentName: string
    cwdLabel?: string
    cwdPath?: string
    cwdRootId?: string
    framework: SdkAgent['framework']
    id: string
    index: number
    // Ask the API to open this terminal already inside the framework TUI for
    // that chat session. Only the id travels: the API builds the argv from
    // the session's own stored reference.
    resumeChatSessionId?: string
    // The chat's last message id when this terminal was (re)seeded. A resumed
    // TUI reads the transcript once at startup and never tails it, so when the
    // chat moves past this watermark the tab must be rebuilt (fresh resume) to
    // show those turns. null = unknown yet (messages still loading); the next
    // switch adopts the current id instead of rebuilding.
    seedMessageId?: string | null
    runtime: SdkAgent['runtime']
    status: TerminalConnectionStatus
}

interface TerminalSessionProps {
    active: boolean
    getToken: () => Promise<string>
    onStatusChange: (tabId: string, status: TerminalConnectionStatus) => void
    tab: TerminalTabModel
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

const buildWsUrl = (
    tab: TerminalTabModel,
    token: string,
    cols: number,
    rows: number
): string => {
    const base = import.meta.env.VITE_API_URL ?? '/api'
    const params = new URLSearchParams({
        agentId: tab.agentId,
        token,
        cols: String(cols),
        rows: String(rows)
    })
    if (tab.cwdPath) params.set('cwdPath', tab.cwdPath)
    if (tab.cwdRootId) params.set('cwdRootId', tab.cwdRootId)
    if (tab.resumeChatSessionId)
        params.set('resumeChatSessionId', tab.resumeChatSessionId)

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

const TerminalSession: FC<TerminalSessionProps> = ({
    active,
    getToken,
    onStatusChange,
    tab
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

            if (event.data instanceof Blob) {
                void event.data.arrayBuffer().then((buffer) => {
                    if (disposedRef.current || wsRef.current !== ws) return
                    term.write(new Uint8Array(buffer))
                })
                return
            }

            term.write(new Uint8Array(event.data as ArrayBuffer))
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
        tab.cwdPath,
        tab.cwdRootId,
        tab.resumeChatSessionId
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
            const encoded = new TextEncoder().encode(data)
            const frame = new Uint8Array(encoded.length + 1)
            frame[0] = 0x00
            frame.set(encoded, 1)
            ws.send(frame)
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

export default TerminalSession
