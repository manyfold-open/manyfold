import type {
    ChannelCredentials,
    ChannelProviderName,
    ChannelSummary,
    CreateChannelBody,
    DiscordChannelConfig,
    GithubChannelConfig,
    LarkAppRegion,
    LarkChannelConfig,
    LarkSubscriptionMode,
    LinearChannelConfig,
    LineChannelConfig,
    MatrixChannelConfig,
    SlackChannelConfig,
    TelegramChannelConfig,
    WeixinChannelConfig
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Outlet,
    useMatch,
    useNavigate,
    useSearchParams
} from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { t as translate } from '@manyfold/i18n'
import {
    AgentIcon,
    ChannelIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloseIcon,
    PlusIcon,
    SearchIcon,
    ZapIcon
} from '@/components/icons'
import EmptyState from '@/components/EmptyState'
import { GhostRailRows } from '@/components/Loading'
import ProductDialog from '@/components/ProductDialog'
import { useI18n } from '@/lib/i18n'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import {
    GroupByControl,
    type GroupByOption,
    GroupHeader,
    type Health,
    Highlight,
    useCascadeState
} from '@/lib/cascade'
import { ChannelProviderIcon, channelLabel } from '@/lib/channelMeta'
import { apiErrorMessage } from '@/lib/errorMessage'
import ChannelDocsLink from './ChannelDocsLink'
import LarkQuickCreate, { type LarkQuickCreateState } from './LarkQuickCreate'
import WeixinQuickCreate, {
    type WeixinQuickCreateState
} from './WeixinQuickCreate'

type CreateProviderChoice = ChannelProviderName | LarkAppRegion

const isLarkProviderChoice = (
    provider: CreateProviderChoice
): provider is LarkAppRegion => provider === 'feishu' || provider === 'lark'

const docsProviderForChoice = (
    provider: CreateProviderChoice
): ChannelProviderName => (isLarkProviderChoice(provider) ? 'lark' : provider)

type ChannelStatus = ChannelSummary['status']
type GroupBy = 'provider' | 'agent' | 'status'
type StatusFilter = 'all' | 'active' | 'issues'

const CHANNEL_DIMS = ['provider', 'agent', 'status'] as const

const PROVIDER_ORDER: ChannelProviderName[] = [
    'lark',
    'telegram',
    'slack',
    'discord',
    'matrix',
    'weixin',
    'linear',
    'github',
    'line',
    'fake'
]

const STATUS_ORDER: ChannelStatus[] = ['active', 'paused', 'error', 'draft']

const CHANNEL_DOT: Record<ChannelStatus, string> = {
    active: 'bg-success',
    paused: 'bg-warning',
    error: 'bg-error',
    draft: 'bg-idle'
}

interface ChannelGroup {
    key: string
    label: string
    count: number
    health: Health
    items: ChannelSummary[]
}

const groupHealth = (items: ChannelSummary[]): Health => {
    let warn = false
    for (const c of items) {
        if (c.status === 'error') return 'error'
        if (c.status === 'paused') warn = true
    }
    return warn ? 'warn' : null
}

const ChannelLeaf: FC<{
    channel: ChannelSummary
    selected: boolean
    q: string
    subLabel: string
    onSelect: () => void
}> = ({ channel: c, selected, q, subLabel, onSelect }): ReactNode => (
    <button
        type='button'
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={[
            'flex w-full items-center gap-2.5 rounded-sm py-2 pl-8 pr-2.5 text-left transition-colors',
            selected ? 'bg-active-session' : 'hover:bg-rail-hover'
        ].join(' ')}
    >
        <ChannelProviderIcon
            provider={c.provider}
            className='h-5 w-5 shrink-0'
        />
        <span className='min-w-0 flex-1'>
            <span className='text-ui text-fg block truncate'>
                <Highlight text={c.label} q={q} />
            </span>
            <span className='text-caption text-subtle block truncate'>
                {subLabel}
            </span>
        </span>
        <span
            className={[
                'h-2 w-2 shrink-0 rounded-full',
                CHANNEL_DOT[c.status]
            ].join(' ')}
        />
        <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0 lg:hidden' />
    </button>
)

const ChannelsList: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const navigate = useNavigate()
    const match = useMatch('/settings/channels/:id')
    const selectedId = match?.params.id ?? null
    const hasSelection = Boolean(selectedId)

    const [channels, setChannels] = useState<ChannelSummary[]>([])
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [searchParams, setSearchParams] = useSearchParams()
    const [query, setQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
    const lastRevealed = useRef<string | null>(null)

    const {
        groupBy,
        setGroupBy,
        expanded,
        toggle,
        collapseAll,
        expandAll,
        reveal
    } = useCascadeState('mf.channels.cascade.v1', CHANNEL_DIMS, 'provider')

    const agentFilter = searchParams.get('agent') ?? ''
    const q = query.trim().toLowerCase()

    const setAgentFilter = (value: string): void => {
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev)
                if (value) next.set('agent', value)
                else next.delete('agent')
                return next
            },
            { replace: true }
        )
    }

    const refresh = useCallback(async (): Promise<void> => {
        try {
            const [channelsList, agentsList] = await Promise.all([
                client.channels.list(),
                client.agents.list()
            ])
            setChannels(channelsList)
            setAgents(agentsList)
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const prevSelected = useRef<string | null>(selectedId)
    useEffect(() => {
        if (prevSelected.current && !selectedId) void refresh()
        prevSelected.current = selectedId
    }, [selectedId, refresh])

    const agentById = useMemo(
        () => new Map(agents.map((agent) => [agent.id, agent])),
        [agents]
    )
    const baseChannels = useMemo(
        () =>
            agentFilter
                ? channels.filter((c) => c.agentId === agentFilter)
                : channels,
        [channels, agentFilter]
    )

    const groups = useMemo<ChannelGroup[]>(() => {
        const matchesQuery = (c: ChannelSummary): boolean =>
            !q ||
            `${c.label} ${channelLabel(c.provider)} ${c.agent.name}`
                .toLowerCase()
                .includes(q)
        const passStatus = (c: ChannelSummary): boolean => {
            if (statusFilter === 'all') return true
            if (statusFilter === 'active') return c.status === 'active'
            return c.status === 'error' || c.status === 'paused'
        }
        const filtered = baseChannels.filter(
            (c) => passStatus(c) && matchesQuery(c)
        )

        if (groupBy === 'provider') {
            const out: ChannelGroup[] = []
            for (const provider of PROVIDER_ORDER) {
                const items = filtered.filter((c) => c.provider === provider)
                if (items.length === 0) continue
                out.push({
                    key: `pv:${provider}`,
                    label: channelLabel(provider),
                    count: items.length,
                    health: groupHealth(items),
                    items
                })
            }
            return out
        }
        if (groupBy === 'status') {
            const out: ChannelGroup[] = []
            for (const s of STATUS_ORDER) {
                const items = filtered.filter((c) => c.status === s)
                if (items.length === 0) continue
                out.push({
                    key: `st:${s}`,
                    label: t(`web.channels.settings.status.${s}`),
                    count: items.length,
                    health: groupHealth(items),
                    items
                })
            }
            return out
        }
        const byAgent = new Map<string, ChannelSummary[]>()
        for (const c of filtered) {
            const arr = byAgent.get(c.agentId) ?? []
            arr.push(c)
            byAgent.set(c.agentId, arr)
        }
        return [...byAgent.entries()]
            .map(([agentId, items]) => ({
                key: `ag:${agentId}`,
                label:
                    agentById.get(agentId)?.name ??
                    items[0]?.agent.name ??
                    agentId,
                count: items.length,
                health: groupHealth(items),
                items
            }))
            .sort((a, b) => a.label.localeCompare(b.label))
    }, [baseChannels, groupBy, q, statusFilter, agentById])

    const totalCount = useMemo(
        () => groups.reduce((n, g) => n + g.count, 0),
        [groups]
    )
    const allKeys = useMemo(() => groups.map((g) => g.key), [groups])

    const keysForSelection = useCallback(
        (id: string): string[] => {
            const c = channels.find((x) => x.id === id)
            if (!c) return []
            if (groupBy === 'provider') return [`pv:${c.provider}`]
            if (groupBy === 'status') return [`st:${c.status}`]
            return [`ag:${c.agentId}`]
        },
        [channels, groupBy]
    )

    useEffect(() => {
        if (channels.length === 0 || !selectedId) return
        const token = `${groupBy}|${selectedId}`
        if (lastRevealed.current === token) return
        lastRevealed.current = token
        const keys = keysForSelection(selectedId)
        if (keys.length > 0) reveal(keys)
    }, [channels, selectedId, groupBy, keysForSelection, reveal])

    const isOpen = (key: string): boolean => q !== '' || expanded.has(key)
    const anyExpanded = expanded.size > 0
    const canCreate = agents.length > 0
    const groupByOptions: ReadonlyArray<GroupByOption<GroupBy>> = [
        {
            value: 'provider',
            label: t('web.channels.settings.groupBy.platform'),
            icon: ChannelIcon
        },
        {
            value: 'agent',
            label: t('web.channels.settings.groupBy.agent'),
            icon: AgentIcon
        },
        {
            value: 'status',
            label: t('web.channels.settings.groupBy.status'),
            icon: ZapIcon
        }
    ]
    const statusFilters: Array<{ value: StatusFilter; label: string }> = [
        { value: 'all', label: t('web.channels.settings.filters.all') },
        {
            value: 'active',
            label: t('web.channels.settings.filters.active')
        },
        {
            value: 'issues',
            label: t('web.channels.settings.filters.issues')
        }
    ]

    const subLabelFor = (c: ChannelSummary): string => {
        if (groupBy === 'provider') return c.agent.name
        if (groupBy === 'agent') return channelLabel(c.provider)
        return `${channelLabel(c.provider)} · ${c.agent.name}`
    }

    const chipClass = (active: boolean): string =>
        [
            'text-caption rounded-full px-2.5 py-1 font-medium transition-colors',
            active ? 'bg-rail-hover text-fg' : 'text-muted hover:bg-rail-hover'
        ].join(' ')

    const filterAgent = agentFilter ? agentById.get(agentFilter) : null

    const renderTree = (): ReactNode => {
        if (loading) return <GhostRailRows rows={4} icon={true} />
        if (error)
            return (
                <div className='workbench-alert-error mx-1 my-2'>{error}</div>
            )
        if (channels.length === 0)
            return (
                <EmptyState
                    kind='first-use'
                    tier='line'
                    title={t('web.emptyState.channelsTitle')}
                    className='px-3 py-4'
                />
            )
        if (groups.length === 0)
            return (
                <EmptyState
                    kind='no-results'
                    tier='line'
                    subtle
                    body={t('web.emptyState.noMatches')}
                    className='px-3 py-4'
                />
            )
        return groups.map((g) => (
            <div key={g.key}>
                <GroupHeader
                    label={g.label}
                    count={g.count}
                    open={isOpen(g.key)}
                    health={g.health}
                    onToggle={() => toggle(g.key)}
                />
                {isOpen(g.key) &&
                    g.items.map((c) => (
                        <ChannelLeaf
                            key={c.id}
                            channel={c}
                            q={q}
                            subLabel={subLabelFor(c)}
                            selected={c.id === selectedId}
                            onSelect={() =>
                                navigate(`/settings/channels/${c.id}`)
                            }
                        />
                    ))}
            </div>
        ))
    }

    return (
        <>
            <div className='flex h-full min-h-0 flex-col lg:flex-row'>
                <aside
                    aria-label={t('web.channels.settings.channels')}
                    className={[
                        'bg-rail border-divider/70 flex w-full flex-col lg:h-full lg:w-72 lg:shrink-0 lg:overflow-hidden lg:border-r',
                        hasSelection ? 'hidden lg:flex' : 'flex'
                    ].join(' ')}
                >
                    <div className='shrink-0 space-y-2.5 p-3'>
                        <div className='flex items-center justify-between'>
                            <div className='flex items-center gap-2'>
                                <h2 className='text-h3 text-fg tracking-tight'>
                                    {t('web.channels.settings.channels')}
                                </h2>
                                <span className='tag tag-neutral tabular-nums'>
                                    {totalCount}
                                </span>
                            </div>
                            <button
                                type='button'
                                onClick={() => setCreateOpen(true)}
                                disabled={!canCreate}
                                aria-label={t('web.channels.settings.newChannel')}
                                className='text-muted hover:text-fg hover:bg-rail-hover flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:opacity-40'
                            >
                                <PlusIcon className='h-4 w-4' />
                            </button>
                        </div>

                        {filterAgent && (
                            <div className='flex items-center'>
                                <span className='text-caption text-muted bg-soft inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1'>
                                    {t('web.channels.settings.agentFilter', {
                                        name: filterAgent.name
                                    })}
                                    <button
                                        type='button'
                                        onClick={() => setAgentFilter('')}
                                        aria-label={t(
                                            'web.channels.settings.clearAgentFilter'
                                        )}
                                        className='hover:text-fg flex h-4 w-4 items-center justify-center'
                                    >
                                        <CloseIcon className='h-3 w-3' />
                                    </button>
                                </span>
                            </div>
                        )}

                        <div className='relative'>
                            <SearchIcon className='text-subtle pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2' />
                            <input
                                type='text'
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={t(
                                    'web.channels.settings.searchChannels'
                                )}
                                aria-label={t(
                                    'web.channels.settings.searchChannels'
                                )}
                                className='text-ui bg-surface text-fg shadow-ring-light hover:shadow-ring-hover placeholder:text-subtle focus-visible:shadow-focus h-9 w-full rounded-sm pl-9 pr-8 transition-shadow focus:outline-none'
                            />
                            {query && (
                                <button
                                    type='button'
                                    onClick={() => setQuery('')}
                                    aria-label={t(
                                        'web.channels.settings.clearSearch'
                                    )}
                                    className='text-subtle hover:text-fg hover:bg-rail-hover absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full transition-colors'
                                >
                                    <CloseIcon className='h-4 w-4' />
                                </button>
                            )}
                        </div>

                        <div className='flex gap-1.5'>
                            {statusFilters.map((f) => (
                                <button
                                    key={f.value}
                                    type='button'
                                    onClick={() => setStatusFilter(f.value)}
                                    className={chipClass(
                                        statusFilter === f.value
                                    )}
                                >
                                    {f.label}
                                </button>
                            ))}
                        </div>

                        <div className='flex items-center justify-between gap-2'>
                            <GroupByControl
                                value={groupBy}
                                onChange={setGroupBy}
                                options={groupByOptions}
                            />
                            {!q && (
                                <button
                                    type='button'
                                    onClick={
                                        anyExpanded
                                            ? collapseAll
                                            : () => expandAll(allKeys)
                                    }
                                    className='text-caption text-muted hover:text-fg inline-flex items-center gap-1 transition-colors'
                                >
                                    {anyExpanded ? (
                                        <ChevronUpIcon className='h-3.5 w-3.5' />
                                    ) : (
                                        <ChevronDownIcon className='h-3.5 w-3.5' />
                                    )}
                                    {anyExpanded
                                        ? t(
                                              'web.channels.settings.collapseAll'
                                          )
                                        : t(
                                              'web.channels.settings.expandAll'
                                          )}
                                </button>
                            )}
                        </div>
                    </div>

                    <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-2'>
                        {renderTree()}
                    </div>

                    <div className='shrink-0 p-2'>
                        <button
                            type='button'
                            onClick={() => setCreateOpen(true)}
                            disabled={!canCreate}
                            className='workbench-button-primary h-9 w-full justify-center disabled:opacity-40'
                        >
                            {t('web.channels.settings.newChannel')}
                        </button>
                    </div>
                </aside>

                <main
                    className={[
                        'min-w-0 lg:h-full lg:flex-1 lg:overflow-y-auto',
                        hasSelection
                            ? 'flex flex-col'
                            : 'hidden lg:flex lg:flex-col'
                    ].join(' ')}
                >
                    {selectedId ? (
                        <Outlet />
                    ) : (
                        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                            {loading ? null : channels.length === 0 ? (
                                <EmptyState
                                    kind='first-use'
                                    tier='stack'
                                    icon={ChannelIcon}
                                    title={t('web.emptyState.channelsTitle')}
                                    body={t('web.emptyState.channelsBody')}
                                    action={{
                                        label: t(
                                            'web.emptyState.channelsCreateAction'
                                        ),
                                        onClick: () => setCreateOpen(true)
                                    }}
                                />
                            ) : (
                                <EmptyState
                                    kind='no-selection'
                                    tier='stack'
                                    title={t(
                                        'web.emptyState.channelNoSelectionTitle'
                                    )}
                                    body={t(
                                        'web.emptyState.channelNoSelectionBody'
                                    )}
                                />
                            )}
                        </div>
                    )}
                </main>
            </div>

            {createOpen && (
                <CreateChannelDialog
                    agents={agents}
                    onClose={() => setCreateOpen(false)}
                    onCreated={(id) => {
                        setCreateOpen(false)
                        navigate(`/settings/channels/${id}`)
                    }}
                />
            )}
        </>
    )
}

interface CreateChannelDialogProps {
    agents: SdkAgent[]
    onClose: () => void
    onCreated: (id: string) => void
}

const CreateChannelDialog: FC<CreateChannelDialogProps> = ({
    agents,
    onClose,
    onCreated
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
    const [provider, setProvider] = useState<CreateProviderChoice>('feishu')
    const [larkMode, setLarkMode] = useState<'qr' | 'manual'>('qr')
    const [label, setLabel] = useState('')
    const [subscriptionMode, setSubscriptionMode] =
        useState<LarkSubscriptionMode>('webhook')
    const [appId, setAppId] = useState('')
    const [appSecret, setAppSecret] = useState('')
    const [verificationToken, setVerificationToken] = useState('')
    const [encryptKey, setEncryptKey] = useState('')
    const [botName, setBotName] = useState('')
    const [quickBotName, setQuickBotName] = useState(agents[0]?.name ?? '')
    const quickBotNameTouched = useRef(false)
    const [larkQuickState, setLarkQuickState] = useState<LarkQuickCreateState>({
        id: null,
        status: 'idle'
    })
    const [larkAllowedUserIds, setLarkAllowedUserIds] = useState('')
    const [larkOperatorUserIds, setLarkOperatorUserIds] = useState('')
    const [tgBotToken, setTgBotToken] = useState('')
    const [slackBotToken, setSlackBotToken] = useState('')
    const [slackSigningSecret, setSlackSigningSecret] = useState('')
    const [slackAllowedUserIds, setSlackAllowedUserIds] = useState('')
    const [slackOperatorUserIds, setSlackOperatorUserIds] = useState('')
    const [linearClientId, setLinearClientId] = useState('')
    const [linearClientSecret, setLinearClientSecret] = useState('')
    const [linearWebhookSecret, setLinearWebhookSecret] = useState('')
    const [linearAccessToken, setLinearAccessToken] = useState('')
    const [linearAllowedUserIds, setLinearAllowedUserIds] = useState('')
    const [githubAllowedRepos, setGithubAllowedRepos] = useState('')
    const [discordBotToken, setDiscordBotToken] = useState('')
    const [discordAllowedGuildIds, setDiscordAllowedGuildIds] = useState('')
    const [matrixHomeserver, setMatrixHomeserver] = useState('')
    const [matrixAccessToken, setMatrixAccessToken] = useState('')
    const [matrixAllowedRoomIds, setMatrixAllowedRoomIds] = useState('')
    const [matrixAllowedUserIds, setMatrixAllowedUserIds] = useState('')
    const [matrixFreeResponseRoomIds, setMatrixFreeResponseRoomIds] =
        useState('')
    const [weixinMode, setWeixinMode] = useState<'qr' | 'manual'>('qr')
    const [weixinBotToken, setWeixinBotToken] = useState('')
    const [weixinBaseUrl, setWeixinBaseUrl] = useState('')
    const [weixinAllowedUserIds, setWeixinAllowedUserIds] = useState('')
    const [weixinOperatorUserIds, setWeixinOperatorUserIds] = useState('')
    const [weixinQuickState, setWeixinQuickState] =
        useState<WeixinQuickCreateState>({ id: null, status: 'idle' })
    const [lineChannelSecret, setLineChannelSecret] = useState('')
    const [lineChannelAccessToken, setLineChannelAccessToken] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const larkQuickActive =
        larkQuickState.status === 'starting' ||
        larkQuickState.status === 'pending' ||
        larkQuickState.status === 'creating'
    const weixinQuickActive =
        weixinQuickState.status === 'starting' ||
        weixinQuickState.status === 'pending' ||
        weixinQuickState.status === 'need_verify_code' ||
        weixinQuickState.status === 'creating'
    const quickActive = larkQuickActive || weixinQuickActive
    const larkQrMode = isLarkProviderChoice(provider) && larkMode === 'qr'

    const handleClose = async (): Promise<void> => {
        const weixinPendingId =
            provider === 'weixin' &&
            weixinMode === 'qr' &&
            (weixinQuickState.status === 'pending' ||
                weixinQuickState.status === 'need_verify_code') &&
            weixinQuickState.id
                ? weixinQuickState.id
                : null
        if (weixinPendingId) {
            setBusy(true)
            setError(null)
            try {
                await client.channels.cancelWeixinRegistration(weixinPendingId)
                const latest =
                    await client.channels.getWeixinRegistration(weixinPendingId)
                setWeixinQuickState({ id: latest.id, status: latest.status })
                if (latest.status === 'succeeded' && latest.channelId) {
                    onCreated(latest.channelId)
                    return
                }
                if (!weixinQuickActive) onClose()
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setBusy(false)
            }
            return
        }
        if (
            !larkQrMode ||
            larkQuickState.status !== 'pending' ||
            !larkQuickState.id
        ) {
            if (!quickActive) onClose()
            return
        }

        setBusy(true)
        setError(null)
        try {
            await client.channels.cancelLarkRegistration(larkQuickState.id)
            const latest = await client.channels.getLarkRegistration(
                larkQuickState.id
            )
            setLarkQuickState({ id: latest.id, status: latest.status })
            if (latest.status === 'succeeded' && latest.channelId) {
                onCreated(latest.channelId)
                return
            }
            if (latest.status !== 'pending' && latest.status !== 'creating')
                onClose()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (larkQrMode) return
        if (provider === 'weixin' && weixinMode === 'qr') return
        setBusy(true)
        setError(null)
        try {
            const body = buildBody({
                agentId,
                provider,
                label,
                subscriptionMode,
                appId,
                appSecret,
                verificationToken,
                encryptKey,
                botName,
                larkAllowedUserIds,
                larkOperatorUserIds,
                tgBotToken,
                slackBotToken,
                slackSigningSecret,
                slackAllowedUserIds,
                slackOperatorUserIds,
                linearClientId,
                linearClientSecret,
                linearWebhookSecret,
                linearAccessToken,
                linearAllowedUserIds,
                githubAllowedRepos,
                discordBotToken,
                discordAllowedGuildIds,
                matrixHomeserver,
                matrixAccessToken,
                matrixAllowedRoomIds,
                matrixAllowedUserIds,
                matrixFreeResponseRoomIds,
                weixinBotToken,
                weixinBaseUrl,
                weixinAllowedUserIds,
                weixinOperatorUserIds,
                lineChannelSecret,
                lineChannelAccessToken
            })
            const created = await client.channels.create(body)
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.channels.settings.newChannel')}
            description={t('web.channels.settings.createDescription')}
            onClose={() => void handleClose()}
            onSubmit={handleSubmit}
            closeDisabled={busy || quickActive}
            bodyClassName='space-y-4'
            headerAccessory={
                <ChannelDocsLink provider={docsProviderForChoice(provider)} />
            }
            footer={
                <>
                    <button
                        type='button'
                        onClick={() => void handleClose()}
                        className='workbench-button-secondary'
                        disabled={
                            busy ||
                            larkQuickState.status === 'starting' ||
                            larkQuickState.status === 'creating' ||
                            weixinQuickState.status === 'starting' ||
                            weixinQuickState.status === 'creating'
                        }
                    >
                        {t('common.cancel')}
                    </button>
                    {!larkQrMode &&
                        !(provider === 'weixin' && weixinMode === 'qr') && (
                            <button
                                type='submit'
                                className='workbench-button-primary'
                                disabled={busy}
                            >
                                {busy
                                    ? t('common.creating')
                                    : t('web.channels.settings.create')}
                            </button>
                        )}
                </>
            }
        >
            {error && <div className='workbench-alert-error'>{error}</div>}

            <Field label={t('web.channels.settings.fields.agent')}>
                <WorkbenchSelect
                    ariaLabel={t('web.channels.settings.fields.agent')}
                    value={agentId}
                    disabled={quickActive}
                    onChange={(next) => {
                        setAgentId(next)
                        if (!quickBotNameTouched.current)
                            setQuickBotName(
                                agents.find((agent) => agent.id === next)
                                    ?.name ?? ''
                            )
                    }}
                    options={agents.map((agent) => ({
                        value: agent.id,
                        label: agent.name
                    }))}
                />
            </Field>

            <Field label={t('web.channels.settings.fields.provider')}>
                <WorkbenchSelect
                    ariaLabel={t('web.channels.settings.fields.provider')}
                    value={provider}
                    disabled={quickActive}
                    onChange={(next) =>
                        setProvider(next as CreateProviderChoice)
                    }
                    options={[
                        { value: 'feishu', label: 'Feishu' },
                        { value: 'lark', label: 'Lark' },
                        { value: 'telegram', label: 'Telegram' },
                        { value: 'slack', label: 'Slack' },
                        { value: 'discord', label: 'Discord' },
                        { value: 'matrix', label: 'Matrix' },
                        { value: 'weixin', label: 'WeChat' },
                        { value: 'linear', label: 'Linear' },
                        { value: 'github', label: 'GitHub' },
                        { value: 'line', label: 'LINE' }
                    ]}
                />
            </Field>

            <Field label={t('web.channels.settings.fields.label')}>
                <input
                    type='text'
                    className='workbench-input'
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('web.channels.settings.placeholders.teamSupport')}
                    disabled={quickActive}
                    required
                />
            </Field>

            {isLarkProviderChoice(provider) && (
                <>
                    <div
                        role='group'
                        aria-label={t('web.channels.settings.setupMode.lark')}
                        className='bg-soft shadow-ring-light grid grid-cols-2 gap-1 rounded-md p-1'
                    >
                        <button
                            type='button'
                            disabled={quickActive}
                            aria-pressed={larkMode === 'qr'}
                            onClick={() => setLarkMode('qr')}
                            className={larkModeButtonClass(larkMode === 'qr')}
                        >
                            <span>{t('web.channels.larkQuick.modeQr')}</span>
                            <span className='tag tag-neutral'>
                                {t('web.channels.larkQuick.recommended')}
                            </span>
                        </button>
                        <button
                            type='button'
                            disabled={quickActive}
                            aria-pressed={larkMode === 'manual'}
                            onClick={() => setLarkMode('manual')}
                            className={larkModeButtonClass(
                                larkMode === 'manual'
                            )}
                        >
                            {t('web.channels.larkQuick.modeManual')}
                        </button>
                    </div>

                    {larkQrMode ? (
                        <>
                            <Field
                                label={t('web.channels.larkQuick.botNameLabel')}
                            >
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={quickBotName}
                                    onChange={(e) => {
                                        quickBotNameTouched.current = true
                                        setQuickBotName(e.target.value)
                                    }}
                                    disabled={quickActive}
                                    maxLength={60}
                                    required
                                />
                            </Field>
                            <LarkQuickCreate
                                agentId={agentId}
                                appRegion={provider}
                                label={label}
                                botName={quickBotName}
                                onCreated={onCreated}
                                onStateChange={setLarkQuickState}
                            />
                        </>
                    ) : (
                        <LarkManualFields
                            subscriptionMode={subscriptionMode}
                            setSubscriptionMode={setSubscriptionMode}
                            appId={appId}
                            setAppId={setAppId}
                            appSecret={appSecret}
                            setAppSecret={setAppSecret}
                            verificationToken={verificationToken}
                            setVerificationToken={setVerificationToken}
                            encryptKey={encryptKey}
                            setEncryptKey={setEncryptKey}
                            botName={botName}
                            setBotName={setBotName}
                            larkAllowedUserIds={larkAllowedUserIds}
                            setLarkAllowedUserIds={setLarkAllowedUserIds}
                            larkOperatorUserIds={larkOperatorUserIds}
                            setLarkOperatorUserIds={setLarkOperatorUserIds}
                        />
                    )}
                </>
            )}

            {provider === 'telegram' && (
                <>
                    <Field label={t('web.channels.settings.fields.botToken')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={tgBotToken}
                            onChange={(e) => setTgBotToken(e.target.value)}
                            placeholder='123456789:AAH...'
                            required
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.telegramCreate')}
                    </p>
                </>
            )}

            {provider === 'slack' && (
                <>
                    <Field label={t('web.channels.settings.fields.botToken')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={slackBotToken}
                            onChange={(e) => setSlackBotToken(e.target.value)}
                            placeholder='xoxb-...'
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.signingSecret')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={slackSigningSecret}
                            onChange={(e) =>
                                setSlackSigningSecret(e.target.value)
                            }
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={slackAllowedUserIds}
                            onChange={(e) =>
                                setSlackAllowedUserIds(e.target.value)
                            }
                            placeholder='U01ABCDEF, U02GHIJKL'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={slackOperatorUserIds}
                            onChange={(e) =>
                                setSlackOperatorUserIds(e.target.value)
                            }
                            placeholder='U01ABCDEF'
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.slackCreate')}
                    </p>
                </>
            )}

            {provider === 'linear' && (
                <>
                    <Field label={t('web.channels.settings.fields.clientId')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={linearClientId}
                            onChange={(e) => setLinearClientId(e.target.value)}
                            placeholder={t(
                                'web.channels.settings.placeholders.linearClientId'
                            )}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.clientSecret')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={linearClientSecret}
                            onChange={(e) =>
                                setLinearClientSecret(e.target.value)
                            }
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.webhookSigningSecret')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={linearWebhookSecret}
                            onChange={(e) =>
                                setLinearWebhookSecret(e.target.value)
                            }
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.accessTokenOptional')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={linearAccessToken}
                            onChange={(e) =>
                                setLinearAccessToken(e.target.value)
                            }
                            placeholder={t(
                                'web.channels.settings.placeholders.linearAccessToken'
                            )}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedLinearUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={linearAllowedUserIds}
                            onChange={(e) =>
                                setLinearAllowedUserIds(e.target.value)
                            }
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.linearCreate')}
                    </p>
                </>
            )}

            {provider === 'github' && (
                <>
                    <Field label={t('web.channels.settings.fields.repositoriesOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubAllowedRepos}
                            onChange={(e) =>
                                setGithubAllowedRepos(e.target.value)
                            }
                            placeholder='owner/repo, owner/other-repo'
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.githubCreate')}
                    </p>
                </>
            )}

            {provider === 'line' && (
                <>
                    <Field label={t('web.channels.settings.fields.channelSecret')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={lineChannelSecret}
                            onChange={(e) =>
                                setLineChannelSecret(e.target.value)
                            }
                            autoComplete='new-password'
                            required
                        />
                    </Field>
                    <Field
                        label={t(
                            'web.channels.settings.fields.channelAccessToken'
                        )}
                    >
                        <input
                            type='password'
                            className='workbench-input'
                            value={lineChannelAccessToken}
                            onChange={(e) =>
                                setLineChannelAccessToken(e.target.value)
                            }
                            autoComplete='new-password'
                            required
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.lineCreate')}
                    </p>
                </>
            )}

            {provider === 'discord' && (
                <>
                    <Field label={t('web.channels.settings.fields.botToken')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={discordBotToken}
                            onChange={(e) => setDiscordBotToken(e.target.value)}
                            placeholder='MTk...'
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedGuildIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={discordAllowedGuildIds}
                            onChange={(e) =>
                                setDiscordAllowedGuildIds(e.target.value)
                            }
                            placeholder='123456789012345678, ...'
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.discordCreate')}
                    </p>
                </>
            )}

            {provider === 'matrix' && (
                <>
                    <Field label={t('web.channels.settings.fields.homeserverUrl')}>
                        <input
                            type='url'
                            className='workbench-input'
                            value={matrixHomeserver}
                            onChange={(e) =>
                                setMatrixHomeserver(e.target.value)
                            }
                            placeholder='https://matrix.example.org'
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.accessToken')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={matrixAccessToken}
                            onChange={(e) =>
                                setMatrixAccessToken(e.target.value)
                            }
                            autoComplete='new-password'
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedRoomIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixAllowedRoomIds}
                            onChange={(e) =>
                                setMatrixAllowedRoomIds(e.target.value)
                            }
                            placeholder='!roomid:matrix.example.org, ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixAllowedUserIds}
                            onChange={(e) =>
                                setMatrixAllowedUserIds(e.target.value)
                            }
                            placeholder='@alice:matrix.example.org, ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.freeResponseRoomIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixFreeResponseRoomIds}
                            onChange={(e) =>
                                setMatrixFreeResponseRoomIds(e.target.value)
                            }
                            placeholder='!roomid:matrix.example.org, ...'
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.matrixCreate')}
                    </p>
                </>
            )}

            {provider === 'weixin' && (
                <>
                    <div
                        role='group'
                        aria-label={t('web.channels.settings.setupMode.weixin')}
                        className='bg-soft shadow-ring-light grid grid-cols-2 gap-1 rounded-md p-1'
                    >
                        <button
                            type='button'
                            disabled={weixinQuickActive}
                            aria-pressed={weixinMode === 'qr'}
                            onClick={() => setWeixinMode('qr')}
                            className={larkModeButtonClass(weixinMode === 'qr')}
                        >
                            <span>{t('web.channels.weixinQuick.modeQr')}</span>
                            <span className='tag tag-neutral'>
                                {t('web.channels.weixinQuick.recommended')}
                            </span>
                        </button>
                        <button
                            type='button'
                            disabled={weixinQuickActive}
                            aria-pressed={weixinMode === 'manual'}
                            onClick={() => setWeixinMode('manual')}
                            className={larkModeButtonClass(
                                weixinMode === 'manual'
                            )}
                        >
                            {t('web.channels.weixinQuick.modeManual')}
                        </button>
                    </div>

                    {weixinMode === 'qr' ? (
                        <WeixinQuickCreate
                            agentId={agentId}
                            label={label}
                            onCreated={onCreated}
                            onStateChange={setWeixinQuickState}
                        />
                    ) : (
                        <>
                            <Field label={t('web.channels.settings.fields.ilinkBotToken')}>
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={weixinBotToken}
                                    onChange={(e) =>
                                        setWeixinBotToken(e.target.value)
                                    }
                                    autoComplete='new-password'
                                    required
                                />
                            </Field>
                            <Field label={t('web.channels.settings.fields.gatewayBaseUrlOptional')}>
                                <input
                                    type='url'
                                    className='workbench-input'
                                    value={weixinBaseUrl}
                                    onChange={(e) =>
                                        setWeixinBaseUrl(e.target.value)
                                    }
                                    placeholder='https://ilinkai.weixin.qq.com'
                                />
                            </Field>
                            <Field label={t('web.channels.settings.fields.allowedUserIdsOptional')}>
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={weixinAllowedUserIds}
                                    onChange={(e) =>
                                        setWeixinAllowedUserIds(e.target.value)
                                    }
                                    placeholder='wxid_xxx@im.wechat, ...'
                                />
                            </Field>
                            <Field label={t('web.channels.settings.fields.operatorUserIdsOptional')}>
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={weixinOperatorUserIds}
                                    onChange={(e) =>
                                        setWeixinOperatorUserIds(e.target.value)
                                    }
                                    placeholder='wxid_xxx@im.wechat, ...'
                                />
                            </Field>
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.weixinCreate')}
                            </p>
                        </>
                    )}
                </>
            )}
        </ProductDialog>
    )
}

interface LarkManualFieldsProps {
    subscriptionMode: LarkSubscriptionMode
    setSubscriptionMode: (value: LarkSubscriptionMode) => void
    appId: string
    setAppId: (value: string) => void
    appSecret: string
    setAppSecret: (value: string) => void
    verificationToken: string
    setVerificationToken: (value: string) => void
    encryptKey: string
    setEncryptKey: (value: string) => void
    botName: string
    setBotName: (value: string) => void
    larkAllowedUserIds: string
    setLarkAllowedUserIds: (value: string) => void
    larkOperatorUserIds: string
    setLarkOperatorUserIds: (value: string) => void
}

const LarkManualFields: FC<LarkManualFieldsProps> = ({
    subscriptionMode,
    setSubscriptionMode,
    appId,
    setAppId,
    appSecret,
    setAppSecret,
    verificationToken,
    setVerificationToken,
    encryptKey,
    setEncryptKey,
    botName,
    setBotName,
    larkAllowedUserIds,
    setLarkAllowedUserIds,
    larkOperatorUserIds,
    setLarkOperatorUserIds
}): ReactNode => {
    const { t } = useI18n()
    return (
    <>
        <Field label={t('web.channels.settings.fields.subscriptionMode')}>
            <WorkbenchSelect
                ariaLabel={t('web.channels.settings.fields.subscriptionMode')}
                value={subscriptionMode}
                onChange={(next) =>
                    setSubscriptionMode(next as LarkSubscriptionMode)
                }
                options={[
                    {
                        value: 'webhook',
                        label: t('web.channels.settings.options.webhook')
                    },
                    {
                        value: 'websocket',
                        label: t('web.channels.settings.options.websocket')
                    }
                ]}
            />
        </Field>
        <Field label={t('web.channels.settings.fields.appId')}>
            <input
                type='text'
                className='workbench-input'
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder='cli_xxxxx'
                required
            />
        </Field>
        <Field label={t('web.channels.settings.fields.appSecret')}>
            <input
                type='password'
                className='workbench-input'
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                required
            />
        </Field>
        <Field label={t('web.channels.settings.fields.verificationToken')}>
            <input
                type='text'
                className='workbench-input'
                value={verificationToken}
                onChange={(e) => setVerificationToken(e.target.value)}
                required={
                    subscriptionMode === 'webhook' &&
                    encryptKey.trim().length === 0
                }
            />
        </Field>
        <Field label={t('web.channels.settings.fields.encryptKey')}>
            <input
                type='text'
                className='workbench-input'
                value={encryptKey}
                onChange={(e) => setEncryptKey(e.target.value)}
                required={
                    subscriptionMode === 'webhook' &&
                    verificationToken.trim().length === 0
                }
            />
        </Field>
        <Field label={t('web.channels.settings.fields.botNameMention')}>
            <input
                type='text'
                className='workbench-input'
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
            />
        </Field>
        <Field label={t('web.channels.settings.fields.allowedOpenIdsOptional')}>
            <input
                type='text'
                className='workbench-input'
                value={larkAllowedUserIds}
                onChange={(e) => setLarkAllowedUserIds(e.target.value)}
                placeholder='ou_xxxx, ou_yyyy'
            />
        </Field>
        <Field label={t('web.channels.settings.fields.operatorOpenIdsOptional')}>
            <input
                type='text'
                className='workbench-input'
                value={larkOperatorUserIds}
                onChange={(e) => setLarkOperatorUserIds(e.target.value)}
                placeholder='ou_xxxx'
            />
        </Field>
        <p className='text-ui text-muted -mt-2'>
            {t('web.channels.settings.help.larkManual')}
        </p>
    </>
    )
}

const larkModeButtonClass = (active: boolean): string =>
    [
        'text-ui flex min-w-0 items-center justify-center gap-2 rounded-sm px-3 py-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'text-muted hover:bg-surface-hover'
    ].join(' ')

const Field: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}) => (
    <label className='block'>
        <span className='text-ui text-fg mb-1 block font-medium'>{label}</span>
        {children}
    </label>
)

const buildBody = (input: {
    agentId: string
    provider: CreateProviderChoice
    label: string
    subscriptionMode: LarkSubscriptionMode
    appId: string
    appSecret: string
    verificationToken: string
    encryptKey: string
    botName: string
    larkAllowedUserIds: string
    larkOperatorUserIds: string
    tgBotToken: string
    slackBotToken: string
    slackSigningSecret: string
    slackAllowedUserIds: string
    slackOperatorUserIds: string
    linearClientId: string
    linearClientSecret: string
    linearWebhookSecret: string
    linearAccessToken: string
    linearAllowedUserIds: string
    githubAllowedRepos: string
    discordBotToken: string
    discordAllowedGuildIds: string
    matrixHomeserver: string
    matrixAccessToken: string
    matrixAllowedRoomIds: string
    matrixAllowedUserIds: string
    matrixFreeResponseRoomIds: string
    weixinBotToken: string
    weixinBaseUrl: string
    weixinAllowedUserIds: string
    weixinOperatorUserIds: string
    lineChannelSecret: string
    lineChannelAccessToken: string
}): CreateChannelBody => {
    if (isLarkProviderChoice(input.provider)) {
        if (
            input.subscriptionMode === 'webhook' &&
            !input.verificationToken.trim() &&
            !input.encryptKey.trim()
        )
            throw new Error(
                translate('web.channels.settings.errors.larkWebhookCredentials')
            )
        const config: LarkChannelConfig = {
            appId: input.appId.trim(),
            appRegion: input.provider,
            subscriptionMode: input.subscriptionMode,
            verificationToken: input.verificationToken.trim() || null,
            encryptKey: input.encryptKey.trim() || null,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: false,
            progressMode: 'preview',
            botName: input.botName.trim() || null,
            allowedUserIds: commaList(input.larkAllowedUserIds),
            operatorUserIds: commaList(input.larkOperatorUserIds)
        }
        const credentials: ChannelCredentials = {
            appSecret: input.appSecret.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'lark',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'telegram') {
        const config: TelegramChannelConfig = {
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        }
        const credentials: ChannelCredentials = {
            botToken: input.tgBotToken.trim(),
            webhookSecret: null
        }
        return {
            agentId: input.agentId,
            provider: 'telegram',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'slack') {
        const config: SlackChannelConfig = {
            allowedUserIds: commaList(input.slackAllowedUserIds),
            operatorUserIds: commaList(input.slackOperatorUserIds),
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        }
        const credentials: ChannelCredentials = {
            botToken: input.slackBotToken.trim(),
            signingSecret: input.slackSigningSecret.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'slack',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'linear') {
        const clientId = input.linearClientId.trim()
        const clientSecret = input.linearClientSecret.trim()
        const accessToken = input.linearAccessToken.trim()
        if (!accessToken && !(clientId && clientSecret))
            throw new Error(
                translate('web.channels.settings.errors.linearCredentials')
            )
        const config: LinearChannelConfig = {
            allowedUserIds: commaList(input.linearAllowedUserIds),
            progressMode: 'activity'
        }
        const credentials: ChannelCredentials = {
            webhookSecret: input.linearWebhookSecret.trim(),
            ...(clientId ? { clientId } : {}),
            ...(clientSecret ? { clientSecret } : {}),
            ...(accessToken ? { accessToken } : {})
        }
        return {
            agentId: input.agentId,
            provider: 'linear',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'github') {
        const config: GithubChannelConfig = {
            allowedRepos: commaList(input.githubAllowedRepos),
            allowedUserIds: [],
            operatorUserIds: [],
            // Empty = server default (OWNER/MEMBER/COLLABORATOR).
            allowedAssociations: [],
            progressMode: 'preview'
        }
        return {
            agentId: input.agentId,
            provider: 'github',
            label: input.label.trim(),
            config,
            // The manifest flow on the channel page fills these in.
            credentials: null
        }
    }
    if (input.provider === 'discord') {
        const allowedGuildIds = input.discordAllowedGuildIds
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        const config: DiscordChannelConfig = {
            allowedGuildIds,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            autoThread: false,
            progressMode: 'preview',
            finalMessageMode: 'edit'
        }
        const credentials: ChannelCredentials = {
            botToken: input.discordBotToken.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'discord',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'matrix') {
        const homeserver = input.matrixHomeserver.trim()
        if (!homeserver)
            throw new Error(
                translate('web.channels.settings.errors.matrixHomeserver')
            )
        if (!input.matrixAccessToken.trim())
            throw new Error(
                translate('web.channels.settings.errors.matrixAccessToken')
            )
        const config: MatrixChannelConfig = {
            homeserver,
            botUserId: null,
            botDisplayName: null,
            allowedRoomIds: commaList(input.matrixAllowedRoomIds),
            allowedUserIds: commaList(input.matrixAllowedUserIds),
            freeResponseRoomIds: commaList(input.matrixFreeResponseRoomIds),
            autoJoin: true,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            autoThread: true,
            progressMode: 'preview'
        }
        const credentials: ChannelCredentials = {
            accessToken: input.matrixAccessToken.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'matrix',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'weixin') {
        if (!input.weixinBotToken.trim())
            throw new Error(
                translate('web.channels.settings.errors.weixinBotToken')
            )
        const config: WeixinChannelConfig = {
            botId: null,
            allowedUserIds: commaList(input.weixinAllowedUserIds),
            operatorUserIds: commaList(input.weixinOperatorUserIds),
            progressMode: 'final',
            outboundFiles: true,
            contextProjection: true
        }
        const credentials: ChannelCredentials = {
            botToken: input.weixinBotToken.trim(),
            baseUrl: input.weixinBaseUrl.trim() || null
        }
        return {
            agentId: input.agentId,
            provider: 'weixin',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'line') {
        const channelSecret = input.lineChannelSecret.trim()
        const channelAccessToken = input.lineChannelAccessToken.trim()
        if (!channelSecret || !channelAccessToken)
            throw new Error(
                translate('web.channels.settings.errors.lineCredentials')
            )
        const config: LineChannelConfig = {
            allowedUserIds: [],
            operatorUserIds: [],
            allowedChatIds: [],
            mentionOnly: true,
            shareSessionInChannel: false,
            progressMode: 'final'
        }
        const credentials: ChannelCredentials = {
            channelSecret,
            channelAccessToken
        }
        return {
            agentId: input.agentId,
            provider: 'line',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    throw new Error(
        translate('web.channels.settings.errors.unsupportedProvider', {
            provider: input.provider
        })
    )
}

const commaList = (raw: string): string[] =>
    raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

export default ChannelsList
