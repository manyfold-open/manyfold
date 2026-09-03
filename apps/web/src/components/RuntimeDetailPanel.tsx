import {
    frameworkUpgradeAvailable,
    frameworkUpgradeMode,
    isUpgradeableFramework,
    runtimeAccountSupport,
    runtimeKindLabel
} from '@manyfold/shared'
import type {
    AgentRuntimeStatus,
    AgentRuntimeSummary,
    RuntimeServiceStatus,
    SpriteStatus
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { t as translate } from '@manyfold/i18n'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import {
    CheckIcon,
    ChevronRightIcon,
    CopyIcon,
    RefreshIcon
} from '@/components/icons'
import EmptyState from '@/components/EmptyState'
import { Ghost, GhostSettingsRows, Spinner } from '@/components/Loading'
import OverflowMenu from '@/components/OverflowMenu'
import { useI18n, type TFn } from '@/lib/i18n'
import {
    ControlRow,
    dashboardStateError,
    dashboardStatePending,
    dashboardStatePendingLabel
} from '@/components/ControlRow'
import {
    StatusTag,
    statusLabel,
    statusTone,
    type TagTone
} from '@/components/Tag'
import ProductDialog from '@/components/ProductDialog'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import RenameDialog from '@/components/RenameDialog'
import RuntimeAccountSection from '@/components/RuntimeAccountSection'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { updatesPath } from '@/lib/updateCenter'
import { useApiClient } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { openDashboardInPopup } from '@/lib/openDashboard'
import { spriteStatusLabel, spriteStatusTone } from '@/lib/spriteStatus'

export { ControlRow } from '@/components/ControlRow'
export { StatusTag, type TagTone } from '@/components/Tag'

export const formatDate = (value: string | null): string =>
    formatDateTime(value)

export const relative = (value: string | null): string => {
    if (!value) return '—'
    const ms = Date.now() - new Date(value).getTime()
    if (ms < 0) return '—'
    const sec = Math.round(ms / 1000)
    if (sec < 60)
        return translate('web.runtimeDetails.secondsAgo', { count: sec })
    const min = Math.round(sec / 60)
    if (min < 60)
        return translate('web.runtimeDetails.minutesAgo', { count: min })
    const hr = Math.round(min / 60)
    if (hr < 24)
        return translate('web.runtimeDetails.hoursAgo', { count: hr })
    const d = Math.round(hr / 24)
    return translate('web.runtimeDetails.daysAgo', { count: d })
}

// Ghost copy affordance for technical values (IDs, paths). The check
// feedback replaces the icon for a beat instead of toasting.
export const CopyButton: FC<{ value: string; label?: string }> = ({
    value,
    label = translate('web.runtimeDetails.copy')
}): ReactNode => {
    const [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied) return
        const timer = window.setTimeout(() => setCopied(false), 1500)
        return (): void => window.clearTimeout(timer)
    }, [copied])
    return (
        <ShortcutTooltip label={copied ? translate('web.runtimeDetails.copied') : label} className='shrink-0'>
            <button
                type='button'
                aria-label={label}
                onClick={(): void => {
                    void navigator.clipboard?.writeText(value)
                    setCopied(true)
                }}
                className='text-muted hover:bg-surface-hover rounded-pill inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors'
            >
                {copied ? (
                    <CheckIcon className='h-3.5 w-3.5' />
                ) : (
                    <CopyIcon className='h-3.5 w-3.5' />
                )}
            </button>
        </ShortcutTooltip>
    )
}

// Attention strip under the identity header: one row per actionable fact
// (upgrade available, host offline, provisioning failure). Renders nothing
// worth reading as chrome — when there is nothing to act on, don't mount it.
export const NoticeRow: FC<{
    tone?: 'info' | 'danger'
    title: ReactNode
    detail?: ReactNode
    action?: ReactNode
}> = ({ tone = 'info', title, detail, action }): ReactNode => (
    <div
        className={[
            'shadow-ring-light flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md px-4 py-3',
            tone === 'danger' ? 'bg-danger-bg' : 'bg-info-bg'
        ].join(' ')}
    >
        <div className='min-w-0 flex-1'>
            <div
                className={[
                    'text-ui font-medium',
                    tone === 'danger'
                        ? 'text-workflow-ship'
                        : 'text-info-strong'
                ].join(' ')}
            >
                {title}
            </div>
            {detail && (
                <div
                    className={[
                        'text-caption mt-0.5 break-words',
                        tone === 'danger'
                            ? 'text-workflow-ship'
                            : 'text-info-strong'
                    ].join(' ')}
                >
                    {detail}
                </div>
            )}
        </div>
        {action && (
            <div className='flex shrink-0 items-center gap-2'>{action}</div>
        )}
    </div>
)

const VersionPill: FC<{ version: string | null }> = ({
    version
}): ReactNode => (
    <span className='tag tag-neutral font-mono'>
        {version ? `v${version}` : translate('web.runtimeDetails.versionPending')}
    </span>
)

export const IdentityHeader: FC<{
    icon: ReactNode
    title: string
    subtitle?: ReactNode
    badge?: ReactNode
    actions?: ReactNode
}> = ({ icon, title, subtitle, badge, actions }): ReactNode => (
    <div className='flex flex-wrap items-start gap-4'>
        <div className='bg-surface-subtle shadow-ring-light flex h-12 w-12 shrink-0 items-center justify-center rounded-sm'>
            {icon}
        </div>
        <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-3'>
                <h1 className='text-h1 text-fg min-w-0 break-words tracking-tight'>
                    {title}
                </h1>
                {badge}
            </div>
            {subtitle && (
                <div className='mt-2 flex flex-wrap items-center gap-2'>
                    {subtitle}
                </div>
            )}
        </div>
        {actions && (
            <div className='flex shrink-0 items-center gap-2'>{actions}</div>
        )}
    </div>
)

export const Section: FC<{
    title: string
    action?: ReactNode
    children: ReactNode
}> = ({ title, action, children }): ReactNode => (
    <section>
        <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
            <h2 className='text-h3 text-fg tracking-tight'>{title}</h2>
            {action}
        </div>
        {children}
    </section>
)

export const Info: FC<{
    label: string
    value: ReactNode
    mono?: boolean
}> = ({ label, value, mono }): ReactNode => (
    <div className='grid gap-2 px-5 py-4 md:grid-cols-[11rem_minmax(0,1fr)] md:items-baseline'>
        <dt className='text-caption text-subtle uppercase tracking-wider'>
            {label}
        </dt>
        <dd
            className={[
                'text-ui text-fg break-all',
                mono ? 'font-mono' : ''
            ].join(' ')}
        >
            {value ?? '—'}
        </dd>
    </div>
)

const InfoPanel: FC<{ children: ReactNode }> = ({ children }): ReactNode => (
    <div className='workbench-panel divide-divider divide-y overflow-hidden'>
        {children}
    </div>
)

const AgentRow: FC<{ agent: SdkAgent; isPrimary: boolean; t: TFn }> = ({
    agent: a,
    isPrimary,
    t
}): ReactNode => {
    const body = (
        <>
            <FrameworkLogo framework={a.framework} size={28} />
            <span className='min-w-0 flex-1'>
                <span className='flex flex-wrap items-center gap-2'>
                    <span className='settings-card-label'>{a.name}</span>
                    {isPrimary && (
                        <span className='tag tag-neutral'>{translate('web.runtimeDetails.primary')}</span>
                    )}
                    <StatusTag
                        tone={statusTone(a.status)}
                        label={statusLabel(a.status, t)}
                    />
                </span>
                <span className='settings-card-copy block truncate'>
                    <span className='font-mono'>{a.internalId}</span>
                    {a.model ? <span> · {a.model}</span> : null}
                    <span>
                        {' · '}
                        {translate('web.runtimeDetails.synced', {
                            time: relative(a.lastReconciledAt)
                        })}
                    </span>
                </span>
            </span>
            <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0' />
        </>
    )
    const base =
        'border-divider/60 flex w-full items-center gap-3 border-t px-4 py-3 text-left first:border-t-0'
    return (
        <Link
            to={`/agents/${a.id}`}
            className={`${base} hover:bg-surface-hover transition-colors`}
        >
            {body}
        </Link>
    )
}

const SERVICE_TONE: Record<RuntimeServiceStatus, TagTone> = {
    ready: 'success',
    starting: 'info',
    stopped: 'idle',
    unknown: 'idle'
}

const serviceStatusLabel = (status: RuntimeServiceStatus): string => {
    if (status === 'ready') return translate('web.runtimeDetails.ready')
    if (status === 'starting') return translate('web.runtimeDetails.starting')
    if (status === 'stopped') return translate('web.runtimeDetails.stopped')
    return translate('web.runtimeDetails.unknown')
}

const STATUS_TONE: Record<AgentRuntimeStatus, TagTone> = {
    ready: 'success',
    pending: 'warning',
    failed: 'error',
    stopped: 'idle'
}

const runtimeStatusLabel = (status: AgentRuntimeStatus): string => {
    if (status === 'ready') return translate('web.runtimeDetails.ready')
    if (status === 'pending') return translate('web.runtimeDetails.pending')
    if (status === 'failed') return translate('web.runtimeDetails.failed')
    return translate('web.runtimeDetails.stopped')
}

export const runtimeStatusTag = (status: AgentRuntimeStatus): ReactNode => (
    <StatusTag
        tone={STATUS_TONE[status]}
        label={runtimeStatusLabel(status)}
        pulse={status === 'pending'}
    />
)

export const daemonOnlineBadge = (online: boolean | null): ReactNode => {
    if (online === null)
        return (
            <StatusTag tone='idle' label={translate('web.runtimeDetails.unknown')} />
        )
    return online ? (
        <StatusTag tone='success' label={translate('web.runtimeDetails.online')} />
    ) : (
        <StatusTag tone='error' label={translate('web.runtimeDetails.offline')} />
    )
}

// Sandbox (sprite) host badge: the VM's sprites.dev lifecycle (active/warm/cold),
// not the runtime provisioning status. Active pulses (work in flight); a not-yet
// -reported sprite reads as provisioning.
export const spriteStatusTag = (status: SpriteStatus | null): ReactNode => (
    <StatusTag
        tone={spriteStatusTone(status)}
        label={spriteStatusLabel(status)}
        pulse={status === 'running' || status === null}
    />
)

const headerBadge = (runtime: AgentRuntimeSummary): ReactNode =>
    runtime.kind === 'daemon'
        ? daemonOnlineBadge(runtime.daemonOnline)
        : runtimeStatusTag(runtime.status)

const serviceStatusValue = (r: AgentRuntimeSummary): ReactNode => (
    <span className='flex flex-wrap items-center gap-2'>
        <StatusTag
            tone={SERVICE_TONE[r.serviceStatus]}
            label={serviceStatusLabel(r.serviceStatus)}
            pulse={r.serviceStatus === 'starting'}
        />
        {r.serviceStatusAt && (
            <span className='text-caption text-subtle'>
                {translate('web.runtimeDetails.checked', {
                    time: relative(r.serviceStatusAt)
                })}
            </span>
        )}
    </span>
)

const dateValue = (value: string | null): ReactNode =>
    value ? (
        <span className='tabular-nums'>
            {formatDate(value)}
            <span className='text-subtle'> · {relative(value)}</span>
        </span>
    ) : null

export const monoCopyValue = (value: string | null): ReactNode =>
    value ? (
        <span className='flex items-center gap-1.5'>
            <span className='min-w-0 break-all'>{value}</span>
            <CopyButton value={value} />
        </span>
    ) : null

const RuntimeDetailPanel: FC<{
    runtimeId: string
    onDeleted: (runtimeId: string) => void
    onRenamed?: () => void
}> = ({ runtimeId, onDeleted, onRenamed }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [runtime, setRuntime] = useState<AgentRuntimeSummary | null>(null)
    const [agents, setAgents] = useState<SdkAgent[] | null>(null)
    const [notFound, setNotFound] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [deleting, setDeleting] = useState(false)
    const [renameOpen, setRenameOpen] = useState(false)
    const [controlUiPending, setControlUiPending] = useState(false)
    const [controlUiError, setControlUiError] = useState<string | null>(null)
    const [dashboardPending, setDashboardPending] = useState(false)
    const [dashboardError, setDashboardError] = useState<string | null>(null)
    const [keepAlivePending, setKeepAlivePending] = useState(false)
    const [keepAliveError, setKeepAliveError] = useState<string | null>(null)
    const [fwRefreshing, setFwRefreshing] = useState(false)
    const [fwUpgrading, setFwUpgrading] = useState(false)
    const [fwError, setFwError] = useState<string | null>(null)
    const [fwPickerOpen, setFwPickerOpen] = useState(false)
    const [fwVersions, setFwVersions] = useState<string[] | null>(null)
    const [fwTarget, setFwTarget] = useState<string>('')
    const [fwStep, setFwStep] = useState<string | null>(null)
    const [fwLatest, setFwLatest] = useState<string | null>(null)

    const handleToggleControlUi = async (): Promise<void> => {
        if (!runtime || controlUiPending) return
        setControlUiPending(true)
        setControlUiError(null)
        try {
            const next = await client.agentRuntimes.setControlUi(
                runtime.id,
                !runtime.controlUiEnabled
            )
            setRuntime(next)
        } catch (e) {
            setControlUiError(apiErrorMessage(e))
        } finally {
            setControlUiPending(false)
        }
    }

    // Sprite hermes toggles run async server-side: the PATCH returns with
    // dashboardState pending and the polling effect below tracks completion.
    const handleToggleDashboard = async (): Promise<void> => {
        if (!runtime || dashboardPending) return
        setDashboardPending(true)
        setDashboardError(null)
        try {
            const next = await client.agentRuntimes.setDashboard(
                runtime.id,
                !runtime.dashboardEnabled
            )
            setRuntime(next)
        } catch (e) {
            setDashboardError(apiErrorMessage(e))
        } finally {
            setDashboardPending(false)
        }
    }

    const handleToggleKeepAlive = async (): Promise<void> => {
        if (!runtime || keepAlivePending) return
        setKeepAlivePending(true)
        setKeepAliveError(null)
        try {
            const next = await client.agentRuntimes.setKeepAlive(
                runtime.id,
                !runtime.keepAliveEnabled
            )
            setRuntime(next)
            // no 60s debounce here: that exists for k8s pod restarts, this is a sub-second exec round-trip
            setKeepAlivePending(false)
        } catch (e) {
            setKeepAliveError(apiErrorMessage(e))
            setKeepAlivePending(false)
        }
    }

    const handleOpenControlUi = (): void => {
        if (!runtime) return
        openDashboardInPopup(client.agentRuntimes, {
            runtimeId: runtime.id,
            failureTitle: translate('web.runtimeDetails.failedToOpenControlUi')
        })
    }

    const handleOpenDashboard = (): void => {
        if (!runtime) return
        openDashboardInPopup(client.agentRuntimes, {
            runtimeId: runtime.id,
            failureTitle: translate('web.runtimeDetails.failedToOpenDashboard')
        })
    }

    const load = useCallback(
        (silent: boolean): void => {
            setError(null)
            setNotFound(false)
            if (!silent) {
                setRuntime(null)
                setAgents(null)
            }
            Promise.all([
                client.agentRuntimes.get(runtimeId),
                client.agents.list()
            ])
                .then(([rt, ags]) => {
                    setRuntime(rt)
                    setAgents(
                        (ags as SdkAgent[]).filter((a) => a.runtimeId === rt.id)
                    )
                })
                .catch((e: Error) => {
                    if (e.message.includes('404')) setNotFound(true)
                    else setError(e.message)
                })
        },
        [client, runtimeId]
    )

    const refresh = useCallback((): void => load(false), [load])

    useEffect(refresh, [refresh])

    const dashboardStateValue = runtime?.dashboardState ?? null
    useEffect(() => {
        if (!dashboardStatePending(dashboardStateValue)) return
        const timer = window.setInterval(() => load(true), 5_000)
        return (): void => window.clearInterval(timer)
    }, [dashboardStateValue, load])

    const fwFramework = runtime?.framework ?? null
    const runtimeKind = runtime?.kind ?? null

    useEffect(() => {
        if (
            !fwFramework ||
            runtimeKind !== 'sprites' ||
            !isUpgradeableFramework(fwFramework)
        )
            return
        let cancelled = false
        client.frameworkVersions
            .get(fwFramework)
            .then((catalog) => {
                if (cancelled) return
                setFwVersions(catalog.versions)
                setFwLatest(catalog.latest)
                setFwTarget(
                    (prev) =>
                        prev || catalog.latest || catalog.versions[0] || ''
                )
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [client, fwFramework, runtimeKind])

    const getPrimaryAgent = (): SdkAgent | null =>
        agents?.find((a) => a.id === runtime?.primaryAgentId) ?? null

    const handleRefreshFrameworkVersion = async (): Promise<void> => {
        const agent = getPrimaryAgent()
        if (!agent || fwRefreshing) return
        setFwRefreshing(true)
        setFwError(null)
        try {
            await client.agents.refreshFrameworkVersion(agent.id)
            load(true)
        } catch (e) {
            setFwError(apiErrorMessage(e))
        } finally {
            setFwRefreshing(false)
        }
    }

    const handleOpenVersionPicker = async (): Promise<void> => {
        const agent = getPrimaryAgent()
        if (!agent) return
        setFwPickerOpen(true)
        setFwError(null)
        if (fwVersions) return
        try {
            const catalog = await client.frameworkVersions.get(agent.framework)
            setFwVersions(catalog.versions)
            setFwLatest(catalog.latest)
            setFwTarget(catalog.latest ?? catalog.versions[0] ?? '')
        } catch (e) {
            setFwError(apiErrorMessage(e))
        }
    }

    const handleUpgradeFramework = async (): Promise<void> => {
        const agent = getPrimaryAgent()
        if (!agent || !fwTarget || fwUpgrading) return
        setFwUpgrading(true)
        setFwError(null)
        setFwStep(null)
        try {
            if (frameworkUpgradeMode(agent.framework) === 'rebuild') {
                // heavy rebuild (narranexus / hermes) — stream phase events
                await client.agents.upgradeFrameworkStream(
                    agent.id,
                    fwTarget,
                    (ev) => {
                        if (ev.type === 'step') setFwStep(ev.step)
                    }
                )
            } else {
                await client.agents.upgradeFramework(agent.id, fwTarget)
            }
            load(true)
            setFwPickerOpen(false)
        } catch (e) {
            setFwError(apiErrorMessage(e))
        } finally {
            setFwUpgrading(false)
            setFwStep(null)
        }
    }

    const handleDelete = async (): Promise<void> => {
        if (!runtime) return
        if (
            !(await confirm({
                title: translate('web.runtimeDetails.deleteTitle'),
                description: translate('web.runtimeDetails.deleteConfirm', {
                    name: runtime.name
                }),
                confirmLabel: translate('web.runtimeDetails.deleteAction'),
                tone: 'danger'
            }))
        )
            return
        setDeleting(true)
        try {
            await client.agentRuntimes.delete(runtime.id)
            onDeleted(runtime.id)
        } catch (e) {
            setError((e as Error).message)
            setDeleting(false)
        }
    }

    const handleRename = async (name: string): Promise<void> => {
        if (!runtime) return
        const updated = await client.agentRuntimes.rename(runtime.id, name)
        setRuntime(updated)
        onRenamed?.()
    }

    if (notFound)
        return (
            <EmptyState
                kind='no-results'
                tier='stack'
                title={t('web.emptyState.runtimeNotFoundTitle')}
                body={t('web.emptyState.runtimeNotFoundBody')}
            />
        )
    if (!runtime)
        return error ? (
            <div className='workbench-alert-error'>{error}</div>
        ) : (
            <div aria-busy='true'>
                <Ghost variant='title' className='w-52' />
                <Ghost variant='cap' className='mt-3 w-72 max-w-full' />
                <div className='workbench-panel mt-6 space-y-3 px-5 py-5'>
                    <Ghost variant='line' className='w-1/4' />
                    <Ghost variant='cap' className='w-3/5' />
                    <Ghost variant='cap' className='w-2/5' />
                </div>
            </div>
        )

    const primaryAgent =
        agents?.find((a) => a.id === runtime.primaryAgentId) ?? null
    const fwUpgradeable =
        runtime.kind === 'sprites' &&
        isUpgradeableFramework(runtime.framework) &&
        primaryAgent !== null
    const fwUpgradeAvailable = frameworkUpgradeAvailable(
        runtime.frameworkVersion,
        fwLatest
    )

    return (
        <div className='space-y-8'>
            {error && <div className='workbench-alert-error'>{error}</div>}
            {fwError && !fwPickerOpen && (
                <div className='workbench-alert-error'>{fwError}</div>
            )}
            <IdentityHeader
                icon={<FrameworkLogo framework={runtime.framework} size={28} />}
                title={runtime.name}
                badge={headerBadge(runtime)}
                subtitle={
                    <>
                        <span className='text-ui text-fg font-medium'>
                            {frameworkLabel(runtime.framework)}
                        </span>
                        <VersionPill version={runtime.frameworkVersion} />
                        {fwUpgradeable && (
                            <>
                                <ShortcutTooltip
                                    label={translate('web.runtimeDetails.refreshVersion')}
                                    className='shrink-0'
                                >
                                    <button
                                        type='button'
                                        disabled={fwRefreshing}
                                        onClick={(): void => {
                                            void handleRefreshFrameworkVersion()
                                        }}
                                        aria-label={translate('web.runtimeDetails.refreshVersion')}
                                        className='text-subtle hover:bg-surface-hover inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                    >
                                        <RefreshIcon
                                            className={[
                                                'h-3.5 w-3.5',
                                                fwRefreshing
                                                    ? 'loading-spin'
                                                    : ''
                                            ].join(' ')}
                                        />
                                    </button>
                                </ShortcutTooltip>
                                <button
                                    type='button'
                                    onClick={(): void => {
                                        void handleOpenVersionPicker()
                                    }}
                                    className='text-caption text-subtle hover:text-fg transition-colors'
                                >
                                    {translate('web.runtimeDetails.changeVersion')}
                                </button>
                            </>
                        )}
                        <span className='text-subtle'>·</span>
                        <span className='text-caption text-muted'>
                            {runtimeKindLabel(runtime.kind)}
                        </span>
                    </>
                }
                actions={
                    <>
                        <button
                            type='button'
                            onClick={refresh}
                            aria-label={translate('web.runtimeDetails.refresh')}
                            className='text-muted hover:bg-surface-hover flex h-9 w-9 items-center justify-center rounded-full transition-colors'
                        >
                            <RefreshIcon className='h-4 w-4' />
                        </button>
                        <OverflowMenu
                            ariaLabel={translate('web.runtimeDetails.actions')}
                            items={[
                                {
                                    label: translate('web.runtimeDetails.rename'),
                                    onSelect: () => setRenameOpen(true)
                                },
                                {
                                    label: deleting
                                        ? translate('web.runtimeDetails.deleting')
                                        : translate('web.runtimeDetails.deleteTitle'),
                                    danger: true,
                                    disabled: deleting,
                                    onSelect: () => {
                                        void handleDelete()
                                    }
                                }
                            ]}
                        />
                    </>
                }
            />

            {runtime.failureReason && (
                <NoticeRow
                    tone='danger'
                    title={translate('web.runtimeDetails.runtimeFailed')}
                    detail={runtime.failureReason}
                />
            )}
            {fwUpgradeable && fwUpgradeAvailable && fwLatest && (
                <NoticeRow
                    title={translate('web.runtimeDetails.upgradeAvailable', {
                        framework: frameworkLabel(runtime.framework),
                        version: fwLatest
                    })}
                    detail={
                        runtime.frameworkVersion
                            ? translate('web.runtimeDetails.currentVersion', {
                                  version: runtime.frameworkVersion
                              })
                            : translate('web.runtimeDetails.upgradeNotice')
                    }
                    action={
                        <Link
                            to={updatesPath('framework')}
                            className='workbench-button-secondary'
                        >
                            {translate('web.updates.reviewCta')}
                        </Link>
                    }
                />
            )}

            <Section
                title={translate('web.runtimeDetails.agents', {
                    count: agents?.length ?? 0
                })}
            >
                {agents === null ? (
                    <div className='settings-card' aria-busy='true'>
                        <GhostSettingsRows rows={2} action={false} />
                    </div>
                ) : agents.length === 0 ? (
                    <EmptyState
                        kind='first-use'
                        tier='stack'
                        title={t('web.emptyState.runtimeAgentsTitle')}
                        body={t('web.emptyState.runtimeAgentsBody')}
                    />
                ) : (
                    <div className='settings-card'>
                        {agents.map((a) => (
                            <AgentRow
                                key={a.id}
                                agent={a}
                                isPrimary={a.id === runtime.primaryAgentId}
                                t={t}
                            />
                        ))}
                    </div>
                )}
            </Section>

            {runtimeAccountSupport(runtime.framework, runtime.kind) === 'ok' && (
                <RuntimeAccountSection key={runtime.id} runtime={runtime} />
            )}

            {(runtime.kind === 'sprites' ||
                runtime.framework === 'openclaw') && (
                <Section title={translate('web.runtimeDetails.controls')}>
                    <div className='settings-card'>
                        {runtime.framework === 'openclaw' && (
                            <ControlRow
                                label={translate('web.runtimeDetails.controlUi')}
                                description={translate('web.runtimeDetails.controlUiDescription')}
                                enabled={runtime.controlUiEnabled}
                                pending={
                                    controlUiPending ||
                                    dashboardStatePending(
                                        runtime.dashboardState
                                    )
                                }
                                pendingLabel={translate('web.runtimeDetails.restarting')}
                                onToggle={(): void => {
                                    void handleToggleControlUi()
                                }}
                                onOpen={handleOpenControlUi}
                                openLabel={translate('web.runtimeDetails.openUi')}
                                error={
                                    controlUiError ??
                                    dashboardStateError(runtime.dashboardState)
                                }
                            />
                        )}
                        {runtime.framework === 'hermes' &&
                            runtime.kind === 'sprites' && (
                            <ControlRow
                                label={translate('web.runtimeDetails.dashboard')}
                                description={translate('web.runtimeDetails.dashboardDescription')}
                                enabled={runtime.dashboardEnabled}
                                pending={
                                    dashboardPending ||
                                    dashboardStatePending(
                                        runtime.dashboardState
                                    )
                                }
                                pendingLabel={dashboardStatePendingLabel(
                                    runtime.dashboardState,
                                    translate('web.runtimeDetails.updating')
                                )}
                                onToggle={(): void => {
                                    void handleToggleDashboard()
                                }}
                                onOpen={handleOpenDashboard}
                                openLabel={translate('web.runtimeDetails.openDashboard')}
                                error={
                                    dashboardError ??
                                    dashboardStateError(runtime.dashboardState)
                                }
                            />
                        )}
                        {runtime.kind === 'sprites' && (
                            <ControlRow
                                label={translate('web.runtimeDetails.keepAlive')}
                                description={translate('web.runtimeDetails.keepAliveDescription')}
                                enabled={runtime.keepAliveEnabled}
                                pending={keepAlivePending}
                                pendingLabel={translate('web.runtimeDetails.updating')}
                                onToggle={(): void => {
                                    void handleToggleKeepAlive()
                                }}
                                error={keepAliveError}
                            />
                        )}
                    </div>
                </Section>
            )}

            <Section title={translate('web.runtimeDetails.details')}>
                <InfoPanel>
                    <Info
                        label={translate('web.runtimeDetails.primaryAgent')}
                        value={
                            runtime.primaryAgentId ? (
                                <span className='flex flex-wrap items-center gap-2'>
                                    <Link
                                        to={`/agents/${runtime.primaryAgentId}`}
                                        className='text-link hover:text-fg font-medium'
                                    >
                                        {primaryAgent?.name ??
                                            runtime.primaryAgentId}
                                    </Link>
                                    {primaryAgent && (
                                        <span className='text-caption text-subtle font-mono'>
                                            {runtime.primaryAgentId}
                                        </span>
                                    )}
                                </span>
                            ) : null
                        }
                    />
                    {runtime.kind === 'sprites' && (
                        <Info
                            label={translate('web.runtimeDetails.statefulSandbox')}
                            value={monoCopyValue(runtime.spriteName)}
                            mono
                        />
                    )}
                    {runtime.kind === 'k8s' && (
                        <>
                            <Info
                                label={translate('web.runtimeDetails.cluster')}
                                value={runtime.clusterName}
                                mono
                            />
                            <Info
                                label={translate('web.runtimeDetails.namespace')}
                                value={runtime.namespace}
                                mono
                            />
                            <Info
                                label={translate('web.runtimeDetails.ingress')}
                                value={runtime.ingressHost}
                                mono
                            />
                        </>
                    )}
                    {runtime.kind === 'daemon' && (
                        <Info label={translate('web.runtimeDetails.machine')} value={runtime.daemonName} />
                    )}
                    {runtime.kind === 'external' && (
                        <Info
                            label={translate('web.runtimeDetails.endpoint')}
                            value={runtime.endpointUrl}
                            mono
                        />
                    )}
                    {runtime.mountPath && (
                        <Info
                            label={translate('web.runtimeDetails.mountPath')}
                            value={monoCopyValue(runtime.mountPath)}
                            mono
                        />
                    )}
                    {runtime.kind === 'daemon' && (
                        <>
                            <Info
                                label={translate('web.runtimeDetails.homeDir')}
                                value={runtime.homeDir}
                                mono
                            />
                            <Info
                                label={translate('web.runtimeDetails.workspaceBase')}
                                value={runtime.workspaceBaseDir}
                                mono
                            />
                            <Info
                                label={translate('web.runtimeDetails.cliVersion')}
                                value={
                                    runtime.daemonCliVersion
                                        ? `v${runtime.daemonCliVersion}`
                                        : null
                                }
                                mono
                            />
                            <Info
                                label={translate('web.runtimeDetails.lastSeen')}
                                value={dateValue(runtime.lastSeenAt)}
                            />
                        </>
                    )}
                    {runtime.kind !== 'daemon' && (
                        <Info
                            label={translate('web.runtimeDetails.service')}
                            value={serviceStatusValue(runtime)}
                        />
                    )}
                    {runtime.kind === 'k8s' && runtime.currentPhase && (
                        <Info label={translate('web.runtimeDetails.phase')} value={runtime.currentPhase} />
                    )}
                    {runtime.startedAt && (
                        <Info
                            label={translate('web.runtimeDetails.started')}
                            value={dateValue(runtime.startedAt)}
                        />
                    )}
                    <Info
                        label={translate('web.runtimeDetails.created')}
                        value={dateValue(runtime.createdAt)}
                    />
                </InfoPanel>
            </Section>

            {fwPickerOpen && primaryAgent && (
                <ProductDialog
                    title={
                        fwUpgradeAvailable
                            ? translate('web.runtimeDetails.upgradeFramework')
                            : translate('web.runtimeDetails.changeFrameworkVersion')
                    }
                    description={translate('web.runtimeDetails.chooseVersion', {
                        framework: frameworkLabel(runtime.framework)
                    })}
                    size='sm'
                    onClose={() => {
                        if (!fwUpgrading) setFwPickerOpen(false)
                    }}
                    closeDisabled={fwUpgrading}
                    bodyClassName='flex flex-col gap-4'
                    footer={
                        <>
                            <button
                                type='button'
                                className='workbench-button-secondary'
                                onClick={() => setFwPickerOpen(false)}
                                disabled={fwUpgrading}
                            >
                                {translate('web.runtimeDetails.cancel')}
                            </button>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                disabled={
                                    fwUpgrading ||
                                    !fwTarget ||
                                    fwTarget === runtime.frameworkVersion
                                }
                                onClick={(): void => {
                                    void handleUpgradeFramework()
                                }}
                            >
                                {fwUpgrading ? (
                                    <span className='inline-flex items-center gap-2'>
                                        <Spinner size={16} />
                                        {fwStep
                                            ? `${translate('web.runtimeDetails.upgrading')} ${fwStep.replace(/_/g, ' ')}`
                                            : translate('web.runtimeDetails.upgrading')}
                                    </span>
                                ) : (
                                    translate('web.runtimeDetails.upgrade')
                                )}
                            </button>
                        </>
                    }
                >
                    <div>
                        <label
                            htmlFor='fw-version-select'
                            className='text-caption text-subtle mb-1.5 block'
                        >
                            {translate('web.runtimeDetails.version')}
                        </label>
                        <WorkbenchSelect
                            id='fw-version-select'
                            mono
                            value={fwTarget}
                            disabled={fwUpgrading || !fwVersions}
                            onChange={setFwTarget}
                            placeholder={translate('common.loading')}
                            options={(fwVersions ?? []).map((v) => ({
                                value: v,
                                label: v
                            }))}
                        />
                    </div>
                    {fwError ? (
                        <div className='workbench-alert-error'>{fwError}</div>
                    ) : null}
                </ProductDialog>
            )}
            {renameOpen && (
                <RenameDialog
                    title={translate('web.runtimeDetails.renameRuntime')}
                    initialName={runtime.name}
                    submit={handleRename}
                    onClose={() => setRenameOpen(false)}
                />
            )}
            {confirmDialog}
        </div>
    )
}

export default RuntimeDetailPanel