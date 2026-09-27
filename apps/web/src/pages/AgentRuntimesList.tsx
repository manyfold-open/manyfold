import {
    DAEMON_DETECTABLE_FRAMEWORKS,
    frameworkCapability,
    frameworkKind,
    frameworkUpgradeAvailable,
    isDevCliVersion,
    isVersionedFramework,
    listVersionedFrameworks
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    CliVersionCatalog,
    DaemonHostSummary,
    RuntimeAvailability,
    RuntimeHostPowerState,
    RuntimeHostStatus,
    SandboxServiceSummary,
    SandboxSummary,
    SandboxTaskSummary,
    SandboxUsageBreakdown,
    UserExternalAgentProviderSummary,
    VersionedFramework
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { subscribeWorkbenchEvents } from '@/lib/workbenchEvents'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Breadcrumb, { type BreadcrumbItem } from '@/components/Breadcrumb'
import EmptyState from '@/components/EmptyState'
import { CascadeShell } from '@/components/CascadeShell'
import { CreateMenu } from '@/components/CreateMenu'
import FrameworkInstallGuide from '@/components/FrameworkInstallGuide'
import { GhostRailRows, SheenText, Spinner } from '@/components/Loading'
import { useI18n, type TFn } from '@/lib/i18n'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import OverflowMenu, { type OverflowMenuItem } from '@/components/OverflowMenu'
import RuntimeDetailPanel, {
    ControlRow,
    IdentityHeader,
    Info,
    NoticeRow,
    Section,
    StatusTag,
    type TagTone,
    daemonOnlineBadge,
    formatDate,
    monoCopyValue,
    powerStateTag,
    relative,
    runtimeAvailabilityTag,
    runtimeStatusTag
} from '@/components/RuntimeDetailPanel'
import { formatDuration } from '@/lib/usageFormat'
import { formatTime } from '@/lib/dateFormat'
import {
    BoxIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloudComputerIcon,
    CodeIcon,
    GlobeIcon,
    ListViewIcon,
    LocalDaemonIcon,
    type LucideIcon,
    RefreshIcon,
    ZapIcon
} from '@/components/icons'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ProductDialog from '@/components/ProductDialog'
import RenameDialog from '@/components/RenameDialog'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { updateRunStore, useIsTargetUpdating } from '@/lib/updateRunStore'
import {
    GroupByControl,
    type GroupByOption,
    GroupHeader,
    type Health,
    useCascadeState
} from '@/lib/cascade'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import {
    daemonPresenceLabel,
    hostKey,
    hostLifecycleLabel,
    hostLifecycleTone,
    placementLabel,
    powerStateTone
} from '@/lib/hostStatus'
import { updatesPath } from '@/lib/updateCenter'
import { NEW_RUNTIME_OPTIONS } from '@/lib/newRuntimeOptions'
import RuntimesDashboard from '@/pages/RuntimesDashboard'
import SandboxNew from '@/pages/SandboxNew'
import ExternalAgentProviders from '@/pages/Settings/ExternalAgentProviders'
import LocalDaemons from '@/pages/Settings/LocalDaemons'
import { VersionTag } from '@/components/VersionTag'

type RuntimeKind = AgentRuntimeSummary['kind']
type RuntimeStatus = AgentRuntimeSummary['status']
type RuntimeFramework = AgentRuntimeSummary['framework']
// A runtime's one word in the rail: its install state, or — once installed —
// why its machine cannot take a turn (asleep = wakeable, offline = a
// self-owned computer whose daemon is away or a machine that is not ready).
type EffStatus = RuntimeStatus | 'offline' | 'asleep'
type GroupBy = 'none' | 'kind' | 'status' | 'framework'

type Selection =
    | { kind: 'dashboard' }
    | { kind: 'page'; page: RuntimePageSegment }
    | { kind: 'host'; key: string }
    | { kind: 'runtime'; id: string }

// Reserved path segments under runtimes/*: runtime ids are prefixed
// ObjectIds, so a bare word never collides with one. The create/manage
// pages render in the detail pane so the rail stays alongside them.
const DASHBOARD_SEGMENT = 'dashboard'

const RUNTIME_PAGES = {
    sandbox: SandboxNew,
    'local-daemons': LocalDaemons,
    'external-agent-providers': ExternalAgentProviders
} as const

type RuntimePageSegment = keyof typeof RUNTIME_PAGES

const isRuntimePage = (
    value: string | undefined
): value is RuntimePageSegment => value !== undefined && value in RUNTIME_PAGES

const KIND_ORDER: RuntimeKind[] = ['sprites', 'k8s', 'daemon', 'external']

const STATUS_RANK: Record<RuntimeStatus, number> = {
    failed: 0,
    installing: 1,
    ready: 2
}

const STATUS_ORDER: EffStatus[] = [
    'failed',
    'offline',
    'installing',
    'asleep',
    'ready'
]

const EFF_DOT: Record<EffStatus, string> = {
    failed: 'bg-error',
    offline: 'bg-error',
    installing: 'bg-warning',
    asleep: 'bg-idle',
    ready: 'bg-success'
}

export const TONE_DOT: Record<TagTone, string> = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    idle: 'bg-idle'
}

const RUNTIME_DIMS = ['none', 'kind', 'status', 'framework'] as const

const GROUP_BY_OPTIONS: ReadonlyArray<GroupByOption<GroupBy>> = [
    { value: 'none', label: '', icon: ListViewIcon },
    { value: 'kind', label: '', icon: BoxIcon },
    { value: 'status', label: '', icon: ZapIcon },
    { value: 'framework', label: '', icon: CodeIcon }
]

// One machine (ADR-0036): a host with its runtimes underneath, or a single
// external runtime, which has no machine.
export interface RuntimeVM {
    key: string
    hostId: string | null
    kind: RuntimeKind
    label: string
    location: string
    runtimes: AgentRuntimeSummary[]
    agentsCount: number
    status: RuntimeStatus | null
    hostStatus: RuntimeHostStatus | null
    powerState: RuntimeHostPowerState | null
    keepAwake: boolean
    online: boolean | null
    host: DaemonHostSummary | null
    sandbox: SandboxSummary | null
}

interface HostBucket {
    key: string
    vm: RuntimeVM
    runtimes: AgentRuntimeSummary[]
}

type Group =
    | {
          mode: 'none'
          key: string
          count: number
          health: Health
          hosts: HostBucket[]
      }
    | {
          mode: 'kind'
          key: string
          label: string
          count: number
          health: Health
          hosts: HostBucket[]
      }
    | {
          mode: 'flat'
          key: string
          label: string
          logo?: RuntimeFramework
          count: number
          health: Health
          leaves: AgentRuntimeSummary[]
      }

const AVAILABILITY_EFF: Record<RuntimeAvailability, EffStatus> = {
    available: 'ready',
    wakeable: 'asleep',
    offline: 'offline',
    unavailable: 'offline'
}

const effStatus = (r: AgentRuntimeSummary): EffStatus =>
    r.status !== 'ready' ? r.status : AVAILABILITY_EFF[r.availability]

const groupHealth = (runtimes: AgentRuntimeSummary[]): Health => {
    let warn = false
    for (const r of runtimes) {
        const s = effStatus(r)
        if (s === 'failed' || s === 'offline') return 'error'
        if (s === 'installing') warn = true
    }
    return warn ? 'warn' : null
}

const vmKeyOf = (r: AgentRuntimeSummary): string =>
    r.hostId ? hostKey(r.hostId) : `external:${r.id}`

const vmLabelOf = (r: AgentRuntimeSummary, t: TFn): string => {
    if (r.hostName) return r.hostName
    if (r.kind === 'sprites') return t('web.agentRuntimesList.sandbox')
    return r.name
}

const vmLocationOf = (r: AgentRuntimeSummary): string => {
    if (r.kind === 'external') return r.endpointUrl ?? '—'
    return r.providerRefLabel ?? r.hostName ?? '—'
}

const aggregateStatus = (
    runtimes: AgentRuntimeSummary[]
): RuntimeStatus | null => {
    if (runtimes.length === 0) return null
    return runtimes.reduce<RuntimeStatus>(
        (worst, r) =>
            STATUS_RANK[r.status] < STATUS_RANK[worst] ? r.status : worst,
        runtimes[0].status
    )
}

// Every runtime on a host carries the same host facts (they are one hop from
// one row), so the machine reads them off any of its runtimes; the host and
// sandbox lists then overwrite them with their fresher copy.
const buildVMs = (
    runtimeRows: AgentRuntimeSummary[],
    hostRows: DaemonHostSummary[],
    sandboxRows: SandboxSummary[],
    t: TFn
): RuntimeVM[] => {
    const map = new Map<string, RuntimeVM>()
    for (const r of runtimeRows) {
        const key = vmKeyOf(r)
        let vm = map.get(key)
        if (!vm) {
            vm = {
                key,
                hostId: r.hostId,
                kind: r.kind,
                label: vmLabelOf(r, t),
                location: vmLocationOf(r),
                runtimes: [],
                agentsCount: 0,
                status: null,
                hostStatus: r.hostStatus,
                powerState: r.powerState,
                keepAwake: false,
                online: r.daemonOnline,
                host: null,
                sandbox: null
            }
            map.set(key, vm)
        }
        vm.runtimes.push(r)
        vm.agentsCount += r.agentsCount
    }
    for (const vm of map.values()) vm.status = aggregateStatus(vm.runtimes)
    for (const host of hostRows) {
        const key = hostKey(host.id)
        const existing = map.get(key)
        if (existing) {
            existing.label = host.name
            existing.location = host.hostname ?? host.name
            existing.hostStatus = host.status
            existing.online = host.online
            existing.host = host
        } else {
            map.set(key, {
                key,
                hostId: host.id,
                kind: 'daemon',
                label: host.name,
                location: host.hostname ?? host.name,
                runtimes: [],
                agentsCount: host.agentCount,
                status: null,
                hostStatus: host.status,
                powerState: null,
                keepAwake: false,
                online: host.online,
                host,
                sandbox: null
            })
        }
    }
    // A sandbox shows even with zero runtimes; sandbox id = host id, so an
    // existing machine is enriched in place.
    for (const sandbox of sandboxRows) {
        const key = hostKey(sandbox.id)
        const existing = map.get(key)
        if (existing) {
            existing.label = sandbox.name
            existing.location = sandbox.providerRefLabel ?? sandbox.name
            existing.hostStatus = sandbox.status
            existing.powerState = sandbox.powerState
            existing.keepAwake = sandbox.keepAwake
            existing.online = sandbox.daemonOnline
            existing.sandbox = sandbox
        } else {
            map.set(key, {
                key,
                hostId: sandbox.id,
                kind: 'sprites',
                label: sandbox.name,
                location: sandbox.providerRefLabel ?? sandbox.name,
                runtimes: [],
                agentsCount: sandbox.agentsCount,
                status: null,
                hostStatus: sandbox.status,
                powerState: sandbox.powerState,
                keepAwake: sandbox.keepAwake,
                online: sandbox.daemonOnline,
                host: null,
                sandbox
            })
        }
    }
    return [...map.values()].sort((a, b) => {
        const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
        return k !== 0 ? k : a.label.localeCompare(b.label)
    })
}

// A machine's dot is the machine, not its runtimes: a failed host is red, a
// self-owned computer is its daemon's presence, a hosted one its power state
// (a ready runtime on a suspended machine is still asleep).
const vmDotClass = (vm: RuntimeVM): string => {
    if (vm.hostStatus === 'failed') return TONE_DOT.error
    if (vm.kind === 'daemon')
        return vm.online === false
            ? TONE_DOT.error
            : vm.online
              ? TONE_DOT.success
              : TONE_DOT.idle
    if (vm.hostId !== null) return TONE_DOT[powerStateTone(vm.powerState)]
    return vm.status === null ? TONE_DOT.idle : EFF_DOT[vm.status]
}

const vmContaining = (vms: RuntimeVM[], runtimeId: string): RuntimeVM | null =>
    vms.find((v) => v.runtimes.some((r) => r.id === runtimeId)) ?? null

const HostRow: FC<{
    vm: RuntimeVM
    count: number
    open: boolean
    selected: boolean
    onToggle: () => void
    onSelect: () => void
}> = ({ vm, count, open, selected, onToggle, onSelect }): ReactNode => {
    const { t } = useI18n()
    return (
        <div
            className={[
                'flex items-center rounded-sm pl-1.5 transition-colors',
                selected ? 'bg-active-session' : 'hover:bg-rail-hover'
            ].join(' ')}
        >
            <button
                type='button'
                onClick={onToggle}
                aria-expanded={open}
                aria-label={
                    open
                        ? t('web.agentRuntimesList.collapseHost')
                        : t('web.agentRuntimesList.expandHost')
                }
                className='text-subtle hover:text-fg flex w-7 shrink-0 items-center justify-center self-stretch'
            >
                {open ? (
                    <ChevronDownIcon className='h-4 w-4' />
                ) : (
                    <ChevronRightIcon className='h-4 w-4' />
                )}
            </button>
            <button
                type='button'
                onClick={onSelect}
                aria-current={selected ? 'true' : undefined}
                className='flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 text-left'
            >
                <HostKindIcon
                    kind={vm.kind}
                    className='text-muted h-4 w-4 shrink-0'
                />
                <span className='text-ui text-fg min-w-0 flex-1 truncate font-mono'>
                    {vm.label}
                </span>
                <span
                    className={[
                        'h-2 w-2 shrink-0 rounded-full',
                        vmDotClass(vm)
                    ].join(' ')}
                />
                <ShortcutTooltip
                    label={`${count} ${count === 1 ? t('web.agentRuntimesList.runtime') : t('web.agentRuntimesList.runtimes')}`}
                    placement='bottom-end'
                    className='shrink-0'
                >
                    <span className='text-caption text-subtle tabular-nums'>
                        {count}
                    </span>
                </ShortcutTooltip>
            </button>
        </div>
    )
}

const RuntimeLeaf: FC<{
    runtime: AgentRuntimeSummary
    selected: boolean
    subLabel?: string
    indentClass: string
    showStatusDot?: boolean
    onSelect: () => void
}> = ({
    runtime: r,
    selected,
    subLabel,
    indentClass,
    showStatusDot = true,
    onSelect
}): ReactNode => (
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
        <FrameworkLogo framework={r.framework} size={18} />
        <span className='min-w-0 flex-1'>
            <span className='text-ui text-fg block truncate font-mono'>
                {r.name}
            </span>
            {subLabel && (
                <span className='text-caption text-subtle block truncate'>
                    {subLabel}
                </span>
            )}
        </span>
        {showStatusDot && (
            <span
                className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    EFF_DOT[effStatus(r)]
                ].join(' ')}
            />
        )}
        <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0 lg:hidden' />
    </button>
)

// A provisioned runtime on a host — the single home for "what runs here".
// Navigates into the runtime detail page (where version management lives);
// self-owned machines keep the "Update…" guide inline because their runtime
// page has no host-level install affordance.
const HostRuntimeRow: FC<{
    runtime: AgentRuntimeSummary
    latest: string | null
    onSelect: () => void
}> = ({ runtime: r, latest, onSelect }): ReactNode => {
    const { t } = useI18n()
    const upgradeAvailable = frameworkUpgradeAvailable(
        r.frameworkVersion,
        latest
    )
    const guideFramework = isVersionedFramework(r.framework)
        ? r.framework
        : null
    return (
        <div className='border-divider/60 hover:bg-surface-hover flex w-full items-center gap-3 border-t px-4 py-3 transition-colors first:border-t-0'>
            <button
                type='button'
                onClick={onSelect}
                className='flex min-w-0 flex-1 items-center gap-3 text-left'
            >
                <span className='inline-flex shrink-0'>
                    <FrameworkLogo framework={r.framework} size={28} />
                </span>
                <span className='min-w-0 flex-1'>
                    <span className='flex flex-wrap items-center gap-2'>
                        <span className='settings-card-label'>
                            {frameworkLabel(r.framework)}
                        </span>
                        {/* Not a link: the whole row is already a press
                            target, and the runtime page it opens carries a
                            linked pill of its own. */}
                        <VersionTag
                            label={
                                r.frameworkVersion
                                    ? `v${r.frameworkVersion}`
                                    : t('web.runtimeDetail.versionPending')
                            }
                            mono={!!r.frameworkVersion}
                            latest={upgradeAvailable ? latest : null}
                            kind='framework'
                            linked={false}
                        />
                        {runtimeAvailabilityTag(r)}
                    </span>
                    <span className='settings-card-copy block truncate'>
                        <span className='font-mono'>{r.name}</span>
                        <span>
                            {' '}
                            · {r.agentsCount}{' '}
                            {r.agentsCount === 1
                                ? t('web.agentRuntimesList.runtime')
                                : t('web.agentRuntimesList.runtimes')}
                        </span>
                    </span>
                </span>
            </button>
            {r.kind === 'daemon' && guideFramework && (
                <Link
                    to={updatesPath('framework')}
                    className='text-ui shadow-ring-light bg-surface hover:bg-surface-hover shrink-0 rounded-md px-3 py-1.5 font-medium transition-colors'
                >
                    {t('web.agentRuntimesList.update')}…
                </Link>
            )}
            <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0' />
        </div>
    )
}

const HOST_ICON: Record<RuntimeKind, LucideIcon> = {
    daemon: LocalDaemonIcon,
    sprites: BoxIcon,
    k8s: CloudComputerIcon,
    external: GlobeIcon
}

const HostKindIcon: FC<{ kind: RuntimeKind; className?: string }> = ({
    kind,
    className
}): ReactNode => {
    const Icon = HOST_ICON[kind]
    return (
        <Icon
            role='img'
            aria-label={placementLabel(kind)}
            className={className}
        />
    )
}

// A framework NOT yet provisioned on this host. Any framework can be provisioned
// into a sandbox in place, with one exception: a sprite exposes a single public
// port, so it hosts at most one service framework — `serviceOccupant` names
// the one already there. Self-owned machines are
// detect-only, so we point at the official install guide instead. Empty version
// selection = latest. Provisioned frameworks live in "Runtimes".
const AvailableFrameworkRow: FC<{
    framework: VersionedFramework
    kind: RuntimeKind
    installed: boolean
    version: string | null
    versions: string[]
    latest: string | null
    serviceOccupant: AgentFramework | null
    provisionHostId: string | null
    onGuide?: (
        framework: VersionedFramework,
        mode: 'install' | 'upgrade'
    ) => void
}> = ({
    framework,
    kind,
    installed,
    version,
    versions,
    latest,
    serviceOccupant,
    provisionHostId,
    onGuide
}): ReactNode => {
    const { t } = useI18n()
    const [ver, setVer] = useState('')
    const isDaemon = kind === 'daemon'
    const serviceSlotTaken =
        frameworkCapability(framework).kind === 'service' &&
        serviceOccupant !== null &&
        serviceOccupant !== framework
    const target = ver || latest || ''

    let action: ReactNode
    if (isDaemon) {
        // Self-owned machines are detect-only: we never install/upgrade CLIs on
        // someone's own computer. Point them at the official install guide
        // instead; the daemon picks the CLI up automatically once it's on PATH.
        // Updating an already-installed one is a reminder like any other, so it
        // goes through the Update Center rather than opening the guide here.
        action = installed ? (
            <Link
                to={updatesPath('framework')}
                className='text-ui shadow-ring-light bg-surface hover:bg-surface-hover shrink-0 rounded-md px-3 py-1.5 font-medium transition-colors'
            >
                {`${t('web.agentRuntimesList.update')}…`}
            </Link>
        ) : (
            <button
                type='button'
                onClick={(): void => onGuide?.(framework, 'install')}
                className='text-ui shadow-ring-light bg-surface hover:bg-surface-hover shrink-0 rounded-md px-3 py-1.5 font-medium transition-colors'
            >
                {`${t('web.agentRuntimesList.install')}…`}
            </button>
        )
    } else {
        const verQuery = target ? `&version=${encodeURIComponent(target)}` : ''
        // Provision into this sandbox; without a host id (or when the sandbox's
        // one service slot is taken) fall back to plain agent creation on a new VM.
        const href = serviceSlotTaken
            ? null
            : provisionHostId
              ? `/agents/new?hostId=${encodeURIComponent(provisionHostId)}&framework=${framework}${verQuery}`
              : `/agents/new?framework=${framework}${verQuery}`
        action = (
            <>
                {versions.length > 0 && (
                    <WorkbenchSelect
                        size='sm'
                        mono
                        className='w-44 shrink-0'
                        ariaLabel={`${frameworkLabel(framework)} version`}
                        value={ver}
                        onChange={setVer}
                        options={[
                            {
                                value: '',
                                label: latest
                                    ? `${t('web.agentRuntimesList.latest')} (${latest})`
                                    : t('web.agentRuntimesList.latest')
                            },
                            ...versions.map((v) => ({ value: v, label: v }))
                        ]}
                    />
                )}
                {href ? (
                    <Link
                        to={href}
                        className='text-ui shadow-ring-light bg-surface hover:bg-surface-hover shrink-0 rounded-md px-3 py-1.5 font-medium transition-colors'
                    >
                        {t('web.agentRuntimesList.provision')}
                    </Link>
                ) : (
                    <span className='text-caption text-subtle shrink-0'>
                        {serviceOccupant
                            ? t('web.agentRuntimesList.alreadyRuns', {
                                  framework: frameworkLabel(serviceOccupant)
                              })
                            : t('web.agentRuntimesList.unavailableAction')}
                    </span>
                )}
            </>
        )
    }

    const versionChip = version
        ? `v${version}`
        : installed
          ? t('web.agentRuntimesList.versionUnknown').toLowerCase()
          : t('web.agentRuntimesList.notInstalled').toLowerCase()
    const stateCopy = installed
        ? isDaemon
            ? t('web.agentRuntimesList.installedNotProvisioned')
            : t('web.agentRuntimesList.preinstalledReady')
        : isDaemon
          ? t('web.agentRuntimesList.notInstalled')
          : serviceSlotTaken
            ? t('web.agentRuntimesList.needsSandbox')
            : t('web.agentRuntimesList.notProvisioned')

    return (
        <div className='border-divider/60 flex items-center gap-3 border-t px-4 py-3 first:border-t-0'>
            <span className='inline-flex shrink-0'>
                <FrameworkLogo framework={framework} size={28} />
            </span>
            <span className='min-w-0 flex-1'>
                <span className='flex flex-wrap items-center gap-2'>
                    <span className='settings-card-label'>
                        {frameworkLabel(framework)}
                    </span>
                    <span className={['tag tag-neutral font-mono'].join(' ')}>
                        {versionChip}
                    </span>
                </span>
                <span className='settings-card-copy block'>{stateCopy}</span>
            </span>
            <span className='flex shrink-0 items-center gap-2'>{action}</span>
        </div>
    )
}

// mf CLI version, on the shared version-management grammar: mono version
// tag + latest hint + a quiet "change version…" link that opens the picker
// dialog. The dialog is the confirmation surface — its description carries
// herdr's version on a machine or inside a sandbox (ADR-0031): one target,
// the newest release, so a pill and one action are the whole control. An
// absent herdr reads as an install.
const HerdrVersionValue: FC<{
    current: string | null
    latest: string | null
    updateAvailable: boolean
    busy: boolean
    onUpgrade?: () => void
}> = ({ current, latest, updateAvailable, busy, onUpgrade }): ReactNode => {
    const { t } = useI18n()
    const target = latest && updateAvailable ? latest : null
    return (
        <span className='flex flex-wrap items-center gap-2'>
            <VersionTag
                label={
                    current
                        ? `v${current}`
                        : t('web.agentRuntimesList.notInstalled')
                }
                mono={!!current}
                latest={target}
                kind='herdr'
            />
            {latest && !target && (
                <span className='text-caption text-subtle'>
                    {t('web.agentRuntimesList.latest')}
                </span>
            )}
            {target && onUpgrade ? (
                busy ? (
                    <span className='text-caption text-muted inline-flex items-center gap-1.5'>
                        <Spinner size={12} />
                        {t('web.agentRuntimesList.upgrading')}
                    </span>
                ) : (
                    <button
                        type='button'
                        onClick={(): void => onUpgrade()}
                        className='text-caption text-subtle hover:text-fg transition-colors'
                    >
                        {current
                            ? t('web.updates.badgeCta', { version: `v${target}` })
                            : t('web.agentRuntimesList.installVersion', {
                                  version: `v${target}`
                              })}
                    </button>
                )
            ) : null}
        </span>
    )
}

// the restart warning, so there is no separate confirm step. Empty
// selection = latest. Used for both daemon hosts and sandboxes.
const CliVersionValue: FC<{
    current: string | null
    latest: string | null
    updateAvailable: boolean
    stable: string[]
    dev: string[]
    targetName: string
    restarts: boolean
    busy: boolean
    onUpgrade: (targetVersion: string | undefined) => void
}> = ({
    current,
    latest,
    updateAvailable,
    stable,
    dev,
    targetName,
    restarts,
    busy,
    onUpgrade
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const [sel, setSel] = useState('')
    // An unreported version is an update too: the upgrade installs the first
    // one, so the pill announces it rather than sitting neutral on "Unknown".
    const updateTarget = latest && (updateAvailable || !current) ? latest : null
    return (
        <span className='flex flex-wrap items-center gap-2'>
            <VersionTag
                label={
                    current
                        ? `v${current}`
                        : t('web.agentRuntimesList.versionUnknown')
                }
                mono={!!current}
                latest={updateTarget}
                kind='cli'
                hint={
                    current
                        ? undefined
                        : t('web.agentRuntimesList.noCliVersion')
                }
            />
            {latest && !updateTarget && (
                <span className='text-caption text-subtle'>
                    {t('web.agentRuntimesList.latest')}
                </span>
            )}
            {busy ? (
                <span className='text-caption text-muted inline-flex items-center gap-1.5'>
                    <Spinner size={12} />
                    {t('web.agentRuntimesList.upgrading')}
                </span>
            ) : (
                <button
                    type='button'
                    onClick={(): void => setOpen(true)}
                    className='text-caption text-subtle hover:text-fg transition-colors'
                >
                    {t('web.runtimeDetail.changeVersion')}…
                </button>
            )}
            {open && (
                <ProductDialog
                    title={t('web.agentRuntimesList.changeCliVersion')}
                    description={
                        restarts
                            ? t('web.agentRuntimesList.versionPickerDaemon', {
                                  name: targetName
                              })
                            : t('web.agentRuntimesList.versionPickerSandbox', {
                                  name: targetName
                              })
                    }
                    size='sm'
                    onClose={() => setOpen(false)}
                    bodyClassName='flex flex-col gap-4'
                    footer={
                        <>
                            <button
                                type='button'
                                className='workbench-button-secondary'
                                onClick={() => setOpen(false)}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                onClick={(): void => {
                                    onUpgrade(sel || undefined)
                                    setOpen(false)
                                }}
                                disabled={busy}
                            >
                                {t('web.agentRuntimesList.upgrade')}
                            </button>
                        </>
                    }
                >
                    <div>
                        <label
                            htmlFor='cli-version-select'
                            className='text-caption text-subtle mb-1.5 block'
                        >
                            {t('web.runtimeDetail.version')}
                        </label>
                        <WorkbenchSelect
                            id='cli-version-select'
                            mono
                            ariaLabel={t(
                                'web.agentRuntimesList.changeCliVersion'
                            )}
                            value={sel}
                            disabled={busy}
                            onChange={setSel}
                            options={[
                                {
                                    value: '',
                                    label: latest
                                        ? t(
                                              'web.agentRuntimesList.latestVersion',
                                              { version: latest }
                                          )
                                        : t('web.agentRuntimesList.latest')
                                },
                                ...stable.map((v) => ({
                                    value: v,
                                    label: v,
                                    group: t('web.agentRuntimesList.stable')
                                })),
                                ...dev.map((v) => ({
                                    value: v,
                                    label: v,
                                    group: t('web.agentRuntimesList.staging')
                                }))
                            ]}
                        />
                    </div>
                </ProductDialog>
            )}
        </span>
    )
}

const SERVICE_TONE: Record<SandboxServiceSummary['status'], TagTone> = {
    running: 'success',
    starting: 'warning',
    stopping: 'warning',
    stopped: 'idle',
    failed: 'error'
}

const serviceStatusLabel = (
    status: SandboxServiceSummary['status'],
    t: TFn
): string =>
    t(
        status === 'running'
            ? 'web.agentRuntimesList.serviceRunning'
            : status === 'starting'
              ? 'web.agentRuntimesList.serviceStarting'
              : status === 'stopping'
                ? 'web.agentRuntimesList.serviceStopping'
                : status === 'stopped'
                  ? 'web.agentRuntimesList.serviceStopped'
                  : 'web.agentRuntimesList.serviceFailed'
    )

const ServiceRow: FC<{
    service: SandboxServiceSummary
    deleting: boolean
    onDelete: () => void
}> = ({ service, deleting, onDelete }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='border-divider/60 flex items-center gap-3 border-t px-4 py-3 first:border-t-0'>
            <span className='min-w-0 flex-1'>
                <span className='flex flex-wrap items-center gap-2'>
                    <span className='settings-card-label'>{service.name}</span>
                    {service.httpPort !== null && (
                        <span className='tag tag-neutral font-mono'>
                            :{service.httpPort}
                        </span>
                    )}
                    <StatusTag
                        tone={SERVICE_TONE[service.status]}
                        label={serviceStatusLabel(service.status, t)}
                        pulse={service.status === 'running'}
                    />
                </span>
                <span className='settings-card-copy block truncate font-mono'>
                    {service.command}
                </span>
            </span>
            {service.managed ? (
                <ShortcutTooltip
                    label={t('web.agentRuntimesList.managedBy')}
                    placement='bottom-end'
                    className='shrink-0'
                >
                    <span className='text-caption text-muted'>
                        {t('web.agentRuntimesList.managed')}
                    </span>
                </ShortcutTooltip>
            ) : (
                <button
                    type='button'
                    disabled={deleting}
                    onClick={onDelete}
                    className='workbench-button-danger shrink-0'
                >
                    {deleting
                        ? t('web.agentRuntimesList.deleting')
                        : t('web.agentRuntimesList.delete')}
                </button>
            )}
        </div>
    )
}

const TaskRow: FC<{
    task: SandboxTaskSummary
    deleting: boolean
    onDelete: () => void
}> = ({ task, deleting, onDelete }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='border-divider/60 flex items-center gap-3 border-t px-4 py-3 first:border-t-0'>
            <span className='min-w-0 flex-1'>
                <span className='flex flex-wrap items-center gap-2'>
                    <span className='settings-card-label font-mono'>
                        {task.name}
                    </span>
                    {task.keepAlive && (
                        <span className='tag tag-neutral'>
                            {t('web.hostStatus.keepAwake.on')}
                        </span>
                    )}
                </span>
                {task.expiresAt && (
                    <span className='settings-card-copy block tabular-nums'>
                        {t('web.agentRuntimesList.leaseExpires', {
                            time: formatTime(task.expiresAt) ?? ''
                        })}
                    </span>
                )}
            </span>
            <StatusTag
                tone='success'
                label={t('web.agentRuntimesList.active')}
                pulse
            />
            {task.keepAlive ? (
                <span
                    className='text-caption text-muted shrink-0'
                    title={t('web.agentRuntimesList.keepAliveLease')}
                >
                    {t('web.agentRuntimesList.managed')}
                </span>
            ) : (
                <button
                    type='button'
                    disabled={deleting}
                    onClick={onDelete}
                    className='workbench-button-danger shrink-0'
                >
                    {deleting
                        ? t('web.agentRuntimesList.deleting')
                        : t('web.agentRuntimesList.delete')}
                </button>
            )}
        </div>
    )
}

const HostDetailPanel: FC<{
    vm: RuntimeVM
    onSelectRuntime: (runtimeId: string) => void
    onDetect?: (hostId: string) => void
    detecting?: boolean
    onRefreshStatus?: (hostId: string) => Promise<void>
    catalog: Record<string, { versions: string[]; latest: string | null }>
    cliCatalog: CliVersionCatalog
    onUpgradeCli?: (
        hostId: string,
        targetVersion?: string
    ) => void | Promise<void>
    upgradingCli?: boolean
    onUpgradeSandboxCli?: (
        hostId: string,
        targetVersion?: string
    ) => void | Promise<void>
    upgradingSandboxCli?: boolean
    onUpgradeHerdr?: (hostId: string) => void | Promise<void>
    upgradingHerdr?: boolean
    onUpgradeSandboxHerdr?: (hostId: string) => void | Promise<void>
    upgradingSandboxHerdr?: boolean
    onDelete?: (hostId: string) => void | Promise<void>
    onStop?: (hostId: string) => Promise<void>
    onRename?: (name: string) => Promise<void>
    onToggleTerminal?: (
        hostId: string,
        enabled: boolean
    ) => void | Promise<void>
    togglingTerminal?: boolean
    // The host's keep-awake switch (ADR-0036): keeps the machine running.
    onToggleKeepAwake?: (
        hostId: string,
        enabled: boolean
    ) => void | Promise<void>
    togglingKeepAwake?: boolean
    onToggleTerminalModelCredentials?: (
        hostId: string,
        enabled: boolean
    ) => void | Promise<void>
    togglingTerminalModelCredentials?: boolean
    onLoadServices?: (hostId: string) => Promise<SandboxServiceSummary[]>
    onDeleteService?: (hostId: string, name: string) => Promise<void>
    onLoadTasks?: (hostId: string) => Promise<SandboxTaskSummary[]>
    onDeleteTask?: (hostId: string, name: string) => Promise<void>
}> = ({
    vm,
    onSelectRuntime,
    onDetect,
    detecting,
    onRefreshStatus,
    catalog,
    cliCatalog,
    onUpgradeCli,
    upgradingCli,
    onUpgradeSandboxCli,
    upgradingSandboxCli,
    onUpgradeHerdr,
    upgradingHerdr,
    onUpgradeSandboxHerdr,
    upgradingSandboxHerdr,
    onDelete,
    onStop,
    onRename,
    onToggleTerminal,
    togglingTerminal,
    onToggleKeepAwake,
    togglingKeepAwake,
    onToggleTerminalModelCredentials,
    togglingTerminalModelCredentials,
    onLoadServices,
    onDeleteService,
    onLoadTasks,
    onDeleteTask
}): ReactNode => {
    const { t } = useI18n()
    const navigate = useNavigate()
    const [deleting, setDeleting] = useState(false)
    const [stopping, setStopping] = useState(false)
    const [refreshingStatus, setRefreshingStatus] = useState(false)
    const [renameOpen, setRenameOpen] = useState(false)
    const { confirm, confirmDialog } = useProductConfirm()
    const [guide, setGuide] = useState<{
        framework: VersionedFramework
        mode: 'install' | 'upgrade'
    } | null>(null)
    const [services, setServices] = useState<SandboxServiceSummary[] | null>(
        null
    )
    const [tasks, setTasks] = useState<SandboxTaskSummary[] | null>(null)
    const [activityLoading, setActivityLoading] = useState(false)
    const [servicesError, setServicesError] = useState<string | null>(null)
    const [tasksError, setTasksError] = useState<string | null>(null)
    const [deletingService, setDeletingService] = useState<string | null>(null)
    const [deletingTask, setDeletingTask] = useState<string | null>(null)
    const host = vm.host
    const sandbox = vm.sandbox
    const serviceHostId = sandbox?.id ?? null
    useEffect(() => {
        if (!serviceHostId || !onLoadServices || !onLoadTasks) {
            setServices(null)
            setTasks(null)
            return
        }
        let cancelled = false
        setActivityLoading(true)
        setServicesError(null)
        setTasksError(null)
        Promise.allSettled([
            onLoadServices(serviceHostId),
            onLoadTasks(serviceHostId)
        ])
            .then(([s, taskResult]) => {
                if (cancelled) return
                if (s.status === 'fulfilled') setServices(s.value)
                else
                    setServicesError(
                        (s.reason as Error)?.message ?? t('common.unknown')
                    )
                if (taskResult.status === 'fulfilled')
                    setTasks(taskResult.value)
                else
                    setTasksError(
                        (taskResult.reason as Error)?.message ??
                            t('common.unknown')
                    )
            })
            .finally(() => {
                if (!cancelled) setActivityLoading(false)
            })
        return (): void => {
            cancelled = true
        }
    }, [serviceHostId, onLoadServices, onLoadTasks, t])
    const detected = host?.detectedFrameworks ?? []
    const detectedByFramework = new Map<string, string | null>(
        (vm.sandbox?.detectedFrameworks ?? []).map((d) => [
            d.framework,
            d.version
        ])
    )
    const Icon = HOST_ICON[vm.kind]
    // Every sprite image ships claude-code / codex / gemini-cli pre-installed, and
    // a sandbox can host any framework it hasn't provisioned yet. Surface those as
    // one-click "provision here" targets.
    const sandboxHostId = vm.sandbox?.id ?? vm.runtimes[0]?.hostId ?? null
    // Per-framework state for the "Available frameworks" section: whether the
    // CLI is installed on the host and its detected version. Sprites pre-install
    // every coding CLI; daemons report installs via detection. Provisioned
    // frameworks are excluded up front (they live in the Runtimes list).
    const frameworkAvailability = (
        f: VersionedFramework
    ): { installed: boolean; version: string | null } => {
        const detectedVersion = host
            ? (detected.find((d) => d.framework === f)?.version ?? null)
            : (detectedByFramework.get(f) ?? null)
        const installed = host
            ? detected.some((d) => d.framework === f)
            : frameworkCapability(f).kind === 'coding' ||
              detectedByFramework.has(f)
        return { installed, version: detectedVersion }
    }
    // The one service framework already live on this sandbox, if any — it owns the
    // sprite's single public port, so no second one can join.
    const serviceOccupant =
        vm.runtimes.find(
            (r) =>
                frameworkKind(r.framework) === 'service' &&
                r.status !== 'failed'
        )?.framework ?? null
    // A daemon lists every framework it can detect + run (5); a sandbox lists
    // every framework that runs on a sprite (every versioned one — the coding
    // CLIs plus the service frameworks), so nothing provisioned stays hidden.
    const frameworkList: VersionedFramework[] = host
        ? DAEMON_DETECTABLE_FRAMEWORKS
        : [...listVersionedFrameworks()]
    const availableFrameworks = frameworkList.filter(
        (f) => !vm.runtimes.some((r) => r.framework === f)
    )
    // The machine's badge: lifecycle while it is not ready; then its daemon's
    // presence for a self-owned computer and its power state for a hosted
    // one. A sandbox's power badge doubles as its refresh control.
    const refreshStatus = (): void => {
        if (!onRefreshStatus || !sandboxHostId || refreshingStatus) return
        setRefreshingStatus(true)
        void Promise.resolve(onRefreshStatus(sandboxHostId))
            .catch(() => undefined)
            .finally(() => setRefreshingStatus(false))
    }
    const badge =
        vm.hostStatus !== null && vm.hostStatus !== 'ready' ? (
            <StatusTag
                tone={hostLifecycleTone(vm.hostStatus)}
                label={hostLifecycleLabel(vm.hostStatus)}
                pulse={
                    vm.hostStatus === 'provisioning' ||
                    vm.hostStatus === 'deleting'
                }
            />
        ) : vm.kind === 'daemon' ? (
            daemonOnlineBadge(vm.online)
        ) : vm.kind === 'sprites' && sandbox ? (
            <span className='flex items-center gap-1.5'>
                {powerStateTag(vm.powerState)}
                {onRefreshStatus && sandboxHostId && (
                    <ShortcutTooltip
                        label={t('web.agentRuntimesList.refreshStatus')}
                        className='shrink-0'
                    >
                        <button
                            type='button'
                            onClick={refreshStatus}
                            disabled={refreshingStatus}
                            aria-label={t(
                                'web.agentRuntimesList.refreshStatus'
                            )}
                            className='text-subtle hover:bg-surface-hover inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                        >
                            <RefreshIcon
                                className={[
                                    'h-3.5 w-3.5',
                                    refreshingStatus ? 'loading-spin' : ''
                                ].join(' ')}
                            />
                        </button>
                    </ShortcutTooltip>
                )}
            </span>
        ) : vm.hostId !== null ? (
            powerStateTag(vm.powerState)
        ) : vm.status ? (
            runtimeStatusTag(vm.status)
        ) : null
    // mf CLI version property-row value. When the daemon supports remote upgrade
    // we offer a version picker constrained to its OWN channel (a daemon can only
    // self-update from the channel it was installed from). Otherwise it's a
    // read-only hint (the daemon is too old / not autostart-managed).
    const renderCliVersionValue = (h: DaemonHostSummary): ReactNode => {
        if (h.canRemoteUpgrade && onUpgradeCli) {
            // A daemon normally upgrades only within its own channel; in
            // local/staging a capable daemon can cross channels, so offer both.
            const onDev = isDevCliVersion(h.cliVersion)
            const cross = h.canCrossChannelUpgrade
            return (
                <CliVersionValue
                    current={h.cliVersion}
                    latest={h.latestCliVersion}
                    updateAvailable={h.updateAvailable}
                    stable={cross || !onDev ? cliCatalog.stable : []}
                    dev={cross || onDev ? cliCatalog.dev : []}
                    targetName={vm.label}
                    restarts
                    busy={Boolean(upgradingCli)}
                    onUpgrade={(target) => void onUpgradeCli(h.id, target)}
                />
            )
        }
        const remoteUpdate =
            h.updateAvailable && h.latestCliVersion ? h.latestCliVersion : null
        return (
            <span className='flex flex-wrap items-center gap-2'>
                {/* Still a link: this machine cannot be driven from here, and
                    the Update Center is where that gets said in full — so the
                    hint takes over the pill's hover label rather than wrapping
                    it, since two nested tooltips would both open at once. */}
                <VersionTag
                    label={
                        h.cliVersion
                            ? `v${h.cliVersion}`
                            : t('web.agentRuntimesList.versionUnknown')
                    }
                    mono={!!h.cliVersion}
                    latest={remoteUpdate}
                    kind='cli'
                    hint={
                        remoteUpdate
                            ? t('web.agentRuntimesList.remoteUpgradeHint')
                            : h.cliVersion
                              ? undefined
                              : t('web.agentRuntimesList.noCliVersionShort')
                    }
                />
                {!remoteUpdate && h.latestCliVersion && (
                    <span className='text-subtle text-caption'>
                        {t('web.agentRuntimesList.latest')}
                    </span>
                )}
            </span>
        )
    }
    // Sandbox mf CLI version row: the sprite has no daemon to self-update, so the
    // upgrade re-installs the chosen channel binary over ~/.local/bin/mf (no
    // restart). The picker is always offered (the platform controls the install).
    const renderSandboxCliValue = (sb: SandboxSummary): ReactNode => {
        if (onUpgradeSandboxCli)
            return (
                <CliVersionValue
                    current={sb.cliVersion}
                    latest={sb.latestCliVersion}
                    updateAvailable={sb.cliUpdateAvailable}
                    stable={cliCatalog.stable}
                    dev={cliCatalog.dev}
                    targetName={sb.name}
                    restarts={false}
                    busy={Boolean(upgradingSandboxCli)}
                    onUpgrade={(target) =>
                        void onUpgradeSandboxCli(sb.id, target)
                    }
                />
            )
        return (
            <span className='flex flex-wrap items-center gap-2'>
                <VersionTag
                    label={
                        sb.cliVersion
                            ? `v${sb.cliVersion}`
                            : t('web.agentRuntimesList.versionUnknown')
                    }
                    mono={!!sb.cliVersion}
                    latest={sb.cliUpdateAvailable ? sb.latestCliVersion : null}
                    kind='cli'
                />
                {!sb.cliUpdateAvailable && sb.latestCliVersion && (
                    <span className='text-subtle text-caption'>
                        {t('web.agentRuntimesList.latest')}
                    </span>
                )}
            </span>
        )
    }
    const handleStopSandboxClick = async (): Promise<void> => {
        if (!sandboxHostId || !onStop) return
        if (
            !(await confirm({
                title: t('web.agentRuntimesList.stopSandbox'),
                description: t('web.agentRuntimesList.stopDescription', {
                    name: vm.label
                }),
                confirmLabel: t('web.agentRuntimesList.stop'),
                tone: 'danger'
            }))
        )
            return
        setStopping(true)
        void onStop(sandboxHostId)
            .then(async () => {
                if (onLoadServices)
                    setServices(
                        await onLoadServices(sandboxHostId).catch(() => null)
                    )
                if (onLoadTasks)
                    setTasks(await onLoadTasks(sandboxHostId).catch(() => null))
            })
            .finally(() => setStopping(false))
    }
    const handleDeleteSandboxClick = async (): Promise<void> => {
        if (!sandboxHostId || !onDelete) return
        if (
            !(await confirm({
                title: t('web.agentRuntimesList.deleteSandbox'),
                description: t(
                    'web.agentRuntimesList.deleteSandboxDescription',
                    { name: vm.label }
                ),
                confirmLabel: t('web.agentRuntimesList.delete'),
                tone: 'danger'
            }))
        )
            return
        setDeleting(true)
        void Promise.resolve(onDelete(sandboxHostId)).finally(() =>
            setDeleting(false)
        )
    }
    const menuItems: OverflowMenuItem[] = []
    if (onRename)
        menuItems.push({
            label: t('web.agentRuntimesList.rename'),
            onSelect: () => setRenameOpen(true)
        })
    if (vm.kind === 'sprites' && sandboxHostId && onStop)
        menuItems.push({
            label: stopping
                ? t('web.agentRuntimesList.stopping')
                : t('web.agentRuntimesList.stopSandbox'),
            disabled: stopping,
            onSelect: () => void handleStopSandboxClick()
        })
    // The API refuses (409) while agents still live on the machine; its
    // runtimes go with it.
    if (vm.kind === 'sprites' && sandboxHostId && onDelete)
        menuItems.push({
            label: deleting
                ? t('web.agentRuntimesList.deleting')
                : t('web.agentRuntimesList.deleteSandbox'),
            danger: true,
            disabled: deleting || vm.agentsCount > 0,
            disabledReason:
                vm.agentsCount > 0
                    ? t('web.agentRuntimesList.removingAgents')
                    : undefined,
            onSelect: () => void handleDeleteSandboxClick()
        })
    return (
        <div className='space-y-8'>
            {confirmDialog}
            <IdentityHeader
                icon={<Icon className='text-muted h-6 w-6' />}
                title={vm.label}
                badge={badge}
                subtitle={
                    <>
                        <span className='text-ui text-fg font-medium'>
                            {placementLabel(vm.kind)}
                        </span>
                        {vm.keepAwake && (
                            <span className='tag tag-neutral'>
                                {t('web.hostStatus.keepAwake.on')}
                            </span>
                        )}
                        {sandbox && sandbox.activeSecondsThisPeriod > 0 && (
                            <>
                                <span className='text-subtle'>·</span>
                                <span className='text-caption text-muted'>
                                    {t('web.agentRuntimesList.activePeriod', {
                                        duration: formatDuration(
                                            sandbox.activeSecondsThisPeriod *
                                                1000
                                        )
                                    })}
                                </span>
                            </>
                        )}
                    </>
                }
                actions={
                    menuItems.length > 0 ? (
                        <OverflowMenu
                            ariaLabel={t('web.agentRuntimesList.hostActions')}
                            items={menuItems}
                        />
                    ) : undefined
                }
            />

            {host && vm.online === false && (
                <NoticeRow
                    tone='danger'
                    title={t('web.agentRuntimesList.machineOffline')}
                    detail={
                        host.lastSeenAt
                            ? t('web.agentRuntimesList.machineOfflineSeen', {
                                  time: relative(host.lastSeenAt)
                              })
                            : t('web.agentRuntimesList.machineOfflineDetail')
                    }
                />
            )}
            {vm.hostStatus === 'failed' && (
                <NoticeRow
                    tone='danger'
                    title={t('web.agentRuntimesList.hostFailed')}
                    detail={sandbox?.failureReason ?? undefined}
                />
            )}
            {(vm.hostStatus === 'provisioning' ||
                vm.hostStatus === 'deleting') && (
                <NoticeRow
                    title={t(
                        vm.hostStatus === 'provisioning'
                            ? 'web.agentRuntimesList.hostProvisioning'
                            : 'web.agentRuntimesList.hostDeleting'
                    )}
                />
            )}
            {(stopping || deleting) && (
                <NoticeRow
                    title={
                        stopping
                            ? t('web.agentRuntimesList.stoppingSandbox')
                            : t('web.agentRuntimesList.deletingSandbox')
                    }
                />
            )}
            {/* No CLI-upgrade strip for the host or the sandbox: the mf CLI
                property row below already shows the installed version with a
                badge beside it, so a strip here said the same thing twice and
                pushed the rest of the panel down. */}

            <Section
                title={t('web.agentRuntimesList.runtimesTitle')}
                action={
                    vm.runtimes.length > 0 ? (
                        <span className='text-caption text-muted'>
                            {vm.agentsCount}{' '}
                            {vm.agentsCount === 1
                                ? t('web.agentRuntimesList.agent')
                                : t('web.agentRuntimesList.agents')}
                        </span>
                    ) : undefined
                }
            >
                {vm.runtimes.length === 0 ? (
                    <EmptyState
                        kind='first-use'
                        tier='stack'
                        title={t('web.emptyState.runtimesTitle')}
                        body={
                            host
                                ? t('web.emptyState.hostRuntimesBody')
                                : sandbox
                                  ? t('web.emptyState.sandboxRuntimesBody')
                                  : t('web.emptyState.createRuntimeBody')
                        }
                        action={
                            host || sandbox
                                ? undefined
                                : {
                                      label: t(
                                          'web.emptyState.createRuntimeAction'
                                      ),
                                      onClick: () =>
                                          navigate('/settings/runtimes/sandbox')
                                  }
                        }
                    />
                ) : (
                    <div className='settings-card'>
                        {vm.runtimes.map((r) => (
                            <HostRuntimeRow
                                key={r.id}
                                runtime={r}
                                latest={catalog[r.framework]?.latest ?? null}
                                onSelect={() => onSelectRuntime(r.id)}
                            />
                        ))}
                    </div>
                )}
            </Section>

            {(host || sandbox) && availableFrameworks.length > 0 && (
                <Section
                    title={t('web.agentRuntimesList.availableFrameworks')}
                    action={
                        vm.kind === 'sprites' && sandboxHostId && onDetect ? (
                            <button
                                type='button'
                                disabled={detecting}
                                onClick={() => onDetect(sandboxHostId)}
                                className='text-caption text-link hover:text-fg disabled:text-muted font-medium disabled:cursor-not-allowed'
                            >
                                {detecting
                                    ? t('web.agentRuntimesList.detecting')
                                    : t(
                                          'web.agentRuntimesList.detectFrameworks'
                                      )}
                            </button>
                        ) : undefined
                    }
                >
                    <p className='text-caption text-muted mb-3'>
                        {host
                            ? t('web.agentRuntimesList.installDaemonHint')
                            : t('web.agentRuntimesList.provisionHint')}
                    </p>
                    <div className='settings-card'>
                        {availableFrameworks.map((f) => {
                            const info = frameworkAvailability(f)
                            return (
                                <AvailableFrameworkRow
                                    key={f}
                                    framework={f}
                                    kind={vm.kind}
                                    installed={info.installed}
                                    version={info.version}
                                    versions={catalog[f]?.versions ?? []}
                                    latest={catalog[f]?.latest ?? null}
                                    serviceOccupant={serviceOccupant}
                                    provisionHostId={sandboxHostId}
                                    onGuide={(framework, mode): void =>
                                        setGuide({ framework, mode })
                                    }
                                />
                            )
                        })}
                    </div>
                </Section>
            )}

            {sandbox && serviceHostId && (
                <Section
                    title={t('web.agentRuntimesList.activity')}
                    action={
                        activityLoading ? (
                            <SheenText className='text-caption text-muted'>
                                {t('web.agentRuntimesList.loading')}
                            </SheenText>
                        ) : undefined
                    }
                >
                    <p className='text-caption text-muted mb-3'>
                        {t('web.agentRuntimesList.activityDescription')}
                    </p>
                    {servicesError && (
                        <div className='workbench-alert-error mb-3'>
                            {servicesError}
                        </div>
                    )}
                    {tasksError && (
                        <div className='workbench-alert-error mb-3'>
                            {tasksError}
                        </div>
                    )}
                    {services === null && tasks === null ? (
                        !servicesError && !tasksError ? (
                            <div className='text-caption text-muted py-4'>
                                {t('web.agentRuntimesList.loadingActivity')}
                            </div>
                        ) : null
                    ) : !servicesError &&
                      !tasksError &&
                      (services?.length ?? 0) === 0 &&
                      (tasks?.length ?? 0) === 0 ? (
                        <EmptyState
                            kind='all-clear'
                            tier='stack'
                            title={t('web.emptyState.sandboxActivityTitle')}
                            body={t('web.emptyState.sandboxActivityBody')}
                        />
                    ) : (
                        <div className='space-y-4'>
                            {services && services.length > 0 && (
                                <div>
                                    <div className='workbench-kicker mb-2'>
                                        {t('web.agentRuntimesList.services')}
                                    </div>
                                    <div className='settings-card'>
                                        {services.map((svc) => (
                                            <ServiceRow
                                                key={svc.name}
                                                service={svc}
                                                deleting={
                                                    deletingService === svc.name
                                                }
                                                onDelete={async (): Promise<void> => {
                                                    if (
                                                        !onDeleteService ||
                                                        !serviceHostId
                                                    )
                                                        return
                                                    if (
                                                        !(await confirm({
                                                            title: t(
                                                                'web.agentRuntimesList.deleteService'
                                                            ),
                                                            description: t(
                                                                'web.agentRuntimesList.deleteServiceDescription',
                                                                {
                                                                    name: svc.name
                                                                }
                                                            ),
                                                            confirmLabel: t(
                                                                'web.agentRuntimesList.delete'
                                                            ),
                                                            tone: 'danger'
                                                        }))
                                                    )
                                                        return
                                                    setDeletingService(svc.name)
                                                    void Promise.resolve(
                                                        onDeleteService(
                                                            serviceHostId,
                                                            svc.name
                                                        )
                                                    )
                                                        .then(() => {
                                                            setServices(
                                                                (prev) =>
                                                                    prev
                                                                        ? prev.filter(
                                                                              (
                                                                                  s
                                                                              ) =>
                                                                                  s.name !==
                                                                                  svc.name
                                                                          )
                                                                        : prev
                                                            )
                                                        })
                                                        .catch((e: Error) =>
                                                            setServicesError(
                                                                e.message
                                                            )
                                                        )
                                                        .finally(() =>
                                                            setDeletingService(
                                                                null
                                                            )
                                                        )
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                            {tasks && tasks.length > 0 && (
                                <div>
                                    <div className='workbench-kicker mb-2'>
                                        {t('web.agentRuntimesList.tasks')}
                                    </div>
                                    <div className='settings-card'>
                                        {tasks.map((task) => (
                                            <TaskRow
                                                key={task.name}
                                                task={task}
                                                deleting={
                                                    deletingTask === task.name
                                                }
                                                onDelete={async (): Promise<void> => {
                                                    if (
                                                        !onDeleteTask ||
                                                        !onLoadTasks ||
                                                        !serviceHostId
                                                    )
                                                        return
                                                    if (
                                                        !(await confirm({
                                                            title: t(
                                                                'web.agentRuntimesList.deleteTask'
                                                            ),
                                                            description: t(
                                                                'web.agentRuntimesList.deleteTaskDescription',
                                                                {
                                                                    name: task.name
                                                                }
                                                            ),
                                                            confirmLabel: t(
                                                                'web.agentRuntimesList.delete'
                                                            ),
                                                            tone: 'danger'
                                                        }))
                                                    )
                                                        return
                                                    setDeletingTask(task.name)
                                                    setTasksError(null)
                                                    void Promise.resolve(
                                                        onDeleteTask(
                                                            serviceHostId,
                                                            task.name
                                                        )
                                                    )
                                                        .then(() =>
                                                            onLoadTasks(
                                                                serviceHostId
                                                            )
                                                        )
                                                        .then(setTasks)
                                                        .catch((e: Error) =>
                                                            setTasksError(
                                                                e.message
                                                            )
                                                        )
                                                        .finally(() =>
                                                            setDeletingTask(
                                                                null
                                                            )
                                                        )
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </Section>
            )}

            {(host || sandbox) && (
                <Section title={t('web.agentRuntimesList.controls')}>
                    <div className='settings-card'>
                        {sandbox && sandboxHostId && onToggleKeepAwake && (
                            <ControlRow
                                label={t('web.hostStatus.keepAwake.label')}
                                description={t('web.hostStatus.keepAwake.hint')}
                                enabled={sandbox.keepAwake}
                                pending={Boolean(togglingKeepAwake)}
                                pendingLabel={t('web.runtimeDetail.updating')}
                                onToggle={(): void => {
                                    void onToggleKeepAwake(
                                        sandboxHostId,
                                        !sandbox.keepAwake
                                    )
                                }}
                            />
                        )}
                        {sandbox && sandboxHostId && onToggleTerminal && (
                            <ControlRow
                                label={t('web.agentRuntimesList.terminal')}
                                description={t(
                                    'web.agentRuntimesList.terminalDescription'
                                )}
                                enabled={sandbox.terminalEnabled}
                                pending={Boolean(togglingTerminal)}
                                pendingLabel={t('web.runtimeDetail.updating')}
                                onToggle={(): void => {
                                    void onToggleTerminal(
                                        sandboxHostId,
                                        !sandbox.terminalEnabled
                                    )
                                }}
                            />
                        )}
                        {sandbox &&
                            sandboxHostId &&
                            sandbox.terminalEnabled &&
                            onToggleTerminalModelCredentials && (
                                <ControlRow
                                    label={t(
                                        'web.agentRuntimesList.terminalModelCredentials'
                                    )}
                                    description={t(
                                        'web.agentRuntimesList.terminalModelCredentialsDescription'
                                    )}
                                    enabled={sandbox.terminalModelCredentials}
                                    pending={Boolean(
                                        togglingTerminalModelCredentials
                                    )}
                                    pendingLabel={t(
                                        'web.runtimeDetail.updating'
                                    )}
                                    onToggle={(): void => {
                                        void onToggleTerminalModelCredentials(
                                            sandboxHostId,
                                            !sandbox.terminalModelCredentials
                                        )
                                    }}
                                />
                            )}
                        {sandbox && (
                            <div className='settings-card-row'>
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {t('web.agentRuntimesList.cliLabel')}
                                    </div>
                                    <div className='settings-card-copy'>
                                        {t(
                                            'web.agentRuntimesList.sandboxCliDescription'
                                        )}
                                    </div>
                                </div>
                                <div className='settings-card-side'>
                                    {renderSandboxCliValue(sandbox)}
                                </div>
                            </div>
                        )}
                        {sandbox && (
                            <div className='settings-card-row'>
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {t('web.agentRuntimesList.herdrLabel')}
                                    </div>
                                    <div className='settings-card-copy'>
                                        {t(
                                            'web.agentRuntimesList.sandboxHerdrDescription'
                                        )}
                                    </div>
                                </div>
                                <div className='settings-card-side'>
                                    <HerdrVersionValue
                                        current={sandbox.herdrVersion}
                                        latest={sandbox.latestHerdrVersion}
                                        updateAvailable={
                                            sandbox.herdrUpdateAvailable
                                        }
                                        busy={Boolean(upgradingSandboxHerdr)}
                                        onUpgrade={
                                            onUpgradeSandboxHerdr
                                                ? () =>
                                                      void onUpgradeSandboxHerdr(
                                                          sandbox.id
                                                      )
                                                : undefined
                                        }
                                    />
                                </div>
                            </div>
                        )}
                        {host && (
                            <div className='settings-card-row'>
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {t('web.agentRuntimesList.cliLabel')}
                                    </div>
                                    <div className='settings-card-copy'>
                                        {t(
                                            'web.agentRuntimesList.daemonCliDescription'
                                        )}
                                    </div>
                                </div>
                                <div className='settings-card-side'>
                                    {renderCliVersionValue(host)}
                                </div>
                            </div>
                        )}
                        {host && (
                            <div className='settings-card-row'>
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {t('web.agentRuntimesList.herdrLabel')}
                                    </div>
                                    <div className='settings-card-copy'>
                                        {t(
                                            'web.agentRuntimesList.daemonHerdrDescription'
                                        )}
                                    </div>
                                </div>
                                <div className='settings-card-side'>
                                    <HerdrVersionValue
                                        current={host.herdrVersion}
                                        latest={host.latestHerdrVersion}
                                        updateAvailable={
                                            host.herdrUpdateAvailable &&
                                            host.online
                                        }
                                        busy={Boolean(upgradingHerdr)}
                                        onUpgrade={
                                            onUpgradeHerdr
                                                ? () => void onUpgradeHerdr(host.id)
                                                : undefined
                                        }
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </Section>
            )}

            <Section title={t('web.agentRuntimesList.details')}>
                <div className='workbench-panel divide-divider divide-y overflow-hidden'>
                    {sandbox && (
                        <>
                            <Info
                                label={t('web.agentRuntimesList.provider')}
                                value={sandbox.providerName}
                            />
                            <Info
                                label={t('web.agentRuntimesList.providerRef')}
                                value={monoCopyValue(sandbox.providerRefLabel)}
                                mono
                            />
                            <Info
                                label={t('web.agentRuntimesList.daemon')}
                                value={daemonPresenceLabel({
                                    registered: sandbox.registered,
                                    online: sandbox.daemonOnline
                                })}
                            />
                            <Info
                                label={t('web.agentRuntimesList.created')}
                                value={
                                    <span className='tabular-nums'>
                                        {formatDate(sandbox.createdAt)}
                                    </span>
                                }
                            />
                        </>
                    )}
                    {host && (
                        <>
                            <Info
                                label={t('web.agentRuntimesList.hostname')}
                                value={host.hostname}
                                mono
                            />
                            <Info
                                label={t('web.agentRuntimesList.os')}
                                value={
                                    host.os
                                        ? `${host.os}${host.arch ? `/${host.arch}` : ''}`
                                        : null
                                }
                                mono
                            />
                            <Info
                                label={t('web.agentRuntimesList.startupMethod')}
                                value={host.startupMethod}
                                mono
                            />
                            <Info
                                label={t('web.agentRuntimesList.homeDir')}
                                value={host.homeDir}
                                mono
                            />
                            <Info
                                label={t('web.agentRuntimesList.workspaceBase')}
                                value={host.workspaceBaseDir}
                                mono
                            />
                            <Info
                                label={t('web.agentRuntimesList.lastSeen')}
                                value={
                                    host.lastSeenAt ? (
                                        <span className='tabular-nums'>
                                            {formatDate(host.lastSeenAt)}
                                            <span className='text-subtle'>
                                                {' '}
                                                · {relative(host.lastSeenAt)}
                                            </span>
                                        </span>
                                    ) : null
                                }
                            />
                            <Info
                                label={t('web.agentRuntimesList.created')}
                                value={
                                    <span className='tabular-nums'>
                                        {formatDate(host.createdAt)}
                                    </span>
                                }
                            />
                        </>
                    )}
                    {!sandbox && !host && (
                        <Info
                            label={t('web.agentRuntimesList.location')}
                            value={vm.location}
                            mono
                        />
                    )}
                </div>
            </Section>

            {guide && (
                <FrameworkInstallGuide
                    framework={guide.framework}
                    mode={guide.mode}
                    hostName={vm.label}
                    onClose={() => setGuide(null)}
                />
            )}
            {renameOpen && onRename && (
                <RenameDialog
                    title={t('web.agentRuntimesList.renameHost')}
                    initialName={vm.label}
                    submit={onRename}
                    onClose={() => setRenameOpen(false)}
                />
            )}
        </div>
    )
}

// The rail's two create affordances, both driven by NEW_RUNTIME_OPTIONS so
// destinations and gating cannot drift between them.
const NewRuntimeMenu: FC<{
    cloudComputerEnabled: boolean
    variant: 'header' | 'footer'
}> = ({ cloudComputerEnabled, variant }): ReactNode => {
    const { t } = useI18n()
    const options = NEW_RUNTIME_OPTIONS.filter(
        (option) => !option.requiresCloudComputer || cloudComputerEnabled
    ).map((option) => ({
        key: option.to,
        icon: option.icon,
        label: t(option.labelKey),
        to: option.to
    }))
    return (
        <CreateMenu
            options={options}
            variant={variant}
            triggerLabel={t('web.agentRuntimesList.newRuntimeButton')}
            sheetTitle={t('web.agentRuntimesList.newRuntime')}
        />
    )
}

const AgentRuntimesList: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const params = useParams()
    const id = params['*'] && params['*'].length > 0 ? params['*'] : undefined
    const [searchParams] = useSearchParams()
    const hostParam = searchParams.get('host')
    const [runtimeRows, setRuntimeRows] = useState<
        AgentRuntimeSummary[] | null
    >(null)
    const [hostRows, setHostRows] = useState<DaemonHostSummary[]>([])
    const [sandboxRows, setSandboxRows] = useState<SandboxSummary[]>([])
    const [detectingHostId, setDetectingHostId] = useState<string | null>(null)
    const detectedHostsRef = useRef<Set<string>>(new Set())
    const [versionCatalog, setVersionCatalog] = useState<
        Record<string, { versions: string[]; latest: string | null }>
    >({})
    const [cliCatalog, setCliCatalog] = useState<CliVersionCatalog>({
        stable: [],
        dev: []
    })
    const [upgradingCliHostId, setUpgradingCliHostId] = useState<string | null>(
        null
    )
    const [upgradingSandboxCliId, setUpgradingSandboxCliId] = useState<
        string | null
    >(null)
    const [togglingTerminalCredentialsId, setTogglingTerminalCredentialsId] =
        useState<string | null>(null)
    const [togglingTerminalId, setTogglingTerminalId] = useState<string | null>(
        null
    )
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [cloudComputerEnabled, setCloudComputerEnabled] = useState(false)
    const [sandboxUsage, setSandboxUsage] =
        useState<SandboxUsageBreakdown | null>(null)
    const [usageLoading, setUsageLoading] = useState(true)
    const [providerRows, setProviderRows] = useState<
        UserExternalAgentProviderSummary[] | null
    >(null)

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
    } = useCascadeState('mf.runtimes.cascade.v2', RUNTIME_DIMS, 'none')
    const lastRevealed = useRef<string | null>(null)

    const refresh = useCallback((): void => {
        setError(null)
        client.agentRuntimes
            .list()
            .then(setRuntimeRows)
            .catch((e: Error) => setError(e.message))
        client.daemons
            .listHosts()
            .then(setHostRows)
            .catch(() => setHostRows([]))
        client.sandboxes
            .list()
            .then(setSandboxRows)
            .catch(() => setSandboxRows([]))
        client.runtimeAccess
            .summary()
            .then((s) => setCloudComputerEnabled(s.cloudComputerEnabled))
            .catch(() => setCloudComputerEnabled(false))
        client.frameworkVersions
            .list()
            .then((entries) =>
                setVersionCatalog(
                    Object.fromEntries(
                        entries.map((e) => [
                            e.framework,
                            { versions: e.versions, latest: e.latest }
                        ])
                    )
                )
            )
            .catch(() => setVersionCatalog({}))
        client.cliVersions
            .list()
            .then(setCliCatalog)
            .catch(() => setCliCatalog({ stable: [], dev: [] }))
    }, [client])

    useEffect(refresh, [refresh])

    useEffect(() => {
        return subscribeWorkbenchEvents({
            onHostUpdate: (update) => {
                setSandboxRows((prev) =>
                    prev.map((s) =>
                        s.id === update.hostId
                            ? {
                                  ...s,
                                  powerState: update.powerState,
                                  daemonOnline: update.daemonOnline
                              }
                            : s
                    )
                )
            }
        })
    }, [client])

    const loadSandboxServices = useCallback(
        (hostId: string): Promise<SandboxServiceSummary[]> =>
            client.sandboxes.listServices(hostId),
        [client]
    )

    const deleteSandboxService = useCallback(
        (hostId: string, name: string): Promise<void> =>
            client.sandboxes.deleteService(hostId, name),
        [client]
    )

    const loadSandboxTasks = useCallback(
        (hostId: string): Promise<SandboxTaskSummary[]> =>
            client.sandboxes.listTasks(hostId),
        [client]
    )

    const deleteSandboxTask = useCallback(
        (hostId: string, name: string): Promise<void> =>
            client.sandboxes.deleteTask(hostId, name),
        [client]
    )

    const vms = useMemo(
        () =>
            runtimeRows
                ? buildVMs(runtimeRows, hostRows, sandboxRows, t)
                : null,
        [runtimeRows, hostRows, sandboxRows, t]
    )

    const groups = useMemo<Group[]>(() => {
        if (!vms || !runtimeRows) return []
        const hosts: HostBucket[] = vms.map((vm) => ({
            key: vm.key,
            vm,
            runtimes: vm.runtimes
        }))

        if (groupBy === 'none')
            return hosts.length === 0
                ? []
                : [
                      {
                          mode: 'none',
                          key: 'all',
                          count: runtimeRows.length,
                          health: groupHealth(runtimeRows),
                          hosts
                      }
                  ]

        if (groupBy === 'kind') {
            const out: Group[] = []
            for (const kind of KIND_ORDER) {
                const kindHosts = hosts.filter((h) => h.vm.kind === kind)
                if (kindHosts.length === 0) continue
                const all = kindHosts.flatMap((h) => h.runtimes)
                out.push({
                    mode: 'kind',
                    key: `kind:${kind}`,
                    label: placementLabel(kind),
                    count: all.length,
                    health: groupHealth(all),
                    hosts: kindHosts
                })
            }
            return out
        }

        if (groupBy === 'status') {
            const out: Group[] = []
            for (const s of STATUS_ORDER) {
                const leaves = runtimeRows.filter((r) => effStatus(r) === s)
                if (leaves.length === 0) continue
                out.push({
                    mode: 'flat',
                    key: `status:${s}`,
                    label: t(`web.runtimeDetail.status.${s}`),
                    count: leaves.length,
                    health: groupHealth(leaves),
                    leaves
                })
            }
            return out
        }

        const byFw = new Map<RuntimeFramework, AgentRuntimeSummary[]>()
        for (const r of runtimeRows) {
            const arr = byFw.get(r.framework) ?? []
            arr.push(r)
            byFw.set(r.framework, arr)
        }
        return [...byFw.entries()]
            .sort(
                (a, b) =>
                    b[1].length - a[1].length ||
                    frameworkLabel(a[0]).localeCompare(frameworkLabel(b[0]))
            )
            .map(([fw, leaves]) => ({
                mode: 'flat' as const,
                key: `fw:${fw}`,
                label: frameworkLabel(fw),
                logo: fw,
                count: leaves.length,
                health: groupHealth(leaves),
                leaves
            }))
    }, [vms, runtimeRows, groupBy])

    const totalCount = useMemo(
        () => groups.reduce((n, g) => n + g.count, 0),
        [groups]
    )

    const selection = useMemo<Selection | null>(() => {
        if (id === DASHBOARD_SEGMENT) return { kind: 'dashboard' }
        if (isRuntimePage(id)) return { kind: 'page', page: id }
        if (!vms) return null
        if (id) return { kind: 'runtime', id }
        if (hostParam && vms.some((v) => v.key === hostParam))
            return { kind: 'host', key: hostParam }
        return null
    }, [vms, id, hostParam])

    const hasSelection = Boolean(id) || Boolean(hostParam)
    // Desktop shows the dashboard whenever nothing is selected; mobile only on
    // the explicit /dashboard segment (the bare URL keeps the rail there).
    const dashboardVisible =
        id === DASHBOARD_SEGMENT ||
        (!id && !hostParam) ||
        (vms !== null && selection === null)

    // Dashboard-only data: sandbox usage (storage + per-agent breakdown) and
    // external providers. Failures degrade to missing columns on the cards —
    // they never feed the page error banner.
    useEffect(() => {
        if (!dashboardVisible) return
        let cancelled = false
        setUsageLoading(true)
        client.runtimeAccess
            .sandboxUsage()
            .then((u) => {
                if (!cancelled) setSandboxUsage(u)
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setUsageLoading(false)
            })
        client.externalAgentProviders
            .list()
            .then((rows) => {
                if (!cancelled) setProviderRows(rows)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [client, dashboardVisible])

    // The embedded create/manage pages mutate the hosts and providers the
    // rail and dashboard read; refetch on leaving one so a fresh sandbox or a
    // revoked machine shows up without a reload.
    const onRuntimePage = isRuntimePage(id)
    const wasOnRuntimePage = useRef(false)
    useEffect(() => {
        if (wasOnRuntimePage.current && !onRuntimePage) refresh()
        wasOnRuntimePage.current = onRuntimePage
    }, [onRuntimePage, refresh])

    const keysForSelection = useCallback(
        (sel: Selection): string[] => {
            if (!vms || sel.kind === 'dashboard' || sel.kind === 'page')
                return []
            if (sel.kind === 'host') {
                const vm = vms.find((v) => v.key === sel.key)
                if (!vm) return []
                if (groupBy === 'none') return [vm.key]
                if (groupBy === 'kind') return [`kind:${vm.kind}`, vm.key]
                return []
            }
            const vm = vmContaining(vms, sel.id)
            const runtime =
                runtimeRows?.find((r) => r.id === sel.id) ??
                vm?.runtimes.find((r) => r.id === sel.id) ??
                null
            if (groupBy === 'none') return vm ? [vm.key] : []
            if (groupBy === 'kind') return vm ? [`kind:${vm.kind}`, vm.key] : []
            if (groupBy === 'status' && runtime)
                return [`status:${effStatus(runtime)}`]
            if (groupBy === 'framework' && runtime)
                return [`fw:${runtime.framework}`]
            return []
        },
        [vms, runtimeRows, groupBy]
    )

    useEffect(() => {
        if (
            !vms ||
            !selection ||
            selection.kind === 'dashboard' ||
            selection.kind === 'page'
        )
            return
        const selKey =
            selection.kind === 'runtime'
                ? `r:${selection.id}`
                : `h:${selection.key}`
        const token = `${groupBy}|${selKey}`
        if (lastRevealed.current === token) return
        lastRevealed.current = token
        const keys = keysForSelection(selection)
        if (keys.length > 0) reveal(keys)
    }, [vms, selection, groupBy, keysForSelection, reveal])

    const isOpen = (key: string): boolean => expanded.has(key)

    const allKeys = useMemo(() => {
        const keys: string[] = []
        for (const g of groups) {
            if (g.mode !== 'none') keys.push(g.key)
            if (g.mode !== 'flat') for (const h of g.hosts) keys.push(h.key)
        }
        return keys
    }, [groups])

    const selectHost = (key: string): void => {
        navigate(`/settings/runtimes?host=${encodeURIComponent(key)}`)
    }
    const selectRuntime = (runtimeId: string): void => {
        navigate(`/settings/runtimes/${runtimeId}`)
    }

    const handleDeleted = useCallback(
        (deletedId: string): void => {
            setRuntimeRows((prev) =>
                prev ? prev.filter((r) => r.id !== deletedId) : prev
            )
            navigate('/settings/runtimes')
            refresh()
        },
        [navigate, refresh]
    )

    const handleDeleteSandbox = useCallback(
        async (hostId: string): Promise<void> => {
            try {
                await client.sandboxes.delete(hostId)
                navigate('/settings/runtimes')
                refresh()
            } catch (e) {
                setError((e as Error).message)
            }
        },
        [client, navigate, refresh]
    )

    const handleRenameHost = useCallback(
        async (vm: RuntimeVM, name: string): Promise<void> => {
            if (!vm.hostId) return
            if (vm.kind === 'sprites')
                await client.sandboxes.rename(vm.hostId, name)
            else if (vm.kind === 'daemon')
                await client.daemons.renameHost(vm.hostId, name)
            else if (vm.kind === 'k8s')
                await client.podHosts.rename(vm.hostId, name)
            else return
            refresh()
        },
        [client, refresh]
    )

    const [togglingKeepAwakeId, setTogglingKeepAwakeId] = useState<
        string | null
    >(null)
    const handleToggleKeepAwake = useCallback(
        async (hostId: string, enabled: boolean): Promise<void> => {
            setTogglingKeepAwakeId(hostId)
            setError(null)
            try {
                const updated = await client.sandboxes.setKeepAwake(
                    hostId,
                    enabled
                )
                setSandboxRows((prev) =>
                    prev.map((s) => (s.id === hostId ? updated : s))
                )
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setTogglingKeepAwakeId(null)
            }
        },
        [client]
    )

    const handleToggleTerminalModelCredentials = useCallback(
        async (hostId: string, enabled: boolean): Promise<void> => {
            setTogglingTerminalCredentialsId(hostId)
            setError(null)
            try {
                const updated =
                    await client.sandboxes.setTerminalModelCredentials(
                        hostId,
                        enabled
                    )
                setSandboxRows((prev) =>
                    prev.map((s) => (s.id === hostId ? updated : s))
                )
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setTogglingTerminalCredentialsId(null)
            }
        },
        [client]
    )

    const handleToggleTerminal = useCallback(
        async (hostId: string, enabled: boolean): Promise<void> => {
            setTogglingTerminalId(hostId)
            setError(null)
            try {
                const updated = await client.sandboxes.setTerminal(
                    hostId,
                    enabled
                )
                setSandboxRows((prev) =>
                    prev.map((s) => (s.id === hostId ? updated : s))
                )
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setTogglingTerminalId(null)
            }
        },
        [client, t]
    )

    const selectedVM = useMemo(() => {
        if (!vms || selection?.kind !== 'host') return null
        return vms.find((v) => v.key === selection.key) ?? null
    }, [vms, selection])
    const queuedHostCli = useIsTargetUpdating(`cli:daemon:${selectedVM?.host?.id}`)
    const queuedSandboxCli = useIsTargetUpdating(`cli:sandbox:${selectedVM?.sandbox?.id}`)

    const handleRefreshSandboxStatus = useCallback(
        async (hostId: string): Promise<void> => {
            const updated = await client.sandboxes.refreshStatus(hostId)
            setSandboxRows((prev) =>
                prev.map((s) => (s.id === hostId ? updated : s))
            )
        },
        [client]
    )

    const handleStopSandbox = useCallback(
        async (hostId: string): Promise<void> => {
            try {
                await client.sandboxes.stop(hostId)
                await handleRefreshSandboxStatus(hostId)
            } catch (e) {
                setError((e as Error).message)
            }
        },
        [client, handleRefreshSandboxStatus]
    )

    const runDetectFrameworks = useCallback(
        async (hostId: string): Promise<void> => {
            setDetectingHostId(hostId)
            try {
                const updated = await client.sandboxes.detectFrameworks(hostId)
                setSandboxRows((prev) =>
                    prev.map((s) => (s.id === hostId ? updated : s))
                )
                // detect back-fills runtime versions server-side; pull the
                // refreshed rows so provisioned cards show real versions too.
                const rows = await client.agentRuntimes.list()
                setRuntimeRows(rows)
            } catch {
                // best-effort: leave existing data in place on failure
            } finally {
                setDetectingHostId(null)
            }
        },
        [client]
    )

    useEffect(() => {
        const hostId = selectedVM?.sandbox?.id
        if (!selectedVM || selectedVM.kind !== 'sprites' || !hostId) return
        if (detectedHostsRef.current.has(hostId)) return
        detectedHostsRef.current.add(hostId)
        void runDetectFrameworks(hostId)
    }, [selectedVM, runDetectFrameworks])

    const handleUpgradeHostCli = useCallback(
        async (hostId: string, targetVersion?: string): Promise<void> => {
            if (updateRunStore.isTargetUpdating(`cli:daemon:${hostId}`)) return
            setUpgradingCliHostId(hostId)
            setError(null)
            setMessage(null)
            try {
                const res = await client.daemons.upgradeHost(
                    hostId,
                    targetVersion
                )
                setMessage(
                    res.deferred
                        ? t('web.updates.run.deferredDetail', { count: String(res.activeSessions ?? 0) })
                        : res.restarting
                        ? t('web.agentRuntimesList.upgradeMessage', {
                              version:
                                  res.toVersion ??
                                  t('web.agentRuntimesList.latest')
                          })
                        : t('web.agentRuntimesList.alreadyOnVersion', {
                              version:
                                  res.toVersion ??
                                  t('web.agentRuntimesList.latest')
                          })
                )
                refresh()
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setUpgradingCliHostId(null)
            }
        },
        [client, refresh]
    )

    const handleUpgradeSandboxCli = useCallback(
        async (hostId: string, targetVersion?: string): Promise<void> => {
            if (updateRunStore.isTargetUpdating(`cli:sandbox:${hostId}`)) return
            setUpgradingSandboxCliId(hostId)
            setError(null)
            setMessage(null)
            try {
                const updated = await client.sandboxes.upgradeCli(
                    hostId,
                    targetVersion
                )
                setSandboxRows((prev) =>
                    prev.map((s) => (s.id === hostId ? updated : s))
                )
                setMessage(
                    t('web.agentRuntimesList.upgradedMessage', {
                        version:
                            updated.cliVersion ??
                            t('web.agentRuntimesList.latest')
                    })
                )
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setUpgradingSandboxCliId(null)
            }
        },
        [client]
    )

    // herdr upgrades (ADR-0031): herdr's own updater on a machine, the
    // installer inside a sandbox; the list re-reads the version it landed on.
    const [upgradingHerdrHostId, setUpgradingHerdrHostId] = useState<
        string | null
    >(null)
    const [upgradingSandboxHerdrId, setUpgradingSandboxHerdrId] = useState<
        string | null
    >(null)
    const handleUpgradeHostHerdr = useCallback(
        async (hostId: string): Promise<void> => {
            if (updateRunStore.isTargetUpdating(`herdr:daemon:${hostId}`)) return
            setUpgradingHerdrHostId(hostId)
            setError(null)
            setMessage(null)
            try {
                const res = await client.daemons.upgradeHerdr(hostId)
                setMessage(
                    t('web.agentRuntimesList.herdrUpgradedMessage', {
                        version:
                            res.toVersion ?? t('web.agentRuntimesList.latest')
                    })
                )
                refresh()
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setUpgradingHerdrHostId(null)
            }
        },
        [client, refresh]
    )
    const handleUpgradeSandboxHerdr = useCallback(
        async (hostId: string): Promise<void> => {
            if (updateRunStore.isTargetUpdating(`herdr:sandbox:${hostId}`))
                return
            setUpgradingSandboxHerdrId(hostId)
            setError(null)
            setMessage(null)
            try {
                const updated = await client.sandboxes.upgradeHerdr(hostId)
                setSandboxRows((prev) =>
                    prev.map((s) => (s.id === hostId ? updated : s))
                )
                setMessage(
                    t('web.agentRuntimesList.herdrUpgradedMessage', {
                        version:
                            updated.herdrVersion ??
                            t('web.agentRuntimesList.latest')
                    })
                )
            } catch (e) {
                setError((e as Error).message)
            } finally {
                setUpgradingSandboxHerdrId(null)
            }
        },
        [client]
    )

    const breadcrumbItems = useMemo<BreadcrumbItem[]>(() => {
        if (
            !vms ||
            !selection ||
            selection.kind === 'dashboard' ||
            selection.kind === 'page'
        )
            return []
        if (selection.kind === 'host') {
            const vm = vms.find((v) => v.key === selection.key)
            return vm
                ? [
                      {
                          label: placementLabel(vm.kind),
                          to: '/settings/runtimes'
                      },
                      { label: vm.label }
                  ]
                : []
        }
        const vm = vmContaining(vms, selection.id)
        const runtime = runtimeRows?.find((r) => r.id === selection.id) ?? null
        const parts: BreadcrumbItem[] = []
        if (vm)
            parts.push(
                {
                    label: placementLabel(vm.kind),
                    to: '/settings/runtimes'
                },
                {
                    label: vm.label,
                    to: `/settings/runtimes?host=${encodeURIComponent(vm.key)}`
                }
            )
        if (runtime) parts.push({ label: frameworkLabel(runtime.framework) })
        return parts
    }, [vms, selection, runtimeRows])

    const loading = runtimeRows === null
    const anyExpanded = expanded.size > 0

    const renderTree = (): ReactNode => {
        if (loading) return <GhostRailRows rows={4} icon />
        if (vms && vms.length === 0)
            return (
                <EmptyState
                    kind='first-use'
                    tier='line'
                    title={t('web.emptyState.runtimesTitle')}
                    className='px-3 py-4'
                />
            )
        if (groups.length === 0)
            return (
                <div className='text-caption text-subtle px-3 py-4'>
                    {t('web.agentRuntimesList.noMatches')}
                </div>
            )
        return groups.map((g) => (
            <div key={g.key}>
                {g.mode !== 'none' && (
                    <GroupHeader
                        label={g.label}
                        count={g.count}
                        open={isOpen(g.key)}
                        health={g.health}
                        logo={g.mode === 'flat' ? g.logo : undefined}
                        onToggle={() => toggle(g.key)}
                    />
                )}
                {(g.mode === 'none' || isOpen(g.key)) &&
                    (g.mode === 'flat'
                        ? g.leaves.map((r) => (
                              <RuntimeLeaf
                                  key={r.id}
                                  runtime={r}
                                  subLabel={vmLabelOf(r, t)}
                                  indentClass='pl-8'
                                  selected={
                                      selection?.kind === 'runtime' &&
                                      selection.id === r.id
                                  }
                                  onSelect={() => selectRuntime(r.id)}
                              />
                          ))
                        : g.hosts.map((h) => (
                              <div key={h.key}>
                                  <HostRow
                                      vm={h.vm}
                                      count={h.runtimes.length}
                                      open={isOpen(h.key)}
                                      selected={
                                          selection?.kind === 'host' &&
                                          selection.key === h.key
                                      }
                                      onToggle={() => toggle(h.key)}
                                      onSelect={() => selectHost(h.key)}
                                  />
                                  {isOpen(h.key) &&
                                      h.runtimes.map((r) => (
                                          <RuntimeLeaf
                                              key={r.id}
                                              runtime={r}
                                              indentClass='pl-10'
                                              showStatusDot={false}
                                              selected={
                                                  selection?.kind ===
                                                      'runtime' &&
                                                  selection.id === r.id
                                              }
                                              onSelect={() =>
                                                  selectRuntime(r.id)
                                              }
                                          />
                                      ))}
                              </div>
                          )))}
            </div>
        ))
    }

    const renderDetail = (): ReactNode => {
        if (selection?.kind === 'page') {
            const Page = RUNTIME_PAGES[selection.page]
            return <Page />
        }
        if (loading) return null
        if (selection?.kind === 'runtime')
            return (
                <>
                    {breadcrumbItems.length > 0 && (
                        <Breadcrumb items={breadcrumbItems} />
                    )}
                    <RuntimeDetailPanel
                        key={selection.id}
                        runtimeId={selection.id}
                        onDeleted={handleDeleted}
                        onRenamed={refresh}
                    />
                </>
            )
        if (selectedVM)
            return (
                <>
                    {breadcrumbItems.length > 0 && (
                        <Breadcrumb items={breadcrumbItems} />
                    )}
                    <HostDetailPanel
                        key={selectedVM.key}
                        vm={selectedVM}
                        onSelectRuntime={selectRuntime}
                        onDetect={runDetectFrameworks}
                        detecting={detectingHostId === selectedVM.sandbox?.id}
                        onRefreshStatus={handleRefreshSandboxStatus}
                        catalog={versionCatalog}
                        cliCatalog={cliCatalog}
                        onUpgradeCli={handleUpgradeHostCli}
                        upgradingCli={
                            upgradingCliHostId === selectedVM.host?.id || queuedHostCli
                        }
                        onUpgradeSandboxCli={handleUpgradeSandboxCli}
                        upgradingSandboxCli={
                            upgradingSandboxCliId === selectedVM.sandbox?.id || queuedSandboxCli
                        }
                        onUpgradeHerdr={handleUpgradeHostHerdr}
                        upgradingHerdr={
                            upgradingHerdrHostId === selectedVM.host?.id
                        }
                        onUpgradeSandboxHerdr={handleUpgradeSandboxHerdr}
                        upgradingSandboxHerdr={
                            upgradingSandboxHerdrId === selectedVM.sandbox?.id
                        }
                        onDelete={handleDeleteSandbox}
                        onStop={handleStopSandbox}
                        onRename={
                            selectedVM.hostId !== null
                                ? (name) => handleRenameHost(selectedVM, name)
                                : undefined
                        }
                        onToggleTerminal={handleToggleTerminal}
                        onToggleKeepAwake={handleToggleKeepAwake}
                        togglingKeepAwake={
                            togglingKeepAwakeId === selectedVM.sandbox?.id
                        }
                        onToggleTerminalModelCredentials={
                            handleToggleTerminalModelCredentials
                        }
                        togglingTerminalModelCredentials={
                            togglingTerminalCredentialsId ===
                            selectedVM.sandbox?.id
                        }
                        togglingTerminal={
                            togglingTerminalId === selectedVM.sandbox?.id
                        }
                        onLoadServices={loadSandboxServices}
                        onDeleteService={deleteSandboxService}
                        onLoadTasks={loadSandboxTasks}
                        onDeleteTask={deleteSandboxTask}
                    />
                </>
            )
        return (
            <RuntimesDashboard
                vms={vms ?? []}
                usage={sandboxUsage}
                usageLoading={usageLoading}
                providers={providerRows}
                cloudComputerEnabled={cloudComputerEnabled}
                onSelectHost={selectHost}
            />
        )
    }

    return (
        <CascadeShell
            railLabel={t('web.agentRuntimesList.runtimesAria')}
            hasSelection={hasSelection}
            rail={
                <>
                    <div className='shrink-0 space-y-2.5 p-3'>
                        <div className='flex items-center justify-between'>
                            <Link
                                to={`/settings/runtimes/${DASHBOARD_SEGMENT}`}
                                aria-current={
                                    selection === null ||
                                    selection.kind === 'dashboard'
                                        ? 'page'
                                        : undefined
                                }
                                className='hover:bg-rail-hover -mx-1.5 flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 transition-colors'
                            >
                                <h2 className='text-h3 text-fg'>
                                    {t('web.agentRuntimesList.runtimesTitle')}
                                </h2>
                                <span className='tag tag-neutral tabular-nums'>
                                    {totalCount}
                                </span>
                            </Link>
                            <NewRuntimeMenu
                                cloudComputerEnabled={cloudComputerEnabled}
                                variant='header'
                            />
                        </div>

                        <div className='flex items-center justify-between gap-2'>
                            <GroupByControl
                                value={groupBy}
                                onChange={setGroupBy}
                                options={GROUP_BY_OPTIONS.map((option) => ({
                                    ...option,
                                    label:
                                        option.value === 'none'
                                            ? t(
                                                  'web.agentRuntimesList.statusNone'
                                              )
                                            : option.value === 'kind'
                                              ? t(
                                                    'web.agentRuntimesList.statusKind'
                                                )
                                              : option.value === 'status'
                                                ? t(
                                                      'web.agentRuntimesList.statusStatus'
                                                  )
                                                : t(
                                                      'web.agentRuntimesList.statusFramework'
                                                  )
                                }))}
                            />
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
                                    ? t('web.agentRuntimesList.collapseAll')
                                    : t('web.agentRuntimesList.expandAll')}
                            </button>
                        </div>
                    </div>

                    <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-2'>
                        {renderTree()}
                    </div>

                    <div className='shrink-0 p-2'>
                        <NewRuntimeMenu
                            cloudComputerEnabled={cloudComputerEnabled}
                            variant='footer'
                        />
                    </div>
                </>
            }
        >
            <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                {message && (
                    <div className='workbench-note mb-6'>{message}</div>
                )}
                {error && (
                    <div className='workbench-alert-error mb-6'>{error}</div>
                )}
                {renderDetail()}
            </div>
        </CascadeShell>
    )
}

export default AgentRuntimesList
