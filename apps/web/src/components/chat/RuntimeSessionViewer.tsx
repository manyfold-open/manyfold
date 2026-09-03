import { chatCapabilitiesByFramework } from '@manyfold/shared'
import type {
    ChatCapabilities,
    ChatMessage,
    RuntimeSessionCandidate,
    RuntimeSessionViewResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import EmptyState from '@/components/EmptyState'
import { MessageBubble } from '@/components/chat/MessageList'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import {
    CheckIcon,
    EllipsisVerticalIcon,
    PreviewIcon,
    RawIcon,
    RestoreIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'

interface RuntimeSessionViewerProps {
    agentId: string
    sessionId: string | null
    onClose: () => void
    onApplied: (sessionId?: string) => void
}

const RuntimeSessionViewer: FC<RuntimeSessionViewerProps> = ({
    agentId,
    sessionId,
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
    const [pickedRef, setPickedRef] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [previewMode, setPreviewMode] = useState<'preview' | 'raw'>('preview')
    const autoPickedRef = useRef(false)
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

    const loadRuntimeSession = useCallback(
        async (sessionRef?: string): Promise<void> => {
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
                        ...(sessionRef ? { sessionRef } : {}),
                        ...(previewModeRef.current === 'raw'
                            ? { includeRaw: true }
                            : {})
                    },
                    { signal: controller.signal }
                )
                if (seq !== requestSeqRef.current) return
                setPickedRef(res.selectedSessionRef)
                setResult(res)
            } catch (err) {
                if (controller.signal.aborted || seq !== requestSeqRef.current)
                    return
                setError(apiErrorMessage(err))
            } finally {
                if (seq === requestSeqRef.current) setLoading(false)
            }
        },
        [agentId, client, sessionId]
    )

    useEffect(() => {
        void loadRuntimeSession()
    }, [loadRuntimeSession])

    const loadRawContent = useCallback(
        async (sessionRef: string): Promise<void> => {
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
        },
        [agentId, client, sessionId]
    )

    const handleModeChange = useCallback(
        (mode: 'preview' | 'raw'): void => {
            setPreviewMode(mode)
            previewModeRef.current = mode
            if (
                mode === 'raw' &&
                result &&
                result.rawLocalText == null &&
                result.selectedSessionRef
            )
                void loadRawContent(result.selectedSessionRef)
        },
        [loadRawContent, result]
    )

    const handlePick = useCallback(
        async (candidate: RuntimeSessionCandidate): Promise<void> => {
            setPickedRef(candidate.sessionRef)
            await loadRuntimeSession(candidate.sessionRef)
        },
        [loadRuntimeSession]
    )

    useEffect(() => {
        if (autoPickedRef.current) return
        if (!result?.needsCandidatePick) return
        if (result.candidates.length !== 1) return
        autoPickedRef.current = true
        void handlePick(result.candidates[0])
    }, [result, handlePick])

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

    const showPicker = result?.needsCandidatePick ?? false
    const rawMissingCount = result?.rawMissingCount ?? 0
    const selectedCloudSessionId = result?.selectedCloudSessionId ?? null
    const restoreAction = runtimeSessionAction({
        applying,
        rawMissingCount,
        selectedCloudSessionId,
        selectedSessionRef: result?.selectedSessionRef ?? null,
        sessionId,
        t
    })
    const rebuildAction = runtimeSessionRebuildAction({
        applying,
        selectedCloudSessionId,
        selectedSessionRef: result?.selectedSessionRef ?? null,
        t
    })

    return (
        <div
            className='flex min-h-0 w-full flex-1 flex-col'
            aria-label={t('web.runtimeSession.viewerLabel')}
        >
            <header className='border-divider/80 flex min-h-11 shrink-0 items-center gap-2 border-b px-3'>
                <div className='min-w-0 flex-1'>
                    {!showPicker && result && !loading ? (
                        <RuntimeSessionSelect
                            candidates={result.candidates}
                            currentSessionRef={
                                result.selectedCloudSessionId === sessionId
                                    ? result.currentSessionRef
                                    : null
                            }
                            value={result.selectedSessionRef}
                            onSelect={(ref) => void loadRuntimeSession(ref)}
                            t={t}
                        />
                    ) : (
                        <div className='text-ui text-fg truncate font-medium'>
                            {t('web.runtimeSession.sessionLabel')}
                        </div>
                    )}
                </div>
                <RuntimeSessionMenu
                    applying={applying}
                    disabled={showPicker || !result || loading}
                    mode={previewMode}
                    rebuildAction={rebuildAction}
                    restoreAction={restoreAction}
                    onModeChange={handleModeChange}
                    onRebuildParsed={() => void handleRebuildParsed()}
                    onRestore={() => void handleRestore()}
                    t={t}
                />
            </header>

            <div className='min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-4'>
                {loading && (
                    <div className='text-ui text-muted flex flex-col gap-1'>
                        <div className='flex items-center gap-2'>
                            <Spinner size={16} />
                            {pickedRef
                                ? t('web.runtimeSession.loadingParsing')
                                : t('web.runtimeSession.loadingReading')}
                        </div>
                    </div>
                )}

                {error && !loading && (
                    <div className='workbench-alert-error'>{error}</div>
                )}

                {result && !loading && showPicker && (
                    <CandidatePicker
                        candidates={result.candidates}
                        onPick={(c) => void handlePick(c)}
                        pickedRef={pickedRef}
                        t={t}
                    />
                )}

                {result && !loading && !showPicker && (
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
                    label={result?.sourceFile ?? undefined}
                    placement='top'
                    className='min-w-0'
                >
                    <span className='w-full truncate font-mono'>
                        {result?.sourceFile ??
                            (loading
                                ? t('web.runtimeSession.preparing')
                                : t('web.runtimeSession.unavailable'))}
                    </span>
                </ShortcutTooltip>
            </footer>
        </div>
    )
}

interface CandidatePickerProps {
    candidates: RuntimeSessionCandidate[]
    onPick: (candidate: RuntimeSessionCandidate) => void
    pickedRef: string | null
    t: TFn
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

const RuntimeSessionSelect: FC<{
    candidates: RuntimeSessionCandidate[]
    currentSessionRef: string | null
    value: string | null
    onSelect: (sessionRef: string) => void
    t: TFn
}> = ({ candidates, currentSessionRef, value, onSelect, t }): ReactNode => {
    const hasValue = value
        ? candidates.some((candidate) => candidate.sessionRef === value)
        : true
    if (candidates.length === 0) {
        return (
            <div className='min-w-0 truncate font-mono'>
                {value ?? t('web.runtimeSession.noRuntimeSessions')}
            </div>
        )
    }
    return (
        <WorkbenchSelect
            size='sm'
            mono
            className='w-full min-w-0'
            ariaLabel={t('web.runtimeSession.selectPlaceholder')}
            placeholder={t('web.runtimeSession.selectPlaceholder')}
            value={value ?? ''}
            onChange={(next) => {
                if (next) onSelect(next)
            }}
            options={[
                ...(value && !hasValue
                    ? [
                          {
                              value,
                              label: runtimeSessionOptionLabel({
                                  currentSessionRef,
                                  messageCount: null,
                                  sessionRef: value,
                                  t
                              })
                          }
                      ]
                    : []),
                ...candidates.map((candidate) => ({
                    value: candidate.sessionRef,
                    label: runtimeSessionOptionLabel({
                        currentSessionRef,
                        messageCount: candidate.messageCount,
                        sessionRef: candidate.sessionRef,
                        t
                    })
                }))
            ]}
        />
    )
}

const runtimeSessionOptionLabel = (input: {
    currentSessionRef: string | null
    messageCount: number | null
    sessionRef: string
    t: TFn
}): string => {
    const parts = [input.sessionRef]
    if (input.messageCount && input.messageCount > 0)
        parts.push(`(${input.messageCount})`)
    if (input.currentSessionRef === input.sessionRef)
        parts.push(input.t('web.runtimeSession.currentWebSession'))
    return parts.join(' - ')
}

const CandidatePicker: FC<CandidatePickerProps> = ({
    candidates,
    onPick,
    pickedRef,
    t
}): ReactNode => (
    <div className='workbench-panel-subtle px-4 py-3'>
        <div className='text-caption text-fg font-medium'>
            {t('web.runtimeSession.selectOne')}
        </div>
        {candidates.length === 0 ? (
            <div className='text-caption text-muted mt-2'>
                {t('web.runtimeSession.noCandidatesFound')}
            </div>
        ) : (
            <ol className='mt-2 space-y-1.5'>
                {candidates.map((c, i) => (
                    <li key={c.sessionRef}>
                        <button
                            type='button'
                            className={[
                                'shadow-ring-light flex w-full flex-col items-start gap-1 rounded-md bg-white px-3 py-2 text-left transition-colors',
                                pickedRef === c.sessionRef
                                    ? 'ring-link ring-2'
                                    : 'hover:bg-surface-hover'
                            ].join(' ')}
                            onClick={() => onPick(c)}
                        >
                            <div className='text-caption text-muted flex w-full items-center justify-between font-mono'>
                                <span className='truncate'>{c.sessionRef}</span>
                                <span className='ml-2 flex shrink-0 items-center gap-2'>
                                    {i === 0 && (
                                        <span className='tag tag-neutral'>
                                            {t('web.runtimeSession.recent')}
                                        </span>
                                    )}
                                    <span>
                                        {t('web.runtimeSession.messageCount', {
                                            count: c.messageCount
                                        })}
                                    </span>
                                </span>
                            </div>
                            <div className='text-caption text-fg whitespace-pre-wrap break-words'>
                                {c.firstUserMessage ??
                                    t('web.runtimeSession.noUserMessage')}
                            </div>
                            <div className='text-caption text-placeholder font-mono'>
                                {c.timestamp ?? ''} · {c.sourceFile}
                            </div>
                        </button>
                    </li>
                ))}
            </ol>
        )}
    </div>
)

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

export default memo(RuntimeSessionViewer)
