import type {
    AgentFramework,
    ChatSessionSummary,
    DaemonHostSummary,
    QuotaWarningEvent,
    RuntimeAccessSummary,
    SandboxSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import {
    Fragment,
    Suspense,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import {
    Link,
    Outlet,
    useLocation,
    useMatch,
    useNavigate,
    useOutletContext
} from 'react-router-dom'
import { createPortal } from 'react-dom'
import { Plus as LucidePlusIcon } from 'lucide-react'
import {
    CheckIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    EllipsisHorizontalIcon,
    AutomationsIcon,
    ExternalLinkIcon,
    GlobeIcon,
    InfoIcon,
    LogoutIcon,
    MenuIcon,
    MoonIcon,
    PinIcon,
    PlusIcon,
    CustomizeIcon,
    SettingsIcon,
    SidebarToggleIcon,
    SunIcon,
    TrashIcon,
    UsageIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { createReconnectingStream } from '@/lib/spriteStatusStream'
import { useShellPolling } from '@/hooks/useShellPolling'
import { subscribeAgentCredentialsOpen } from '@/lib/agentCredentialsEvents'
import { daysAgoIso, fmtCost, hoursAgoIso } from '@/lib/usageFormat'
import { useAppAuth } from '@/lib/auth'
import { useCurrentUser } from '@/lib/useCurrentUser'
import SignupBetaBadge from '@/components/signup-gate/BetaBadge'
import { agentStatusDotClass } from '@/lib/agentStatusDot'
import AgentStatusDot from '@/components/AgentStatusDot'
import { Ghost, GhostPageContent } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import ConcurrencyIndicator from '@/components/ConcurrencyIndicator'
import { countActiveSandboxes } from '@/lib/concurrencySlots'
import AgentSidebarControls from '@/components/AgentSidebarControls'
import SidebarResizeHandle from '@/components/SidebarResizeHandle'
import { useSidebarResize } from '@/lib/useSidebarResize'
import {
    applyAgentsView,
    readAgentsViewConfig,
    readCollapsedAgentGroups,
    writeAgentsViewConfig,
    writeCollapsedAgentGroups,
    type AgentGroup,
    type AgentsViewConfig
} from '@/lib/agentSidebarView'
import { useIsAgentStreaming } from '@/lib/chatStreamStore'
import { storeLastChatLocation } from '@/lib/chatNavigation'
import { languageOptions, useI18n } from '@/lib/i18n'
import { navigateWithRailTransition } from '@/lib/railTransition'
import { useTheme } from '@/lib/theme'
import { matchesKeyboardShortcut } from '@/lib/keyboardShortcuts'
import { docsHref } from '@/lib/docsLinks'
import { agentDashboardOpener } from '@/lib/openDashboard'
import type { AgentMenuItem } from '@/lib/agentMenu'
import { buildAgentMenuItems, isSectionBoundary } from '@/lib/agentMenu'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { useDeleteAgent } from '@/lib/useDeleteAgent'
import {
    FrameworkLogo,
    frameworkLabel as frameworkDisplayLabel
} from '@/lib/frameworkMeta'
import TerminalDock, {
    type TerminalConnectionStatus,
    type TerminalTabModel
} from '@/components/TerminalDock'
import BackgroundTasksPanel from '@/components/BackgroundTasksPanel'
import AgentCredentialsDialog from '@/components/chat/AgentCredentialsDialog'
import { BrandMark } from '@/components/Brand'
import QuotaBanner from '@/components/QuotaBanner'
import CliUpgradeBanner from '@/components/CliUpgradeBanner'
import WorkspaceChallengeCard from '@/components/challenge/WorkspaceChallengeCard'
import QuotaConflictModal, {
    type QuotaConflictRequest
} from '@/components/QuotaConflictModal'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import RenameAgentDialog from '@/components/RenameAgentDialog'
import RenameChannelDisplayNameDialog from '@/components/RenameChannelDisplayNameDialog'
import RenameChatSessionDialog from '@/components/RenameChatSessionDialog'
import ShareChatSessionDialog from '@/components/chat/ShareChatSessionDialog'
import SessionStreamingDot from '@/components/chat/SessionStreamingDot'
import SessionContextMenu from '@/components/chat/SessionContextMenu'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import {
    applyAgentStatusSnapshots,
    getAgentChatAvailability,
    reconcileSidebarAgents,
    sortSidebarAgents
} from '@/lib/chatAgents'
import { ChannelProviderIcon } from '@/lib/channelMeta'
import { timeAgo } from '@/lib/timeAgo'
import { useSessionCache } from '@/components/app-shell/useSessionCache'

export interface AppShellOutletContext {
    activeSessionId: string | null
    agents: SdkAgent[]
    agentsError: string | null
    agentsLoading: boolean
    currentAgent: SdkAgent | null
    openMobileSidebar: () => void
    openTerminalForAgent: (
        agent: SdkAgent,
        options?: OpenTerminalOptions
    ) => void
    refreshAgents: () => Promise<SdkAgent[]>
    refreshSessionsForAgent: (agentId: string) => Promise<ChatSessionSummary[]>
    refreshSessions: () => Promise<ChatSessionSummary[]>
    runtimeAccess: RuntimeAccessSummary | null
    refreshRuntimeAccess: () => Promise<RuntimeAccessSummary | null>
    quotaWarnings: QuotaWarningEvent[]
    dismissQuotaWarning: (code: string) => void
    requestQuotaConflict: (request: QuotaConflictRequest) => void
    markAgentReleasing: (agentId: string) => void
    bgTasksVisible: boolean
    toggleBackgroundTasks: () => void
    sessions: ChatSessionSummary[]
    sessionsError: string | null
    sessionsLoading: boolean
}

export const useAppShellContext = (): AppShellOutletContext =>
    useOutletContext<AppShellOutletContext>()

export interface OpenTerminalOptions {
    cwdLabel?: string
    cwdPath?: string
    cwdRootId?: string
}

type ExpandedByAgent = Record<string, boolean>
interface PinnedSessionRecord {
    agentId: string | null
    pinnedAt: number
}
type PinnedSessions = Record<string, PinnedSessionRecord>
type SidebarSectionKey = 'pinned' | 'agents'
type SidebarSectionState = Record<SidebarSectionKey, boolean>
type SessionMutationState = Record<string, boolean>
interface RefreshAgentsOptions {
    clearOnError?: boolean
    showLoading?: boolean
}

const expandedStateStorageKey = 'nca.web.sidebar.expandedByAgent'
const sidebarCollapsedStorageKey = 'nca.web.sidebar.collapsed'
const pinnedSessionsStorageKey = 'nca.web.sidebar.pinnedSessions'
const sidebarSectionStateStorageKey = 'nca.web.sidebar.sectionState'
const sidebarSessionLimit = 5
const agentListRefreshIntervalMs = 60_000
const daemonHostsRefreshIntervalMs = 60_000
const sandboxesRefreshIntervalMs = 60_000
const runtimeAccessRefreshIntervalMs = 300_000
const runtimeAccessMinSpacingMs = 60_000

const learnMoreLinkGroups = [
    [
        {
            labelKey: 'web.settingsMenu.docs',
            href: docsHref('/docs/getting-started/')
        },
        {
            labelKey: 'web.settingsMenu.gettingStarted',
            href: docsHref('/docs/getting-started/')
        },
        {
            labelKey: 'web.settingsMenu.installCli',
            href: docsHref('/docs/install')
        },
        {
            labelKey: 'web.settingsMenu.telegramChannel',
            href: docsHref('/docs/channels/telegram')
        },
        {
            labelKey: 'web.settingsMenu.slackChannel',
            href: docsHref('/docs/channels/slack')
        },
        {
            labelKey: 'web.settingsMenu.larkChannel',
            href: docsHref('/docs/channels/lark')
        },
        {
            labelKey: 'web.settingsMenu.discordChannel',
            href: docsHref('/docs/channels/discord')
        }
    ],
    [
        {
            labelKey: 'web.settingsMenu.changelog',
            href: docsHref('/changelog')
        },
        { labelKey: 'web.settingsMenu.status', href: docsHref('/status') }
    ],
    [
        {
            labelKey: 'web.settingsMenu.privacyPolicy',
            href: docsHref('/privacy')
        },
        {
            labelKey: 'web.settingsMenu.termsOfService',
            href: docsHref('/terms')
        }
    ]
] as const

const readStoredBoolean = (storageKey: string): boolean => {
    if (typeof window === 'undefined') return false

    try {
        return window.localStorage.getItem(storageKey) === 'true'
    } catch {
        return false
    }
}

const readExpandedByAgent = (): ExpandedByAgent => {
    if (typeof window === 'undefined') return {}

    try {
        const raw = window.localStorage.getItem(expandedStateStorageKey)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object') return {}

        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, boolean] =>
                    typeof entry[0] === 'string' &&
                    typeof entry[1] === 'boolean'
            )
        )
    } catch {
        return {}
    }
}

const parsePinnedSessionRecord = (
    value: unknown
): PinnedSessionRecord | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { agentId: null, pinnedAt: value }
    }

    if (!value || typeof value !== 'object') return null
    const record = value as Partial<PinnedSessionRecord>
    if (
        typeof record.pinnedAt !== 'number' ||
        !Number.isFinite(record.pinnedAt)
    ) {
        return null
    }

    return {
        agentId: typeof record.agentId === 'string' ? record.agentId : null,
        pinnedAt: record.pinnedAt
    }
}

const readPinnedSessions = (): PinnedSessions => {
    if (typeof window === 'undefined') return {}

    try {
        const raw = window.localStorage.getItem(pinnedSessionsStorageKey)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object') return {}

        return Object.fromEntries(
            Object.entries(parsed).flatMap(([sessionId, value]) => {
                const record = parsePinnedSessionRecord(value)
                return record ? [[sessionId, record]] : []
            })
        )
    } catch {
        return {}
    }
}

const readSidebarSectionState = (): SidebarSectionState => {
    const fallback: SidebarSectionState = {
        pinned: false,
        agents: false
    }
    if (typeof window === 'undefined') return fallback

    try {
        const raw = window.localStorage.getItem(sidebarSectionStateStorageKey)
        if (!raw) return fallback
        const parsed = JSON.parse(raw) as Partial<SidebarSectionState> | null
        if (!parsed || typeof parsed !== 'object') return fallback

        return {
            pinned: parsed.pinned === true,
            agents: parsed.agents === true
        }
    } catch {
        return fallback
    }
}

const omitRecordKey = <T,>(
    value: Record<string, T>,
    key: string
): Record<string, T> => {
    if (!hasOwn(value, key)) return value
    const next = { ...value }
    delete next[key]
    return next
}

/* Agent block container: just wrapper + bottom margin. Active state
   isn't expressed at the block level — there's no surrounding card.
   Sessions just sit indented under the agent row. */
const agentBlockClass = (): string => 'mb-1'

/* Agent rail row — class L list-item per DESIGN.md §8.10.
   Hover only — no `focus-within`. The row has **no active state** and
   no sticky selection feedback: clicking a row action (the `+`/`⋯`/`▾`
   button) leaves focus on the button, but the row background must
   release the moment the cursor leaves. Using `focus-within` here made
   the row read as "selected" after any click, which contradicts the
   no-active-state contract. Selection is communicated by which agent
   block is expanded and which session row inside is highlighted. */
const agentRailRowClass = (menuOpen: boolean): string =>
    [
        'group/row flex items-center gap-0.5 rounded-sm pr-2.5 transition-colors hover:bg-rail-hover',
        menuOpen ? 'bg-rail-hover' : ''
    ].join(' ')

/* The name button is transparent — typography only. Text stays
   `text-muted` at rest and lifts to `text-fg` on row hover (not
   focus-within — see agentRailRowClass for the rationale). */
const agentToggleClass = (): string =>
    'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-left text-muted transition-colors group-hover/row:text-fg'

/* Session rows sit visibly tighter than their parent agent row — they
   are children, not peers. Padded vertically by py-1.5 (~30px vs the
   agent row's ~36px). The active session inside an active agent block
   lifts to bg-surface (lighter than block bg in light mode; same step
   lighter in dark) so it reads as the focused chat. Hover stays text-
   only — no background — to keep the two list levels distinct from
   the agent rows above. */
const railSessionClass = (active: boolean): string =>
    [
        'flex items-center gap-2 px-2.5 py-1.5 transition-colors',
        active
            ? 'text-fg'
            : 'text-subtle group-hover:text-fg group-focus-within:text-fg'
    ].join(' ')

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key)

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max)

const iconClass = 'h-4 w-4 shrink-0'

/* Row action buttons (+ / ⋯ / ▾ chevron) are class G ghost icons
   inside a class L list row. They fade in on row hover/focus so the
   rail reads quietly at rest. Agent rows have no active state — the
   user identifies "which agent am I in" through which agent block
   is expanded plus which session row is highlighted, not through
   per-agent persistent chrome. (Mirrors the session row's behavior.)
   No fill on icon-button hover: the row already carries the
   bg-rail-hover highlight, and stacking another fill on top would
   read as a double-layered chip. Icon color shift alone is the
   hover signal here. */
const rowActionButtonClass = (): string =>
    [
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:!opacity-40',
        'text-subtle hover:text-fg'
    ].join(' ')

const railIconButtonClass = (active = false): string =>
    [
        'shadow-ring-light inline-flex h-10 w-10 items-center justify-center rounded-pill transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        active
            ? 'bg-surface text-fg'
            : 'bg-surface/70 text-muted hover:bg-surface-hover'
    ].join(' ')

const collapsedAgentButtonClass = (active: boolean): string =>
    [
        'shadow-ring-light relative inline-flex h-11 w-11 items-center justify-center rounded-pill transition-colors',
        active
            ? 'bg-surface text-fg'
            : 'bg-surface/70 text-muted hover:bg-surface-hover'
    ].join(' ')

const menuItemClass =
    'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-ui text-muted transition-colors hover:bg-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'

const dangerMenuItemClass =
    'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-ui text-workflow-ship transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'

// Rail skeletons (DESIGN.md §10.8) sit directly on --color-rail with no
// container: the rail is chrome, so a card around pending rows would
// invent a surface the loaded state doesn't have. Widths step per row so
// the stack reads as a list of titles (literal classes for the scan).
const ghostSessionWidth = ['w-4/5', 'w-3/5', 'w-11/12', 'w-1/2', 'w-2/3']
const GHOST_SESSION_ROWS = [0, 1, 2, 3, 4]
const ghostAgentWidth = ['w-2/3', 'w-1/2', 'w-3/4', 'w-2/5']
const GHOST_AGENT_ROWS = [0, 1, 2, 3]

// Both rail ghosts own their own §10.8 gate rather than taking a prop:
// they mount and unmount with the fetch they stand in for, so the gate
// lives where the pending flag already is.
const SessionListGhost: FC = (): ReactNode => {
    const gate = useLoadingGate(true)
    if (!gate.showLoading) return null
    return (
        <div aria-busy='true'>
            {GHOST_SESSION_ROWS.map((row) => (
                <div key={row} className='px-2.5 py-[9px]'>
                    <Ghost variant='line' className={ghostSessionWidth[row]} />
                </div>
            ))}
        </div>
    )
}

const AgentRailGhost: FC<{ collapsed: boolean }> = ({
    collapsed
}): ReactNode => {
    const gate = useLoadingGate(true)
    if (!gate.showLoading) return null
    return (
        <div aria-busy='true' className={collapsed ? 'space-y-2' : 'space-y-1'}>
            {GHOST_AGENT_ROWS.map((row) =>
                collapsed ? (
                    <Ghost
                        key={row}
                        variant='circle'
                        className='mx-auto h-10 w-10'
                    />
                ) : (
                    <div
                        key={row}
                        className='flex items-center gap-2.5 px-2.5 py-[7px]'
                    >
                        <Ghost variant='circle' className='h-6 w-6 shrink-0' />
                        <Ghost
                            variant='line'
                            className={ghostAgentWidth[row]}
                        />
                    </div>
                )
            )}
        </div>
    )
}

const agentGroupHeaderLabel = (
    group: AgentGroup,
    t: (key: string) => string
): string => {
    switch (group.kind) {
        case 'host':
            return group.hostLabel ?? ''
        case 'framework':
            return frameworkDisplayLabel(group.key as AgentFramework)
        case 'date':
            return t(`web.shell.agentsView.date.${group.key}`)
        default:
            return ''
    }
}

type AgentListItem =
    | { kind: 'header'; key: string; label: string; collapsed: boolean }
    | { kind: 'agent'; agent: SdkAgent }

const flattenAgentGroups = (
    groups: AgentGroup[],
    showHeaders: boolean,
    collapsedKeys: ReadonlySet<string>,
    t: (key: string) => string
): AgentListItem[] => {
    const items: AgentListItem[] = []
    for (const group of groups) {
        const headerKey = `${group.kind}:${group.key}`
        const hasHeader = showHeaders && group.kind !== 'none'
        const collapsed = hasHeader && collapsedKeys.has(headerKey)
        if (hasHeader)
            items.push({
                kind: 'header',
                key: headerKey,
                label: agentGroupHeaderLabel(group, t),
                collapsed
            })
        if (collapsed) continue
        for (const agent of group.agents) items.push({ kind: 'agent', agent })
    }
    return items
}

const frameworkLabel = (framework: SdkAgent['framework']): string => {
    switch (framework) {
        case 'claude-code':
            return 'Claude Code'
        case 'codex':
            return 'Codex'
        case 'gemini-cli':
            return 'Gemini CLI'
        case 'openclaw':
            return 'OpenClaw'
        case 'hermes':
            return 'Hermes'
        default:
            return 'NarraNexus'
    }
}

// Whether this agent currently has a reachable dashboard. Mirrors the
// server-side preconditions in `getControlUiUrl`: framework-specific gating
// (controlUiEnabled for openclaw, dashboardEnabled for hermes, always on for
// narranexus) plus an ingress host and a runtimeId to mint against.
const FrameworkLogoIcon: FC<{
    framework: SdkAgent['framework']
    className?: string
}> = ({ framework, className }): ReactNode => (
    <FrameworkLogo
        framework={framework}
        size={18}
        className={className ?? ''}
    />
)

const SidebarSectionHeader: FC<{
    action?: ReactNode
    collapsed: boolean
    label: string
    meta?: ReactNode
    onToggle: () => void
}> = ({ action, collapsed, label, meta, onToggle }): ReactNode => (
    <div className='mb-2 flex items-center justify-between gap-1 pl-2'>
        <div className='flex min-w-0 items-center gap-2'>
            <button
                type='button'
                onClick={onToggle}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
                className='text-subtle hover:text-fg inline-flex min-w-0 items-center gap-1 rounded-md py-1 transition-colors'
            >
                <span className='workbench-kicker truncate'>{label}</span>
                <ChevronDownIcon
                    className={[
                        'h-4 w-4 shrink-0 transition-transform',
                        collapsed ? '-rotate-90' : ''
                    ].join(' ')}
                />
            </button>
            {meta}
        </div>
        {action}
    </div>
)

interface SidebarSessionRowProps {
    active: boolean
    agent: SdkAgent
    confirmingDelete: boolean
    deleting: boolean
    onConfirmDelete: () => void
    onSelect?: () => void
    onRequestDelete: () => void
    onSessionRenamed?: (agentId: string, sessionId: string) => void
    onTogglePinned: () => void
    pinned: boolean
    session: ChatSessionSummary
}

const SidebarSessionRow: FC<SidebarSessionRowProps> = ({
    active,
    agent,
    confirmingDelete,
    deleting,
    onConfirmDelete,
    onSelect,
    onRequestDelete,
    onSessionRenamed,
    onTogglePinned,
    pinned,
    session
}): ReactNode => {
    const { t } = useI18n()
    const channelDisplayName = session.channel?.displayName ?? null
    const title = channelDisplayName
        ? `🏷️ ${channelDisplayName}`
        : (session.title ?? t('web.shell.untitledChat'))
    const hasChannel = Boolean(session.channel)
    const [menuAnchor, setMenuAnchor] = useState<{
        x: number
        y: number
    } | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [renameChannelOpen, setRenameChannelOpen] = useState(false)
    const [shareOpen, setShareOpen] = useState(false)
    const rowClass = [
        'group relative flex w-full min-w-0 items-center overflow-visible rounded-sm transition-colors',
        active ? 'bg-active-session' : 'hover:bg-rail-hover'
    ].join(' ')

    return (
        <div
            className={rowClass}
            onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setMenuAnchor({ x: event.clientX, y: event.clientY })
            }}
        >
            {menuAnchor && (
                <SessionContextMenu
                    x={menuAnchor.x}
                    y={menuAnchor.y}
                    pinned={pinned}
                    session={session}
                    onClose={() => setMenuAnchor(null)}
                    onRename={() => setRenameOpen(true)}
                    onRenameChannel={
                        session.channel
                            ? () => setRenameChannelOpen(true)
                            : undefined
                    }
                    onShare={
                        session.channel ? undefined : () => setShareOpen(true)
                    }
                    onTogglePin={onTogglePinned}
                    onDelete={onRequestDelete}
                />
            )}
            {renameOpen && (
                <RenameChatSessionDialog
                    agentId={agent.id}
                    sessionId={session.id}
                    initialTitle={session.title ?? ''}
                    onClose={() => setRenameOpen(false)}
                    onRenamed={() => {
                        onSessionRenamed?.(agent.id, session.id)
                    }}
                />
            )}
            {renameChannelOpen && session.channel && (
                <RenameChannelDisplayNameDialog
                    channelId={session.channel.id}
                    channelSessionId={session.channel.channelSessionId}
                    initialDisplayName={session.channel.displayName ?? ''}
                    onClose={() => setRenameChannelOpen(false)}
                    onRenamed={() => {
                        onSessionRenamed?.(agent.id, session.id)
                    }}
                />
            )}
            {shareOpen && (
                <ShareChatSessionDialog
                    agentId={agent.id}
                    sessionId={session.id}
                    title={session.title}
                    onClose={() => setShareOpen(false)}
                />
            )}
            {/* Leading channel marker — small badge that identifies an
                external-channel session (Slack/Discord/etc). Sits at
                the row's left edge so it reads as session metadata. */}
            {hasChannel && (
                <ShortcutTooltip
                    label={session.channel?.label}
                    className='ml-2 shrink-0'
                >
                    <span
                        role='img'
                        aria-label={session.channel?.label}
                        className='inline-flex h-4 w-4 shrink-0 items-center justify-center'
                    >
                        <ChannelProviderIcon
                            provider={session.channel!.provider}
                            className='h-3.5 w-3.5'
                        />
                    </span>
                </ShortcutTooltip>
            )}

            <div
                className={[
                    railSessionClass(active),
                    'w-full min-w-0 flex-1 self-stretch'
                ].join(' ')}
            >
                <Link
                    to={`/agents/${agent.id}/chat?sessionId=${session.id}`}
                    onClick={() => {
                        onSelect?.()
                    }}
                    className='flex min-w-0 flex-1 items-center gap-2'
                >
                    <SessionStreamingDot
                        agentId={agent.id}
                        sessionId={session.id}
                    />
                    <div className='text-ui min-w-0 flex-1 truncate'>
                        {title}
                    </div>
                </Link>

                {/* Right cluster: timeAgo (default) collapses on hover
                    to reveal the action buttons (pin + delete). Pinned
                    sessions keep the pin button visible always. */}
                <div
                    className={[
                        'relative flex shrink-0 items-center justify-end self-stretch',
                        confirmingDelete ? 'min-w-[5.5rem]' : 'min-w-[3.75rem]'
                    ].join(' ')}
                >
                    {!confirmingDelete && (
                        <>
                            <div className='text-caption text-subtle shrink-0 transition-opacity group-hover:opacity-0'>
                                {timeAgo(session.updatedAt)}
                            </div>

                            <div className='pointer-events-none absolute right-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100'>
                                <ShortcutTooltip
                                    label={
                                        pinned
                                            ? t('web.shell.unpinChat', {
                                                  title
                                              })
                                            : t('web.shell.pinChat', { title })
                                    }
                                    className='shrink-0'
                                >
                                    <button
                                        type='button'
                                        aria-label={
                                            pinned
                                                ? t('web.shell.unpinChat', {
                                                      title
                                                  })
                                                : t('web.shell.pinChat', {
                                                      title
                                                  })
                                        }
                                        onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            onTogglePinned()
                                        }}
                                        className={[
                                            'rounded-pill inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors',
                                            pinned
                                                ? 'text-fg hover:text-fg'
                                                : 'text-subtle hover:text-fg'
                                        ].join(' ')}
                                    >
                                        <PinIcon className='h-3.5 w-3.5' />
                                    </button>
                                </ShortcutTooltip>

                                <ShortcutTooltip
                                    label={t('web.shell.deleteChat', { title })}
                                    className='shrink-0'
                                >
                                    <button
                                        type='button'
                                        aria-label={t('web.shell.deleteChat', {
                                            title
                                        })}
                                        disabled={deleting}
                                        onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            onRequestDelete()
                                        }}
                                        className='text-workflow-ship hover:text-error-strong rounded-pill inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors disabled:opacity-40'
                                    >
                                        <TrashIcon className='h-3.5 w-3.5' />
                                    </button>
                                </ShortcutTooltip>
                            </div>
                        </>
                    )}

                    {confirmingDelete && (
                        <button
                            type='button'
                            aria-label={t('web.shell.confirmDelete')}
                            disabled={deleting}
                            onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                onConfirmDelete()
                            }}
                            className='text-caption text-workflow-ship shadow-ring-light bg-danger-bg hover:bg-danger-hover inline-flex h-7 items-center justify-center rounded-md px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'
                        >
                            {t('web.shell.confirmDelete')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

interface AgentActionsMenuProps {
    agent: SdkAgent
    items: AgentMenuItem[]
    onOpenChange?: (open: boolean) => void
}

const AgentActionsMenu: FC<AgentActionsMenuProps> = ({
    agent,
    items,
    onOpenChange
}): ReactNode => {
    const { direction } = useI18n()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const [menuPos, setMenuPos] = useState<{
        left: number
        top: number
        ready: boolean
    }>({
        left: 0,
        top: 0,
        ready: false
    })

    const changeOpen = (next: boolean): void => {
        setOpen(next)
        onOpenChange?.(next)
    }

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !rootRef.current?.contains(target) &&
                !panelRef.current?.contains(target)
            ) {
                changeOpen(false)
            }
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') changeOpen(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    const updateMenuPosition = useCallback((): void => {
        if (
            typeof window === 'undefined' ||
            !rootRef.current ||
            !panelRef.current
        ) {
            return
        }

        const buttonRect = rootRef.current.getBoundingClientRect()
        const panelRect = panelRef.current.getBoundingClientRect()
        const viewportPadding = 8
        const gap = 6
        const panelWidth = panelRect.width || 176
        const panelHeight = panelRect.height

        const alignedLeft =
            direction === 'rtl'
                ? buttonRect.left
                : buttonRect.right - panelWidth
        const left = clamp(
            alignedLeft,
            viewportPadding,
            window.innerWidth - viewportPadding - panelWidth
        )

        const fitsBelow =
            buttonRect.bottom + gap + panelHeight <=
            window.innerHeight - viewportPadding
        const top = fitsBelow
            ? buttonRect.bottom + gap
            : Math.max(viewportPadding, buttonRect.top - gap - panelHeight)

        setMenuPos({ left, top, ready: true })
    }, [direction])

    const setPanelNode = useCallback(
        (node: HTMLDivElement | null): void => {
            panelRef.current = node
            if (!node || typeof window === 'undefined') return
            window.requestAnimationFrame(updateMenuPosition)
        },
        [updateMenuPosition]
    )

    useLayoutEffect(() => {
        if (!open) {
            setMenuPos((current) =>
                current.ready ? { ...current, ready: false } : current
            )
            return
        }

        updateMenuPosition()
        const positionFrame = window.requestAnimationFrame(updateMenuPosition)

        const handleViewportChange = (): void => {
            updateMenuPosition()
        }

        window.addEventListener('resize', handleViewportChange)
        document.addEventListener('scroll', handleViewportChange, true)

        return () => {
            window.cancelAnimationFrame(positionFrame)
            window.removeEventListener('resize', handleViewportChange)
            document.removeEventListener('scroll', handleViewportChange, true)
        }
    }, [open, updateMenuPosition])

    const runAction = (action: () => void): void => {
        changeOpen(false)
        action()
    }

    const toggleMenu = (): void => {
        changeOpen(!open)
    }

    return (
        <div
            ref={rootRef}
            className='relative shrink-0'
            onClick={(event) => {
                event.stopPropagation()
            }}
        >
            <button
                type='button'
                aria-label={`More actions for ${agent.name}`}
                aria-haspopup='menu'
                aria-expanded={open}
                onClick={toggleMenu}
                className={rowActionButtonClass()}
            >
                <EllipsisHorizontalIcon className='h-3.5 w-3.5' />
            </button>

            {open &&
                typeof document !== 'undefined' &&
                createPortal(
                    <div
                        ref={setPanelNode}
                        role='menu'
                        className='shadow-elevated bg-surface-elevated/95 popover-panel fixed z-[200] w-44 rounded-md p-1 backdrop-blur'
                        style={{
                            left: menuPos.left,
                            top: menuPos.top,
                            visibility: menuPos.ready ? 'visible' : 'hidden'
                        }}
                    >
                        {items.map((item, index) => (
                            <Fragment key={item.id}>
                                {isSectionBoundary(items, index) && (
                                    <div className='popover-separator' />
                                )}
                                <button
                                    type='button'
                                    role='menuitem'
                                    disabled={item.disabled}
                                    onClick={() => runAction(item.onSelect)}
                                    className={
                                        item.danger
                                            ? dangerMenuItemClass
                                            : menuItemClass
                                    }
                                >
                                    <span className='min-w-0 flex-1 truncate'>
                                        {item.label}
                                    </span>
                                    {item.trailing && (
                                        <span
                                            aria-hidden='true'
                                            className='text-subtle shrink-0'
                                        >
                                            {item.trailing}
                                        </span>
                                    )}
                                </button>
                            </Fragment>
                        ))}
                    </div>,
                    document.body
                )}
        </div>
    )
}

interface CollapsedAgentSessionsMenuProps {
    active: boolean
    activeSessionId: string | null
    agent: SdkAgent
    confirmingDeleteSessionId: string | null
    hiddenPinnedSessionCount: number
    onClearDeleteConfirmation: () => void
    onCreateSession: () => void
    onDeleteSession: (session: ChatSessionSummary) => void
    onOpenDetails: () => void
    onOpenSessions: () => void
    onRequestDeleteSession: (sessionId: string) => void
    onRetrySessions: () => void
    onSessionRenamed: (agentId: string, sessionId: string) => void
    onTogglePinnedSession: (agentId: string, sessionId: string) => void
    pinnedSessions: PinnedSessions
    sessionMutating: SessionMutationState
    sessions: ChatSessionSummary[]
    sessionsError: string | null
    sessionsLoading: boolean
}

interface CollapsedPinnedSessionsMenuProps {
    activeSessionId: string | null
    confirmingDeleteSessionId: string | null
    onClearDeleteConfirmation: () => void
    rows: Array<{
        agent: SdkAgent
        session: ChatSessionSummary
    }>
    onDeleteSession: (agentId: string, session: ChatSessionSummary) => void
    onRequestDeleteSession: (sessionId: string) => void
    onSessionRenamed: (agentId: string, sessionId: string) => void
    onTogglePinnedSession: (agentId: string, sessionId: string) => void
    sessionMutating: SessionMutationState
}

const CollapsedPinnedSessionsMenu: FC<CollapsedPinnedSessionsMenuProps> = ({
    activeSessionId,
    confirmingDeleteSessionId,
    onClearDeleteConfirmation,
    rows,
    onDeleteSession,
    onRequestDeleteSession,
    onSessionRenamed,
    onTogglePinnedSession,
    sessionMutating
}): ReactNode => {
    const { direction, t } = useI18n()
    const location = useLocation()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const [panelStyle, setPanelStyle] = useState<{
        left: number
        top: number
    }>({ left: 0, top: 16 })

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !rootRef.current?.contains(target) &&
                !panelRef.current?.contains(target)
            ) {
                setOpen(false)
            }
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    useEffect(() => {
        setOpen(false)
    }, [location.pathname, location.search])

    const updatePanelPosition = useCallback((): void => {
        if (
            typeof window === 'undefined' ||
            !rootRef.current ||
            !panelRef.current
        ) {
            return
        }

        const buttonRect = rootRef.current.getBoundingClientRect()
        const panelRect = panelRef.current.getBoundingClientRect()
        const viewportPadding = 16
        const gutter = 10
        const panelWidth = panelRect.width || 288
        const nextLeft =
            direction === 'rtl'
                ? Math.max(
                      viewportPadding,
                      buttonRect.left - gutter - panelWidth
                  )
                : Math.min(
                      buttonRect.right + gutter,
                      window.innerWidth - viewportPadding - panelWidth
                  )
        const nextTop = clamp(
            buttonRect.top + buttonRect.height / 2 - panelRect.height / 2,
            viewportPadding,
            window.innerHeight - viewportPadding - panelRect.height
        )

        setPanelStyle({
            left: nextLeft,
            top: nextTop
        })
    }, [direction])

    useLayoutEffect(() => {
        if (!open) return

        updatePanelPosition()

        const handleViewportChange = (): void => {
            updatePanelPosition()
        }

        window.addEventListener('resize', handleViewportChange)
        document.addEventListener('scroll', handleViewportChange, true)

        return () => {
            window.removeEventListener('resize', handleViewportChange)
            document.removeEventListener('scroll', handleViewportChange, true)
        }
    }, [open, updatePanelPosition])

    useLayoutEffect(() => {
        if (!open) return
        updatePanelPosition()
    }, [open, rows.length, updatePanelPosition])

    const active = rows.some((row) => row.session.id === activeSessionId)
    const sessionPanel =
        open && typeof document !== 'undefined'
            ? createPortal(
                  <div
                      ref={panelRef}
                      role='dialog'
                      aria-label={t('web.shell.pinnedChats')}
                      className='shadow-elevated bg-surface-elevated/95 popover-panel fixed z-[200] flex max-h-[calc(100vh-2rem)] w-[16.5rem] flex-col overflow-hidden rounded-md p-1 backdrop-blur'
                      style={panelStyle}
                  >
                      <div className='shadow-ring-light bg-soft mb-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2'>
                          <span className='text-fg shadow-ring-light bg-surface inline-flex h-[1.125rem] w-[1.125rem] items-center justify-center rounded-md'>
                              <PinIcon className='h-3 w-3' />
                          </span>
                          <div className='min-w-0 flex-1'>
                              <div className='text-ui text-fg truncate font-medium'>
                                  {t('web.shell.pinnedChats')}
                              </div>
                          </div>
                          <span className='tag tag-neutral tabular-nums'>
                              {rows.length}
                          </span>
                      </div>

                      <div className='min-h-0 flex-1 space-y-1 overflow-auto'>
                          {rows.map(({ agent, session }) => (
                              <SidebarSessionRow
                                  key={session.id}
                                  active={session.id === activeSessionId}
                                  agent={agent}
                                  confirmingDelete={
                                      confirmingDeleteSessionId === session.id
                                  }
                                  deleting={
                                      sessionMutating[session.id] ?? false
                                  }
                                  onSelect={() => {
                                      onClearDeleteConfirmation()
                                      setOpen(false)
                                  }}
                                  onConfirmDelete={() => {
                                      setOpen(false)
                                      onDeleteSession(agent.id, session)
                                  }}
                                  onRequestDelete={() => {
                                      onRequestDeleteSession(session.id)
                                  }}
                                  onSessionRenamed={onSessionRenamed}
                                  pinned={true}
                                  session={session}
                                  onTogglePinned={() => {
                                      onTogglePinnedSession(
                                          agent.id,
                                          session.id
                                      )
                                  }}
                              />
                          ))}
                      </div>
                  </div>,
                  document.body
              )
            : null

    return (
        <div ref={rootRef} className='relative shrink-0'>
            <ShortcutTooltip
                label={t('web.shell.pinnedChats')}
                placement='right'
            >
                <button
                    type='button'
                    aria-label={t('web.shell.openPinnedChats')}
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    onClick={() => setOpen((prev) => !prev)}
                    className={collapsedAgentButtonClass(active || open)}
                >
                    <PinIcon className='h-3.5 w-3.5' />
                </button>
            </ShortcutTooltip>
            {sessionPanel}
        </div>
    )
}

const CollapsedAgentSessionsMenu: FC<CollapsedAgentSessionsMenuProps> = ({
    active,
    activeSessionId,
    agent,
    confirmingDeleteSessionId,
    hiddenPinnedSessionCount,
    onClearDeleteConfirmation,
    onCreateSession,
    onDeleteSession,
    onOpenDetails,
    onOpenSessions,
    onRequestDeleteSession,
    onRetrySessions,
    onSessionRenamed,
    onTogglePinnedSession,
    pinnedSessions,
    sessionMutating,
    sessions,
    sessionsError,
    sessionsLoading
}): ReactNode => {
    const { direction, t } = useI18n()
    const availability = getAgentChatAvailability(agent)
    const agentStreaming = useIsAgentStreaming(agent.id)
    const daemonStopped =
        agent.runtime === 'daemon' && agent.status === 'stopped'
    const showReadOnlyBadge =
        !availability.ready &&
        !daemonStopped &&
        availability.code !== 'cli-upgrade'
    const location = useLocation()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const [panelStyle, setPanelStyle] = useState<{
        left: number
        top: number
    }>({ left: 0, top: 16 })

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !rootRef.current?.contains(target) &&
                !panelRef.current?.contains(target)
            ) {
                setOpen(false)
            }
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    useEffect(() => {
        setOpen(false)
    }, [location.pathname, location.search])

    useEffect(() => {
        if (open) onOpenSessions()
    }, [onOpenSessions, open])

    const updatePanelPosition = useCallback((): void => {
        if (
            typeof window === 'undefined' ||
            !rootRef.current ||
            !panelRef.current
        ) {
            return
        }

        const buttonRect = rootRef.current.getBoundingClientRect()
        const panelRect = panelRef.current.getBoundingClientRect()
        const viewportPadding = 16
        const gutter = 10
        const panelWidth = panelRect.width || 288
        const nextLeft =
            direction === 'rtl'
                ? Math.max(
                      viewportPadding,
                      buttonRect.left - gutter - panelWidth
                  )
                : Math.min(
                      buttonRect.right + gutter,
                      window.innerWidth - viewportPadding - panelWidth
                  )
        const nextTop = clamp(
            buttonRect.top + buttonRect.height / 2 - panelRect.height / 2,
            viewportPadding,
            window.innerHeight - viewportPadding - panelRect.height
        )

        setPanelStyle({
            left: nextLeft,
            top: nextTop
        })
    }, [direction])

    useLayoutEffect(() => {
        if (!open) return

        updatePanelPosition()

        const handleViewportChange = (): void => {
            updatePanelPosition()
        }

        window.addEventListener('resize', handleViewportChange)
        document.addEventListener('scroll', handleViewportChange, true)

        return () => {
            window.removeEventListener('resize', handleViewportChange)
            document.removeEventListener('scroll', handleViewportChange, true)
        }
    }, [open, updatePanelPosition])

    useLayoutEffect(() => {
        if (!open) return
        updatePanelPosition()
    }, [
        open,
        sessions.length,
        sessionsError,
        sessionsLoading,
        updatePanelPosition
    ])

    const runAction = (action: () => void): void => {
        setOpen(false)
        action()
    }

    const agentTitle = `${agent.name} · ${frameworkLabel(agent.framework)} · ${
        agent.status
    }${showReadOnlyBadge ? ` · ${t('web.shell.readOnly')}` : ''}`
    const sessionPanel =
        open && typeof document !== 'undefined'
            ? createPortal(
                  <div
                      ref={panelRef}
                      role='dialog'
                      aria-label={t('web.shell.openSessionsForAgent', {
                          name: agent.name
                      })}
                      className='shadow-elevated bg-surface-elevated/95 popover-panel fixed z-[200] flex max-h-[calc(100vh-2rem)] w-[16.5rem] flex-col overflow-hidden rounded-md p-1 backdrop-blur'
                      style={panelStyle}
                  >
                      <div className='shadow-ring-light bg-soft mb-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2'>
                          <FrameworkLogoIcon
                              framework={agent.framework}
                              className='h-[1.125rem] w-[1.125rem]'
                          />
                          <div className='min-w-0 flex-1'>
                              <div className='flex items-center gap-2'>
                                  <div className='text-ui text-fg truncate font-medium'>
                                      {agent.name}
                                  </div>
                                  <AgentStatusDot agent={agent} />
                              </div>
                          </div>
                      </div>

                      <div className='min-h-0 flex-1 space-y-1 overflow-auto'>
                          {sessionsError && (
                              <>
                                  <div className='workbench-alert-error'>
                                      {sessionsError}
                                  </div>
                                  <button
                                      type='button'
                                      onClick={() => onRetrySessions()}
                                      className={menuItemClass}
                                  >
                                      {t('web.shell.retryLoadingChats')}
                                  </button>
                              </>
                          )}

                          {!sessionsError && sessionsLoading && (
                              <SessionListGhost />
                          )}

                          {!sessionsError &&
                              !sessionsLoading &&
                              sessions.length === 0 && (
                                  <div className='text-ui text-subtle px-3 py-1.5'>
                                      {availability.ready
                                          ? hiddenPinnedSessionCount > 0
                                              ? t('web.shell.allChatsPinned')
                                              : t('web.shell.noChatsYet')
                                          : t('web.shell.noChatsAvailable')}
                                  </div>
                              )}

                          {sessions.map((session) => {
                              const sessionActive =
                                  active && session.id === activeSessionId
                              return (
                                  <SidebarSessionRow
                                      key={session.id}
                                      active={sessionActive}
                                      agent={agent}
                                      confirmingDelete={
                                          confirmingDeleteSessionId ===
                                          session.id
                                      }
                                      deleting={
                                          sessionMutating[session.id] ?? false
                                      }
                                      onSelect={() => {
                                          onClearDeleteConfirmation()
                                          setOpen(false)
                                      }}
                                      onConfirmDelete={() => {
                                          setOpen(false)
                                          onDeleteSession(session)
                                      }}
                                      onRequestDelete={() => {
                                          onRequestDeleteSession(session.id)
                                      }}
                                      onSessionRenamed={onSessionRenamed}
                                      pinned={hasOwn(
                                          pinnedSessions,
                                          session.id
                                      )}
                                      session={session}
                                      onTogglePinned={() => {
                                          onTogglePinnedSession(
                                              agent.id,
                                              session.id
                                          )
                                      }}
                                  />
                              )
                          })}
                      </div>

                      <div className='border-divider/70 mt-1.5 space-y-1 border-t pt-1.5'>
                          <button
                              type='button'
                              onClick={() => runAction(onOpenDetails)}
                              className='text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center rounded-sm px-2.5 py-2 text-left transition-colors'
                          >
                              {t('web.shell.agentSettings')}
                          </button>
                          {availability.ready && (
                              <button
                                  type='button'
                                  onClick={() => runAction(onCreateSession)}
                                  className='text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center rounded-sm px-2.5 py-2 text-left transition-colors'
                              >
                                  {t('web.shell.newChat')}
                              </button>
                          )}
                      </div>
                  </div>,
                  document.body
              )
            : null

    return (
        <div ref={rootRef} className='relative shrink-0'>
            <ShortcutTooltip label={agentTitle} placement='right'>
                <button
                    type='button'
                    aria-label={t('web.shell.openSessionsForAgent', {
                        name: agent.name
                    })}
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    onClick={() => setOpen((prev) => !prev)}
                    className={collapsedAgentButtonClass(active || open)}
                >
                    <FrameworkLogoIcon framework={agent.framework} />
                    <span
                        className={[
                            'absolute bottom-2.5 right-2.5 h-2.5 w-2.5 rounded-full border-2 border-[#f3f3ef]',
                            agentStatusDotClass(
                                agent.status,
                                agent.spriteStatus,
                                agent.k8sPodPhase,
                                agent.runtime
                            ),
                            agentStreaming ? 'animate-pulse' : ''
                        ].join(' ')}
                        aria-hidden='true'
                    />
                    <span className='sr-only'>{agentTitle}</span>
                </button>
            </ShortcutTooltip>
            {sessionPanel}
        </div>
    )
}

const sidebarMenuItemClass = (danger = false, active = false): string =>
    [
        'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-ui transition-colors',
        danger
            ? 'text-workflow-ship hover:bg-danger-hover'
            : active
              ? 'bg-soft text-fg'
              : 'text-muted hover:bg-soft hover:text-fg'
    ].join(' ')

const accountTriggerClass = (collapsed: boolean): string =>
    collapsed
        ? 'rounded-pill focus-visible:shadow-focus inline-flex h-9 w-9 items-center justify-center transition-[color,background-color,box-shadow] focus:outline-none'
        : 'text-ui text-muted hover:text-fg hover:bg-rail-hover focus-visible:shadow-focus flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left font-medium transition-[color,background-color,box-shadow] focus:outline-none'

const SidebarUserAvatar: FC<{
    imageUrl?: string | null
    label: string
    className?: string
}> = ({ imageUrl, label, className }): ReactNode => {
    const fallback = label.trim().charAt(0).toUpperCase() || 'A'

    return (
        <span
            className={[
                'shadow-ring-light bg-avatar-bg text-avatar-fg inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium',
                className ?? ''
            ].join(' ')}
            aria-hidden='true'
        >
            {imageUrl ? (
                <img
                    src={imageUrl}
                    alt=''
                    className='h-full w-full object-cover'
                />
            ) : (
                fallback
            )}
        </span>
    )
}

interface AccountUsageWindows {
    last5h: number | null
    last7d: number | null
}

const useAccountUsage = (active: boolean): AccountUsageWindows | null => {
    const client = useApiClient()
    const [usage, setUsage] = useState<AccountUsageWindows | null>(null)

    useEffect(() => {
        if (!active) return
        let cancelled = false
        Promise.all([
            client.usage.summary({ from: hoursAgoIso(5) }),
            client.usage.summary({ from: daysAgoIso(6) })
        ])
            .then(([h5, d7]) => {
                if (!cancelled)
                    setUsage({
                        last5h: h5.totalCostUsd,
                        last7d: d7.totalCostUsd
                    })
            })
            .catch(() => {
                // best-effort
            })
        return (): void => {
            cancelled = true
        }
    }, [active, client])

    return usage
}

const SidebarSettingsMenu: FC<{ collapsed?: boolean }> = ({
    collapsed = false
}): ReactNode => {
    const navigate = useNavigate()
    const location = useLocation()
    const { signOut, user } = useAppAuth()
    const { user: currentUser } = useCurrentUser()
    const { direction, language, setLanguage, t } = useI18n()
    const { theme, toggleTheme } = useTheme()
    const [open, setOpen] = useState(false)
    const usage = useAccountUsage(open)
    const [languageOpen, setLanguageOpen] = useState(false)
    const [learnMoreOpen, setLearnMoreOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)

    const openLearnMore = useCallback((): void => {
        setLanguageOpen(false)
        setLearnMoreOpen(true)
    }, [])

    const closeLearnMore = useCallback((): void => {
        setLearnMoreOpen(false)
    }, [])

    const closeLanguage = useCallback((): void => {
        setLanguageOpen(false)
    }, [])

    const openLanguage = useCallback((): void => {
        closeLearnMore()
        setLanguageOpen(true)
    }, [closeLearnMore])

    const toggleLanguage = useCallback((): void => {
        closeLearnMore()
        setLanguageOpen((current) => !current)
    }, [closeLearnMore])

    const toggleLearnMore = useCallback((): void => {
        closeLanguage()
        setLearnMoreOpen((current) => !current)
    }, [closeLanguage])

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false)
                closeLearnMore()
                closeLanguage()
            }
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setOpen(false)
                closeLearnMore()
                closeLanguage()
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [closeLanguage, closeLearnMore, open])

    useEffect(() => {
        setOpen(false)
        closeLearnMore()
        closeLanguage()
    }, [closeLanguage, closeLearnMore, location.pathname, location.search])

    useEffect(() => {
        if (!open) {
            closeLearnMore()
            closeLanguage()
        }
    }, [closeLanguage, closeLearnMore, open])

    const accountName =
        currentUser?.displayName ||
        user?.email ||
        t('web.settingsMenu.personalAccount')
    const selectedLanguage =
        languageOptions.find((option) => option.code === language) ??
        languageOptions[0]
    const ThemeIcon = theme === 'dark' ? MoonIcon : SunIcon
    const currentThemeLabel =
        theme === 'dark'
            ? t('web.general.themeDark')
            : t('web.general.themeLight')

    const runAction = (action: () => void): void => {
        setOpen(false)
        closeLearnMore()
        closeLanguage()
        action()
    }

    return (
        <div
            ref={rootRef}
            className={['relative', collapsed ? 'w-11' : ''].join(' ')}
        >
            {open && (
                <div
                    role='menu'
                    className={[
                        'shadow-elevated bg-surface-elevated/95 popover-panel absolute bottom-full z-[85] mb-2 max-h-[calc(100vh-1.5rem)] w-[16.5rem] max-w-[calc(100vw-1.5rem)] overflow-visible rounded-md p-1 backdrop-blur',
                        direction === 'rtl' ? 'right-0' : 'left-0'
                    ].join(' ')}
                >
                    <button
                        type='button'
                        role='menuitem'
                        aria-label={t('web.settingsMenu.personalAccount')}
                        onClick={() => {
                            runAction(() =>
                                navigateWithRailTransition(
                                    navigate,
                                    '/settings/account',
                                    'forward'
                                )
                            )
                        }}
                        className={sidebarMenuItemClass()}
                    >
                        <SidebarUserAvatar
                            label={accountName}
                            className='h-4 w-4 text-[0.55rem]'
                        />
                        <span className='min-w-0 flex-1 truncate'>
                            {accountName}
                        </span>
                    </button>

                    <button
                        type='button'
                        role='menuitem'
                        onClick={() => {
                            runAction(() =>
                                navigateWithRailTransition(
                                    navigate,
                                    '/settings/general',
                                    'forward'
                                )
                            )
                        }}
                        className={sidebarMenuItemClass()}
                    >
                        <SettingsIcon className='h-4 w-4 shrink-0' />
                        {t('web.settingsMenu.settings')}
                    </button>

                    <div className='popover-separator' />

                    <button
                        type='button'
                        role='menuitem'
                        onClick={() => {
                            runAction(() =>
                                navigateWithRailTransition(
                                    navigate,
                                    '/settings/usage',
                                    'forward'
                                )
                            )
                        }}
                        className={[
                            sidebarMenuItemClass(),
                            'flex-col !items-stretch gap-1.5'
                        ].join(' ')}
                    >
                        <span className='flex w-full items-center gap-2.5'>
                            <UsageIcon className='h-4 w-4 shrink-0' />
                            <span className='min-w-0 flex-1'>
                                {t('web.settingsMenu.usage')}
                            </span>
                            <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0' />
                        </span>
                        {usage && (
                            <span className='ms-[1.625rem] flex flex-col gap-1 tabular-nums'>
                                <span className='flex items-baseline justify-between gap-4'>
                                    <span className='text-caption text-subtle'>
                                        {t('web.settingsMenu.usageWindow5h')}
                                    </span>
                                    <span className='text-caption text-fg'>
                                        {fmtCost(usage.last5h)}
                                    </span>
                                </span>
                                <span className='flex items-baseline justify-between gap-4'>
                                    <span className='text-caption text-subtle'>
                                        {t('web.settingsMenu.usageWindow7d')}
                                    </span>
                                    <span className='text-caption text-fg'>
                                        {fmtCost(usage.last7d)}
                                    </span>
                                </span>
                            </span>
                        )}
                    </button>

                    <div className='popover-separator' />

                    <div className='relative'>
                        <button
                            type='button'
                            role='menuitem'
                            aria-haspopup='listbox'
                            aria-expanded={languageOpen}
                            onClick={toggleLanguage}
                            onKeyDown={(event) => {
                                if (
                                    event.key === 'Enter' ||
                                    event.key === ' ' ||
                                    event.key === 'ArrowRight'
                                ) {
                                    event.preventDefault()
                                    openLanguage()
                                }
                            }}
                            className={sidebarMenuItemClass(
                                false,
                                languageOpen
                            )}
                        >
                            <GlobeIcon className='h-4 w-4 shrink-0' />
                            <span className='min-w-0 flex-1'>
                                {t('web.settingsMenu.language')}
                            </span>
                            <span className='text-caption text-subtle max-w-28 truncate'>
                                {selectedLanguage.nativeName}
                            </span>
                            <ChevronRightIcon
                                className={[
                                    'text-subtle h-4 w-4 shrink-0 transition-transform',
                                    languageOpen ? 'text-fg' : ''
                                ].join(' ')}
                            />
                        </button>

                        {languageOpen && (
                            <>
                                <span
                                    aria-hidden='true'
                                    className={[
                                        'absolute bottom-0 hidden h-[calc(100vh-1.5rem)] w-2 sm:block',
                                        direction === 'rtl'
                                            ? 'right-full'
                                            : 'left-full'
                                    ].join(' ')}
                                />
                                <div
                                    role='listbox'
                                    aria-label={t('web.settingsMenu.language')}
                                    className={[
                                        'shadow-elevated bg-surface-elevated/95 popover-panel absolute bottom-full z-[86] mb-1 max-h-[min(50vh,26rem)] w-full overflow-auto rounded-md p-1 backdrop-blur sm:bottom-0 sm:mb-0 sm:max-h-[calc(100vh-1.5rem)] sm:w-64',
                                        direction === 'rtl'
                                            ? 'sm:right-[calc(100%+0.5rem)]'
                                            : 'sm:left-[calc(100%+0.5rem)]'
                                    ].join(' ')}
                                >
                                    {languageOptions.map((option) => {
                                        const active = option.code === language

                                        return (
                                            <button
                                                key={option.code}
                                                type='button'
                                                role='option'
                                                aria-selected={active}
                                                onClick={() => {
                                                    setLanguage(option.code)
                                                    closeLanguage()
                                                }}
                                                className={[
                                                    'text-muted hover:text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors',
                                                    active
                                                        ? 'text-fg font-medium'
                                                        : ''
                                                ].join(' ')}
                                            >
                                                <span className='min-w-0 flex-1'>
                                                    <span className='text-ui block truncate font-medium'>
                                                        {option.nativeName}
                                                    </span>
                                                    <span className='text-caption text-subtle block truncate'>
                                                        {option.englishName}
                                                    </span>
                                                </span>
                                                {active && (
                                                    <CheckIcon className='h-4 w-4 shrink-0' />
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            </>
                        )}
                    </div>

                    <button
                        type='button'
                        role='menuitem'
                        aria-label={`${t(
                            'web.settingsMenu.theme'
                        )}: ${currentThemeLabel}`}
                        onClick={() => {
                            closeLearnMore()
                            closeLanguage()
                            toggleTheme()
                        }}
                        className={sidebarMenuItemClass()}
                    >
                        <ThemeIcon className='h-4 w-4 shrink-0' />
                        <span className='min-w-0 flex-1'>
                            {t('web.settingsMenu.theme')}
                        </span>
                        <span className='text-caption text-subtle'>
                            {currentThemeLabel}
                        </span>
                    </button>

                    <div className='relative'>
                        <button
                            type='button'
                            role='menuitem'
                            aria-haspopup='menu'
                            aria-expanded={learnMoreOpen}
                            onClick={toggleLearnMore}
                            onKeyDown={(event) => {
                                if (
                                    event.key === 'Enter' ||
                                    event.key === ' ' ||
                                    event.key === 'ArrowRight'
                                ) {
                                    event.preventDefault()
                                    openLearnMore()
                                }
                            }}
                            className={sidebarMenuItemClass(
                                false,
                                learnMoreOpen
                            )}
                        >
                            <InfoIcon className='h-4 w-4 shrink-0' />
                            <span className='min-w-0 flex-1'>
                                {t('web.settingsMenu.learnMore')}
                            </span>
                            <ChevronRightIcon
                                className={[
                                    'text-subtle h-4 w-4 shrink-0 transition-transform',
                                    learnMoreOpen ? 'text-fg' : ''
                                ].join(' ')}
                            />
                        </button>

                        {learnMoreOpen && (
                            <>
                                <span
                                    aria-hidden='true'
                                    className={[
                                        'absolute bottom-0 hidden h-[calc(100vh-1.5rem)] w-2 sm:block',
                                        direction === 'rtl'
                                            ? 'right-full'
                                            : 'left-full'
                                    ].join(' ')}
                                />
                                <div
                                    role='menu'
                                    aria-label={t(
                                        'web.settingsMenu.learnMoreMenu'
                                    )}
                                    className={[
                                        'shadow-elevated bg-surface-elevated/95 popover-panel absolute bottom-full z-[86] mb-1 max-h-[min(50vh,26rem)] w-full overflow-auto rounded-md p-1 backdrop-blur sm:bottom-0 sm:mb-0 sm:max-h-[calc(100vh-1.5rem)] sm:w-64',
                                        direction === 'rtl'
                                            ? 'sm:right-[calc(100%+0.5rem)]'
                                            : 'sm:left-[calc(100%+0.5rem)]'
                                    ].join(' ')}
                                >
                                    {learnMoreLinkGroups.map(
                                        (group, groupIndex) => (
                                            <div key={groupIndex}>
                                                {groupIndex > 0 && (
                                                    <div className='popover-separator' />
                                                )}
                                                {group.map((link) => (
                                                    <a
                                                        key={link.href}
                                                        role='menuitem'
                                                        href={link.href}
                                                        target='_blank'
                                                        rel='noreferrer'
                                                        onClick={() => {
                                                            setOpen(false)
                                                            closeLearnMore()
                                                        }}
                                                        className='text-muted hover:text-fg text-ui hover:bg-soft flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 transition-colors'
                                                    >
                                                        <span className='min-w-0 flex-1 truncate'>
                                                            {t(link.labelKey)}
                                                        </span>
                                                        <ExternalLinkIcon className='h-4 w-4 shrink-0' />
                                                    </a>
                                                ))}
                                            </div>
                                        )
                                    )}
                                </div>
                            </>
                        )}
                    </div>

                    <div className='popover-separator' />

                    <button
                        type='button'
                        role='menuitem'
                        onClick={() => {
                            runAction(() => {
                                signOut({ redirectUrl: '/login' })
                            })
                        }}
                        className={sidebarMenuItemClass(true)}
                    >
                        <LogoutIcon className='h-4 w-4 shrink-0' />
                        {t('web.settingsMenu.logOut')}
                    </button>
                </div>
            )}

            {collapsed ? (
                <div className='flex w-full flex-col items-center gap-2'>
                    <ShortcutTooltip label={accountName} placement='right'>
                        <button
                            type='button'
                            aria-label={accountName}
                            aria-haspopup='menu'
                            aria-expanded={open}
                            onClick={() => setOpen((prev) => !prev)}
                            className={accountTriggerClass(true)}
                        >
                            <SidebarUserAvatar
                                label={accountName}
                                className='h-7 w-7 text-[0.7rem]'
                            />
                        </button>
                    </ShortcutTooltip>
                </div>
            ) : (
                <button
                    type='button'
                    aria-label={accountName}
                    aria-haspopup='menu'
                    aria-expanded={open}
                    onClick={() => setOpen((prev) => !prev)}
                    className={accountTriggerClass(false)}
                >
                    <SidebarUserAvatar
                        label={accountName}
                        className='h-5 w-5 text-[0.6rem]'
                    />
                    <span className='min-w-0 flex-1 truncate'>
                        {accountName}
                    </span>
                </button>
            )}
        </div>
    )
}

const AppShell: FC = (): ReactNode => {
    const client = useApiClient()
    const { getToken } = useAppAuth()
    const location = useLocation()
    const navigate = useNavigate()
    const { direction, t } = useI18n()
    const { confirm, confirmDialog } = useProductConfirm()
    const chatMatch = useMatch('/agents/:id/chat')
    const agentNewMatch = useMatch('/agents/new')
    const agentDetailMatch = useMatch('/agents/:id')
    const skillsMatch = useMatch('/skills/*')
    const connectionsMatch = useMatch('/connections/*')
    const mcpMatch = useMatch('/mcp/*')
    const customizeMatch = skillsMatch ?? connectionsMatch ?? mcpMatch
    const automationsMatch = useMatch('/automations/*')
    const pageOwnMobileHeader = Boolean(
        chatMatch || agentDetailMatch || agentNewMatch
    )
    const selectedAgentId =
        chatMatch?.params.id ??
        (agentNewMatch ? null : (agentDetailMatch?.params.id ?? null))
    const activeSessionId = chatMatch
        ? new URLSearchParams(location.search).get('sessionId')
        : null
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [agentsLoading, setAgentsLoading] = useState(true)
    const [agentsError, setAgentsError] = useState<string | null>(null)
    const [daemonHosts, setDaemonHosts] = useState<DaemonHostSummary[]>([])
    const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([])
    const [agentsViewConfig, setAgentsViewConfig] = useState<AgentsViewConfig>(
        () => readAgentsViewConfig()
    )
    const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<
        Set<string>
    >(() => readCollapsedAgentGroups())
    const toggleAgentGroupCollapsed = useCallback((key: string): void => {
        setCollapsedAgentGroups((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }, [])
    const hostNames = useMemo(() => {
        const map = new Map<string, string>()
        for (const host of daemonHosts) map.set(host.id, host.name)
        // Sprite agents carry spriteName (the VM id), not the sandbox host id;
        // key sandbox names by spriteName so host grouping/filters show the
        // renameable "sandbox-002" label instead of the raw VM id.
        for (const sandbox of sandboxes)
            if (sandbox.spriteName) map.set(sandbox.spriteName, sandbox.name)
        return map
    }, [daemonHosts, sandboxes])
    const agentsView = useMemo(
        () =>
            applyAgentsView(agents, agentsViewConfig, {
                now: Date.now(),
                hostNames
            }),
        [agents, agentsViewConfig, hostNames]
    )
    useEffect(() => {
        writeAgentsViewConfig(agentsViewConfig)
    }, [agentsViewConfig])
    useEffect(() => {
        writeCollapsedAgentGroups(collapsedAgentGroups)
    }, [collapsedAgentGroups])
    const [runtimeAccess, setRuntimeAccess] =
        useState<RuntimeAccessSummary | null>(null)
    const [quotaWarnings, setQuotaWarnings] = useState<QuotaWarningEvent[]>([])
    const [quotaConflict, setQuotaConflict] =
        useState<QuotaConflictRequest | null>(null)
    const [releasingAgentIds, setReleasingAgentIds] = useState<Set<string>>(
        () => new Set()
    )
    const {
        ensureSessionsForAgent,
        pruneSessionCacheToAgentIds,
        refreshSessionsForAgent,
        sessionErrorByAgent,
        sessionLoadingByAgent,
        sessionsByAgent
    } = useSessionCache(client)
    const [expandedByAgent, setExpandedByAgent] = useState<ExpandedByAgent>(
        () => readExpandedByAgent()
    )
    const [showAllSessionsByAgent, setShowAllSessionsByAgent] = useState<
        Record<string, boolean>
    >({})
    const [pinnedSessions, setPinnedSessions] = useState<PinnedSessions>(() =>
        readPinnedSessions()
    )
    const [sidebarSectionState, setSidebarSectionState] =
        useState<SidebarSectionState>(() => readSidebarSectionState())
    const [sessionMutating, setSessionMutating] =
        useState<SessionMutationState>({})
    const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = useState<
        string | null
    >(null)
    const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] =
        useState<boolean>(() => readStoredBoolean(sidebarCollapsedStorageKey))
    const sidebarResize = useSidebarResize({
        storageKey: 'nca.web.sidebar.width',
        direction
    })
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [sidebarError, setSidebarError] = useState<string | null>(null)
    const [activeAutomationCount, setActiveAutomationCount] = useState<
        number | null
    >(null)
    const terminalSerialRef = useRef(0)
    const [terminalTabs, setTerminalTabs] = useState<TerminalTabModel[]>([])
    const [activeTerminalId, setActiveTerminalId] = useState<string | null>(
        null
    )
    const [terminalDockVisible, setTerminalDockVisible] = useState(false)
    const [bgTasksVisible, setBgTasksVisible] = useState(false)
    const [credentialsAgent, setCredentialsAgent] = useState<SdkAgent | null>(
        null
    )
    const [renameAgent, setRenameAgent] = useState<SdkAgent | null>(null)
    const [menuOpenAgentId, setMenuOpenAgentId] = useState<string | null>(null)

    const currentAgent = useMemo(
        () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
        [agents, selectedAgentId]
    )
    useEffect(
        () =>
            subscribeAgentCredentialsOpen((agentId) => {
                const target = agents.find((agent) => agent.id === agentId)
                if (target) setCredentialsAgent(target)
            }),
        [agents]
    )
    const activeTerminalAgent = useMemo(() => {
        const activeTab =
            terminalTabs.find((tab) => tab.id === activeTerminalId) ??
            terminalTabs[0] ??
            null
        if (!activeTab) return null
        return agents.find((agent) => agent.id === activeTab.agentId) ?? null
    }, [activeTerminalId, agents, terminalTabs])
    const terminalCreateTarget =
        currentAgent?.status === 'running' &&
        currentAgent.runtime !== 'external'
            ? currentAgent
            : activeTerminalAgent?.status === 'running' &&
                activeTerminalAgent.runtime !== 'external'
              ? activeTerminalAgent
              : null
    const currentAgentChat = useMemo(
        () => getAgentChatAvailability(currentAgent),
        [currentAgent]
    )
    const sessions = useMemo(
        () => (selectedAgentId ? (sessionsByAgent[selectedAgentId] ?? []) : []),
        [selectedAgentId, sessionsByAgent]
    )
    const selectedSessionsFetched = Boolean(
        selectedAgentId &&
        (hasOwn(sessionsByAgent, selectedAgentId) ||
            hasOwn(sessionErrorByAgent, selectedAgentId))
    )
    const sessionsLoading = selectedAgentId
        ? (sessionLoadingByAgent[selectedAgentId] ?? !selectedSessionsFetched)
        : false
    const sessionsError = selectedAgentId
        ? (sessionErrorByAgent[selectedAgentId] ?? null)
        : null
    const currentLabel = location.pathname.startsWith('/settings')
        ? t('web.settingsMenu.settings')
        : location.pathname.startsWith('/skills')
          ? t('web.shell.skills')
          : location.pathname.startsWith('/automations')
            ? t('web.shell.automations')
            : (currentAgent?.name ?? t('common.appName'))
    /* New chat button is enabled when there's *any* ready agent to target.
       In a chat page the target is the selected agent; outside chat (Skills,
       Automations, Settings) the target is the first ready agent the user
       has — handleNewSession falls back to that automatically. Disabling
       the button on non-chat pages just because nothing's "selected" hides
       a feature the user legitimately wants to use from any page. */
    const firstReadyAgent = agents.find(
        (agent) => getAgentChatAvailability(agent).ready
    )
    const canCreateChat = currentAgentChat.ready || Boolean(firstReadyAgent)
    const sessionLookup = useMemo(() => {
        const next = new Map<
            string,
            {
                agent: SdkAgent
                session: ChatSessionSummary
            }
        >()

        agents.forEach((agent) => {
            ;(sessionsByAgent[agent.id] ?? []).forEach((session) => {
                next.set(session.id, { agent, session })
            })
        })

        return next
    }, [agents, sessionsByAgent])
    const pinnedSessionRows = useMemo(
        () =>
            Object.entries(pinnedSessions)
                .map(([sessionId, pin]) => {
                    const record = sessionLookup.get(sessionId)
                    if (!record) return null
                    return {
                        ...record,
                        pinnedAt: pin.pinnedAt
                    }
                })
                .filter(
                    (
                        value
                    ): value is {
                        agent: SdkAgent
                        pinnedAt: number
                        session: ChatSessionSummary
                    } => value !== null
                )
                .sort((a, b) => {
                    const pinnedDiff = b.pinnedAt - a.pinnedAt
                    if (pinnedDiff !== 0) return pinnedDiff
                    return (
                        new Date(b.session.updatedAt).getTime() -
                        new Date(a.session.updatedAt).getTime()
                    )
                }),
        [pinnedSessions, sessionLookup]
    )
    const pinnedAgentIds = useMemo(
        () =>
            Array.from(
                new Set(
                    Object.values(pinnedSessions)
                        .map((record) => record.agentId)
                        .filter((agentId): agentId is string =>
                            Boolean(agentId)
                        )
                )
            ),
        [pinnedSessions]
    )

    const refreshAgents = useCallback(
        async (options: RefreshAgentsOptions = {}): Promise<SdkAgent[]> => {
            const showLoading = options.showLoading ?? true
            if (showLoading) setAgentsLoading(true)
            setAgentsError(null)
            try {
                const rows = sortSidebarAgents(await client.agents.list())
                setAgents((previous) => reconcileSidebarAgents(previous, rows))
                return rows
            } catch (err) {
                setAgentsError((err as Error).message)
                if (options.clearOnError !== false) setAgents([])
                return []
            } finally {
                if (showLoading) setAgentsLoading(false)
            }
        },
        [client]
    )

    const refreshSessions = useCallback(async (): Promise<
        ChatSessionSummary[]
    > => {
        if (!selectedAgentId || (!currentAgent && !agentsLoading)) return []
        if (!currentAgent) return []
        return refreshSessionsForAgent(selectedAgentId)
    }, [agentsLoading, currentAgent, refreshSessionsForAgent, selectedAgentId])

    const {
        deleteAgent,
        deleting: deletingAgent,
        confirmDialog: deleteAgentDialog
    } = useDeleteAgent({
        onDeleted: () => {
            void refreshAgents({ showLoading: false })
        },
        onError: setSidebarError,
        // Only the agent you are currently looking at needs an escape route.
        redirectTo: (agent) =>
            agent.id === selectedAgentId ? '/workspace' : null
    })

    const refreshRuntimeAccess =
        useCallback(async (): Promise<RuntimeAccessSummary | null> => {
            try {
                const summary = await client.runtimeAccess.summary()
                setRuntimeAccess(summary)
                return summary
            } catch {
                return null
            }
        }, [client])

    const refreshDaemonHosts = useCallback(async (): Promise<void> => {
        try {
            const rows = await client.daemons.listHosts()
            setDaemonHosts(rows)
        } catch {
            setDaemonHosts([])
        }
    }, [client])

    const refreshSandboxes = useCallback(async (): Promise<void> => {
        try {
            const rows = await client.sandboxes.list()
            setSandboxes(rows)
        } catch {
            setSandboxes([])
        }
    }, [client])

    const initialAgentsLoadRef = useRef(true)
    const pollAgents = useCallback((): Promise<SdkAgent[]> => {
        if (initialAgentsLoadRef.current) {
            initialAgentsLoadRef.current = false
            return refreshAgents()
        }
        return refreshAgents({ clearOnError: false, showLoading: false })
    }, [refreshAgents])

    const handleSetKeepAlive = useCallback(
        async (runtimeId: string, enabled: boolean): Promise<void> => {
            await client.agentRuntimes.setKeepAlive(runtimeId, enabled)
            await refreshAgents({ showLoading: false })
        },
        [client, refreshAgents]
    )

    const dismissQuotaWarning = useCallback((code: string): void => {
        setQuotaWarnings((prev) => prev.filter((w) => w.code !== code))
        try {
            const key = `quota-dismissed:${code}:${new Date()
                .toISOString()
                .slice(0, 10)}`
            window.localStorage.setItem(key, '1')
        } catch {
            /* ignore */
        }
    }, [])

    useShellPolling(refreshRuntimeAccess, runtimeAccessRefreshIntervalMs, {
        minSpacingMs: runtimeAccessMinSpacingMs
    })

    const requestQuotaConflict = useCallback(
        (request: QuotaConflictRequest): void => {
            setQuotaConflict(request)
        },
        []
    )

    const markAgentReleasing = useCallback((agentId: string): void => {
        setReleasingAgentIds((prev) => {
            if (prev.has(agentId)) return prev
            const next = new Set(prev)
            next.add(agentId)
            return next
        })
        window.setTimeout(() => {
            setReleasingAgentIds((prev) => {
                if (!prev.has(agentId)) return prev
                const next = new Set(prev)
                next.delete(agentId)
                return next
            })
        }, 50_000)
    }, [])

    const refreshAutomationCount = useCallback(async (): Promise<void> => {
        try {
            const rows = await client.automations.list()
            setActiveAutomationCount(
                rows.filter((row) => row.status === 'active').length
            )
        } catch {
            setActiveAutomationCount(null)
        }
    }, [client])

    const getTerminalToken = useCallback(async (): Promise<string> => {
        return getToken()
    }, [getToken])

    const openTerminalForAgent = useCallback(
        (agent: SdkAgent, options: OpenTerminalOptions = {}): void => {
            if (agent.status !== 'running') return
            if (agent.runtime === 'external') return

            const openTab = (): void => {
                const index = terminalSerialRef.current + 1
                terminalSerialRef.current = index
                const id = `terminal-${Date.now()}-${index}`
                const tab: TerminalTabModel = {
                    agentId: agent.id,
                    agentName: agent.name,
                    cwdLabel: options.cwdLabel,
                    cwdPath: options.cwdPath,
                    cwdRootId: options.cwdRootId,
                    framework: agent.framework,
                    id,
                    index,
                    runtime: agent.runtime,
                    status: 'connecting'
                }

                setTerminalTabs((prev) => [...prev, tab])
                setActiveTerminalId(id)
                setTerminalDockVisible(true)
            }

            // Terminal is opt-in per sandbox (sprites runtime only). Rather than
            // opening the dock and letting the websocket surface a cryptic
            // "terminal is disabled" error, ask first and enable on confirm.
            if (agent.runtime !== 'sprites') {
                openTab()
                return
            }

            void (async (): Promise<void> => {
                let sandbox: SandboxSummary | null = null
                try {
                    const sandboxes = await client.sandboxes.list()
                    sandbox = agent.spriteName
                        ? (sandboxes.find(
                              (s) => s.spriteName === agent.spriteName
                          ) ?? null)
                        : null
                } catch {
                    sandbox = null
                }

                if (sandbox && !sandbox.terminalEnabled) {
                    const confirmed = await confirm({
                        title: t('web.terminal.enablePromptTitle'),
                        description: t('web.terminal.enablePromptBody'),
                        confirmLabel: t('web.terminal.enablePromptConfirm'),
                        cancelLabel: t('web.terminal.enablePromptCancel')
                    })
                    if (!confirmed) return
                    try {
                        await client.sandboxes.setTerminal(sandbox.id, true)
                    } catch {
                        // Enable failed; open anyway so the websocket surfaces
                        // the underlying error instead of failing silently.
                    }
                }

                openTab()
            })()
        },
        [client, confirm, t]
    )

    const handleTerminalStatusChange = useCallback(
        (tabId: string, status: TerminalConnectionStatus): void => {
            setTerminalTabs((prev) =>
                prev.map((tab) => (tab.id === tabId ? { ...tab, status } : tab))
            )
        },
        []
    )

    const handleCloseTerminalTab = useCallback((tabId: string): void => {
        setTerminalTabs((prev) => prev.filter((tab) => tab.id !== tabId))
    }, [])

    const handleCloseTerminalDock = useCallback((): void => {
        setTerminalTabs([])
        setActiveTerminalId(null)
        setTerminalDockVisible(false)
    }, [])

    const handleCreateTerminalFromDock = useCallback((): void => {
        if (terminalCreateTarget) openTerminalForAgent(terminalCreateTarget)
    }, [openTerminalForAgent, terminalCreateTarget])

    const toggleTerminalDock = useCallback((): void => {
        if (terminalDockVisible) {
            setTerminalDockVisible(false)
            return
        }

        if (terminalTabs.length > 0) {
            setTerminalDockVisible(true)
            return
        }

        if (terminalCreateTarget) openTerminalForAgent(terminalCreateTarget)
    }, [
        openTerminalForAgent,
        terminalCreateTarget,
        terminalDockVisible,
        terminalTabs.length
    ])

    const toggleSidebar = useCallback((): void => {
        const desktop =
            typeof window !== 'undefined' &&
            window.matchMedia('(min-width: 768px)').matches

        if (desktop) {
            setDesktopSidebarCollapsed((prev) => !prev)
            return
        }

        setDrawerOpen((prev) => !prev)
    }, [])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.repeat) return

            if (
                matchesKeyboardShortcut(event, {
                    code: 'KeyJ',
                    meta: true
                })
            ) {
                event.preventDefault()
                toggleTerminalDock()
                return
            }

            if (
                matchesKeyboardShortcut(event, {
                    code: 'KeyB',
                    meta: true
                })
            ) {
                event.preventDefault()
                toggleSidebar()
            }
        }

        document.addEventListener('keydown', handleKeyDown, true)

        return () => {
            document.removeEventListener('keydown', handleKeyDown, true)
        }
    }, [toggleSidebar, toggleTerminalDock])

    useShellPolling(pollAgents, agentListRefreshIntervalMs)

    useShellPolling(refreshDaemonHosts, daemonHostsRefreshIntervalMs)

    useShellPolling(refreshSandboxes, sandboxesRefreshIntervalMs)

    useEffect(() => {
        const stream = createReconnectingStream({
            connect: ({ onOpen, onDown }) => {
                console.log('[sprite-status] opening SSE')
                return client.agents.streamSpriteStatus({
                    onOpen: () => {
                        console.log('[sprite-status] SSE opened')
                        onOpen()
                    },
                    onSnapshot: (snapshot) => {
                        console.log(
                            '[sprite-status] snapshot',
                            snapshot.length,
                            'agents',
                            snapshot
                        )
                        setAgents((previous) =>
                            applyAgentStatusSnapshots(previous, snapshot)
                        )
                    },
                    onUpdate: (update) => {
                        console.log('[sprite-status] update', update)
                        setAgents((previous) =>
                            applyAgentStatusSnapshots(previous, [update])
                        )
                        if (update.spriteStatus !== 'running') {
                            setReleasingAgentIds((prev) => {
                                if (!prev.has(update.agentId)) return prev
                                const next = new Set(prev)
                                next.delete(update.agentId)
                                return next
                            })
                        }
                    },
                    onHostUpdate: (update) => {
                        setSandboxes((prev) =>
                            prev.map((s) =>
                                s.id === update.hostId
                                    ? {
                                          ...s,
                                          spriteStatus: update.spriteStatus
                                      }
                                    : s
                            )
                        )
                    },
                    onQuotaWarning: (event) => {
                        console.log('[sprite-status] quota-warning', event)
                        try {
                            const key = `quota-dismissed:${event.code}:${event.at.slice(0, 10)}`
                            if (window.localStorage.getItem(key)) return
                        } catch {
                            /* ignore */
                        }
                        setQuotaWarnings((prev) => {
                            const filtered = prev.filter(
                                (w) => w.code !== event.code
                            )
                            return [...filtered, event]
                        })
                        void refreshRuntimeAccess()
                    },
                    onError: (err) => {
                        console.error('[sprite-status] SSE error', err)
                        onDown()
                    },
                    onClose: () => {
                        console.log('[sprite-status] SSE closed')
                        onDown()
                    }
                })
            },
            onReconnected: () => {
                void refreshAgents({ clearOnError: false, showLoading: false })
                void refreshSandboxes()
            },
            isVisible: () => document.visibilityState === 'visible'
        })
        stream.start()
        const handleOnline = (): void => stream.notifyOnline()
        const handleVisibilityChange = (): void => {
            if (document.visibilityState === 'visible') stream.notifyVisible()
        }
        window.addEventListener('online', handleOnline)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.removeEventListener('online', handleOnline)
            document.removeEventListener(
                'visibilitychange',
                handleVisibilityChange
            )
            stream.dispose()
        }
    }, [client, refreshAgents, refreshSandboxes, refreshRuntimeAccess])

    useEffect(() => {
        void refreshAutomationCount()
    }, [location.pathname, refreshAutomationCount])

    useEffect(() => {
        if (terminalTabs.length === 0) {
            if (activeTerminalId) setActiveTerminalId(null)
            if (terminalDockVisible) setTerminalDockVisible(false)
            return
        }

        if (
            !activeTerminalId ||
            !terminalTabs.some((tab) => tab.id === activeTerminalId)
        ) {
            setActiveTerminalId(terminalTabs[terminalTabs.length - 1].id)
        }
    }, [activeTerminalId, terminalDockVisible, terminalTabs])

    useEffect(() => {
        // Avoid clearing persisted expansion state before the first agents load completes.
        if (agentsLoading) return

        const validIds = new Set(agents.map((agent) => agent.id))
        pruneSessionCacheToAgentIds(agents.map((agent) => agent.id))
        setExpandedByAgent((prev) =>
            Object.fromEntries(
                Object.entries(prev).filter(([agentId]) =>
                    validIds.has(agentId)
                )
            )
        )
        setPinnedSessions((prev) => {
            let changed = false
            const next = Object.fromEntries(
                Object.entries(prev).filter(([, pin]) => {
                    const keep = !pin.agentId || validIds.has(pin.agentId)
                    if (!keep) changed = true
                    return keep
                })
            )
            return changed ? next : prev
        })
    }, [agents, agentsLoading, pruneSessionCacheToAgentIds])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(
            expandedStateStorageKey,
            JSON.stringify(expandedByAgent)
        )
    }, [expandedByAgent])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(
            pinnedSessionsStorageKey,
            JSON.stringify(pinnedSessions)
        )
    }, [pinnedSessions])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(
            sidebarSectionStateStorageKey,
            JSON.stringify(sidebarSectionState)
        )
    }, [sidebarSectionState])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(
            sidebarCollapsedStorageKey,
            String(desktopSidebarCollapsed)
        )
    }, [desktopSidebarCollapsed])

    useEffect(() => {
        if (!selectedAgentId || agentsLoading || !currentAgent) return
        ensureSessionsForAgent(selectedAgentId)
    }, [agentsLoading, currentAgent, ensureSessionsForAgent, selectedAgentId])

    useEffect(() => {
        if (agentsLoading || agents.length === 0) return

        const validIds = new Set(agents.map((agent) => agent.id))
        const agentIds = new Set<string>()
        Object.entries(expandedByAgent).forEach(([agentId, expanded]) => {
            if (expanded && validIds.has(agentId)) agentIds.add(agentId)
        })
        pinnedAgentIds.forEach((agentId) => {
            if (validIds.has(agentId)) agentIds.add(agentId)
        })
        agentIds.forEach(ensureSessionsForAgent)
    }, [
        agents,
        agentsLoading,
        ensureSessionsForAgent,
        expandedByAgent,
        pinnedAgentIds
    ])

    useEffect(() => {
        setPinnedSessions((prev) => {
            let changed = false
            const next = { ...prev }

            Object.entries(sessionsByAgent).forEach(([agentId, rows]) => {
                rows.forEach((session) => {
                    const pin = next[session.id]
                    if (!pin || pin.agentId) return
                    next[session.id] = {
                        ...pin,
                        agentId
                    }
                    changed = true
                })
            })

            return changed ? next : prev
        })
    }, [sessionsByAgent])

    useEffect(() => {
        setDrawerOpen(false)
    }, [location.pathname, location.search])

    useEffect(() => {
        setConfirmingDeleteSessionId(null)
    }, [location.pathname, location.search])

    useEffect(() => {
        if (!chatMatch) return
        storeLastChatLocation({
            path: `${location.pathname}${location.search}`,
            agentId: currentAgent?.id ?? null,
            agentName: currentAgent?.name ?? null
        })
    }, [chatMatch, currentAgent, location.pathname, location.search])

    const toggleAgentExpanded = useCallback((agentId: string): void => {
        setExpandedByAgent((prev) => ({
            ...prev,
            [agentId]: !(prev[agentId] ?? false)
        }))
    }, [])

    const toggleShowAllSessions = useCallback((agentId: string): void => {
        setShowAllSessionsByAgent((prev) => ({
            ...prev,
            [agentId]: !(prev[agentId] ?? false)
        }))
    }, [])

    const handleOpenAgent = useCallback(
        (agentId: string): void => {
            setExpandedByAgent((prev) =>
                prev[agentId] ? prev : { ...prev, [agentId]: true }
            )
            navigate(`/agents/${agentId}/chat`)
        },
        [navigate]
    )

    const togglePinnedSession = useCallback(
        (agentId: string, sessionId: string): void => {
            setSidebarError(null)
            setConfirmingDeleteSessionId((prev) =>
                prev === sessionId ? null : prev
            )
            setPinnedSessions((prev) =>
                hasOwn(prev, sessionId)
                    ? omitRecordKey(prev, sessionId)
                    : {
                          ...prev,
                          [sessionId]: {
                              agentId,
                              pinnedAt: Date.now()
                          }
                      }
            )
        },
        []
    )

    const toggleSidebarSection = useCallback(
        (section: SidebarSectionKey): void => {
            setSidebarSectionState((prev) => ({
                ...prev,
                [section]: !prev[section]
            }))
        },
        []
    )

    const requestDeleteSession = useCallback((sessionId: string): void => {
        setSidebarError(null)
        setConfirmingDeleteSessionId((prev) =>
            prev === sessionId ? null : sessionId
        )
    }, [])

    const handleNewSession = useCallback(
        (agentId?: string | null): void => {
            /* An explicit agentId means the chat was started from a
               specific agent (its "+" button), so the composer's agent
               picker stays hidden. The global "New chat" button passes
               nothing: the agent is inferred (current chat, else the
               first ready one — e.g. when invoked from /skills, /settings),
               so ?pickAgent=1 offers the picker to retarget in place. */
            const explicit = agentId != null
            const resolvedId =
                agentId ??
                selectedAgentId ??
                agents.find((agent) => getAgentChatAvailability(agent).ready)
                    ?.id ??
                null
            if (!resolvedId) return
            const targetAgent =
                agents.find((agent) => agent.id === resolvedId) ?? null
            const availability = getAgentChatAvailability(targetAgent)
            if (!availability.ready) return
            setExpandedByAgent((prev) => ({
                ...prev,
                [resolvedId]: true
            }))
            navigate(
                `/agents/${resolvedId}/chat?draft=1${explicit ? '' : '&pickAgent=1'}`
            )
        },
        [agents, navigate, selectedAgentId]
    )

    const handleSessionRenamed = useCallback(
        (agentId: string, _sessionId: string): void => {
            void refreshSessionsForAgent(agentId)
        },
        [refreshSessionsForAgent]
    )

    const handleDeleteSession = useCallback(
        async (agentId: string, session: ChatSessionSummary): Promise<void> => {
            setSidebarError(null)
            setConfirmingDeleteSessionId(null)
            setSessionMutating((prev) => ({
                ...prev,
                [session.id]: true
            }))

            try {
                await client.chat.deleteSession(agentId, session.id, {
                    force: true
                })
                setPinnedSessions((prev) => omitRecordKey(prev, session.id))
                const remaining = await refreshSessionsForAgent(agentId)

                if (
                    selectedAgentId === agentId &&
                    activeSessionId === session.id
                ) {
                    const nextSessionId = remaining[0]?.id ?? null
                    navigate(
                        nextSessionId
                            ? `/agents/${agentId}/chat?sessionId=${nextSessionId}`
                            : `/agents/${agentId}/chat?draft=1`,
                        { replace: true }
                    )
                }
            } catch (err) {
                setSidebarError((err as Error).message)
            } finally {
                setSessionMutating((prev) => omitRecordKey(prev, session.id))
            }
        },
        [
            activeSessionId,
            client,
            navigate,
            refreshSessionsForAgent,
            setConfirmingDeleteSessionId,
            selectedAgentId
        ]
    )

    const renderSidebar = ({
        collapsed,
        showCollapseToggle
    }: {
        collapsed: boolean
        showCollapseToggle: boolean
    }): ReactNode => {
        const newChatLabel = t('web.shell.newChat')
        const newAgentLabel = t('web.shell.newAgent')
        const customizeLabel = t('web.shell.customize')
        const automationsLabel = t('web.shell.automations')
        const readOnlyLabel = t('web.shell.readOnly')
        const concurrencyLimit = runtimeAccess?.plan.maxConcurrentActive ?? null
        const concurrencyFull =
            concurrencyLimit != null &&
            countActiveSandboxes(agents, sandboxes) >= concurrencyLimit

        return (
            <div
                className={[
                    'rail-vt-pane flex h-full flex-col px-2 pb-2 pt-3'
                ].join(' ')}
            >
                <div
                    className={[
                        collapsed ? 'flex flex-col items-center' : ''
                    ].join(' ')}
                >
                    {showCollapseToggle && (
                        <div
                            className={[
                                'mb-2 flex',
                                collapsed
                                    ? 'flex-col items-center gap-2'
                                    : 'items-center justify-between [container-name:railhead] [container-type:inline-size]'
                            ].join(' ')}
                        >
                            {collapsed ? (
                                <Link
                                    to='/?stay=1'
                                    aria-label={t('common.appName')}
                                    className='text-fg flex items-center justify-center'
                                >
                                    <BrandMark className='block h-7 w-auto' />
                                </Link>
                            ) : (
                                <Link
                                    to='/?stay=1'
                                    aria-label={t('common.appName')}
                                    className='text-fg inline-flex min-w-0 items-center gap-1 px-1 text-[19px] font-medium tracking-[-0.015em]'
                                >
                                    <BrandMark className='block h-7 w-auto shrink-0' />
                                    <span className='rail-brand-name whitespace-nowrap'>
                                        {t('common.appName')}
                                    </span>
                                    <SignupBetaBadge />
                                </Link>
                            )}
                            <ShortcutTooltip
                                label={
                                    collapsed
                                        ? t('web.shell.expandSidebar')
                                        : t('web.shell.collapseSidebar')
                                }
                                placement={collapsed ? 'right' : 'bottom-end'}
                                shortcut='Cmd+B'
                            >
                                <button
                                    type='button'
                                    aria-label={
                                        collapsed
                                            ? t('web.shell.expandSidebar')
                                            : t('web.shell.collapseSidebar')
                                    }
                                    onClick={() =>
                                        setDesktopSidebarCollapsed(
                                            (prev) => !prev
                                        )
                                    }
                                    className='text-subtle hover:text-fg hover:bg-rail-hover rounded-pill inline-flex h-9 w-9 shrink-0 items-center justify-center transition-colors'
                                >
                                    <SidebarToggleIcon
                                        className={[
                                            'h-[18px] w-[18px] transition-transform',
                                            collapsed
                                                ? 'text-fg rotate-180'
                                                : ''
                                        ].join(' ')}
                                    />
                                </button>
                            </ShortcutTooltip>
                        </div>
                    )}

                    <ShortcutTooltip
                        label={collapsed ? newChatLabel : undefined}
                        placement='right'
                    >
                        <button
                            type='button'
                            onClick={() => {
                                handleNewSession()
                            }}
                            disabled={!canCreateChat}
                            className={
                                collapsed
                                    ? railIconButtonClass()
                                    : 'text-ui text-muted hover:text-fg hover:bg-rail-hover flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45'
                            }
                        >
                            <PlusIcon className={iconClass} />
                            {collapsed ? (
                                <span className='sr-only'>{newChatLabel}</span>
                            ) : (
                                newChatLabel
                            )}
                        </button>
                    </ShortcutTooltip>
                    <ShortcutTooltip
                        label={collapsed ? customizeLabel : undefined}
                        placement='right'
                    >
                        <button
                            type='button'
                            onClick={() => {
                                navigateWithRailTransition(
                                    navigate,
                                    '/skills/library',
                                    'forward'
                                )
                            }}
                            className={[
                                collapsed
                                    ? railIconButtonClass(
                                          Boolean(customizeMatch)
                                      )
                                    : [
                                          'text-ui flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left font-medium transition-colors',
                                          customizeMatch
                                              ? 'text-fg bg-rail-hover'
                                              : 'text-muted hover:text-fg hover:bg-rail-hover'
                                      ].join(' '),
                                collapsed ? 'mt-2' : 'mt-1'
                            ].join(' ')}
                        >
                            <CustomizeIcon className={iconClass} />
                            {collapsed ? (
                                <span className='sr-only'>
                                    {customizeLabel}
                                </span>
                            ) : (
                                customizeLabel
                            )}
                        </button>
                    </ShortcutTooltip>
                    <ShortcutTooltip
                        label={collapsed ? automationsLabel : undefined}
                        placement='right'
                    >
                        <Link
                            to='/automations'
                            className={[
                                collapsed
                                    ? railIconButtonClass(
                                          Boolean(automationsMatch)
                                      )
                                    : [
                                          'text-ui flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left font-medium transition-colors',
                                          automationsMatch
                                              ? 'text-fg bg-rail-hover'
                                              : 'text-muted hover:text-fg hover:bg-rail-hover'
                                      ].join(' '),
                                collapsed ? 'mt-2' : 'mt-1'
                            ].join(' ')}
                        >
                            <AutomationsIcon className={iconClass} />
                            {collapsed ? (
                                <span className='sr-only'>
                                    {automationsLabel}
                                </span>
                            ) : (
                                <>
                                    <span className='min-w-0 flex-1'>
                                        {automationsLabel}
                                    </span>
                                    {activeAutomationCount !== null &&
                                        activeAutomationCount > 0 && (
                                            <span className='tag tag-neutral tabular-nums'>
                                                {activeAutomationCount}
                                            </span>
                                        )}
                                </>
                            )}
                        </Link>
                    </ShortcutTooltip>
                </div>

                <div className='flex min-h-0 flex-1 flex-col pt-2'>
                    {sidebarError &&
                        (collapsed ? (
                            <ShortcutTooltip
                                label={sidebarError}
                                placement='right'
                                className='mx-auto mb-3'
                            >
                                <div className='text-ui text-workflow-ship bg-danger-bg rounded-pill flex h-10 w-10 items-center justify-center font-medium'>
                                    !
                                </div>
                            </ShortcutTooltip>
                        ) : (
                            <div className='workbench-alert-error mx-1 mb-3'>
                                {sidebarError}
                            </div>
                        ))}

                    <div className='scrollbar-hidden min-h-0 flex-1 overflow-y-auto'>
                        {!collapsed && pinnedSessionRows.length > 0 && (
                            <section className='mb-2'>
                                <SidebarSectionHeader
                                    label={t('web.shell.pinned')}
                                    collapsed={sidebarSectionState.pinned}
                                    onToggle={() => {
                                        toggleSidebarSection('pinned')
                                    }}
                                />

                                {!sidebarSectionState.pinned && (
                                    <div className='space-y-0.5 px-1'>
                                        {pinnedSessionRows.map(
                                            ({ agent, session }) => (
                                                <SidebarSessionRow
                                                    key={session.id}
                                                    active={
                                                        agent.id ===
                                                            selectedAgentId &&
                                                        session.id ===
                                                            activeSessionId
                                                    }
                                                    agent={agent}
                                                    confirmingDelete={
                                                        confirmingDeleteSessionId ===
                                                        session.id
                                                    }
                                                    deleting={
                                                        sessionMutating[
                                                            session.id
                                                        ] ?? false
                                                    }
                                                    onConfirmDelete={() => {
                                                        void handleDeleteSession(
                                                            agent.id,
                                                            session
                                                        )
                                                    }}
                                                    onSelect={() => {
                                                        setConfirmingDeleteSessionId(
                                                            null
                                                        )
                                                    }}
                                                    onRequestDelete={() => {
                                                        requestDeleteSession(
                                                            session.id
                                                        )
                                                    }}
                                                    onSessionRenamed={
                                                        handleSessionRenamed
                                                    }
                                                    pinned={true}
                                                    session={session}
                                                    onTogglePinned={() => {
                                                        togglePinnedSession(
                                                            agent.id,
                                                            session.id
                                                        )
                                                    }}
                                                />
                                            )
                                        )}
                                    </div>
                                )}
                            </section>
                        )}

                        <section className='flex min-h-0 flex-1 flex-col'>
                            {collapsed ? (
                                <div className='mb-2 flex flex-col items-center gap-2'>
                                    {pinnedSessionRows.length > 0 && (
                                        <CollapsedPinnedSessionsMenu
                                            activeSessionId={activeSessionId}
                                            confirmingDeleteSessionId={
                                                confirmingDeleteSessionId
                                            }
                                            onClearDeleteConfirmation={() => {
                                                setConfirmingDeleteSessionId(
                                                    null
                                                )
                                            }}
                                            rows={pinnedSessionRows}
                                            onDeleteSession={(
                                                agentId,
                                                session
                                            ) => {
                                                void handleDeleteSession(
                                                    agentId,
                                                    session
                                                )
                                            }}
                                            onRequestDeleteSession={(
                                                sessionId
                                            ) => {
                                                requestDeleteSession(sessionId)
                                            }}
                                            onSessionRenamed={
                                                handleSessionRenamed
                                            }
                                            onTogglePinnedSession={(
                                                agentId,
                                                sessionId
                                            ) => {
                                                togglePinnedSession(
                                                    agentId,
                                                    sessionId
                                                )
                                            }}
                                            sessionMutating={sessionMutating}
                                        />
                                    )}

                                    <ShortcutTooltip
                                        label={newAgentLabel}
                                        placement='right'
                                    >
                                        <Link
                                            to='/agents/new'
                                            aria-label={newAgentLabel}
                                            className={railIconButtonClass()}
                                        >
                                            <LucidePlusIcon className='h-3.5 w-3.5 shrink-0' />
                                        </Link>
                                    </ShortcutTooltip>
                                </div>
                            ) : (
                                <SidebarSectionHeader
                                    label={t('web.shell.agents')}
                                    collapsed={sidebarSectionState.agents}
                                    onToggle={() => {
                                        toggleSidebarSection('agents')
                                    }}
                                    meta={
                                        <ConcurrencyIndicator
                                            agents={agents}
                                            sandboxes={sandboxes}
                                            limit={
                                                runtimeAccess?.plan
                                                    .maxConcurrentActive ?? null
                                            }
                                            planName={
                                                runtimeAccess?.plan.name ?? null
                                            }
                                            releasingIds={releasingAgentIds}
                                            activeHoursThisPeriod={
                                                runtimeAccess?.activeHoursThisPeriod ??
                                                null
                                            }
                                            activeHoursLimit={
                                                runtimeAccess?.activeHoursLimit ??
                                                null
                                            }
                                            usagePeriodEnd={
                                                runtimeAccess?.usagePeriod
                                                    .end ?? null
                                            }
                                            onSetKeepAlive={handleSetKeepAlive}
                                        />
                                    }
                                    action={
                                        <div className='flex items-center gap-0.5'>
                                            {agents.length > 0 && (
                                                <AgentSidebarControls
                                                    agents={agents}
                                                    config={agentsViewConfig}
                                                    hostNames={hostNames}
                                                    onChange={
                                                        setAgentsViewConfig
                                                    }
                                                />
                                            )}
                                            <ShortcutTooltip
                                                label={newAgentLabel}
                                            >
                                                <Link
                                                    to='/agents/new'
                                                    aria-label={newAgentLabel}
                                                    className='text-subtle hover:text-fg hover:bg-rail-hover rounded-pill inline-flex h-9 w-9 items-center justify-center transition-colors'
                                                >
                                                    <LucidePlusIcon className='h-[18px] w-[18px] shrink-0' />
                                                </Link>
                                            </ShortcutTooltip>
                                        </div>
                                    }
                                />
                            )}

                            {(collapsed || !sidebarSectionState.agents) && (
                                <div className='min-h-0'>
                                    {agentsError &&
                                        (collapsed ? (
                                            <ShortcutTooltip
                                                label={agentsError}
                                                placement='right'
                                                className='mx-auto mb-3'
                                            >
                                                <div className='text-ui text-workflow-ship bg-danger-bg rounded-pill flex h-10 w-10 items-center justify-center font-medium'>
                                                    !
                                                </div>
                                            </ShortcutTooltip>
                                        ) : (
                                            <div className='workbench-alert-error mx-1 mb-3'>
                                                {agentsError}
                                            </div>
                                        ))}
                                    {agentsLoading && !agentsError && (
                                        <div
                                            className={
                                                collapsed ? '' : 'mx-1 mb-3'
                                            }
                                        >
                                            <AgentRailGhost
                                                collapsed={collapsed}
                                            />
                                        </div>
                                    )}
                                    {!collapsed &&
                                        !agentsLoading &&
                                        agents.length === 0 &&
                                        !agentsError && (
                                            <div className='text-ui text-muted shadow-ring-light bg-surface/75 mx-1 rounded-md px-3 py-3'>
                                                {t('web.shell.noAgents')}
                                            </div>
                                        )}
                                    {!collapsed &&
                                        !agentsLoading &&
                                        agents.length > 0 &&
                                        agentsView.visibleCount === 0 &&
                                        !agentsError && (
                                            <div className='text-ui text-muted shadow-ring-light bg-surface/75 mx-1 rounded-md px-3 py-3'>
                                                {t(
                                                    'web.shell.agentsView.emptyFiltered'
                                                )}
                                            </div>
                                        )}

                                    {flattenAgentGroups(
                                        agentsView.groups,
                                        !collapsed,
                                        collapsedAgentGroups,
                                        t
                                    ).map((item) => {
                                        if (item.kind === 'header') {
                                            return (
                                                <button
                                                    key={item.key}
                                                    type='button'
                                                    onClick={() => {
                                                        toggleAgentGroupCollapsed(
                                                            item.key
                                                        )
                                                    }}
                                                    aria-expanded={
                                                        !item.collapsed
                                                    }
                                                    className='text-subtle hover:text-fg flex w-full items-center gap-1 rounded-md px-2.5 pb-1 pt-3 transition-colors first:pt-1'
                                                >
                                                    <span className='workbench-kicker'>
                                                        {item.label}
                                                    </span>
                                                    <ChevronDownIcon
                                                        className={[
                                                            'h-3.5 w-3.5 shrink-0 transition-transform',
                                                            item.collapsed
                                                                ? '-rotate-90'
                                                                : ''
                                                        ].join(' ')}
                                                    />
                                                </button>
                                            )
                                        }
                                        const agent = item.agent
                                        const active =
                                            agent.id === selectedAgentId
                                        const availability =
                                            getAgentChatAvailability(agent)
                                        const daemonStopped =
                                            agent.runtime === 'daemon' &&
                                            agent.status === 'stopped'
                                        const showReadOnlyBadge =
                                            !availability.ready &&
                                            !daemonStopped &&
                                            availability.code !== 'cli-upgrade'
                                        const sidebarToggleDisabled =
                                            !availability.ready &&
                                            availability.code !== 'cli-upgrade'
                                        const agentSessions =
                                            sessionsByAgent[agent.id] ?? []
                                        const visibleAgentSessions =
                                            agentSessions.filter(
                                                (session) =>
                                                    !hasOwn(
                                                        pinnedSessions,
                                                        session.id
                                                    )
                                            )
                                        const hiddenPinnedSessionCount =
                                            agentSessions.length -
                                            visibleAgentSessions.length
                                        const showAllSessions =
                                            showAllSessionsByAgent[agent.id] ??
                                            false
                                        const sessionOverflowCount = Math.max(
                                            0,
                                            visibleAgentSessions.length -
                                                sidebarSessionLimit
                                        )
                                        const renderedAgentSessions =
                                            showAllSessions
                                                ? visibleAgentSessions
                                                : visibleAgentSessions.slice(
                                                      0,
                                                      sidebarSessionLimit
                                                  )
                                        const agentExpanded =
                                            expandedByAgent[agent.id] ?? false
                                        const agentSessionsFetched =
                                            hasOwn(sessionsByAgent, agent.id) ||
                                            hasOwn(
                                                sessionErrorByAgent,
                                                agent.id
                                            )
                                        const agentSessionsLoading =
                                            sessionLoadingByAgent[agent.id] ??
                                            !agentSessionsFetched
                                        const agentSessionsError =
                                            sessionErrorByAgent[agent.id] ??
                                            null
                                        const occupiesSlot =
                                            agent.runtime === 'sprites' &&
                                            agent.spriteStatus === 'running'
                                        const isReleasing =
                                            releasingAgentIds.has(agent.id)
                                        const agentTitle = `${agent.name} · ${frameworkLabel(
                                            agent.framework
                                        )} · ${agent.status}${showReadOnlyBadge ? ` · ${readOnlyLabel}` : ''}`

                                        return (
                                            <div
                                                key={agent.id}
                                                className={[
                                                    agentBlockClass(),
                                                    collapsed
                                                        ? 'flex justify-center'
                                                        : ''
                                                ].join(' ')}
                                            >
                                                {collapsed ? (
                                                    <CollapsedAgentSessionsMenu
                                                        active={active}
                                                        activeSessionId={
                                                            activeSessionId
                                                        }
                                                        agent={agent}
                                                        confirmingDeleteSessionId={
                                                            confirmingDeleteSessionId
                                                        }
                                                        hiddenPinnedSessionCount={
                                                            hiddenPinnedSessionCount
                                                        }
                                                        onClearDeleteConfirmation={() => {
                                                            setConfirmingDeleteSessionId(
                                                                null
                                                            )
                                                        }}
                                                        onCreateSession={() => {
                                                            handleNewSession(
                                                                agent.id
                                                            )
                                                        }}
                                                        onDeleteSession={(
                                                            session
                                                        ) => {
                                                            void handleDeleteSession(
                                                                agent.id,
                                                                session
                                                            )
                                                        }}
                                                        onOpenDetails={() => {
                                                            navigate(
                                                                `/agents/${agent.id}`
                                                            )
                                                        }}
                                                        onOpenSessions={() => {
                                                            ensureSessionsForAgent(
                                                                agent.id
                                                            )
                                                        }}
                                                        onRequestDeleteSession={(
                                                            sessionId
                                                        ) => {
                                                            requestDeleteSession(
                                                                sessionId
                                                            )
                                                        }}
                                                        onRetrySessions={() => {
                                                            void refreshSessionsForAgent(
                                                                agent.id
                                                            )
                                                        }}
                                                        onSessionRenamed={
                                                            handleSessionRenamed
                                                        }
                                                        onTogglePinnedSession={(
                                                            agentId,
                                                            sessionId
                                                        ) => {
                                                            togglePinnedSession(
                                                                agentId,
                                                                sessionId
                                                            )
                                                        }}
                                                        pinnedSessions={
                                                            pinnedSessions
                                                        }
                                                        sessionMutating={
                                                            sessionMutating
                                                        }
                                                        sessions={
                                                            visibleAgentSessions
                                                        }
                                                        sessionsError={
                                                            agentSessionsError
                                                        }
                                                        sessionsLoading={
                                                            agentSessionsLoading
                                                        }
                                                    />
                                                ) : (
                                                    <>
                                                        <div
                                                            className={agentRailRowClass(
                                                                menuOpenAgentId ===
                                                                    agent.id
                                                            )}
                                                        >
                                                            <ShortcutTooltip
                                                                label={
                                                                    agentTitle
                                                                }
                                                                className='min-w-0 flex-1'
                                                            >
                                                                <button
                                                                    type='button'
                                                                    onClick={() => {
                                                                        handleOpenAgent(
                                                                            agent.id
                                                                        )
                                                                    }}
                                                                    aria-label={t(
                                                                        'web.shell.openAgent',
                                                                        {
                                                                            name: agent.name
                                                                        }
                                                                    )}
                                                                    disabled={
                                                                        sidebarToggleDisabled
                                                                    }
                                                                    className={agentToggleClass()}
                                                                >
                                                                    <FrameworkLogoIcon
                                                                        framework={
                                                                            agent.framework
                                                                        }
                                                                    />
                                                                    <div className='flex min-w-0 flex-1 items-center gap-2'>
                                                                        <div className='text-ui text-subtle truncate font-medium'>
                                                                            {
                                                                                agent.name
                                                                            }
                                                                        </div>
                                                                        <AgentStatusDot
                                                                            agent={
                                                                                agent
                                                                            }
                                                                            tone={
                                                                                occupiesSlot
                                                                                    ? `${concurrencyFull ? 'bg-warning' : 'bg-success'}${isReleasing ? ' animate-pulse' : ''}`
                                                                                    : undefined
                                                                            }
                                                                        />
                                                                    </div>
                                                                    <span className='sr-only'>
                                                                        {frameworkLabel(
                                                                            agent.framework
                                                                        )}{' '}
                                                                        {
                                                                            agent.status
                                                                        }
                                                                    </span>
                                                                </button>
                                                            </ShortcutTooltip>
                                                            <div
                                                                className={[
                                                                    'items-center gap-0.5 group-hover/row:flex',
                                                                    menuOpenAgentId ===
                                                                    agent.id
                                                                        ? 'flex'
                                                                        : 'hidden'
                                                                ].join(' ')}
                                                            >
                                                                <button
                                                                    type='button'
                                                                    aria-label={
                                                                        agentExpanded
                                                                            ? t(
                                                                                  'web.shell.collapseAgent',
                                                                                  {
                                                                                      name: agent.name
                                                                                  }
                                                                              )
                                                                            : t(
                                                                                  'web.shell.expandAgent',
                                                                                  {
                                                                                      name: agent.name
                                                                                  }
                                                                              )
                                                                    }
                                                                    aria-expanded={
                                                                        agentExpanded
                                                                    }
                                                                    onClick={() => {
                                                                        toggleAgentExpanded(
                                                                            agent.id
                                                                        )
                                                                    }}
                                                                    className={rowActionButtonClass()}
                                                                >
                                                                    <ChevronDownIcon
                                                                        className={[
                                                                            'h-3.5 w-3.5 transition-transform',
                                                                            agentExpanded
                                                                                ? ''
                                                                                : '-rotate-90'
                                                                        ].join(
                                                                            ' '
                                                                        )}
                                                                    />
                                                                </button>
                                                                <ShortcutTooltip
                                                                    label={t(
                                                                        'web.shell.newChatForAgent',
                                                                        {
                                                                            name: agent.name
                                                                        }
                                                                    )}
                                                                >
                                                                    <button
                                                                        type='button'
                                                                        aria-label={t(
                                                                            'web.shell.newChatForAgent',
                                                                            {
                                                                                name: agent.name
                                                                            }
                                                                        )}
                                                                        onClick={() => {
                                                                            handleNewSession(
                                                                                agent.id
                                                                            )
                                                                        }}
                                                                        disabled={
                                                                            !availability.ready
                                                                        }
                                                                        className={rowActionButtonClass()}
                                                                    >
                                                                        <PlusIcon className='h-3.5 w-3.5' />
                                                                    </button>
                                                                </ShortcutTooltip>
                                                                <AgentActionsMenu
                                                                    agent={
                                                                        agent
                                                                    }
                                                                    items={buildAgentMenuItems(
                                                                        agent,
                                                                        t,
                                                                        {
                                                                            onRename:
                                                                                () =>
                                                                                    setRenameAgent(
                                                                                        agent
                                                                                    ),
                                                                            onModelProvider:
                                                                                () =>
                                                                                    setCredentialsAgent(
                                                                                        agent
                                                                                    ),
                                                                            onAgentSettings:
                                                                                () =>
                                                                                    navigate(
                                                                                        agentSettingsPath(
                                                                                            agent.id
                                                                                        )
                                                                                    ),
                                                                            onOpenDashboard:
                                                                                agentDashboardOpener(
                                                                                    agent,
                                                                                    client.agentRuntimes,
                                                                                    t
                                                                                ),
                                                                            onOpenRuntime:
                                                                                (
                                                                                    runtimeId
                                                                                ) =>
                                                                                    navigate(
                                                                                        `/settings/runtimes/${runtimeId}`
                                                                                    ),
                                                                            onDelete:
                                                                                () => {
                                                                                    void deleteAgent(
                                                                                        agent
                                                                                    )
                                                                                }
                                                                        },
                                                                        {
                                                                            deleting:
                                                                                deletingAgent
                                                                        }
                                                                    )}
                                                                    onOpenChange={(
                                                                        menuOpen
                                                                    ) =>
                                                                        setMenuOpenAgentId(
                                                                            (
                                                                                prev
                                                                            ) =>
                                                                                menuOpen
                                                                                    ? agent.id
                                                                                    : prev ===
                                                                                        agent.id
                                                                                      ? null
                                                                                      : prev
                                                                        )
                                                                    }
                                                                />
                                                            </div>
                                                        </div>

                                                        {agentExpanded && (
                                                            <div className='ml-7 mt-0.5'>
                                                                {agentSessionsError && (
                                                                    <div className='workbench-alert-error mx-2 mb-2'>
                                                                        {
                                                                            agentSessionsError
                                                                        }
                                                                    </div>
                                                                )}

                                                                {!agentSessionsLoading &&
                                                                    visibleAgentSessions.length ===
                                                                        0 &&
                                                                    !agentSessionsError && (
                                                                        <div className='text-ui text-subtle px-2.5 py-1.5'>
                                                                            {hiddenPinnedSessionCount >
                                                                            0
                                                                                ? t(
                                                                                      'web.shell.allChatsPinned'
                                                                                  )
                                                                                : t(
                                                                                      'web.shell.noChatsYet'
                                                                                  )}
                                                                        </div>
                                                                    )}

                                                                {agentSessionsLoading && (
                                                                    <div className='text-ui text-subtle px-2.5 py-1.5'>
                                                                        {t(
                                                                            'web.shell.loadingChats'
                                                                        )}
                                                                    </div>
                                                                )}

                                                                <div className='-ml-7 w-[calc(100%+1.75rem)] space-y-0.5 [&>*]:pl-7'>
                                                                    {renderedAgentSessions.map(
                                                                        (
                                                                            session
                                                                        ) => (
                                                                            <SidebarSessionRow
                                                                                key={
                                                                                    session.id
                                                                                }
                                                                                active={
                                                                                    active &&
                                                                                    session.id ===
                                                                                        activeSessionId
                                                                                }
                                                                                agent={
                                                                                    agent
                                                                                }
                                                                                confirmingDelete={
                                                                                    confirmingDeleteSessionId ===
                                                                                    session.id
                                                                                }
                                                                                deleting={
                                                                                    sessionMutating[
                                                                                        session
                                                                                            .id
                                                                                    ] ??
                                                                                    false
                                                                                }
                                                                                onConfirmDelete={() => {
                                                                                    void handleDeleteSession(
                                                                                        agent.id,
                                                                                        session
                                                                                    )
                                                                                }}
                                                                                onSelect={() => {
                                                                                    setConfirmingDeleteSessionId(
                                                                                        null
                                                                                    )
                                                                                }}
                                                                                onRequestDelete={() => {
                                                                                    requestDeleteSession(
                                                                                        session.id
                                                                                    )
                                                                                }}
                                                                                onSessionRenamed={
                                                                                    handleSessionRenamed
                                                                                }
                                                                                pinned={hasOwn(
                                                                                    pinnedSessions,
                                                                                    session.id
                                                                                )}
                                                                                session={
                                                                                    session
                                                                                }
                                                                                onTogglePinned={() => {
                                                                                    togglePinnedSession(
                                                                                        agent.id,
                                                                                        session.id
                                                                                    )
                                                                                }}
                                                                            />
                                                                        )
                                                                    )}
                                                                    {sessionOverflowCount >
                                                                        0 && (
                                                                        <button
                                                                            type='button'
                                                                            onClick={() =>
                                                                                toggleShowAllSessions(
                                                                                    agent.id
                                                                                )
                                                                            }
                                                                            className='text-ui text-subtle hover:text-fg hover:bg-rail-hover flex w-full items-center rounded-sm px-2.5 py-1.5 text-left transition-colors'
                                                                        >
                                                                            {showAllSessions
                                                                                ? t(
                                                                                      'web.shell.showFewerChats'
                                                                                  )
                                                                                : t(
                                                                                      'web.shell.showMoreChats',
                                                                                      {
                                                                                          count: sessionOverflowCount
                                                                                      }
                                                                                  )}
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </section>
                    </div>
                </div>

                <div className='pt-2'>
                    <CliUpgradeBanner
                        daemons={daemonHosts}
                        collapsed={collapsed}
                    />
                    <WorkspaceChallengeCard collapsed={collapsed} />
                    <div className={collapsed ? 'flex justify-center' : ''}>
                        <SidebarSettingsMenu collapsed={collapsed} />
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className='bg-app flex h-[100dvh] h-screen overflow-hidden overscroll-none'>
            {drawerOpen && (
                <button
                    type='button'
                    aria-label={t('web.shell.closeSidebar')}
                    onClick={() => setDrawerOpen(false)}
                    className='fixed inset-0 z-[90] bg-black/20 md:hidden'
                />
            )}
            <aside
                ref={sidebarResize.asideRef}
                style={
                    desktopSidebarCollapsed
                        ? undefined
                        : { width: sidebarResize.width }
                }
                className={[
                    'bg-rail border-divider/80 relative z-[90] hidden h-full shrink-0 md:block',
                    sidebarResize.resizing
                        ? ''
                        : 'transition-[width] duration-200',
                    direction === 'rtl' ? 'border-l' : 'border-r',
                    desktopSidebarCollapsed ? 'w-[5.5rem]' : ''
                ].join(' ')}
            >
                {renderSidebar({
                    collapsed: desktopSidebarCollapsed,
                    showCollapseToggle: true
                })}
                {!desktopSidebarCollapsed && (
                    <SidebarResizeHandle
                        direction={direction}
                        resizing={sidebarResize.resizing}
                        label={t('web.shell.resizeSidebar')}
                        onPointerDown={sidebarResize.startResize}
                        onReset={sidebarResize.resetWidth}
                    />
                )}
            </aside>
            <aside
                className={[
                    'bg-rail border-divider/80 fixed inset-y-0 z-[100] w-[19rem] transition-transform md:hidden',
                    direction === 'rtl'
                        ? 'right-0 border-l'
                        : 'left-0 border-r',
                    drawerOpen
                        ? 'translate-x-0'
                        : direction === 'rtl'
                          ? 'translate-x-full'
                          : '-translate-x-full'
                ].join(' ')}
            >
                {renderSidebar({
                    collapsed: false,
                    showCollapseToggle: false
                })}
            </aside>
            <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-none'>
                {!pageOwnMobileHeader && (
                    <header className='border-divider/80 bg-surface/90 relative z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 backdrop-blur md:hidden'>
                        <div className='flex min-w-0 items-center gap-3'>
                            <button
                                type='button'
                                onClick={() => setDrawerOpen(true)}
                                aria-label={t('web.shell.menu')}
                                className='shadow-ring-light bg-surface text-muted hover:bg-surface-hover rounded-pill inline-flex h-9 w-9 shrink-0 items-center justify-center transition-colors'
                            >
                                <MenuIcon className='h-4 w-4' />
                            </button>
                            <div className='min-w-0'>
                                <div className='text-ui text-fg truncate font-medium'>
                                    {currentLabel}
                                </div>
                                <Link
                                    to='/?stay=1'
                                    aria-label={t('common.appName')}
                                    className='text-fg mt-0.5 inline-flex items-center gap-1 truncate text-[13px] font-medium tracking-[-0.015em]'
                                >
                                    <BrandMark className='block h-4 w-auto' />
                                    <span className='truncate'>
                                        {t('common.appName')}
                                    </span>
                                </Link>
                            </div>
                        </div>
                    </header>
                )}
                <main
                    className={[
                        'bg-main flex min-h-0 flex-1 flex-col overscroll-none',
                        chatMatch ? 'overflow-hidden' : 'overflow-auto'
                    ].join(' ')}
                >
                    <QuotaBanner
                        warnings={quotaWarnings}
                        onDismiss={dismissQuotaWarning}
                    />
                    <WorkspaceChallengeCard variant='strip' />
                    <Suspense fallback={<GhostPageContent />}>
                        <Outlet
                            context={
                                {
                                    activeSessionId,
                                    agents,
                                    agentsError,
                                    agentsLoading,
                                    currentAgent,
                                    openMobileSidebar: () =>
                                        setDrawerOpen(true),
                                    openTerminalForAgent,
                                    refreshAgents,
                                    refreshSessionsForAgent,
                                    refreshSessions,
                                    runtimeAccess,
                                    refreshRuntimeAccess,
                                    quotaWarnings,
                                    dismissQuotaWarning,
                                    requestQuotaConflict,
                                    markAgentReleasing,
                                    bgTasksVisible,
                                    toggleBackgroundTasks: () =>
                                        setBgTasksVisible((value) => !value),
                                    sessions,
                                    sessionsError,
                                    sessionsLoading
                                } satisfies AppShellOutletContext
                            }
                        />
                    </Suspense>
                </main>
                {terminalDockVisible && (
                    <TerminalDock
                        activeTabId={activeTerminalId}
                        canCreateTerminal={Boolean(terminalCreateTarget)}
                        getToken={getTerminalToken}
                        onCloseDock={handleCloseTerminalDock}
                        onCloseTab={handleCloseTerminalTab}
                        onCreateTerminal={handleCreateTerminalFromDock}
                        onSelectTab={setActiveTerminalId}
                        onStatusChange={handleTerminalStatusChange}
                        tabs={terminalTabs}
                    />
                )}
                {credentialsAgent && (
                    <AgentCredentialsDialog
                        agentId={credentialsAgent.id}
                        agentName={credentialsAgent.name}
                        framework={credentialsAgent.framework}
                        onUpdated={() => {
                            void refreshAgents()
                        }}
                        onClose={() => setCredentialsAgent(null)}
                    />
                )}
                <QuotaConflictModal
                    request={quotaConflict}
                    onClose={() => setQuotaConflict(null)}
                />
                {confirmDialog}
                {deleteAgentDialog}
                {renameAgent && (
                    <RenameAgentDialog
                        agent={renameAgent}
                        onClose={() => setRenameAgent(null)}
                        onRenamed={(updated) =>
                            setAgents((prev) =>
                                prev.map((a) =>
                                    a.id === updated.id
                                        ? { ...a, name: updated.name }
                                        : a
                                )
                            )
                        }
                    />
                )}
            </div>
            {bgTasksVisible && (
                <BackgroundTasksPanel
                    agent={currentAgent}
                    onClose={() => setBgTasksVisible(false)}
                />
            )}
        </div>
    )
}

export default AppShell
