import {
    MANYFOLD_CLI_USAGE_SKILL_ID,
    frameworkCapability,
    frameworkUpgradeMode,
    isSkillFramework,
    isUpgradeableFramework,
    isVersionedFramework,
    runtimeKindLabel
} from '@manyfold/shared'
import type {
    AgentBackupRestoreSummary,
    AgentBackupSummary,
    AgentCredentialsView,
    AgentModelConfigSource,
    AgentModelConfigView,
    AgentProbeStatus,
    AgentStorageUsageResponse,
    ChannelSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { NcaClient, SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import {
    ArchiveIcon,
    EditIcon,
    MenuIcon,
    ProviderIcon,
    RefreshIcon,
    RestoreIcon,
    RuntimeIcon,
    SettingsIcon,
    TrashIcon
} from '@/components/icons'
import AgentCredentialsDialog from '@/components/chat/AgentCredentialsDialog'
import ModelSourceSwitch from '@/components/chat/ModelSourceSwitch'
import ProductDialog from '@/components/ProductDialog'
import RenameAgentDialog from '@/components/RenameAgentDialog'
import { CopyButton } from '@/components/RuntimeDetailPanel'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { AgentPermissions } from '@/pages/agents/AgentPermissions'
import { AgentA2a } from '@/pages/agents/AgentA2a'
import { AgentEnvVars } from '@/pages/agents/AgentEnvVars'
import { AgentConnections } from '@/pages/agents/AgentConnections'
import { AgentChannels } from '@/pages/agents/AgentChannels'
import { AgentContextDoc } from '@/pages/agents/AgentContextDoc'
import { AgentMcpTools } from '@/pages/agents/AgentMcpTools'
import { AgentSkills } from '@/pages/agents/AgentSkills'
import { Ghost, Spinner } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { waitForSettled } from '@/lib/backupProgress'
import { apiErrorMessage } from '@/lib/errorMessage'
import type { AgentSettingsSectionId } from '@/lib/agentSettingsSections'
import {
    isAgentSettingsSection,
    sectionLabelKey,
    sectionPreconditionKey
} from '@/lib/agentSettingsSections'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import AgentSettingsRail from '@/pages/AgentSettings/AgentSettingsRail'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import {
    clearEnvPendingRestart,
    readEnvPendingRestart
} from '@/lib/envPendingRestart'
import { useDeleteAgent } from '@/lib/useDeleteAgent'
import { agentStatusDotLabel } from '@/lib/agentStatusDot'
import { formatDateTime } from '@/lib/dateFormat'
import { useI18n } from '@/lib/i18n'
import { timeAgo } from '@/lib/timeAgo'
import { subscribeAgentCredentialsUpdates } from '@/lib/agentCredentialsEvents'
import {
    FrameworkLogo,
    defaultProviderForFramework,
    frameworkLabel
} from '@/lib/frameworkMeta'
import { updatesPath } from '@/lib/updateCenter'
import {
    frameworkUsesModelConfig,
    mergeCachedRuntimeLocalModelConfigView,
    modelConfigDisplayLabel,
    readCachedModelConfigView,
    subscribeModelConfigViewUpdates,
    writeCachedModelConfigView
} from '@/lib/agentModelConfig'
import { providerLabel } from '@/pages/Settings/ModelProviderFields'
import { openDashboardInPopup } from '@/lib/openDashboard'
import {
    ControlRow,
    dashboardStateError,
    dashboardStatePending,
    dashboardStatePendingLabel
} from '@/components/ControlRow'
import { StatusTag, Tag, statusLabel, statusTone } from '@/components/Tag'


const openNativeUi = (
    client: NcaClient,
    runtimeId: string,
    agentId: string
): void => {
    openDashboardInPopup(client.agentRuntimes, {
        runtimeId,
        agentId,
        failureTitle: t('web.agents.detail.openNativeFailed')
    })
}

const formatDate = (value: string | null): string => formatDateTime(value, '-')

const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let size = value
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
    }
    return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

const Info: FC<{ label: string; value: ReactNode; mono?: boolean }> = ({
    label,
    mono,
    value
}): ReactNode => (
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
            {value ?? '-'}
        </dd>
    </div>
)

// min-w-0 because a Fact is usually a grid cell, and a grid track's automatic
// minimum is its content — without it a long value (a workspace path) widens
// the column past the card instead of truncating inside it.
const Fact: FC<{ label: string; value: ReactNode; mono?: boolean }> = ({
    label,
    mono,
    value
}): ReactNode => (
    <div className='min-w-0 px-5 py-4'>
        <dt className='text-caption text-subtle uppercase tracking-wider'>
            {label}
        </dt>
        <dd
            className={[
                'text-ui text-fg mt-1.5 break-all',
                mono ? 'font-mono' : ''
            ].join(' ')}
        >
            {value ?? '-'}
        </dd>
    </div>
)

// Overview's banner stack is the area's router for trouble: the condition
// usually lives in another section, so each banner states it and offers the
// jump. Errors sort before notices — something broken outranks something
// available.
type OverviewBannerTone = 'error' | 'warning' | 'info'

interface OverviewBanner {
    id: string
    tone: OverviewBannerTone
    title: string
    detail?: string | null
    action?: ReactNode
}

const bannerToneClass: Record<OverviewBannerTone, string> = {
    error: 'workbench-alert-error',
    warning: 'workbench-alert-warning',
    info: 'workbench-alert-info'
}

const BANNER_ORDER: Record<OverviewBannerTone, number> = {
    error: 0,
    warning: 1,
    info: 2
}

const BannerStack: FC<{ banners: OverviewBanner[] }> = ({
    banners
}): ReactNode => {
    if (banners.length === 0) return null
    const sorted = [...banners].sort(
        (a, b) => BANNER_ORDER[a.tone] - BANNER_ORDER[b.tone]
    )
    return (
        <div className='space-y-3'>
            {sorted.map((banner) => (
                <div
                    key={banner.id}
                    className={`${bannerToneClass[banner.tone]} flex flex-wrap items-center gap-x-4 gap-y-2`}
                >
                    <div className='min-w-0 flex-1'>
                        <div className='font-medium'>{banner.title}</div>
                        {banner.detail && (
                            <div className='text-caption mt-0.5 opacity-90'>
                                {banner.detail}
                            </div>
                        )}
                    </div>
                    {banner.action}
                </div>
            ))}
        </div>
    )
}

// Look-it-up facts (ids, paths, timestamps) read as a quiet reference list
// rather than competing with the cards for the top of the page.
const QuietRow: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}): ReactNode => (
    <div className='border-divider/50 text-ui flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b py-2 last:border-b-0'>
        <span className='text-caption text-subtle w-28 shrink-0'>{label}</span>
        <span className='text-muted inline-flex min-w-0 items-center gap-1.5'>
            {children}
        </span>
    </div>
)

const StatusPill: FC<{ status: AgentProbeStatus }> = ({
    status
}): ReactNode => (
    <StatusTag tone={statusTone(status)} label={statusLabel(status, t)} />
)

const BackupStatusPill: FC<{ status: AgentBackupSummary['status'] }> = ({
    status
}): ReactNode => (
    <StatusTag tone={statusTone(status)} label={statusLabel(status, t)} />
)

const modelFromCredentialsView = (
    credentials: AgentCredentialsView | null
): string | null =>
    (credentials?.extras.model as string | null | undefined) ??
    (credentials?.extras.primaryModelName as string | null | undefined) ??
    null

const AgentSettingsContent: FC = (): ReactNode => {
    const { id, section } = useParams<{ id: string; section?: string }>()
    const navigate = useNavigate()
    // The URL is the single source of truth for which section is open, so a
    // deep link, a rail click and the browser's Back button all agree.
    const activeTab: AgentSettingsSectionId = isAgentSettingsSection(section)
        ? section
        : 'overview'
    const [searchParams, setSearchParams] = useSearchParams()
    const { t: translate } = useI18n()
    const [drawerOpen, setDrawerOpen] = useState(false)
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [agent, setAgent] = useState<SdkAgent | null>(null)
    const [credentials, setCredentials] = useState<AgentCredentialsView | null>(
        null
    )
    const [storage, setStorage] = useState<AgentStorageUsageResponse | null>(
        null
    )
    // Overview summarises the interfaces and surfaces channel breakage, both of
    // which live in other sections — so it reads them here rather than making
    // the user go look.
    const [channels, setChannels] = useState<ChannelSummary[] | null>(null)
    const [a2aEnabled, setA2aEnabled] = useState<boolean | null>(null)
    // Whether the platform's own skill — the one that lets the agent drive
    // Manyfold on your behalf — is installed. null while unknown, so the card
    // stays quiet rather than claiming "not installed" before it has looked.
    const [cliSkillInstalled, setCliSkillInstalled] = useState<boolean | null>(
        null
    )
    const [cliSkillInstalling, setCliSkillInstalling] = useState(false)
    const [restarting, setRestarting] = useState(false)
    const [backups, setBackups] = useState<AgentBackupSummary[]>([])
    const [lastRestore, setLastRestore] =
        useState<AgentBackupRestoreSummary | null>(null)
    const [loading, setLoading] = useState(true)
    const [storageLoading, setStorageLoading] = useState(false)
    const [backupsLoading, setBackupsLoading] = useState(false)
    const [backupBusy, setBackupBusy] = useState<string | null>(null)
    // `error` means the agent could not be loaded, which is the only thing that
    // earns the whole-page fallback. An action that fails (a restart the
    // framework does not support, an install the plan refuses) leaves the page
    // standing and reports above the section, so the reader keeps the rail, the
    // facts and the way out.
    const [error, setError] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const {
        deleteAgent,
        deleting,
        confirmDialog: deleteAgentDialog
    } = useDeleteAgent({
        onError: setActionError,
        redirectTo: () => '/workspace'
    })
    const [credentialsError, setCredentialsError] = useState<string | null>(
        null
    )
    const [storageError, setStorageError] = useState<string | null>(null)
    const [backupsError, setBackupsError] = useState<string | null>(null)
    const [credentialsDialogOpen, setCredentialsDialogOpen] = useState(false)
    const [renameOpen, setRenameOpen] = useState(false)
    const [fwRefreshing, setFwRefreshing] = useState(false)
    const [dashboardToggling, setDashboardToggling] = useState(false)
    const [dashboardToggleError, setDashboardToggleError] = useState<
        string | null
    >(null)
    const [fwUpgrading, setFwUpgrading] = useState(false)
    const [fwError, setFwError] = useState<string | null>(null)
    const [fwPickerOpen, setFwPickerOpen] = useState(false)
    const [fwVersions, setFwVersions] = useState<string[] | null>(null)
    const [fwTarget, setFwTarget] = useState<string>('')
    const [fwStep, setFwStep] = useState<string | null>(null)
    const [modelConfigView, setModelConfigView] =
        useState<AgentModelConfigView | null>(null)
    const applyModelConfigView = useCallback(
        (view: AgentModelConfigView): void => {
            setModelConfigView(view)
        },
        []
    )
    const [sourceUpdating, setSourceUpdating] = useState(false)
    const [sourceError, setSourceError] = useState<string | null>(null)

    const changeModelSource = useCallback(
        async (next: AgentModelConfigSource): Promise<void> => {
            if (!id || sourceUpdating) return
            if (modelConfigView?.source === next) return
            setSourceUpdating(true)
            setSourceError(null)
            try {
                const view = await client.agents.updateModelConfig(id, {
                    modelConfigSource: next
                })
                writeCachedModelConfigView(view)
                setModelConfigView(view)
            } catch (err) {
                setSourceError(apiErrorMessage(err))
            } finally {
                setSourceUpdating(false)
            }
        },
        [client, id, modelConfigView?.source, sourceUpdating]
    )

    const selectTab = useCallback(
        (next: AgentSettingsSectionId): void => {
            if (!id) return
            navigate(agentSettingsPath(id, next))
        },
        [id, navigate]
    )

    // A slug that names no section falls back to Overview, so put that in the
    // address too — otherwise the bogus URL is what gets copied and shared.
    useEffect(() => {
        if (!id || !section || isAgentSettingsSection(section)) return
        navigate(agentSettingsPath(id, 'overview'), { replace: true })
    }, [id, navigate, section])

    const refreshStorage = useCallback(async (): Promise<void> => {
        if (!id) return
        setStorageLoading(true)
        setStorageError(null)
        try {
            setStorage(await client.agents.storageUsage(id))
        } catch (err) {
            setStorageError((err as Error).message)
        } finally {
            setStorageLoading(false)
        }
    }, [client, id])

    const refreshBackups = useCallback(async (): Promise<void> => {
        if (!id) return
        setBackupsLoading(true)
        setBackupsError(null)
        try {
            setBackups(await client.backups.list({ agentId: id }))
        } catch (err) {
            setBackupsError((err as Error).message)
        } finally {
            setBackupsLoading(false)
        }
    }, [client, id])

    useEffect(() => {
        if (!id) return
        let cancelled = false
        const cachedModelConfig = readCachedModelConfigView(id)
        if (cachedModelConfig) applyModelConfigView(cachedModelConfig)
        setLoading(true)
        setError(null)
        setCredentialsError(null)
        Promise.all([
            client.agents.get(id),
            client.agents.getModelConfig(id).catch(() => null),
            client.agents.credentials.get(id).catch((err: Error) => {
                setCredentialsError(err.message)
                return null
            })
        ])
            .then(([nextAgent, nextModelConfig, nextCredentials]) => {
                if (cancelled) return
                setAgent(nextAgent)
                const cachedAtResponse =
                    readCachedModelConfigView(id) ?? cachedModelConfig
                const nextView = nextModelConfig
                    ? mergeCachedRuntimeLocalModelConfigView(
                          nextModelConfig,
                          cachedAtResponse
                      )
                    : cachedAtResponse?.framework === nextAgent.framework &&
                        frameworkUsesModelConfig(
                            nextAgent.framework,
                            nextAgent.runtime
                        )
                      ? cachedAtResponse
                      : null
                if (nextView) {
                    writeCachedModelConfigView(nextView)
                    applyModelConfigView(nextView)
                } else {
                    setModelConfigView(null)
                }
                setCredentials(nextCredentials)
            })
            .catch((err: Error) => {
                if (!cancelled) setError(err.message)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, id, applyModelConfigView])

    useEffect(() => {
        void refreshStorage()
    }, [refreshStorage])

    useEffect(() => {
        void refreshBackups()
    }, [refreshBackups])

    const createBackup = async (): Promise<void> => {
        if (!id || backupBusy) return
        setBackupBusy('create')
        setBackupsError(null)
        try {
            const { backup } = await client.backups.create(id)
            setBackups((items) => [backup, ...items])
            window.setTimeout(() => {
                void refreshBackups()
            }, 2500)
        } catch (err) {
            setBackupsError((err as Error).message)
        } finally {
            setBackupBusy(null)
        }
    }

    const deleteBackup = async (backup: AgentBackupSummary): Promise<void> => {
        if (backupBusy) return
        if (
            !(await confirm({
                title: t('web.agents.detail.storage.deleteTitle'),
                description: t('web.agents.detail.storage.deleteConfirm', {
                    date: formatDate(backup.createdAt)
                }),
                confirmLabel: t('web.agents.detail.storage.deleteAction'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBackupBusy(backup.id)
        setBackupsError(null)
        try {
            await client.backups.delete(backup.id)
            setBackups((items) => items.filter((item) => item.id !== backup.id))
        } catch (err) {
            setBackupsError((err as Error).message)
        } finally {
            setBackupBusy(null)
        }
    }

    const restoreBackup = async (backup: AgentBackupSummary): Promise<void> => {
        if (!id || backupBusy) return
        if (
            !(await confirm({
                title: t('web.agents.detail.storage.restoreTitle'),
                description: [
                    t('web.agents.detail.storage.restoreConfirm', {
                        date: formatDate(backup.createdAt)
                    }),
                    t('web.agents.detail.storage.restoreSnapshotNote')
                ].join(' '),
                confirmLabel: t('web.agents.detail.storage.restoreAction'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBackupBusy(backup.id)
        setBackupsError(null)
        try {
            // Restore overwrites the workspace, so take a snapshot of what is
            // there first. Without it the only way to undo a restore chosen by
            // mistake is a backup that happens to predate it, and the state it
            // replaced is gone for good.
            const { backup: safety } = await client.backups.create(id)
            setBackups((items) => [safety, ...items])
            // `create` only enqueues the archive job, so the snapshot is still
            // being read out of the workspace right now. Waiting for it is the
            // whole safety net: starting the restore here would overwrite the
            // workspace the snapshot is mid-read of, and a snapshot that then
            // fails would leave the restore already under way with nothing to
            // go back to.
            const settled = await waitForSettled(safety, async () => {
                const items = await client.backups.list({ agentId: id })
                setBackups(items)
                return items.find((item) => item.id === safety.id)
            })
            if (settled?.status !== 'succeeded')
                throw new Error(
                    t(
                        settled?.status === 'running'
                            ? 'web.agents.detail.storage.restoreSnapshotTimeout'
                            : 'web.agents.detail.storage.restoreSnapshotFailed'
                    )
                )
            const restore = await client.backups.restore(id, {
                backupId: backup.id
            })
            setLastRestore(restore)
            const finished = await waitForSettled(restore, async () => {
                const next = await client.backups.getRestore(restore.id)
                setLastRestore(next)
                return next
            })
            await refreshBackups()
            if (finished?.status === 'failed')
                throw new Error(
                    finished.errorMessage ??
                        t('web.agents.detail.storage.restoreFailed')
                )
        } catch (err) {
            setBackupsError((err as Error).message)
        } finally {
            setBackupBusy(null)
        }
    }

    // Both are read-only summaries for Overview; a failure here must not take
    // the page down, so each falls back to "unknown" and simply shows nothing.
    useEffect(() => {
        if (!id) return
        let active = true
        void client.channels
            .list()
            .then((list) => {
                if (active) setChannels(list)
            })
            .catch(() => {
                // Leave null: unknown is not the same as none.
                if (active) setChannels(null)
            })
        void client.a2a
            .getExposure(id)
            .then((exposure) => {
                if (active) setA2aEnabled(exposure?.enabled ?? false)
            })
            .catch(() => {
                if (active) setA2aEnabled(null)
            })
        return () => {
            active = false
        }
    }, [client, id])

    // Overview only asks "is the platform skill there", so it reads the
    // recorded installs without the runtime inventory probe the Skills section
    // pays for — that skill is always installed through Manyfold, so the
    // record is the answer.
    const refreshCliSkill = useCallback(async (): Promise<void> => {
        if (!id) return
        try {
            const groups = await client.skills.installed(id)
            setCliSkillInstalled(
                (groups[0]?.skills ?? []).some(
                    (skill) => skill.skillId === MANYFOLD_CLI_USAGE_SKILL_ID
                )
            )
        } catch {
            // Unknown is not the same as missing: leave the card off rather
            // than inviting an install that may already exist.
            setCliSkillInstalled(null)
        }
    }, [client, id])

    // Keyed on what the answer depends on, not on the agent object: the status
    // poll replaces that object every few seconds, and the install record does
    // not change under it.
    const agentFramework = agent?.framework ?? null
    const agentRuntimeId = agent?.runtimeId ?? null
    useEffect(() => {
        if (!agentFramework || !agentRuntimeId) return
        if (!isSkillFramework(agentFramework)) return
        void refreshCliSkill()
    }, [agentFramework, agentRuntimeId, refreshCliSkill])

    const installCliSkill = useCallback(async (): Promise<void> => {
        if (!id || cliSkillInstalling) return
        setCliSkillInstalling(true)
        setActionError(null)
        try {
            await client.skills.install({
                skillId: MANYFOLD_CLI_USAGE_SKILL_ID,
                agentId: id
            })
            await refreshCliSkill()
        } catch (err) {
            setActionError(apiErrorMessage(err))
        } finally {
            setCliSkillInstalling(false)
        }
    }, [client, cliSkillInstalling, id, refreshCliSkill])

    const handleRestart = useCallback(async (): Promise<void> => {
        if (!agent || restarting) return
        if (
            !(await confirm({
                title: t('web.agentSettings.restart.title'),
                description: t('web.agentSettings.restart.description', {
                    name: agent.name
                }),
                confirmLabel: t('web.agentSettings.restart.confirm')
            }))
        )
            return
        setRestarting(true)
        setActionError(null)
        try {
            setAgent(await client.agents.restart(agent.id))
            // The restart records a fresh startedAt, so any other surface
            // reading the pending mark also agrees the values are live now.
            clearEnvPendingRestart(agent.id)
        } catch (err) {
            setActionError(apiErrorMessage(err))
        } finally {
            setRestarting(false)
        }
    }, [agent, client, confirm, restarting, t])

    const refreshAgentSummary =
        useCallback(async (): Promise<SdkAgent | null> => {
            if (!id) return null
            const nextAgent = await client.agents.get(id)
            setAgent(nextAgent)
                        return nextAgent
        }, [client, id])

    // Toggle the framework dashboard (openclaw control UI / hermes
    // dashboard) on this agent's runtime. Hermes sprite toggles run async
    // server-side — dashboardState carries progress and the polling effect
    // below follows it until it settles.
    const handleToggleDashboard = async (): Promise<void> => {
        const runtimeId = agent?.runtimeId
        if (!agent || !runtimeId || dashboardToggling) return
        setDashboardToggling(true)
        setDashboardToggleError(null)
        try {
            if (agent.framework === 'openclaw')
                await client.agentRuntimes.setControlUi(
                    runtimeId,
                    !agent.controlUiEnabled
                )
            else
                await client.agentRuntimes.setDashboard(
                    runtimeId,
                    !agent.dashboardEnabled
                )
            await refreshAgentSummary()
        } catch (err) {
            setDashboardToggleError(apiErrorMessage(err))
        } finally {
            setDashboardToggling(false)
        }
    }

    const handleOpenAgentDashboard = (): void => {
        const runtimeId = agent?.runtimeId
        if (!runtimeId) return
        openDashboardInPopup(client.agentRuntimes, {
            runtimeId,
            failureTitle: t('web.shell.openDashboardFailedTitle')
        })
    }

    const agentDashboardState = agent?.dashboardState ?? null
    useEffect(() => {
        if (!dashboardStatePending(agentDashboardState)) return
        const timer = window.setInterval(() => {
            void refreshAgentSummary().catch(() => undefined)
        }, 5_000)
        return (): void => window.clearInterval(timer)
    }, [agentDashboardState, refreshAgentSummary])

    const handleRefreshFrameworkVersion = async (): Promise<void> => {
        if (!id || fwRefreshing) return
        setFwRefreshing(true)
        setFwError(null)
        try {
            const next = await client.agents.refreshFrameworkVersion(id)
            setAgent(next)
                    } catch (err) {
            setFwError(apiErrorMessage(err))
        } finally {
            setFwRefreshing(false)
        }
    }

    const handleOpenVersionPicker = async (): Promise<void> => {
        setFwPickerOpen(true)
        setFwError(null)
        if (fwVersions || !agent) return
        try {
            const catalog = await client.frameworkVersions.get(agent.framework)
            setFwVersions(catalog.versions)
            setFwTarget(
                agent.frameworkLatestVersion ??
                    catalog.latest ??
                    catalog.versions[0] ??
                    ''
            )
        } catch (err) {
            setFwError(apiErrorMessage(err))
        }
    }

    const handleUpgradeFramework = async (): Promise<void> => {
        if (!id || !fwTarget || !agent || fwUpgrading) return
        setFwUpgrading(true)
        setFwError(null)
        setFwStep(null)
        try {
            if (frameworkUpgradeMode(agent.framework) === 'rebuild') {
                // heavy rebuild (narranexus) — stream phase events for liveness
                const next = await client.agents.upgradeFrameworkStream(
                    id,
                    fwTarget,
                    (ev) => {
                        if (ev.type === 'step') setFwStep(ev.step)
                    }
                )
                setAgent(next)
            } else {
                setAgent(await client.agents.upgradeFramework(id, fwTarget))
            }
                        setFwPickerOpen(false)
        } catch (err) {
            setFwError(apiErrorMessage(err))
        } finally {
            setFwUpgrading(false)
            setFwStep(null)
        }
    }

    useEffect(() => {
        if (!id) return
        return subscribeAgentCredentialsUpdates(id, (nextCredentials) => {
            setCredentials(nextCredentials)
            setCredentialsError(null)
            void refreshAgentSummary()
        })
    }, [id, refreshAgentSummary])

    useEffect(() => {
        if (!id) return
        return subscribeModelConfigViewUpdates(id, (nextView) => {
            if (agent && nextView.framework !== agent.framework) return
            applyModelConfigView(nextView)
        })
    }, [agent, applyModelConfigView, id])

    useEffect(() => {
        if (searchParams.get('configureModel') !== '1' || !id) return
        setCredentialsDialogOpen(true)
        const next = new URLSearchParams(searchParams)
        next.delete('configureModel')
        setSearchParams(next, { replace: true })
        if (activeTab !== 'model') navigate(agentSettingsPath(id, 'model'))
    }, [activeTab, id, navigate, searchParams, setSearchParams])

    if (loading && !agent) {
        return (
            <div className='settings-content' aria-busy='true'>
                <div className='settings-page'>
                    <Ghost variant='title' className='w-56' />
                    <Ghost variant='cap' className='mt-3 w-80 max-w-full' />
                    <div className='workbench-panel mt-7 space-y-3 px-5 py-5'>
                        <Ghost variant='line' className='w-1/4' />
                        <Ghost variant='cap' className='w-3/5' />
                        <Ghost variant='cap' className='w-2/5' />
                        <Ghost variant='cap' className='w-1/2' />
                    </div>
                </div>
            </div>
        )
    }

    if (error || !agent) {
        return (
            <div className='settings-content'>
                <div className='settings-page'>
                    <div className='workbench-alert-error'>
                        {error ?? t('web.agents.detail.notFound')}
                    </div>
                </div>
            </div>
        )
    }

    const statusChipLabel = agentStatusDotLabel(
        agent.status,
        agent.spriteStatus,
        agent.k8sPodPhase
    )
    const runtimeLocation =
        agent.runtime === 'sprites'
            ? agent.spriteName
            : agent.runtime === 'daemon'
              ? t('web.agents.detail.yourMachine')
              : (agent.namespace ?? agent.ingressHost)
    // Skills materialize into the agent's workspace for the frameworks that
    // discover them (claude-code/codex/gemini-cli/hermes); the API resolves
    // them through the agent's runtime, so a runtime must be attached.
    const skillsSupported =
        isSkillFramework(agent.framework) && !!agent.runtimeId
    // Only a framework that runs a long-lived service has something to restart,
    // and only on a sprite runtime can we do it — the same two preconditions the
    // endpoint enforces. Offering the button anywhere else buys a 400 for the
    // one lifecycle action on the page.
    const canRestart =
        frameworkCapability(agent.framework).kind === 'service' &&
        agent.runtime === 'sprites'
    // "up to date" is a comparison, so it takes both sides. With no latest
    // release read, the honest render is the installed version and nothing else.
    const cliUpToDate =
        !!agent.cliVersion &&
        !!agent.cliLatestVersion &&
        !agent.cliUpdateAvailable
    const runtimePath = agent.runtimeId
        ? `/settings/runtimes/${agent.runtimeId}`
        : '/settings/runtimes'
    const modelProviderType =
        credentials?.provider ?? defaultProviderForFramework(agent.framework)
    const usesFrameworkModelConfig = frameworkUsesModelConfig(
        agent.framework,
        agent.runtime
    )
    const providerDisplay =
        credentials?.localManaged &&
        usesFrameworkModelConfig &&
        modelConfigView?.source === 'runtime-local'
            ? t('web.agents.detail.modelProvider.runtimeLocalConfig')
            : providerLabel[modelProviderType]
    const modelConfigDisplay = usesFrameworkModelConfig
        ? modelConfigDisplayLabel(
              modelConfigView,
              modelConfigView?.config ?? null,
              agent.model ?? frameworkLabel(agent.framework),
              translate
          )
        : (agent.model ?? modelFromCredentialsView(credentials))
    const supportedModelSummary =
        usesFrameworkModelConfig && modelConfigView
            ? modelConfigView.source === 'runtime-local'
                ? modelConfigView.runtimeLocal?.ready
                    ? modelConfigView.runtimeLocal.models.length > 0
                        ? t('web.agents.detail.modelProvider.localModels', {
                              count: modelConfigView.runtimeLocal.models.length
                          })
                        : t('web.agents.detail.modelProvider.runtimeLocal')
                    : t('web.agents.detail.modelProvider.testRequired')
                : modelConfigView.providerModelsStatus === 'ready'
                  ? t('web.agents.detail.modelProvider.supportedCount', {
                        count: modelConfigView.providerModels.length
                    })
                  : modelConfigView.providerModelsStatus === 'needs_refresh'
                    ? t('web.agents.detail.modelProvider.testRequired')
                    : t('web.agents.detail.modelProvider.unavailable')
            : null
    const modelSourceLabel =
        usesFrameworkModelConfig && modelConfigView
            ? modelConfigView.source === 'runtime-local'
                ? t('web.agents.detail.modelProvider.runtimeLocalConfig')
                : t('web.agents.detail.modelProvider.manyfoldConfig')
            : null
    const modelSourceSwitchable =
        usesFrameworkModelConfig &&
        !!modelConfigView &&
        modelConfigView.availableSources.includes('runtime-local')
    const modelValidationMessage =
        usesFrameworkModelConfig && modelConfigView?.validation.valid === false
            ? (modelConfigView.validation.messages[0] ??
              t('web.agents.detail.modelProvider.needsAttention'))
            : null
    const configureProviderLabel =
        usesFrameworkModelConfig &&
        modelConfigView?.validation.cta === 'configure-claude-mapping'
            ? t('web.agents.detail.modelProvider.configureMapping')
            : t('web.agents.detail.modelProvider.configureProvider')
    const hasModelProviderSummary = Boolean(
        credentials &&
        (!credentials.localManaged ||
            credentials.apiKeyMasked ||
            credentials.savedProvider ||
            (usesFrameworkModelConfig && modelConfigView))
    )

    // A section this agent cannot have (env vars on a daemon, MCP on a
    // framework that ignores it) is absent from the rail, but a bookmark can
    // still land on it — explain the precondition rather than 404.
    const sectionUnavailableKey = sectionPreconditionKey(agent, activeTab)
    const activeSectionLabelKey = sectionLabelKey(activeTab)

    const renderActiveTab = (): ReactNode => {
        switch (activeTab) {
            case 'overview': {
                const fwSprite = agent.runtime === 'sprites'
                const fwVersioned = isVersionedFramework(agent.framework)
                const fwUpgradeable =
                    fwSprite && isUpgradeableFramework(agent.framework)
                const fwUpgradeReady =
                    fwUpgradeable &&
                    agent.frameworkUpgradeAvailable &&
                    !!agent.frameworkLatestVersion
                const fwLatestLabel = agent.frameworkLatestVersion
                    ? agent.frameworkUpgradeAvailable
                        ? t(
                              'web.agents.detail.framework.latestAvailable',
                              { version: agent.frameworkLatestVersion }
                          )
                        : t('web.agents.detail.framework.latest', {
                              version: agent.frameworkLatestVersion
                          })
                    : null
                const hasEndpoint =
                    (agent.framework === 'narranexus' && !!agent.runtimeId) ||
                    !!agent.endpointUrl
                const brokenChannels = (channels ?? []).filter(
                    (channel) =>
                        channel.agentId === agent.id &&
                        channel.status === 'error'
                )
                const banners: OverviewBanner[] = []
                if (agent.failureReason)
                    banners.push({
                        id: 'failure',
                        tone: 'error',
                        title: agent.failureReason
                    })
                if (brokenChannels.length > 0)
                    banners.push({
                        id: 'channels',
                        tone: 'error',
                        title: t('web.agentSettings.overview.channelsBroken', {
                            name: brokenChannels[0]?.label ?? ''
                        }),
                        detail: [
                            brokenChannels[0]?.lastErrorMessage,
                            brokenChannels.length > 1
                                ? t(
                                      'web.agentSettings.overview.channelsBrokenMore',
                                      { count: brokenChannels.length - 1 }
                                  )
                                : null
                        ]
                            .filter(Boolean)
                            .join(' · '),
                        action: (
                            <button
                                type='button'
                                onClick={() => selectTab('channels')}
                                className='workbench-button-secondary shrink-0'
                            >
                                {t('web.agentSettings.overview.fixInChannels')}
                            </button>
                        )
                    })
                if (agent.frameworkVersionBlockedReason)
                    banners.push({
                        id: 'framework-blocked',
                        tone: 'error',
                        title: t(
                            'web.agents.detail.framework.versionBlocked',
                            { framework: frameworkLabel(agent.framework) }
                        ),
                        detail: agent.frameworkVersionBlockedReason,
                        action: fwUpgradeable ? (
                            <button
                                type='button'
                                onClick={() => void handleOpenVersionPicker()}
                                className='workbench-button-secondary shrink-0'
                            >
                                {t(
                                    'web.agents.detail.framework.changeVersionEllipsis'
                                )}
                            </button>
                        ) : undefined
                    })
                const envPending = readEnvPendingRestart(
                    agent.id,
                    agent.startedAt
                )
                if (envPending)
                    banners.push({
                        id: 'env-pending',
                        tone: 'warning',
                        title: t(
                            'web.agents.detail.environment.pendingTitle'
                        ),
                        detail: t(
                            'web.agents.detail.environment.pendingDetail',
                            { framework: frameworkLabel(agent.framework) }
                        ),
                        action: (
                            <button
                                type='button'
                                onClick={() => selectTab('environment')}
                                className='workbench-button-secondary shrink-0'
                            >
                                {t('web.agentSettings.sections.environment')}
                            </button>
                        )
                    })
                // A framework upgrade being available is news, not trouble: it
                // rides in the Framework cell's hint line instead of a banner,
                // so a banner on this page always means something needs doing.
                // An agent with no runtime of its own (an external one) has its
                // endpoint as the second fact instead; anywhere else the
                // endpoint stays a look-it-up detail. Either way it renders
                // once.
                const endpointInStrip = hasEndpoint && !agent.runtimeId
                const endpointValue =
                    agent.framework === 'narranexus' && agent.runtimeId ? (
                        <button
                            type='button'
                            onClick={() => {
                                const runtimeId = agent.runtimeId
                                if (!runtimeId) return
                                openNativeUi(client, runtimeId, agent.id)
                            }}
                            className='text-link hover:text-fg'
                        >
                            {t('web.agents.detail.openNativeUi')}
                            <span aria-hidden='true'> ↗</span>
                        </button>
                    ) : agent.endpointUrl ? (
                        <a
                            href={agent.endpointUrl}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='text-link hover:text-fg min-w-0 truncate'
                        >
                            {agent.endpointUrl}
                            <span aria-hidden='true'> ↗</span>
                        </a>
                    ) : null
                const showCli =
                    !!agent.runtimeId && agent.runtime !== 'external'
                const cliSkillCard =
                    isSkillFramework(agent.framework) &&
                    !!agent.runtimeId &&
                    cliSkillInstalled !== null

                return (
                    <section className='space-y-5'>
                        <BannerStack banners={banners} />

                        {/* The page's own title: this section's subject is the
                            agent itself. It carries what the rail's thumbnail
                            deliberately does not — renaming, and the one
                            lifecycle action. */}
                        <div className='flex flex-wrap items-center gap-3'>
                            <span className='shrink-0'>
                                <FrameworkLogo
                                    framework={agent.framework}
                                    size={36}
                                />
                            </span>
                            <div className='min-w-0 flex-1'>
                                <div className='flex min-w-0 items-center gap-1'>
                                    <h2 className='text-h3 text-fg min-w-0 truncate tracking-tight'>
                                        {agent.name}
                                    </h2>
                                    <ShortcutTooltip
                                        label={t('web.shell.rename')}
                                    >
                                        <button
                                            type='button'
                                            onClick={() => setRenameOpen(true)}
                                            aria-label={t('web.shell.rename')}
                                            className='text-subtle hover:text-fg hover:bg-surface-hover rounded-pill inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors'
                                        >
                                            <EditIcon className='h-3.5 w-3.5' />
                                        </button>
                                    </ShortcutTooltip>
                                </div>
                                <div className='mt-1 flex flex-wrap items-center gap-2'>
                                    <StatusTag
                                        tone={statusTone(statusChipLabel)}
                                        label={statusLabel(
                                            statusChipLabel,
                                            translate
                                        )}
                                    />
                                    {agent.keepAliveEnabled ? (
                                        <span className='text-caption text-subtle'>
                                            {t(
                                                'web.agentSettings.overview.keepAliveOn'
                                            )}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                            {canRestart && (
                                <button
                                    type='button'
                                    disabled={restarting}
                                    onClick={() => void handleRestart()}
                                    className='workbench-button-secondary shrink-0'
                                >
                                    {restarting
                                        ? t('web.agentSettings.restart.working')
                                        : t('web.agentSettings.restart.action')}
                                </button>
                            )}
                        </div>

                        {/* What this agent is made of. These four were spread
                            across three places (a row, a grid cell and the
                            reference list at the bottom) and the mf CLI was
                            nowhere — yet they are the first things anyone
                            checks when something behaves oddly. */}
                        <dl className='workbench-panel divide-divider divide-y overflow-hidden'>
                            <div className='divide-divider grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0'>
                                <Fact
                                    label={t(
                                        agent.runtime === 'external'
                                            ? 'web.agentSettings.overview.provider'
                                            : 'web.agentSettings.overview.framework'
                                    )}
                                    value={
                                        <>
                                            <span className='flex flex-wrap items-center gap-2'>
                                                <span>
                                                    {frameworkLabel(
                                                        agent.framework
                                                    )}
                                                </span>
                                                {fwVersioned ? (
                                                    agent.frameworkVersion ? (
                                                        <Tag mono>
                                                            {
                                                                agent.frameworkVersion
                                                            }
                                                        </Tag>
                                                    ) : (
                                                        <span className='text-caption text-subtle'>
                                                            {t(
                                                                'web.agents.detail.framework.notDetected'
                                                            )}
                                                        </span>
                                                    )
                                                ) : null}
                                                {fwSprite && (
                                                    <ShortcutTooltip
                                                        label={t(
                                                            'web.agents.detail.framework.refreshVersion'
                                                        )}
                                                    >
                                                        <button
                                                            type='button'
                                                            disabled={
                                                                fwRefreshing
                                                            }
                                                            onClick={() =>
                                                                void handleRefreshFrameworkVersion()
                                                            }
                                                            aria-label={t(
                                                                'web.agents.detail.framework.refreshVersion'
                                                            )}
                                                            className='text-subtle hover:text-fg hover:bg-surface-hover rounded-pill inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                                        >
                                                            <RefreshIcon
                                                                className={
                                                                    fwRefreshing
                                                                        ? 'h-3.5 w-3.5 loading-spin'
                                                                        : 'h-3.5 w-3.5'
                                                                }
                                                            />
                                                        </button>
                                                    </ShortcutTooltip>
                                                )}
                                            </span>
                                            {fwUpgradeable ? (
                                                fwUpgradeReady ? (
                                                    <Link
                                                        to={updatesPath(
                                                            'framework'
                                                        )}
                                                        className='text-caption text-subtle hover:text-fg mt-1 block transition-colors'
                                                    >
                                                        {fwLatestLabel}
                                                    </Link>
                                                ) : (
                                                    <button
                                                        type='button'
                                                        onClick={() =>
                                                            void handleOpenVersionPicker()
                                                        }
                                                        className='text-caption text-subtle hover:text-fg mt-1 block transition-colors'
                                                    >
                                                        {t(
                                                            'web.agents.detail.framework.changeVersion'
                                                        )}
                                                    </button>
                                                )
                                            ) : fwLatestLabel ? (
                                                <span className='text-caption text-subtle mt-1 block'>
                                                    {fwLatestLabel}
                                                </span>
                                            ) : null}
                                        </>
                                    }
                                />
                                {agent.runtimeId ? (
                                    <Fact
                                        label={t('web.agents.detail.runtime')}
                                        value={
                                            <>
                                                <Link
                                                    to={runtimePath}
                                                    className='text-link hover:text-fg inline-flex max-w-full items-center gap-1.5'
                                                >
                                                    <RuntimeIcon className='h-3.5 w-3.5 shrink-0' />
                                                    <span>
                                                        {runtimeKindLabel(
                                                            agent.runtime
                                                        )}
                                                    </span>
                                                    <span aria-hidden='true'>
                                                        →
                                                    </span>
                                                </Link>
                                                {runtimeLocation ? (
                                                    <span className='text-caption text-subtle mt-1 block truncate font-mono'>
                                                        {runtimeLocation}
                                                    </span>
                                                ) : null}
                                            </>
                                        }
                                    />
                                ) : endpointInStrip ? (
                                    <Fact
                                        label={t('web.agents.detail.endpoint')}
                                        value={endpointValue}
                                    />
                                ) : null}
                            </div>
                            {showCli || agent.workspacePath ? (
                                <div className='divide-divider grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0'>
                                    {showCli && (
                                        <Fact
                                            label={t(
                                                'web.agentSettings.overview.cli'
                                            )}
                                            value={
                                                <>
                                                    {agent.cliVersion ? (
                                                        <Tag mono>
                                                            {agent.cliVersion}
                                                        </Tag>
                                                    ) : (
                                                        <span className='text-caption text-subtle'>
                                                            {t(
                                                                'web.agents.detail.framework.notDetected'
                                                            )}
                                                        </span>
                                                    )}
                                                    {agent.cliUpdateAvailable &&
                                                    agent.cliLatestVersion ? (
                                                        <Link
                                                            to={updatesPath(
                                                                'cli'
                                                            )}
                                                            className='text-caption text-subtle hover:text-fg mt-1 block transition-colors'
                                                        >
                                                            {t(
                                                                'web.agentSettings.overview.cliUpdate',
                                                                {
                                                                    version:
                                                                        agent.cliLatestVersion
                                                                }
                                                            )}
                                                        </Link>
                                                    ) : cliUpToDate ? (
                                                        <span className='text-caption text-subtle mt-1 block'>
                                                            {t(
                                                                'web.agentSettings.overview.cliUpToDate'
                                                            )}
                                                        </span>
                                                    ) : null}
                                                </>
                                            }
                                        />
                                    )}
                                    {agent.workspacePath ? (
                                        <Fact
                                            label={t(
                                                'web.agents.detail.workspace'
                                            )}
                                            value={
                                                <span className='flex min-w-0 items-center gap-1.5'>
                                                    <ShortcutTooltip
                                                        label={
                                                            agent.workspacePath
                                                        }
                                                        className='min-w-0'
                                                    >
                                                        <span className='block min-w-0 truncate font-mono'>
                                                            {agent.workspacePath}
                                                        </span>
                                                    </ShortcutTooltip>
                                                    <CopyButton
                                                        value={
                                                            agent.workspacePath
                                                        }
                                                        label={t(
                                                            'web.agents.detail.copyWorkspacePath'
                                                        )}
                                                    />
                                                </span>
                                            }
                                        />
                                    ) : null}
                                </div>
                            ) : null}
                        </dl>

                        {/* How it has been doing lately. */}
                        <dl className='workbench-panel divide-divider divide-y overflow-hidden'>
                            <div className='divide-divider grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0'>
                                <Fact
                                    label={t('web.agents.detail.lastMessage')}
                                    value={
                                        agent.lastMessageAt
                                            ? timeAgo(agent.lastMessageAt)
                                            : '-'
                                    }
                                />
                                <Fact
                                    label={t('web.agents.detail.lastActive')}
                                    value={
                                        agent.lastActiveAt
                                            ? timeAgo(agent.lastActiveAt)
                                            : '-'
                                    }
                                />
                            </div>
                            {agent.runtime !== 'external' && (
                                <div className='flex flex-wrap items-center justify-between gap-3 px-5 py-4'>
                                    <div className='min-w-0'>
                                        <dt className='text-caption text-subtle uppercase tracking-wider'>
                                            {t(
                                                'web.agents.detail.storage.title'
                                            )}
                                        </dt>
                                        <dd className='text-ui text-fg mt-1.5 tabular-nums'>
                                            {storage
                                                ? formatBytes(
                                                      storage.totalBytes
                                                  )
                                                : '-'}
                                            <span className='text-subtle'>
                                                {storage
                                                    ? t(
                                                          'web.agents.detail.storage.measuredInline',
                                                          {
                                                              date: formatDate(
                                                                  storage.checkedAt
                                                              )
                                                          }
                                                      )
                                                    : t(
                                                          'web.agents.detail.storage.notMeasuredInline'
                                                      )}
                                            </span>
                                        </dd>
                                    </div>
                                    <button
                                        type='button'
                                        onClick={() => selectTab('storage')}
                                        className='text-link hover:text-fg text-ui inline-flex shrink-0 items-center gap-1'
                                    >
                                        {t('web.agents.detail.storage.manage')}
                                    </button>
                                </div>
                            )}
                            {/* One line answering "how can this agent be
                                reached", with the counts that matter and a way
                                into each. */}
                            <div className='px-5 py-4'>
                                <dt className='text-caption text-subtle uppercase tracking-wider'>
                                    {t(
                                        'web.agentSettings.overview.interfaces'
                                    )}
                                </dt>
                                <dd className='text-ui mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1'>
                                    <button
                                        type='button'
                                        onClick={() => selectTab('channels')}
                                        className='text-link hover:text-fg'
                                    >
                                        {channels === null
                                            ? t(
                                                  'web.agentSettings.sections.channels'
                                              )
                                            : t(
                                                  'web.agentSettings.overview.channelCount',
                                                  {
                                                      count: channels.filter(
                                                          (channel) =>
                                                              channel.agentId ===
                                                              agent.id
                                                      ).length
                                                  }
                                              )}
                                    </button>
                                    {brokenChannels.length > 0 && (
                                        <StatusTag
                                            tone='error'
                                            label={t(
                                                'web.agentSettings.overview.channelErrors',
                                                { count: brokenChannels.length }
                                            )}
                                        />
                                    )}
                                    <span className='text-subtle'>·</span>
                                    <button
                                        type='button'
                                        onClick={() => selectTab('a2a')}
                                        className='text-link hover:text-fg'
                                    >
                                        {a2aEnabled === null
                                            ? t('web.agentSettings.sections.a2a')
                                            : t(
                                                  a2aEnabled
                                                      ? 'web.agentSettings.overview.a2aOn'
                                                      : 'web.agentSettings.overview.a2aOff'
                                              )}
                                    </button>
                                </dd>
                            </div>
                        </dl>

                        {/* The platform's own skill decides whether this agent
                            can act on Manyfold for you. Installed it looks like
                            any other row in the Skills list, so its absence —
                            and its presence — were both invisible here. */}
                        {cliSkillCard && (
                            <div>
                                <div className='workbench-kicker mb-1.5'>
                                    {t('web.agentSettings.overview.access')}
                                </div>
                                <div className='workbench-panel divide-divider divide-y overflow-hidden'>
                                    <div className='flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4'>
                                        <div className='min-w-0 flex-1'>
                                            <div className='text-ui text-fg font-medium'>
                                                {t(
                                                    'web.agentSettings.overview.accessSkill'
                                                )}
                                            </div>
                                            <div className='text-caption text-subtle mt-0.5'>
                                                {cliSkillInstalled
                                                    ? t(
                                                          'web.agentSettings.overview.accessSkillMeta'
                                                      )
                                                    : t(
                                                          'web.agentSettings.overview.accessMissing'
                                                      )}
                                            </div>
                                        </div>
                                        {cliSkillInstalled ? (
                                            <>
                                                <StatusTag
                                                    tone='success'
                                                    label={t(
                                                        'web.agentSettings.overview.accessInstalled'
                                                    )}
                                                />
                                                <button
                                                    type='button'
                                                    onClick={() =>
                                                        selectTab('skills')
                                                    }
                                                    className='text-link hover:text-fg text-ui shrink-0'
                                                >
                                                    {t(
                                                        'web.agentSettings.sections.skills'
                                                    )}
                                                    <span aria-hidden='true'>
                                                        {' '}
                                                        →
                                                    </span>
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                type='button'
                                                disabled={cliSkillInstalling}
                                                onClick={() =>
                                                    void installCliSkill()
                                                }
                                                className='workbench-button-secondary shrink-0'
                                            >
                                                {cliSkillInstalling
                                                    ? t(
                                                          'web.skills.statusInstalling'
                                                      )
                                                    : t(
                                                          'web.skills.installAction'
                                                      )}
                                            </button>
                                        )}
                                    </div>
                                    <p className='text-caption text-muted px-5 py-4'>
                                        {cliSkillInstalled ? (
                                            <>
                                                {t(
                                                    'web.agentSettings.overview.accessInstalledBlurb'
                                                )}{' '}
                                                <button
                                                    type='button'
                                                    onClick={() =>
                                                        selectTab('permissions')
                                                    }
                                                    className='text-link hover:text-fg'
                                                >
                                                    {t(
                                                        'web.agentSettings.sections.permissions'
                                                    )}
                                                    <span aria-hidden='true'>
                                                        {' '}
                                                        →
                                                    </span>
                                                </button>
                                            </>
                                        ) : (
                                            t(
                                                'web.agentSettings.overview.accessMissingBlurb'
                                            )
                                        )}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Look-it-up facts, demoted out of the cards. */}
                        <div>
                            <div className='workbench-kicker mb-1'>
                                {t('web.agentSettings.overview.details')}
                            </div>
                            <QuietRow label={t('web.agents.detail.agentId')}>
                                <span className='min-w-0 truncate font-mono'>
                                    {agent.id}
                                </span>
                                <CopyButton
                                    value={agent.id}
                                    label={t('web.agents.detail.copyAgentId')}
                                />
                            </QuietRow>
                            <QuietRow label={t('web.agents.detail.created')}>
                                {formatDate(agent.createdAt)}
                            </QuietRow>
                            {hasEndpoint && !endpointInStrip ? (
                                <QuietRow
                                    label={t('web.agents.detail.endpoint')}
                                >
                                    {endpointValue}
                                </QuietRow>
                            ) : null}
                        </div>

                        {fwError && !fwPickerOpen ? (
                            <p className='text-caption text-error'>
                                {fwError}
                            </p>
                        ) : null}

                        {(agent.framework === 'openclaw' ||
                            (agent.framework === 'hermes' &&
                                agent.runtime === 'sprites')) &&
                        agent.runtimeId ? (
                            <div className='border-divider border-t pt-5'>
                                <div className='settings-card'>
                                    <ControlRow
                                        label={
                                            agent.framework === 'openclaw'
                                                ? t(
                                                      'web.agents.detail.dashboard.controlUi'
                                                  )
                                                : t(
                                                      'web.agents.detail.dashboard.dashboard'
                                                  )
                                        }
                                        description={
                                            agent.framework === 'openclaw'
                                                ? t(
                                                      'web.agents.detail.dashboard.controlUiDescription'
                                                  )
                                                : t(
                                                      'web.agents.detail.dashboard.dashboardDescription'
                                                  )
                                        }
                                        enabled={
                                            agent.framework === 'openclaw'
                                                ? agent.controlUiEnabled
                                                : agent.dashboardEnabled
                                        }
                                        pending={
                                            dashboardToggling ||
                                            dashboardStatePending(
                                                agent.dashboardState
                                            )
                                        }
                                        pendingLabel={dashboardStatePendingLabel(
                                            agent.dashboardState,
                                            t('web.agents.detail.updating')
                                        )}
                                        onToggle={(): void => {
                                            void handleToggleDashboard()
                                        }}
                                        onOpen={handleOpenAgentDashboard}
                                        openLabel={
                                            agent.framework === 'openclaw'
                                                ? t(
                                                      'web.agents.detail.dashboard.openUi'
                                                  )
                                                : t(
                                                      'web.agents.detail.dashboard.openDashboard'
                                                  )
                                        }
                                        error={
                                            dashboardToggleError ??
                                            dashboardStateError(
                                                agent.dashboardState
                                            )
                                        }
                                    />
                                </div>
                            </div>
                        ) : null}

                        <div className='border-divider mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 border-t pt-5'>
                            <div className='min-w-0 flex-1'>
                                <div className='text-ui text-fg font-medium'>
                                    {t('web.agents.detail.delete.agentAction')}
                                </div>
                                <p className='text-caption text-subtle mt-0.5'>
                                    {t('web.agentSettings.overview.deleteBlurb')}
                                </p>
                            </div>
                            <button
                                type='button'
                                disabled={deleting}
                                onClick={() => {
                                    void deleteAgent(agent)
                                }}
                                className='workbench-button-danger shrink-0'
                            >
                                {deleting
                                    ? t('web.agents.detail.delete.deleting')
                                    : t('web.agents.detail.delete.button')}
                            </button>
                        </div>

                        {fwPickerOpen ? (
                            <ProductDialog
                                title={
                                    agent.frameworkUpgradeAvailable
                                        ? t(
                                              'web.agents.detail.framework.upgradeTitle'
                                          )
                                        : t(
                                              'web.agents.detail.framework.changeTitle'
                                          )
                                }
                                description={t(
                                    'web.agents.detail.framework.chooseVersion',
                                    {
                                        framework: frameworkLabel(
                                            agent.framework
                                        )
                                    }
                                )}
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
                                            onClick={() =>
                                                setFwPickerOpen(false)
                                            }
                                            disabled={fwUpgrading}
                                        >
                                            {t('common.cancel')}
                                        </button>
                                        <button
                                            type='button'
                                            className='workbench-button-primary'
                                            disabled={
                                                fwUpgrading ||
                                                !fwTarget ||
                                                fwTarget ===
                                                    agent.frameworkVersion
                                            }
                                            onClick={() =>
                                                void handleUpgradeFramework()
                                            }
                                        >
                                            {fwUpgrading ? (
                                                <span className='inline-flex items-center gap-2'>
                                                    <Spinner size={16} />
                                                    {fwStep
                                                        ? t(
                                                              'web.agents.detail.framework.upgradingStep',
                                                              {
                                                                  step: fwStep.replace(
                                                                      /_/g,
                                                                      ' '
                                                                  )
                                                              }
                                                          )
                                                        : t(
                                                              'web.agents.detail.framework.upgrading'
                                                          )}
                                                </span>
                                            ) : (
                                                t(
                                                    'web.agents.detail.framework.upgrade'
                                                )
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
                                        {t(
                                            'web.agents.detail.framework.versionLabel'
                                        )}
                                    </label>
                                    <WorkbenchSelect
                                        id='fw-version-select'
                                        mono
                                        value={fwTarget}
                                        disabled={fwUpgrading || !fwVersions}
                                        onChange={setFwTarget}
                                        placeholder={t('common.loadingShort')}
                                        options={(fwVersions ?? []).map(
                                            (v) => ({ value: v, label: v })
                                        )}
                                    />
                                </div>
                                {fwError ? (
                                    <div className='workbench-alert-error'>
                                        {fwError}
                                    </div>
                                ) : null}
                            </ProductDialog>
                        ) : null}
                    </section>
                )
            }
            case 'storage':
                return (
                    <section className='space-y-6'>
                        <div>
                            <header className='mb-4 flex flex-wrap items-start justify-between gap-3'>
                                <h2 className='text-h3 text-fg tracking-tight'>
                                    {t('web.agents.detail.storage.title')}
                                </h2>
                                <button
                                    type='button'
                                    disabled={storageLoading}
                                    onClick={() => {
                                        void refreshStorage()
                                    }}
                                    className='workbench-button-secondary shrink-0 gap-2'
                                >
                                    <RefreshIcon
                                        className={[
                                            'h-4 w-4',
                                            storageLoading ? 'loading-spin' : ''
                                        ].join(' ')}
                                    />
                                    {t('web.agents.detail.refresh')}
                                </button>
                            </header>
                            {storageError && (
                                <div className='workbench-alert-error mb-4'>
                                    {storageError}
                                </div>
                            )}
                            <div className='workbench-stat-grid mb-4'>
                                {(storage?.items ?? []).map((item) => (
                                    <div
                                        key={item.kind}
                                        className='workbench-stat-card'
                                    >
                                        <div className='settings-stat-label'>
                                            {item.label}
                                        </div>
                                        <div className='settings-stat-value'>
                                            {formatBytes(item.bytes)}
                                        </div>
                                        <div className='text-caption text-subtle mt-2 truncate font-mono'>
                                            {item.path ?? '-'}
                                        </div>
                                        <div className='mt-3'>
                                            <StatusPill status={item.status} />
                                        </div>
                                    </div>
                                ))}
                                {storage && (
                                    <div className='workbench-stat-card'>
                                        <div className='settings-stat-label'>
                                            {t('web.agents.detail.storage.total')}
                                        </div>
                                        <div className='settings-stat-value'>
                                            {formatBytes(storage.totalBytes)}
                                        </div>
                                        <div className='text-caption text-subtle mt-2'>
                                            {t(
                                                'web.agents.detail.storage.measured',
                                                {
                                                    date: formatDate(
                                                        storage.checkedAt
                                                    )
                                                }
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                            {!storage && !storageLoading && (
                                <div className='workbench-note'>
                                    {t(
                                        'web.agents.detail.storage.notMeasured'
                                    )}
                                </div>
                            )}
                        </div>

                        <div>
                            <div className='mb-3 flex flex-wrap items-center justify-between gap-3'>
                                <h3 className='text-ui text-fg font-medium'>
                                    {t(
                                        'web.agents.detail.storage.backupsTitle'
                                    )}
                                </h3>
                                <button
                                    type='button'
                                    disabled={backupsLoading || !!backupBusy}
                                    onClick={() => {
                                        void createBackup()
                                    }}
                                    className='workbench-button-secondary shrink-0 gap-2'
                                >
                                    <ArchiveIcon className='h-4 w-4' />
                                    {backupBusy === 'create'
                                        ? t(
                                              'web.agents.detail.storage.starting'
                                          )
                                        : t(
                                              'web.agents.detail.storage.createBackup'
                                          )}
                                </button>
                            </div>
                            {backupsError && (
                                <div className='workbench-alert-error mb-4'>
                                    {backupsError}
                                </div>
                            )}
                            {lastRestore && (
                                <div className='workbench-note mb-4'>
                                    {t(
                                        'web.agents.detail.storage.restoreStatus',
                                        {
                                            status: lastRestore.status,
                                            date: formatDate(
                                                lastRestore.startedAt
                                            )
                                        }
                                    )}
                                </div>
                            )}
                            {backups.length === 0 && !backupsLoading ? (
                                <div className='workbench-note'>
                                    {t(
                                        'web.agents.detail.storage.noBackups'
                                    )}
                                </div>
                            ) : (
                                <div className='workbench-table-shell'>
                                    <div className='overflow-x-auto'>
                                        <table className='workbench-table min-w-[860px]'>
                                            <thead className='workbench-table-head'>
                                                <tr className='text-caption text-muted uppercase tracking-wider'>
                                                    <th className='px-5 py-3 font-medium'>
                                                        {t(
                                                            'web.agents.detail.created'
                                                        )}
                                                    </th>
                                                    <th className='px-5 py-3 font-medium'>
                                                        {t(
                                                            'web.agents.detail.status'
                                                        )}
                                                    </th>
                                                    <th className='px-5 py-3 font-medium'>
                                                        {t(
                                                            'web.agents.detail.storage.archive'
                                                        )}
                                                    </th>
                                                    <th className='px-5 py-3 font-medium'>
                                                        {t(
                                                            'web.agents.detail.workspace'
                                                        )}
                                                    </th>
                                                    <th className='px-5 py-3 font-medium'>
                                                        {t(
                                                            'web.agents.detail.files.title'
                                                        )}
                                                    </th>
                                                    <th className='px-5 py-3 font-medium'>
                                                        {t(
                                                            'web.agents.detail.error'
                                                        )}
                                                    </th>
                                                    <th className='px-5 py-3 text-right font-medium'>
                                                        {t(
                                                            'web.agents.detail.actions'
                                                        )}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {backups.map((backup) => (
                                                    <tr
                                                        key={backup.id}
                                                        className='hover:bg-surface-subtle/40 border-t border-solid border-transparent shadow-[inset_0_1px_0_rgba(0,0,0,0.04)] transition-colors'
                                                    >
                                                        <td className='text-caption text-subtle whitespace-nowrap px-5 py-4 tabular-nums'>
                                                            {formatDate(
                                                                backup.createdAt
                                                            )}
                                                        </td>
                                                        <td className='whitespace-nowrap px-5 py-4'>
                                                            <BackupStatusPill
                                                                status={
                                                                    backup.status
                                                                }
                                                            />
                                                        </td>
                                                        <td className='text-caption text-muted px-5 py-4 font-mono'>
                                                            {formatBytes(
                                                                backup.archiveBytes
                                                            )}
                                                        </td>
                                                        <td className='text-caption text-muted px-5 py-4 font-mono'>
                                                            {formatBytes(
                                                                backup.workspaceBytes
                                                            )}
                                                        </td>
                                                        <td className='text-caption text-muted px-5 py-4 font-mono'>
                                                            {backup.fileCount}
                                                        </td>
                                                        <td className='text-caption text-error max-w-xs truncate px-5 py-4'>
                                                            {backup.errorMessage ??
                                                                '-'}
                                                        </td>
                                                        <td className='px-5 py-4'>
                                                            <div className='flex justify-end gap-2'>
                                                                <ShortcutTooltip
                                                                    label={t(
                                                                        'web.agents.detail.storage.restoreTitle'
                                                                    )}
                                                                >
                                                                    <button
                                                                        type='button'
                                                                        disabled={
                                                                            backup.status !==
                                                                                'succeeded' ||
                                                                            !!backupBusy
                                                                        }
                                                                        onClick={() => {
                                                                            void restoreBackup(
                                                                                backup
                                                                            )
                                                                        }}
                                                                        aria-label={t(
                                                                            'web.agents.detail.storage.restoreTitle'
                                                                        )}
                                                                        className='text-muted hover:text-fg hover:bg-surface-hover rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                                                    >
                                                                        <RestoreIcon className='h-4 w-4' />
                                                                    </button>
                                                                </ShortcutTooltip>
                                                                <ShortcutTooltip
                                                                    label={t(
                                                                        'web.agents.detail.storage.deleteTitle'
                                                                    )}
                                                                    placement='bottom-end'
                                                                >
                                                                    <button
                                                                        type='button'
                                                                        disabled={
                                                                            backup.status ===
                                                                                'running' ||
                                                                            !!backupBusy
                                                                        }
                                                                        onClick={() => {
                                                                            void deleteBackup(
                                                                                backup
                                                                            )
                                                                        }}
                                                                        aria-label={t(
                                                                            'web.agents.detail.storage.deleteTitle'
                                                                        )}
                                                                        className='text-muted hover:text-error hover:bg-danger-bg rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                                                    >
                                                                        <TrashIcon className='h-4 w-4' />
                                                                    </button>
                                                                </ShortcutTooltip>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                )
            // These panes render only when sectionPreconditionKey returned
            // null (the precondition note wins otherwise), so the old per-case
            // runtime ternaries were four hand-copies of the section gate —
            // deleted so the gate has one source (#781).
            case 'environment':
                return (
                    <AgentEnvVars
                        agent={agent}
                        onAgentUpdated={(next) => {
                            setAgent(next)
                                                    }}
                    />
                )
            case 'connections':
                return (
                    <AgentConnections
                        agent={agent}
                        onAgentUpdated={(next) => {
                            setAgent(next)
                                                    }}
                    />
                )
            case 'context':
                return <AgentContextDoc agent={agent} />
            case 'mcp':
                return (
                    <AgentMcpTools
                        agent={agent}
                        onAgentUpdated={(next) => {
                            setAgent(next)
                                                    }}
                    />
                )
            case 'skills':
                return skillsSupported ? (
                    <AgentSkills agent={agent} />
                ) : (
                    <section>
                        <h2 className='text-h3 text-fg mb-4 tracking-tight'>
                            {t('web.agents.detail.skills.title')}
                        </h2>
                        <div className='workbench-note'>
                            {isSkillFramework(agent.framework)
                                ? t('web.agents.detail.skills.needsRuntime')
                                : t('web.agents.detail.skills.unsupported', {
                                      framework: frameworkLabel(
                                          agent.framework
                                      )
                                  })}
                        </div>
                    </section>
                )
            case 'model':
                return (
                    <section>
                        <header className='mb-4 flex flex-wrap items-center gap-x-3 gap-y-2'>
                            <h2 className='text-h3 text-fg tracking-tight'>
                                {t('web.agents.detail.modelProvider.title')}
                            </h2>
                            <span className='flex-1' />
                            <EffectTimingTag timing='immediate' />
                            {credentials && !credentials.unsupported && (
                                <button
                                    type='button'
                                    onClick={() =>
                                        setCredentialsDialogOpen(true)
                                    }
                                    className='workbench-button-primary shrink-0 gap-2'
                                >
                                    {configureProviderLabel ===
                                    t(
                                        'web.agents.detail.modelProvider.configureMapping'
                                    ) ? (
                                        <SettingsIcon className='h-4 w-4' />
                                    ) : (
                                        <ProviderIcon className='h-4 w-4' />
                                    )}
                                    {configureProviderLabel}
                                </button>
                            )}
                        </header>
                        {credentialsError && (
                            <div className='workbench-alert-error mb-4'>
                                {credentialsError}
                            </div>
                        )}
                        {modelValidationMessage && (
                            <div className='workbench-alert-error mb-4'>
                                {modelValidationMessage}
                            </div>
                        )}
                        {hasModelProviderSummary && credentials ? (
                            <dl className='workbench-panel divide-divider divide-y overflow-hidden'>
                                <Info
                                    label={t('web.agents.detail.modelProvider.provider')}
                                    value={providerDisplay}
                                />
                                {usesFrameworkModelConfig &&
                                    (modelSourceSwitchable ? (
                                        <div className='grid gap-2 px-5 py-4 md:grid-cols-[11rem_minmax(0,1fr)] md:items-start'>
                                            <dt className='text-caption text-subtle pt-1 uppercase tracking-wider'>
                                                {t(
                                                    'web.agents.detail.modelProvider.source'
                                                )}
                                            </dt>
                                            <dd className='space-y-2'>
                                                <ModelSourceSwitch
                                                    source={
                                                        modelConfigView!.source
                                                    }
                                                    onSelect={(next) =>
                                                        void changeModelSource(
                                                            next
                                                        )
                                                    }
                                                />
                                                {sourceError && (
                                                    <div className='text-caption text-error'>
                                                        {sourceError}
                                                    </div>
                                                )}
                                            </dd>
                                        </div>
                                    ) : (
                                        <Info
                                            label={t(
                                                'web.agents.detail.modelProvider.source'
                                            )}
                                            value={modelSourceLabel}
                                        />
                                    ))}
                                <Info
                                    label={t('web.agents.detail.modelProvider.label')}
                                    value={modelConfigDisplay}
                                    mono
                                />
                                {usesFrameworkModelConfig && (
                                    <Info
                                        label={t(
                                            'web.agents.detail.modelProvider.supportedModels'
                                        )}
                                        value={supportedModelSummary}
                                    />
                                )}
                                <Info
                                    label={t(
                                        'web.agents.detail.modelProvider.savedProvider'
                                    )}
                                    value={
                                        credentials.savedProvider?.providerName
                                    }
                                />
                                <Info
                                    label={t('web.agents.detail.modelProvider.apiKey')}
                                    value={credentials.apiKeyMasked}
                                    mono
                                />
                                <Info
                                    label={t('web.agents.detail.modelProvider.baseUrl')}
                                    value={credentials.baseUrl}
                                    mono
                                />
                                <Info
                                    label={t('web.agents.detail.updated')}
                                    value={formatDate(credentials.updatedAt)}
                                />
                            </dl>
                        ) : credentials?.localManaged ? (
                            <div className='workbench-note'>
                                {t(
                                    'web.agents.detail.modelProvider.noPlatformProvider'
                                )}
                            </div>
                        ) : (
                            <div className='workbench-note'>
                                {t(
                                    'web.agents.detail.modelProvider.metadataUnavailable'
                                )}
                            </div>
                        )}
                    </section>
                )
            case 'permissions':
                return <AgentPermissions agentId={agent.id} />
            case 'a2a':
                return <AgentA2a agentId={agent.id} />
            case 'channels':
                return <AgentChannels agent={agent} />
            default:
                return null
        }
    }

    return (
        <div className='settings-shell'>
            <AgentSettingsRail
                agent={agent}
                activeSection={activeTab}
                onSelectSection={selectTab}
                drawerOpen={drawerOpen}
                onDrawerOpenChange={setDrawerOpen}
            />

            <div className='settings-content'>
                <div className='settings-page'>
                    <header className='settings-mobile-header lg:hidden'>
                        <button
                            type='button'
                            onClick={() => setDrawerOpen(true)}
                            aria-label={t('web.shell.menu')}
                            className='settings-mobile-menu-btn'
                        >
                            <MenuIcon className='h-4 w-4' />
                        </button>
                        <span className='text-ui text-fg min-w-0 truncate font-medium'>
                            {t(activeSectionLabelKey)}
                        </span>
                    </header>
                    {actionError && (
                        <div className='workbench-alert-error mb-5'>
                            {actionError}
                        </div>
                    )}
                    {sectionUnavailableKey ? (
                        <div className='workbench-note'>
                            {t(sectionUnavailableKey, {
                                framework: frameworkLabel(agent.framework)
                            })}
                        </div>
                    ) : (
                        renderActiveTab()
                    )}
                </div>
            </div>

            {renameOpen && (
                <RenameAgentDialog
                    agent={{ id: agent.id, name: agent.name }}
                    onClose={() => setRenameOpen(false)}
                    onRenamed={(updated) => {
                        setAgent((prev) =>
                            prev ? { ...prev, name: updated.name } : prev
                        )
                                            }}
                />
            )}
            {credentialsDialogOpen && (
                <AgentCredentialsDialog
                    agentId={agent.id}
                    agentName={agent.name}
                    framework={agent.framework}
                    onUpdated={(nextCredentials) => {
                        setCredentials(nextCredentials)
                        void refreshAgentSummary()
                    }}
                    onClose={() => setCredentialsDialogOpen(false)}
                />
            )}
            {confirmDialog}
            {deleteAgentDialog}
        </div>
    )
}

// Rendered as a sibling of AppShell: the area replaces the workspace rail with
// its own, so it cannot read the shell's context. Terminal and session tools
// stay in the conversation, matching Settings and Customize.
const AgentSettings: FC = (): ReactNode => <AgentSettingsContent />

export default AgentSettings
