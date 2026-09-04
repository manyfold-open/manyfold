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
    type FC,
    type MouseEvent as ReactMouseEvent,
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
import { MenuIcon } from '@/components/icons'
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
import OverflowMenu, { type OverflowMenuEntry } from '@/components/OverflowMenu'
import { ChatGrantProvider } from '@/components/chat/ChatGrantContext'
import type { MarkdownLinkClickHandler } from '@/components/chat/MarkdownText'
import type { MessageScrollAction } from '@/components/chat/MessageList'
import type {
    WorkspaceFileContextRef,
    WorkspaceFilePreviewRequest,
    WorkspaceFileTerminalRequest
} from '@/components/chat/WorkspaceFiles'
import { resolveWorkspaceFileLink } from '@/components/chat/fileLinkPreview'
import SidePane, {
    type SidePaneKind,
    type SidePaneOption
} from '@/components/chat/SidePane'
import type { TerminalTabModel } from '@/components/TerminalSession'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import {
    ensureSandboxTerminalEnabled,
    terminalAvailabilityForAgent,
    terminalBlockedLabel
} from '@/lib/terminalAccess'
import { terminalResumeAvailability } from '@/lib/terminalResume'
import {
    applyRegeneratedUserMessage,
    mergeLatestMessages,
    mergeMessagesById
} from '@/lib/chatMessages'

const MessageList = lazyChunk(() => import('@/components/chat/MessageList'))
const SessionTerminal = lazyChunk(() => import('@/components/TerminalSession'))
const WorkspaceFiles = lazyChunk(
    () => import('@/components/chat/WorkspaceFiles')
)
const AgentSessions = lazyChunk(
    () => import('@/components/chat/AgentSessions')
)
const BackgroundTasksBody = lazyChunk(
    () => import('@/components/BackgroundTasksPanel')
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
const CHAT_MESSAGES_PAGE_SIZE = CHAT_MESSAGE_SOFT_LIMIT

// The two representations of one session; the Chat/Terminal switch flips it.
type SessionViewMode = 'chat' | 'terminal'

// Don't re-read the runtime transcript more than once per this window on the
// throttled (session-open) path; a forced switch-back sync ignores it.
const RUNTIME_SYNC_THROTTLE_MS = 15_000

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
    const { confirm, confirmDialog } = useProductConfirm()
    const {
        agents,
        agentsLoading,
        currentAgent,
        openMobileSidebar,
        openTerminalForAgent,
        refreshAgents,
        refreshSessionsForAgent,
        daemonHosts,
        requestQuotaConflict,
        sandboxes,
        sessions,
        sessionsLoading
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
    const [activePane, setActivePane] = useState<SidePaneKind | null>(null)
    const [filePreviewVisible, setFilePreviewVisible] = useState(false)
    const [filePreviewAvailable, setFilePreviewAvailable] = useState(false)
    const [filesTreeVisible, setFilesTreeVisible] = useState(true)
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
    const [sessionView, setSessionView] = useState<SessionViewMode>('chat')
    /* Created on the first switch to Terminal and kept afterwards: the chat
       and terminal panes both stay mounted so toggling back does not tear
       down the websocket, the pty or the scrollback. */
    const [sessionTerminal, setSessionTerminal] =
        useState<TerminalTabModel | null>(null)
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
    const lastMessageIdRef = useRef<string | null>(null)
    // Bumped whenever the session terminal is rebuilt for the SAME session so
    // the tab id (= SessionTerminal key) changes and the TUI re-resumes.
    const terminalGenerationRef = useRef(0)
    // When a session was last folded from its runtime transcript, per session.
    // Throttles the open-session sync so re-renders don't re-read the CLI file.
    const runtimeSyncAtRef = useRef<Map<string, number>>(new Map())
    const runtimeSyncInFlightRef = useRef<Set<string>>(new Set())
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

    useEffect(() => {
        lastMessageIdRef.current =
            messages.length > 0 ? messages[messages.length - 1].id : null
    }, [messages])

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
    const reloadSessionMessages =
        useCallback(async (): Promise<ChatMessagesPage | null> => {
            if (!agentId || !activeSessionId) return null
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
                    return null
                setMessages(page.messages)
                setMessagesHasMore(page.hasMore)
                setMessagesNextBefore(page.nextBefore)
                setInflightAssistantMessageId(page.inflightAssistantMessageId)
                setInflightCheckpoint(checkpointFromPage(page))
                setStreamCursorEventId(page.streamCursorEventId)
                loadedMessagesAgentIdRef.current = requestAgentId
                setLoadedMessagesSessionId(requestSessionId)
                requestMessageScroll(CHAT_SCROLL_BOTTOM)
                return page
            } catch (err) {
                setError(apiErrorMessage(err))
                return null
            }
        }, [activeSessionId, agentId, client, requestMessageScroll])

    // Fold a resumed terminal TUI's own messages back into this session. The
    // TUI writes only to the CLI's local transcript, so the chat view never
    // sees them until this reads that file and appends the diff server-side.
    // The server no-ops on anything unsyncable, so this is safe to call on
    // session open (throttled) and on every switch back from the terminal
    // (forced). Only appended>0 warrants a reload.
    const syncRuntimeSessionAndReload = useCallback(
        async (force: boolean): Promise<void> => {
            const sid = activeSessionIdRef.current
            const aid = agentIdRef.current
            if (!aid || !sid || !currentAgent) return
            if (
                currentAgent.framework !== 'claude-code' &&
                currentAgent.framework !== 'codex'
            )
                return
            if (currentAgent.runtime === 'external') return
            // The server owns the real gate (session ref, reader, inflight);
            // it returns quickly when there is nothing to sync. Gating on the
            // client's session cache here would over-skip when that cache is
            // stale about the framework_session_ref.
            if (!force) {
                const last = runtimeSyncAtRef.current.get(sid) ?? 0
                if (Date.now() - last < RUNTIME_SYNC_THROTTLE_MS) return
            }
            // One sync per session at a time: overlapping calls (rapid
            // switch-backs) would diff against the same pre-append state and
            // race the same delta in twice.
            if (runtimeSyncInFlightRef.current.has(sid)) return
            runtimeSyncInFlightRef.current.add(sid)
            runtimeSyncAtRef.current.set(sid, Date.now())
            try {
                const res = await client.chat.runtimeSessionSync(aid, {
                    sessionId: sid
                })
                if (
                    res.appended > 0 &&
                    activeSessionIdRef.current === sid &&
                    agentIdRef.current === aid
                ) {
                    const page = await reloadSessionMessages()
                    // Messages the sync appended came out of the TUI's own
                    // transcript — the TUI already shows them. Advancing the
                    // tab's seed to the reloaded tip stops the next switch
                    // from rebuilding a terminal that is not actually stale.
                    const tip =
                        page && page.messages.length > 0
                            ? page.messages[page.messages.length - 1].id
                            : null
                    if (tip)
                        setSessionTerminal((prev) =>
                            prev && prev.resumeChatSessionId === sid
                                ? { ...prev, seedMessageId: tip }
                                : prev
                        )
                }
            } catch {
                // Best-effort: a failed sync just leaves the chat as it was.
            } finally {
                runtimeSyncInFlightRef.current.delete(sid)
            }
        },
        [client, currentAgent, reloadSessionMessages]
    )

    // On session open: once the initial page has loaded, pull anything a
    // terminal TUI added while we were away.
    useEffect(() => {
        if (loadedMessagesSessionId && loadedMessagesSessionId === activeSessionId)
            void syncRuntimeSessionAndReload(false)
    }, [
        activeSessionId,
        loadedMessagesSessionId,
        syncRuntimeSessionAndReload
    ])

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
        setActivePane((pane) => (pane === 'runtime' ? null : pane))
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

    /* A terminal is bound to one agent's sandbox, so switching agents must
       drop it rather than show the previous agent's shell under a new
       header. */
    useEffect(() => {
        setSessionView('chat')
        setSessionTerminal(null)
    }, [agentId])

    // Switching sessions in the sidebar re-points the terminal at the newly
    // selected session so the TUI resumes there. The session-scoped id makes
    // SessionTerminal remount (fresh xterm) rather than append onto the
    // previous session's scrollback.
    useEffect(() => {
        if (!currentAgent) return
        setSessionTerminal((prev) => {
            if (!prev) return prev
            const base = `session-terminal-${currentAgent.id}-${activeSessionId ?? 'none'}`
            // Advance-rebuilds append a `-g<N>` generation to the same base;
            // only an actual session change may retarget the terminal.
            if (prev.id === base || prev.id.startsWith(`${base}-g`))
                return prev
            return {
                ...prev,
                id: base,
                status: 'connecting',
                seedMessageId: null,
                resumeChatSessionId: activeSessionId ?? undefined
            }
        })
    }, [activeSessionId, currentAgent])

    const terminalAvailability = currentAgent
        ? terminalAvailabilityForAgent(currentAgent)
        : { available: false, reason: 'agent-not-running' as const }

    const sessionSandbox = currentAgent?.spriteName
        ? (sandboxes.find((s) => s.spriteName === currentAgent.spriteName) ??
          null)
        : null
    const sessionDaemon = currentAgent?.daemonId
        ? (daemonHosts.find((h) => h.id === currentAgent.daemonId) ?? null)
        : null
    const resumeAvailability = currentAgent
        ? terminalResumeAvailability({
              framework: currentAgent.framework,
              runtime: currentAgent.runtime,
              daemonCanResume: sessionDaemon?.canResumeInTerminal === true,
              frameworkSessionRef: activeSession?.frameworkSessionRef ?? null,
              modelSource: effectiveModelConfigView?.source ?? null,
              runtimeLocalReady:
                  effectiveModelConfigView?.runtimeLocal?.ready === true,
              sandboxModelCredentials:
                  sessionSandbox?.terminalModelCredentials === true
          })
        : { available: false, blocked: 'runtime-unsupported' as const }

    const handleSelectSessionView = useCallback(
        (next: SessionViewMode): void => {
            if (next === 'chat') {
                setSessionView('chat')
                // Coming back from the terminal is the moment to fold in
                // whatever was said in the TUI. Forced past the throttle.
                if (sessionTerminal) void syncRuntimeSessionAndReload(true)
                return
            }
            if (!currentAgent) return
            if (!terminalAvailabilityForAgent(currentAgent).available) return
            if (sessionTerminal) {
                // A running TUI read the transcript once at startup; messages
                // sent from the chat since then (each cloud turn appends to the
                // same CLI file) are invisible to it. If the conversation moved
                // past the tab's seed, rebuild it — the new id remounts the
                // terminal, the old pty is killed on disconnect, and the fresh
                // resume loads the full transcript. A null seed means the tab
                // was just (re)built from an unloaded state: adopt the current
                // tip instead of paying a pointless restart. Never rebuild
                // mid-stream — the daemon's own CLI process is still writing
                // that turn.
                const lastId = lastMessageIdRef.current
                const messagesReady =
                    loadedMessagesSessionId === activeSessionId
                const streaming = isLiveStreamStatus(stream.status)
                if (messagesReady && !streaming) {
                    if (
                        sessionTerminal.seedMessageId != null &&
                        sessionTerminal.seedMessageId !== lastId
                    ) {
                        terminalGenerationRef.current += 1
                        setSessionTerminal({
                            ...sessionTerminal,
                            id: `session-terminal-${currentAgent.id}-${activeSessionId ?? 'none'}-g${terminalGenerationRef.current}`,
                            status: 'connecting',
                            seedMessageId: lastId,
                            resumeChatSessionId: activeSessionId ?? undefined
                        })
                    } else if (sessionTerminal.seedMessageId == null) {
                        setSessionTerminal({
                            ...sessionTerminal,
                            seedMessageId: lastId
                        })
                    }
                }
                setSessionView('terminal')
                return
            }
            void (async (): Promise<void> => {
                const allowed = await ensureSandboxTerminalEnabled({
                    agent: currentAgent,
                    client,
                    confirm,
                    t
                })
                if (!allowed) return
                setSessionTerminal({
                    agentId: currentAgent.id,
                    agentName: currentAgent.name,
                    framework: currentAgent.framework,
                    id: `session-terminal-${currentAgent.id}-${activeSessionId ?? 'none'}`,
                    index: 1,
                    // Only on the mount that creates the terminal: quitting
                    // the TUI leaves a shell in the same session, and a later
                    // switch back must not seize it again.
                    //
                    // The id alone is the intent; the server owns every gate
                    // (session ref, framework, runtime, daemon capability,
                    // credentials) and opens a plain shell when it cannot
                    // resume. Deciding here from resumeAvailability would race
                    // its async inputs (daemonHosts, model config): a fast
                    // switch before they load would strand a plain shell that
                    // is never rebuilt. The id comes straight from the URL, so
                    // it is always ready. resumeAvailability now drives only
                    // the notice.
                    ...(activeSessionId
                        ? { resumeChatSessionId: activeSessionId }
                        : {}),
                    seedMessageId: lastMessageIdRef.current,
                    runtime: currentAgent.runtime,
                    status: 'connecting'
                })
                setSessionView('terminal')
            })()
        },
        [
            activeSessionId,
            client,
            confirm,
            currentAgent,
            loadedMessagesSessionId,
            sessionTerminal,
            stream.status,
            syncRuntimeSessionAndReload,
            t
        ]
    )

    const noopTerminalStatusChange = useCallback((): void => {}, [])

    /* Only the two blocked reasons the user can act on. A framework with no
       resume form, or a session the CLI has not named yet, is not a problem
       to report — the shell is simply a shell. */
    const resumeNotice =
        resumeAvailability.blocked === 'needs-credential-toggle'
            ? t('web.sessionView.resumeNeedsCredentials')
            : resumeAvailability.blocked === 'needs-runtime-signin'
              ? t('web.sessionView.resumeNeedsSignIn')
              : resumeAvailability.blocked === 'daemon-needs-upgrade'
                ? t('web.sessionView.resumeNeedsDaemonUpgrade')
                : null

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
            setActivePane('files')
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
        // The sessions pane lists one agent, so switching agents invalidates
        // it. Switching sessions only moves its Current tag, so it stays open
        // — as Files / Background tasks always have.
        setActivePane((pane) => (pane === 'runtime' ? null : pane))
    }, [agentId])

    // Leaving the Files pane drops its preview sub-state, so a stale preview
    // neither re-opens the pane nor lights the header's preview toggle.
    useEffect(() => {
        if (activePane !== 'files') {
            setFilePreviewVisible(false)
            setFilePreviewAvailable(false)
            setFilePreviewRequest(null)
        }
    }, [activePane])

    // The tree collapses only while a preview stands in for it; the moment the
    // preview is gone, bring the tree back so the Files pane is never empty.
    useEffect(() => {
        if (!(filePreviewAvailable && filePreviewVisible))
            setFilesTreeVisible(true)
    }, [filePreviewAvailable, filePreviewVisible])

    const toggleFiles = useCallback((): void => {
        if (!workspaceToolsAvailable) return
        setActivePane((pane) => (pane === 'files' ? null : 'files'))
    }, [workspaceToolsAvailable])

    const toggleFilePreviewVisible = useCallback((): void => {
        if (!workspaceToolsAvailable) return
        if (!filePreviewAvailable) return
        setActivePane('files')
        setFilePreviewVisible((value) => !value)
    }, [filePreviewAvailable, workspaceToolsAvailable])

    useEffect(() => {
        setFilePreviewAvailable(false)
        setFilePreviewVisible(false)
        setFilePreviewRequest(null)
        setWorkspaceRefreshing(false)
    }, [agentId])

    useEffect(() => {
        if (!workspaceToolsAvailable)
            setActivePane((pane) => (pane === 'files' ? null : pane))
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
                toggleFiles()
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
    }, [toggleFilePreviewVisible, toggleFiles])

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
    const paneOptions: SidePaneOption[] = [
        ...(workspaceToolsAvailable
            ? [{ kind: 'files' as const, label: t('web.chat.pane.files') }]
            : []),
        {
            kind: 'background-tasks',
            label: t('web.chat.pane.backgroundTasks')
        },
        ...(currentAgent && currentAgent.runtime !== 'external'
            ? [
                  {
                      kind: 'runtime' as const,
                      label: t('web.chat.pane.runtimeSession')
                  }
              ]
            : [])
    ]

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
        <div className='flex h-full min-h-0 overflow-hidden'>
        <div className='chat-workspace-shell flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
            <AgentChatHeader
                agent={currentAgent}
                refreshing={workspaceRefreshing}
                onOpenMobileMenu={openMobileSidebar}
                onOpenTerminal={() => openTerminalForAgent(currentAgent)}
                sessionView={sessionView}
                terminalDisabledReason={
                    terminalAvailability.reason
                        ? terminalBlockedLabel(terminalAvailability.reason, t)
                        : null
                }
                onSelectSessionView={handleSelectSessionView}
                onShare={
                    shareableSession
                        ? () => setShareSessionOpen(true)
                        : null
                }
                onRefresh={handleRefreshWorkspace}
                onOpenFiles={
                    workspaceToolsAvailable
                        ? () => setActivePane('files')
                        : null
                }
                onOpenBackgroundTasks={() => setActivePane('background-tasks')}
                onOpenRuntimeViewer={
                    currentAgent.runtime !== 'external'
                        ? () => setActivePane('runtime')
                        : null
                }
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
                                        <h2 className='text-display text-fg'>
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
                        {/* Kept mounted once opened, and only hidden when the
                            chat tab is active: unmounting would drop the
                            websocket, the pty and the scrollback, and the
                            message list underneath would lose its reading
                            position if it were the side that got hidden. */}
                        {sessionTerminal && (
                            <div
                                className={
                                    sessionView === 'terminal'
                                        ? 'absolute inset-0 z-20 flex flex-col'
                                        : 'hidden'
                                }
                            >
                                {/* Why this shell is not the session's TUI.
                                    Without it a plain prompt reads as the
                                    feature silently not working. */}
                                {resumeNotice && (
                                    <div className='border-divider/80 bg-surface text-caption text-muted shrink-0 border-b px-3 py-1.5'>
                                        {resumeNotice}
                                    </div>
                                )}
                                <div className='relative min-h-0 flex-1'>
                                    <Suspense fallback={null}>
                                        <SessionTerminal
                                            key={sessionTerminal.id}
                                            active={sessionView === 'terminal'}
                                            getToken={getToken}
                                            onStatusChange={
                                                noopTerminalStatusChange
                                            }
                                            tab={sessionTerminal}
                                        />
                                    </Suspense>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {confirmDialog}
        </div>
        {activePane && (
            <SidePane
                activeKind={activePane}
                options={paneOptions}
                onSelectKind={setActivePane}
                onClose={() => setActivePane(null)}
            >
                {activePane === 'background-tasks' && (
                    <Suspense fallback={null}>
                        <BackgroundTasksBody agent={currentAgent} />
                    </Suspense>
                )}
                {activePane === 'runtime' && agentId && (
                    <Suspense
                        fallback={
                            <div className='text-ui text-muted flex h-full items-center justify-center px-6 text-center'>
                                {t('web.chat.loadingRuntimeViewer')}
                            </div>
                        }
                    >
                        <AgentSessions
                            agentId={agentId}
                            sessionId={activeSessionId}
                            onClose={handleRuntimeViewerClose}
                            onApplied={handleRuntimeViewerApplied}
                        />
                    </Suspense>
                )}
                {activePane === 'files' && (
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
                            onToggleTree={() =>
                                setFilesTreeVisible((value) => !value)
                            }
                            previewRequest={filePreviewRequest}
                            previewVisible={filePreviewVisible}
                            refreshKey={workspaceRefreshKey}
                            visible={filesTreeVisible}
                        />
                    </Suspense>
                )}
            </SidePane>
        )}
        </div>
    )
}

interface AgentChatHeaderProps {
    agent: SdkAgent
    refreshing: boolean
    onOpenMobileMenu: () => void
    onOpenTerminal: () => void
    sessionView: SessionViewMode
    terminalDisabledReason: string | null
    onSelectSessionView: (mode: SessionViewMode) => void
    onShare: (() => void) | null
    onRefresh: () => void
    onOpenFiles: (() => void) | null
    onOpenBackgroundTasks: () => void
    onOpenRuntimeViewer: (() => void) | null
}

const AgentChatHeader: FC<AgentChatHeaderProps> = ({
    agent,
    refreshing,
    onOpenMobileMenu,
    onOpenTerminal,
    sessionView,
    terminalDisabledReason,
    onSelectSessionView,
    onShare,
    onRefresh,
    onOpenFiles,
    onOpenBackgroundTasks,
    onOpenRuntimeViewer
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

    // Every non-primary chat action lives in this one overflow menu: the
    // Chat/Terminal view switch (its label flips with the current view), the
    // three side-panel openers, then share / terminal dock / refresh.
    const overflowItems: OverflowMenuEntry[] = [
        {
            label:
                sessionView === 'chat'
                    ? t('web.sessionView.switchToTerminal')
                    : t('web.sessionView.switchToChat'),
            onSelect: () =>
                onSelectSessionView(
                    sessionView === 'chat' ? 'terminal' : 'chat'
                ),
            disabled: sessionView === 'chat' && terminalDisabledReason !== null,
            disabledReason:
                sessionView === 'chat'
                    ? (terminalDisabledReason ?? undefined)
                    : undefined
        },
        { separator: true },
        ...(onOpenFiles
            ? [{ label: t('web.chat.pane.files'), onSelect: onOpenFiles }]
            : []),
        {
            label: t('web.chat.pane.backgroundTasks'),
            onSelect: onOpenBackgroundTasks
        },
        ...(onOpenRuntimeViewer
            ? [
                  {
                      label: t('web.chat.pane.runtimeSession'),
                      onSelect: onOpenRuntimeViewer
                  }
              ]
            : []),
        { separator: true },
        ...(onShare
            ? [{ label: t('web.chat.header.share'), onSelect: onShare }]
            : []),
        ...(agent.runtime !== 'external'
            ? [
                  {
                      label: t('web.chat.header.openTerminal'),
                      onSelect: onOpenTerminal,
                      disabled: agent.status !== 'running'
                  }
              ]
            : []),
        {
            label: t('web.chat.header.refresh'),
            onSelect: onRefresh,
            disabled: refreshing
        }
    ]

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
                <OverflowMenu
                    items={overflowItems}
                    triggerClassName={`${actionButtonClass()} inline-flex`}
                />
            </div>
        </header>
    )
}

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
