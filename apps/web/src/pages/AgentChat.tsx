import {
    AgentFramework,
    AgentModelConfig,
    AgentModelConfigSource,
    AgentModelConfigView,
    CHAT_ATTACHMENT_MAX_COUNT,
    CHAT_MESSAGE_SOFT_LIMIT,
    ChatCapabilities,
    ChatMessage,
    ChatMessagesPage,
    ClaudeCodePermissionMode,
    CodexPermissionMode,
    HermesPermissionMode,
    CreateMessageAttachmentInput,
    CreateMessageContextRefInput,
    CreateMessageUploadInput,
    DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    DEFAULT_CODEX_PERMISSION_MODE,
    DEFAULT_HERMES_PERMISSION_MODE,
    chatCapabilitiesByFramework,
    isClaudeCodePermissionMode,
    isCodexPermissionMode,
    isHermesPermissionMode
} from '@manyfold/shared'
import {
    Suspense,
    type CSSProperties,
    type FC,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode
} from 'react'
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import {
    Link,
    Navigate,
    useNavigate,
    useParams,
    useSearchParams
} from 'react-router-dom'
import {
    FolderIcon,
    FolderOpenIcon,
    HistoryIcon,
    MenuIcon,
    PreviewIcon,
    RefreshIcon,
    ShareIcon,
    TasksIcon,
    TerminalIcon
} from '@/components/icons'
import type { SdkAgent } from '@manyfold/sdk'
import { useAppShellContext } from '@/components/AppShell'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { workspaceDirNameOf, workspacePathOf } from '@/lib/workspacePath'
import { navigateWithRailTransition } from '@/lib/railTransition'
import EmptyState from '@/components/EmptyState'
import ShareChatSessionDialog from '@/components/chat/ShareChatSessionDialog'
import { RuntimeLocalSignInCard } from '@/components/chat/RuntimeLocalSignInCard'
import { shouldShowRuntimeSignIn } from '@/lib/runtimeSignIn'
import { useI18n, type TFn } from '@/lib/i18n'
import { Ghost } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { publishAgentCredentialsOpen } from '@/lib/agentCredentialsEvents'
import { apiErrorMessage } from '@/lib/errorMessage'
import { lazyChunk } from '@/lib/lazyChunk'
import { buildQuotaConflictRequest } from '@/lib/quotaConflict'
import { useAppAuth } from '@/lib/auth'
import { agentStatusDotClass, agentStatusDotLabel } from '@/lib/agentStatusDot'
import { getAgentChatAvailability } from '@/lib/chatAgents'
import {
    CHAT_SCROLL_BOTTOM,
    chatScrollScopeKey,
    readChatScrollPosition,
    shouldRestoreChatScrollScope,
    writeChatScrollPosition,
    type ChatScrollPosition
} from '@/lib/chatScrollMemory'
import { useChatStream, type StreamStatus } from '@/lib/useChatStream'
import { chatStreamStore, type ReplayCheckpoint } from '@/lib/chatStreamStore'
import {
    publishStreamEvent,
    subscribeStreamEvents
} from '@/lib/chatStreamBroadcast'
import {
    FrameworkLogo,
    modelOptionsForAgent,
    supportsModelOverride
} from '@/lib/frameworkMeta'
import {
    draftFromModelConfigView,
    frameworkUsesModelConfig,
    mergeCachedRuntimeLocalModelConfigView,
    normalizeDraftForView,
    readCachedModelConfigView,
    subscribeModelConfigViewUpdates,
    validateModelConfigDraft,
    writeCachedModelConfigView
} from '@/lib/agentModelConfig'
import { matchesKeyboardShortcut } from '@/lib/keyboardShortcuts'
import Composer, {
    type ComposerAgentOption,
    type ComposerContextRef,
    type ComposerSendAttachment,
    type ComposerSendHelpers
} from '@/components/chat/Composer'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { ChatGrantProvider } from '@/components/chat/ChatGrantContext'
import type { MarkdownLinkClickHandler } from '@/components/chat/MarkdownText'
import type { MessageScrollAction } from '@/components/chat/MessageList'
import type {
    WorkspaceFileContextRef,
    WorkspaceFilePreviewRequest,
    WorkspaceFileTerminalRequest
} from '@/components/chat/WorkspaceFiles'
import { resolveWorkspaceFileLink } from '@/components/chat/fileLinkPreview'
import {
    applyRegeneratedUserMessage,
    mergeLatestMessages,
    mergeMessagesById
} from '@/lib/chatMessages'

const MessageList = lazyChunk(() => import('@/components/chat/MessageList'))
const WorkspaceFiles = lazyChunk(
    () => import('@/components/chat/WorkspaceFiles')
)
const RuntimeSessionViewer = lazyChunk(
    () => import('@/components/chat/RuntimeSessionViewer')
)

// The page's inflight turn as a resumable pair, or null if it did not carry
// one. Both halves come out of the SAME response: the cursor only describes
// the `contentBlocks` that arrived with it, and pairing it with any other
// read of the row would either lose the events between the two or replay
// them over content that already holds them.
const checkpointFromPage = (
    page: ChatMessagesPage
): ReplayCheckpoint | null => {
    const messageId = page.inflightAssistantMessageId
    const eventId = page.inflightCheckpointEventId
    if (!messageId || !eventId) return null
    const row = page.messages.find((message) => message.id === messageId)
    if (!row) return null
    return { messageId, eventId, blocks: row.contentBlocks }
}

const DRAFT_SEARCH_VALUE = '1'
const MODEL_OVERRIDE_STORAGE_PREFIX = 'nca.chat.modelOverride.'
const CLAUDE_CODE_PERMISSION_MODE_STORAGE_PREFIX =
    'nca.chat.claudeCodePermissionMode.'
const CODEX_PERMISSION_MODE_STORAGE_PREFIX = 'nca.chat.codexPermissionMode.'
const HERMES_PERMISSION_MODE_STORAGE_PREFIX = 'nca.chat.hermesPermissionMode.'
const DRAFT_STORAGE_PREFIX = 'nca.chat.draft.'
const DRAFT_NEW_SLOT = 'new'
const DEFAULT_RUNTIME_SESSION_PANEL_WIDTH = 560
const MIN_RUNTIME_SESSION_PANEL_WIDTH = 420
const MAX_RUNTIME_SESSION_PANEL_WIDTH = 900
const CHAT_MESSAGES_PAGE_SIZE = CHAT_MESSAGE_SOFT_LIMIT

// A rejected cancel POST is undone immediately by cancelRequestFailed. This
// covers the other case: the POST was accepted (or is still hanging) and no
// terminal event followed, so re-arm the stop control rather than leaving the
// user stuck in 'cancelling'.
const CANCEL_RETRY_AFTER_MS = 15_000

const isLiveStreamStatus = (status: StreamStatus): boolean =>
    status === 'connecting' ||
    status === 'streaming' ||
    status === 'suspended' ||
    status === 'cancelling'

interface CleanupCandidate {
    agentId: string | null
    sessionId: string | null
    isEmpty: boolean
}

const AgentChat: FC = (): ReactNode => {
    const { t } = useI18n()
    const { id: agentId } = useParams<{ id: string }>()
    const [searchParams, setSearchParams] = useSearchParams()
    const navigate = useNavigate()
    const client = useApiClient()
    const { getToken, sessionKey } = useAppAuth()
    const {
        agents,
        agentsLoading,
        bgTasksVisible,
        currentAgent,
        openMobileSidebar,
        openTerminalForAgent,
        refreshAgents,
        refreshSessionsForAgent,
        requestQuotaConflict,
        sessions,
        sessionsLoading,
        toggleBackgroundTasks
    } = useAppShellContext()
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [error, setError] = useState<string | null>(null)
    const [messagesLoading, setMessagesLoading] = useState(false)
    const [loadedMessagesSessionId, setLoadedMessagesSessionId] = useState<
        string | null
    >(null)
    const [messagesHasMore, setMessagesHasMore] = useState(false)
    const [messagesNextBefore, setMessagesNextBefore] = useState<string | null>(
        null
    )
    const [inflightAssistantMessageId, setInflightAssistantMessageId] =
        useState<string | null>(null)
    const [inflightCheckpoint, setInflightCheckpoint] =
        useState<ReplayCheckpoint | null>(null)
    const [streamCursorEventId, setStreamCursorEventId] =
        useState<string | null>(null)
    const [olderMessagesLoading, setOlderMessagesLoading] = useState(false)
    const [messageScrollAction, setMessageScrollAction] =
        useState<MessageScrollAction | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [filesVisible, setFilesVisible] = useState(false)
    const [filePreviewVisible, setFilePreviewVisible] = useState(false)
    const [filePreviewAvailable, setFilePreviewAvailable] = useState(false)
    const [filePreviewRequest, setFilePreviewRequest] =
        useState<WorkspaceFilePreviewRequest | null>(null)
    const [composerContextRefs, setComposerContextRefs] = useState<
        ComposerContextRef[]
    >([])
    const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0)
    const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false)
    const [modelOverride, setModelOverride] = useState<string | null>(null)
    const [claudeCodePermissionMode, setClaudeCodePermissionMode] =
        useState<ClaudeCodePermissionMode>(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
    const [codexPermissionMode, setCodexPermissionMode] =
        useState<CodexPermissionMode>(DEFAULT_CODEX_PERMISSION_MODE)
    const [hermesPermissionMode, setHermesPermissionMode] =
        useState<HermesPermissionMode>(DEFAULT_HERMES_PERMISSION_MODE)
    const [modelConfigView, setModelConfigView] =
        useState<AgentModelConfigView | null>(null)
    const [modelConfigDraft, setModelConfigDraft] =
        useState<AgentModelConfig | null>(null)
    const [modelConfigSourceDraft, setModelConfigSourceDraft] =
        useState<AgentModelConfigSource>('platform')
    const [modelConfigLoading, setModelConfigLoading] = useState(false)
    const [modelConfigRefreshing, setModelConfigRefreshing] = useState(false)
    const [runtimeSessionViewerOpen, setRuntimeSessionViewerOpen] =
        useState(false)
    const [runtimeSessionPanelWidth, setRuntimeSessionPanelWidth] = useState(
        DEFAULT_RUNTIME_SESSION_PANEL_WIDTH
    )
    const sendInFlightRef = useRef(false)
    const chatWindowRef = useRef<HTMLDivElement>(null)
    const composerDockRef = useRef<HTMLDivElement>(null)
    const [composerDockHeight, setComposerDockHeight] = useState(0)
    const messageScrollActionSeqRef = useRef(0)
    const activeSessionIdRef = useRef<string | null>(null)
    const agentIdRef = useRef<string | null>(null)
    const loadedMessagesAgentIdRef = useRef<string | null>(null)
    const loadedMessagesSessionIdRef = useRef<string | null>(null)
    const messagesLengthRef = useRef(0)
    const filePreviewRequestIdRef = useRef(0)
    const modelInitializedAgentRef = useRef<string | null>(null)
    const cleanupInFlightRef = useRef<Set<string>>(new Set())
    const cleanupIgnoredRef = useRef<Set<string>>(new Set())
    const cleanupCandidateRef = useRef<CleanupCandidate>({
        agentId: null,
        sessionId: null,
        isEmpty: false
    })
    const olderMessagesRequestIdRef = useRef(0)
    const olderMessagesAbortRef = useRef<AbortController | null>(null)
    const activeSessionId = searchParams.get('sessionId')
    const [shareSessionOpen, setShareSessionOpen] = useState(false)
    const activeSession = activeSessionId
        ? (sessions.find((session) => session.id === activeSessionId) ?? null)
        : null
    const shareableSession =
        activeSession && !activeSession.channel ? activeSession : null
    const isDraft =
        activeSessionId === null &&
        searchParams.get('draft') === DRAFT_SEARCH_VALUE
    const showAgentPicker = isDraft && searchParams.get('pickAgent') === '1'
    const draftKey = agentId
        ? `${DRAFT_STORAGE_PREFIX}${agentId}.${activeSessionId ?? DRAFT_NEW_SLOT}`
        : null

    // The reading position belongs to one account's copy of one conversation.
    // Agent Settings is a sibling route, so coming back mounts a new message
    // list that would otherwise start at the newest message (#725).
    const scrollScopeKey = useMemo(
        () =>
            chatScrollScopeKey({
                accountKey: sessionKey,
                agentId,
                sessionId: activeSessionId
            }),
        [activeSessionId, agentId, sessionKey]
    )
    const scrollScopeKeyRef = useRef(scrollScopeKey)
    useLayoutEffect(() => {
        scrollScopeKeyRef.current = scrollScopeKey
    }, [scrollScopeKey])
    const restoredScrollScopeKeyRef = useRef<string | null>(null)

    const rememberMessageScroll = useCallback(
        (scopeKey: string, position: ChatScrollPosition): void => {
            writeChatScrollPosition(scopeKey, position)
        },
        []
    )

    useEffect(() => {
        setComposerContextRefs([])
    }, [draftKey])

    const chatAvailability = useMemo(
        () => getAgentChatAvailability(currentAgent),
        [currentAgent]
    )

    useEffect(() => {
        loadedMessagesSessionIdRef.current = loadedMessagesSessionId
    }, [loadedMessagesSessionId])

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId
        agentIdRef.current = agentId ?? null
    }, [activeSessionId, agentId])

    useEffect(() => {
        messagesLengthRef.current = messages.length
    }, [messages.length])

    const disabled = !chatAvailability.ready
    const modelSwitchingSupported = supportsModelOverride(currentAgent)
    const currentAgentId = currentAgent?.id ?? null
    const currentAgentFramework = currentAgent?.framework ?? null
    const hermesModelSwitching = currentAgentFramework === 'hermes'
    const frameworkModelConfigSupported = frameworkUsesModelConfig(
        currentAgentFramework,
        currentAgent?.runtime
    )
    const modelOptions = useMemo(
        () =>
            modelOptionsForAgent(currentAgent, [
                modelOverride,
                // hermes options come from the provider-models cache the
                // model-config view carries; presets stay empty.
                ...(hermesModelSwitching
                    ? (modelConfigView?.providerModels ?? [])
                    : [])
            ]),
        [currentAgent, modelOverride, hermesModelSwitching, modelConfigView]
    )
    const effectiveModelConfigView = useMemo(
        () =>
            modelConfigView
                ? { ...modelConfigView, source: modelConfigSourceDraft }
                : null,
        [modelConfigSourceDraft, modelConfigView]
    )
    const normalizedModelConfigDraft = useMemo(
        () => normalizeDraftForView(effectiveModelConfigView, modelConfigDraft),
        [effectiveModelConfigView, modelConfigDraft]
    )
    const modelConfigValidation = useMemo(
        () =>
            validateModelConfigDraft(
                effectiveModelConfigView,
                normalizedModelConfigDraft,
                t
            ),
        [effectiveModelConfigView, normalizedModelConfigDraft, t]
    )
    const applyModelConfigView = useCallback(
        (view: AgentModelConfigView): void => {
            setModelConfigView(view)
            setModelConfigDraft(draftFromModelConfigView(view))
            setModelConfigSourceDraft(view.source)
        },
        []
    )
    const capabilities: ChatCapabilities = useMemo(
        () =>
            currentAgent
                ? chatCapabilitiesByFramework[
                      currentAgent.framework as AgentFramework
                  ]
                : chatCapabilitiesByFramework['claude-code'],
        [currentAgent]
    )
    const agentOptions: ComposerAgentOption[] = useMemo(
        () =>
            agents.map((agent) => {
                const availability = getAgentChatAvailability(agent)
                return {
                    id: agent.id,
                    name: agent.name,
                    framework: agent.framework,
                    status: agent.status,
                    disabled: !availability.ready,
                    disabledReason: availability.reason ?? undefined
                }
            }),
        [agents]
    )

    const requestMessageScroll = useCallback(
        (position: ChatScrollPosition): void => {
            messageScrollActionSeqRef.current += 1
            setMessageScrollAction({
                position,
                seq: messageScrollActionSeqRef.current
            })
        },
        []
    )

    const cancelOlderMessages = useCallback((): void => {
        olderMessagesRequestIdRef.current += 1
        olderMessagesAbortRef.current?.abort()
        olderMessagesAbortRef.current = null
    }, [])

    const resetConversationState = useCallback((): void => {
        cancelOlderMessages()
        setMessagesLoading(false)
        loadedMessagesAgentIdRef.current = null
        setLoadedMessagesSessionId(null)
        setMessages([])
        setMessagesHasMore(false)
        setMessagesNextBefore(null)
        setInflightAssistantMessageId(null)
        setInflightCheckpoint(null)
        setStreamCursorEventId(null)
        setOlderMessagesLoading(false)
        setMessageScrollAction(null)
    }, [cancelOlderMessages])

    useEffect(
        () => (): void => cancelOlderMessages(),
        [cancelOlderMessages]
    )

    useEffect(() => {
        modelInitializedAgentRef.current = null
        setModelOverride(null)
    }, [agentId])

    useEffect(() => {
        if (!agentId || currentAgent?.id !== agentId) {
            setClaudeCodePermissionMode(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
            setCodexPermissionMode(DEFAULT_CODEX_PERMISSION_MODE)
            setHermesPermissionMode(DEFAULT_HERMES_PERMISSION_MODE)
            return
        }
        if (currentAgent.framework === 'claude-code') {
            setClaudeCodePermissionMode(
                readStoredClaudeCodePermissionMode(agentId)
            )
            setCodexPermissionMode(DEFAULT_CODEX_PERMISSION_MODE)
            setHermesPermissionMode(DEFAULT_HERMES_PERMISSION_MODE)
            return
        }
        if (currentAgent.framework === 'codex') {
            setClaudeCodePermissionMode(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
            setCodexPermissionMode(readStoredCodexPermissionMode(agentId))
            setHermesPermissionMode(DEFAULT_HERMES_PERMISSION_MODE)
            return
        }
        if (currentAgent.framework === 'hermes') {
            setClaudeCodePermissionMode(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
            setCodexPermissionMode(DEFAULT_CODEX_PERMISSION_MODE)
            setHermesPermissionMode(readStoredHermesPermissionMode(agentId))
            return
        }
        setClaudeCodePermissionMode(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
        setCodexPermissionMode(DEFAULT_CODEX_PERMISSION_MODE)
        setHermesPermissionMode(DEFAULT_HERMES_PERMISSION_MODE)
    }, [agentId, currentAgent])

    useEffect(() => {
        if (!agentId) return
        if (sessionsLoading) return
        try {
            const prefix = `${DRAFT_STORAGE_PREFIX}${agentId}.`
            const liveSlots = new Set<string>([DRAFT_NEW_SLOT])
            for (const session of sessions) liveSlots.add(session.id)
            const toRemove: string[] = []
            for (let i = 0; i < window.localStorage.length; i++) {
                const key = window.localStorage.key(i)
                if (!key || !key.startsWith(prefix)) continue
                const slot = key.slice(prefix.length)
                if (!liveSlots.has(slot)) toRemove.push(key)
            }
            for (const key of toRemove) window.localStorage.removeItem(key)
        } catch {
            /* ignore local storage failures */
        }
    }, [agentId, sessions, sessionsLoading])

    useEffect(() => {
        if (!agentId) {
            return
        }
        if (currentAgent?.id !== agentId) return
        if (modelInitializedAgentRef.current === agentId) return
        modelInitializedAgentRef.current = agentId
        if (!supportsModelOverride(currentAgent.framework)) {
            setModelOverride(null)
            return
        }
        const stored = readStoredModelOverride(agentId)
        setModelOverride(
            stored !== undefined
                ? stored
                : normalizeModelOverride(currentAgent.model)
        )
    }, [agentId, currentAgent])

    useEffect(() => {
        let cancelled = false
        if (
            !agentId ||
            currentAgentId !== agentId ||
            // hermes has no config drawer, but the view's providerModels feed
            // its model picker, so the fetch runs for it too.
            !(frameworkModelConfigSupported || hermesModelSwitching)
        ) {
            setModelConfigView(null)
            setModelConfigDraft(null)
            setModelConfigSourceDraft('platform')
            setModelConfigLoading(false)
            return () => {
                cancelled = true
            }
        }
        const cachedView = readCachedModelConfigView(agentId)
        const usableCachedView =
            cachedView?.framework === currentAgentFramework ? cachedView : null
        if (usableCachedView) applyModelConfigView(usableCachedView)
        setModelConfigLoading(!usableCachedView)
        client.agents
            .getModelConfig(agentId)
            .then((view) => {
                if (cancelled) return
                const mergedView = mergeCachedRuntimeLocalModelConfigView(
                    view,
                    readCachedModelConfigView(agentId) ?? usableCachedView
                )
                writeCachedModelConfigView(mergedView)
                applyModelConfigView(mergedView)
            })
            .catch((err: Error) => {
                if (cancelled) return
                setError(err.message)
            })
            .finally(() => {
                if (!cancelled) setModelConfigLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [
        agentId,
        client,
        currentAgentId,
        currentAgentFramework,
        frameworkModelConfigSupported,
        applyModelConfigView
    ])

    useEffect(() => {
        if (
            !agentId ||
            !frameworkModelConfigSupported ||
            typeof window === 'undefined'
        ) {
            return
        }
        return subscribeModelConfigViewUpdates(agentId, (cachedView) => {
            if (cachedView.framework !== currentAgentFramework) return
            applyModelConfigView(cachedView)
        })
    }, [
        agentId,
        currentAgentFramework,
        frameworkModelConfigSupported,
        applyModelConfigView
    ])

    const handleModelOverrideChange = useCallback(
        (next: string | null): void => {
            // hermes sessions PERSIST their model, so picking "default" must
            // re-send the default's id — a null override sends nothing and
            // would leave the session on the previous pick while the UI
            // claims the default.
            const normalized =
                normalizeModelOverride(next) ??
                (hermesModelSwitching
                    ? normalizeModelOverride(currentAgent?.model ?? null)
                    : null)
            setModelOverride(normalized)
            if (agentId) writeStoredModelOverride(agentId, normalized)
        },
        [agentId, hermesModelSwitching, currentAgent]
    )

    const handleRefreshModelConfig = useCallback(
        async (sourceOverride?: AgentModelConfigSource): Promise<void> => {
            if (!agentId) return
            const source = sourceOverride ?? modelConfigSourceDraft
            setModelConfigRefreshing(true)
            setError(null)
            try {
                const result = await client.agents.refreshModelConfigModels(
                    agentId,
                    {
                        source
                    }
                )
                writeCachedModelConfigView(result.view)
                setModelConfigView(result.view)
                if (source === modelConfigSourceDraft) {
                    setModelConfigDraft(draftFromModelConfigView(result.view))
                    setModelConfigSourceDraft(source)
                }
            } catch (err) {
                setError(apiErrorMessage(err))
                throw err
            } finally {
                setModelConfigRefreshing(false)
            }
        },
        [agentId, client, modelConfigSourceDraft]
    )

    useEffect(() => {
        if (!activeSessionId || !searchParams.has('draft')) return
        const next = new URLSearchParams(searchParams)
        next.delete('draft')
        next.delete('pickAgent')
        setSearchParams(next, { replace: true })
    }, [activeSessionId, searchParams, setSearchParams])

    useEffect(() => {
        if (sessionsLoading) return
        const firstSessionId = sessions[0]?.id ?? null
        if (!activeSessionId) {
            if (isDraft) return
            if (firstSessionId) {
                const next = new URLSearchParams(searchParams)
                next.delete('draft')
                next.delete('pickAgent')
                next.set('sessionId', firstSessionId)
                setSearchParams(next, { replace: true })
            }
            return
        }
        if (sessions.some((session) => session.id === activeSessionId)) return
        const next = new URLSearchParams(searchParams)
        next.delete('draft')
        next.delete('pickAgent')
        if (firstSessionId) next.set('sessionId', firstSessionId)
        else next.delete('sessionId')
        setSearchParams(next, { replace: true })
    }, [
        activeSessionId,
        isDraft,
        searchParams,
        sessions,
        sessionsLoading,
        setSearchParams
    ])

    useEffect(() => {
        if (!agentId || !activeSessionId) {
            setError(null)
            resetConversationState()
            return
        }
        let cancelled = false
        const controller = new AbortController()
        const sessionId = activeSessionId
        restoredScrollScopeKeyRef.current = null
        setError(null)
        resetConversationState()
        setMessagesLoading(true)
        client.chat
            .listMessagePage(agentId, sessionId, {
                limit: CHAT_MESSAGES_PAGE_SIZE,
                signal: controller.signal
            })
            .then((page) => {
                if (cancelled) return
                setMessages(page.messages)
                setMessagesHasMore(page.hasMore)
                setMessagesNextBefore(page.nextBefore)
                setInflightAssistantMessageId(page.inflightAssistantMessageId)
                setInflightCheckpoint(checkpointFromPage(page))
                setStreamCursorEventId(page.streamCursorEventId)
                loadedMessagesAgentIdRef.current = agentId
                setLoadedMessagesSessionId(sessionId)
                const scopeKey = scrollScopeKeyRef.current
                if (scopeKey) {
                    restoredScrollScopeKeyRef.current = scopeKey
                    requestMessageScroll(
                        readChatScrollPosition(scopeKey) ?? CHAT_SCROLL_BOTTOM
                    )
                }
            })
            .catch((e: Error) => {
                if (!cancelled && !controller.signal.aborted)
                    setError(e.message)
            })
            .finally(() => {
                if (!cancelled && !controller.signal.aborted)
                    setMessagesLoading(false)
            })
        return (): void => {
            cancelled = true
            controller.abort()
        }
    }, [
        activeSessionId,
        agentId,
        client,
        requestMessageScroll,
        resetConversationState
    ])

    useLayoutEffect(() => {
        if (
            !shouldRestoreChatScrollScope({
                scopeKey: scrollScopeKey,
                restoredScopeKey: restoredScrollScopeKeyRef.current,
                loadedAgentId: loadedMessagesAgentIdRef.current,
                activeAgentId: agentId ?? null,
                loadedSessionId: loadedMessagesSessionId,
                activeSessionId
            })
        )
            return
        restoredScrollScopeKeyRef.current = scrollScopeKey
        requestMessageScroll(
            readChatScrollPosition(scrollScopeKey) ?? CHAT_SCROLL_BOTTOM
        )
    }, [
        activeSessionId,
        agentId,
        loadedMessagesSessionId,
        requestMessageScroll,
        scrollScopeKey
    ])

    const refreshMessagesFromServer = useCallback(async (): Promise<void> => {
        if (!agentId || !activeSessionId) return
        const requestAgentId = agentId
        const requestSessionId = activeSessionId
        try {
            const page = await client.chat.listMessagePage(
                requestAgentId,
                requestSessionId,
                { limit: CHAT_MESSAGES_PAGE_SIZE }
            )
            if (
                agentIdRef.current !== requestAgentId ||
                activeSessionIdRef.current !== requestSessionId
            )
                return
            setMessages((prev) =>
                page.messages.length === 0
                    ? []
                    : mergeLatestMessages(prev, page.messages)
            )
            if (
                loadedMessagesSessionIdRef.current !== requestSessionId ||
                messagesLengthRef.current === 0
            ) {
                setMessagesHasMore(page.hasMore)
                setMessagesNextBefore(page.nextBefore)
            }
            loadedMessagesAgentIdRef.current = requestAgentId
            setLoadedMessagesSessionId(requestSessionId)
            const streamKey = chatStreamStore.keyOf(
                requestAgentId,
                requestSessionId
            )
            const snapshot = chatStreamStore.getSnapshot(streamKey)
            const persistedStreamingMessageId = snapshot.streamingAssistantId
            if (
                persistedStreamingMessageId &&
                page.inflightAssistantMessageId !==
                    persistedStreamingMessageId &&
                page.messages.some(
                    (message) => message.id === persistedStreamingMessageId
                )
            )
                chatStreamStore.acknowledgePersistedMessage(
                    streamKey,
                    persistedStreamingMessageId
                )
            setInflightAssistantMessageId(page.inflightAssistantMessageId)
            setInflightCheckpoint(checkpointFromPage(page))
            setStreamCursorEventId(page.streamCursorEventId)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }, [activeSessionId, agentId, client])

    // Recover-raw / rebuild-parsed rewrite the session's history server-side
    // (rebuild replaces every message id); merging the latest page would keep
    // ghost rows and a pagination cursor pointing at deleted ids, so reload
    // the first page wholesale instead.
    const reloadSessionMessages = useCallback(async (): Promise<void> => {
        if (!agentId || !activeSessionId) return
        const requestAgentId = agentId
        const requestSessionId = activeSessionId
        try {
            const page = await client.chat.listMessagePage(
                requestAgentId,
                requestSessionId,
                { limit: CHAT_MESSAGES_PAGE_SIZE }
            )
            if (
                agentIdRef.current !== requestAgentId ||
                activeSessionIdRef.current !== requestSessionId
            )
                return
            setMessages(page.messages)
            setMessagesHasMore(page.hasMore)
            setMessagesNextBefore(page.nextBefore)
            setInflightAssistantMessageId(page.inflightAssistantMessageId)
            setInflightCheckpoint(checkpointFromPage(page))
            setStreamCursorEventId(page.streamCursorEventId)
            loadedMessagesAgentIdRef.current = requestAgentId
            setLoadedMessagesSessionId(requestSessionId)
            requestMessageScroll(CHAT_SCROLL_BOTTOM)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }, [activeSessionId, agentId, client, requestMessageScroll])

    const loadOlderMessages = useCallback(async (): Promise<void> => {
        if (
            !agentId ||
            !activeSessionId ||
            !messagesNextBefore ||
            olderMessagesLoading
        )
            return
        const requestAgentId = agentId
        const requestSessionId = activeSessionId
        const requestId = olderMessagesRequestIdRef.current + 1
        olderMessagesRequestIdRef.current = requestId
        const controller = new AbortController()
        olderMessagesAbortRef.current = controller
        setOlderMessagesLoading(true)
        try {
            const page = await client.chat.listMessagePage(
                requestAgentId,
                requestSessionId,
                {
                    limit: CHAT_MESSAGES_PAGE_SIZE,
                    before: messagesNextBefore,
                    signal: controller.signal
                }
            )
            if (
                olderMessagesRequestIdRef.current !== requestId ||
                agentIdRef.current !== requestAgentId ||
                activeSessionIdRef.current !== requestSessionId
            )
                return
            setMessages((prev) => mergeMessagesById(prev, page.messages))
            setMessagesHasMore(page.hasMore)
            setMessagesNextBefore(page.nextBefore)
            loadedMessagesAgentIdRef.current = requestAgentId
            setLoadedMessagesSessionId(requestSessionId)
        } catch (err) {
            if (controller.signal.aborted) return
            if (olderMessagesRequestIdRef.current === requestId)
                setError(apiErrorMessage(err))
            throw err
        } finally {
            if (olderMessagesRequestIdRef.current === requestId) {
                olderMessagesAbortRef.current = null
                setOlderMessagesLoading(false)
            }
        }
    }, [
        activeSessionId,
        agentId,
        client,
        messagesNextBefore,
        olderMessagesLoading
    ])

    const handleRefreshWorkspace = useCallback(async (): Promise<void> => {
        if (!agentId || workspaceRefreshing) return
        setWorkspaceRefreshing(true)
        setWorkspaceRefreshKey((value) => value + 1)
        try {
            await Promise.all([
                refreshAgents(),
                refreshSessionsForAgent(agentId),
                refreshMessagesFromServer()
            ])
        } finally {
            setWorkspaceRefreshing(false)
        }
    }, [
        agentId,
        refreshAgents,
        refreshMessagesFromServer,
        refreshSessionsForAgent,
        workspaceRefreshing
    ])

    const handleAttachWorkspaceContext = useCallback(
        (contextRef: WorkspaceFileContextRef): void => {
            setComposerContextRefs((prev) => {
                const key = contextRefKey(contextRef)
                if (prev.some((item) => contextRefKey(item) === key))
                    return prev
                if (prev.length >= CHAT_ATTACHMENT_MAX_COUNT) {
                    setError(
                        t('web.composer.attachmentLimit', {
                            max: CHAT_ATTACHMENT_MAX_COUNT
                        })
                    )
                    return prev
                }
                setError(null)
                return [
                    ...prev,
                    {
                        ...contextRef,
                        id: createContextRefId()
                    }
                ]
            })
        },
        [t]
    )

    const handleRemoveComposerContextRef = useCallback((id: string): void => {
        setComposerContextRefs((prev) => prev.filter((ref) => ref.id !== id))
    }, [])

    // Composer focus = send intent: fire-and-forget sprite prewarm so the ~1s
    // VM resume overlaps typing time. Client throttle keeps focus churn off
    // the network; the API debounces again per agent.
    const prewarmedAgentsRef = useRef(new Map<string, number>())
    const handleComposeIntent = useCallback((): void => {
        if (!agentId) return
        const now = Date.now()
        const last = prewarmedAgentsRef.current.get(agentId)
        if (last !== undefined && now - last < 30_000) return
        prewarmedAgentsRef.current.set(agentId, now)
        void client.chat.prewarm(agentId).catch(() => {
            // best-effort wake; the real turn surfaces persistent failures
        })
    }, [agentId, client])

    const handleOpenWorkspaceTerminal = useCallback(
        (request: WorkspaceFileTerminalRequest): void => {
            if (!currentAgent) return
            openTerminalForAgent(currentAgent, {
                cwdLabel: request.label,
                cwdPath: request.cwdPath,
                cwdRootId: request.rootId
            })
        },
        [currentAgent, openTerminalForAgent]
    )

    const stream = useChatStream({
        agentId: agentId ?? null,
        sessionId: activeSessionId,
        // Attach only after the initial page resolves, so the first connection
        // carries either its inflight replay target or its idle stream cursor.
        enabled:
            !disabled &&
            Boolean(activeSessionId) &&
            Boolean(agentId) &&
            loadedMessagesSessionId === activeSessionId,
        baseUrl: import.meta.env.VITE_API_URL ?? '/api',
        getToken,
        onFallback: refreshMessagesFromServer,
        replayMessageId: inflightAssistantMessageId,
        replayCheckpoint: inflightCheckpoint,
        initialLastEventId: streamCursorEventId
    })

    const lastTurnRef = useRef<{
        sessionId: string | null
        messageId: string | null
        status: StreamStatus
    }>({ sessionId: null, messageId: null, status: 'idle' })
    useEffect(() => {
        const prev = lastTurnRef.current
        const sid = activeSessionId
        const mid = stream.streamingAssistantId
        const status = stream.status
        lastTurnRef.current = { sessionId: sid, messageId: mid, status }
        if (
            prev.sessionId === sid &&
            prev.messageId !== null &&
            isLiveStreamStatus(prev.status) &&
            !isLiveStreamStatus(status)
        ) {
            setInflightAssistantMessageId(null)
            setInflightCheckpoint(null)
            void refreshMessagesFromServer()
            if (agentId) void refreshSessionsForAgent(agentId)
        }
    }, [
        activeSessionId,
        agentId,
        refreshMessagesFromServer,
        refreshSessionsForAgent,
        stream.status,
        stream.streamingAssistantId
    ])

    useEffect(() => {
        return subscribeStreamEvents((msg) => {
            if (!agentId || msg.agentId !== agentId) return
            if (msg.type === 'turn-begin') {
                if (msg.sessionId === activeSessionId) {
                    void refreshMessagesFromServer()
                    chatStreamStore.beginAssistantTurn(
                        chatStreamStore.keyOf(agentId, msg.sessionId),
                        {
                            agentId,
                            sessionId: msg.sessionId,
                            baseUrl: import.meta.env.VITE_API_URL ?? '/api',
                            getToken,
                            onFallback: refreshMessagesFromServer
                        },
                        msg.assistantMessageId
                    )
                } else {
                    void refreshSessionsForAgent(agentId)
                }
                return
            }
            if (msg.type === 'cancel') {
                if (msg.sessionId === activeSessionId) {
                    const streamKey = chatStreamStore.keyOf(
                        agentId,
                        msg.sessionId
                    )
                    const attempt = chatStreamStore.cancelMatchingTurn(
                        streamKey,
                        msg.assistantMessageId
                    )
                    if (attempt)
                        chatStreamStore.cancelRequestSucceeded(
                            streamKey,
                            attempt
                        )
                }
            }
        })
    }, [
        activeSessionId,
        agentId,
        getToken,
        refreshMessagesFromServer,
        refreshSessionsForAgent
    ])

    const selectSession = useCallback(
        (sessionId: string | null, replace = false): void => {
            const next = new URLSearchParams(searchParams)
            next.delete('draft')
            next.delete('pickAgent')
            if (sessionId) next.set('sessionId', sessionId)
            else next.delete('sessionId')
            setSearchParams(next, { replace })
        },
        [searchParams, setSearchParams]
    )

    // Stable references: the viewer holds multi-MB state, and fresh inline
    // closures would re-render it on every streaming token of the main chat.
    const handleRuntimeViewerClose = useCallback((): void => {
        setRuntimeSessionViewerOpen(false)
    }, [])

    const handleRuntimeViewerApplied = useCallback(
        (restoredSessionId?: string): void => {
            if (restoredSessionId) {
                void (async (): Promise<void> => {
                    if (agentId) await refreshSessionsForAgent(agentId)
                    selectSession(restoredSessionId, true)
                })()
                return
            }
            void reloadSessionMessages()
        },
        [agentId, refreshSessionsForAgent, reloadSessionMessages, selectSession]
    )

    const createSession = useCallback(
        async (selectCreated = true): Promise<string | null> => {
            if (!agentId) return null
            try {
                const created = await client.chat.createSession(agentId, {})
                if (selectCreated) {
                    resetConversationState()
                    selectSession(created.id, true)
                }
                await refreshSessionsForAgent(agentId)
                return created.id
            } catch (err) {
                setError(apiErrorMessage(err))
                return null
            }
        },
        [
            agentId,
            client,
            refreshSessionsForAgent,
            resetConversationState,
            selectSession
        ]
    )

    const cleanupEmptySession = useCallback(
        async (candidate: CleanupCandidate): Promise<void> => {
            if (
                !candidate.agentId ||
                !candidate.sessionId ||
                !candidate.isEmpty
            )
                return
            if (sendInFlightRef.current) return
            const cleanupKey = `${candidate.agentId}:${candidate.sessionId}`
            if (
                cleanupInFlightRef.current.has(cleanupKey) ||
                cleanupIgnoredRef.current.has(cleanupKey)
            )
                return
            cleanupInFlightRef.current.add(cleanupKey)

            try {
                await client.chat.deleteSession(
                    candidate.agentId,
                    candidate.sessionId
                )
                await refreshSessionsForAgent(candidate.agentId)
            } catch (err) {
                const status = getHttpStatus(err)
                if (status === 404 || status === 409) {
                    cleanupIgnoredRef.current.add(cleanupKey)
                    return
                }
            } finally {
                cleanupInFlightRef.current.delete(cleanupKey)
            }
        },
        [client, refreshSessionsForAgent]
    )

    useEffect(() => {
        const previous = cleanupCandidateRef.current
        cleanupCandidateRef.current = {
            agentId: agentId ?? null,
            sessionId: activeSessionId,
            isEmpty:
                activeSessionId !== null &&
                loadedMessagesSessionId === activeSessionId &&
                !messagesLoading &&
                messages.length === 0
        }
        void cleanupEmptySession(previous)
    }, [
        activeSessionId,
        agentId,
        cleanupEmptySession,
        loadedMessagesSessionId,
        messages.length,
        messagesLoading
    ])

    useEffect(
        () => () => {
            void cleanupEmptySession(cleanupCandidateRef.current)
        },
        [cleanupEmptySession]
    )

    const handleSend = async (
        text: string,
        attachments: ComposerSendAttachment[],
        contextRefs: ComposerContextRef[],
        helpers: ComposerSendHelpers
    ): Promise<void> => {
        if (!agentId || sendInFlightRef.current) return
        sendInFlightRef.current = true
        setIsSubmitting(true)
        setError(null)
        let pendingStreamKey: string | null = null
        try {
            const sessionId =
                activeSessionId ??
                (isDraft
                    ? await createSession(false)
                    : (sessions[0]?.id ?? (await createSession(false))))
            if (!sessionId)
                throw new Error(t('web.chat.failedToCreateSession'))
            if (
                attachments.length + contextRefs.length >
                CHAT_ATTACHMENT_MAX_COUNT
            )
                throw new Error(
                    t('web.composer.attachmentLimit', {
                        max: CHAT_ATTACHMENT_MAX_COUNT
                    })
                )

            const streamKey = chatStreamStore.keyOf(agentId, sessionId)
            const streamParams = {
                agentId,
                sessionId,
                baseUrl: import.meta.env.VITE_API_URL ?? '/api',
                getToken,
                onFallback: refreshMessagesFromServer
            }
            pendingStreamKey = streamKey
            chatStreamStore.markTurnPending(streamKey, streamParams)

            const usesChatUploads = currentAgentFramework === 'dify'
            const uploadedAttachments = usesChatUploads
                ? []
                : await uploadChatAttachments(
                      client,
                      agentId,
                      sessionId,
                      attachments,
                      helpers
                  )
            const uploadedFiles = usesChatUploads
                ? await uploadChatFiles(client, agentId, attachments, helpers)
                : []

            const selectedModel =
                modelSwitchingSupported &&
                !frameworkModelConfigSupported &&
                modelOverride
                    ? modelOverride
                    : null
            // For runtime-local the draft carries the picked model and the
            // tuning knobs. The server reads both out of it but never forwards
            // it to the adapter, where a set modelConfig would mean "inject
            // platform credentials".
            const selectedModelConfig = !frameworkModelConfigSupported
                ? null
                : modelConfigSourceDraft === 'platform'
                  ? normalizedModelConfigDraft
                  : modelConfigDraft
            const body = {
                ...(text ? { text } : {}),
                ...(uploadedAttachments.length > 0
                    ? { attachments: uploadedAttachments }
                    : {}),
                ...(uploadedFiles.length > 0
                    ? { uploads: uploadedFiles }
                    : {}),
                ...(contextRefs.length > 0
                    ? { contextRefs: contextRefsForRequest(contextRefs) }
                    : {}),
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(frameworkModelConfigSupported
                    ? {
                          modelConfigSource: modelConfigSourceDraft,
                          saveAsDefault: true
                      }
                    : {}),
                ...(selectedModelConfig
                    ? {
                          modelConfig: selectedModelConfig
                      }
                    : {}),
                ...(currentAgentFramework === 'claude-code'
                    ? { claudeCodePermissionMode }
                    : {}),
                ...(currentAgentFramework === 'codex'
                    ? { codexPermissionMode }
                    : {}),
                ...(currentAgentFramework === 'hermes'
                    ? { hermesPermissionMode }
                    : {})
            }
            const result = await client.chat.sendMessage(
                agentId,
                sessionId,
                body
            )
            if (activeSessionId !== sessionId) selectSession(sessionId, true)
            setComposerContextRefs([])
            setMessages((prev) => mergeMessagesById(prev, [result.userMessage]))
            requestMessageScroll(CHAT_SCROLL_BOTTOM)
            chatStreamStore.beginAssistantTurn(
                streamKey,
                streamParams,
                result.assistantMessageId
            )
            publishStreamEvent({
                type: 'turn-begin',
                agentId,
                sessionId,
                assistantMessageId: result.assistantMessageId
            })
            if (frameworkModelConfigSupported && effectiveModelConfigView) {
                const nextView: AgentModelConfigView = {
                    ...effectiveModelConfigView,
                    source: modelConfigSourceDraft,
                    config:
                        selectedModelConfig ??
                        effectiveModelConfigView.config
                }
                writeCachedModelConfigView(nextView)
                applyModelConfigView(nextView)
            }
            void refreshSessionsForAgent(agentId)
            if (frameworkModelConfigSupported) void refreshAgents()
        } catch (err) {
            // The turn never got an assistant message id, so nothing will ever
            // arrive on the stream to clear it: undo the optimistic pending
            // state instead of locking the composer behind a phantom turn.
            if (pendingStreamKey)
                chatStreamStore.abandonPendingTurn(pendingStreamKey)
            const newAgent = currentAgent
            const conflict = newAgent
                ? buildQuotaConflictRequest({
                      err,
                      newAgent: { id: newAgent.id, name: newAgent.name },
                      candidates: agents,
                      retry: async () => {
                          await handleSend(
                              text,
                              attachments,
                              contextRefs,
                              helpers
                          )
                      }
                  })
                : null
            if (conflict) {
                requestQuotaConflict(conflict)
                return
            }
            setError(apiErrorMessage(err))
            throw err
        } finally {
            sendInFlightRef.current = false
            setIsSubmitting(false)
        }
    }

    const handleRegenerateUserMessage = async (
        message: ChatMessage,
        text: string
    ): Promise<void> => {
        if (
            !agentId ||
            !activeSessionId ||
            currentAgentFramework !== 'codex' ||
            sendInFlightRef.current ||
            stream.streamingAssistantId
        )
            return
        sendInFlightRef.current = true
        setIsSubmitting(true)
        setError(null)
        const streamKey = chatStreamStore.keyOf(agentId, activeSessionId)
        try {
            const streamParams = {
                agentId,
                sessionId: activeSessionId,
                baseUrl: import.meta.env.VITE_API_URL ?? '/api',
                getToken,
                onFallback: refreshMessagesFromServer
            }
            chatStreamStore.markTurnPending(streamKey, streamParams)

            const selectedModel =
                modelSwitchingSupported &&
                !frameworkModelConfigSupported &&
                modelOverride
                    ? modelOverride
                    : null
            // For runtime-local the draft carries the picked model and the
            // tuning knobs. The server reads both out of it but never forwards
            // it to the adapter, where a set modelConfig would mean "inject
            // platform credentials".
            const selectedModelConfig = !frameworkModelConfigSupported
                ? null
                : modelConfigSourceDraft === 'platform'
                  ? normalizedModelConfigDraft
                  : modelConfigDraft
            const body = {
                ...(text ? { text } : {}),
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(frameworkModelConfigSupported
                    ? {
                          modelConfigSource: modelConfigSourceDraft,
                          saveAsDefault: true
                      }
                    : {}),
                ...(selectedModelConfig
                    ? {
                          modelConfig: selectedModelConfig
                      }
                    : {}),
                codexPermissionMode
            }
            const result = await client.chat.regenerateMessage(
                agentId,
                activeSessionId,
                message.id,
                body
            )
            setMessages((prev) =>
                applyRegeneratedUserMessage(
                    prev,
                    message.id,
                    result.userMessage,
                    result.deletedMessageIds
                )
            )
            requestMessageScroll(CHAT_SCROLL_BOTTOM)
            chatStreamStore.beginAssistantTurn(
                streamKey,
                streamParams,
                result.assistantMessageId
            )
            publishStreamEvent({
                type: 'turn-begin',
                agentId,
                sessionId: activeSessionId,
                assistantMessageId: result.assistantMessageId
            })
            if (frameworkModelConfigSupported && effectiveModelConfigView) {
                const nextView: AgentModelConfigView = {
                    ...effectiveModelConfigView,
                    source: modelConfigSourceDraft,
                    config:
                        selectedModelConfig ??
                        effectiveModelConfigView.config
                }
                writeCachedModelConfigView(nextView)
                applyModelConfigView(nextView)
            }
            void refreshSessionsForAgent(agentId)
            if (frameworkModelConfigSupported) void refreshAgents()
        } catch (err) {
            chatStreamStore.abandonPendingTurn(streamKey)
            setError(apiErrorMessage(err))
            throw err
        } finally {
            sendInFlightRef.current = false
            setIsSubmitting(false)
        }
    }

    // Optimistic then reconciled: the stop button has to feel instant, but only
    // an accepted cancel writes the durable request the turn converges on, so a
    // rejected POST must hand the turn back rather than leave it 'cancelling'.
    const handleStop = (): void => {
        if (!agentId || !activeSessionId) {
            stream.stop()
            return
        }
        const sessionId = activeSessionId
        const streamKey = chatStreamStore.keyOf(agentId, sessionId)
        const assistantMessageId = stream.streamingAssistantId
        if (!assistantMessageId) return
        const cancelAttempt = stream.stop()
        if (!cancelAttempt) return
        void (async (): Promise<void> => {
            try {
                await client.chat.cancelStream(
                    agentId,
                    sessionId,
                    assistantMessageId
                )
                const accepted = chatStreamStore.cancelRequestSucceeded(
                    streamKey,
                    cancelAttempt
                )
                if (accepted)
                    publishStreamEvent({
                        type: 'cancel',
                        agentId,
                        sessionId,
                        assistantMessageId
                    })
            } catch (err) {
                if (
                    chatStreamStore.cancelRequestFailed(
                        streamKey,
                        cancelAttempt
                    )
                )
                    setError(apiErrorMessage(err))
            }
        })()
    }

    const handleCodexPermissionModeChange = useCallback(
        (mode: CodexPermissionMode): void => {
            setCodexPermissionMode(mode)
            if (agentId) writeStoredCodexPermissionMode(agentId, mode)
        },
        [agentId]
    )

    const handleClaudeCodePermissionModeChange = useCallback(
        (mode: ClaudeCodePermissionMode): void => {
            setClaudeCodePermissionMode(mode)
            if (agentId) writeStoredClaudeCodePermissionMode(agentId, mode)
        },
        [agentId]
    )

    const handleHermesPermissionModeChange = useCallback(
        (mode: HermesPermissionMode): void => {
            setHermesPermissionMode(mode)
            if (agentId) writeStoredHermesPermissionMode(agentId, mode)
        },
        [agentId]
    )

    // Answers a pending hermes permission card on the LIVE turn. The card
    // lives in the streaming bubble, so the target message is always the
    // stream's assistant id.
    const handleAnswerPermission = useCallback(
        async (requestId: string, optionId: string): Promise<void> => {
            const sessionId = activeSessionIdRef.current
            const messageId = stream.streamingAssistantId
            if (!agentId || !sessionId || !messageId)
                throw new Error('the turn is no longer active')
            await client.chat.answerPermission(
                agentId,
                sessionId,
                messageId,
                requestId,
                { optionId }
            )
        },
        [agentId, client, stream.streamingAssistantId]
    )

    const workspaceToolsAvailable = currentAgent?.runtime !== 'external'

    const handleMessageLinkClick = useCallback<MarkdownLinkClickHandler>(
        (href) => {
            if (!currentAgent || !workspaceToolsAvailable) return false
            const target = resolveWorkspaceFileLink(href, {
                mountPath: currentAgent.mountPath,
                workspacePath: currentAgent.workspacePath
            })
            if (!target) return false

            filePreviewRequestIdRef.current += 1
            setRuntimeSessionViewerOpen(false)
            setFilesVisible(true)
            setFilePreviewVisible(true)
            setFilePreviewRequest({
                id: filePreviewRequestIdRef.current,
                ...target
            })
            return true
        },
        [currentAgent, workspaceToolsAvailable]
    )

    const continueAfterGrant = useCallback(
        (text: string): void => {
            const trimmed = text.trim()
            if (!trimmed || !agentId || !activeSessionId) return
            if (sendInFlightRef.current) return
            const sessionId = activeSessionId
            const streamKey = chatStreamStore.keyOf(agentId, sessionId)
            void (async (): Promise<void> => {
                sendInFlightRef.current = true
                setIsSubmitting(true)
                setError(null)
                try {
                    const streamParams = {
                        agentId,
                        sessionId,
                        baseUrl: import.meta.env.VITE_API_URL ?? '/api',
                        getToken,
                        onFallback: refreshMessagesFromServer
                    }
                    chatStreamStore.markTurnPending(streamKey, streamParams)
                    const body = {
                        text: trimmed,
                        ...(currentAgentFramework === 'claude-code'
                            ? { claudeCodePermissionMode }
                            : {}),
                        ...(currentAgentFramework === 'codex'
                            ? { codexPermissionMode }
                            : {})
                    }
                    const result = await client.chat.sendMessage(
                        agentId,
                        sessionId,
                        body
                    )
                    setMessages((prev) =>
                        mergeMessagesById(prev, [result.userMessage])
                    )
                    requestMessageScroll(CHAT_SCROLL_BOTTOM)
                    chatStreamStore.beginAssistantTurn(
                        streamKey,
                        streamParams,
                        result.assistantMessageId
                    )
                    publishStreamEvent({
                        type: 'turn-begin',
                        agentId,
                        sessionId,
                        assistantMessageId: result.assistantMessageId
                    })
                    void refreshSessionsForAgent(agentId)
                } catch (err) {
                    chatStreamStore.abandonPendingTurn(streamKey)
                    setError(apiErrorMessage(err))
                } finally {
                    sendInFlightRef.current = false
                    setIsSubmitting(false)
                }
            })()
        },
        [
            activeSessionId,
            agentId,
            claudeCodePermissionMode,
            client,
            codexPermissionMode,
            currentAgentFramework,
            getToken,
            refreshMessagesFromServer,
            refreshSessionsForAgent,
            requestMessageScroll
        ]
    )

    const chatGrantActions = useMemo(
        () => ({ continueAfterGrant }),
        [continueAfterGrant]
    )

    useEffect(() => {
        setRuntimeSessionViewerOpen(false)
    }, [agentId, activeSessionId])

    const toggleFilesVisible = useCallback((): void => {
        if (!workspaceToolsAvailable) return
        setRuntimeSessionViewerOpen(false)
        setFilesVisible((value) => !value)
    }, [workspaceToolsAvailable])

    const toggleFilePreviewVisible = useCallback((): void => {
        if (!workspaceToolsAvailable) return
        if (!filePreviewAvailable) return
        setRuntimeSessionViewerOpen(false)
        setFilePreviewVisible((value) => !value)
    }, [filePreviewAvailable, workspaceToolsAvailable])

    const startRuntimeSessionPanelResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (event.button !== 0) return
            event.preventDefault()
            const startX = event.clientX
            const startWidth = runtimeSessionPanelWidth
            const previousCursor = document.body.style.cursor
            const previousUserSelect = document.body.style.userSelect
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'

            const onMove = (moveEvent: PointerEvent): void => {
                const dx = moveEvent.clientX - startX
                setRuntimeSessionPanelWidth(
                    clamp(
                        startWidth - dx,
                        MIN_RUNTIME_SESSION_PANEL_WIDTH,
                        MAX_RUNTIME_SESSION_PANEL_WIDTH
                    )
                )
            }

            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                document.body.style.cursor = previousCursor
                document.body.style.userSelect = previousUserSelect
            }

            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
            window.addEventListener('pointercancel', onUp)
        },
        [runtimeSessionPanelWidth]
    )

    useEffect(() => {
        setFilePreviewAvailable(false)
        setFilePreviewVisible(false)
        setFilePreviewRequest(null)
        setWorkspaceRefreshing(false)
    }, [agentId])

    useEffect(() => {
        if (!workspaceToolsAvailable) setFilesVisible(false)
    }, [workspaceToolsAvailable])

    const handleDraftAgentSelect = useCallback(
        (nextAgentId: string): void => {
            if (nextAgentId === agentId) return
            const next = new URLSearchParams(searchParams)
            next.delete('sessionId')
            next.set('draft', DRAFT_SEARCH_VALUE)
            navigate(`/agents/${nextAgentId}/chat?${next.toString()}`)
        },
        [agentId, navigate, searchParams]
    )

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.repeat) return

            if (
                matchesKeyboardShortcut(event, {
                    code: 'KeyE',
                    meta: true,
                    shift: true
                })
            ) {
                event.preventDefault()
                toggleFilesVisible()
                return
            }

            if (
                matchesKeyboardShortcut(event, {
                    alt: true,
                    code: 'KeyB',
                    meta: true
                })
            ) {
                event.preventDefault()
                toggleFilePreviewVisible()
            }
        }

        document.addEventListener('keydown', handleKeyDown, true)

        return () => {
            document.removeEventListener('keydown', handleKeyDown, true)
        }
    }, [toggleFilePreviewVisible, toggleFilesVisible])

    const isStreaming = isLiveStreamStatus(stream.status)
    const isCancelling = stream.status === 'cancelling'
    const [cancelRetryOffered, setCancelRetryOffered] = useState(false)
    useEffect(() => {
        if (!isCancelling) {
            setCancelRetryOffered(false)
            return
        }
        const timer = setTimeout(
            () => setCancelRetryOffered(true),
            CANCEL_RETRY_AFTER_MS
        )
        return () => clearTimeout(timer)
    }, [isCancelling])
    const modelConfigBlocked =
        frameworkModelConfigSupported &&
        (modelConfigLoading || !modelConfigValidation.valid)
    const interactionDisabled = disabled || isSubmitting || modelConfigBlocked
    const stopAvailable =
        stream.streamingAssistantId !== null &&
        (!isCancelling || cancelRetryOffered)
    const composerHint = disabled
        ? (chatAvailability.reason ?? undefined)
        : modelConfigLoading
          ? t('web.chat.loadingModelOptions')
          : modelConfigBlocked
            ? (modelConfigValidation.message ?? t('web.composer.chooseModel'))
            : isSubmitting
              ? t('web.chat.savingDraftAndSending')
              : isCancelling
                ? t('web.chat.stoppingResponse')
                : isStreaming
                  ? t('web.chat.streamingEsc')
                  : undefined
    const softLimitHit =
        !messagesHasMore && messages.length >= CHAT_MESSAGE_SOFT_LIMIT
    const showEmptyState =
        !messagesLoading &&
        messages.length === 0 &&
        stream.streamingAssistantId === null &&
        stream.streamErrors.length === 0

    useEffect(() => {
        const node = composerDockRef.current
        if (!node || typeof ResizeObserver === 'undefined') {
            setComposerDockHeight(0)
            return
        }
        const measure = (): void =>
            setComposerDockHeight(node.getBoundingClientRect().height)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
    }, [showEmptyState])
    const runtimeSignInVisible =
        frameworkModelConfigSupported &&
        shouldShowRuntimeSignIn(effectiveModelConfigView)
    const showTopNotices =
        !chatAvailability.ready ||
        softLimitHit ||
        Boolean(error) ||
        runtimeSignInVisible
    const shouldMountWorkspaceFiles =
        workspaceToolsAvailable &&
        !runtimeSessionViewerOpen &&
        (filesVisible ||
            filePreviewVisible ||
            filePreviewAvailable ||
            Boolean(filePreviewRequest))

    if (agentsLoading && !currentAgent) {
        return (
            <div className='flex h-full min-h-0 flex-col' aria-busy='true'>
                <div className='border-divider/60 flex shrink-0 items-center gap-3 border-b px-5 py-3.5'>
                    <Ghost variant='circle' className='h-7 w-7 shrink-0' />
                    <Ghost variant='line' className='w-40 max-w-full' />
                </div>
                <div className='min-h-0 flex-1 overflow-hidden px-5 py-6 md:px-6'>
                    <div className='mx-auto flex max-w-3xl flex-col gap-7'>
                        <div className='flex flex-col items-end gap-2'>
                            <Ghost variant='cap' className='w-2/5' />
                        </div>
                        <div className='flex flex-col gap-2'>
                            <Ghost variant='cap' className='w-11/12' />
                            <Ghost variant='cap' className='w-4/5' />
                            <Ghost variant='cap' className='w-3/5' />
                        </div>
                    </div>
                </div>
                <div className='shrink-0 px-4 pb-4 pt-3'>
                    <Ghost
                        variant='block'
                        className='mx-auto h-[92px] max-w-3xl rounded-[18px]'
                    />
                </div>
            </div>
        )
    }

    if (!currentAgent) {
        // No agents at all is first-use, not a not-found — send the user to the
        // workspace home, which owns the onboarding guidance (§10.7).
        if (agents.length === 0) return <Navigate to='/' replace />
        // Agents exist but this id/selection isn't one of them: a genuine
        // not-found. Flat empty state per §10.7 — no raised card, no kicker.
        return (
            <div className='flex h-full items-center justify-center px-5'>
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.emptyState.agentNotFoundTitle')}
                    body={t('web.emptyState.agentNotFoundBody')}
                />
            </div>
        )
    }

    const renderComposer = (variant: 'dock' | 'inline'): ReactNode => (
        <Composer
            dropTargetRef={chatWindowRef}
            onComposeIntent={handleComposeIntent}
            disabled={interactionDisabled}
            streaming={isStreaming}
            onSend={handleSend}
            onStop={stopAvailable ? handleStop : undefined}
            hint={composerHint}
            agentName={currentAgent.name}
            framework={currentAgent.framework}
            runtime={currentAgent.runtime}
            status={currentAgent.status}
            model={currentAgent.model}
            modelOverride={modelSwitchingSupported ? modelOverride : null}
            modelOptions={modelOptions}
            modelPickerDisabled={isSubmitting}
            onModelOverrideChange={
                modelSwitchingSupported && !frameworkModelConfigSupported
                    ? handleModelOverrideChange
                    : undefined
            }
            modelConfigView={
                frameworkModelConfigSupported ? effectiveModelConfigView : null
            }
            modelConfigDraft={
                frameworkModelConfigSupported
                    ? normalizedModelConfigDraft
                    : null
            }
            modelConfigRefreshing={modelConfigRefreshing}
            claudeCodePermissionMode={claudeCodePermissionMode}
            onClaudeCodePermissionModeChange={
                currentAgent.framework === 'claude-code'
                    ? handleClaudeCodePermissionModeChange
                    : undefined
            }
            codexPermissionMode={codexPermissionMode}
            onCodexPermissionModeChange={
                currentAgent.framework === 'codex'
                    ? handleCodexPermissionModeChange
                    : undefined
            }
            hermesPermissionMode={hermesPermissionMode}
            onHermesPermissionModeChange={
                currentAgent.framework === 'hermes'
                    ? handleHermesPermissionModeChange
                    : undefined
            }
            onModelConfigDraftChange={
                frameworkModelConfigSupported ? setModelConfigDraft : undefined
            }
            modelConfigSource={modelConfigSourceDraft}
            onModelConfigSourceChange={
                frameworkModelConfigSupported
                    ? setModelConfigSourceDraft
                    : undefined
            }
            onRefreshModelConfig={
                frameworkModelConfigSupported
                    ? handleRefreshModelConfig
                    : undefined
            }
            onOpenModelSettings={
                frameworkModelConfigSupported && agentId
                    ? () => publishAgentCredentialsOpen(agentId)
                    : undefined
            }
            variant={variant}
            showAgentSwitcher={showAgentPicker}
            agentOptions={agentOptions}
            selectedAgentId={agentId ?? null}
            onSelectAgent={handleDraftAgentSelect}
            attachmentsEnabled={capabilities.attachments}
            contextRefs={composerContextRefs}
            draftKey={draftKey}
            onRemoveContextRef={handleRemoveComposerContextRef}
        />
    )

    return (
        <div className='chat-workspace-shell flex h-full min-h-0 flex-col overflow-hidden'>
            <AgentChatHeader
                agent={currentAgent}
                filesVisible={filesVisible}
                previewAvailable={filePreviewAvailable}
                previewVisible={filePreviewVisible}
                refreshing={workspaceRefreshing}
                runtimeSessionViewerEnabled={
                    currentAgent.runtime !== 'external'
                }
                runtimeSessionViewerOpen={runtimeSessionViewerOpen}
                onOpenMobileMenu={openMobileSidebar}
                onToggleRuntimeSessionViewer={() =>
                    setRuntimeSessionViewerOpen((value) => {
                        const next = !value
                        if (next) {
                            setFilesVisible(false)
                            setFilePreviewVisible(false)
                        }
                        return next
                    })
                }
                onOpenTerminal={() => openTerminalForAgent(currentAgent)}
                onShare={
                    shareableSession
                        ? () => setShareSessionOpen(true)
                        : null
                }
                onRefresh={handleRefreshWorkspace}
                onToggleFiles={toggleFilesVisible}
                onTogglePreview={toggleFilePreviewVisible}
                onToggleBackgroundTasks={toggleBackgroundTasks}
                backgroundTasksOpen={bgTasksVisible}
            />
            {shareSessionOpen && shareableSession && (
                <ShareChatSessionDialog
                    agentId={currentAgent.id}
                    sessionId={shareableSession.id}
                    title={shareableSession.title}
                    onClose={() => setShareSessionOpen(false)}
                />
            )}
            <div className='flex min-h-0 flex-1 overflow-hidden'>
                <div className='flex min-w-0 flex-1 flex-col overflow-hidden overscroll-none'>
                    {showTopNotices && (
                        <div className='mx-auto w-full max-w-3xl shrink-0 px-5 pt-3 md:px-6'>
                            <div className='flex flex-col gap-3'>
                                {!chatAvailability.ready &&
                                    chatAvailability.reason && (
                                        <div className='workbench-alert-error'>
                                            {chatAvailability.reason}
                                        </div>
                                    )}
                                {softLimitHit && (
                                    <div className='text-caption text-muted shadow-ring-light bg-surface/85 rounded-md px-3.5 py-2.5'>
                                        {t('web.chat.sessionMessageLimit', {
                                            count: messages.length
                                        })}
                                    </div>
                                )}
                                {error && (
                                    <div className='workbench-alert-error'>
                                        {error}
                                    </div>
                                )}
                                {runtimeSignInVisible &&
                                    effectiveModelConfigView && (
                                        <RuntimeLocalSignInCard
                                            view={effectiveModelConfigView}
                                            refreshing={modelConfigRefreshing}
                                            onRefresh={() =>
                                                void handleRefreshModelConfig(
                                                    'runtime-local'
                                                ).catch(() => {})
                                            }
                                            onOpenTerminal={() =>
                                                currentAgent &&
                                                openTerminalForAgent(
                                                    currentAgent
                                                )
                                            }
                                        />
                                    )}
                            </div>
                        </div>
                    )}

                    <div
                        ref={chatWindowRef}
                        className='relative flex min-h-0 flex-1 flex-col overflow-hidden'
                    >
                        {messagesLoading ? (
                            <div
                                aria-busy='true'
                                className='min-h-0 flex-1 overflow-auto px-5 py-6 md:px-6'
                            >
                                <div className='mx-auto flex max-w-3xl flex-col gap-7'>
                                    <div className='flex flex-col items-end gap-2'>
                                        <Ghost
                                            variant='cap'
                                            className='w-2/5'
                                        />
                                        <Ghost
                                            variant='cap'
                                            className='w-1/4'
                                        />
                                    </div>
                                    <div className='flex flex-col gap-2'>
                                        <Ghost
                                            variant='cap'
                                            className='w-11/12'
                                        />
                                        <Ghost
                                            variant='cap'
                                            className='w-4/5'
                                        />
                                        <Ghost
                                            variant='cap'
                                            className='w-3/5'
                                        />
                                    </div>
                                    <div className='flex flex-col items-end gap-2'>
                                        <Ghost
                                            variant='cap'
                                            className='w-1/3'
                                        />
                                    </div>
                                    <div className='flex flex-col gap-2'>
                                        <Ghost
                                            variant='cap'
                                            className='w-5/6'
                                        />
                                        <Ghost
                                            variant='cap'
                                            className='w-2/3'
                                        />
                                    </div>
                                </div>
                            </div>
                        ) : showEmptyState ? null : (
                            <Suspense
                                fallback={
                                    <div className='flex min-h-0 flex-1 items-center justify-center overflow-auto px-5 py-6 md:px-6'>
                                        <div className='workbench-panel text-ui text-muted px-5 py-4'>
                                            {t('web.chat.loadingConversation')}
                                        </div>
                                    </div>
                                }
                            >
                                <ChatGrantProvider value={chatGrantActions}>
                                    <MessageList
                                        onLinkClick={handleMessageLinkClick}
                                        bottomInset={composerDockHeight}
                                        messages={messages}
                                        streamingAssistantId={
                                            stream.streamingAssistantId
                                        }
                                        streamingBlocks={
                                            stream.streamingBlocks
                                        }
                                        streamStatus={stream.status}
                                        streamStartedAt={
                                            stream.streamStartedAt
                                        }
                                        streamStalled={stream.stalled}
                                        streamRecoveryPhase={
                                            stream.recoveryPhase
                                        }
                                        streamErrors={stream.streamErrors}
                                        capabilities={capabilities}
                                        framework={currentAgent.framework}
                                        hasMore={messagesHasMore}
                                        loadingOlder={olderMessagesLoading}
                                        scrollAction={messageScrollAction}
                                        scrollScopeKey={scrollScopeKey}
                                        onCapturePosition={
                                            rememberMessageScroll
                                        }
                                        onLoadOlder={loadOlderMessages}
                                        editingDisabled={
                                            interactionDisabled || isStreaming
                                        }
                                        onRegenerateUserMessage={
                                            currentAgent.framework === 'codex'
                                                ? handleRegenerateUserMessage
                                                : undefined
                                        }
                                        onAnswerPermission={
                                            currentAgent.framework === 'hermes'
                                                ? handleAnswerPermission
                                                : undefined
                                        }
                                    />
                                </ChatGrantProvider>
                            </Suspense>
                        )}
                        {/* One mount point for both states: moving the composer
                            between the centered new-chat stage and the docked
                            conversation would remount it, and a remount re-seeds
                            the input from the stored draft (the message you just
                            sent reappears) and drops pending attachments. */}
                        <div
                            className={
                                showEmptyState
                                    ? 'chat-composer-stage'
                                    : 'chat-composer-overlay'
                            }
                        >
                            <div className='w-full'>
                                {showEmptyState && (
                                    <div className='mx-auto mb-7 max-w-3xl text-center'>
                                        <h2 className='text-display text-fg tracking-tight'>
                                            {t('web.chat.whatNext', {
                                                name: currentAgent.name
                                            })}
                                        </h2>
                                    </div>
                                )}
                                <div ref={composerDockRef}>
                                    {renderComposer(
                                        showEmptyState ? 'inline' : 'dock'
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                {runtimeSessionViewerOpen && agentId && (
                    <RuntimeSessionResizeHandle
                        label={t('web.chat.header.resizeRuntimeViewer')}
                        onPointerDown={startRuntimeSessionPanelResize}
                    />
                )}
                {runtimeSessionViewerOpen && agentId && (
                    <Suspense
                        fallback={
                            <aside
                                className='border-divider/80 bg-surface order-3 flex min-h-0 w-full flex-1 flex-col border-t lg:order-none lg:w-[var(--runtime-session-panel-width)] lg:flex-none lg:shrink-0 lg:border-l lg:border-t-0'
                                style={
                                    {
                                        '--runtime-session-panel-width': `${runtimeSessionPanelWidth}px`
                                    } as CSSProperties
                                }
                            >
                                <div className='text-ui text-muted flex h-full items-center justify-center px-6 text-center'>
                                    {t('web.chat.loadingRuntimeViewer')}
                                </div>
                            </aside>
                        }
                    >
                        <RuntimeSessionViewer
                            agentId={agentId}
                            sessionId={activeSessionId}
                            width={runtimeSessionPanelWidth}
                            onClose={handleRuntimeViewerClose}
                            onApplied={handleRuntimeViewerApplied}
                        />
                    </Suspense>
                )}
                {shouldMountWorkspaceFiles && (
                    <Suspense fallback={null}>
                        <WorkspaceFiles
                            key={currentAgent.id}
                            agent={currentAgent}
                            onAttachContext={handleAttachWorkspaceContext}
                            onOpenTerminal={handleOpenWorkspaceTerminal}
                            onPreviewAvailableChange={setFilePreviewAvailable}
                            onPreviewRequestHandled={(requestId) => {
                                setFilePreviewRequest((request) =>
                                    request?.id === requestId ? null : request
                                )
                            }}
                            onPreviewVisibleChange={setFilePreviewVisible}
                            previewRequest={filePreviewRequest}
                            previewVisible={filePreviewVisible}
                            refreshKey={workspaceRefreshKey}
                            visible={filesVisible}
                        />
                    </Suspense>
                )}
            </div>

        </div>
    )
}

interface AgentChatHeaderProps {
    agent: SdkAgent
    filesVisible: boolean
    previewAvailable: boolean
    previewVisible: boolean
    refreshing: boolean
    runtimeSessionViewerEnabled: boolean
    runtimeSessionViewerOpen: boolean
    onOpenMobileMenu: () => void
    onToggleRuntimeSessionViewer: () => void
    onOpenTerminal: () => void
    onShare: (() => void) | null
    onRefresh: () => void
    onToggleFiles: () => void
    onTogglePreview: () => void
    onToggleBackgroundTasks: () => void
    backgroundTasksOpen: boolean
}

const AgentChatHeader: FC<AgentChatHeaderProps> = ({
    agent,
    filesVisible,
    previewAvailable,
    previewVisible,
    refreshing,
    runtimeSessionViewerEnabled,
    runtimeSessionViewerOpen,
    onOpenMobileMenu,
    onToggleRuntimeSessionViewer,
    onOpenTerminal,
    onShare,
    onRefresh,
    onToggleFiles,
    onTogglePreview,
    onToggleBackgroundTasks,
    backgroundTasksOpen
}): ReactNode => {
    const { t } = useI18n()
    const navigate = useNavigate()
    const workspacePath = workspacePathOf(agent)
    const workspaceDirName = workspaceDirNameOf(agent)
    const actionButtonClass = (active = false): string =>
        [
            'shadow-ring-light h-9 w-9 shrink-0 items-center justify-center rounded-pill transition-colors disabled:cursor-not-allowed disabled:opacity-45',
            active
                ? 'bg-surface-hover text-fg hover:bg-soft-hover'
                : 'bg-surface text-muted hover:bg-surface-hover'
        ].join(' ')
    const FileToggleIcon = filesVisible ? FolderOpenIcon : FolderIcon
    const previewOpen = previewAvailable && previewVisible
    const filesLabel = filesVisible
        ? t('web.chat.header.hideFileTree')
        : t('web.chat.header.showFileTree')
    const previewLabel = previewOpen
        ? t('web.chat.header.hideFilePreview')
        : t('web.chat.header.showFilePreview')
    const runtimeSessionLabel = runtimeSessionViewerOpen
        ? t('web.chat.header.hideRuntimeViewer')
        : t('web.chat.header.runtimeViewer')

    return (
        <header className='bg-main relative z-[80] flex h-14 shrink-0 items-center justify-between gap-3 px-4 md:px-5'>
            <div className='flex min-w-0 items-center gap-3'>
                <ShortcutTooltip
                    label={t('web.chat.header.openMenu')}
                    placement='bottom-start'
                    shortcut='Cmd+B'
                >
                    <button
                        type='button'
                        className={`${actionButtonClass()} inline-flex md:hidden`}
                        aria-label={t('web.chat.header.openMenu')}
                        onClick={onOpenMobileMenu}
                    >
                        <MenuIcon className='h-4 w-4' />
                    </button>
                </ShortcutTooltip>
                {/* The identity block is a door, not a menu: in a chat
                    product the header's subject is how you reach that subject's
                    own page (Telegram, WhatsApp, Slack all read this way), and
                    the trip is cheap and reversible — Back to chat restores
                    the conversation's draft and, since #725, the reading
                    position it was left at. Actions live on the rail row's `…`
                    and inside the area, so the avatar does not impersonate an
                    overflow menu. No chevron: per DESIGN.md that glyph
                    promises a list, and this navigates. */}
                <ShortcutTooltip
                    label={t('web.shell.agentSettings')}
                    placement='bottom-start'
                    className='min-w-0'
                >
                    <Link
                        to={agentSettingsPath(agent.id)}
                        onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                            // Let modified clicks open a tab the browser's way.
                            if (
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                            )
                                return
                            event.preventDefault()
                            navigateWithRailTransition(
                                navigate,
                                agentSettingsPath(agent.id),
                                'forward'
                            )
                        }}
                        className='hover:bg-soft flex min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-1 transition-colors'
                    >
                        <span className='hidden shrink-0 sm:inline-flex'>
                            <FrameworkLogo
                                framework={agent.framework}
                                size={28}
                            />
                        </span>
                        <h1 className='text-ui text-fg min-w-0 truncate font-medium'>
                            {agent.name}
                        </h1>
                        <span className='text-caption text-muted hidden shrink-0 items-center gap-1.5 sm:inline-flex'>
                            <span
                                className={[
                                    'h-1.5 w-1.5 rounded-full',
                                    agentStatusDotClass(
                                        agent.status,
                                        agent.spriteStatus,
                                        agent.k8sPodPhase
                                    )
                                ].join(' ')}
                                aria-hidden='true'
                            />
                            {formatStatusLabel(
                                agentStatusDotLabel(
                                    agent.status,
                                    agent.spriteStatus,
                                    agent.k8sPodPhase
                                ),
                                t
                            )}
                        </span>
                    </Link>
                </ShortcutTooltip>
                {/* A sandbox path is plumbing — every agent's differs only by
                    an opaque id, and Terminal and Files already open inside it.
                    A daemon agent's directory is not plumbing but identity: it
                    answers which of your projects this agent acts on, with your
                    permissions, and it is a choice you can get wrong. Only that
                    case earns a permanent place, and only as the basename. */}
                {agent.runtime === 'daemon' && workspaceDirName ? (
                    <ShortcutTooltip
                        label={workspacePath}
                        placement='bottom-start'
                        className='hidden min-w-0 shrink sm:block'
                    >
                        <span className='text-caption text-muted bg-soft shadow-ring-light block max-w-[14rem] truncate rounded-sm px-2 py-0.5 font-mono'>
                            {workspaceDirName}
                        </span>
                    </ShortcutTooltip>
                ) : null}
            </div>

            <div className='flex shrink-0 items-center gap-1.5'>
                {onShare && (
                    <ShortcutTooltip
                        label={t('web.chat.header.share')}
                        placement='bottom-end'
                    >
                        <button
                            type='button'
                            className={`${actionButtonClass()} inline-flex`}
                            aria-label={t('web.chat.header.share')}
                            onClick={onShare}
                        >
                            <ShareIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                )}
                {agent.runtime !== 'external' && (
                    <ShortcutTooltip
                        label={t('web.chat.header.openTerminal')}
                        placement='bottom-end'
                        shortcut='Cmd+J'
                    >
                        <button
                            type='button'
                            className={`${actionButtonClass()} inline-flex`}
                            disabled={agent.status !== 'running'}
                            aria-label={t('web.chat.header.openTerminal')}
                            onClick={onOpenTerminal}
                        >
                            <TerminalIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                )}
                <ShortcutTooltip
                    label={t('web.chat.header.refresh')}
                    placement='bottom-end'
                >
                    <button
                        type='button'
                        className={`${actionButtonClass()} inline-flex`}
                        disabled={refreshing}
                        aria-label={t('web.chat.header.refresh')}
                        onClick={onRefresh}
                    >
                        <RefreshIcon
                            className={[
                                'h-4 w-4',
                                refreshing ? 'loading-spin' : ''
                            ].join(' ')}
                        />
                    </button>
                </ShortcutTooltip>
                {agent.runtime !== 'external' && (
                    <ShortcutTooltip
                        label={runtimeSessionLabel}
                        placement='bottom-end'
                    >
                        <button
                            type='button'
                            className={`${actionButtonClass(runtimeSessionViewerOpen)} inline-flex`}
                            disabled={!runtimeSessionViewerEnabled}
                            aria-label={runtimeSessionLabel}
                            aria-pressed={runtimeSessionViewerOpen}
                            onClick={onToggleRuntimeSessionViewer}
                        >
                            <HistoryIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                )}
                {agent.runtime !== 'external' && (
                    <ShortcutTooltip
                        label={filesLabel}
                        placement='bottom-end'
                        shortcut='Shift+Cmd+E'
                    >
                        <button
                            type='button'
                            className={`${actionButtonClass(filesVisible)} inline-flex`}
                            aria-label={filesLabel}
                            aria-expanded={filesVisible}
                            aria-pressed={filesVisible}
                            onClick={onToggleFiles}
                        >
                            <FileToggleIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                )}
                {agent.runtime !== 'external' && (
                    <ShortcutTooltip
                        label={previewLabel}
                        placement='bottom-end'
                        shortcut='Option+Cmd+B'
                    >
                        <button
                            type='button'
                            className={`${actionButtonClass(previewOpen)} inline-flex`}
                            disabled={!previewAvailable}
                            aria-label={previewLabel}
                            aria-expanded={previewOpen}
                            aria-pressed={previewOpen}
                            onClick={onTogglePreview}
                        >
                            <PreviewIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                )}
                <ShortcutTooltip
                    label={t('web.chat.header.backgroundTasks')}
                    placement='bottom-end'
                >
                    <button
                        type='button'
                        className={`${actionButtonClass(backgroundTasksOpen)} inline-flex`}
                        aria-label={t('web.chat.header.backgroundTasks')}
                        aria-pressed={backgroundTasksOpen}
                        onClick={onToggleBackgroundTasks}
                    >
                        <TasksIcon className='h-4 w-4' />
                    </button>
                </ShortcutTooltip>
            </div>
        </header>
    )
}

const RuntimeSessionResizeHandle: FC<{
    label: string
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}> = ({ label, onPointerDown }): ReactNode => (
    <div
        aria-label={label}
        aria-orientation='vertical'
        className='group hidden w-2 shrink-0 cursor-col-resize items-stretch justify-center lg:flex'
        role='separator'
        tabIndex={0}
        onPointerDown={onPointerDown}
    >
        <span className='group-hover:bg-placeholder group-focus-visible:bg-placeholder my-auto h-12 w-px rounded-full bg-transparent transition-colors' />
    </div>
)

export default AgentChat

const normalizeModelOverride = (value?: string | null): string | null => {
    const trimmed = value?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : null
}

const modelStorageKey = (agentId: string): string =>
    `${MODEL_OVERRIDE_STORAGE_PREFIX}${agentId}`

const claudeCodePermissionStorageKey = (agentId: string): string =>
    `${CLAUDE_CODE_PERMISSION_MODE_STORAGE_PREFIX}${agentId}`

const codexPermissionStorageKey = (agentId: string): string =>
    `${CODEX_PERMISSION_MODE_STORAGE_PREFIX}${agentId}`

const readStoredModelOverride = (
    agentId: string
): string | null | undefined => {
    try {
        const raw = window.localStorage.getItem(modelStorageKey(agentId))
        return raw === null ? undefined : normalizeModelOverride(raw)
    } catch {
        return undefined
    }
}

const writeStoredModelOverride = (
    agentId: string,
    model: string | null
): void => {
    try {
        window.localStorage.setItem(modelStorageKey(agentId), model ?? '')
    } catch {
        /* ignore local storage failures */
    }
}

const readStoredClaudeCodePermissionMode = (
    agentId: string
): ClaudeCodePermissionMode => {
    try {
        const raw = window.localStorage.getItem(
            claudeCodePermissionStorageKey(agentId)
        )
        return isClaudeCodePermissionMode(raw)
            ? raw
            : DEFAULT_CLAUDE_CODE_PERMISSION_MODE
    } catch {
        return DEFAULT_CLAUDE_CODE_PERMISSION_MODE
    }
}

const writeStoredClaudeCodePermissionMode = (
    agentId: string,
    mode: ClaudeCodePermissionMode
): void => {
    try {
        window.localStorage.setItem(
            claudeCodePermissionStorageKey(agentId),
            mode
        )
    } catch {
        /* ignore local storage failures */
    }
}

const hermesPermissionStorageKey = (agentId: string): string =>
    `${HERMES_PERMISSION_MODE_STORAGE_PREFIX}${agentId}`

const readStoredHermesPermissionMode = (
    agentId: string
): HermesPermissionMode => {
    try {
        const raw = window.localStorage.getItem(
            hermesPermissionStorageKey(agentId)
        )
        return isHermesPermissionMode(raw)
            ? raw
            : DEFAULT_HERMES_PERMISSION_MODE
    } catch {
        return DEFAULT_HERMES_PERMISSION_MODE
    }
}

const writeStoredHermesPermissionMode = (
    agentId: string,
    mode: HermesPermissionMode
): void => {
    try {
        window.localStorage.setItem(hermesPermissionStorageKey(agentId), mode)
    } catch {
        /* ignore local storage failures */
    }
}

const readStoredCodexPermissionMode = (
    agentId: string
): CodexPermissionMode => {
    try {
        const raw = window.localStorage.getItem(
            codexPermissionStorageKey(agentId)
        )
        return isCodexPermissionMode(raw) ? raw : DEFAULT_CODEX_PERMISSION_MODE
    } catch {
        return DEFAULT_CODEX_PERMISSION_MODE
    }
}

const writeStoredCodexPermissionMode = (
    agentId: string,
    mode: CodexPermissionMode
): void => {
    try {
        window.localStorage.setItem(codexPermissionStorageKey(agentId), mode)
    } catch {
        /* ignore local storage failures */
    }
}

type ApiClient = ReturnType<typeof useApiClient>

const uploadChatAttachments = async (
    client: ApiClient,
    agentId: string,
    sessionId: string,
    attachments: ComposerSendAttachment[],
    helpers: ComposerSendHelpers
): Promise<CreateMessageAttachmentInput[]> => {
    if (attachments.length === 0) return []
    const batchId = createBatchId()
    const baseDir = `chat-attachments/${sessionId}/${batchId}`
    await ensureWorkspaceDirectory(client, agentId, baseDir)

    const usedNames = new Set<string>()
    const uploaded: CreateMessageAttachmentInput[] = []
    for (const [index, attachment] of attachments.entries()) {
        const fileName = uniqueAttachmentFileName(
            attachment.file.name,
            index,
            usedNames
        )
        const path = `${baseDir}/${fileName}`
        try {
            helpers.setAttachmentProgress(attachment.id, 0)
            await client.files.write(agentId, path, attachment.file, {
                rootId: 'workspace',
                onProgress: (loaded, total) => {
                    helpers.setAttachmentProgress(
                        attachment.id,
                        total > 0 ? loaded / total : 0
                    )
                }
            })
            helpers.setAttachmentUploaded(attachment.id, path)
            uploaded.push({
                path,
                rootId: 'workspace',
                name: attachment.file.name || fileName,
                contentType: attachment.file.type || 'application/octet-stream',
                size: attachment.file.size
            })
        } catch (err) {
            const message = (err as Error).message
            helpers.setAttachmentError(attachment.id, message)
            throw err
        }
    }
    return uploaded
}

// External (Dify) agents have no workspace; their files are uploaded straight
// to our chat-upload storage and referenced by id instead of a workspace path.
const uploadChatFiles = async (
    client: ApiClient,
    agentId: string,
    attachments: ComposerSendAttachment[],
    helpers: ComposerSendHelpers
): Promise<CreateMessageUploadInput[]> => {
    if (attachments.length === 0) return []
    const uploaded: CreateMessageUploadInput[] = []
    for (const attachment of attachments) {
        try {
            helpers.setAttachmentProgress(attachment.id, 0)
            const result = await client.chat.uploadFile(
                agentId,
                attachment.file,
                attachment.file.name
            )
            helpers.setAttachmentUploaded(attachment.id, result.id)
            uploaded.push({
                uploadId: result.id,
                name: result.name,
                contentType: result.contentType,
                size: result.size
            })
        } catch (err) {
            const message = (err as Error).message
            helpers.setAttachmentError(attachment.id, message)
            throw err
        }
    }
    return uploaded
}

const contextRefsForRequest = (
    refs: ComposerContextRef[]
): CreateMessageContextRefInput[] =>
    refs.map(({ path, rootId, name, entryType, contentType, size }) => ({
        path,
        rootId,
        name,
        entryType,
        ...(contentType ? { contentType } : {}),
        ...(size !== undefined ? { size } : {})
    }))

const ensureWorkspaceDirectory = async (
    client: ApiClient,
    agentId: string,
    dir: string
): Promise<void> => {
    let current = ''
    for (const segment of dir.split('/').filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment
        await client.files.mkdir(agentId, current, { rootId: 'workspace' })
    }
}

const createBatchId = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`

const createContextRefId = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `context-${Date.now()}-${Math.random().toString(16).slice(2)}`

const contextRefKey = (ref: { rootId: string; path: string }): string =>
    `${ref.rootId}:${ref.path}`

const uniqueAttachmentFileName = (
    name: string,
    index: number,
    used: Set<string>
): string => {
    const cleaned =
        sanitizeAttachmentFileName(name).slice(0, 160) ||
        `attachment-${index + 1}`
    const dot = cleaned.lastIndexOf('.')
    const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
    const ext = dot > 0 ? cleaned.slice(dot) : ''
    let candidate = cleaned
    let suffix = 1
    while (used.has(candidate.toLowerCase())) {
        suffix += 1
        candidate = `${stem}-${suffix}${ext}`
    }
    used.add(candidate.toLowerCase())
    return candidate
}

const sanitizeAttachmentFileName = (name: string): string =>
    Array.from(name.trim())
        .map((char) => {
            const code = char.charCodeAt(0)
            if (code < 32 || code === 127 || '\\/:*?"<>|'.includes(char))
                return '-'
            return char
        })
        .join('')
        .replace(/-+/g, '-')
        .replace(/\s+/g, ' ')

const getHttpStatus = (error: unknown): number | null => {
    const message = (error as Error)?.message ?? ''
    const match = /^(\d{3})\b/.exec(message)
    if (!match) return null
    return Number(match[1])
}

const formatStatusLabel = (status: string, t: TFn): string => {
    const normalized = status
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .toLowerCase()
    switch (normalized) {
        case 'pending':
            return t('web.chat.agentStatus.pending')
        case 'running':
            return t('web.chat.agentStatus.running')
        case 'stopped':
            return t('web.chat.agentStatus.stopped')
        case 'failed':
            return t('web.chat.agentStatus.failed')
        case 'cold':
            return t('web.chat.agentStatus.cold')
        case 'warm':
            return t('web.chat.agentStatus.warm')
        case 'not_ready':
            return t('web.chat.agentStatus.notReady')
        case 'container_creating':
            return t('web.chat.agentStatus.containerCreating')
        case 'pod_initializing':
            return t('web.chat.agentStatus.podInitializing')
        case 'crash_loop_back_off':
            return t('web.chat.agentStatus.crashLoopBackOff')
        case 'image_pull_back_off':
            return t('web.chat.agentStatus.imagePullBackOff')
        case 'err_image_pull':
            return t('web.chat.agentStatus.errImagePull')
        case 'create_container_config_error':
            return t('web.chat.agentStatus.createContainerConfigError')
        case 'create_container_error':
            return t('web.chat.agentStatus.createContainerError')
        case 'invalid_image_name':
            return t('web.chat.agentStatus.invalidImageName')
        case 'unknown':
            return t('web.chat.agentStatus.unknown')
        case 'succeeded':
            return t('web.chat.agentStatus.succeeded')
        default:
            return t('web.chat.agentStatus.unknown')
    }
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value))
