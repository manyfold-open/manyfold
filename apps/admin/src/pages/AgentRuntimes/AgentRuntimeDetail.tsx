import { isExternal } from '@manyfold/shared'
import type {
    AgentRuntimeStatus,
    AgentRuntimeSummary,
    AgentStatus
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import type { SdkAgent } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { openDashboardInPopup } from '@/lib/openDashboard'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import {
    Badge,
    Breadcrumbs,
    Button,
    Card,
    DetailPage,
    Heading,
    type BadgeTone
} from '@/ui'
import AddAgentInline from './components/AddAgentInline'
import UsageTab from '../Agents/components/UsageTab'

type RuntimeTab = 'overview' | 'usage'

const runtimeStatusTone: Record<AgentRuntimeStatus, BadgeTone> = {
    pending: 'warning',
    ready: 'success',
    failed: 'error',
    stopped: 'neutral'
}

const agentStatusTone: Record<AgentStatus, BadgeTone> = {
    pending: 'warning',
    running: 'success',
    stopped: 'neutral',
    failed: 'error'
}

const formatDate = (value: string | null): string =>
    value ? new Date(value).toLocaleString(getLocale()) : '—'

const relativeFromNow = (value: string | null): string => {
    if (!value) return '—'
    const ms = Date.now() - new Date(value).getTime()
    if (ms < 0) return '—'
    const sec = Math.round(ms / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.round(min / 60)
    if (hr < 24) return `${hr}h ago`
    const d = Math.round(hr / 24)
    return `${d}d ago`
}

const Row: FC<{ label: string; value: ReactNode; mono?: boolean }> = ({
    label,
    value,
    mono
}): ReactNode => (
    <div className='border-border grid grid-cols-3 gap-2 border-b px-2 py-1 last:border-0'>
        <dt className='text-caption text-label font-normal'>{label}</dt>
        <dd
            className={[
                'text-caption text-heading col-span-2 break-all',
                mono ? 'font-mono' : ''
            ].join(' ')}
        >
            {value ?? '—'}
        </dd>
    </div>
)

// Dashboard toggle progress helpers — dashboard_state grammar:
// 'enabling@<ISO>' | 'disabling@<ISO>' | 'error:<reason>' | null.
const dashboardStatePending = (state: string | null): boolean =>
    !!state && !state.startsWith('error:')

const dashboardStateError = (state: string | null): string | null =>
    state?.startsWith('error:') ? state.slice('error:'.length) : null

const AgentRuntimeDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const client = useApiClient()
    const {
        user: currentUser,
        isAdmin,
        loading: userLoading
    } = useCurrentUser()
    const currentUserId = currentUser?.id ?? null
    const runtimesApi = isAdmin
        ? client.admin.agentRuntimes
        : client.agentRuntimes
    const agentsApi = isAdmin ? client.admin.agents : client.agents
    const [runtime, setRuntime] = useState<AgentRuntimeSummary | null>(null)
    const [agents, setAgents] = useState<SdkAgent[] | null>(null)
    const [notFound, setNotFound] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [removingId, setRemovingId] = useState<string | null>(null)
    const [deletingRuntime, setDeletingRuntime] = useState(false)
    const [controlUiPending, setControlUiPending] = useState(false)
    const [controlUiError, setControlUiError] = useState<string | null>(null)
    const [dashboardPending, setDashboardPending] = useState(false)
    const [dashboardError, setDashboardError] = useState<string | null>(null)
    const [keepAlivePending, setKeepAlivePending] = useState(false)
    const [keepAliveError, setKeepAliveError] = useState<string | null>(null)
    const [tab, setTab] = useState<RuntimeTab>('overview')

    const handleToggleControlUi = async (): Promise<void> => {
        if (!runtime || controlUiPending) return
        setControlUiPending(true)
        setControlUiError(null)
        try {
            const next = await runtimesApi.setControlUi(
                runtime.id,
                !runtime.controlUiEnabled
            )
            setRuntime(next)
            setControlUiPending(false)
        } catch (err) {
            setControlUiError((err as Error).message)
            setControlUiPending(false)
        }
    }

    const handleToggleDashboard = async (): Promise<void> => {
        if (!runtime || dashboardPending) return
        setDashboardPending(true)
        setDashboardError(null)
        try {
            const next = await runtimesApi.setDashboard(
                runtime.id,
                !runtime.dashboardEnabled
            )
            setRuntime(next)
            setDashboardPending(false)
        } catch (err) {
            setDashboardError((err as Error).message)
            setDashboardPending(false)
        }
    }

    const handleToggleKeepAlive = async (): Promise<void> => {
        if (!runtime || keepAlivePending) return
        setKeepAlivePending(true)
        setKeepAliveError(null)
        try {
            const next = await runtimesApi.setKeepAlive(
                runtime.id,
                !runtime.keepAliveEnabled
            )
            setRuntime(next)
            // no 60s debounce: keep-alive is a sub-second sprite exec, not a
            // k8s pod restart like control-ui/dashboard
            setKeepAlivePending(false)
        } catch (err) {
            setKeepAliveError((err as Error).message)
            setKeepAlivePending(false)
        }
    }

    // Admin opening someone else's runtime mints a session into their
    // dashboard — confirm so the operator knows they're acting on behalf
    // of the owner, not themselves. Returns false when the user cancels.
    const confirmAdminCrossOwnerOpen = (
        kind: 'control UI' | 'dashboard'
    ): boolean => {
        if (!runtime) return false
        if (!currentUserId || currentUserId === runtime.userId) return true
        return window.confirm(
            `This will open the ${kind} as runtime owner ${runtime.userId}. Continue?`
        )
    }

    const handleOpenControlUi = (): void => {
        if (!runtime) return
        openDashboardInPopup(runtimesApi, {
            runtimeId: runtime.id,
            failureTitle: 'Failed to open control UI',
            confirm: () => confirmAdminCrossOwnerOpen('control UI')
        })
    }

    const handleOpenDashboard = (): void => {
        if (!runtime) return
        openDashboardInPopup(runtimesApi, {
            runtimeId: runtime.id,
            failureTitle: 'Failed to open dashboard',
            confirm: () => confirmAdminCrossOwnerOpen('dashboard')
        })
    }

    const refresh = useCallback((): void => {
        if (!id || userLoading) return
        setError(null)
        Promise.all([runtimesApi.get(id), agentsApi.list()])
            .then(([rt, ags]) => {
                setRuntime(rt)
                setAgents(ags.filter((a) => a.runtimeId === rt.id))
            })
            .catch((e: Error) => {
                const msg = e.message
                if (msg.includes('404')) setNotFound(true)
                else setError(msg)
            })
    }, [id, userLoading, runtimesApi, agentsApi])

    useEffect(refresh, [refresh])

    // Sprite hermes toggles run async server-side; poll while
    // dashboard_state is pending so the row settles without a manual reload.
    const dashboardStateValue = runtime?.dashboardState ?? null
    useEffect(() => {
        if (!dashboardStatePending(dashboardStateValue)) return
        const timer = window.setInterval(refresh, 5_000)
        return (): void => window.clearInterval(timer)
    }, [dashboardStateValue, refresh])

    const canAddAgent =
        !!runtime &&
        runtime.kind === 'k8s' &&
        (runtime.framework === 'openclaw' || runtime.framework === 'hermes')

    const handleAddAgent = async (body: {
        name: string
        workspace?: string
        model?: string
        cloneFrom?: string
    }): Promise<SdkAgent> => {
        if (!runtime) throw new Error('runtime not loaded')
        const inserted = await runtimesApi.addAgent(runtime.id, body)
        setAgents((prev) =>
            prev ? [...prev, inserted as SdkAgent] : [inserted as SdkAgent]
        )
        setRuntime((prev) =>
            prev ? { ...prev, agentsCount: prev.agentsCount + 1 } : prev
        )
        return inserted as SdkAgent
    }

    const handleRemoveAgent = async (agent: SdkAgent): Promise<void> => {
        if (
            !window.confirm(
                t('admin.agentRuntimes.detail.agentsSection.removeConfirm')
            )
        )
            return
        setRemovingId(agent.id)
        try {
            await runtimesApi.removeAgent(agent.id)
            setAgents((prev) =>
                prev ? prev.filter((a) => a.id !== agent.id) : prev
            )
            setRuntime((prev) =>
                prev
                    ? {
                          ...prev,
                          agentsCount: Math.max(0, prev.agentsCount - 1)
                      }
                    : prev
            )
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setRemovingId(null)
        }
    }

    const handleDeleteRuntime = async (): Promise<void> => {
        if (!runtime) return
        if (
            !window.confirm(
                `${t('admin.agentRuntimes.actions.deleteConfirm')}\n\n${runtime.name}`
            )
        )
            return
        setDeletingRuntime(true)
        try {
            await runtimesApi.delete(runtime.id)
            navigate(adminRoutes.runtimes)
        } catch (e) {
            setError((e as Error).message)
            setDeletingRuntime(false)
        }
    }

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    {
                        label: t('admin.nav.agentRuntimes'),
                        to: adminRoutes.runtimes
                    },
                    {
                        label:
                            runtime?.name ?? id ?? t('admin.nav.agentRuntimes')
                    }
                ]}
            />

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {notFound && (
                <p className='admin-page-description'>
                    {t('admin.agentRuntimes.detail.notFound')}
                </p>
            )}

            {!runtime && !notFound && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {runtime && (
                <>
                    <div className='mb-2 flex items-start justify-between gap-2'>
                        <div className='min-w-0 flex-1'>
                            <div className='mb-2 flex items-center gap-2'>
                                <Heading level={2}>{runtime.name}</Heading>
                                <Badge tone={runtimeStatusTone[runtime.status]}>
                                    {t(
                                        `admin.agentRuntimes.status.${runtime.status}`
                                    )}
                                </Badge>
                            </div>
                            <p className='text-caption-sm text-body font-mono break-all'>
                                {runtime.id}
                            </p>
                            <div className='text-caption-sm text-body mt-2 flex gap-3 font-mono'>
                                <span>{runtime.framework}</span>
                                <span>·</span>
                                <span>
                                    {t(
                                        `admin.agentRuntimes.kind.${runtime.kind}`
                                    )}
                                </span>
                            </div>
                        </div>
                        <Button
                            variant='neutral'
                            size='sm'
                            onClick={(): void => {
                                void handleDeleteRuntime()
                            }}
                            disabled={deletingRuntime}
                            className='!text-accent-ruby !border-accent-ruby/30 hover:!bg-accent-ruby/5'
                        >
                            {t('admin.agentRuntimes.detail.actions.delete')}
                        </Button>
                    </div>

                    <div className='mb-2 flex gap-2'>
                        <Button
                            variant={tab === 'overview' ? 'primary' : 'ghost'}
                            size='sm'
                            onClick={(): void => setTab('overview')}
                        >
                            Overview
                        </Button>
                        <Button
                            variant={tab === 'usage' ? 'primary' : 'ghost'}
                            size='sm'
                            onClick={(): void => setTab('usage')}
                        >
                            Usage
                        </Button>
                    </div>

                    {tab === 'usage' && (
                        <UsageTab scope='runtime' id={runtime.id} />
                    )}

                    {tab === 'overview' && (
                        <>
                            <Card elevation='ambient' className='mb-2'>
                                <Row
                                    label={t(
                                        'admin.agentRuntimes.detail.info.primaryAgentId'
                                    )}
                                    value={
                                        runtime.primaryAgentId ? (
                                            <Link
                                                to={adminRoutes.agent(
                                                    runtime.primaryAgentId
                                                )}
                                                className='text-brand hover:text-brand-hover font-mono'
                                            >
                                                {runtime.primaryAgentId}
                                            </Link>
                                        ) : null
                                    }
                                />
                                {runtime.kind === 'sprites' && (
                                    <Row
                                        label={t(
                                            'admin.agentRuntimes.detail.info.spriteName'
                                        )}
                                        value={runtime.spriteName}
                                        mono
                                    />
                                )}
                                {runtime.kind === 'k8s' && (
                                    <>
                                        <Row
                                            label={t(
                                                'admin.agentRuntimes.detail.info.namespace'
                                            )}
                                            value={runtime.namespace}
                                            mono
                                        />
                                        <Row
                                            label={t(
                                                'admin.agentRuntimes.detail.info.ingressHost'
                                            )}
                                            value={runtime.ingressHost}
                                            mono
                                        />
                                        <Row
                                            label={t(
                                                'admin.agentRuntimes.detail.info.clusterName'
                                            )}
                                            value={
                                                runtime.clusterName &&
                                                runtime.clusterId ? (
                                                    <Link
                                                        to={adminRoutes.cluster(
                                                            runtime.clusterId
                                                        )}
                                                        className='text-brand hover:text-brand-hover font-mono'
                                                    >
                                                        {runtime.clusterName}
                                                    </Link>
                                                ) : runtime.clusterName ? (
                                                    <span className='font-mono'>
                                                        {runtime.clusterName}
                                                    </span>
                                                ) : runtime.clusterId ? (
                                                    <span className='text-accent-ruby font-mono'>
                                                        {runtime.clusterId}{' '}
                                                        (deleted)
                                                    </span>
                                                ) : null
                                            }
                                        />
                                    </>
                                )}
                                <Row
                                    label={t(
                                        'admin.agentRuntimes.detail.info.mountPath'
                                    )}
                                    value={runtime.mountPath}
                                    mono
                                />
                                {runtime.accountSlug && (
                                    <Row
                                        label={t(
                                            'admin.agentRuntimes.detail.info.accountSlug'
                                        )}
                                        value={runtime.accountSlug}
                                        mono
                                    />
                                )}
                                <Row
                                    label={t(
                                        'admin.agentRuntimes.detail.info.createdAt'
                                    )}
                                    value={
                                        <span className='tnum'>
                                            {formatDate(runtime.createdAt)}
                                        </span>
                                    }
                                />
                                <Row
                                    label={t(
                                        'admin.agentRuntimes.detail.info.lastBootstrappedAt'
                                    )}
                                    value={
                                        <span className='tnum'>
                                            {formatDate(
                                                runtime.lastBootstrappedAt
                                            )}
                                        </span>
                                    }
                                />
                                <Row
                                    label={t(
                                        'admin.agentRuntimes.detail.info.serviceStatus'
                                    )}
                                    value={
                                        <span
                                            className='font-mono'
                                            title={
                                                runtime.serviceStatusAt
                                                    ? formatDate(
                                                          runtime.serviceStatusAt
                                                      )
                                                    : undefined
                                            }
                                        >
                                            {runtime.serviceStatus}
                                            {runtime.serviceStatusAt &&
                                                ` · ${relativeFromNow(runtime.serviceStatusAt)}`}
                                        </span>
                                    }
                                />
                                {runtime.currentPhase && (
                                    <Row
                                        label={t(
                                            'admin.agentRuntimes.detail.info.currentPhase'
                                        )}
                                        value={runtime.currentPhase}
                                        mono
                                    />
                                )}
                                {runtime.failureReason && (
                                    <Row
                                        label={t(
                                            'admin.agentRuntimes.detail.info.failureReason'
                                        )}
                                        value={
                                            <span className='text-accent-ruby'>
                                                {runtime.failureReason}
                                            </span>
                                        }
                                    />
                                )}
                                {runtime.kind === 'sprites' &&
                                    !isExternal(runtime.framework) && (
                                        <Row
                                            label='keepAlive'
                                            value={
                                                <div className='flex flex-wrap items-center gap-3'>
                                                    <span className='font-mono'>
                                                        {runtime.keepAliveEnabled
                                                            ? 'enabled'
                                                            : 'disabled'}
                                                    </span>
                                                    <Button
                                                        variant='neutral'
                                                        size='sm'
                                                        onClick={(): void => {
                                                            void handleToggleKeepAlive()
                                                        }}
                                                        disabled={
                                                            keepAlivePending
                                                        }
                                                    >
                                                        {keepAlivePending
                                                            ? 'saving…'
                                                            : runtime.keepAliveEnabled
                                                              ? 'Disable'
                                                              : 'Enable'}
                                                    </Button>
                                                    {keepAliveError && (
                                                        <span className='text-accent-ruby text-caption-sm'>
                                                            {keepAliveError}
                                                        </span>
                                                    )}
                                                </div>
                                            }
                                        />
                                    )}
                                {runtime.framework === 'openclaw' && (
                                        <Row
                                            label='controlUi'
                                            value={
                                                <div className='flex flex-wrap items-center gap-3'>
                                                    <span className='font-mono'>
                                                        {runtime.controlUiEnabled
                                                            ? 'enabled'
                                                            : 'disabled'}
                                                    </span>
                                                    <Button
                                                        variant='neutral'
                                                        size='sm'
                                                        onClick={(): void => {
                                                            void handleToggleControlUi()
                                                        }}
                                                        disabled={
                                                            controlUiPending ||
                                                            dashboardStatePending(
                                                                runtime.dashboardState
                                                            )
                                                        }
                                                    >
                                                        {controlUiPending ||
                                                        dashboardStatePending(
                                                            runtime.dashboardState
                                                        )
                                                            ? 'restarting…'
                                                            : runtime.controlUiEnabled
                                                              ? 'Disable'
                                                              : 'Enable'}
                                                    </Button>
                                                    {runtime.controlUiEnabled && (
                                                        <Button
                                                            variant='neutral'
                                                            size='sm'
                                                            onClick={(): void => {
                                                                handleOpenControlUi()
                                                            }}
                                                        >
                                                            Open UI ↗
                                                        </Button>
                                                    )}
                                                    {(controlUiError ??
                                                        dashboardStateError(
                                                            runtime.dashboardState
                                                        )) && (
                                                        <span className='text-accent-ruby text-caption-sm'>
                                                            {controlUiError ??
                                                                dashboardStateError(
                                                                    runtime.dashboardState
                                                                )}
                                                        </span>
                                                    )}
                                                </div>
                                            }
                                        />
                                    )}
                                {runtime.framework === 'hermes' && (
                                        <Row
                                            label='dashboard'
                                            value={
                                                <div className='flex flex-wrap items-center gap-3'>
                                                    <span className='font-mono'>
                                                        {runtime.dashboardEnabled
                                                            ? 'enabled'
                                                            : 'disabled'}
                                                    </span>
                                                    {runtime.kind ===
                                                        'sprites' && (
                                                        <Button
                                                            variant='neutral'
                                                            size='sm'
                                                            onClick={(): void => {
                                                                void handleToggleDashboard()
                                                            }}
                                                            disabled={
                                                                dashboardPending ||
                                                                dashboardStatePending(
                                                                    runtime.dashboardState
                                                                )
                                                            }
                                                        >
                                                            {dashboardPending ||
                                                            dashboardStatePending(
                                                                runtime.dashboardState
                                                            )
                                                                ? 'working…'
                                                                : runtime.dashboardEnabled
                                                                  ? 'Disable'
                                                                  : 'Enable'}
                                                        </Button>
                                                    )}
                                                    {runtime.kind ===
                                                        'sprites' &&
                                                        runtime.dashboardEnabled && (
                                                        <Button
                                                            variant='neutral'
                                                            size='sm'
                                                            onClick={
                                                                handleOpenDashboard
                                                            }
                                                        >
                                                            Open Dashboard ↗
                                                        </Button>
                                                    )}
                                                    {(dashboardError ??
                                                        dashboardStateError(
                                                            runtime.dashboardState
                                                        )) && (
                                                        <span className='text-accent-ruby text-caption-sm'>
                                                            {dashboardError ??
                                                                dashboardStateError(
                                                                    runtime.dashboardState
                                                                )}
                                                        </span>
                                                    )}
                                                </div>
                                            }
                                        />
                                    )}
                            </Card>

                            <div className='mb-2 flex items-center justify-between gap-2'>
                                <Heading level={3}>
                                    {t(
                                        'admin.agentRuntimes.detail.agentsSection.title'
                                    )}
                                </Heading>
                                {canAddAgent && (
                                    <AddAgentInline
                                        framework={runtime.framework}
                                        siblingInternalIds={(agents ?? []).map(
                                            (a) => a.internalId
                                        )}
                                        onAdd={handleAddAgent}
                                    />
                                )}
                            </div>

                            {!canAddAgent && runtime.kind === 'k8s' && (
                                <p className='text-caption-sm text-body mb-2'>
                                    {t(
                                        'admin.agentRuntimes.detail.actions.addAgentUnsupported'
                                    )}
                                </p>
                            )}

                            {agents === null ? (
                                <p className='text-caption text-body'>
                                    {t('common.loading')}
                                </p>
                            ) : agents.length === 0 ? (
                                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                                    <p className='admin-page-description'>
                                        {t(
                                            'admin.agentRuntimes.detail.agentsSection.empty'
                                        )}
                                    </p>
                                </div>
                            ) : (
                                <Card
                                    elevation='ambient'
                                    className='overflow-hidden'
                                >
                                    <div className='overflow-x-auto'>
                                        <table className='admin-table w-full min-w-[960px] text-left'>
                                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b tracking-wider uppercase'>
                                                <tr>
                                                    <th className='px-2 py-1.5 font-normal'>
                                                        {t(
                                                            'admin.agentRuntimes.detail.agentsSection.cols.internalId'
                                                        )}
                                                    </th>
                                                    <th className='px-2 py-1.5 font-normal'>
                                                        {t(
                                                            'admin.agentRuntimes.detail.agentsSection.cols.name'
                                                        )}
                                                    </th>
                                                    <th className='px-2 py-1.5 font-normal'>
                                                        {t(
                                                            'admin.agentRuntimes.detail.agentsSection.cols.model'
                                                        )}
                                                    </th>
                                                    <th className='px-2 py-1.5 font-normal'>
                                                        {t(
                                                            'admin.agentRuntimes.detail.agentsSection.cols.workspace'
                                                        )}
                                                    </th>
                                                    <th className='px-2 py-1.5 font-normal'>
                                                        {t(
                                                            'admin.agentRuntimes.detail.agentsSection.cols.status'
                                                        )}
                                                    </th>
                                                    <th className='px-2 py-1.5 font-normal'>
                                                        {t(
                                                            'admin.agentRuntimes.detail.agentsSection.cols.lastReconciledAt'
                                                        )}
                                                    </th>
                                                    <th className='px-2 py-1.5 text-right font-normal' />
                                                </tr>
                                            </thead>
                                            <tbody className='divide-border divide-y'>
                                                {agents.map((a) => {
                                                    const isPrimary =
                                                        a.id ===
                                                        runtime.primaryAgentId
                                                    return (
                                                        <tr
                                                            key={a.id}
                                                            className='hover:bg-surface-muted transition-colors'
                                                        >
                                                            <td className='text-caption text-heading px-2 py-1.5 font-mono'>
                                                                {a.internalId}
                                                                {isPrimary && (
                                                                    <Badge
                                                                        tone='brand'
                                                                        className='ml-2'
                                                                    >
                                                                        {t(
                                                                            'admin.agents.detail.primaryPill'
                                                                        )}
                                                                    </Badge>
                                                                )}
                                                            </td>
                                                            <td className='px-2 py-1.5'>
                                                                <Link
                                                                    to={adminRoutes.agent(
                                                                        a.id
                                                                    )}
                                                                    className='text-body text-heading hover:text-brand'
                                                                >
                                                                    {a.name}
                                                                </Link>
                                                            </td>
                                                            <td className='text-caption text-body px-2 py-1.5 font-mono'>
                                                                {a.model ?? '—'}
                                                            </td>
                                                            <td
                                                                className='text-caption text-body max-w-xs truncate px-2 py-1.5 font-mono'
                                                                title={
                                                                    a.workspacePath ??
                                                                    undefined
                                                                }
                                                            >
                                                                {a.workspacePath ??
                                                                    '—'}
                                                            </td>
                                                            <td className='px-2 py-1.5'>
                                                                <Badge
                                                                    tone={
                                                                        agentStatusTone[
                                                                            a
                                                                                .status
                                                                        ]
                                                                    }
                                                                >
                                                                    {t(
                                                                        `admin.agents.status.${a.status}`
                                                                    )}
                                                                </Badge>
                                                            </td>
                                                            <td
                                                                className='tnum text-caption text-body px-2 py-1.5'
                                                                title={
                                                                    a.lastReconciledAt
                                                                        ? formatDate(
                                                                              a.lastReconciledAt
                                                                          )
                                                                        : undefined
                                                                }
                                                            >
                                                                {relativeFromNow(
                                                                    a.lastReconciledAt
                                                                )}
                                                            </td>
                                                            <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                                                <Button
                                                                    variant='neutral'
                                                                    size='sm'
                                                                    disabled={
                                                                        isPrimary ||
                                                                        removingId ===
                                                                            a.id
                                                                    }
                                                                    onClick={(): void => {
                                                                        void handleRemoveAgent(
                                                                            a
                                                                        )
                                                                    }}
                                                                    title={
                                                                        isPrimary
                                                                            ? t(
                                                                                  'admin.agents.primaryTooltip'
                                                                              )
                                                                            : undefined
                                                                    }
                                                                >
                                                                    {removingId ===
                                                                    a.id
                                                                        ? t(
                                                                              'admin.agentRuntimes.detail.agentsSection.removing'
                                                                          )
                                                                        : t(
                                                                              'admin.agentRuntimes.detail.agentsSection.remove'
                                                                          )}
                                                                </Button>
                                                            </td>
                                                        </tr>
                                                    )
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </Card>
                            )}
                        </>
                    )}
                </>
            )}
        </DetailPage>
    )
}

export default AgentRuntimeDetail