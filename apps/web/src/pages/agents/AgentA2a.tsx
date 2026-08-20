import type {
    A2aExposure,
    A2aGrantSummary,
    A2aOutboundGrantSummary,
    A2aTaskTraceItem
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import { Ghost } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDateTime } from '@/lib/dateFormat'
import { a2aEndpointUrls } from '@/pages/agents/a2aUrls'
import A2aStateBadge from '@/components/a2a/A2aStateBadge'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { Tag } from '@/components/Tag'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { a2aPeerLabel, formatElapsed, formatTokens } from '@/lib/a2aTaskState'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import A2aGrantDialog from '@/components/a2a/A2aGrantDialog'
import {
    CheckIcon,
    CopyIcon,
    PlusIcon,
    ShieldAlertIcon,
    TrashIcon
} from '@/components/icons'

interface AgentA2aProps {
    agentId: string
}

type DirectionFilter = 'all' | 'inbound' | 'outbound'

const resolveApiOrigin = (): string => {
    const base = import.meta.env.VITE_API_URL ?? '/api'
    if (base.startsWith('http')) return base
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}${base}`
}

const formatTime = (iso: string): string => formatDateTime(iso)

// Runtimes that carry a runtime identity and can therefore act as an A2A
// caller.
const isCallerRuntime = (runtime: string): boolean =>
    runtime === 'sprites' || runtime === 'daemon' || runtime === 'k8s'

export const AgentA2a: FC<AgentA2aProps> = ({ agentId }): ReactNode => {
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [exposure, setExposure] = useState<A2aExposure | null>(null)
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [grants, setGrants] = useState<A2aGrantSummary[]>([])
    const [outboundGrants, setOutboundGrants] = useState<
        A2aOutboundGrantSummary[]
    >([])
    const [tasks, setTasks] = useState<A2aTaskTraceItem[]>([])
    const [tasksCursor, setTasksCursor] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [copied, setCopied] = useState<string | null>(null)
    const [addInbound, setAddInbound] = useState(false)
    const [addOutbound, setAddOutbound] = useState(false)
    const [dirFilter, setDirFilter] = useState<DirectionFilter>('all')
    const [stateFilter, setStateFilter] = useState<string>('all')

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true)
        setError(null)
        try {
            const [exp, grantList, agentList, taskPage, outbound] =
                await Promise.all([
                    client.a2a.getExposure(agentId),
                    client.a2a.listGrants(agentId),
                    client.agents.list(),
                    client.a2a.listTasks(agentId),
                    client.a2a.listOutboundGrants(agentId)
                ])
            setExposure(exp)
            setGrants(grantList)
            setAgents(agentList)
            setTasks(taskPage.tasks)
            setTasksCursor(taskPage.nextCursor)
            setOutboundGrants(outbound)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [agentId, client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const reloadGrants = useCallback(async (): Promise<void> => {
        try {
            setGrants(await client.a2a.listGrants(agentId))
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }, [agentId, client])

    const reloadOutbound = useCallback(async (): Promise<void> => {
        try {
            setOutboundGrants(await client.a2a.listOutboundGrants(agentId))
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }, [agentId, client])

    const reloadTasks = useCallback(
        async (state: string): Promise<void> => {
            try {
                const page = await client.a2a.listTasks(
                    agentId,
                    state === 'all' ? undefined : { state }
                )
                setTasks(page.tasks)
                setTasksCursor(page.nextCursor)
            } catch (err) {
                setError(apiErrorMessage(err))
            }
        },
        [agentId, client]
    )

    const toggle = useCallback(async (): Promise<void> => {
        const enabling = !exposure?.enabled
        if (!enabling) {
            const ok = await confirm({
                title: t('web.agents.detail.a2a.disableTitle'),
                description: t('web.agents.detail.a2a.disableDescription'),
                confirmLabel: t('web.agents.detail.a2a.disableAction'),
                tone: 'danger'
            })
            if (!ok) return
        }
        setSaving(true)
        setError(null)
        try {
            const next = await client.a2a.setExposure(agentId, {
                enabled: enabling
            })
            setExposure(next)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSaving(false)
        }
    }, [agentId, client, confirm, exposure])

    const revoke = useCallback(
        async (grant: A2aGrantSummary): Promise<void> => {
            const label = grant.callerAgentId
                ? (grant.callerAgentName ?? grant.callerAgentId)
                : t('web.agents.detail.a2a.externalClient')
            const ok = await confirm({
                title: t('web.agents.detail.a2a.revokeGrantTitle'),
                description: (
                    <>
                        {t('web.agents.detail.a2a.revokeGrantPrefix')}{' '}
                        <code className='font-mono'>{label}</code>
                        {t('web.agents.detail.a2a.revokeGrantSuffix')}
                    </>
                ),
                confirmLabel: t('web.agents.detail.a2a.revokeAction'),
                tone: 'danger'
            })
            if (!ok) return
            setError(null)
            try {
                await client.a2a.revokeGrant(agentId, grant.tokenId)
                setGrants((prev) =>
                    prev.filter((g) => g.tokenId !== grant.tokenId)
                )
            } catch (err) {
                setError(apiErrorMessage(err))
            }
        },
        [agentId, client, confirm]
    )

    const revokeOutbound = useCallback(
        async (grant: A2aOutboundGrantSummary): Promise<void> => {
            const label = grant.targetAgentName ?? grant.targetAgentId
            const ok = await confirm({
                title: t('web.agents.detail.a2a.revokeAuthorizationTitle'),
                description: (
                    <>
                        {t('web.agents.detail.a2a.revokeAuthorizationPrefix')}{' '}
                        <code className='font-mono'>{label}</code>?
                    </>
                ),
                confirmLabel: t('web.agents.detail.a2a.revokeAction'),
                tone: 'danger'
            })
            if (!ok) return
            setError(null)
            try {
                await client.a2a.revokeGrant(agentId, grant.tokenId)
                setOutboundGrants((prev) =>
                    prev.filter((g) => g.tokenId !== grant.tokenId)
                )
            } catch (err) {
                setError(apiErrorMessage(err))
            }
        },
        [agentId, client, confirm]
    )

    // Outbound convenience: flip on A2A for an unreachable target (one of the
    // user's own agents) without leaving this tab.
    const enableTarget = useCallback(
        async (grant: A2aOutboundGrantSummary): Promise<void> => {
            const label = grant.targetAgentName ?? grant.targetAgentId
            const ok = await confirm({
                title: t('web.agents.detail.a2a.enableTargetTitle'),
                description: (
                    <>
                        {t('web.agents.detail.a2a.enableTargetPrefix')}{' '}
                        <code className='font-mono'>{label}</code>{' '}
                        {t('web.agents.detail.a2a.enableTargetSuffix')}
                    </>
                ),
                confirmLabel: t('web.agents.detail.a2a.enableAction')
            })
            if (!ok) return
            setError(null)
            try {
                await client.a2a.setExposure(grant.targetAgentId, {
                    enabled: true
                })
                await reloadOutbound()
            } catch (err) {
                setError(apiErrorMessage(err))
            }
        },
        [client, confirm, reloadOutbound]
    )

    const loadMoreTasks = useCallback(async (): Promise<void> => {
        if (!tasksCursor) return
        try {
            const page = await client.a2a.listTasks(agentId, {
                cursor: tasksCursor,
                ...(stateFilter === 'all' ? {} : { state: stateFilter })
            })
            setTasks((prev) => [...prev, ...page.tasks])
            setTasksCursor(page.nextCursor)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }, [agentId, client, tasksCursor, stateFilter])

    const copy = useCallback(
        async (text: string, key: string): Promise<void> => {
            try {
                await navigator.clipboard.writeText(text)
                setCopied(key)
                window.setTimeout(
                    () => setCopied((c) => (c === key ? null : c)),
                    1500
                )
            } catch {
                /* clipboard unavailable */
            }
        },
        []
    )

    const enabled = exposure?.enabled ?? false
    const urls = a2aEndpointUrls(agentId, resolveApiOrigin())
    // Only runtime-identity agents can act as a caller. Never offer the agent
    // itself, nor a caller that is already granted.
    const grantedCallerIds = new Set(
        grants.map((g) => g.callerAgentId).filter((id): id is string => !!id)
    )
    const callerOptions = agents.filter(
        (agent) =>
            isCallerRuntime(agent.runtime) &&
            agent.id !== agentId &&
            !grantedCallerIds.has(agent.id)
    )
    // Outbound: this agent must itself be a caller-runtime to delegate. Targets
    // can be any of my other agents, minus ones already authorized.
    const selfAgent = agents.find((agent) => agent.id === agentId)
    const canCall = selfAgent ? isCallerRuntime(selfAgent.runtime) : false
    const grantedTargetIds = new Set(outboundGrants.map((g) => g.targetAgentId))
    const targetOptions = agents.filter(
        (agent) => agent.id !== agentId && !grantedTargetIds.has(agent.id)
    )
    const visibleTasks =
        dirFilter === 'all'
            ? tasks
            : tasks.filter((t) => t.direction === dirFilter)
    const lastCallElapsed =
        tasks.length > 0 ? formatElapsed(tasks[0].createdAt) : ''
    const filtersActive = dirFilter !== 'all' || stateFilter !== 'all'

    return (
        <section>
            <header className='mb-4'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                    <h2 className='text-h3 text-fg tracking-tight'>
                        {t('web.agents.detail.a2a.title')}
                    </h2>
                    <span className='flex-1' />
                    <EffectTimingTag timing='immediate' />
                </div>
                <p className='text-caption text-muted mt-1.5'>
                    {t('web.agents.detail.a2a.descriptionPrefix')}{' '}
                    <code className='font-mono'>mf a2a</code>{' '}
                    {t('web.agents.detail.a2a.descriptionSuffix')}
                </p>
            </header>

            {error ? (
                <div className='workbench-alert-error mb-4'>{error}</div>
            ) : null}

            {loading ? (
                <div
                    className='workbench-panel space-y-3 px-4 py-4'
                    aria-busy='true'
                >
                    <Ghost variant='line' className='w-1/3' />
                    <Ghost variant='cap' className='w-3/5' />
                    <Ghost variant='cap' className='w-2/5' />
                </div>
            ) : exposure === null ? null : (
                <div className='space-y-4'>
                    <div className='workbench-panel p-4'>
                        <div className='flex items-center justify-between gap-3'>
                            <div className='flex min-w-0 items-center gap-2.5'>
                                <span
                                    aria-hidden='true'
                                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                        enabled ? 'bg-success' : 'bg-idle'
                                    }`}
                                />
                                <div className='min-w-0'>
                                    <div className='text-ui text-fg font-medium'>
                                        {enabled
                                            ? t(
                                                  'web.agents.detail.a2a.serving'
                                              )
                                            : t(
                                                  'web.agents.detail.a2a.notExposed'
                                              )}
                                    </div>
                                    <div className='text-subtle text-caption'>
                                        {enabled
                                            ? exposure?.enabledAt
                                                ? t(
                                                      'web.agents.detail.a2a.enabledAt',
                                                      {
                                                          date: formatTime(
                                                              exposure.enabledAt
                                                          )
                                                      }
                                                  )
                                                : t(
                                                      'web.agents.detail.a2a.acceptsCalls'
                                                  )
                                            : t(
                                                  'web.agents.detail.a2a.notAcceptingCalls'
                                              )}
                                    </div>
                                </div>
                            </div>
                            <button
                                type='button'
                                className={
                                    enabled
                                        ? 'workbench-button-secondary'
                                        : 'workbench-button-primary'
                                }
                                disabled={saving}
                                onClick={() => void toggle()}
                            >
                                {saving
                                    ? t('web.agents.detail.saving')
                                    : enabled
                                      ? t(
                                            'web.agents.detail.a2a.disableAction'
                                        )
                                      : t(
                                            'web.agents.detail.a2a.enableAction'
                                        )}
                            </button>
                        </div>

                        {enabled ? (
                            <div className='mt-4 space-y-2'>
                                <EndpointRow
                                    label={t(
                                        'web.agents.detail.a2a.agentCardUrl'
                                    )}
                                    value={urls.cardUrl}
                                    copyKey='card'
                                    copied={copied}
                                    onCopy={copy}
                                />
                                <EndpointRow
                                    label={t(
                                        'web.agents.detail.a2a.rpcEndpoint'
                                    )}
                                    value={urls.rpcUrl}
                                    copyKey='rpc'
                                    copied={copied}
                                    onCopy={copy}
                                />
                                <div className='text-subtle text-caption flex flex-wrap gap-x-3 pt-1'>
                                    <span>
                                        <span className='text-fg font-medium'>
                                            {grants.length}
                                        </span>{' '}
                                        {grants.length === 1
                                            ? t(
                                                  'web.agents.detail.a2a.caller'
                                              )
                                            : t(
                                                  'web.agents.detail.a2a.callers'
                                              )}
                                    </span>
                                    {canCall ? (
                                        <span>
                                            <span className='text-fg font-medium'>
                                                {outboundGrants.length}
                                            </span>{' '}
                                                {outboundGrants.length === 1
                                                ? t(
                                                      'web.agents.detail.a2a.target'
                                                  )
                                                : t(
                                                      'web.agents.detail.a2a.targets'
                                                  )}
                                        </span>
                                    ) : null}
                                    {lastCallElapsed ? (
                                        <span>
                                            {t(
                                                'web.agents.detail.a2a.lastCallAgo',
                                                { elapsed: lastCallElapsed }
                                            )}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </div>

                    <div className='workbench-panel p-4'>
                        <div className='mb-3 flex items-center justify-between gap-3'>
                            <h3 className='text-ui text-fg font-medium'>
                                {t('web.agents.detail.a2a.inboundTitle')}
                            </h3>
                            <button
                                type='button'
                                className='workbench-button-secondary gap-2'
                                onClick={() => setAddInbound(true)}
                            >
                                <PlusIcon className='h-4 w-4' />
                                {t('web.agents.detail.a2a.addCaller')}
                            </button>
                        </div>
                        {!enabled ? (
                            <div className='workbench-note mb-3'>
                                {t('web.agents.detail.a2a.inactiveNote')}
                            </div>
                        ) : null}
                        {grants.length === 0 ? (
                            <div className='workbench-note'>
                                {t('web.agents.detail.a2a.noCallers')}
                            </div>
                        ) : (
                            <ul className='divide-divider divide-y'>
                                {grants.map((grant) => (
                                    <GrantRow
                                        key={grant.tokenId}
                                        grant={grant}
                                        onRevoke={() => void revoke(grant)}
                                    />
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className='workbench-panel p-4'>
                        <div className='mb-3 flex items-center justify-between gap-3'>
                            <h3 className='text-ui text-fg font-medium'>
                                {t('web.agents.detail.a2a.outboundTitle')}
                            </h3>
                            {canCall ? (
                                <button
                                    type='button'
                                    className='workbench-button-secondary gap-2'
                                    onClick={() => setAddOutbound(true)}
                                >
                                    <PlusIcon className='h-4 w-4' />
                                    {t('web.agents.detail.a2a.addTarget')}
                                </button>
                            ) : null}
                        </div>
                        {!canCall ? (
                            <div className='workbench-note'>
                                {t('web.agents.detail.a2a.noIdentityPrefix')}{' '}
                                <code className='font-mono'>
                                    {selfAgent?.runtime ?? 'external'}
                                </code>{' '}
                                {t('web.agents.detail.a2a.noIdentitySuffix')}
                            </div>
                        ) : outboundGrants.length === 0 ? (
                            <div className='workbench-note'>
                                {t('web.agents.detail.a2a.noTargets')}
                            </div>
                        ) : (
                            <ul className='divide-divider divide-y'>
                                {outboundGrants.map((grant) => (
                                    <OutboundGrantRow
                                        key={grant.tokenId}
                                        grant={grant}
                                        onRevoke={() =>
                                            void revokeOutbound(grant)
                                        }
                                        onEnable={() =>
                                            void enableTarget(grant)
                                        }
                                    />
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className='workbench-panel p-4'>
                        <div className='mb-3 flex flex-wrap items-center justify-between gap-3'>
                            <h3 className='text-ui text-fg font-medium'>
                                {t('web.agents.detail.a2a.activity')}
                            </h3>
                            <div className='flex items-center gap-2'>
                                <WorkbenchSelect
                                    size='sm'
                                    className='w-40'
                                    ariaLabel={t(
                                        'web.agents.detail.a2a.filterDirection'
                                    )}
                                    value={dirFilter}
                                    onChange={(next) =>
                                        setDirFilter(next as DirectionFilter)
                                    }
                                    options={[
                                        {
                                            value: 'all',
                                            label: t(
                                                'web.agents.detail.a2a.allDirections'
                                            )
                                        },
                                        {
                                            value: 'inbound',
                                            label: t(
                                                'web.backgroundTasks.direction.inbound'
                                            )
                                        },
                                        {
                                            value: 'outbound',
                                            label: t(
                                                'web.backgroundTasks.direction.outbound'
                                            )
                                        }
                                    ]}
                                />
                                <WorkbenchSelect
                                    size='sm'
                                    className='w-40'
                                    ariaLabel={t(
                                        'web.agents.detail.a2a.filterState'
                                    )}
                                    value={stateFilter}
                                    onChange={(next) => {
                                        setStateFilter(next)
                                        void reloadTasks(next)
                                    }}
                                    options={[
                                        {
                                            value: 'all',
                                            label: t(
                                                'web.agents.detail.a2a.anyState'
                                            )
                                        },
                                        {
                                            value: 'working',
                                            label: t(
                                                'web.backgroundTasks.states.working'
                                            )
                                        },
                                        {
                                            value: 'completed',
                                            label: t(
                                                'web.backgroundTasks.states.completed'
                                            )
                                        },
                                        {
                                            value: 'failed',
                                            label: t(
                                                'web.backgroundTasks.states.failed'
                                            )
                                        },
                                        {
                                            value: 'input-required',
                                            label: t(
                                                'web.backgroundTasks.states.input-required'
                                            )
                                        },
                                        {
                                            value: 'canceled',
                                            label: t(
                                                'web.backgroundTasks.states.canceled'
                                            )
                                        }
                                    ]}
                                />
                            </div>
                        </div>
                        {visibleTasks.length === 0 ? (
                            <div className='workbench-note'>
                                {filtersActive
                                    ? t(
                                          'web.agents.detail.a2a.noFilteredCalls'
                                      )
                                    : t('web.agents.detail.a2a.noCalls')}
                            </div>
                        ) : (
                            <ul className='divide-divider divide-y'>
                                {visibleTasks.map((task) => (
                                    <TaskRow
                                        key={task.id}
                                        agentId={agentId}
                                        task={task}
                                    />
                                ))}
                            </ul>
                        )}
                        {tasksCursor ? (
                            <button
                                type='button'
                                className='workbench-button-secondary mt-3'
                                onClick={() => void loadMoreTasks()}
                            >
                                {t('web.agents.detail.a2a.loadMore')}
                            </button>
                        ) : null}
                    </div>
                </div>
            )}

            {addInbound ? (
                <A2aGrantDialog
                    agentId={agentId}
                    direction='inbound'
                    options={callerOptions}
                    emptyReason={t('web.agents.detail.a2a.noCallerOptions')}
                    rpcUrl={urls.rpcUrl}
                    onClose={() => {
                        setAddInbound(false)
                        void reloadGrants()
                    }}
                />
            ) : null}

            {addOutbound ? (
                <A2aGrantDialog
                    agentId={agentId}
                    direction='outbound'
                    options={targetOptions}
                    emptyReason={t('web.agents.detail.a2a.noTargetOptions')}
                    rpcUrl={urls.rpcUrl}
                    onClose={() => {
                        setAddOutbound(false)
                        void reloadOutbound()
                    }}
                />
            ) : null}

            {confirmDialog}
        </section>
    )
}

interface GrantRowProps {
    grant: A2aGrantSummary
    onRevoke: () => void
}

const GrantRow: FC<GrantRowProps> = ({ grant, onRevoke }): ReactNode => {
    const external = !grant.callerAgentId
    return (
        <li className='flex items-center justify-between gap-3 py-2.5'>
            <div className='min-w-0'>
                <div className='flex items-center gap-2'>
                    <span className='text-fg text-ui truncate'>
                        {external
                            ? (grant.name ??
                              t('web.agents.detail.a2a.externalClient'))
                            : (grant.callerAgentName ?? grant.callerAgentId)}
                    </span>
                    <Tag>
                        {external
                            ? t('web.agents.detail.a2a.external')
                            : t('web.agents.detail.a2a.agent')}
                    </Tag>
                </div>
                <div className='text-subtle text-caption'>
                    {t('web.agents.detail.a2a.grantedAt', {
                        date: formatTime(grant.createdAt)
                    })}
                    {grant.lastUsedAt
                        ? t('web.agents.detail.a2a.lastUsedAt', {
                              date: formatTime(grant.lastUsedAt)
                          })
                        : ''}
                    {grant.expiresAt
                        ? t('web.agents.detail.a2a.expiresAt', {
                              date: formatTime(grant.expiresAt)
                          })
                        : ''}
                </div>
            </div>
            <ShortcutTooltip
                label={t('web.agents.detail.a2a.revokeAccess')}
                placement='bottom-end'
            >
                <button
                    type='button'
                    aria-label={t('web.agents.detail.a2a.revokeAccess')}
                    className='text-muted hover:text-error hover:bg-danger-bg rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors'
                    onClick={onRevoke}
                >
                    <TrashIcon className='h-4 w-4' />
                </button>
            </ShortcutTooltip>
        </li>
    )
}

interface OutboundGrantRowProps {
    grant: A2aOutboundGrantSummary
    onRevoke: () => void
    onEnable: () => void
}

const OutboundGrantRow: FC<OutboundGrantRowProps> = ({
    grant,
    onRevoke,
    onEnable
}): ReactNode => (
    <li className='flex items-center justify-between gap-3 py-2.5'>
        <div className='min-w-0'>
            <div className='flex items-center gap-2'>
                <span className='text-fg text-ui truncate'>
                    {grant.targetAgentName ?? grant.targetAgentId}
                </span>
                {grant.targetExposed ? (
                    <span className='text-success text-caption inline-flex shrink-0 items-center gap-1'>
                        <CheckIcon className='h-3.5 w-3.5' />
                        {t('web.agents.detail.a2a.reachable')}
                    </span>
                ) : (
                    <ShortcutTooltip
                        label={t('web.agents.detail.a2a.enableTargetTooltip', {
                            target: grant.targetAgentName ?? grant.targetAgentId
                        })}
                        className='shrink-0'
                    >
                        <button
                            type='button'
                            onClick={onEnable}
                            className='text-warning text-caption inline-flex items-center gap-1 font-medium hover:underline'
                        >
                            <ShieldAlertIcon className='h-3.5 w-3.5' />
                            {t('web.agents.detail.a2a.a2aOffEnable')}
                        </button>
                    </ShortcutTooltip>
                )}
            </div>
            <div className='text-subtle text-caption'>
                {t('web.agents.detail.a2a.authorizedAt', {
                    date: formatTime(grant.createdAt)
                })}
                {grant.lastUsedAt
                    ? t('web.agents.detail.a2a.lastUsedAt', {
                          date: formatTime(grant.lastUsedAt)
                      })
                    : ''}
            </div>
        </div>
        <ShortcutTooltip
            label={t('web.agents.detail.a2a.revokeAuthorizationTitle')}
            placement='bottom-end'
        >
            <button
                type='button'
                aria-label={t(
                    'web.agents.detail.a2a.revokeAuthorizationTitle'
                )}
                className='text-muted hover:text-error hover:bg-danger-bg rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors'
                onClick={onRevoke}
            >
                <TrashIcon className='h-4 w-4' />
            </button>
        </ShortcutTooltip>
    </li>
)

interface TaskRowProps {
    agentId: string
    task: A2aTaskTraceItem
}

const TaskRow: FC<TaskRowProps> = ({ agentId, task }): ReactNode => {
    const duration = formatElapsed(task.createdAt, task.completedAt)
    const tokens = formatTokens(task.usage)
    return (
        <li className='flex items-start justify-between gap-3 py-2.5'>
            <div className='min-w-0'>
                <div className='text-fg text-ui truncate'>
                    <span className='text-subtle'>
                        {task.direction === 'inbound'
                            ? t('web.agents.detail.a2a.fromPrefix')
                            : t('web.agents.detail.a2a.toPrefix')}
                    </span>
                    {a2aPeerLabel(task)}
                </div>
                {task.errorMessage ? (
                    <ShortcutTooltip
                        label={task.errorMessage}
                        className='w-full min-w-0'
                    >
                        <div className='text-error text-caption w-full truncate'>
                            {task.errorMessage}
                        </div>
                    </ShortcutTooltip>
                ) : null}
                <div className='text-subtle text-caption flex flex-wrap items-center gap-x-2'>
                    <span>{formatTime(task.createdAt)}</span>
                    {duration ? <span>· {duration}</span> : null}
                    {tokens ? (
                        <span>
                            {t('web.agents.detail.a2a.tokens', { tokens })}
                        </span>
                    ) : null}
                    {task.chatSessionId ? (
                        <Link
                            to={`/agents/${agentId}/chat`}
                            className='text-link hover:text-fg'
                        >
                            {t('web.agents.detail.a2a.openChat')}
                        </Link>
                    ) : null}
                </div>
            </div>
            <A2aStateBadge state={task.state} />
        </li>
    )
}

interface EndpointRowProps {
    label: string
    value: string
    copyKey: string
    copied: string | null
    onCopy: (text: string, key: string) => Promise<void>
}

const EndpointRow: FC<EndpointRowProps> = ({
    label,
    value,
    copyKey,
    copied,
    onCopy
}): ReactNode => (
    <div>
        <div className='text-subtle text-caption mb-1'>{label}</div>
        <div className='flex items-center gap-2'>
            <code className='bg-surface-subtle shadow-ring-light text-ui text-fg flex-1 truncate rounded-sm px-2 py-1 font-mono'>
                {value}
            </code>
            <button
                type='button'
                className='workbench-button-secondary gap-2'
                onClick={() => void onCopy(value, copyKey)}
            >
                {copied === copyKey ? (
                    <CheckIcon className='h-4 w-4' />
                ) : (
                    <CopyIcon className='h-4 w-4' />
                )}
                {copied === copyKey
                    ? t('web.chat.copied')
                    : t('web.chat.copy')}
            </button>
        </div>
    </div>
)
