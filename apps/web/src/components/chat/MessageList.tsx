import type {
    AgentFramework,
    ChatAttachmentBlock,
    ChatCapabilities,
    ChatContentBlock,
    ChatContextRefBlock,
    ChatError,
    ChatMessage,
    ChatTurnStatusPhase,
    ChatUploadBlock
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import { useParams } from 'react-router-dom'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import ActivityGroup from '@/components/chat/ActivityGroup'
import ElapsedTimer from '@/components/chat/ElapsedTimer'
import MarkdownText from '@/components/chat/MarkdownText'
import MessageMetaFooter from '@/components/chat/MessageMetaFooter'
import HermesPermissionCard from '@/components/chat/HermesPermissionCard'
import PermissionRequestCard from '@/components/chat/PermissionRequestCard'
import { splitGrantPermissionContent } from '@/components/chat/utils/grantPermissionLinks'
import {
    groupRenderableBlocks,
    type RenderableGroup
} from '@/components/chat/utils/groupRenderableBlocks'
import { pairToolBlocks } from '@/components/chat/utils/pairToolBlocks'
import {
    streamingBlocksToContentBlocks,
    type StreamError,
    type StreamingBlock
} from '@/components/chat/utils/streamingBlocks'
import {
    ArrowDownIcon,
    CopyIcon,
    DownloadIcon,
    EditIcon,
    FileIcon,
    FolderIcon
} from '@/components/icons'
import type { MarkdownLinkClickHandler } from '@/components/chat/MarkdownText'
import { downloadFile } from '@/components/chat/utils/downloadFile'
import { recoveryLabelKey } from '@/components/chat/utils/recoveryLabel'
import { useApiClient } from '@/lib/apiClient'
import { SheenText } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import { formatMessageTimestamp } from '@/lib/dateFormat'
import { resolveChatErrorDisplay } from '@/lib/chatErrorDisplay'
import {
    CHAT_SCROLL_RESTORE_COMMAND,
    advanceChatScrollRestoration,
    beginChatScrollRestoration,
    captureChatScrollPosition,
    chatAnchorScrollTop,
    chatMessageAnchorId,
    handoffChatScrollScope,
    isChatViewportAtBottom,
    unpositionedChatScrollRestoration,
    type ChatMessageOffset,
    type ChatScrollPosition,
    type ChatScrollRestorationState,
    type ChatViewportMetrics
} from '@/lib/chatScrollMemory'
import { publishAgentCredentialsOpen } from '@/lib/agentCredentialsEvents'
import { writeCachedModelConfigView } from '@/lib/agentModelConfig'
import type { StreamStatus } from '@/lib/chatStreamStore'

interface Props {
    capabilities: ChatCapabilities
    hasMore?: boolean
    loadingOlder?: boolean
    messages: ChatMessage[]
    onLinkClick?: MarkdownLinkClickHandler
    onLoadOlder?: () => Promise<void> | void
    scrollScopeKey?: string | null
    onCapturePosition?: (scopeKey: string, position: ChatScrollPosition) => void
    scrollAction?: MessageScrollAction | null
    bottomInset?: number
    streamingAssistantId: string | null
    streamingBlocks: StreamingBlock[]
    streamStatus: StreamStatus
    streamStartedAt: number | null
    streamStalled?: boolean
    streamRecoveryPhase?: ChatTurnStatusPhase | null
    streamErrors: StreamError[]
    framework?: AgentFramework | null
    editingDisabled?: boolean
    disableGrantCards?: boolean
    onRegenerateUserMessage?: (
        message: ChatMessage,
        text: string
    ) => Promise<void>
    // Answers a pending hermes permission card in the LIVE turn. Historical
    // cards render inert: a turn that reached a terminal without a resolution
    // was never answered.
    onAnswerPermission?: (requestId: string, optionId: string) => Promise<void>
}

export interface MessageScrollAction {
    position: ChatScrollPosition
    seq: number
}

// A remembered position is written a beat after the reader stops moving, so
// leaving does not depend on catching an unmount, and scrolling does not touch
// storage on every frame.
const capturePauseMs = 200

const viewportMetrics = (node: HTMLElement): ChatViewportMetrics => ({
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight
})

const messageElements = (node: HTMLElement): HTMLElement[] =>
    Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]'))

const messageOffsets = (node: HTMLElement): ChatMessageOffset[] => {
    const viewportTop = node.getBoundingClientRect().top
    return messageElements(node).map((element) => ({
        messageId: element.dataset.messageId ?? '',
        top: element.getBoundingClientRect().top - viewportTop
    }))
}

const messageOffsetTop = (node: HTMLElement, element: HTMLElement): number =>
    element.getBoundingClientRect().top - node.getBoundingClientRect().top

const MessageList: FC<Props> = ({
    capabilities,
    hasMore = false,
    loadingOlder = false,
    messages,
    onLinkClick,
    onLoadOlder,
    scrollScopeKey = null,
    onCapturePosition,
    scrollAction = null,
    bottomInset = 0,
    streamingAssistantId,
    streamingBlocks,
    streamStatus,
    streamStartedAt,
    streamStalled = false,
    streamRecoveryPhase = null,
    streamErrors,
    framework = null,
    editingDisabled = false,
    disableGrantCards = false,
    onRegenerateUserMessage,
    onAnswerPermission
}): ReactNode => {
    const { t } = useI18n()
    const scrollerRef = useRef<HTMLDivElement>(null)
    const atBottomRef = useRef(true)
    const loadingOlderRef = useRef(false)
    const pendingPrependHeightRef = useRef<number | null>(null)
    const lastScrollActionSeqRef = useRef(0)
    const restorationRef = useRef<ChatScrollRestorationState>(
        unpositionedChatScrollRestoration()
    )
    const captureTimerRef = useRef<number | null>(null)
    const captureScopeKeyRef = useRef(scrollScopeKey)
    const loadGenerationRef = useRef(0)
    const mountedRef = useRef(false)
    const hasMoreRef = useRef(hasMore)
    const loadingOlderPropRef = useRef(loadingOlder)
    const onLoadOlderRef = useRef(onLoadOlder)
    const [showJumpToBottom, setShowJumpToBottom] = useState(false)
    const [restoreRevision, setRestoreRevision] = useState(0)

    // Read by callbacks that must stay stable: the layout effect below cannot
    // re-run on every `hasMore` flip without mistaking a load in flight for a
    // prepended page.
    useLayoutEffect(() => {
        hasMoreRef.current = hasMore
        loadingOlderPropRef.current = loadingOlder
        onLoadOlderRef.current = onLoadOlder
    })

    const visibleMessages = streamingAssistantId
        ? messages.filter((m) => m.id !== streamingAssistantId)
        : messages

    const updateAtBottom = useCallback((): void => {
        const node = scrollerRef.current
        if (!node) return
        const atBottom = isChatViewportAtBottom(viewportMetrics(node))
        atBottomRef.current = atBottom
        setShowJumpToBottom(!atBottom)
    }, [])

    const scrollToBottom = useCallback((): void => {
        const node = scrollerRef.current
        if (!node) return
        node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
        atBottomRef.current = true
        setShowJumpToBottom(false)
    }, [])

    const pinToBottom = useCallback((node: HTMLDivElement): void => {
        node.scrollTo({ top: node.scrollHeight, behavior: 'auto' })
        atBottomRef.current = true
        setShowJumpToBottom(false)
    }, [])

    const requestOlderMessages = useCallback((): boolean => {
        const node = scrollerRef.current
        const loadOlder = onLoadOlderRef.current
        if (
            !node ||
            !hasMoreRef.current ||
            loadingOlderPropRef.current ||
            loadingOlderRef.current ||
            !loadOlder
        )
            return false
        pendingPrependHeightRef.current = node.scrollHeight
        loadingOlderRef.current = true
        const generation = loadGenerationRef.current
        void Promise.resolve()
            .then(loadOlder)
            .catch(() => {
                if (
                    mountedRef.current &&
                    generation === loadGenerationRef.current
                ) {
                    pendingPrependHeightRef.current = null
                    if (restorationRef.current.pending)
                        restorationRef.current = {
                            positioned: true,
                            pending: null
                        }
                }
            })
            .finally(() => {
                if (
                    !mountedRef.current ||
                    generation !== loadGenerationRef.current
                )
                    return
                loadingOlderRef.current = false
                setRestoreRevision((revision) => revision + 1)
            })
        return true
    }, [])

    // Nothing is remembered until the conversation has been put where it
    // belongs: a capture taken while the list is still being restored would
    // write the position the reader is being moved away from.
    const capturePositionForScope = useCallback(
        (scopeKey: string | null): void => {
            if (captureTimerRef.current !== null) {
                window.clearTimeout(captureTimerRef.current)
                captureTimerRef.current = null
            }
            const node = scrollerRef.current
            if (
                !scopeKey ||
                !onCapturePosition ||
                !node ||
                !node.isConnected ||
                !restorationRef.current.positioned ||
                restorationRef.current.pending
            )
                return
            const position = captureChatScrollPosition(
                viewportMetrics(node),
                messageOffsets(node)
            )
            if (position) onCapturePosition(scopeKey, position)
        },
        [onCapturePosition]
    )

    const capturePosition = useCallback((): void => {
        capturePositionForScope(captureScopeKeyRef.current)
    }, [capturePositionForScope])

    // Capture the old transcript under the old key before closing the gate for
    // a conversation that reuses this mounted list. Old pagination completions
    // are generation-scoped so they cannot clear the new conversation's load.
    useLayoutEffect(() => {
        const previousScopeKey = captureScopeKeyRef.current
        const handoff = handoffChatScrollScope(
            previousScopeKey,
            scrollScopeKey,
            restorationRef.current
        )
        if (!handoff.changed) return
        capturePositionForScope(handoff.captureScopeKey)
        captureScopeKeyRef.current = scrollScopeKey
        restorationRef.current = handoff.state
        atBottomRef.current = true
        loadGenerationRef.current += 1
        loadingOlderRef.current = false
        pendingPrependHeightRef.current = null
    }, [capturePositionForScope, scrollScopeKey])

    const scheduleCapture = useCallback((): void => {
        if (
            !onCapturePosition ||
            !captureScopeKeyRef.current ||
            !restorationRef.current.positioned
        )
            return
        if (captureTimerRef.current !== null)
            window.clearTimeout(captureTimerRef.current)
        captureTimerRef.current = window.setTimeout(
            capturePosition,
            capturePauseMs
        )
    }, [capturePosition, onCapturePosition])

    const settleRestore = useCallback(
        (node: HTMLDivElement): void => {
            const state = restorationRef.current
            const pending = state.pending
            if (!pending) return
            const target = messageElements(node).find(
                (element) =>
                    element.dataset.messageId === pending.anchor.messageId
            )
            const transition = advanceChatScrollRestoration(state, {
                anchorFound: Boolean(target),
                hasMore: hasMoreRef.current && Boolean(onLoadOlderRef.current),
                loadingOlder:
                    loadingOlderPropRef.current || loadingOlderRef.current
            })
            restorationRef.current = transition.state

            if (
                transition.command ===
                    CHAT_SCROLL_RESTORE_COMMAND.applyAnchor &&
                target
            ) {
                node.scrollTop = chatAnchorScrollTop(
                    viewportMetrics(node),
                    messageOffsetTop(node, target),
                    pending.anchor.offset
                )
                updateAtBottom()
                return
            }

            // Hold the newest messages in view while older pages are pulled in,
            // so a search that comes up empty has already landed where it falls
            // back to.
            if (transition.command === CHAT_SCROLL_RESTORE_COMMAND.loadOlder) {
                if (!requestOlderMessages()) restorationRef.current = state
                pinToBottom(node)
                return
            }
            if (transition.command === CHAT_SCROLL_RESTORE_COMMAND.pinBottom) {
                pinToBottom(node)
                return
            }
        },
        [pinToBottom, requestOlderMessages, updateAtBottom]
    )

    const handleScroll = useCallback((): void => {
        updateAtBottom()
        scheduleCapture()
        const node = scrollerRef.current
        if (node && node.scrollTop < 160) requestOlderMessages()
    }, [requestOlderMessages, scheduleCapture, updateAtBottom])

    useLayoutEffect(() => {
        const node = scrollerRef.current
        if (!node) return

        if (
            scrollAction &&
            scrollAction.seq !== lastScrollActionSeqRef.current
        ) {
            lastScrollActionSeqRef.current = scrollAction.seq
            loadGenerationRef.current += 1
            loadingOlderRef.current = false
            pendingPrependHeightRef.current = null
            const transition = beginChatScrollRestoration(scrollAction.position)
            restorationRef.current = transition.state
            if (scrollAction.position.mode === 'anchor') {
                settleRestore(node)
                return
            }
            pinToBottom(node)
            return
        }

        const prependHeight = pendingPrependHeightRef.current
        if (prependHeight !== null) {
            node.scrollTop += node.scrollHeight - prependHeight
            pendingPrependHeightRef.current = null
            if (!restorationRef.current.pending) {
                updateAtBottom()
                return
            }
        }

        if (restorationRef.current.pending) {
            settleRestore(node)
            return
        }

        if (atBottomRef.current) {
            node.scrollTo({
                top: node.scrollHeight,
                behavior: 'auto'
            })
        }
    }, [
        messages,
        pinToBottom,
        scrollAction,
        settleRestore,
        streamErrors,
        streamStatus,
        streamingAssistantId,
        streamingBlocks,
        updateAtBottom
    ])

    // A page that arrives carrying no new messages, or a list that runs out of
    // history, still ends the search: `loadingOlder` always falls back to false.
    useLayoutEffect(() => {
        const node = scrollerRef.current
        if (!node || !restorationRef.current.pending) return
        const prependHeight = pendingPrependHeightRef.current
        if (
            prependHeight !== null &&
            !loadingOlderPropRef.current &&
            !loadingOlderRef.current
        ) {
            node.scrollTop += node.scrollHeight - prependHeight
            pendingPrependHeightRef.current = null
        }
        settleRestore(node)
    }, [hasMore, loadingOlder, restoreRevision, settleRestore])

    useLayoutEffect(() => {
        const node = scrollerRef.current
        if (!node || !atBottomRef.current) return
        node.scrollTop = node.scrollHeight
    }, [bottomInset])

    useEffect(() => {
        if (!onCapturePosition) return
        const captureIfHidden = (): void => {
            if (document.visibilityState === 'hidden') capturePosition()
        }
        window.addEventListener('pagehide', capturePosition)
        document.addEventListener('visibilitychange', captureIfHidden)
        return (): void => {
            window.removeEventListener('pagehide', capturePosition)
            document.removeEventListener('visibilitychange', captureIfHidden)
        }
    }, [capturePosition, onCapturePosition])

    // Read through a ref: the unmount cleanup has to run for the conversation
    // that was on screen, which is the last one committed, and it has to run
    // while the scroller is still in the document — a layout effect's cleanup
    // is the last moment the browser will still measure it.
    const capturePositionRef = useRef(capturePosition)
    useLayoutEffect(() => {
        capturePositionRef.current = capturePosition
    }, [capturePosition])
    useLayoutEffect(() => {
        mountedRef.current = true
        return (): void => {
            capturePositionRef.current()
            mountedRef.current = false
        }
    }, [])

    return (
        <div className='relative flex min-h-0 flex-1 flex-col'>
            <div
                ref={scrollerRef}
                onScroll={handleScroll}
                className='scrollbar-hidden min-h-0 flex-1 overflow-auto overscroll-contain px-5 pb-40 pt-4 md:px-6'
                style={
                    bottomInset > 0
                        ? { paddingBottom: bottomInset + 16 }
                        : undefined
                }
            >
                <div className='mx-auto flex max-w-3xl flex-col gap-4'>
                    {(hasMore || loadingOlder) && (
                        <div className='text-caption text-subtle flex justify-center py-1'>
                            {loadingOlder ? (
                                <SheenText>
                                    {t('web.chat.loadingOlder')}
                                </SheenText>
                            ) : (
                                t('web.chat.scrollForOlder')
                            )}
                        </div>
                    )}
                    {visibleMessages.map((m) => (
                        <MessageGroup
                            key={m.id}
                            message={m}
                            capabilities={capabilities}
                            onLinkClick={onLinkClick}
                            framework={framework}
                            editingDisabled={editingDisabled}
                            disableGrantCards={disableGrantCards}
                            onRegenerateUserMessage={onRegenerateUserMessage}
                        />
                    ))}
                    {streamingAssistantId && streamingBlocks.length > 0 && (
                        <StreamingBubble
                            messageId={streamingAssistantId}
                            blocks={streamingBlocks}
                            status={streamStatus}
                            streamStartedAt={streamStartedAt}
                            stalled={streamStalled}
                            recoveryPhase={streamRecoveryPhase}
                            capabilities={capabilities}
                            onLinkClick={onLinkClick}
                            onAnswerPermission={onAnswerPermission}
                        />
                    )}
                    {streamingAssistantId && streamingBlocks.length === 0 && (
                        <RespondingIndicator
                            messageId={streamingAssistantId}
                            status={streamStatus}
                            startedAt={streamStartedAt}
                            stalled={streamStalled}
                            recoveryPhase={streamRecoveryPhase}
                        />
                    )}
                    {streamErrors
                        .filter(
                            (e) =>
                                !e.messageId ||
                                !visibleMessages.some(
                                    (m) => m.id === e.messageId && m.error
                                )
                        )
                        .map((e) => (
                            <ErrorBubble key={e.id} error={e.error} />
                        ))}
                </div>
            </div>
            {showJumpToBottom && (
                <span
                    className='absolute bottom-[8.5rem] left-1/2 z-10 -translate-x-1/2'
                    style={
                        bottomInset > 0
                            ? { bottom: bottomInset + 16 }
                            : undefined
                    }
                >
                    <ShortcutTooltip
                        label={t('web.chat.scrollToBottom')}
                        placement='top'
                    >
                        <button
                            type='button'
                            onClick={scrollToBottom}
                            aria-label={t('web.chat.scrollToBottom')}
                            className='bg-surface text-muted hover:bg-surface-hover shadow-ring-light rounded-pill flex h-8 w-8 items-center justify-center transition-colors'
                        >
                            <ArrowDownIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                </span>
            )}
        </div>
    )
}

interface MessageGroupProps {
    capabilities: ChatCapabilities
    message: ChatMessage
    onLinkClick?: MarkdownLinkClickHandler
    framework?: AgentFramework | null
    editingDisabled?: boolean
    disableGrantCards?: boolean
    onRegenerateUserMessage?: (
        message: ChatMessage,
        text: string
    ) => Promise<void>
}

const MessageGroup: FC<MessageGroupProps> = ({
    capabilities,
    message,
    onLinkClick,
    framework = null,
    editingDisabled = false,
    disableGrantCards = false,
    onRegenerateUserMessage
}): ReactNode => (
    <>
        <MessageBubble
            message={message}
            capabilities={capabilities}
            onLinkClick={onLinkClick}
            framework={framework}
            editingDisabled={editingDisabled}
            disableGrantCards={disableGrantCards}
            onRegenerateUserMessage={onRegenerateUserMessage}
        />
        {message.error && <ErrorBubble error={message.error} />}
    </>
)

interface ErrorBubbleProps {
    error: ChatError
}

const ErrorBubble: FC<ErrorBubbleProps> = ({ error }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { id: agentId } = useParams<{ id: string }>()
    const [switching, setSwitching] = useState(false)
    const [switched, setSwitched] = useState(false)
    const display = resolveChatErrorDisplay(error, t)
    const recoverable =
        (display.kind === 'model_auth' || display.kind === 'model_billing') &&
        Boolean(agentId)

    const switchToPlatform = async (): Promise<void> => {
        if (!agentId || switching) return
        setSwitching(true)
        try {
            const view = await client.agents.updateModelConfig(agentId, {
                modelConfigSource: 'platform'
            })
            writeCachedModelConfigView(view)
            setSwitched(true)
        } catch {
            // Leave the error in place; the user can retry the action.
        } finally {
            setSwitching(false)
        }
    }

    return (
        <div
            role='alert'
            className='text-ui text-workflow-ship shadow-ring-light bg-danger-bg mr-auto w-full max-w-full rounded-md px-3.5 py-3'
        >
            <div className='text-caption font-mono uppercase tracking-wide'>
                {error.code}
                {error.retryable ? ' · retryable' : ''}
            </div>
            <p className='mt-1 whitespace-pre-wrap break-words'>
                {display.title}
            </p>
            {display.detail && (
                <p className='text-caption mt-1 whitespace-pre-wrap break-words opacity-70'>
                    {t('web.chat.error.detailLabel')}: {display.detail}
                </p>
            )}
            {recoverable &&
                (switched ? (
                    <p className='text-caption mt-2 font-medium'>
                        {t('web.chat.error.switchedToPlatform')}
                    </p>
                ) : (
                    <div className='mt-2.5 flex flex-wrap gap-2'>
                        <button
                            type='button'
                            onClick={() =>
                                agentId && publishAgentCredentialsOpen(agentId)
                            }
                            className='shadow-ring-light bg-surface text-fg hover:bg-surface-hover text-caption inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium transition-colors'
                        >
                            {t('web.chat.error.updateKey')}
                        </button>
                        <button
                            type='button'
                            onClick={() => void switchToPlatform()}
                            disabled={switching}
                            className='shadow-ring-light bg-surface text-fg hover:bg-surface-hover text-caption inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium transition-colors disabled:opacity-60'
                        >
                            {switching
                                ? t('web.chat.error.switching')
                                : t('web.chat.error.switchToPlatform')}
                        </button>
                    </div>
                ))}
        </div>
    )
}

interface BubbleProps {
    capabilities: ChatCapabilities
    message: ChatMessage
    onLinkClick?: MarkdownLinkClickHandler
    framework?: AgentFramework | null
    editingDisabled?: boolean
    disableGrantCards?: boolean
    onRegenerateUserMessage?: (
        message: ChatMessage,
        text: string
    ) => Promise<void>
}

export const MessageBubble: FC<BubbleProps> = ({
    capabilities,
    message,
    onLinkClick,
    framework = null,
    editingDisabled = false,
    disableGrantCards = false,
    onRegenerateUserMessage
}): ReactNode => {
    const { t } = useI18n()
    const isUser = message.role === 'user'
    const initialUserText = useMemo(
        () => markdownTextFromBlocks(message.contentBlocks),
        [message.contentBlocks]
    )
    const [draftText, setDraftText] = useState(initialUserText)
    const [isEditing, setIsEditing] = useState(false)
    const [isSavingEdit, setIsSavingEdit] = useState(false)
    const [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!isEditing) setDraftText(initialUserText)
    }, [initialUserText, isEditing])
    const renderable = useMemo(
        () =>
            pairToolBlocks(message.contentBlocks, {
                streaming: false,
                nestSubagents: true
            }),
        [message.contentBlocks]
    )

    if (isUser) {
        const isCodex = framework === 'codex'
        const canEdit = isCodex && Boolean(onRegenerateUserMessage)
        const messageTime = formatMessageTimestamp(message.createdAt)
        const hasAttachments = message.contentBlocks.some(
            (block) =>
                block.type === 'attachment' || block.type === 'context_ref'
        )
        const trimmedDraft = draftText.trim()
        const saveDisabled =
            editingDisabled ||
            isSavingEdit ||
            (!trimmedDraft && !hasAttachments) ||
            trimmedDraft === initialUserText.trim()
        const handleCopy = (): void => {
            const text = copyTextFromBlocks(message.contentBlocks)
            void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1200)
            })
        }
        const handleSave = async (): Promise<void> => {
            if (!onRegenerateUserMessage || saveDisabled) return
            setIsSavingEdit(true)
            try {
                await onRegenerateUserMessage(message, draftText)
                setIsEditing(false)
            } catch {
                /* parent renders the request error */
            } finally {
                setIsSavingEdit(false)
            }
        }

        return (
            <div
                data-message-id={chatMessageAnchorId(message.id) ?? undefined}
                className='group/msg flex w-full flex-col items-end'
            >
                <div className='text-ui text-fg bg-surface-subtle dark:bg-surface inline-block max-w-[min(538px,100%)] break-words rounded-sm px-3 py-2'>
                    {renderable.map((r, idx) => {
                        const key = `${message.id}-${idx}`
                        if (r.kind === 'text')
                            return (
                                <p key={key} className='whitespace-pre-wrap'>
                                    {r.block.text}
                                </p>
                            )
                        if (r.kind === 'attachment')
                            return (
                                <MessageAttachment
                                    key={key}
                                    attachment={r.block}
                                />
                            )
                        if (r.kind === 'context_ref')
                            return (
                                <MessageContextRef
                                    key={key}
                                    contextRef={r.block}
                                />
                            )
                        if (r.kind === 'upload')
                            return <MessageUpload key={key} upload={r.block} />
                        return null
                    })}
                </div>
                {isEditing && (
                    <form
                        className='bg-surface shadow-ring-light mt-2 w-full max-w-[538px] rounded-md p-2.5'
                        onSubmit={(event) => {
                            event.preventDefault()
                            void handleSave()
                        }}
                    >
                        <textarea
                            className='text-ui text-fg border-divider bg-surface focus:border-link min-h-28 w-full resize-y rounded-md border px-3 py-2 outline-none transition-colors'
                            value={draftText}
                            onChange={(event) =>
                                setDraftText(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (
                                    event.key === 'Enter' &&
                                    !event.shiftKey &&
                                    !event.nativeEvent.isComposing
                                ) {
                                    event.preventDefault()
                                    void handleSave()
                                }
                                if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setDraftText(initialUserText)
                                    setIsEditing(false)
                                }
                            }}
                            disabled={editingDisabled || isSavingEdit}
                            autoFocus
                        />
                        <div className='mt-2 flex justify-end gap-2'>
                            <button
                                type='button'
                                className='workbench-button-secondary h-8 px-3'
                                disabled={isSavingEdit}
                                onClick={() => {
                                    setDraftText(initialUserText)
                                    setIsEditing(false)
                                }}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type='submit'
                                className='workbench-button-primary h-8 px-3'
                                disabled={saveDisabled}
                            >
                                {t('common.save')}
                            </button>
                        </div>
                    </form>
                )}
                {isCodex && !isEditing && (
                    <div className='mt-1.5 flex items-center justify-end gap-1.5 pr-1 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100'>
                        {messageTime && (
                            <span className='text-caption text-subtle mr-1.5 tabular-nums'>
                                {messageTime}
                            </span>
                        )}
                        <ShortcutTooltip
                            label={
                                copied
                                    ? t('web.chat.copied')
                                    : t('web.chat.copy')
                            }
                        >
                            <button
                                type='button'
                                className='text-placeholder hover:bg-surface-subtle dark:hover:bg-surface rounded-xs inline-flex h-6 w-6 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                aria-label={
                                    copied
                                        ? t('web.chat.copiedMessage')
                                        : t('web.chat.copyMessage')
                                }
                                onClick={handleCopy}
                            >
                                <CopyIcon className='h-3.5 w-3.5' />
                            </button>
                        </ShortcutTooltip>
                        {canEdit && (
                            <ShortcutTooltip label={t('web.chat.editMessage')}>
                                <button
                                    type='button'
                                    className='text-placeholder hover:bg-surface-subtle dark:hover:bg-surface rounded-xs inline-flex h-6 w-6 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                    aria-label={t('web.chat.editMessage')}
                                    disabled={editingDisabled}
                                    onClick={() => setIsEditing(true)}
                                >
                                    <EditIcon className='h-3.5 w-3.5' />
                                </button>
                            </ShortcutTooltip>
                        )}
                    </div>
                )}
            </div>
        )
    }

    const groups = groupRenderableBlocks(renderable, capabilities)
    if (groups.length === 0) return null
    return (
        <div
            data-message-id={chatMessageAnchorId(message.id) ?? undefined}
            className='group/msg w-full max-w-full'
        >
            <div className='flex flex-col'>
                {groups.map((seg, idx) => {
                    const key = `${message.id}-seg-${idx}`
                    if (seg.kind === 'text-run')
                        return (
                            <TextRun
                                key={key}
                                group={seg}
                                onLinkClick={onLinkClick}
                                renderGrantCards={!disableGrantCards}
                            />
                        )
                    if (seg.kind === 'permission-card')
                        return (
                            <HermesPermissionCard
                                key={`perm-${seg.block.request.requestId}`}
                                card={seg.block}
                                turnActive={false}
                            />
                        )
                    return <ActivityGroup key={key} group={seg} />
                })}
            </div>
            <div className='opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100'>
                <MessageMetaFooter
                    usage={message.usage ?? null}
                    messageModel={message.model ?? null}
                    contextUsage={message.contextUsage ?? null}
                    createdAt={message.createdAt}
                    copyText={copyTextFromBlocks(message.contentBlocks)}
                    markdownText={markdownTextFromBlocks(message.contentBlocks)}
                    rawResponse={rawResponseFromMessage(message)}
                />
            </div>
        </div>
    )
}

const MessageAttachment: FC<{
    attachment: ChatAttachmentBlock
}> = ({ attachment }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const { id: agentId } = useParams<{ id: string }>()
    const [downloading, setDownloading] = useState(false)
    const canDownload = Boolean(agentId)
    const download = (): void => {
        if (!agentId || downloading) return
        setDownloading(true)
        void downloadFile(
            client.files,
            agentId,
            attachment.rootId,
            attachment.path,
            attachment.name
        ).finally(() => setDownloading(false))
    }
    return (
        <ShortcutTooltip label={attachment.path} className='max-w-full'>
            <div
                className='message-attachment min-w-0'
                role={canDownload ? 'button' : undefined}
                tabIndex={canDownload ? 0 : undefined}
                aria-disabled={downloading || undefined}
                onClick={canDownload ? download : undefined}
                onKeyDown={
                    canDownload
                        ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  download()
                              }
                          }
                        : undefined
                }
                style={canDownload ? { cursor: 'pointer' } : undefined}
            >
                <span className='message-attachment-icon'>
                    <FileIcon className='h-4 w-4' />
                </span>
                <span className='min-w-0 flex-1'>
                    <span className='message-attachment-name'>
                        {attachment.name}
                    </span>
                    <span className='message-attachment-meta'>
                        {formatSize(attachment.size)} · {attachment.path}
                    </span>
                </span>
                {canDownload && (
                    <span
                        className='message-attachment-icon'
                        aria-label={t('web.workspaceFiles.downloadFile')}
                    >
                        <DownloadIcon className='h-4 w-4' />
                    </span>
                )}
            </div>
        </ShortcutTooltip>
    )
}

const MessageUpload: FC<{
    upload: ChatUploadBlock
}> = ({ upload }): ReactNode => (
    <ShortcutTooltip label={upload.name} className='max-w-full'>
        <div className='message-attachment min-w-0'>
            <span className='message-attachment-icon'>
                <FileIcon className='h-4 w-4' />
            </span>
            <span className='min-w-0 flex-1'>
                <span className='message-attachment-name'>{upload.name}</span>
                <span className='message-attachment-meta'>
                    {formatSize(upload.size)} · {upload.contentType}
                </span>
            </span>
        </div>
    </ShortcutTooltip>
)

const MessageContextRef: FC<{
    contextRef: ChatContextRefBlock
}> = ({ contextRef }): ReactNode => {
    const Icon = contextRef.entryType === 'dir' ? FolderIcon : FileIcon
    const meta =
        contextRef.entryType === 'file' && contextRef.size !== undefined
            ? `${formatSize(contextRef.size)} · ${contextRef.path}`
            : `${contextRef.entryType} · ${contextRef.path}`
    return (
        <ShortcutTooltip label={contextRef.path} className='max-w-full'>
            <div className='message-attachment min-w-0'>
                <span className='message-attachment-icon'>
                    <Icon className='h-4 w-4' />
                </span>
                <span className='min-w-0 flex-1'>
                    <span className='message-attachment-name'>
                        {contextRef.name}
                    </span>
                    <span className='message-attachment-meta'>{meta}</span>
                </span>
            </div>
        </ShortcutTooltip>
    )
}

interface StreamingProps {
    messageId: string
    blocks: StreamingBlock[]
    status: StreamStatus
    streamStartedAt: number | null
    stalled: boolean
    recoveryPhase: ChatTurnStatusPhase | null
    capabilities: ChatCapabilities
    onLinkClick?: MarkdownLinkClickHandler
    onAnswerPermission?: (requestId: string, optionId: string) => Promise<void>
}

const StreamingBubble: FC<StreamingProps> = ({
    messageId,
    blocks,
    status,
    streamStartedAt,
    stalled,
    recoveryPhase,
    capabilities,
    onLinkClick,
    onAnswerPermission
}): ReactNode => {
    const { t } = useI18n()
    const isActive = isActiveStreamStatus(status)
    const renderable = useMemo(
        () =>
            pairToolBlocks(streamingBlocksToContentBlocks(blocks), {
                streaming: true,
                nestSubagents: true
            }),
        [blocks]
    )
    const groups = groupRenderableBlocks(renderable, capabilities)
    const lastActivityRunIdx = lastIndexOf(
        groups,
        (s) => s.kind === 'activity-run'
    )
    const activeActivityRunIdx =
        groups[groups.length - 1]?.kind === 'activity-run'
            ? lastActivityRunIdx
            : -1
    return (
        <div
            data-message-id={chatMessageAnchorId(messageId) ?? undefined}
            className='w-full max-w-full'
        >
            <div className='flex flex-col'>
                {groups.map((seg, idx) => {
                    const key = `stream-seg-${idx}`
                    if (seg.kind === 'text-run')
                        return (
                            <TextRun
                                key={key}
                                group={seg}
                                onLinkClick={onLinkClick}
                                streaming={isActive}
                            />
                        )
                    if (seg.kind === 'permission-card')
                        return (
                            <HermesPermissionCard
                                key={`perm-${seg.block.request.requestId}`}
                                card={seg.block}
                                turnActive={isActive}
                                onAnswer={onAnswerPermission}
                            />
                        )
                    return (
                        <ActivityGroup
                            key={key}
                            group={seg}
                            streaming={isActive && idx === activeActivityRunIdx}
                        />
                    )
                })}
            </div>
            <MessageMetaFooter
                usage={null}
                isStreaming={isActive}
                streamLabel={streamingFooterLabel(
                    status,
                    recoveryPhase,
                    groups,
                    t
                )}
                streamStartedAt={streamStartedAt}
                streamHint={stalled ? t('web.chatStream.stalled') : undefined}
                hideActions
            />
        </div>
    )
}

const TextRun: FC<{
    group: Extract<RenderableGroup, { kind: 'text-run' }>
    onLinkClick?: MarkdownLinkClickHandler
    renderGrantCards?: boolean
    streaming?: boolean
}> = ({
    group,
    onLinkClick,
    renderGrantCards = false,
    streaming = false
}): ReactNode => (
    <div className='text-ui text-fg my-1 break-words'>
        {group.blocks.map((b, i) => {
            if (b.kind === 'text') {
                if (renderGrantCards) {
                    const { text, tokens } = splitGrantPermissionContent(
                        b.block.text
                    )
                    if (tokens.length > 0)
                        return (
                            <div key={i}>
                                {text && (
                                    <MarkdownText
                                        onLinkClick={onLinkClick}
                                        streaming={streaming}
                                        text={text}
                                    />
                                )}
                                {tokens.map((token) => (
                                    <PermissionRequestCard
                                        key={`grant-${token}`}
                                        token={token}
                                    />
                                ))}
                            </div>
                        )
                }
                return (
                    <MarkdownText
                        key={i}
                        onLinkClick={onLinkClick}
                        streaming={streaming}
                        text={b.block.text}
                    />
                )
            }
            if (b.kind === 'attachment')
                return <MessageAttachment key={i} attachment={b.block} />
            if (b.kind === 'upload')
                return <MessageUpload key={i} upload={b.block} />
            return <MessageContextRef key={i} contextRef={b.block} />
        })}
    </div>
)

const lastIndexOf = <T,>(arr: T[], pred: (x: T) => boolean): number => {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (pred(arr[i])) return i
    }
    return -1
}

const isActiveStreamStatus = (status: StreamStatus): boolean =>
    status === 'connecting' ||
    status === 'streaming' ||
    status === 'suspended' ||
    status === 'cancelling'

const streamStatusLabel = (status: StreamStatus, t: TFn): string => {
    if (status === 'connecting') return t('web.chatStream.connecting')
    if (status === 'suspended') return t('web.chatStream.suspended')
    if (status === 'cancelling') return t('web.chatStream.cancelling')
    if (status === 'cancelled') return t('web.chatStream.cancelled')
    return t('web.chatStream.working')
}

// #674. Recovery outranks connecting/streaming — "Thinking…" is a lie while the
// server is re-reading a dead turn's transcript — and outranks a suspension it
// is provably newer than. See recoveryLabelKey for why the phase being set at
// all is that proof, and why a cancel still wins.
const recoveryPhaseLabel = (
    status: StreamStatus,
    recoveryPhase: ChatTurnStatusPhase | null,
    t: TFn
): string | null => {
    const key = recoveryLabelKey(status, recoveryPhase)
    return key ? t(key) : null
}

const respondingPhaseLabel = (
    status: StreamStatus,
    recoveryPhase: ChatTurnStatusPhase | null,
    t: TFn
): string => {
    const recovery = recoveryPhaseLabel(status, recoveryPhase, t)
    if (recovery) return recovery
    if (status === 'connecting') return t('web.chatStream.connecting')
    if (status === 'suspended') return t('web.chatStream.suspended')
    if (status === 'cancelling') return t('web.chatStream.cancelling')
    if (status === 'cancelled') return t('web.chatStream.cancelled')
    return t('web.chatStream.thinking')
}

const prettyToolName = (name: string): string =>
    name.includes('__') ? (name.split('__').pop() ?? name) : name

const streamingActivityLabel = (
    groups: RenderableGroup[],
    t: TFn
): string | null => {
    const last = groups[groups.length - 1]
    if (!last) return null
    if (last.kind === 'text-run') return t('web.chatStream.responding')
    if (last.kind === 'permission-card')
        return last.block.resolution
            ? null
            : t('web.chatStream.waitingForPermission')
    const block = last.blocks[last.blocks.length - 1]
    if (!block) return null
    if (block.kind === 'thinking') return t('web.chatStream.thinking')
    if (block.kind === 'orphan_result') return null
    if (block.status !== 'running') return null
    return t('web.chatStream.runningTool', {
        tool: prettyToolName(block.call.toolName)
    })
}

// The last activity block describes what the turn was doing when it went
// quiet, so a suspended transport has to override it: "Running bash…" is no
// longer true once the device carrying that exec has dropped. An in-flight
// recovery (#674) overrides it for the same reason — that tool call belongs to
// the execution that died — and outranks the suspension itself when it is the
// newer fact, which is the only shape recoveryPhaseLabel returns one under.
const streamingFooterLabel = (
    status: StreamStatus,
    recoveryPhase: ChatTurnStatusPhase | null,
    groups: RenderableGroup[],
    t: TFn
): string => {
    const recovery = recoveryPhaseLabel(status, recoveryPhase, t)
    if (recovery) return recovery
    if (
        status === 'suspended' ||
        status === 'cancelling' ||
        status === 'cancelled'
    )
        return streamStatusLabel(status, t)
    return streamingActivityLabel(groups, t) ?? streamStatusLabel(status, t)
}

const RespondingIndicator: FC<{
    messageId: string
    status: StreamStatus
    startedAt: number | null
    stalled: boolean
    recoveryPhase: ChatTurnStatusPhase | null
}> = ({ messageId, status, startedAt, stalled, recoveryPhase }): ReactNode => {
    const { t } = useI18n()
    const active = isActiveStreamStatus(status)
    return (
        <div
            data-message-id={chatMessageAnchorId(messageId) ?? undefined}
            role='status'
            aria-live='polite'
            className='flex w-full max-w-full items-center gap-2 px-0.5'
        >
            <span
                className={[
                    'bg-workflow-develop h-2 w-2 shrink-0 rounded-full',
                    active ? 'animate-pulse' : ''
                ].join(' ')}
            />
            <span className='text-caption text-subtle inline-flex min-w-0 items-center gap-1'>
                <span className={active ? 'chat-shiny-text' : undefined}>
                    {respondingPhaseLabel(status, recoveryPhase, t)}
                </span>
                <ElapsedTimer
                    startedAt={startedAt}
                    active={active}
                    thresholdMs={2100}
                />
                {stalled && (
                    <span className='text-placeholder truncate'>
                        {t('web.chatStream.stalled')}
                    </span>
                )}
            </span>
        </div>
    )
}

const formatSize = (size: number): string => {
    if (size < 1024) return `${size} B`
    const kb = size / 1024
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`
    const mb = kb / 1024
    return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

const copyTextFromBlocks = (blocks: ChatContentBlock[]): string =>
    markdownToPlainText(markdownTextFromBlocks(blocks))

const markdownTextFromBlocks = (blocks: ChatContentBlock[]): string =>
    blocks
        .filter(
            (block): block is Extract<ChatContentBlock, { type: 'text' }> =>
                block.type === 'text'
        )
        .map((block) => block.text)
        .join('')
        .trim()

const markdownToPlainText = (markdown: string): string =>
    markdown
        .replace(/```[\w-]*\n([\s\S]*?)```/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/([*_~]){1,3}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

const rawResponseFromMessage = (message: ChatMessage): unknown => ({
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    model: message.model ?? message.usage?.model ?? null,
    createdAt: message.createdAt,
    contentBlocks: message.contentBlocks,
    usage: message.usage ?? null
})

export default MessageList
