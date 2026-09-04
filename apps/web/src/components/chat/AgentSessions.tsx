import {
    agentSessionListLimits,
    chatCapabilitiesByFramework,
    frameworkResumeCommandLine
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentSessionListItem,
    AgentSessionListResponse,
    ChatCapabilities,
    ChatMessage,
    RuntimeSessionViewResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import EmptyState from '@/components/EmptyState'
import { MessageBubble } from '@/components/chat/MessageList'
import OverflowMenu, { type OverflowMenuEntry } from '@/components/OverflowMenu'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import {
    ArrowLeftIcon,
    CheckIcon,
    EllipsisVerticalIcon,
    PreviewIcon,
    RawIcon,
    RefreshIcon,
    RestoreIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { Ghost, HairlineProgress, Spinner } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { formatDateTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import { timeAgo } from '@/lib/timeAgo'

interface AgentSessionsProps {
    agentId: string
    sessionId: string | null
    onClose: () => void
    onApplied: (sessionId?: string) => void
}

// The last list each agent produced, for the life of the page. The panel
// unmounts whenever it closes, and a reopen should show what it showed a
// moment ago while the runtime is asked again behind it.
const listCache = new Map<string, AgentSessionListResponse>()

// Below lg the pane owns the whole screen (SidePane), so opening a session
// from it has to hand the screen back; beside the chat it can stay.
const paneCanStayOpen = (): boolean =>
    window.matchMedia('(min-width: 1024px)').matches

const AgentSessions: FC<AgentSessionsProps> = ({
    agentId,
    sessionId,
    onClose,
    onApplied
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    // Only a session with a runtime transcript has anything to read; a
    // cloud-only row's "open" is simply switching the chat to it.
    const [openSession, setOpenSession] = useState<{
        item: AgentSessionListItem
        sessionRef: string
    } | null>(null)

    const handleOpen = useCallback(
        (item: AgentSessionListItem): void => {
            if (item.sessionRef) {
                setOpenSession({ item, sessionRef: item.sessionRef })
                return
            }
            if (item.cloudSessionId) {
                onApplied(item.cloudSessionId)
                if (!paneCanStayOpen()) onClose()
            }
        },
        [onApplied, onClose]
    )
    const [result, setResult] = useState<AgentSessionListResponse | null>(
        () => listCache.get(agentId) ?? null
    )
    const [scanning, setScanning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const abortRef = useRef<AbortController | null>(null)
    const seqRef = useRef(0)

    // The scan belongs to the panel, not to the list view: it walks the
    // runtime's transcripts, so opening a session and coming back must not
    // pay for it twice. One scan in flight at a time; a newer request wins.
    const runScan = useCallback(
        (localLimit: number): void => {
            abortRef.current?.abort()
            const controller = new AbortController()
            abortRef.current = controller
            const seq = ++seqRef.current
            setScanning(true)
            setError(null)
            void (async (): Promise<void> => {
                try {
                    const res = await client.chat.agentSessionList(
                        agentId,
                        { localLimit },
                        { signal: controller.signal }
                    )
                    if (seq !== seqRef.current) return
                    listCache.set(agentId, res)
                    setResult(res)
                } catch (err) {
                    if (controller.signal.aborted || seq !== seqRef.current)
                        return
                    setError(apiErrorMessage(err))
                } finally {
                    if (seq === seqRef.current) setScanning(false)
                }
            })()
        },
        [agentId, client]
    )

    useEffect(() => {
        const cached = listCache.get(agentId)
        setResult(cached ?? null)
        setError(null)
        // A cold panel also asks for the cloud half alone, which the server
        // answers without touching the runtime: rows are on screen in the
        // time of one database read, and the full list replaces them when it
        // lands. A warm panel already has rows; it only refreshes, keeping
        // whatever depth the user had paged to.
        const cloudFirst = cached ? null : new AbortController()
        if (cloudFirst)
            void client.chat
                .agentSessionList(
                    agentId,
                    { local: 'skip' },
                    { signal: cloudFirst.signal }
                )
                .then((res) => {
                    if (!cloudFirst.signal.aborted)
                        setResult((prev) => prev ?? res)
                })
                // The full request is the one that reports a failure.
                .catch(() => undefined)
        runScan(
            cached
                ? Math.max(agentSessionListLimits.firstPage, cached.localListed)
                : agentSessionListLimits.firstPage
        )
        return (): void => {
            cloudFirst?.abort()
            abortRef.current?.abort()
        }
    }, [agentId, client, runScan])

    const listed = result?.localListed ?? 0
    const handleRefresh = useCallback((): void => {
        runScan(Math.max(agentSessionListLimits.firstPage, listed))
    }, [listed, runScan])
    const handleShowMore = useCallback((): void => {
        runScan(
            Math.min(
                agentSessionListLimits.maxLocal,
                listed + agentSessionListLimits.step
            )
        )
    }, [listed, runScan])

    return (
        <div
            className='flex min-h-0 w-full flex-1 flex-col'
            aria-label={t('web.runtimeSession.viewerLabel')}
        >
            {/* The list stays mounted behind the detail: re-rendering it is
                free, refetching it is not, and it keeps its scroll position. */}
            <div
                className={
                    openSession
                        ? 'hidden'
                        : 'flex min-h-0 w-full flex-1 flex-col'
                }
            >
                <SessionList
                    currentCloudSessionId={sessionId}
                    error={error}
                    scanning={scanning}
                    onOpen={handleOpen}
                    onRefresh={handleRefresh}
                    onShowMore={handleShowMore}
                    result={result}
                />
            </div>
            {openSession && (
                <SessionDetail
                    agentId={agentId}
                    session={openSession.item}
                    sessionRef={openSession.sessionRef}
                    sessionId={sessionId}
                    onBack={() => setOpenSession(null)}
                    onClose={onClose}
                    onApplied={onApplied}
                />
            )}
        </div>
    )
}

const SessionList: FC<{
    currentCloudSessionId: string | null
    error: string | null
    scanning: boolean
    onOpen: (session: AgentSessionListItem) => void
    onRefresh: () => void
    onShowMore: () => void
    result: AgentSessionListResponse | null
}> = ({
    currentCloudSessionId,
    error,
    scanning,
    onOpen,
    onRefresh,
    onShowMore,
    result
}): ReactNode => {
    const { t } = useI18n()
    // Nothing has answered yet, not even the cloud half: ghosts, gated so a
    // fast answer never flashes them (DESIGN.md §10.8).
    const { showLoading } = useLoadingGate(result === null && error === null)

    if (!result) {
        if (error)
            return (
                <div className='px-4 py-4'>
                    <div className='workbench-alert-error'>{error}</div>
                </div>
            )
        return showLoading ? <SessionListGhost /> : null
    }

    const sessions = result.sessions
    const canShowMore =
        result.localScan === 'ok' &&
        result.localTotal !== null &&
        result.localListed < result.localTotal

    return (
        <div
            className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3'
            aria-busy={scanning}
        >
            {/* The refresh signal never blanks rows: whatever is on screen
                stays while the runtime answers again. Its height is
                reserved so rows do not shift when it comes and goes. */}
            {scanning ? (
                <HairlineProgress className='mb-2' />
            ) : (
                <div className='mb-2 h-[2px]' aria-hidden='true' />
            )}
            <div className='text-caption text-subtle mb-2 flex items-center gap-2 px-1'>
                <span className='flex min-w-0 flex-1 items-center gap-1.5 truncate'>
                    {scanning || result.localScan === 'skipped' ? (
                        <>
                            <Spinner size={12} />
                            {t('web.runtimeSession.loadingList')}
                        </>
                    ) : result.localScan === 'ok' &&
                      result.localTotal !== null ? (
                        t('web.runtimeSession.runtimeCount', {
                            listed: result.localListed,
                            total: result.localTotal
                        })
                    ) : null}
                </span>
                <button
                    type='button'
                    onClick={onRefresh}
                    disabled={scanning}
                    aria-label={t('web.runtimeSession.refresh')}
                    className='text-muted hover:bg-surface-hover hover:text-fg rounded-pill inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors disabled:cursor-default disabled:opacity-45'
                >
                    <RefreshIcon className='h-3.5 w-3.5' />
                </button>
            </div>
            {/* Said once for the whole list rather than per row: without it a
                missing Local tag reads as "not on the runtime" when the truth
                is that nothing could be read. */}
            {result.localScan === 'unavailable' && (
                <div className='text-caption text-muted border-divider mb-2 rounded-md border border-dashed px-3 py-2'>
                    {t('web.runtimeSession.localScanUnavailable')}
                </div>
            )}
            {/* A failed refresh keeps the rows it could not replace. */}
            {error && <div className='workbench-alert-error mb-2'>{error}</div>}
            {sessions.length === 0 ? (
                !scanning && (
                    <EmptyState
                        kind='all-clear'
                        tier='stack'
                        title={t('web.runtimeSession.emptyTitle')}
                        body={t('web.runtimeSession.emptyBody')}
                    />
                )
            ) : (
                <ol className='space-y-2'>
                    {sessions.map((session) => (
                        <li key={sessionKey(session)}>
                            <SessionRow
                                framework={result.framework}
                                isCurrent={
                                    session.cloudSessionId !== null &&
                                    session.cloudSessionId ===
                                        currentCloudSessionId
                                }
                                onOpen={() => onOpen(session)}
                                session={session}
                                t={t}
                            />
                        </li>
                    ))}
                </ol>
            )}
            {canShowMore && (
                <div className='flex justify-center pt-3'>
                    <button
                        type='button'
                        onClick={onShowMore}
                        disabled={scanning}
                        className='text-caption text-muted hover:bg-surface-hover hover:text-fg rounded-sm px-2.5 py-1 transition-colors disabled:cursor-default disabled:opacity-45'
                    >
                        {t('web.runtimeSession.showMore')}
                    </button>
                </div>
            )}
        </div>
    )
}

// The row's ghost twin (DESIGN.md §10.8): SessionRow's container with the
// content slots ghosted at their text tiers, widths stepped so the column
// reads as ragged text rather than a wall.
const GHOST_TITLE_WIDTHS = ['w-3/5', 'w-2/3', 'w-1/2', 'w-3/4']

const SessionRowGhost: FC<{ index: number }> = ({ index }): ReactNode => (
    <div className='bg-surface shadow-ring-light flex flex-col gap-1.5 rounded-md px-3 py-2.5'>
        <Ghost
            variant='title'
            className={GHOST_TITLE_WIDTHS[index % GHOST_TITLE_WIDTHS.length]}
        />
        <Ghost variant='line' className='w-full' />
        <Ghost variant='line' className={index % 2 ? 'w-4/5' : 'w-2/3'} />
        <Ghost variant='cap' className='w-1/3' />
    </div>
)

const SessionListGhost: FC = (): ReactNode => (
    <div
        className='min-h-0 flex-1 overflow-hidden px-3 py-3'
        aria-busy='true'
    >
        <ol className='space-y-2'>
            {[0, 1, 2, 3].map((index) => (
                <li key={index}>
                    <SessionRowGhost index={index} />
                </li>
            ))}
        </ol>
    </div>
)

// A row exists on at least one side, so one of the two ids is always present.
const sessionKey = (session: AgentSessionListItem): string =>
    session.cloudSessionId ?? session.sessionRef ?? ''

const copy = (value: string): void => {
    void navigator.clipboard?.writeText(value)
}

const SessionRow: FC<{
    framework: AgentFramework | null
    isCurrent: boolean
    onOpen: () => void
    session: AgentSessionListItem
    t: TFn
}> = ({ framework, isCurrent, onOpen, session, t }): ReactNode => {
    const resumeCommand =
        framework && session.sessionRef
            ? frameworkResumeCommandLine(framework, session.sessionRef)
            : null
    // The runtime id is the one the resume command and the file path belong
    // to; a session that only exists in the cloud has only its cloud id.
    const copyableId = session.sessionRef ?? session.cloudSessionId

    const items: OverflowMenuEntry[] = [
        {
            label: t('web.runtimeSession.copyResumeCommand'),
            onSelect: () => resumeCommand && copy(resumeCommand),
            disabled: !resumeCommand,
            disabledReason: session.sessionRef
                ? t('web.runtimeSession.resumeUnsupported')
                : t('web.runtimeSession.notOnRuntime')
        },
        {
            label: t('web.runtimeSession.copySessionId'),
            onSelect: () => copyableId && copy(copyableId),
            disabled: !copyableId
        },
        {
            label: t('web.runtimeSession.copyFilePath'),
            onSelect: () => session.sourceFile && copy(session.sourceFile),
            disabled: !session.sourceFile,
            disabledReason: t('web.runtimeSession.notOnRuntime')
        }
    ]

    return (
        <div className='bg-surface hover:bg-surface-hover shadow-ring-light relative rounded-md transition-colors'>
            <button
                type='button'
                onClick={onOpen}
                className='flex w-full flex-col gap-1 px-3 py-2.5 text-left'
            >
                {/* Right padding reserves the menu's corner so a long title
                    never runs underneath it. */}
                <span className='flex w-full items-center gap-2 pr-7'>
                    <span
                        className={[
                            'text-ui text-fg min-w-0 flex-1 truncate font-medium',
                            session.title ? '' : 'font-mono'
                        ].join(' ')}
                    >
                        {session.title ?? sessionKey(session)}
                    </span>
                    {isCurrent && (
                        <span className='tag tag-neutral shrink-0'>
                            {t('web.runtimeSession.currentWebSession')}
                        </span>
                    )}
                </span>
                {/* Every row knows its reply: a cloud row from the database,
                    a runtime row from its transcript. */}
                <span className='text-caption text-muted line-clamp-2'>
                    {session.lastAssistantMessage ??
                        t('web.runtimeSession.noAssistantReply')}
                </span>
                <span className='text-caption text-subtle flex flex-wrap items-center gap-x-1.5 gap-y-1'>
                    {session.inCloud && (
                        <span className='tag tag-neutral'>
                            {t('web.runtimeSession.inCloud')}
                        </span>
                    )}
                    {session.inLocal && (
                        <span className='tag tag-neutral'>
                            {t('web.runtimeSession.inLocal')}
                        </span>
                    )}
                    {session.model && (
                        <>
                            <span className='truncate font-mono'>
                                {session.model}
                            </span>
                            <span aria-hidden='true'>·</span>
                        </>
                    )}
                    <span className='tabular-nums'>
                        {t('web.runtimeSession.messageCount', {
                            count: session.messageCount
                        })}
                    </span>
                    {session.lastActiveAt && (
                        <>
                            <span aria-hidden='true'>·</span>
                            <ShortcutTooltip
                                label={formatDateTime(session.lastActiveAt)}
                            >
                                <span className='tabular-nums'>
                                    {timeAgo(session.lastActiveAt)}
                                </span>
                            </ShortcutTooltip>
                        </>
                    )}
                </span>
            </button>
            <div className='absolute right-1.5 top-1.5'>
                <OverflowMenu
                    ariaLabel={t('web.runtimeSession.sessionActions')}
                    compact
                    items={items}
                />
            </div>
        </div>
    )
}

const SessionDetail: FC<{
    agentId: string
    session: AgentSessionListItem
    sessionRef: string
    sessionId: string | null
    onBack: () => void
    onClose: () => void
    onApplied: (sessionId?: string) => void
}> = ({
    agentId,
    session,
    sessionRef,
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
        : session.messageCount
    const lastActive = session.lastActiveAt

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
                        session.title ? '' : 'font-mono'
                    ].join(' ')}
                >
                    {session.title ?? session.sessionRef}
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
                {session.model && (
                    <span className='truncate font-mono'>
                        {session.model}
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
                    label={sessionRef}
                    className='ml-auto min-w-0'
                >
                    <span className='truncate font-mono'>{sessionRef}</span>
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
                    label={result?.sourceFile ?? session.sourceFile ?? undefined}
                    placement='top'
                    className='min-w-0'
                >
                    <span className='w-full truncate font-mono'>
                        {result?.sourceFile ?? session.sourceFile}
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

export default memo(AgentSessions)
