import type {
    ChannelActivityReport,
    ChannelProviderName,
    ChannelSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Link,
    Outlet,
    useMatch,
    useNavigate,
    useSearchParams
} from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import {
    AgentIcon,
    ChannelIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloseIcon,
    ListViewIcon,
    ZapIcon
} from '@/components/icons'
import { CreateMenu } from '@/components/CreateMenu'
import ChannelsDashboard from '@/pages/Settings/Channels/ChannelsDashboard'
import EmptyState from '@/components/EmptyState'
import { GhostRailRows } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'
import { useApiClient } from '@/lib/apiClient'
import {
    GroupByControl,
    type GroupByOption,
    GroupHeader,
    type Health,
    useCascadeState
} from '@/lib/cascade'
import {
    CHANNEL_DOT,
    ChannelProviderIcon,
    channelLabel
} from '@/lib/channelMeta'
import { NEW_CHANNEL_OPTIONS, wireProvider } from '@/lib/newChannelOptions'
import { apiErrorMessage } from '@/lib/errorMessage'

type ChannelStatus = ChannelSummary['status']
type GroupBy = 'none' | 'provider' | 'agent' | 'status'

const CHANNEL_DIMS = ['none', 'provider', 'agent', 'status'] as const

// Reserved segment under the :id route. Channel ids are prefixed ObjectIds
// (chn_...), so a bare word can never collide with one.
const DASHBOARD_SEGMENT = 'dashboard'

const PROVIDER_ORDER: ChannelProviderName[] = [
    'lark',
    'telegram',
    'slack',
    'discord',
    'matrix',
    'weixin',
    'whatsapp',
    'linear',
    'github',
    'line',
    'fake'
]

const STATUS_ORDER: ChannelStatus[] = ['active', 'paused', 'error', 'draft']

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
    indentClass: string
    subLabel: string
    onSelect: () => void
}> = ({ channel: c, selected, indentClass, subLabel, onSelect }): ReactNode => (
    <button
        type='button'
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={[
            'flex w-full items-center gap-2.5 rounded-sm py-2 pr-2.5 text-left transition-colors',
            indentClass,
            selected ? 'bg-active-session' : 'hover:bg-rail-hover'
        ].join(' ')}
    >
        <ChannelProviderIcon
            provider={c.provider}
            className='h-5 w-5 shrink-0'
        />
        <span className='min-w-0 flex-1'>
            <span className='text-ui text-fg block truncate'>{c.label}</span>
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
    // The edit page is a sub-route of a channel, so the rail must still read
    // the id out of it or the selected row would lose its highlight.
    const editMatch = useMatch('/settings/channels/:id/edit')
    const createMatch = useMatch('/settings/channels/new/:provider')
    const createProvider = createMatch?.params.provider ?? null
    const segment = match?.params.id ?? editMatch?.params.id ?? null
    const onDashboard = segment === DASHBOARD_SEGMENT
    const selectedId = onDashboard ? null : segment
    // Unchanged semantics: the explicit /dashboard URL hides the rail on
    // mobile, the bare URL keeps it, exactly as the runtimes rail behaves.
    const hasSelection = Boolean(segment) || Boolean(createProvider)

    const [channels, setChannels] = useState<ChannelSummary[]>([])
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [activity, setActivity] = useState<ChannelActivityReport | null>(null)
    const [activityLoading, setActivityLoading] = useState(false)
    const [searchParams, setSearchParams] = useSearchParams()
    const lastRevealed = useRef<string | null>(null)

    const {
        groupBy,
        setGroupBy,
        expanded,
        toggle,
        collapseAll,
        expandAll,
        reveal
        // v2: the store persists groupBy on first mount, so changing the
        // fallback alone never reaches a browser that has opened the page
        // before — the key bump is what makes None the default for everyone.
    } = useCascadeState('mf.channels.cascade.v2', CHANNEL_DIMS, 'none')

    const agentFilter = searchParams.get('agent') ?? ''

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

    // Dashboard-only fetch: a failure degrades to em-dashes on the cards and
    // never reaches the rail's error banner.
    useEffect(() => {
        if (hasSelection) return
        let cancelled = false
        setActivityLoading(true)
        client.channels
            .activity()
            .then((r) => {
                if (!cancelled) setActivity(r)
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setActivityLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, hasSelection])

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

    // The create page and the detail page both mutate what the rail reads,
    // and this component stays mounted across both, so refetch on the edge
    // where either is left — otherwise the rail shows a pre-create list.
    const prevDetail = useRef<string | null>(selectedId ?? createProvider)
    useEffect(() => {
        const current = selectedId ?? createProvider
        if (prevDetail.current && !current) void refresh()
        prevDetail.current = current
    }, [selectedId, createProvider, refresh])

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
        // None is one unheadered group, so the header-only fields stay empty:
        // the rail lists every channel flat, in the API's most-recent order.
        if (groupBy === 'none')
            return baseChannels.length === 0
                ? []
                : [
                      {
                          key: 'all',
                          label: '',
                          count: baseChannels.length,
                          health: null,
                          items: baseChannels
                      }
                  ]

        if (groupBy === 'provider') {
            const out: ChannelGroup[] = []
            for (const provider of PROVIDER_ORDER) {
                const items = baseChannels.filter(
                    (c) => c.provider === provider
                )
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
                const items = baseChannels.filter((c) => c.status === s)
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
        for (const c of baseChannels) {
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
    }, [baseChannels, groupBy, agentById])

    const totalCount = useMemo(
        () => groups.reduce((n, g) => n + g.count, 0),
        [groups]
    )
    const allKeys = useMemo(() => groups.map((g) => g.key), [groups])

    const keysForSelection = useCallback(
        (id: string): string[] => {
            if (groupBy === 'none') return []
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

    const isOpen = (key: string): boolean => expanded.has(key)
    const anyExpanded = expanded.size > 0
    const canCreate = agents.length > 0
    const createOptions = NEW_CHANNEL_OPTIONS.map((option) => ({
        key: option.provider,
        lead: (
            <ChannelProviderIcon
                provider={wireProvider(option.provider)}
                className='h-4 w-4'
            />
        ),
        label: option.label,
        to: option.to
    }))
    const groupByOptions: ReadonlyArray<GroupByOption<GroupBy>> = [
        {
            value: 'none',
            label: t('web.channels.settings.groupBy.none'),
            icon: ListViewIcon
        },
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

    const subLabelFor = (c: ChannelSummary): string => {
        if (groupBy === 'provider') return c.agent.name
        if (groupBy === 'agent') return channelLabel(c.provider)
        return `${channelLabel(c.provider)} · ${c.agent.name}`
    }

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
                {groupBy !== 'none' && (
                    <GroupHeader
                        label={g.label}
                        count={g.count}
                        open={isOpen(g.key)}
                        health={g.health}
                        onToggle={() => toggle(g.key)}
                    />
                )}
                {(groupBy === 'none' || isOpen(g.key)) &&
                    g.items.map((c) => (
                        <ChannelLeaf
                            key={c.id}
                            channel={c}
                            indentClass={groupBy === 'none' ? 'pl-2' : 'pl-8'}
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
                            <Link
                                to={`/settings/channels/${DASHBOARD_SEGMENT}`}
                                aria-current={
                                    !hasSelection ? 'page' : undefined
                                }
                                className='hover:bg-rail-hover -mx-1.5 flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 transition-colors'
                            >
                                <h2 className='text-h3 text-fg tracking-tight'>
                                    {t('web.channels.settings.channels')}
                                </h2>
                                <span className='tag tag-neutral tabular-nums'>
                                    {totalCount}
                                </span>
                            </Link>
                            <CreateMenu
                                options={createOptions}
                                variant='header'
                                disabled={!canCreate}
                                triggerLabel={t(
                                    'web.channels.settings.newChannel'
                                )}
                                sheetTitle={t(
                                    'web.channels.settings.newChannel'
                                )}
                            />
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

                        <div className='flex items-center justify-between gap-2'>
                            <GroupByControl
                                value={groupBy}
                                onChange={setGroupBy}
                                options={groupByOptions}
                            />
                            {groupBy !== 'none' && (
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
                                        ? t('web.channels.settings.collapseAll')
                                        : t('web.channels.settings.expandAll')}
                                </button>
                            )}
                        </div>
                    </div>

                    <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-2'>
                        {renderTree()}
                    </div>

                    <div className='shrink-0 p-2'>
                        <CreateMenu
                            options={createOptions}
                            variant='footer'
                            disabled={!canCreate}
                            triggerLabel={t('web.channels.settings.newChannel')}
                            sheetTitle={t('web.channels.settings.newChannel')}
                        />
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
                    {selectedId || createProvider ? (
                        <Outlet />
                    ) : (
                        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                            {loading ? null : (
                                <ChannelsDashboard
                                    channels={channels}
                                    report={activity}
                                    loading={activityLoading}
                                    createOptions={createOptions}
                                    onSelect={(id) =>
                                        navigate(`/settings/channels/${id}`)
                                    }
                                />
                            )}
                        </div>
                    )}
                </main>
            </div>
        </>
    )
}

export default ChannelsList
