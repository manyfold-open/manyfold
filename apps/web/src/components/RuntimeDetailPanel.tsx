import {
    SANDBOX_PREINSTALLED_FRAMEWORKS,
    frameworkUpgradeAvailable,
    frameworkUpgradeMode,
    isUpgradeableFramework,
    runtimeAccountSupport
} from '@manyfold/shared'
import type {
    AgentRuntimeStatus,
    AgentRuntimeSummary,
    RuntimeAvailability,
    RuntimeHostPowerState,
    RuntimeServiceStatus
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
import { Ghost, GhostSettingsRows } from '@/components/Loading'
import OverflowMenu from '@/components/OverflowMenu'
import { useI18n } from '@/lib/i18n'
import { relative } from '@/lib/relativeTime'
import {
    ControlRow,
    dashboardStateError,
    dashboardStatePending,
    dashboardStatePendingLabel
} from '@/components/ControlRow'
import { StatusTag, type TagTone } from '@/components/Tag'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import RenameDialog from '@/components/RenameDialog'
import RuntimeAccountSection from '@/components/RuntimeAccountSection'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import VersionPicker from '@/components/VersionPicker'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { useApiClient } from '@/lib/apiClient'
import { updateRunStore, useIsTargetUpdating } from '@/lib/updateRunStore'
import { formatDateTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import {
    availabilityLabel,
    availabilityTone,
    daemonPresenceLabel,
    hostKey,
    machineLabel,
    machineTone,
    placementLabel,
    powerStateLabel,
    powerStateTone,
    type MachineFacts
} from '@/lib/hostStatus'
import { openDashboardInPopup } from '@/lib/openDashboard'
import { versionChoices } from '@/lib/sandboxRuntimes'

export { ControlRow } from '@/components/ControlRow'
export { StatusTag, type TagTone } from '@/components/Tag'

export const formatDate = (value: string | null): string =>
    formatDateTime(value)

// Re-exported for the runtime and token pages that import it from here.
export { relative }

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
                <h1 className='text-h1 text-fg min-w-0 break-words'>
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
            <h2 className='text-h3 text-fg'>{title}</h2>
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
        <dt className='text-caption text-subtle'>
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

const AgentRow: FC<{ agent: SdkAgent }> = ({ agent: a }): ReactNode => {
    const body = (
        <>
            <FrameworkLogo framework={a.framework} size={28} />
            <span className='min-w-0 flex-1'>
                <span className='flex flex-wrap items-center gap-2'>
                    <span className='settings-card-label'>{a.name}</span>
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

// Install state only (ADR-0037); whether a turn can start is the
// availability tag below.
const STATUS_TONE: Record<AgentRuntimeStatus, TagTone> = {
    ready: 'success',
    installing: 'warning',
    failed: 'error'
}

export const runtimeStatusLabel = (status: AgentRuntimeStatus): string => {
    if (status === 'ready') return translate('web.runtimeDetails.ready')
    if (status === 'installing')
        return translate('web.runtimeDetails.installing')
    return translate('web.runtimeDetails.failed')
}

export const runtimeStatusTag = (status: AgentRuntimeStatus): ReactNode => (
    <StatusTag
        tone={STATUS_TONE[status]}
        label={runtimeStatusLabel(status)}
        pulse={status === 'installing'}
    />
)

const availabilityTag = (
    availability: RuntimeAvailability,
    powerState: RuntimeHostPowerState | null
): ReactNode => (
    <StatusTag
        tone={availabilityTone(availability)}
        label={availabilityLabel(availability, powerState)}
    />
)

// A machine's own badge: the colour its dot has everywhere, and the words for
// it.
export const machineStatusTag = (machine: MachineFacts): ReactNode => {
    const tone = machineTone(machine)
    return (
        <StatusTag
            tone={tone}
            label={machineLabel(machine)}
            pulse={
                machine.status === 'provisioning' ||
                machine.status === 'deleting' ||
                (machine.kind === 'hosted' && tone === 'success')
            }
        />
    )
}

// A hosted machine's power state (running / suspended / stopped), not the
// runtime install status: a ready runtime on a suspended machine is asleep.
export const powerStateTag = (
    state: RuntimeHostPowerState | null
): ReactNode => (
    <StatusTag
        tone={powerStateTone(state)}
        label={powerStateLabel(state)}
        pulse={state === 'running'}
    />
)

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
    const [fwRefreshing, setFwRefreshing] = useState(false)
    const [fwUpgrading, setFwUpgrading] = useState(false)
    const queuedUpgrade = useIsTargetUpdating(`framework:${runtimeId}`)
    const [fwError, setFwError] = useState<string | null>(null)
    const [fwVersions, setFwVersions] = useState<string[] | null>(null)
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
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [client, fwFramework, runtimeKind])

    // Re-reads the version on the machine. A sandbox is probed as a whole,
    // every framework on it, so any runtime there can refresh, with or
    // without an agent to address.
    const handleRefreshFrameworkVersion = async (): Promise<void> => {
        if (!runtime?.hostId || fwRefreshing) return
        setFwRefreshing(true)
        setFwError(null)
        try {
            await client.sandboxes.detectFrameworks(runtime.hostId, {
                probe: true
            })
            load(true)
        } catch (e) {
            setFwError(apiErrorMessage(e))
        } finally {
            setFwRefreshing(false)
        }
    }

    // A version picked from the header's list, moved the way the Update Center
    // moves it: through the runtime, or in place on the sandbox for a CLI its
    // image ships that the runtime cannot upgrade.
    const handleUpgradeFramework = async (version: string): Promise<void> => {
        if (
            !runtime ||
            fwUpgrading ||
            updateRunStore.isTargetUpdating(`framework:${runtimeId}`)
        )
            return
        setFwUpgrading(true)
        setFwError(null)
        setFwStep(null)
        try {
            const mode = frameworkUpgradeMode(runtime.framework)
            if (mode === 'rebuild')
                // heavy rebuild — stream phase events
                await client.agentRuntimes.upgradeFrameworkStream(
                    runtime.id,
                    version,
                    (ev) => {
                        if (ev.type === 'step') setFwStep(ev.step)
                    }
                )
            else if (mode)
                await client.agentRuntimes.upgradeFramework(runtime.id, version)
            else if (runtime.hostId)
                await client.sandboxes.installFramework(
                    runtime.hostId,
                    runtime.framework,
                    version
                )
            load(true)
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

    const fwUpgradeable =
        runtime.kind === 'sprites' && isUpgradeableFramework(runtime.framework)
    const fwUpgradeAvailable = frameworkUpgradeAvailable(
        runtime.frameworkVersion,
        fwLatest
    )
    const fwChangeable =
        fwUpgradeable ||
        (runtime.kind === 'sprites' &&
            runtime.hostId !== null &&
            (SANDBOX_PREINSTALLED_FRAMEWORKS as readonly string[]).includes(
                runtime.framework
            ))

    return (
        <div className='space-y-8'>
            {error && <div className='workbench-alert-error'>{error}</div>}
            {fwError && (
                <div className='workbench-alert-error'>{fwError}</div>
            )}
            <IdentityHeader
                icon={<FrameworkLogo framework={runtime.framework} size={28} />}
                title={runtime.name}
                subtitle={
                    <>
                        <span className='text-ui text-fg font-medium'>
                            {frameworkLabel(runtime.framework)}
                        </span>
                        <VersionPicker
                            current={runtime.frameworkVersion}
                            unknownLabel={translate(
                                'web.runtimeDetails.versionPending'
                            )}
                            groups={[
                                {
                                    label: null,
                                    versions: versionChoices(
                                        fwVersions ?? [],
                                        fwLatest
                                    )
                                }
                            ]}
                            latest={fwLatest}
                            update={fwUpgradeAvailable ? fwLatest : null}
                            kind='framework'
                            busy={fwUpgrading || queuedUpgrade}
                            busyLabel={
                                fwStep
                                    ? `${translate('web.runtimeDetails.upgrading')} ${fwStep.replace(/_/g, ' ')}`
                                    : translate('web.runtimeDetails.upgrading')
                            }
                            onPick={
                                fwChangeable
                                    ? (version) =>
                                          void handleUpgradeFramework(version)
                                    : null
                            }
                        />
                        {runtime.kind === 'sprites' && runtime.hostId && (
                            <ShortcutTooltip
                                label={translate(
                                    'web.runtimeDetails.refreshVersion'
                                )}
                                className='shrink-0'
                            >
                                <button
                                    type='button'
                                    disabled={fwRefreshing}
                                    onClick={(): void => {
                                        void handleRefreshFrameworkVersion()
                                    }}
                                    aria-label={translate(
                                        'web.runtimeDetails.refreshVersion'
                                    )}
                                    className='text-subtle hover:bg-surface-hover inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                >
                                    <RefreshIcon
                                        className={[
                                            'h-3.5 w-3.5',
                                            fwRefreshing ? 'loading-spin' : ''
                                        ].join(' ')}
                                    />
                                </button>
                            </ShortcutTooltip>
                        )}
                        <span className='text-subtle'>·</span>
                        <span className='text-caption text-muted'>
                            {placementLabel(runtime.kind)}
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
            {/* No upgrade-available notice here: the badge beside the version
                in the header carries that, and a strip repeating it pushed the
                actual runtime detail below the fold. */}

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
                            <AgentRow key={a.id} agent={a} />
                        ))}
                    </div>
                )}
            </Section>

            {runtimeAccountSupport(runtime.framework, runtime.kind) === 'ok' && (
                <RuntimeAccountSection key={runtime.id} runtime={runtime} />
            )}

            {(runtime.framework === 'openclaw' ||
                (runtime.framework === 'hermes' &&
                    runtime.kind === 'sprites')) && (
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
                    </div>
                </Section>
            )}

            <Section title={translate('web.runtimeDetails.details')}>
                <InfoPanel>
                    {runtime.hostId && (
                        <Info
                            label={translate('web.runtimeDetails.machine')}
                            value={
                                <Link
                                    to={`/settings/runtimes?host=${encodeURIComponent(hostKey(runtime.hostId))}`}
                                    className='text-link hover:text-fg font-medium'
                                >
                                    {runtime.hostName ?? runtime.hostId}
                                </Link>
                            }
                        />
                    )}
                    {runtime.providerName && (
                        <Info
                            label={translate('web.runtimeDetails.provider')}
                            value={runtime.providerName}
                        />
                    )}
                    {runtime.providerRefLabel && (
                        <Info
                            label={translate('web.runtimeDetails.providerRef')}
                            value={monoCopyValue(runtime.providerRefLabel)}
                            mono
                        />
                    )}
                    {runtime.hostId && (
                        <Info
                            label={translate('web.runtimeDetails.availability')}
                            value={availabilityTag(
                                runtime.availability,
                                runtime.powerState
                            )}
                        />
                    )}
                    {runtime.hostKind === 'hosted' && (
                        <Info
                            label={translate('web.runtimeDetails.power')}
                            value={powerStateTag(runtime.powerState)}
                        />
                    )}
                    {runtime.hostId && (
                        <Info
                            label={translate('web.runtimeDetails.daemon')}
                            value={daemonPresenceLabel({
                                online: runtime.daemonOnline === true
                            })}
                        />
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
                    {runtime.hostId && (
                        <Info
                            label={translate('web.runtimeDetails.cliVersion')}
                            value={
                                runtime.daemonCliVersion
                                    ? `v${runtime.daemonCliVersion}`
                                    : null
                            }
                            mono
                        />
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
                    <Info
                        label={translate('web.runtimeDetails.created')}
                        value={dateValue(runtime.createdAt)}
                    />
                </InfoPanel>
            </Section>

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
