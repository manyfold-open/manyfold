import { chatCapabilitiesByFramework } from '@manyfold/shared'
import type {
    ChatCapabilities,
    ChatMessage,
    RuntimeSessionCandidate,
    RuntimeSessionListResponse,
    RuntimeSessionViewResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import EmptyState from '@/components/EmptyState'
import { MessageBubble } from '@/components/chat/MessageList'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import {
    ArrowLeftIcon,
    CheckIcon,
    EllipsisVerticalIcon,
    PreviewIcon,
    RawIcon,
    RestoreIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { Spinner } from '@/components/Loading'
import { formatDateTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import { timeAgo } from '@/lib/timeAgo'

interface AgentSessionHistoryProps {
    agentId: string
    sessionId: string | null
    onClose: () => void
    onApplied: (sessionId?: string) => void
}

const AgentSessionHistory: FC<AgentSessionHistoryProps> = ({
    agentId,
    sessionId,
    onClose,
    onApplied
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [openCandidate, setOpenCandidate] =
        useState<RuntimeSessionCandidate | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [result, setResult] = useState<RuntimeSessionListResponse | null>(
        null
    )

    // The scan belongs to the panel, not to the list view: it walks every
    // transcript on the runtime, so opening a session and coming back must not
    // pay for it twice.
    useEffect(() => {
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        void (async (): Promise<void> => {
            try {
                const res = await client.chat.runtimeSessionList(
                    agentId,
                    sessionId ? { sessionId } : {},
                    { signal: controller.signal }
                )
                if (controller.signal.aborted) return
                setResult(res)
            } catch (err) {
                if (controller.signal.aborted) return
                setError(apiErrorMessage(err))
            } finally {
                if (!controller.signal.aborted) setLoading(false)
            }
        })()
        return (): void => controller.abort()
    }, [agentId, client, sessionId])

    return (
        <div
            className='flex min-h-0 w-full flex-1 flex-col'
            aria-label={t('web.runtimeSession.viewerLabel')}
        >
            {/* The list stays mounted behind the detail: re-rendering it is
                free, refetching it is not, and it keeps its scroll position. */}
            <div
                className={
                    openCandidate
                        ? 'hidden'
                        : 'flex min-h-0 w-full flex-1 flex-col'
                }
            >
                <SessionList
                    error={error}
                    loading={loading}
                    onOpen={setOpenCandidate}
                    result={result}
                />
            </div>
            {openCandidate && (
                <SessionDetail
                    agentId={agentId}
                    candidate={openCandidate}
                    sessionId={sessionId}
                    onBack={() => setOpenCandidate(null)}
                    onClose={onClose}
                    onApplied={onApplied}
                />
            )}
        </div>
    )
}

const SessionList: FC<{
    error: string | null
    loading: boolean
    onOpen: (candidate: RuntimeSessionCandidate) => void
    result: RuntimeSessionListResponse | null
}> = ({ error, loading, onOpen, result }): ReactNode => {
    const { t } = useI18n()

    if (loading)
        return (
            <div className='text-ui text-muted flex items-center gap-2 px-4 py-4'>
                <Spinner size={16} />
                {t('web.runtimeSession.loadingList')}
            </div>
        )

    if (error)
        return (
            <div className='px-4 py-4'>
                <div className='workbench-alert-error'>{error}</div>
            </div>
        )

    const candidates = result?.candidates ?? []
    if (candidates.length === 0)
        return (
            <EmptyState
                kind='all-clear'
                tier='stack'
                title={t('web.runtimeSession.emptyTitle')}
                body={t('web.runtimeSession.emptyBody')}
            />
        )

    return (
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3'>
            <ol className='space-y-2'>
                {candidates.map((candidate) => (
                    <li key={candidate.sessionRef}>
                        <SessionRow
                            candidate={candidate}
                            isCurrent={
                                candidate.sessionRef ===
                                result?.currentSessionRef
                            }
                            onOpen={() => onOpen(candidate)}
                            t={t}
                        />
                    </li>
                ))}
            </ol>
        </div>
    )
}

const SessionRow: FC<{
    candidate: RuntimeSessionCandidate
    isCurrent: boolean
    onOpen: () => void
    t: TFn
}> = ({ candidate, isCurrent, onOpen, t }): ReactNode => {
    const lastActive = candidate.lastActiveAt ?? candidate.timestamp
    return (
        <button
            type='button'
            onClick={onOpen}
            className='bg-surface hover:bg-surface-hover shadow-ring-light flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left transition-colors'
        >
            <span className='flex w-full items-center gap-2'>
                <span
                    className={[
                        'text-ui text-fg min-w-0 flex-1 truncate font-medium',
                        candidate.firstUserMessage ? '' : 'font-mono'
                    ].join(' ')}
                >
                    {candidate.firstUserMessage ?? candidate.sessionRef}
                </span>
                {isCurrent && (
                    <span className='tag tag-neutral shrink-0'>
                        {t('web.runtimeSession.currentWebSession')}
                    </span>
                )}
            </span>
            <span className='text-caption text-muted line-clamp-2'>
                {candidate.lastAssistantMessage ??
                    t('web.runtimeSession.noAssistantReply')}
            </span>
            <span className='text-caption text-subtle flex flex-wrap items-center gap-x-1.5'>
                {candidate.model && (
                    <>
                        <span className='truncate font-mono'>
                            {candidate.model}
                        </span>
                        <span aria-hidden='true'>·</span>
                    </>
                )}
                <span className='tabular-nums'>
                    {t('web.runtimeSession.messageCount', {
                        count: candidate.messageCount
                    })}
                </span>
                {lastActive && (
                    <>
                        <span aria-hidden='true'>·</span>
                        <ShortcutTooltip label={formatDateTime(lastActive)}>
                            <span className='tabular-nums'>
                                {timeAgo(lastActive)}
                            </span>
                        </ShortcutTooltip>
                    </>
                )}
            </span>
        </button>
    )
}

const SessionDetail: FC<{
    agentId: string
    candidate: RuntimeSessionCandidate
    sessionId: string | null
    onBack: () => void
    onClose: () => void
    onApplied: (sessionId?: string) => void
}> = ({
    agentId,
    candidate,
    sessionId,
    onBack,
    onClose,
    onApplied
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [loading, setLoading] = useState(true)
    const [applying, setApplying] = useState(false)
    const [rawLoading, setRawLoading] = useState(false)
    const [result, setResult] = useState<RuntimeSessionViewResponse | null>(
        null
    )
    const [error, setError] = useState<string | null>(null)
    const [previewMode, setPreviewMode] = useState<'preview' | 'raw'>('preview')
    // Synchronous guards: `applying`/request state only lands after a React
    // re-render, and restore creates a NEW session server-side per call — a
    // double-click must be stopped before the state updates, not after.
    const applyingRef = useRef(false)
    const requestSeqRef = useRef(0)
    const abortRef = useRef<AbortController | null>(null)
    const rawAbortRef = useRef<AbortController | null>(null)
    const previewModeRef = useRef(previewMode)

    useEffect(
        () => () => {
            abortRef.current?.abort()
            rawAbortRef.current?.abort()
        },
        []
    )

    const sessionRef = candidate.sessionRef

    const loadRuntimeSession = useCallback(async (): Promise<void> => {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        const seq = ++requestSeqRef.current
        setLoading(true)
        setError(null)
        try {
            const res = await client.chat.runtimeSessionView(
                agentId,
                {
                    ...(sessionId ? { sessionId } : {}),
                    sessionRef,
                    ...(previewModeRef.current === 'raw'
                        ? { includeRaw: true }
                        : {})
                },
                { signal: controller.signal }
            )
            if (seq !== requestSeqRef.current) return
            setResult(res)
        } catch (err) {
            if (controller.signal.aborted || seq !== requestSeqRef.current)
                return
            setError(apiErrorMessage(err))
        } finally {
            if (seq === requestSeqRef.current) setLoading(false)
        }
    }, [agentId, client, sessionId, sessionRef])

    useEffect(() => {
        void loadRuntimeSession()
    }, [loadRuntimeSession])

    const loadRawContent = useCallback(async (): Promise<void> => {
        rawAbortRef.current?.abort()
        const controller = new AbortController()
        rawAbortRef.current = controller
        setRawLoading(true)
        try {
            const res = await client.chat.runtimeSessionView(
                agentId,
                {
                    ...(sessionId ? { sessionId } : {}),
                    sessionRef,
                    includeRaw: true
                },
                { signal: controller.signal }
            )
            if (controller.signal.aborted) return
            setResult((prev) =>
                prev && prev.selectedSessionRef === res.selectedSessionRef
                    ? { ...prev, rawLocalText: res.rawLocalText }
                    : prev
            )
        } catch (err) {
            if (!controller.signal.aborted) setError(apiErrorMessage(err))
        } finally {
            if (!controller.signal.aborted) setRawLoading(false)
        }
    }, [agentId, client, sessionId, sessionRef])

    const handleModeChange = useCallback(
        (mode: 'preview' | 'raw'): void => {
            setPreviewMode(mode)
            previewModeRef.current = mode
            if (mode === 'raw' && result && result.rawLocalText == null)
                void loadRawContent()
        },
        [loadRawContent, result]
    )

    const handleRestore = useCallback(async (): Promise<void> => {
        if (!result?.selectedSessionRef) return
        if (applyingRef.current) return
        applyingRef.current = true
        setApplying(true)
        setError(null)
        try {
            if (sessionId && result.selectedCloudSessionId === sessionId) {
                await client.chat.runtimeSessionRecoverRaw(agentId, {
                    sessionId,
                    sessionRef: result.selectedSessionRef
                })
                onApplied()
            } else if (result.selectedCloudSessionId) {
                onApplied(result.selectedCloudSessionId)
            } else {
                const restored = await client.chat.runtimeSessionRestore(
                    agentId,
                    result.selectedSessionRef
                )
                onApplied(restored.session.id)
            }
            onClose()
        } catch (err) {
            setError(apiErrorMessage(err))
            setApplying(false)
        } finally {
            applyingRef.current = false
        }
    }, [agentId, client, onApplied, onClose, result, sessionId])

    const handleRebuildParsed = useCallback(async (): Promise<void> => {
        if (!result?.selectedSessionRef || !result.selectedCloudSessionId)
            return
        if (applyingRef.current) return
        applyingRef.current = true
        setApplying(true)
        setError(null)
        try {
            const rebuilt = await client.chat.runtimeSessionRebuildParsed(
                agentId,
                {
                    sessionId: result.selectedCloudSessionId,
                    sessionRef: result.selectedSessionRef
                }
            )
            if (rebuilt.session.id === sessionId) onApplied()
            else onApplied(rebuilt.session.id)
            onClose()
        } catch (err) {
            setError(apiErrorMessage(err))
            setApplying(false)
        } finally {
            applyingRef.current = false
        }
    }, [agentId, client, onApplied, onClose, result, sessionId])

    const restoreAction = runtimeSessionAction({
        applying,
        rawMissingCount: result?.rawMissingCount ?? 0,
        selectedCloudSessionId: result?.selectedCloudSessionId ?? null,
        selectedSessionRef: result?.selectedSessionRef ?? null,
        sessionId,
        t
    })
    const rebuildAction = runtimeSessionRebuildAction({
        applying,
        selectedCloudSessionId: result?.selectedCloudSessionId ?? null,
        selectedSessionRef: result?.selectedSessionRef ?? null,
        t
    })
    const messageCount = result
        ? result.parsedLocalMessages.length
        : candidate.messageCount
    const lastActive = candidate.lastActiveAt ?? candidate.timestamp

    return (
        <>
            <header className='border-divider/80 flex min-h-11 shrink-0 items-center gap-1 border-b px-2'>
                <button
                    type='button'
                    onClick={onBack}
                    aria-label={t('web.runtimeSession.back')}
                    className='text-muted hover:bg-surface-hover hover:text-fg rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors'
                >
                    <ArrowLeftIcon className='h-4 w-4' />
                </button>
                <span
                    className={[
                        'text-ui text-fg min-w-0 flex-1 truncate font-medium',
                        candidate.firstUserMessage ? '' : 'font-mono'
                    ].join(' ')}
                >
                    {candidate.firstUserMessage ?? candidate.sessionRef}
                </span>
                <RuntimeSessionMenu
                    applying={applying}
                    disabled={!result || loading}
                    mode={previewMode}
                    rebuildAction={rebuildAction}
                    restoreAction={restoreAction}
                    onModeChange={handleModeChange}
                    onRebuildParsed={() => void handleRebuildParsed()}
                    onRestore={() => void handleRestore()}
                    t={t}
                />
            </header>

            <div className='border-divider/60 text-caption text-subtle flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2'>
                {candidate.model && (
                    <span className='truncate font-mono'>
                        {candidate.model}
                    </span>
                )}
                <span className='tabular-nums'>
                    {t('web.runtimeSession.messageCount', {
                        count: messageCount
                    })}
                </span>
                {lastActive && (
                    <span className='tabular-nums'>
                        {formatDateTime(lastActive)}
                    </span>
                )}
                <ShortcutTooltip
                    label={candidate.sessionRef}
                    className='ml-auto min-w-0'
                >
                    <span className='truncate font-mono'>
                        {candidate.sessionRef}
                    </span>
                </ShortcutTooltip>
            </div>

            <div className='min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-4'>
                {loading && (
                    <div className='text-ui text-muted flex items-center gap-2'>
                        <Spinner size={16} />
                        {t('web.runtimeSession.loadingParsing')}
                    </div>
                )}

                {error && !loading && (
                    <div className='workbench-alert-error'>{error}</div>
                )}

                {result && !loading && (
                    <LocalContent
                        result={result}
                        mode={previewMode}
                        rawLoading={rawLoading}
                        capabilities={
                            chatCapabilitiesByFramework[result.framework]
                        }
                        t={t}
                    />
                )}
            </div>

            <footer className='border-divider/80 text-caption text-placeholder flex min-h-9 shrink-0 items-center gap-3 border-t px-4'>
                <ShortcutTooltip
                    label={result?.sourceFile ?? candidate.sourceFile}
                    placement='top'
                    className='min-w-0'
                >
                    <span className='w-full truncate font-mono'>
                        {result?.sourceFile ?? candidate.sourceFile}
                    </span>
                </ShortcutTooltip>
            </footer>
        </>
    )
}

const runtimeSessionAction = (input: {
    applying: boolean
    rawMissingCount: number
    selectedCloudSessionId: string | null
    selectedSessionRef: string | null
    sessionId: string | null
    t: TFn
}): { label: string; title: string } | null => {
    if (!input.selectedSessionRef) return null

    if (input.selectedCloudSessionId === input.sessionId && input.sessionId) {
        if (input.rawMissingCount === 0) return null
        return {
            label: input.applying
                ? input.t('web.runtimeSession.restoring')
                : input.t('web.runtimeSession.restoreRaw'),
            title: input.t('web.runtimeSession.restoreRawTitle')
        }
    }

    if (input.selectedCloudSessionId) {
        return {
            label: input.applying
                ? input.t('web.runtimeSession.opening')
                : input.t('web.runtimeSession.openSession'),
            title: input.t('web.runtimeSession.openSessionTitle')
        }
    }

    return {
        label: input.applying
            ? input.t('web.runtimeSession.restoring')
            : input.t('web.runtimeSession.restoreSession'),
        title: input.t('web.runtimeSession.restoreSessionTitle')
    }
}

const runtimeSessionRebuildAction = (input: {
    applying: boolean
    selectedCloudSessionId: string | null
    selectedSessionRef: string | null
    t: TFn
}): { label: string; title: string } | null => {
    if (!input.selectedSessionRef || !input.selectedCloudSessionId) return null
    return {
        label: input.applying
            ? input.t('web.runtimeSession.rebuilding')
            : input.t('web.runtimeSession.rebuildParsed'),
        title: input.t('web.runtimeSession.rebuildParsedTitle')
    }
}

const RuntimeSessionMenu: FC<{
    applying: boolean
    disabled: boolean
    mode: 'preview' | 'raw'
    rebuildAction: { label: string; title: string } | null
    restoreAction: { label: string; title: string } | null
    onModeChange: (mode: 'preview' | 'raw') => void
    onRebuildParsed: () => void
    onRestore: () => void
    t: TFn
}> = ({
    applying,
    disabled,
    mode,
    rebuildAction,
    restoreAction,
    onModeChange,
    onRebuildParsed,
    onRestore,
    t
}): ReactNode => {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!open) return
        const handlePointerDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
        }
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return (): void => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    const chooseMode = (nextMode: 'preview' | 'raw'): void => {
        setOpen(false)
        onModeChange(nextMode)
    }

    const runRestore = (): void => {
        setOpen(false)
        onRestore()
    }
    const runRebuildParsed = (): void => {
        setOpen(false)
        onRebuildParsed()
    }
    const hasApplyAction = Boolean(restoreAction || rebuildAction)

    return (
        <div ref={rootRef} className='relative shrink-0'>
            <button
                type='button'
                className='text-muted hover:text-fg hover:bg-soft-hover rounded-pill flex h-8 w-8 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-45'
                aria-label={t('web.runtimeSession.sessionActions')}
                aria-expanded={open}
                aria-haspopup='menu'
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
            >
                <EllipsisVerticalIcon className='h-4 w-4' />
            </button>

            {open && (
                <div
                    role='menu'
                    className='popover-panel shadow-elevated bg-surface absolute right-0 top-full z-30 mt-1.5 w-52 rounded-md p-1'
                >
                    <div className='text-caption text-placeholder px-2.5 pb-1.5 pt-1 font-medium'>
                        {t('web.runtimeSession.viewSection')}
                    </div>
                    <button
                        type='button'
                        role='menuitemradio'
                        aria-checked={mode === 'preview'}
                        className={runtimeMenuItemClass}
                        onClick={() => chooseMode('preview')}
                    >
                        <PreviewIcon className='h-4 w-4 shrink-0' />
                        <span className='min-w-0 flex-1 text-left'>
                            {t('web.runtimeSession.preview')}
                        </span>
                        {mode === 'preview' && (
                            <CheckIcon className='h-3.5 w-3.5 shrink-0' />
                        )}
                    </button>
                    <button
                        type='button'
                        role='menuitemradio'
                        aria-checked={mode === 'raw'}
                        className={runtimeMenuItemClass}
                        onClick={() => chooseMode('raw')}
                    >
                        <RawIcon className='h-4 w-4 shrink-0' />
                        <span className='min-w-0 flex-1 text-left'>
                            {t('web.runtimeSession.raw')}
                        </span>
                        {mode === 'raw' && (
                            <CheckIcon className='h-3.5 w-3.5 shrink-0' />
                        )}
                    </button>

                    {hasApplyAction && (
                        <>
                            <div className='popover-separator' />
                            {restoreAction && (
                                <ShortcutTooltip
                                    label={restoreAction.title}
                                    className='w-full'
                                >
                                    <button
                                        type='button'
                                        role='menuitem'
                                        className={runtimeMenuItemClass}
                                        disabled={applying}
                                        onClick={runRestore}
                                    >
                                        {applying ? (
                                            <Spinner
                                                size={16}
                                                className='shrink-0'
                                            />
                                        ) : (
                                            <RestoreIcon className='h-4 w-4 shrink-0' />
                                        )}
                                        <span className='min-w-0 flex-1 text-left'>
                                            {restoreAction.label}
                                        </span>
                                    </button>
                                </ShortcutTooltip>
                            )}
                            {rebuildAction && (
                                <ShortcutTooltip
                                    label={rebuildAction.title}
                                    className='w-full'
                                >
                                    <button
                                        type='button'
                                        role='menuitem'
                                        className={runtimeMenuItemClass}
                                        disabled={applying}
                                        onClick={runRebuildParsed}
                                    >
                                        {applying ? (
                                            <Spinner
                                                size={16}
                                                className='shrink-0'
                                            />
                                        ) : (
                                            <RestoreIcon className='h-4 w-4 shrink-0' />
                                        )}
                                        <span className='min-w-0 flex-1 text-left'>
                                            {rebuildAction.label}
                                        </span>
                                    </button>
                                </ShortcutTooltip>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

const runtimeMenuItemClass = [
    'text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-55'
].join(' ')

const LocalContent: FC<{
    result: RuntimeSessionViewResponse
    mode: 'preview' | 'raw'
    rawLoading: boolean
    capabilities: ChatCapabilities
    t: TFn
}> = ({ result, mode, rawLoading, capabilities, t }): ReactNode => {
    if (mode === 'raw') {
        if (result.rawLocalText == null)
            return rawLoading ? (
                <div className='text-ui text-muted flex items-center gap-2'>
                    <Spinner size={16} />
                    {t('web.runtimeSession.loadingRaw')}
                </div>
            ) : (
                <EmptyContent text={t('web.runtimeSession.emptyRawContent')} />
            )
        return (
            <RawContent
                rawText={result.rawLocalText}
                emptyText={t('web.runtimeSession.emptyRawContent')}
                t={t}
            />
        )
    }

    return result.parsedLocalMessages.length === 0 ? (
        <EmptyContent text={t('web.runtimeSession.emptyParsedMessages')} />
    ) : (
        <PreviewMessages
            messages={result.parsedLocalMessages}
            capabilities={capabilities}
            t={t}
        />
    )
}

// Long sessions produce payloads the DOM cannot take in one piece: an
// unwindowed list of markdown bubbles or a multi-MB wrapped <pre> freezes the
// main thread for seconds, so both views render a bounded slice.
const PREVIEW_RENDER_LIMIT = 200
const RAW_RENDER_LIMIT_BYTES = 512 * 1024

const PreviewMessages: FC<{
    messages: ChatMessage[]
    capabilities: ChatCapabilities
    t: TFn
}> = ({ messages, capabilities, t }): ReactNode => {
    const shown =
        messages.length > PREVIEW_RENDER_LIMIT
            ? messages.slice(-PREVIEW_RENDER_LIMIT)
            : messages
    return (
        <ol className='space-y-4 pr-1'>
            {messages.length > shown.length && (
                <li className='text-caption text-placeholder'>
                    {t('web.runtimeSession.previewTruncated', {
                        shown: String(shown.length),
                        total: String(messages.length)
                    })}
                </li>
            )}
            {shown.map((msg) => (
                <li key={msg.id}>
                    <MessageBubble message={msg} capabilities={capabilities} />
                </li>
            ))}
        </ol>
    )
}

const RawContent: FC<{
    rawText: string
    emptyText: string
    t: TFn
}> = ({ rawText, emptyText, t }): ReactNode => {
    if (!rawText.trim()) return <EmptyContent text={emptyText} />
    const truncated = rawText.length > RAW_RENDER_LIMIT_BYTES
    const shown = truncated ? rawText.slice(0, RAW_RENDER_LIMIT_BYTES) : rawText
    return (
        <>
            {truncated && (
                <div className='text-caption text-placeholder pb-2'>
                    {t('web.runtimeSession.rawTruncated', {
                        shownKb: String(
                            Math.round(RAW_RENDER_LIMIT_BYTES / 1024)
                        ),
                        totalKb: String(Math.round(rawText.length / 1024))
                    })}
                </div>
            )}
            <pre className='text-caption text-fg whitespace-pre-wrap break-words font-mono leading-6'>
                {shown}
            </pre>
        </>
    )
}

const EmptyContent: FC<{ text: string }> = ({ text }): ReactNode => (
    <EmptyState kind='no-results' tier='line' body={text} className='py-4' />
)

export default memo(AgentSessionHistory)
