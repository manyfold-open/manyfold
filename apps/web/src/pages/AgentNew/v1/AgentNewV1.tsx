import {
    AgentRuntimeSummary,
    CreateAgentBody,
    K8S_HOME_BASE,
    NARRANEXUS_K8S_BASE_WORKING_PATH,
    NARRANEXUS_SPRITE_BASE_WORKING_PATH,
    SPRITE_HOME_BASE,
    UserExternalAgentProviderSummary,
    UserModelProvider,
    UserModelProviderSummary,
    externalSteps,
    brandFor,
    frameworkUpgradeMode,
    isConfigurableFramework,
    lookupBuiltIn,
    normalizeAgentName,
    providerSupportsTarget,
    runtimeAuthSupported,
    supportsRuntime,
    versionedFrameworks,
    validateAgentName
} from '@manyfold/shared'
import type { AgentFramework, DaemonHostSummary } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
    BoxIcon,
    CheckIcon,
    HelpIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    CloseIcon,
    PlugIcon,
    PlusIcon,
    RuntimeIcon,
    type LucideIcon
} from '@/components/icons'
import { useAppShellContext } from '@/components/AppShell'
import { BuiltInLogo, ProviderLogo } from '@/components/BuiltInProviderLogo'
import ConnectDaemonDialog from '@/components/ConnectDaemonDialog'
import { CreateMenu } from '@/components/CreateMenu'
import { FilterChip } from '@/components/FilterChip'
import ModelProviderCreateDialog, {
    modelProviderCreateOptions,
    type ModelProviderCreatePick
} from '@/components/ModelProviderCreateDialog'
import { DashboardViewToggle } from '@/components/DashboardCard'
import WorkbenchSelect, {
    type WorkbenchSelectOption
} from '@/components/WorkbenchSelect'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import {
    initialPickerForFramework,
    pickerIsValid,
    ProviderPicker,
    type ProviderPickerValue
} from '@/pages/AgentNew/components/ProviderPicker'
import ProductDialog from '@/components/ProductDialog'
import { Spinner } from '@/components/Loading'
import OverflowMenu, { type OverflowMenuEntry } from '@/components/OverflowMenu'
import RenameDialog from '@/components/RenameDialog'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { ProviderSourceSection } from '@/pages/AgentNew/components/ProviderSourceSection'
import { ProviderFamilySection } from '@/pages/AgentNew/components/ProviderFamilySection'
import { providerLabel } from '@/pages/Settings/ModelProviderFields'
import {
    localRowCount,
    type SandboxPrepare
} from '@/pages/AgentNew/components/LocalCredentialsPanel'
import { CreateProgress } from '@/pages/AgentNew/components/CreateProgress'
import {
    frameworkLabel,
    FrameworkLogo as FrameworkLogoMark
} from '@/lib/frameworkMeta'
import {
    apiKeyLabelForProvider,
    buildAddRuntimeAgentBody,
    buildAgentCredentialsBody,
    buildCreateAgentBody,
    modelProviderForFramework,
    progressStepsForCreate,
    workspaceValidationMessage as validateWorkspacePath,
    type AgentCreateRuntimeMode,
    type CreateableFramework,
    type PersistentModelProvider
} from '@/lib/agentCreateDraft'
import {
    frameworkOptions,
    isCreateableFramework,
    isExternalFramework,
    isK8sOnlyFramework,
    REUSE_FRAMEWORKS,
    reuseRuntimeKindsFor,
    supportsSandbox,
    usesConfigurableModelProvider,
    remoteIdHintFor,
    remoteIdLabelFor,
    remoteIdPlaceholderFor,
    type FrameworkChoice,
    type RuntimeCategory,
    type RuntimeMode
} from '@/lib/agentCreate/frameworkOptions'
import { randomAgentName } from '@/lib/agentCreate/agentName'
import { flattenSavedModels } from '@/lib/agentCreate/savedModels'
import {
    AGENT_NEW_RUNTIME_VIEW_KEY,
    readDashboardView,
    writeDashboardView,
    type DashboardView
} from '@/lib/dashboardView'
import { NEW_RUNTIME_OPTIONS } from '@/lib/newRuntimeOptions'
import { sandboxTargetStatus } from '@/lib/agentCreate/runtimeTargetStatus'
import { preferredPrimaryModelDefault } from '@/lib/agentModelConfig'
import {
    computeSpriteTargets,
    type SpriteAttachTarget
} from '@/lib/agentCreate/spriteTargets'
import {
    openclawWorkspaceFor,
    preferredSavedProviderFor
} from '@/lib/agentCreate/providerHelpers'
import {
    INITIAL_LOCAL_CREDENTIALS,
    NEW_RUNTIME_TARGET,
    builtInEntriesFor,
    customProtocolsFor,
    initialPickerModeFor,
    isCloudCredentialPicker,
    localSelectionValid,
    providerFamiliesFor,
    providerFamilyOf,
    providerSourceOf,
    selectableProvidersFor,
    selectableProvidersForFamilies,
    type LocalCredentialSelection,
    type ProviderFamilyFilter,
    type ProviderSourceFilter,
    type ProviderTarget
} from '@/lib/agentCreate/providerSource'
import {
    installedFrameworkVersion,
    serviceSlotOccupant
} from '@/lib/agentCreate/frameworkInstall'
import {
    HostFrameworkIcons,
    type HostFrameworkAction,
    type HostFrameworkEntry
} from '@/pages/AgentNew/components/HostFrameworkIcons'
import {
    initialRuntimeAuthSelection,
    runtimeAuthPickerState
} from '@/lib/runtimeAuth'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'
import { useRunnerPrewarm } from '@/lib/agentCreate/useRunnerPrewarm'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useAgentCreate } from '@/lib/agentCreate/useAgentCreate'
import { useFrameworkModelConfig } from '@/lib/agentCreate/useFrameworkModelConfig'
import { CreateFrameworkModelConfig } from '@/pages/AgentNew/components/shared/CreateFrameworkModelConfig'
import { useI18n } from '@/lib/i18n'
import { BILLING_SURFACE } from '@/edition-capabilities'

// preferredSavedProviderFor over the framework's families, in order: the
// first family with a usable saved provider wins.
const preferredSavedProviderForFamilies = (
    options: UserModelProviderSummary[],
    families: readonly UserModelProvider[],
    framework: CreateableFramework
): UserModelProviderSummary | null => {
    for (const family of families) {
        const found = preferredSavedProviderFor(options, family, framework)
        if (found) return found
    }
    return null
}

const uniqueBy = <T,>(items: readonly T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>()
    return items.filter((item) => {
        const k = key(item)
        if (seen.has(k)) return false
        seen.add(k)
        return true
    })
}

// The brand mark on a saved provider row: the catalog entry's, else the
// brand's, else a neutral box for a custom endpoint.
const providerRowLead = (row: UserModelProviderSummary): ReactNode => {
    const entry = lookupBuiltIn(row.builtInId)
    if (entry) return <BuiltInLogo entry={entry} />
    const brand = brandFor(row)
    if (brand) return <ProviderLogo provider={brand} />
    return <BoxIcon className='text-muted h-4 w-4' aria-hidden='true' />
}

const runtimeColumnClass = (_active: boolean, disabled = false): string =>
    [
        'border-divider border-l px-4 py-2.5 align-top',
        disabled ? 'text-placeholder' : 'text-muted'
    ].join(' ')

// A runtime the agent can land on: either one this form provisions (`create`)
// or one that already exists (`existing`). Both shapes select the same way, so
// the picker renders one list instead of a tab per provenance.
type RuntimeTargetKind = 'sprites' | 'k8s' | 'daemon'
type RuntimeKindFilter = 'all' | RuntimeTargetKind

interface RuntimeTargetStatus {
    label: string
    // ready / success = a green dot, warning and idle the VM lifecycle's
    // amber and grey, progress a spinner, offline the unplugged mark.
    tone: 'ready' | 'success' | 'warning' | 'idle' | 'progress' | 'offline'
}

// Literal class names on purpose: Tailwind only emits utilities it can see
// verbatim in the source (the Tag.tsx precedent).
const STATUS_DOT: Record<
    Exclude<RuntimeTargetStatus['tone'], 'progress' | 'offline'>,
    string
> = {
    ready: 'bg-success',
    success: 'bg-success',
    warning: 'bg-warning',
    idle: 'bg-idle'
}

interface RuntimeTargetPopulation {
    framework: AgentFramework
    agents: number
}

// Name, kind, status, agent count: what picking a runtime turns on. Anything
// else this list used to carry (the framework, the machine behind a daemon, a
// host's spare slots) is either constant across the list or answered elsewhere
// in the form.
interface RuntimeTarget {
    key: string
    kind: RuntimeTargetKind
    group: 'create' | 'existing'
    name: string
    status: RuntimeTargetStatus | null
    // Who already lives on this machine, per framework — a sandbox host carries
    // one runtime per framework, so this is the whole VM's population, not just
    // the runtime that matched the picker. Empty for a runtime this form would
    // create, and for a host nothing runs on yet.
    population: RuntimeTargetPopulation[]
    // A sandbox target: the host, and every coding CLI the sprite image can
    // hold with what the last probe saw of it. Absent on daemons and cloud
    // computers, which keep the plain population line.
    hostId?: string
    frameworks?: HostFrameworkEntry[]
    // The card's own actions (rename, delete when nothing runs on it), in
    // its bottom-right menu. Absent on the targets this form would create.
    menu?: OverflowMenuEntry[]
    selected: boolean
    disabled: boolean
    disabledReason: string | null
    onSelect: () => void
}

// The newer create form's option row (its `rowClass`): the whole card is the
// control, selection is a ring plus a check, and the ring never depends on a
// separate indicator dot.
const runtimeTargetClass = (active: boolean, disabled: boolean): string =>
    [
        'shadow-ring-light focus-visible:shadow-focus w-full rounded-md px-3.5 py-3 text-left transition-[color,background-color,box-shadow] focus:outline-none',
        disabled
            ? 'bg-surface text-muted cursor-not-allowed opacity-55'
            : active
              ? 'bg-info-bg text-fg ring-link/40 ring-2'
              : 'bg-surface text-muted hover:bg-surface-hover hover:text-fg'
    ].join(' ')

const RuntimeTargetStatusTag: FC<{ status: RuntimeTargetStatus }> = ({
    status
}): ReactNode =>
    status.tone === 'offline' ? (
        <span className='text-muted text-caption inline-flex shrink-0 items-center gap-1'>
            <PlugIcon className='h-3.5 w-3.5' />
            {status.label}
        </span>
    ) : status.tone === 'progress' ? (
        <span className='text-subtle text-caption inline-flex shrink-0 items-center gap-1.5'>
            <Spinner size={12} />
            {status.label}
        </span>
    ) : (
        <span className='text-subtle text-caption inline-flex shrink-0 items-center gap-1.5'>
            <span
                className={`${STATUS_DOT[status.tone]} h-1.5 w-1.5 rounded-full`}
            />
            {status.label}
        </span>
    )

const FrameworkLogo: FC<{
    framework: FrameworkChoice
    className?: string
}> = ({ framework, className = '' }): ReactNode => {
    return (
        <span
            className={[
                'inline-flex shrink-0 items-center justify-center',
                className
            ].join(' ')}
            aria-hidden='true'
        >
            <FrameworkLogoMark framework={framework} size={28} />
        </span>
    )
}

const RuntimeAgentIcons: FC<{
    frameworks: CreateableFramework[]
    label: string
}> = ({ frameworks, label }): ReactNode => (
    <span
        className='flex flex-wrap items-center gap-1.5'
        role='img'
        aria-label={label}
    >
        {frameworks.map((framework) => {
            const option =
                frameworkOptions.find((opt) => opt.value === framework) ??
                frameworkOptions[0]
            return (
                <ShortcutTooltip key={framework} label={option.label}>
                    <FrameworkLogo framework={framework} className='h-7 w-7' />
                </ShortcutTooltip>
            )
        })}
    </span>
)

// "who is already here", per framework: the logo, then how many agents that
// framework's runtime carries. A framework with no agents still shows (at
// zero) — that it is installed at all is what decides whether this machine
// needs provisioning.
// Icon, not word, for the kinds: four names in a row cost more width than the
// list they filter. The name survives as the accessible name and the tooltip,
// so the control is not a rebus for anyone who needs the text. "All" keeps its
// word — it has no object to draw, and it is the state the picker opens in.
// The two comparison tables are reference material, not steps: as words they
// read like the next thing to do, and they sat on the same line as the control
// they annotate. A question mark keeps them reachable and stops them competing
// with the label beside them; the name lives in the tooltip and the accessible
// name.
const CompareButton: FC<{ label: string; onOpen: () => void }> = ({
    label,
    onOpen
}): ReactNode => (
    <ShortcutTooltip label={label} placement='bottom-start'>
        <button
            type='button'
            aria-label={label}
            onClick={onOpen}
            className='text-subtle hover:text-fg hover:bg-surface-hover focus-visible:shadow-focus inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-[color,background-color,box-shadow] focus:outline-none'
        >
            <HelpIcon className='h-4 w-4' aria-hidden='true' />
        </button>
    </ShortcutTooltip>
)

const RuntimePopulation: FC<{
    population: RuntimeTargetPopulation[]
    labelFor: (entry: RuntimeTargetPopulation) => string
}> = ({ population, labelFor }): ReactNode => {
    if (population.length === 0) return null
    return (
        <span className='flex flex-wrap items-center gap-x-2.5 gap-y-1'>
            {population.map((entry) => (
                <span
                    key={entry.framework}
                    className='text-subtle text-caption inline-flex shrink-0 items-center gap-1 tabular-nums'
                    title={labelFor(entry)}
                    aria-label={labelFor(entry)}
                >
                    <FrameworkLogoMark framework={entry.framework} size={14} />×
                    {entry.agents}
                </span>
            ))}
        </span>
    )
}

// The newer form's option anatomy — tag chip, ring selection, a check, a status
// dot — restacked for a two-column grid: its rows are full width, so name and
// status share one line there and cannot here.
const RuntimeTargetCard: FC<{
    target: RuntimeTarget
    kindLabel: string
    populationLabelFor: (entry: RuntimeTargetPopulation) => string
    onFrameworkAction?: (
        framework: AgentFramework,
        action: HostFrameworkAction
    ) => void
    frameworkBusy?: string | null
    frameworkError?: { framework: string; message: string } | null
}> = ({
    target,
    kindLabel,
    populationLabelFor,
    onFrameworkAction,
    frameworkBusy = null,
    frameworkError = null
}): ReactNode => {
    const { t } = useI18n()
    // The whole card picks, through a transparent button under the content;
    // the sandbox's framework icons and the menu sit above it and take their
    // own clicks.
    return (
        <div
            className={`${runtimeTargetClass(target.selected, target.disabled)} relative flex flex-col`}
        >
            <button
                type='button'
                disabled={target.disabled}
                onClick={target.onSelect}
                aria-pressed={target.selected}
                aria-label={target.name}
                className='focus-visible:shadow-focus absolute inset-0 rounded-md transition-[box-shadow] focus:outline-none disabled:cursor-not-allowed'
            />
            <span className='pointer-events-none relative flex items-center justify-between gap-2'>
                <span className='flex min-w-0 items-center gap-2'>
                    <span className='tag tag-neutral'>{kindLabel}</span>
                    <span className='text-fg text-ui min-w-0 truncate font-medium'>
                        {target.name}
                    </span>
                </span>
                <span className='flex shrink-0 items-center gap-2.5'>
                    {target.disabled && target.disabledReason ? (
                        <span className='text-muted text-caption'>
                            {target.disabledReason}
                        </span>
                    ) : (
                        target.status && (
                            <RuntimeTargetStatusTag status={target.status} />
                        )
                    )}
                    {target.selected && (
                        <CheckIcon className='text-link h-4 w-4 shrink-0' />
                    )}
                </span>
            </span>
            {(target.frameworks && onFrameworkAction) ||
            target.population.length > 0 ||
            target.menu ? (
                // The second line: what runs here on the left, the card's own
                // menu bottom-right; only those two take clicks, the rest of
                // the line falls through to the pick.
                <span className='pointer-events-none relative mt-1.5 flex items-end justify-between gap-2 [&>*]:pointer-events-auto'>
                    {target.frameworks && onFrameworkAction ? (
                        <span className='mt-0.5 block'>
                            <HostFrameworkIcons
                                entries={target.frameworks}
                                busyFramework={frameworkBusy}
                                error={frameworkError}
                                onAction={onFrameworkAction}
                            />
                        </span>
                    ) : (
                        <span className='pointer-events-none block min-w-0'>
                            {target.population.length > 0 && (
                                <RuntimePopulation
                                    population={target.population}
                                    labelFor={populationLabelFor}
                                />
                            )}
                        </span>
                    )}
                    {target.menu && (
                        <span className='-mb-1 -mr-1.5 shrink-0'>
                            <OverflowMenu
                                compact
                                ariaLabel={`${target.name} · ${t('common.moreActions')}`}
                                items={target.menu}
                            />
                        </span>
                    )}
                </span>
            ) : null}
        </div>
    )
}

// The coding CLIs every sprite image ships; the only frameworks a sandbox
// installs or upgrades in place. The other sandbox frameworks (OpenClaw,
// Hermes, NarraNexus) arrive with their first agent.
const SANDBOX_CLI_FRAMEWORKS: AgentFramework[] = [
    'claude-code',
    'codex',
    'gemini-cli'
]
// Every framework a sandbox can hold, in the order the cards show them.
const SANDBOX_FRAMEWORKS: AgentFramework[] = versionedFrameworks.filter(
    (framework) => supportsRuntime(framework, 'sprites')
)

const targetHeadCell = 'px-3 py-2 font-medium'
const targetBodyCell = 'text-caption text-muted px-3 py-2'

const RuntimeTargetTable: FC<{
    targets: RuntimeTarget[]
    kindLabelFor: (kind: RuntimeTargetKind) => string
    populationLabelFor: (entry: RuntimeTargetPopulation) => string
    columns: { runtime: string; kind: string; status: string; agents: string }
}> = ({ targets, kindLabelFor, populationLabelFor, columns }): ReactNode => (
    <div className='settings-card overflow-x-auto'>
        <table className='w-full min-w-[32rem] text-left'>
            <thead className='workbench-table-head'>
                <tr>
                    <th className={targetHeadCell}>{columns.runtime}</th>
                    <th className={targetHeadCell}>{columns.kind}</th>
                    <th className={targetHeadCell}>{columns.status}</th>
                    <th className={`${targetHeadCell} text-right`}>
                        {columns.agents}
                    </th>
                </tr>
            </thead>
            <tbody>
                {targets.map((target) => (
                    <tr
                        key={target.key}
                        tabIndex={target.disabled ? -1 : 0}
                        aria-selected={target.selected}
                        onClick={() => {
                            if (!target.disabled) target.onSelect()
                        }}
                        onKeyDown={(event) => {
                            if (target.disabled) return
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                target.onSelect()
                            }
                        }}
                        className={[
                            'border-divider/60 border-t transition-colors',
                            target.disabled
                                ? 'cursor-not-allowed opacity-55'
                                : 'hover:bg-surface-hover cursor-pointer',
                            target.selected ? 'bg-info-bg' : ''
                        ].join(' ')}
                    >
                        <td className='px-3 py-2'>
                            <span className='flex min-w-0 items-center gap-2'>
                                {target.selected ? (
                                    <CheckIcon className='text-link h-4 w-4 shrink-0' />
                                ) : (
                                    <span
                                        className='h-4 w-4 shrink-0'
                                        aria-hidden='true'
                                    />
                                )}
                                <span className='text-caption text-fg min-w-0 truncate font-medium'>
                                    {target.name}
                                </span>
                            </span>
                        </td>
                        <td className={targetBodyCell}>
                            {kindLabelFor(target.kind)}
                        </td>
                        <td className={targetBodyCell}>
                            {target.disabled && target.disabledReason ? (
                                target.disabledReason
                            ) : target.status ? (
                                <RuntimeTargetStatusTag
                                    status={target.status}
                                />
                            ) : (
                                <span className='text-placeholder'>—</span>
                            )}
                        </td>
                        <td className={`${targetBodyCell} text-right`}>
                            {target.population.length === 0 ? (
                                <span className='text-placeholder'>—</span>
                            ) : (
                                <span className='inline-flex justify-end'>
                                    <RuntimePopulation
                                        population={target.population}
                                        labelFor={populationLabelFor}
                                    />
                                </span>
                            )}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
)

// One page holds four grid rows; the picker is a step in a form, not a
// dashboard, so it should not grow past that no matter how many runtimes the
// account carries.
const RUNTIME_PAGE_SIZE = 8

// First, last, and the current page's neighbours; gaps collapse to an ellipsis
// so the control's width stays bounded as the runtime count grows.
const runtimePagerEntries = (
    page: number,
    pageCount: number
): Array<number | 'gap'> => {
    if (pageCount <= 7)
        return Array.from({ length: pageCount }, (_, index) => index + 1)
    const shown = new Set([1, pageCount, page - 1, page, page + 1])
    const entries: Array<number | 'gap'> = []
    let previous = 0
    for (let n = 1; n <= pageCount; n += 1) {
        if (!shown.has(n)) continue
        if (previous && n - previous > 1) entries.push('gap')
        entries.push(n)
        previous = n
    }
    return entries
}

const runtimePagerButtonClass = (active: boolean): string =>
    [
        'text-caption inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-sm px-2 tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'text-muted hover:bg-surface-hover'
    ].join(' ')

const RuntimePager: FC<{
    page: number
    pageCount: number
    onChange: (page: number) => void
    labels: { group: string; previous: string; next: string }
}> = ({ page, pageCount, onChange, labels }): ReactNode => (
    <nav
        aria-label={labels.group}
        className='mt-2 flex flex-wrap items-center justify-center gap-1'
    >
        <button
            type='button'
            aria-label={labels.previous}
            disabled={page <= 1}
            onClick={() => onChange(page - 1)}
            className={runtimePagerButtonClass(false)}
        >
            <ChevronLeftIcon className='h-4 w-4' />
        </button>
        {runtimePagerEntries(page, pageCount).map((entry, index) =>
            entry === 'gap' ? (
                <span
                    key={`gap-${index}`}
                    aria-hidden='true'
                    className='text-subtle text-caption px-1'
                >
                    …
                </span>
            ) : (
                <button
                    key={entry}
                    type='button'
                    aria-current={entry === page ? 'page' : undefined}
                    onClick={() => onChange(entry)}
                    className={runtimePagerButtonClass(entry === page)}
                >
                    {entry}
                </button>
            )
        )}
        <button
            type='button'
            aria-label={labels.next}
            disabled={page >= pageCount}
            onClick={() => onChange(page + 1)}
            className={runtimePagerButtonClass(false)}
        >
            <ChevronRightIcon className='h-4 w-4' />
        </button>
    </nav>
)

interface ExternalAgentSectionProps {
    framework: FrameworkChoice
    providers: UserExternalAgentProviderSummary[]
    providersError: string | null
    providerId: string
    onProviderIdChange: (id: string) => void
    remoteId: string
    onRemoteIdChange: (id: string) => void
}

const ExternalAgentSection: FC<ExternalAgentSectionProps> = ({
    framework,
    providers,
    providersError,
    providerId,
    onProviderIdChange,
    remoteId,
    onRemoteIdChange
}): ReactNode => {
    const { t } = useI18n()
    const providerKindLabel =
        framework === 'a2a'
            ? 'A2A'
            : framework === 'langflow'
              ? 'Langflow'
              : 'Dify'
    return (
        <div className='space-y-4'>
            <div>
                <span className='workbench-field-label mb-1 block'>
                    {t('web.agentNew.externalProviderLabel', {
                        provider: providerKindLabel
                    })}
                </span>
                {providers.length === 0 ? (
                    <div className='border-divider rounded-md border border-dashed bg-white p-4'>
                        <p className='text-caption text-muted mb-2'>
                            {t('web.agentNew.noExternalProviderConfigured', {
                                provider: providerKindLabel.toLowerCase()
                            })}
                        </p>
                        <Link
                            to='/settings/runtimes/external-agent-providers'
                            className='text-caption text-link hover:text-fg font-medium'
                        >
                            {t('web.agentNew.manageExternalProviders')}
                        </Link>
                    </div>
                ) : (
                    <WorkbenchSelect
                        mono
                        ariaLabel={t('web.agentNew.externalProviderLabel', {
                            provider: providerKindLabel
                        })}
                        value={providerId}
                        onChange={onProviderIdChange}
                        options={providers.map((p) => ({
                            value: p.id,
                            label: `${p.label} · ${p.endpointUrl}`
                        }))}
                    />
                )}
                {providersError && (
                    <p className='text-caption text-accent-ruby mt-1'>
                        {providersError}
                    </p>
                )}
                <p className='workbench-hint mt-2'>
                    {t('web.agentNew.externalProviderHint')}{' '}
                    <Link
                        to='/settings/runtimes/external-agent-providers'
                        className='text-link hover:text-fg'
                    >
                        {t('web.agentNew.externalAgentsSettings')}
                    </Link>
                    .
                </p>
            </div>
            {framework === 'langflow' && (
                <label className='block'>
                    <span className='workbench-field-label'>
                        {remoteIdLabelFor(framework, t)}
                    </span>
                    <input
                        required
                        value={remoteId}
                        onChange={(e) => onRemoteIdChange(e.target.value)}
                        placeholder={remoteIdPlaceholderFor(framework, t)}
                        className='workbench-input font-mono'
                    />
                    <p className='workbench-hint mt-2'>
                        {remoteIdHintFor(framework, t)}
                    </p>
                </label>
            )}
        </div>
    )
}

const AgentNew: FC = (): ReactNode => {
    const { t } = useI18n()
    const localizedFrameworkOptions = frameworkOptions.map((option) => ({
        ...option,
        description: t(option.descriptionKey)
    }))
    const navigate = useNavigate()
    const client = useApiClient()
    const { refreshAgents, agents: allAgents } = useAppShellContext()
    const [params] = useSearchParams()
    const initialRuntimeId = params.get('runtimeId') ?? ''
    const initialDaemonId = params.get('daemonId') ?? ''
    const initialSandboxId = params.get('sandboxId') ?? ''
    const initialFramework = params.get('framework') ?? ''
    const initialVersion = params.get('version') ?? ''

    const create = useAgentCreate()
    const {
        providers,
        setProviders,
        externalProviders,
        externalProvidersError,
        runtimes,
        runtimesError,
        refetchRuntimes,
        refetchSandboxes,
        setRuntimes,
        sandboxes,
        runtimeAccess,
        runtimeAgents,
        runtimeAgentsLoading,
        runtimeAgentsError,
        loadExternalProviders,
        fetchRuntimeAgents,
        busy,
        progress,
        error,
        setError,
        resetProgress,
        submitCreateStream,
        submitAddToRuntime,
        refetchProviders
    } = create

    const [framework, setFramework] = useState<CreateableFramework>(() =>
        localizedFrameworkOptions.some((o) => o.value === initialFramework)
            ? (initialFramework as CreateableFramework)
            : 'claude-code'
    )
    const [name, setName] = useState(randomAgentName)
    const [workspacePath, setWorkspacePath] = useState('')
    const [workspaceDraftPath, setWorkspaceDraftPath] = useState('')
    const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
    const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
        initialRuntimeId ? 'existing' : 'sandbox'
    )
    const [runtimeView, setRuntimeView] = useState<DashboardView>(() =>
        readDashboardView(AGENT_NEW_RUNTIME_VIEW_KEY)
    )
    const [runtimeKindFilter, setRuntimeKindFilter] =
        useState<RuntimeKindFilter>('all')
    const [runtimePage, setRuntimePage] = useState(1)
    const [existingRuntimeModel, setExistingRuntimeModel] = useState('')
    const [connectDaemonOpen, setConnectDaemonOpen] = useState(false)
    const [sandboxDialogOpen, setSandboxDialogOpen] = useState(false)
    const [sandboxDraftName, setSandboxDraftName] = useState('')
    const [sandboxCreating, setSandboxCreating] = useState(false)
    // Set when a target must be brought on screen after the list reloads — the
    // page it lands on is only knowable once the reloaded list is rendered.
    const [revealTargetKey, setRevealTargetKey] = useState<string | null>(null)
    const [runtimeCompareDialogOpen, setRuntimeCompareDialogOpen] =
        useState(false)
    const [frameworkCompareDialogOpen, setFrameworkCompareDialogOpen] =
        useState(false)
    const [modelProviderHelpOpen, setModelProviderHelpOpen] = useState(false)
    const [advancedConfigHelpOpen, setAdvancedConfigHelpOpen] = useState(false)
    // The catalog's latest per coding CLI, for the sandbox cards' icons.
    const [frameworkLatestByFramework, setFrameworkLatestByFramework] =
        useState<ReadonlyMap<string, string | null>>(new Map())
    const [hostFrameworkBusy, setHostFrameworkBusy] = useState<{
        hostId: string
        framework: string
    } | null>(null)
    const [hostFrameworkError, setHostFrameworkError] = useState<{
        hostId: string
        framework: string
        message: string
    } | null>(null)
    // Bringing a bare sandbox's runtime up so an account can be added on it
    // before any agent exists; the key hands the one click on to the list.
    const [accountPrepareHostId, setAccountPrepareHostId] = useState<
        string | null
    >(null)
    const [accountPrepareError, setAccountPrepareError] = useState<{
        hostId: string
        message: string
    } | null>(null)
    // Which step of bringing a sandbox to its accounts is running; the
    // create button carries it as its label while it does.
    const [accountPrepareStep, setAccountPrepareStep] = useState<
        'check' | 'install' | 'prepare' | null
    >(null)
    const [autoAddAccountKey, setAutoAddAccountKey] = useState<string | null>(
        null
    )
    // The runtime cards' own menu: rename in place, delete when nothing runs
    // there. `targetActionKey` is the card whose action is in flight.
    const { confirm, confirmDialog } = useProductConfirm()
    const [renameTarget, setRenameTarget] = useState<{
        kind: 'sandbox' | 'runtime'
        id: string
        name: string
    } | null>(null)
    const [targetActionKey, setTargetActionKey] = useState<string | null>(null)
    const [pickedRuntimeId, setPickedRuntimeId] = useState(initialRuntimeId)
    const [attachSandboxHostId, setAttachSandboxHostId] = useState('')
    // The sandbox the user chose themselves (a click, a deep link, one they
    // just created) as opposed to the list's own default pick: only that
    // intent brings a runtime up on the sandbox unasked.
    const [userPickedSandboxId, setUserPickedSandboxId] = useState<
        string | null
    >(null)
    const autoPickingRef = useRef(false)
    const [frameworkVersionSel, setFrameworkVersionSel] = useState(() =>
        /^v?\d+\.\d+\.\d+$/.test(initialVersion) ? initialVersion : ''
    )
    const [persistentModelProvider, setPersistentModelProvider] =
        useState<PersistentModelProvider>('anthropic')
    const [primaryModelName, setPrimaryModelName] = useState('')
    const [primaryModelCustom, setPrimaryModelCustom] = useState(false)
    const [cloneEnabled, setCloneEnabled] = useState(false)
    const [cloneFromProfile, setCloneFromProfile] = useState('')
    const [picker, setPicker] = useState<ProviderPickerValue>(() =>
        initialPickerForFramework(
            framework,
            initialRuntimeId
                ? { runtimeMode: 'existing', runtimeKind: null }
                : NEW_RUNTIME_TARGET
        )
    )
    const [localCredentials, setLocalCredentials] =
        useState<LocalCredentialSelection>(INITIAL_LOCAL_CREDENTIALS)
    const [providerSourceFilter, setProviderSourceFilter] =
        useState<ProviderSourceFilter>('all')
    const [providerFamilyFilter, setProviderFamilyFilter] =
        useState<ProviderFamilyFilter>('all')
    const [addProvider, setAddProvider] =
        useState<ModelProviderCreatePick | null>(null)
    const [externalProviderId, setExternalProviderId] = useState('')
    const [externalRemoteId, setExternalRemoteId] = useState('')

    const credentialProvider = modelProviderForFramework(framework)
    const modelProviderForRuntime: UserModelProvider =
        usesConfigurableModelProvider(framework)
            ? persistentModelProvider
            : credentialProvider
    // The families the Cloud list draws from, the current one first so a
    // built-in that speaks both protocols keeps counting for it.
    const providerFamilies = useMemo<readonly UserModelProvider[]>(() => {
        const all = providerFamiliesFor(framework, credentialProvider)
        return all.includes(modelProviderForRuntime)
            ? [
                  modelProviderForRuntime,
                  ...all.filter((f) => f !== modelProviderForRuntime)
              ]
            : all
    }, [credentialProvider, framework, modelProviderForRuntime])

    const modelConfig = useFrameworkModelConfig({
        framework,
        runtimeMode,
        picker,
        providers,
        setProviders,
        modelProviderForRuntime
    })
    const frameworkModelConfig = modelConfig.draft
    const setFrameworkModelConfig = modelConfig.setDraft
    const frameworkModelConfigRequired = modelConfig.required
    const frameworkModelConfigView = modelConfig.view
    const frameworkModelValidation = modelConfig.validation
    const frameworkProviderTesting = modelConfig.testing
    const frameworkProviderTestError = modelConfig.testError
    const providerTestLabel = modelConfig.providerTestLabel
    const providerTestDisabled = modelConfig.providerTestDisabled
    const selectedSavedProvider = modelConfig.selectedSavedProvider
    const inlineProviderModels = modelConfig.inlineProviderModels
    const runFrameworkProviderTest = modelConfig.runTest
    const requestProviderTest = modelConfig.requestTest

    useEffect(() => {
        if (!isExternalFramework(framework)) return
        void loadExternalProviders(framework as 'dify' | 'langflow' | 'a2a')
    }, [framework, loadExternalProviders])

    useEffect(() => {
        if (!isExternalFramework(framework)) return
        setExternalProviderId((cur) =>
            cur && externalProviders.some((r) => r.id === cur)
                ? cur
                : (externalProviders[0]?.id ?? '')
        )
    }, [externalProviders, framework])

    useEffect(() => {
        if (runtimeMode === 'existing') return
        setPicker((current) => {
            if (current.mode !== 'saved') return current
            const selected = providers.find(
                (option) => option.id === current.providerId
            )
            if (selected && providerFamilyOf(selected, providerFamilies))
                return current

            const preferred = preferredSavedProviderForFamilies(
                providers,
                providerFamilies,
                framework
            )
            if (!preferred) {
                return current.providerId
                    ? { ...current, providerId: '' }
                    : current
            }
            return current.providerId === preferred.id
                ? current
                : { ...current, providerId: preferred.id }
        })
    }, [providerFamilies, providers, runtimeMode, framework])

    // The vendor follows the picked provider for the frameworks that take
    // either: the primary-model defaults and the model list read it.
    useEffect(() => {
        if (!usesConfigurableModelProvider(framework)) return
        if (picker.mode !== 'saved') return
        const selected = providers.find((o) => o.id === picker.providerId)
        if (!selected) return
        const family = providerFamilyOf(selected, providerFamilies)
        if (
            (family === 'anthropic' || family === 'openai') &&
            family !== persistentModelProvider
        )
            setPersistentModelProvider(family)
    }, [
        framework,
        persistentModelProvider,
        picker.mode,
        picker.providerId,
        providerFamilies,
        providers
    ])

    const daemonPreselectedRef = useRef(false)
    useEffect(() => {
        if (daemonPreselectedRef.current) return
        if (!initialDaemonId) return
        if (initialRuntimeId) return
        if (runtimes.length === 0) return
        const onDaemon = runtimes.filter((r) => r.daemonId === initialDaemonId)
        if (onDaemon.length === 0) {
            daemonPreselectedRef.current = true
            return
        }
        const pick =
            onDaemon.find((r) => r.framework === framework) ?? onDaemon[0]
        setPickedRuntimeId(pick.id)
        setRuntimeMode('existing')
        if (
            pick.framework !== framework &&
            isCreateableFramework(pick.framework)
        )
            setFramework(pick.framework)
        daemonPreselectedRef.current = true
    }, [initialDaemonId, initialRuntimeId, runtimes, framework])

    const reusable = useMemo(
        () =>
            runtimes.filter(
                (r) =>
                    r.framework === framework &&
                    REUSE_FRAMEWORKS.has(r.framework) &&
                    r.kind !== null &&
                    reuseRuntimeKindsFor(r.framework).has(r.kind) &&
                    r.status === 'ready'
            ),
        [framework, runtimes]
    )

    const spriteTargets = useMemo(
        () => computeSpriteTargets(runtimes, framework, sandboxes),
        [framework, runtimes, sandboxes]
    )
    const spriteReuseRuntimes = useMemo(
        () =>
            spriteTargets.flatMap((t) =>
                t.type === 'reuse' ? [t.runtime] : []
            ),
        [spriteTargets]
    )
    const spriteAttachTargets = useMemo(
        () =>
            spriteTargets.filter(
                (t): t is SpriteAttachTarget => t.type === 'attach'
            ),
        [spriteTargets]
    )

    // 'pending' until the linked host is found (claimed) or the sandbox list
    // says it is gone (given-up). State, not a ref: the auto-select below reads
    // it in the same commit the claim happens, and a ref would flip before the
    // claimed target has rendered as selected — which let the first host win
    // over the link (local stack [2026-09-11], two sandboxes on the account).
    const [sandboxPreselect, setSandboxPreselect] = useState<
        'pending' | 'claimed' | 'given-up'
    >(initialSandboxId ? 'pending' : 'given-up')
    useEffect(() => {
        if (sandboxPreselect !== 'pending') return
        if (!initialSandboxId) return
        const target = spriteAttachTargets.find(
            (t) => t.hostId === initialSandboxId
        )
        if (!target) {
            // Only the sandbox list can hold the linked host; the runtimes
            // usually arrive first, and giving up on their arrival let the
            // first-available pick take the page.
            if (sandboxes.length > 0) setSandboxPreselect('given-up')
            return
        }
        setSandboxPreselect('claimed')
        setRuntimeMode('sandbox')
        setAttachSandboxHostId(target.hostId)
        setUserPickedSandboxId(target.hostId)
        setPickedRuntimeId('')
        // ?sandboxId= can name a host several pages down; selecting it without
        // paging to it would leave the picker showing someone else.
        setRevealTargetKey(`sandbox:${target.hostId}`)
    }, [initialSandboxId, sandboxPreselect, spriteAttachTargets, sandboxes])

    const pickedRuntime = useMemo(
        () => reusable.find((r) => r.id === pickedRuntimeId) ?? null,
        [reusable, pickedRuntimeId]
    )

    const providerTarget = useMemo<ProviderTarget>(
        () =>
            runtimeMode === 'existing'
                ? {
                      runtimeMode: 'existing',
                      runtimeKind: pickedRuntime?.kind ?? null
                  }
                : NEW_RUNTIME_TARGET,
        [runtimeMode, pickedRuntime]
    )
    const providerTargetPicked =
        runtimeMode === 'existing'
            ? pickedRuntime !== null
            : runtimeMode !== 'sandbox' || attachSandboxHostId !== ''

    // The accounts on the picked runtime (a daemon machine or a sandbox with
    // a coding CLI). Loaded per runtime and never waking one on page open;
    // the Local selection resets to that runtime's own default when the list
    // changes hands.
    const runtimeAuthRuntimeId =
        runtimeMode === 'existing' &&
        pickedRuntime &&
        pickedRuntime.kind !== null &&
        isConfigurableFramework(framework) &&
        runtimeAuthSupported(pickedRuntime.framework, pickedRuntime.kind)
            ? pickedRuntime.id
            : null
    const runtimeAuth = useRuntimeAuthList(runtimeAuthRuntimeId)
    const runtimeAuthList = runtimeAuth.list
    const runnerPrewarm = useRunnerPrewarm(
        runtimeAuthRuntimeId,
        pickedRuntime?.kind ?? null,
        runtimeAuth
    )
    const runnerPrewarming = runnerPrewarm.prewarming
    useEffect(() => {
        setLocalCredentials(
            runtimeAuthList
                ? { profileId: initialRuntimeAuthSelection(runtimeAuthList) }
                : INITIAL_LOCAL_CREDENTIALS
        )
    }, [runtimeAuthList])

    // One reset for every way the target changes hands (framework, runtime
    // kind, a daemon connecting, a ?runtimeId= preselect resolving): the
    // Cloud / Local default follows the target, while a chosen provider or a
    // typed key survives the move.
    const providerTargetKey =
        runtimeMode === 'existing'
            ? `existing:${pickedRuntime?.id ?? ''}:${pickedRuntime?.kind ?? ''}`
            : 'new'
    const providerTargetRef = useRef<string | null>(null)
    useEffect(() => {
        const key = `${framework}|${providerTargetKey}`
        if (providerTargetRef.current === key) return
        const first = providerTargetRef.current === null
        providerTargetRef.current = key
        if (first) return
        setPicker((current) => ({
            ...current,
            mode: initialPickerModeFor(framework, providerTarget)
        }))
    }, [framework, providerTargetKey, providerTarget])

    const pickedRuntimeAgents = pickedRuntime
        ? (runtimeAgents[pickedRuntime.id] ?? [])
        : []

    useEffect(() => {
        if (
            runtimeMode !== 'existing' ||
            pickedRuntime?.framework !== 'hermes' ||
            !cloneEnabled
        )
            return
        if (runtimeAgents[pickedRuntime.id]) return
        void fetchRuntimeAgents(pickedRuntime.id)
    }, [
        cloneEnabled,
        fetchRuntimeAgents,
        pickedRuntime,
        runtimeAgents,
        runtimeMode
    ])

    useEffect(() => {
        if (
            runtimeMode !== 'existing' ||
            pickedRuntime?.framework !== 'hermes' ||
            !cloneEnabled
        )
            return
        const rows = runtimeAgents[pickedRuntime.id]
        if (!rows) return
        const preferred =
            rows.find((r) => r.id === 'coder')?.id ??
            rows.find((r) => r.id === 'default')?.id ??
            rows[0]?.id ??
            ''
        setCloneFromProfile((current) =>
            current && rows.some((r) => r.id === current) ? current : preferred
        )
    }, [cloneEnabled, pickedRuntime, runtimeAgents, runtimeMode])

    const streamOpen = progress !== null && !progress.done
    const sandboxLimitReached =
        runtimeAccess !== null &&
        runtimeAccess.statefulSandboxUsage >= runtimeAccess.statefulSandboxLimit
    const persistentLimitReached =
        runtimeAccess !== null &&
        runtimeAccess.alwaysOnlineAgentsUsed >=
            runtimeAccess.alwaysOnlineAgentsLimit
    const cloudComputerAvailable = runtimeAccess?.cloudComputerEnabled === true
    const selectedRuntimeLimitReached =
        runtimeMode === 'sandbox'
            ? attachSandboxHostId
                ? false
                : sandboxLimitReached
            : runtimeMode === 'persistent'
              ? persistentLimitReached
              : false

    const selectFramework = (next: CreateableFramework): void => {
        setFramework(next)
        setPickedRuntimeId('')
        setAttachSandboxHostId('')
        setFrameworkVersionSel('')
        const nextFamilies = usesConfigurableModelProvider(next)
            ? ['openai' as const, 'anthropic' as const]
            : [modelProviderForFramework(next)]
        const preferred = preferredSavedProviderForFamilies(
            providers,
            nextFamilies,
            next
        )
        // OpenClaw / Hermes take either vendor: the one the preferred saved
        // provider speaks, else OpenAI as before.
        const preferredFamily = preferred
            ? providerFamilyOf(preferred, nextFamilies)
            : null
        const nextPersistentProvider: PersistentModelProvider =
            usesConfigurableModelProvider(next)
                ? preferredFamily === 'anthropic'
                    ? 'anthropic'
                    : 'openai'
                : modelProviderForFramework(next) === 'google'
                  ? 'anthropic'
                  : (modelProviderForFramework(next) as PersistentModelProvider)
        setPersistentModelProvider(nextPersistentProvider)
        setProviderFamilyFilter('all')
        const nextTargetProvider: UserModelProvider =
            usesConfigurableModelProvider(next)
                ? nextPersistentProvider
                : modelProviderForFramework(next)
        const pickerBase = initialPickerForFramework(next)
        setPicker(
            pickerBase.mode === 'saved' && preferred
                ? { ...pickerBase, providerId: preferred.id }
                : pickerBase
        )
        const nextPrimaryModel =
            usesConfigurableModelProvider(next) && preferred
                ? (preferredPrimaryModelDefault(
                      flattenSavedModels(preferred.lastTestModels),
                      nextTargetProvider
                  ) ?? '')
                : ''
        setPrimaryModelName(nextPrimaryModel)
        setFrameworkModelConfig(null)
        setPrimaryModelCustom(false)
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
        setExternalProviderId('')
        setExternalRemoteId('')
        setRuntimeKindFilter('all')
        setRuntimePage(1)
        setExistingRuntimeModel('')
        if (isK8sOnlyFramework(next)) {
            setRuntimeMode('persistent')
        } else if (runtimeMode === 'existing') {
            setRuntimeMode('sandbox')
        }
    }

    const selectRuntimeCategory = (next: 'sandbox' | 'persistent'): void => {
        if (next === 'sandbox' && !supportsSandbox(framework)) return
        if (next === 'persistent' && !cloudComputerAvailable) return
        setRuntimeMode(next)
        setPickedRuntimeId('')
        setAttachSandboxHostId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const selectExistingRuntimeTarget = (
        runtime: AgentRuntimeSummary
    ): void => {
        if (runtimeMode === 'existing' && pickedRuntimeId === runtime.id) return
        setRuntimeMode('existing')
        setPickedRuntimeId(runtime.id)
        setAttachSandboxHostId('')
        setExistingRuntimeModel('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const selectAttachSandboxTarget = (target: SpriteAttachTarget): void => {
        // Clicking the card the list picked by default is the user's own
        // pick of it: the intent counts even when the selection does not move.
        if (!autoPickingRef.current) setUserPickedSandboxId(target.hostId)
        if (runtimeMode === 'sandbox' && attachSandboxHostId === target.hostId)
            return
        setRuntimeMode('sandbox')
        setAttachSandboxHostId(target.hostId)
        if (autoPickingRef.current) setUserPickedSandboxId(null)
        setPickedRuntimeId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const openSandboxDialog = (): void => {
        // Mirrors the server's auto-name (sandbox-001, sandbox-002, …) so the
        // prefilled value is the one the user would have got by leaving the
        // standalone form blank — editable, not decorative.
        const used = sandboxes
            .map((sandbox) => /^sandbox-(\d+)$/.exec(sandbox.name ?? '')?.[1])
            .flatMap((digits) => (digits ? [Number(digits)] : []))
        const next = Math.max(sandboxes.length, ...used, 0) + 1
        setSandboxDraftName(`sandbox-${String(next).padStart(3, '0')}`)
        setSandboxDialogOpen(true)
    }

    // The dialog closes on the click; the minute the VM takes shows on the
    // create button (disabled, "Creating the sandbox…"), where the steps
    // that follow — check, prepare, runner — show too, so the form cannot be
    // submitted halfway through.
    const createSandbox = async (): Promise<void> => {
        const validation = validateAgentName(sandboxDraftName)
        if (!validation.valid || sandboxCreating) return
        setSandboxCreating(true)
        setError(null)
        setSandboxDialogOpen(false)
        try {
            const created = await client.sandboxes.create({
                name: validation.value
            })
            await Promise.all([refetchRuntimes(), refetchSandboxes()])
            setRuntimeMode('sandbox')
            setAttachSandboxHostId(created.id)
            setUserPickedSandboxId(created.id)
            setPickedRuntimeId('')
            setRuntimeKindFilter('all')
            setRevealTargetKey(`sandbox:${created.id}`)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSandboxCreating(false)
        }
    }

    // The dialog only offers "use this machine" once the host reports the
    // framework, so a runtime row for it exists (or is moments away) by the
    // time this runs.
    const handleDaemonConnected = async (
        host: DaemonHostSummary
    ): Promise<void> => {
        setConnectDaemonOpen(false)
        const rows = await client.agentRuntimes.list().catch(() => null)
        if (!rows) return
        setRuntimes(rows)
        const connected =
            rows.find(
                (r) =>
                    r.kind === 'daemon' &&
                    r.daemonId === host.id &&
                    r.framework === framework
            ) ?? rows.find((r) => r.kind === 'daemon' && r.daemonId === host.id)
        if (!connected) return
        setRuntimeMode('existing')
        setPickedRuntimeId(connected.id)
        setAttachSandboxHostId('')
        setRuntimeKindFilter('all')
        setRevealTargetKey(`runtime:${connected.id}`)
    }

    const changeRuntimeView = (next: DashboardView): void => {
        setRuntimeView(next)
        writeDashboardView(AGENT_NEW_RUNTIME_VIEW_KEY, next)
    }

    const randomizeName = (): void => {
        setName(randomAgentName())
    }

    const sandboxNameValidation = validateAgentName(sandboxDraftName)
    const sandboxNameValidationMessage = sandboxNameValidation.valid
        ? null
        : sandboxNameValidation.message

    const nameValidation = validateAgentName(name)
    const normalizedName = nameValidation.valid
        ? nameValidation.value
        : normalizeAgentName(name)
    const nameValidationMessage =
        nameValidation.valid || name.length === 0
            ? null
            : nameValidation.message
    const workspaceInputEnabled =
        runtimeMode === 'existing'
            ? pickedRuntime !== null && pickedRuntime.framework !== 'hermes'
            : framework !== 'hermes'
    const requestedWorkspacePath = workspaceInputEnabled
        ? workspacePath.trim()
        : ''
    const workspaceValidationMessage = validateWorkspacePath(
        requestedWorkspacePath
    )
    const workspaceForRequest =
        requestedWorkspacePath && !workspaceValidationMessage
            ? requestedWorkspacePath
            : undefined
    const requestedWorkspaceDraftPath = workspaceInputEnabled
        ? workspaceDraftPath.trim()
        : ''
    const workspaceDraftValidationMessage = validateWorkspacePath(
        requestedWorkspaceDraftPath
    )
    void inlineProviderModels

    // Adding an agent to a runtime inherits that runtime's provider and key.
    // For a coding framework the form shows those credentials as the Local
    // list — its host sign-in row IS the inherited binding — beside the saved
    // providers, so a Cloud pick is always an explicit provider: the same
    // PATCH the agent's own credentials dialog issues, and because the stored
    // credential belongs to the runtime it lands for every agent on it. The
    // frameworks without that list (openclaw, hermes, the external ones,
    // narranexus — none of them configurable) simply inherit; the API rejects
    // a credentials change for the last two anyway.
    const providerInherited =
        runtimeMode === 'existing' && !isConfigurableFramework(framework)

    // What the create button says while the picked sandbox is still on its
    // way to being usable: creating, checked, prepared, its runner starting.
    // The button is disabled for the duration, so the form cannot be
    // submitted around a step that is still running.
    const submitProgressLabel: string | null = sandboxCreating
        ? t('web.agentNew.creatingSandbox')
        : accountPrepareStep === 'check'
          ? t('web.agentNew.checkingSandbox')
          : accountPrepareStep === 'install'
            ? t('web.agentNew.installingFramework', {
                  framework: frameworkLabel(framework)
              })
            : accountPrepareStep === 'prepare'
              ? t('web.agentNew.preparingSandbox')
              : runnerPrewarming
                ? runnerPrewarm.waitingForSlot
                    ? t('web.agentNew.waitingForSlot')
                    : t('web.agentNew.runnerStarting')
                : null

    const canSubmit = (() => {
        if (busy || streamOpen) return false
        if (submitProgressLabel !== null) return false
        if (!nameValidation.valid) return false
        if (isExternalFramework(framework)) {
            if (externalProviderId.trim().length === 0) return false
            if (framework === 'langflow')
                return externalRemoteId.trim().length > 0
            return true
        }
        if (workspaceValidationMessage) return false
        if (selectedRuntimeLimitReached) return false
        if (frameworkModelConfigRequired && !frameworkModelValidation.valid)
            return false
        if (runtimeMode === 'existing') {
            if (!pickedRuntime) return false
            if (pickedRuntime.framework === 'hermes' && cloneEnabled) {
                return (
                    !runtimeAgentsLoading &&
                    !runtimeAgentsError &&
                    cloneFromProfile.trim().length > 0
                )
            }
            return (
                providerInherited ||
                (pickerIsValid(picker) &&
                    localSelectionValid({
                        target: providerTarget,
                        local: localCredentials,
                        list: runtimeAuth.list
                    }))
            )
        }
        // A sandbox target is always an existing host now — creating one is a
        // separate step, so an unattached 'sandbox' mode means nothing is
        // picked yet.
        if (runtimeMode === 'sandbox' && !attachSandboxHostId) return false
        if (runtimeMode === 'persistent') return false
        // NarraNexus manages its provider in its own UI; nothing to pick.
        if (framework === 'narranexus') return true
        return pickerIsValid(picker)
    })()

    const selectedFramework =
        localizedFrameworkOptions.find((opt) => opt.value === framework) ??
        localizedFrameworkOptions[0]
    const selectedRuntimeCategory: RuntimeCategory =
        runtimeMode === 'sandbox'
            ? 'sandbox'
            : runtimeMode === 'persistent'
              ? 'persistent'
              : runtimeMode === 'existing' && pickedRuntime
                ? pickedRuntime.kind === 'sprites'
                    ? 'sandbox'
                    : pickedRuntime.kind === 'daemon'
                      ? 'daemon'
                      : 'persistent'
                : reuseRuntimeKindsFor(framework).has('sprites') &&
                    !reuseRuntimeKindsFor(framework).has('k8s')
                  ? 'sandbox'
                  : 'persistent'
    const existingRuntimeOptionsByKind = {
        sprites: spriteReuseRuntimes,
        k8s: reusable.filter((r) => r.kind === 'k8s'),
        daemon: reusable.filter((r) => r.kind === 'daemon')
    }
    const daemonSupported = reuseRuntimeKindsFor(framework).has('daemon')
    const selectedRuntimeLabel =
        selectedRuntimeCategory === 'sandbox'
            ? t('web.agentNew.sandbox')
            : selectedRuntimeCategory === 'daemon'
              ? t('web.agentNew.localDaemon')
              : t('web.agentNew.persistent')
    const runtimeQuotaItems = runtimeAccess
        ? [
              {
                  category: 'sandbox' as const,
                  label: t('web.agentNew.statefulSandbox'),
                  usage: runtimeAccess.statefulSandboxUsage,
                  limit: runtimeAccess.statefulSandboxLimit,
                  reached: sandboxLimitReached
              },
              {
                  category: 'persistent' as const,
                  label: t('web.agentNew.alwaysOnlineRented'),
                  usage: runtimeAccess.alwaysOnlineAgentsUsed,
                  limit: runtimeAccess.alwaysOnlineAgentsLimit,
                  reached: persistentLimitReached
              }
          ]
        : []
    const runtimeQuotaLabel = (category: RuntimeCategory): string | null => {
        const lookup: RuntimeCategory =
            category === 'daemon' ? 'persistent' : category
        const item = runtimeQuotaItems.find(
            (quota) => quota.category === lookup
        )
        return item
            ? t('web.agentNew.runtimeUsed', {
                  used: `${item.usage}/${item.limit}`
              })
            : null
    }
    // Same table the provision-elsewhere links read, so a kind's icon here and
    // its icon there can never be two different decisions.
    const runtimeKindIcon = (kind: RuntimeTargetKind): LucideIcon =>
        NEW_RUNTIME_OPTIONS.find((option) => option.kind === kind)?.icon ??
        RuntimeIcon

    const runtimeKindLabel = (kind: RuntimeTargetKind): string =>
        kind === 'sprites'
            ? t('web.agentNew.sandbox')
            : kind === 'k8s'
              ? t('web.agentNew.persistent')
              : t('web.agentNew.localDaemon')

    // A machine's population, keyed by host: a sandbox VM (and a daemon) runs
    // one runtime per framework, so the picker can say who already lives there
    // rather than only counting the runtime that matched the framework filter.
    const populationByHost = useMemo(() => {
        const out = new Map<string, RuntimeTargetPopulation[]>()
        for (const r of runtimes) {
            const key = r.hostId ?? r.id
            const list = out.get(key) ?? []
            const existing = list.find(
                (entry) => entry.framework === r.framework
            )
            if (existing) existing.agents += r.agentsCount
            else list.push({ framework: r.framework, agents: r.agentsCount })
            out.set(key, list)
        }
        for (const list of out.values())
            list.sort(
                (a, b) =>
                    b.agents - a.agents ||
                    a.framework.localeCompare(b.framework)
            )
        return out
    }, [runtimes])

    useEffect(() => {
        let cancelled = false
        client.frameworkVersions
            .list()
            .then((catalog) => {
                if (cancelled) return
                setFrameworkLatestByFramework(
                    new Map(
                        catalog.map((entry) => [entry.framework, entry.latest])
                    )
                )
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [client])

    // Every coding CLI the sprite image can hold, on one sandbox: the probe's
    // version, the catalog's latest and who runs on it. A sandbox never probed
    // reports nothing installed, which the icons show as "not checked".
    const hostFrameworkEntries = (hostId: string): HostFrameworkEntry[] => {
        const sandbox = sandboxes.find((s) => s.id === hostId) ?? null
        const onHostRuntimes = runtimes.filter((r) => r.hostId === hostId)
        // The agents on this host: through their runtime, or — for one whose
        // runtime row is not in this list — the sprite they share with it.
        const runtimeIds = new Set(onHostRuntimes.map((r) => r.id))
        const spriteName = sandbox?.spriteName ?? null
        const onHost = allAgents.filter(
            (agent) =>
                (agent.runtimeId !== null && runtimeIds.has(agent.runtimeId)) ||
                (spriteName !== null && agent.spriteName === spriteName)
        )
        // The service framework already on the sandbox's one public port, if
        // any: the other two cannot be installed beside it.
        const occupant = serviceSlotOccupant(
            onHostRuntimes
                .filter((r) => r.status !== 'failed' && r.status !== 'stopped')
                .map((r) => r.framework)
        )
        return SANDBOX_FRAMEWORKS.map((fw) => {
            // A coding CLI is known from the sandbox probe; a service framework
            // only from the runtime that installed it.
            const coding = SANDBOX_CLI_FRAMEWORKS.includes(fw)
            const probedVersion = installedFrameworkVersion(sandbox, fw)
            const runtime = onHostRuntimes.find((r) => r.framework === fw)
            const present = probedVersion !== null || runtime !== undefined
            const blockedBy =
                !coding && !present && occupant !== null && occupant !== fw
                    ? frameworkLabel(occupant)
                    : null
            return {
                framework: fw,
                label: frameworkLabel(fw),
                present,
                version: probedVersion ?? runtime?.frameworkVersion ?? null,
                latest: frameworkLatestByFramework.get(fw) ?? null,
                installable: blockedBy === null,
                blockedBy,
                probed:
                    !coding || (sandbox?.detectedFrameworks.length ?? 0) > 0,
                agents: onHost
                    .filter((agent) => agent.framework === fw)
                    .map((agent) => ({
                        id: agent.id,
                        name: agent.name,
                        status: agent.status
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name))
            }
        })
    }

    // Check re-probes the sandbox; install and upgrade run the sandbox-level
    // install, except that a framework with a runtime on the host upgrades
    // through that runtime's primary agent, as the runtime page does, and a
    // service framework installs as an agent-less runtime (its gateway is
    // the runtime).
    const handleHostFrameworkAction = async (
        hostId: string,
        fw: AgentFramework,
        action: HostFrameworkAction
    ): Promise<void> => {
        if (hostFrameworkBusy) return
        setHostFrameworkBusy({ hostId, framework: fw })
        setHostFrameworkError(null)
        try {
            if (action === 'check') {
                await client.sandboxes.detectFrameworks(hostId)
                await refetchSandboxes()
                return
            }
            const latest = frameworkLatestByFramework.get(fw) ?? null
            const runtime = runtimes.find(
                (r) => r.hostId === hostId && r.framework === fw
            )
            if (action === 'upgrade' && runtime?.primaryAgentId && latest) {
                // The heavy frameworks re-clone and rebuild; their upgrade
                // streams phases, which this card only waits out.
                if (frameworkUpgradeMode(fw) === 'rebuild')
                    await client.agents.upgradeFrameworkStream(
                        runtime.primaryAgentId,
                        latest,
                        () => {}
                    )
                else
                    await client.agents.upgradeFramework(
                        runtime.primaryAgentId,
                        latest
                    )
                await Promise.all([refetchRuntimes(), refetchSandboxes()])
                return
            }
            if (!SANDBOX_CLI_FRAMEWORKS.includes(fw)) {
                await client.sandboxes.prepareRuntime(hostId, fw)
                await Promise.all([refetchRuntimes(), refetchSandboxes()])
                return
            }
            await client.sandboxes.installFramework(
                hostId,
                fw,
                latest ?? undefined
            )
            await refetchSandboxes()
        } catch (err) {
            setHostFrameworkError({
                hostId,
                framework: fw,
                message: apiErrorMessage(err)
            })
        } finally {
            setHostFrameworkBusy(null)
        }
    }

    // A bare sandbox the user picked (a click, a deep link, one they just
    // created) is brought to the point where its accounts read like a
    // runtime's — host sign-in, added accounts, Add account / Add API key —
    // without another ask where nothing but time is at stake: a sandbox never
    // probed is checked, one with the CLI gets the framework's runtime
    // brought up (the form then re-targets itself at that runtime, whose card
    // takes the sandbox card's place; the CLI is left at the version found).
    // A missing CLI is the one step that waits for a click: installing takes
    // a minute and changes the sandbox, so the group says so and offers it.
    const frameworkRef = useRef(framework)
    frameworkRef.current = framework
    const runSandboxStep = async (
        hostId: string,
        step: 'check' | 'install' | 'prepare',
        opts: { autoAdd: boolean }
    ): Promise<void> => {
        if (accountPrepareHostId) return
        const forFramework = framework
        setAccountPrepareHostId(hostId)
        setAccountPrepareStep(step)
        setAccountPrepareError(null)
        try {
            if (step === 'check') {
                // What comes next (prepare, or the install offer) follows from
                // the re-read sandbox, through the effect below.
                await client.sandboxes.detectFrameworks(hostId)
                await refetchSandboxes()
                return
            }
            if (step === 'install') {
                await client.sandboxes.installFramework(
                    hostId,
                    forFramework,
                    frameworkLatestByFramework.get(forFramework) ?? undefined
                )
                await refetchSandboxes()
            }
            setAccountPrepareStep('prepare')
            const prepared = await client.sandboxes.prepareRuntime(
                hostId,
                forFramework
            )
            await refetchRuntimes()
            // The user may have moved on while the sandbox was being
            // prepared; the runtime is there for when they come back.
            if (frameworkRef.current !== forFramework) return
            setRuntimeMode('existing')
            setPickedRuntimeId(prepared.id)
            setAttachSandboxHostId('')
            setRevealTargetKey(`runtime:${prepared.id}`)
            if (opts.autoAdd) setAutoAddAccountKey(prepared.id)
        } catch (err) {
            setAccountPrepareError({ hostId, message: apiErrorMessage(err) })
        } finally {
            setAccountPrepareHostId(null)
            setAccountPrepareStep(null)
        }
    }
    const pickedSandbox =
        runtimeMode === 'sandbox' &&
        attachSandboxHostId !== '' &&
        isConfigurableFramework(framework)
            ? (sandboxes.find((s) => s.id === attachSandboxHostId) ?? null)
            : null
    // What the last probe said about the framework's CLI on it: nothing yet,
    // absent, or there.
    const pickedSandboxCli: 'unknown' | 'missing' | 'present' =
        pickedSandbox === null || pickedSandbox.detectedFrameworks.length === 0
            ? 'unknown'
            : installedFrameworkVersion(pickedSandbox, framework) !== null
              ? 'present'
              : 'missing'
    // A sandbox the list picked by default is not touched unasked — merely
    // opening the page must not probe or wake VMs or add runtime rows; it
    // offers the next step as a chip, which runs on the click.
    const pickedSandboxByUser =
        pickedSandbox !== null && userPickedSandboxId === pickedSandbox.id
    const autoCheckedRef = useRef(new Set<string>())
    const autoPreparedRef = useRef(new Set<string>())
    useEffect(() => {
        if (!pickedSandbox || !pickedSandboxByUser || accountPrepareHostId)
            return
        if (pickedSandboxCli === 'unknown') {
            // Once per sandbox: a failed probe stays on screen with a retry.
            if (autoCheckedRef.current.has(pickedSandbox.id)) return
            autoCheckedRef.current.add(pickedSandbox.id)
            void runSandboxStep(pickedSandbox.id, 'check', { autoAdd: false })
            return
        }
        if (pickedSandboxCli !== 'present') return
        if (
            runtimes.some(
                (r) =>
                    r.hostId === pickedSandbox.id &&
                    r.framework === framework &&
                    r.status !== 'failed' &&
                    r.status !== 'stopped'
            )
        )
            return
        // Once per sandbox and framework, for the same reason.
        const key = `${pickedSandbox.id}|${framework}`
        if (autoPreparedRef.current.has(key)) return
        autoPreparedRef.current.add(key)
        void runSandboxStep(pickedSandbox.id, 'prepare', { autoAdd: false })
        // runSandboxStep is recreated every render; the key sets are what
        // make each step run once.
    }, [
        accountPrepareHostId,
        framework,
        pickedSandbox,
        pickedSandboxByUser,
        pickedSandboxCli,
        runtimes
    ])
    const sandboxAccountPrepare: SandboxPrepare | null = pickedSandbox
        ? {
              cli: pickedSandboxCli,
              auto: pickedSandboxByUser,
              busy: accountPrepareHostId === pickedSandbox.id,
              error:
                  accountPrepareError?.hostId === pickedSandbox.id
                      ? accountPrepareError.message
                      : null,
              // The chip (or the retry): the next step for the CLI as last
              // seen, run for the click that asked for an account.
              onAction: (): void => {
                  autoCheckedRef.current.delete(pickedSandbox.id)
                  autoPreparedRef.current.delete(
                      `${pickedSandbox.id}|${framework}`
                  )
                  void runSandboxStep(
                      pickedSandbox.id,
                      pickedSandboxCli === 'unknown'
                          ? 'check'
                          : pickedSandboxCli === 'missing'
                            ? 'install'
                            : 'prepare',
                      { autoAdd: pickedSandboxCli !== 'unknown' }
                  )
              }
          }
        : null

    const submitRename = async (name: string): Promise<void> => {
        if (!renameTarget) return
        if (renameTarget.kind === 'sandbox')
            await client.sandboxes.rename(renameTarget.id, name)
        else await client.agentRuntimes.rename(renameTarget.id, name)
        await Promise.all([refetchRuntimes(), refetchSandboxes()])
    }

    // After a delete the picked target may be gone; clearing the pick lets
    // the list's own default choose again.
    const forgetDeletedTarget = (input: {
        runtimeId?: string
        hostId?: string
    }): void => {
        if (
            (input.runtimeId && pickedRuntimeId === input.runtimeId) ||
            (input.hostId && attachSandboxHostId === input.hostId)
        ) {
            setPickedRuntimeId('')
            setAttachSandboxHostId('')
            setRuntimeMode('sandbox')
        }
    }

    // A cloud computer's runtime with no agents. A sandbox's runtimes are not
    // deleted one by one from here: the sandbox is the machine the card
    // stands for, and a bare sandbox picked again would only be prepared
    // anew — its menu deletes the sandbox instead.
    const deleteRuntimeTarget = async (
        runtime: AgentRuntimeSummary,
        key: string
    ): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.runtimeDetails.deleteTitle'),
                description: t('web.runtimeDetails.deleteConfirm', {
                    name: runtime.name
                }),
                confirmLabel: t('web.runtimeDetails.deleteAction'),
                tone: 'danger'
            }))
        )
            return
        setTargetActionKey(key)
        setError(null)
        try {
            await client.agentRuntimes.delete(runtime.id)
            forgetDeletedTarget({ runtimeId: runtime.id })
            await Promise.all([refetchRuntimes(), refetchSandboxes()])
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setTargetActionKey(null)
        }
    }

    // A sandbox with no agents: its agent-less runtimes go first (the API
    // refuses a sandbox that still has runtimes, and deleting the last one
    // already takes the VM), then the host itself if it is still there.
    const deleteSandboxTarget = async (
        hostId: string,
        name: string,
        key: string
    ): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.agentRuntimesList.deleteSandbox'),
                description: t(
                    'web.agentRuntimesList.deleteSandboxDescription',
                    { name }
                ),
                confirmLabel: t('web.agentRuntimesList.delete'),
                tone: 'danger'
            }))
        )
            return
        setTargetActionKey(key)
        setError(null)
        try {
            const onHost = runtimes.filter(
                (r) =>
                    r.hostId === hostId &&
                    r.status !== 'failed' &&
                    r.status !== 'stopped'
            )
            for (const r of onHost) await client.agentRuntimes.delete(r.id)
            const remaining = await client.sandboxes.list()
            if (remaining.some((s) => s.id === hostId))
                await client.sandboxes.delete(hostId)
            forgetDeletedTarget({ hostId })
            await Promise.all([refetchRuntimes(), refetchSandboxes()])
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setTargetActionKey(null)
        }
    }

    const agentsOnHost = (hostId: string): number =>
        (populationByHost.get(hostId) ?? []).reduce(
            (sum, entry) => sum + entry.agents,
            0
        )
    const sandboxNameFor = (hostId: string, fallback: string | null): string =>
        sandboxes.find((s) => s.id === hostId)?.name ?? fallback ?? hostId
    const renameRuntimeItem = (
        runtime: AgentRuntimeSummary
    ): OverflowMenuEntry => ({
        label: t('web.runtimeDetails.renameRuntime'),
        onSelect: () =>
            setRenameTarget({
                kind: 'runtime',
                id: runtime.id,
                name: runtime.name
            })
    })
    const renameSandboxItem = (
        hostId: string,
        name: string
    ): OverflowMenuEntry => ({
        label: t('web.agentNew.renameSandbox'),
        onSelect: () => setRenameTarget({ kind: 'sandbox', id: hostId, name })
    })
    const deleteSandboxItem = (
        hostId: string,
        name: string,
        key: string
    ): OverflowMenuEntry => {
        const busy = targetActionKey === key
        const agents = agentsOnHost(hostId)
        return {
            label: busy
                ? t('web.agentRuntimesList.deleting')
                : t('web.agentRuntimesList.deleteSandbox'),
            danger: true,
            disabled: busy || agents > 0,
            disabledReason:
                agents > 0 ? t('web.agentNew.deleteHasAgents') : undefined,
            onSelect: () => void deleteSandboxTarget(hostId, name, key)
        }
    }

    // What a card's menu offers. A sandbox card — bare, or the runtime on
    // it — renames the runtime and the sandbox and deletes the sandbox once
    // nothing runs there. A cloud computer renames and deletes its runtime
    // when no agent is left; a daemon's runtimes are the daemon's own and
    // only rename.
    const runtimeTargetMenu = (
        runtime: AgentRuntimeSummary,
        key: string
    ): OverflowMenuEntry[] => {
        const items: OverflowMenuEntry[] = [renameRuntimeItem(runtime)]
        if (runtime.kind === 'sprites' && runtime.hostId) {
            const name = sandboxNameFor(runtime.hostId, runtime.spriteName)
            items.push(
                renameSandboxItem(runtime.hostId, name),
                deleteSandboxItem(runtime.hostId, name, key)
            )
        } else if (runtime.kind === 'k8s') {
            const busy = targetActionKey === key
            items.push({
                label: busy
                    ? t('web.runtimeDetails.deleting')
                    : t('web.runtimeDetails.deleteTitle'),
                danger: true,
                disabled: busy || runtime.agentsCount > 0,
                disabledReason:
                    runtime.agentsCount > 0
                        ? t('web.agentNew.deleteHasAgents')
                        : undefined,
                onSelect: () => void deleteRuntimeTarget(runtime, key)
            })
        }
        return items
    }
    const sandboxTargetMenu = (
        target: SpriteAttachTarget,
        key: string
    ): OverflowMenuEntry[] => {
        const name = target.name ?? target.spriteName ?? target.hostId
        return [
            renameSandboxItem(target.hostId, name),
            deleteSandboxItem(target.hostId, name, key)
        ]
    }

    // A sandbox card's status line: the runner for the picked one, the VM
    // lifecycle for the rest (see sandboxTargetStatus).
    const sandboxCardStatus = (
        hostId: string,
        picked: boolean
    ): RuntimeTargetStatus => {
        if (picked && runnerPrewarm.refusal)
            return {
                label: t('web.agentNew.statusWakeRefused'),
                tone: 'offline'
            }
        const status = sandboxTargetStatus({
            spriteStatus:
                sandboxes.find((s) => s.id === hostId)?.spriteStatus ?? null,
            picked,
            prewarming: runnerPrewarming,
            availability: picked
                ? (runtimeAuth.list?.availability ?? null)
                : null
        })
        if (status.kind === 'starting-runner')
            return {
                label: t('web.agentNew.statusStartingRunner'),
                tone: 'progress'
            }
        if (status.kind === 'runner-online')
            return {
                label: t('web.agentNew.statusRunnerOnline'),
                tone: 'success'
            }
        return { label: status.label, tone: status.tone }
    }

    const populationLabel = (entry: RuntimeTargetPopulation): string =>
        `${frameworkLabel(entry.framework)} · ${
            entry.agents === 1
                ? t('web.agentNew.agentCountOne')
                : t('web.agentNew.agentCountMany', {
                      count: String(entry.agents)
                  })
        }`

    // Create-new and reuse targets share one list: the picker's job is "where
    // does this agent land", and that question does not split by provenance.
    // Containers are a purchased product only where a billing surface exists,
    // so on that edition renting stays a link instead of a selectable target.
    const runtimeTargets: RuntimeTarget[] = [
        ...(cloudComputerAvailable && !BILLING_SURFACE
            ? [
                  {
                      key: 'create:persistent',
                      kind: 'k8s' as const,
                      group: 'create' as const,
                      name: t('web.agentNew.createRuntimeNamed', {
                          runtime: t('web.agentNew.persistent')
                      }),
                      status: null,
                      population: [],
                      selected: runtimeMode === 'persistent',
                      disabled: persistentLimitReached,
                      disabledReason: persistentLimitReached
                          ? t('web.agentNew.limitReached')
                          : null,
                      onSelect: () => selectRuntimeCategory('persistent')
                  }
              ]
            : []),
        ...[
            ...existingRuntimeOptionsByKind.sprites,
            ...existingRuntimeOptionsByKind.k8s,
            ...existingRuntimeOptionsByKind.daemon
        ].map((r) => ({
            key: `runtime:${r.id}`,
            kind: (r.kind ?? 'sprites') as RuntimeTargetKind,
            group: 'existing' as const,
            name: r.name,
            status:
                r.kind === 'daemon' && !r.daemonOnline
                    ? {
                          label: t('web.agentNew.offline'),
                          tone: 'offline' as const
                      }
                    : r.kind === 'sprites' && r.hostId
                      ? sandboxCardStatus(
                            r.hostId,
                            runtimeMode === 'existing' &&
                                pickedRuntimeId === r.id
                        )
                      : {
                            label: t('web.agentNew.readyTag'),
                            tone: 'ready' as const
                        },
            population:
                populationByHost.get(r.hostId ?? r.id) ??
                (r.agentsCount > 0
                    ? [{ framework: r.framework, agents: r.agentsCount }]
                    : []),
            ...(r.kind === 'sprites' && r.hostId
                ? {
                      hostId: r.hostId,
                      frameworks: hostFrameworkEntries(r.hostId)
                  }
                : {}),
            menu: runtimeTargetMenu(r, `runtime:${r.id}`),
            selected: runtimeMode === 'existing' && pickedRuntimeId === r.id,
            disabled: false,
            disabledReason: null,
            onSelect: () => selectExistingRuntimeTarget(r)
        })),
        // A sandbox that does not run this framework yet: the agent lands here
        // too, so it is the same kind of row. Nothing runs on it for this
        // framework, hence zero.
        ...spriteAttachTargets.map((target) => ({
            key: `sandbox:${target.hostId}`,
            kind: 'sprites' as const,
            group: 'existing' as const,
            name: target.name ?? target.spriteName ?? target.hostId,
            status: sandboxCardStatus(target.hostId, false),
            population: populationByHost.get(target.hostId) ?? [],
            hostId: target.hostId,
            frameworks: hostFrameworkEntries(target.hostId),
            menu: sandboxTargetMenu(target, `sandbox:${target.hostId}`),
            selected:
                runtimeMode === 'sandbox' &&
                attachSandboxHostId === target.hostId,
            disabled: false,
            disabledReason: null,
            onSelect: () => selectAttachSandboxTarget(target)
        }))
    ]

    // The quick filter's chips are the kinds this framework can land on, not
    // the kinds that happen to have a target today: a deployment with one
    // sandbox and nothing else should still see that computers are a choice,
    // and filtering to an empty kind is what surfaces its "provision one" link.
    // Kinds that hold a target are always included, so no target can be
    // unreachable through the filter.
    const runtimeKindsWithTargets = new Set(
        runtimeTargets.map((target) => target.kind)
    )
    const runtimeKindCount = (kind: RuntimeTargetKind): number =>
        runtimeTargets.filter((target) => target.kind === kind).length
    const runtimeKindFilterOptions: RuntimeKindFilter[] = [
        'all',
        ...(
            [
                ['sprites', supportsSandbox(framework)],
                ['k8s', cloudComputerAvailable],
                ['daemon', daemonSupported]
            ] as Array<[RuntimeTargetKind, boolean]>
        )
            .filter(
                ([kind, supported]) =>
                    supported || runtimeKindsWithTargets.has(kind)
            )
            .map(([kind]) => kind)
    ]
    const visibleRuntimeTargets =
        runtimeKindFilter === 'all'
            ? runtimeTargets
            : runtimeTargets.filter(
                  (target) => target.kind === runtimeKindFilter
              )

    // Clamped rather than corrected in an effect: a filter that shrinks the
    // list must not leave the picker on a page that no longer exists, and the
    // clamp is a pure function of what is being rendered.
    const runtimePageCount = Math.max(
        1,
        Math.ceil(visibleRuntimeTargets.length / RUNTIME_PAGE_SIZE)
    )
    const runtimePageSafe = Math.min(runtimePage, runtimePageCount)
    const pagedRuntimeTargets = visibleRuntimeTargets.slice(
        (runtimePageSafe - 1) * RUNTIME_PAGE_SIZE,
        runtimePageSafe * RUNTIME_PAGE_SIZE
    )

    // An empty selection makes the first click a guess: the form cannot submit
    // and does not say what is missing. Whenever the picker has something to
    // offer and nothing is chosen, the first available target is chosen — after
    // any deep link has had its say, so it never overrides one.
    useEffect(() => {
        if (initialDaemonId && !daemonPreselectedRef.current) return
        if (initialSandboxId && sandboxPreselect === 'pending') return
        // A deep-linked runtime arrives with the runtimes list, after the
        // sandbox hosts; until its target is in the list nothing is selected,
        // and picking "the first host" here would overwrite the link.
        // Seen on a local stack [2026-09-11]: a second, empty sandbox got
        // picked over the runtime the page was opened for.
        if (
            initialRuntimeId &&
            !runtimeTargets.some(
                (target) => target.key === `runtime:${initialRuntimeId}`
            )
        )
            return
        if (runtimeTargets.some((target) => target.selected)) return
        const first = runtimeTargets.find((target) => !target.disabled)
        // The list's own pick, not the user's: a sandbox chosen here shows
        // its accounts on request rather than being prepared unasked.
        autoPickingRef.current = true
        try {
            first?.onSelect()
        } finally {
            autoPickingRef.current = false
        }
    }, [initialDaemonId, initialSandboxId, sandboxPreselect, runtimeTargets])

    // A target selected for the user (the sandbox they just created) has to be
    // on the visible page, or "selected" is a claim they cannot see. Runs only
    // while a reveal is pending, and clears itself once the target lands.
    useEffect(() => {
        if (!revealTargetKey) return
        const index = visibleRuntimeTargets.findIndex(
            (target) => target.key === revealTargetKey
        )
        if (index < 0) return
        setRuntimePage(Math.floor(index / RUNTIME_PAGE_SIZE) + 1)
        setRevealTargetKey(null)
    }, [revealTargetKey, visibleRuntimeTargets])

    // Entry points to provision a runtime outside this form. Reuses the
    // dashboard's option table so a new runtime kind appears in both places.
    const newRuntimeEntries = NEW_RUNTIME_OPTIONS.filter((option) => {
        if (option.kind === 'external') return false
        if (option.kind === 'daemon') return daemonSupported
        if (option.kind === 'sprites') return supportsSandbox(framework)
        return cloudComputerAvailable
    }).filter(
        (option) =>
            runtimeKindFilter === 'all' || option.kind === runtimeKindFilter
    )

    const primaryModelOptions = useMemo(() => {
        const seen = new Set<string>()
        return flattenSavedModels(
            selectedSavedProvider?.lastTestModels
        ).flatMap((model) => {
            const id = model.trim()
            if (!id || seen.has(id)) return []
            seen.add(id)
            return [id]
        })
    }, [selectedSavedProvider])
    const primaryModelIsKnownOption = primaryModelOptions.includes(
        primaryModelName.trim()
    )
    const primaryModelSelectValue =
        primaryModelCustom ||
        (primaryModelName.trim().length > 0 && !primaryModelIsKnownOption)
            ? '__custom'
            : primaryModelName.trim()
    const showPrimaryModelCustomInput =
        primaryModelOptions.length === 0 ||
        primaryModelSelectValue === '__custom'

    useEffect(() => {
        if (
            runtimeMode === 'existing' ||
            !usesConfigurableModelProvider(framework) ||
            primaryModelCustom
        )
            return
        if (primaryModelOptions.length === 0) {
            if (primaryModelName.trim()) setPrimaryModelName('')
            return
        }
        if (
            !primaryModelName.trim() ||
            !primaryModelOptions.includes(primaryModelName.trim())
        ) {
            setPrimaryModelName(
                preferredPrimaryModelDefault(
                    primaryModelOptions,
                    modelProviderForRuntime
                ) ?? primaryModelOptions[0]
            )
        }
    }, [
        framework,
        modelProviderForRuntime,
        primaryModelCustom,
        primaryModelName,
        primaryModelOptions,
        runtimeMode
    ])

    const selectPrimaryModel = (value: string): void => {
        if (value === '__custom') {
            setPrimaryModelCustom(true)
            if (primaryModelIsKnownOption) setPrimaryModelName('')
            return
        }
        setPrimaryModelCustom(false)
        setPrimaryModelName(value)
    }

    const existingWorkspaceValue =
        pickedRuntime?.framework === 'openclaw'
            ? openclawWorkspaceFor(pickedRuntime, normalizedName)
            : undefined
    const effectiveExistingWorkspace = workspaceForRequest
    const defaultCodingWorkspaceValue = (
        runtime: AgentRuntimeSummary
    ): string => {
        if (runtime.kind === 'daemon') {
            const base =
                runtime.workspaceBaseDir ??
                (runtime.homeDir
                    ? `${runtime.homeDir}/.manyfold/workspaces`
                    : null)
            return base
                ? `${base.replace(/\/+$/, '')}/{agent-id}`
                : '~/.manyfold/workspaces/{agent-id}'
        }
        const home = runtime.kind === 'k8s' ? K8S_HOME_BASE : SPRITE_HOME_BASE
        return `${home}/.manyfold/workspaces/{agent-id}`
    }
    const defaultWorkspaceValue =
        runtimeMode === 'existing'
            ? pickedRuntime
                ? (existingWorkspaceValue ??
                  defaultCodingWorkspaceValue(pickedRuntime))
                : t('web.agentNew.runtimeSelect')
            : runtimeMode === 'sandbox'
              ? framework === 'narranexus'
                  ? `${NARRANEXUS_SPRITE_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
                  : `${SPRITE_HOME_BASE}/.manyfold/workspaces/{agent-id}`
              : framework === 'openclaw'
                ? '/home/node/.openclaw/workspace'
                : framework === 'narranexus'
                  ? `${NARRANEXUS_K8S_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
                  : `${K8S_HOME_BASE}/.manyfold/workspaces/{agent-id}`
    const customWorkspaceRequested = requestedWorkspacePath.length > 0

    const createRuntimeDefaultWorkspaceValue = (
        category: RuntimeCategory
    ): string => {
        if (category === 'sandbox') {
            if (framework === 'openclaw')
                return `${SPRITE_HOME_BASE}/.openclaw/workspace`
            if (framework === 'hermes') return `${SPRITE_HOME_BASE}/.hermes`
            if (framework === 'narranexus')
                return `${NARRANEXUS_SPRITE_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
            return `${SPRITE_HOME_BASE}/.manyfold/workspaces/{agent-id}`
        }
        if (framework === 'openclaw')
            return `${K8S_HOME_BASE}/.openclaw/workspace`
        if (framework === 'hermes') return `${K8S_HOME_BASE}/.hermes`
        if (framework === 'narranexus')
            return `${NARRANEXUS_K8S_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
        return `${K8S_HOME_BASE}/.manyfold/workspaces/{agent-id}`
    }

    const existingRuntimeDefaultWorkspaceValue = (
        runtime: AgentRuntimeSummary
    ): string => {
        if (runtime.framework === 'openclaw')
            return openclawWorkspaceFor(runtime, normalizedName)
        if (runtime.framework === 'narranexus') {
            const base =
                runtime.kind === 'sprites'
                    ? NARRANEXUS_SPRITE_BASE_WORKING_PATH
                    : NARRANEXUS_K8S_BASE_WORKING_PATH
            return `${base}/{agent-id}_<mf-user>`
        }
        return defaultCodingWorkspaceValue(runtime)
    }

    // One workspace row serves the whole picker, so it resolves the default of
    // whichever target is selected rather than of the card it used to sit in.
    const selectedWorkspaceDefault =
        runtimeMode === 'existing' && pickedRuntime
            ? existingRuntimeDefaultWorkspaceValue(pickedRuntime)
            : createRuntimeDefaultWorkspaceValue(
                  runtimeMode === 'persistent' ? 'persistent' : 'sandbox'
              )

    const frameworkSelectOptions: WorkbenchSelectOption[] =
        localizedFrameworkOptions.map((opt) => ({
            value: opt.value,
            disabled: opt.disabled === true,
            label: (
                <span className='flex min-w-0 items-center gap-2'>
                    <FrameworkLogoMark framework={opt.value} size={18} />
                    <span className='truncate'>{opt.label}</span>
                    {opt.disabled && (
                        <span className='tag tag-neutral'>
                            {t('web.agentNew.coming')}
                        </span>
                    )}
                </span>
            )
        }))

    const resetWorkspaceToDefault = (): void => {
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const closeWorkspaceDialog = (): void => {
        setWorkspaceDraftPath(workspacePath)
        setWorkspaceDialogOpen(false)
    }

    const commitWorkspaceDraft = (): void => {
        if (workspaceDraftValidationMessage) return
        const next = requestedWorkspaceDraftPath
        setWorkspacePath(next)
        setWorkspaceDraftPath(next)
        setWorkspaceDialogOpen(false)
    }

    const renderWorkspaceValue = (args: {
        defaultPath: string
        active: boolean
        onActivate: () => void
    }): ReactNode => {
        const workspaceKind =
            args.active && customWorkspaceRequested
                ? t('web.agentNew.custom')
                : t('web.agentNew.default')
        const displayedPath =
            args.active && customWorkspaceRequested
                ? requestedWorkspacePath
                : args.defaultPath
        const invalid = args.active && !!workspaceValidationMessage
        const startEditing = (): void => {
            const nextDraft = args.active ? workspacePath : ''
            args.onActivate()
            setWorkspaceDraftPath(nextDraft)
            setWorkspaceDialogOpen(true)
        }

        return (
            <ShortcutTooltip
                label={`${workspaceKind}: ${displayedPath}`}
                placement='bottom-start'
                className='w-full min-w-0'
            >
                <button
                    type='button'
                    className='focus-visible:shadow-focus group grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-1.5 rounded-sm text-left transition-shadow focus:outline-none'
                    aria-label={t('web.agentNew.changeWorkspaceAria', {
                        kind: workspaceKind.toLowerCase(),
                        path: displayedPath
                    })}
                    onClick={(e) => {
                        e.stopPropagation()
                        startEditing()
                    }}
                >
                    <span
                        className={[
                            'text-caption shrink-0',
                            invalid ? 'text-workflow-ship' : 'text-muted'
                        ].join(' ')}
                    >
                        {workspaceKind}
                    </span>
                    <span
                        className={[
                            'text-caption min-w-0 truncate font-mono',
                            invalid ? 'text-workflow-ship' : 'text-muted'
                        ].join(' ')}
                    >
                        {displayedPath}
                    </span>
                    <span className='text-caption text-link group-hover:text-fg shrink-0 font-medium'>
                        {t('web.agentNew.change')}
                    </span>
                </button>
            </ShortcutTooltip>
        )
    }

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        if (busy || streamOpen) return
        setError(null)
        if (runtimeMode === 'existing') {
            if (!pickedRuntime) return
            const local =
                isConfigurableFramework(framework) &&
                providerSourceOf(picker.mode) === 'local'
            const created = await submitAddToRuntime({
                runtimeId: pickedRuntime.id,
                body: buildAddRuntimeAgentBody({
                    name: normalizedName,
                    workspace: effectiveExistingWorkspace,
                    // Only the inherited credentials take a model here: a
                    // provider override carries its own, and under Local the
                    // CLI's own config owns it.
                    model: providerInherited ? existingRuntimeModel : '',
                    cloneFrom:
                        pickedRuntime.framework === 'hermes' && cloneEnabled
                            ? cloneFromProfile || undefined
                            : undefined,
                    runtimeLocal: local,
                    runtimeAuthProfileId:
                        local &&
                        runtimeAuthPickerState(runtimeAuth.list) === 'ready'
                            ? localCredentials.profileId
                            : undefined
                })
            })
            if (!created) return
            if (isCloudCredentialPicker(picker) && !providerInherited) {
                try {
                    await client.agents.credentials.update(
                        created.id,
                        buildAgentCredentialsBody({
                            framework,
                            picker,
                            persistentModelProvider,
                            primaryModelName
                        })
                    )
                    // The mapping picked above lands the same way the
                    // credentials did: on the agent, once it exists.
                    if (frameworkModelConfigRequired && frameworkModelConfig)
                        await client.agents.updateModelConfig(created.id, {
                            modelConfigSource: 'platform',
                            modelConfig: frameworkModelConfig
                        })
                } catch (err) {
                    // The agent exists either way; saying so beats a bare
                    // failure that hides a created agent.
                    await refreshAgents()
                    setError(
                        t('web.agentNew.providerChangeFailed', {
                            name: normalizedName,
                            reason: apiErrorMessage(err)
                        })
                    )
                    return
                }
            }
            await refreshAgents()
            navigate(`/agents/${created.id}/chat`)
            return
        }
        const externalNow = isExternalFramework(framework)
        const filesystemRuntimeMode: AgentCreateRuntimeMode =
            runtimeMode === 'persistent' ? 'persistent' : 'sandbox'
        const steps = externalNow
            ? externalSteps
            : progressStepsForCreate(framework, filesystemRuntimeMode)
        const body: CreateAgentBody =
            framework === 'dify'
                ? {
                      name: normalizedName,
                      framework: 'dify',
                      runtime: 'external',
                      difyBinding: {
                          providerId: externalProviderId
                      }
                  }
                : framework === 'langflow'
                  ? {
                        name: normalizedName,
                        framework: 'langflow',
                        runtime: 'external',
                        langflowBinding: {
                            providerId: externalProviderId,
                            flowId: externalRemoteId.trim()
                        }
                    }
                  : framework === 'a2a'
                    ? {
                          name: normalizedName,
                          framework: 'a2a',
                          runtime: 'external',
                          a2aBinding: {
                              providerId: externalProviderId
                          }
                      }
                    : buildCreateAgentBody({
                          framework,
                          name: normalizedName,
                          picker,
                          runtimeMode: filesystemRuntimeMode,
                          persistentModelProvider,
                          primaryModelName,
                          modelConfig: frameworkModelConfig ?? undefined,
                          workspace: workspaceForRequest,
                          frameworkVersion: frameworkVersionSel || undefined
                      })
        if (!externalNow && attachSandboxHostId)
            body.sandboxId = attachSandboxHostId
        const created = await submitCreateStream({ body, steps })
        if (created) {
            await refreshAgents()
            navigate(`/agents/${created.id}/chat`)
        }
    }

    const retry = (): void => {
        resetProgress()
    }

    const cloudRows = selectableProvidersForFamilies(
        providers,
        providerFamilies,
        framework
    )
    const cloudRowCount = cloudRows.length

    // A Local row is the selection: the picker flips to the runtime-local
    // mode and the row's account becomes the binding the attach carries.
    const selectLocalCredential = (profileId: string): void => {
        setLocalCredentials({ profileId })
        setPicker((current) =>
            current.mode === 'runtime'
                ? current
                : { ...current, mode: 'runtime' }
        )
        setFrameworkModelConfig(null)
    }

    // Re-test a saved provider from its row: select it and let the model
    // config hook run the test once the selection has landed.
    const refreshProvider = (id: string): void => {
        setPicker((current) => ({ ...current, mode: 'saved', providerId: id }))
        setFrameworkModelConfig(null)
        requestProviderTest(id)
    }

    // The provider added from the dialog is the one to pick: refetch so the
    // list has it, select it as a saved (Cloud) provider, and test it right
    // away so its models are loaded without a manual step.
    const handleProviderCreated = async (id: string): Promise<void> => {
        await refetchProviders()
        setAddProvider(null)
        setPicker((current) => ({ ...current, mode: 'saved', providerId: id }))
        setFrameworkModelConfig(null)
        requestProviderTest(id)
    }

    const renderInheritedModel = (): ReactNode => (
        <label className='block'>
            <span className='workbench-field-label'>
                {t('web.agentNew.model')}
            </span>
            <input
                value={existingRuntimeModel}
                onChange={(e) => setExistingRuntimeModel(e.target.value)}
                placeholder={t('web.agentNew.primaryModelPlaceholder')}
                maxLength={255}
                className='workbench-input font-mono'
            />
            <p className='workbench-hint mt-2'>
                {t('web.agentNew.modelInheritHint')}
            </p>
        </label>
    )

    // The Cloud pieces of the unified provider grid (coding frameworks): the
    // saved-provider cards and the add-provider chip.
    const providerCards = (
        <ProviderPicker
            provider={modelProviderForRuntime}
            families={providerFamilies}
            visible={(row) =>
                providerFamilyFilter === 'all' ||
                providerSupportsTarget(row, providerFamilyFilter)
            }
            framework={framework}
            apiKeyLabel={apiKeyLabelForProvider(credentialProvider)}
            baseUrlLabel={t('web.agentNew.baseUrlOptional')}
            allowInlineKey={false}
            layout='rows'
            leadFor={providerRowLead}
            onRefresh={refreshProvider}
            refreshingId={frameworkProviderTesting ? picker.providerId : null}
            options={providers}
            value={picker}
            onChange={(next) => {
                setPicker(next)
                setFrameworkModelConfig(null)
            }}
        />
    )
    const providerAddChip = (
        <CreateMenu
            variant='chip'
            align='left'
            triggerLabel={t('web.agentNew.addModelProvider')}
            sheetTitle={t('web.modelProviders.newProvider')}
            options={modelProviderCreateOptions(
                t,
                uniqueBy(
                    providerFamilies.flatMap((family) =>
                        builtInEntriesFor(framework, family)
                    ),
                    (entry) => entry.id
                ),
                [
                    ...new Set(
                        providerFamilies.flatMap((family) =>
                            customProtocolsFor(framework, family)
                        )
                    )
                ],
                setAddProvider
            )}
        />
    )
    // The provider section of a framework without a Local side, in the
    // Cloud / Local section's shape: OpenClaw and Hermes get the saved
    // providers of both vendors under Anthropic / OpenAI chips; NarraNexus,
    // which takes no provider from Manyfold, gets the one card saying so.
    const renderCreateRuntimeSettings = (): ReactNode => {
        if (providerInherited)
            return (
                <p className='workbench-hint'>
                    {t('web.agentNew.inheritRuntimeCredentialsHint', {
                        runtime:
                            pickedRuntime?.name ??
                            t('web.agentNew.runtimeSelect')
                    })}
                </p>
            )
        if (framework === 'narranexus')
            return (
                <ProviderFamilySection
                    chips={[]}
                    filter='all'
                    onFilterChange={() => {}}
                    cards={
                        <div className='shadow-ring-light bg-soft min-w-0 rounded-md px-3 py-2'>
                            <span className='text-ui text-fg block font-medium'>
                                {t('web.agentNew.providerManagedTitle', {
                                    framework: frameworkLabel(framework)
                                })}
                            </span>
                            <span className='text-caption text-muted mt-0.5 block'>
                                {t('web.agentNew.providerManagedByFramework', {
                                    framework: frameworkLabel(framework)
                                })}
                            </span>
                        </div>
                    }
                />
            )
        const familyChips = providerFamiliesFor(framework, credentialProvider)
        return (
            <ProviderFamilySection
                chips={[
                    {
                        value: 'all',
                        label: t('web.agentNew.filterAll'),
                        count: cloudRowCount
                    },
                    ...familyChips.map((family) => ({
                        value: family,
                        label: providerLabel[family],
                        count: selectableProvidersFor(
                            providers,
                            family,
                            framework
                        ).length
                    }))
                ]}
                filter={providerFamilyFilter}
                onFilterChange={setProviderFamilyFilter}
                cards={providerCards}
                actions={providerAddChip}
            />
        )
    }

    // Everything about the model itself, under one label after the provider:
    // the framework's mapping and default (a platform provider on Claude Code
    // or Codex), the primary model of a persistent framework, or the model
    // override for an agent that simply inherits its runtime's credentials.
    // Local has nothing here — the CLI's own config on the runtime owns it —
    // so the section disappears rather than explaining itself.
    const renderAdvancedConfig = (): ReactNode => {
        if (frameworkModelConfigRequired)
            return (
                <CreateFrameworkModelConfig
                    view={frameworkModelConfigView}
                    draft={frameworkModelConfig}
                    validationMessage={frameworkModelValidation.message}
                    onChange={setFrameworkModelConfig}
                />
            )
        if (!usesConfigurableModelProvider(framework)) return null
        if (providerInherited) return renderInheritedModel()
        return (
            <label className='block'>
                <span className='workbench-field-label'>
                    {t('web.agentNew.primaryModel')}
                </span>
                <div className='min-w-0 space-y-2'>
                    {primaryModelOptions.length > 0 && (
                        <WorkbenchSelect
                            mono
                            ariaLabel={t('web.agentNew.primaryModel')}
                            placeholder={t('web.agentNew.selectModel')}
                            value={primaryModelSelectValue}
                            onChange={selectPrimaryModel}
                            options={[
                                {
                                    value: '',
                                    label: t('web.agentNew.selectModel')
                                },
                                ...primaryModelOptions.map((model) => ({
                                    value: model,
                                    label: model
                                })),
                                {
                                    value: '__custom',
                                    label: t('web.agentNew.customModel')
                                }
                            ]}
                        />
                    )}
                    {showPrimaryModelCustomInput && (
                        <input
                            required
                            value={primaryModelName}
                            onChange={(e) => {
                                setPrimaryModelCustom(true)
                                setPrimaryModelName(e.target.value)
                            }}
                            placeholder={t(
                                'web.agentNew.primaryModelPlaceholder'
                            )}
                            maxLength={255}
                            className='workbench-input font-mono'
                        />
                    )}
                </div>
            </label>
        )
    }

    return (
        <>
            <div className='workbench-page-narrow pt-5 md:py-8'>
                <Link
                    to='/workspace'
                    className='text-caption text-muted hover:text-fg mb-4 hidden md:inline-block'
                >
                    {t('web.agentNew.backToWorkspace')}
                </Link>

                <div className='workbench-panel p-6 md:p-7'>
                    {progress ? (
                        <div className='space-y-6'>
                            <div>
                                <h2 className='text-h3 text-fg'>
                                    {t('web.agentNew.creatingAgent')}
                                </h2>
                                <p className='text-caption text-muted mt-1 font-mono'>
                                    {name} · {framework}
                                </p>
                            </div>
                            <CreateProgress
                                steps={progress.steps}
                                currentIndex={progress.currentIndex}
                                failedStep={progress.failedStep}
                                errorMessage={progress.errorMessage}
                            />
                            {progress.done && progress.failedStep && (
                                <button
                                    type='button'
                                    onClick={retry}
                                    className='workbench-button-primary w-full'
                                >
                                    {t('common.retry')}
                                </button>
                            )}
                        </div>
                    ) : (
                        <form onSubmit={submit} className='space-y-6'>
                            <label className='block'>
                                <span className='workbench-field-label'>
                                    {t('web.agentNew.name')}
                                </span>
                                <div className='flex gap-2'>
                                    <input
                                        required
                                        minLength={1}
                                        value={name}
                                        onChange={(e) => {
                                            setName(e.target.value)
                                        }}
                                        placeholder={t(
                                            'web.agentNew.nameExample'
                                        )}
                                        className='workbench-input min-w-0'
                                    />
                                    <ShortcutTooltip
                                        label={t(
                                            'web.agentNew.generateRandomName'
                                        )}
                                        placement='bottom-end'
                                        className='shrink-0'
                                    >
                                        <button
                                            type='button'
                                            onClick={randomizeName}
                                            className='workbench-button-secondary h-10 px-3'
                                        >
                                            {t('web.agentNew.random')}
                                        </button>
                                    </ShortcutTooltip>
                                </div>
                                <p className='workbench-hint mt-2'>
                                    {t('web.agentNew.nameHint')}
                                </p>
                                {nameValidationMessage && (
                                    <p className='text-caption text-accent-ruby mt-1'>
                                        {nameValidationMessage}
                                    </p>
                                )}
                            </label>

                            <div>
                                <div className='mb-1.5 flex items-center gap-1'>
                                    <span className='workbench-field-label mb-0'>
                                        {t('web.agentNew.agentFramework')}
                                    </span>
                                    <CompareButton
                                        label={t(
                                            'web.agentNew.compareFrameworks'
                                        )}
                                        onOpen={() =>
                                            setFrameworkCompareDialogOpen(true)
                                        }
                                    />
                                </div>
                                <WorkbenchSelect
                                    ariaLabel={t('web.agentNew.agentFramework')}
                                    value={framework}
                                    onChange={(value) => {
                                        const option =
                                            localizedFrameworkOptions.find(
                                                (opt) => opt.value === value
                                            )
                                        if (
                                            option &&
                                            !option.disabled &&
                                            isCreateableFramework(option.value)
                                        )
                                            selectFramework(option.value)
                                    }}
                                    options={frameworkSelectOptions}
                                />
                                <p className='workbench-hint mt-2'>
                                    {selectedFramework.description}
                                </p>
                            </div>

                            {!isExternalFramework(framework) && (
                                <div>
                                    <div className='mb-2 flex flex-wrap items-center gap-1'>
                                        <span className='workbench-field-label mb-0'>
                                            {t('web.agentNew.agentRuntime')}
                                        </span>
                                        <CompareButton
                                            label={t(
                                                'web.agentNew.compareRuntimes'
                                            )}
                                            onOpen={() =>
                                                setRuntimeCompareDialogOpen(
                                                    true
                                                )
                                            }
                                        />
                                        <span className='min-w-2 flex-1' />
                                        <DashboardViewToggle
                                            value={runtimeView}
                                            onChange={changeRuntimeView}
                                            ariaLabel={t(
                                                'web.agentNew.agentRuntime'
                                            )}
                                        />
                                    </div>
                                    {runtimeKindFilterOptions.length > 1 && (
                                        <div
                                            role='group'
                                            aria-label={t(
                                                'web.agentNew.runtimeCategory'
                                            )}
                                            className='bg-soft shadow-ring-light mb-2 inline-flex flex-wrap gap-1 rounded-md p-1'
                                        >
                                            {runtimeKindFilterOptions.map(
                                                (kind) => (
                                                    <FilterChip
                                                        key={kind}
                                                        icon={
                                                            kind === 'all'
                                                                ? undefined
                                                                : runtimeKindIcon(
                                                                      kind
                                                                  )
                                                        }
                                                        label={
                                                            kind === 'all'
                                                                ? t(
                                                                      'web.agentNew.filterAll'
                                                                  )
                                                                : runtimeKindLabel(
                                                                      kind
                                                                  )
                                                        }
                                                        count={
                                                            kind === 'all'
                                                                ? runtimeTargets.length
                                                                : runtimeKindCount(
                                                                      kind
                                                                  )
                                                        }
                                                        active={
                                                            runtimeKindFilter ===
                                                            kind
                                                        }
                                                        onSelect={() => {
                                                            setRuntimeKindFilter(
                                                                kind
                                                            )
                                                            setRuntimePage(1)
                                                        }}
                                                    />
                                                )
                                            )}
                                        </div>
                                    )}
                                    {visibleRuntimeTargets.length === 0 ? (
                                        <p className='text-caption text-muted font-medium'>
                                            {t('web.agentNew.notAvailable')}
                                        </p>
                                    ) : runtimeView === 'grid' ? (
                                        <div className='grid gap-2 sm:grid-cols-2'>
                                            {pagedRuntimeTargets.map(
                                                (target) => (
                                                    <RuntimeTargetCard
                                                        key={target.key}
                                                        target={target}
                                                        kindLabel={runtimeKindLabel(
                                                            target.kind
                                                        )}
                                                        populationLabelFor={
                                                            populationLabel
                                                        }
                                                        onFrameworkAction={(
                                                            fw,
                                                            action
                                                        ) => {
                                                            if (target.hostId)
                                                                void handleHostFrameworkAction(
                                                                    target.hostId,
                                                                    fw,
                                                                    action
                                                                )
                                                        }}
                                                        frameworkBusy={
                                                            hostFrameworkBusy &&
                                                            hostFrameworkBusy.hostId ===
                                                                target.hostId
                                                                ? hostFrameworkBusy.framework
                                                                : null
                                                        }
                                                        frameworkError={
                                                            hostFrameworkError &&
                                                            hostFrameworkError.hostId ===
                                                                target.hostId
                                                                ? hostFrameworkError
                                                                : null
                                                        }
                                                    />
                                                )
                                            )}
                                        </div>
                                    ) : (
                                        <RuntimeTargetTable
                                            targets={pagedRuntimeTargets}
                                            kindLabelFor={runtimeKindLabel}
                                            populationLabelFor={populationLabel}
                                            columns={{
                                                runtime: t(
                                                    'web.agentNew.runtime'
                                                ),
                                                kind: t('web.agentNew.kind'),
                                                status: t(
                                                    'web.agentNew.status'
                                                ),
                                                agents: t(
                                                    'web.agentNew.agentsColumn'
                                                )
                                            }}
                                        />
                                    )}
                                    {runtimePageCount > 1 && (
                                        <RuntimePager
                                            page={runtimePageSafe}
                                            pageCount={runtimePageCount}
                                            onChange={setRuntimePage}
                                            labels={{
                                                group: t(
                                                    'web.agentNew.pagination'
                                                ),
                                                previous: t(
                                                    'web.agentNew.previousPage'
                                                ),
                                                next: t('web.agentNew.nextPage')
                                            }}
                                        />
                                    )}
                                    {newRuntimeEntries.length > 0 && (
                                        <div className='mt-2 flex flex-wrap gap-2'>
                                            {newRuntimeEntries.map((option) => {
                                                const Icon = option.icon
                                                const entryClass =
                                                    'text-caption text-muted hover:text-fg hover:bg-surface-hover border-divider inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-55'
                                                const body = (
                                                    <>
                                                        <PlusIcon className='h-3.5 w-3.5 shrink-0' />
                                                        <Icon className='h-3.5 w-3.5 shrink-0' />
                                                        {t(option.labelKey)}
                                                    </>
                                                )
                                                // A sandbox is provisioned here
                                                // and selected in place; the
                                                // other kinds still need their
                                                // own settings page.
                                                if (option.kind === 'sprites')
                                                    return (
                                                        <button
                                                            key={option.kind}
                                                            type='button'
                                                            disabled={
                                                                sandboxLimitReached
                                                            }
                                                            title={
                                                                sandboxLimitReached
                                                                    ? t(
                                                                          'web.agentNew.limitReached'
                                                                      )
                                                                    : undefined
                                                            }
                                                            onClick={
                                                                openSandboxDialog
                                                            }
                                                            className={
                                                                entryClass
                                                            }
                                                        >
                                                            {body}
                                                        </button>
                                                    )
                                                if (option.kind === 'daemon')
                                                    return (
                                                        <button
                                                            key={option.kind}
                                                            type='button'
                                                            onClick={() =>
                                                                setConnectDaemonOpen(
                                                                    true
                                                                )
                                                            }
                                                            className={
                                                                entryClass
                                                            }
                                                        >
                                                            {body}
                                                        </button>
                                                    )
                                                return (
                                                    <Link
                                                        key={option.kind}
                                                        to={option.to}
                                                        className={entryClass}
                                                    >
                                                        {body}
                                                    </Link>
                                                )
                                            })}
                                        </div>
                                    )}
                                    {runtimeMode === 'existing' &&
                                        pickedRuntime?.framework ===
                                            'hermes' && (
                                            <div className='bg-surface shadow-ring-light mt-2 rounded-md px-3.5 py-3'>
                                                <label className='flex items-center gap-2'>
                                                    <input
                                                        type='checkbox'
                                                        checked={cloneEnabled}
                                                        onChange={(e) => {
                                                            setCloneEnabled(
                                                                e.target.checked
                                                            )
                                                            if (
                                                                !e.target
                                                                    .checked
                                                            )
                                                                setCloneFromProfile(
                                                                    ''
                                                                )
                                                        }}
                                                        className='accent-fg'
                                                    />
                                                    <span className='text-ui text-fg'>
                                                        {t(
                                                            'web.agentNew.cloneProfile'
                                                        )}
                                                    </span>
                                                </label>
                                                {cloneEnabled && (
                                                    <div className='mt-2'>
                                                        {runtimeAgentsLoading ? (
                                                            <p className='text-caption text-muted'>
                                                                {t(
                                                                    'web.agentNew.loadingProfiles'
                                                                )}
                                                            </p>
                                                        ) : runtimeAgentsError ? (
                                                            <p className='text-caption text-workflow-ship'>
                                                                {
                                                                    runtimeAgentsError
                                                                }
                                                            </p>
                                                        ) : pickedRuntimeAgents.length ===
                                                          0 ? (
                                                            <p className='text-caption text-muted'>
                                                                {t(
                                                                    'web.agentNew.noProfilesFound'
                                                                )}
                                                            </p>
                                                        ) : (
                                                            <WorkbenchSelect
                                                                mono
                                                                size='sm'
                                                                ariaLabel={t(
                                                                    'web.agentNew.cloneFromProfile'
                                                                )}
                                                                value={
                                                                    cloneFromProfile
                                                                }
                                                                onChange={
                                                                    setCloneFromProfile
                                                                }
                                                                options={pickedRuntimeAgents.map(
                                                                    (
                                                                        profile
                                                                    ) => ({
                                                                        value: profile.id,
                                                                        label: profile.name
                                                                    })
                                                                )}
                                                            />
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    {workspaceInputEnabled && (
                                        <div className='border-divider mt-3 border-t pt-3'>
                                            <span className='workbench-field-label mb-1 block'>
                                                {t('web.agentNew.workspace')}
                                            </span>
                                            {renderWorkspaceValue({
                                                defaultPath:
                                                    selectedWorkspaceDefault,
                                                active: true,
                                                onActivate: () => {}
                                            })}
                                        </div>
                                    )}
                                    {runtimesError && (
                                        <p className='text-caption text-workflow-ship mt-2'>
                                            {runtimesError}
                                        </p>
                                    )}
                                </div>
                            )}

                            {!isExternalFramework(framework) && (
                                <div>
                                    <div className='mb-2 flex items-center gap-1'>
                                        <span className='workbench-field-label mb-0'>
                                            {t(
                                                'web.agentNew.modelProviderSection'
                                            )}
                                        </span>
                                        <CompareButton
                                            label={t(
                                                'web.agentNew.aboutModelProvider'
                                            )}
                                            onOpen={() =>
                                                setModelProviderHelpOpen(true)
                                            }
                                        />
                                    </div>
                                    {providerTargetPicked ? (
                                        <ProviderSourceSection
                                            framework={framework}
                                            target={providerTarget}
                                            pickerMode={picker.mode}
                                            filter={providerSourceFilter}
                                            onFilterChange={
                                                setProviderSourceFilter
                                            }
                                            cloud={renderCreateRuntimeSettings()}
                                            cloudCards={providerCards}
                                            cloudActions={providerAddChip}
                                            cloudCount={cloudRowCount}
                                            localCount={localRowCount(
                                                providerTarget,
                                                runtimeAuth.list,
                                                sandboxAccountPrepare === null
                                            )}
                                            localProfileId={
                                                localCredentials.profileId
                                            }
                                            onLocalSelect={
                                                selectLocalCredential
                                            }
                                            runtime={
                                                runtimeMode === 'existing'
                                                    ? pickedRuntime
                                                    : null
                                            }
                                            auth={runtimeAuth}
                                            prewarming={runnerPrewarming}
                                            wakeRefusal={runnerPrewarm.refusal}
                                            onRetryWake={runnerPrewarm.retry}
                                            prepare={sandboxAccountPrepare}
                                            autoAddKey={autoAddAccountKey}
                                        />
                                    ) : (
                                        <p className='workbench-hint'>
                                            {t('web.agentNew.providerPending')}
                                        </p>
                                    )}
                                </div>
                            )}

                            {!isExternalFramework(framework) &&
                                providerTargetPicked &&
                                renderAdvancedConfig() && (
                                    <div>
                                        <div className='mb-2 flex items-center gap-1'>
                                            <span className='workbench-field-label mb-0'>
                                                {t(
                                                    'web.agentNew.advancedConfig'
                                                )}
                                            </span>
                                            <CompareButton
                                                label={t(
                                                    'web.agentNew.aboutAdvancedConfig'
                                                )}
                                                onOpen={() =>
                                                    setAdvancedConfigHelpOpen(
                                                        true
                                                    )
                                                }
                                            />
                                        </div>
                                        {renderAdvancedConfig()}
                                    </div>
                                )}

                            {isExternalFramework(framework) && (
                                <ExternalAgentSection
                                    framework={framework}
                                    providers={externalProviders}
                                    providersError={externalProvidersError}
                                    providerId={externalProviderId}
                                    onProviderIdChange={setExternalProviderId}
                                    remoteId={externalRemoteId}
                                    onRemoteIdChange={setExternalRemoteId}
                                />
                            )}

                            {error && (
                                <div className='workbench-alert-error'>
                                    <pre className='text-caption whitespace-pre-wrap font-mono'>
                                        {error}
                                    </pre>
                                </div>
                            )}

                            {frameworkModelConfigRequired &&
                                !frameworkModelValidation.valid && (
                                    <div className='workbench-note space-y-2'>
                                        {frameworkModelConfigView?.providerModelsStatus !==
                                        'ready' ? (
                                            frameworkProviderTesting ? (
                                                <p>
                                                    {t(
                                                        'web.agentNew.loadingProviderModels'
                                                    )}
                                                </p>
                                            ) : (
                                                <>
                                                    <p>
                                                        {t(
                                                            'web.agentNew.providerModelsNotLoaded'
                                                        )}
                                                    </p>
                                                    <button
                                                        type='button'
                                                        onClick={() =>
                                                            void runFrameworkProviderTest()
                                                        }
                                                        disabled={
                                                            providerTestDisabled ||
                                                            frameworkProviderTesting
                                                        }
                                                        className='workbench-button-secondary h-9'
                                                    >
                                                        {providerTestLabel}
                                                    </button>
                                                    {frameworkProviderTestError && (
                                                        <div className='workbench-alert-error'>
                                                            {
                                                                frameworkProviderTestError
                                                            }
                                                        </div>
                                                    )}
                                                </>
                                            )
                                        ) : (
                                            <p>
                                                {
                                                    frameworkModelValidation.message
                                                }
                                            </p>
                                        )}
                                    </div>
                                )}

                            <button
                                type='submit'
                                disabled={!canSubmit}
                                aria-busy={submitProgressLabel !== null}
                                className='workbench-button-primary h-11 w-full'
                            >
                                {submitProgressLabel !== null ? (
                                    <span className='inline-flex items-center gap-2'>
                                        <Spinner size={16} />
                                        {submitProgressLabel}
                                    </span>
                                ) : runtimeMode === 'existing' ? (
                                    t('web.agentNew.addAgentToRuntime')
                                ) : (
                                    t('web.agentNew.createAgent')
                                )}
                            </button>
                        </form>
                    )}
                </div>
            </div>
            {workspaceDialogOpen && workspaceInputEnabled && (
                <div
                    className='fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
                    role='dialog'
                    aria-modal='true'
                    aria-label={t('web.agentNew.configureWorkspace')}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            closeWorkspaceDialog()
                        }
                    }}
                >
                    <div className='workbench-panel flex max-h-[calc(100vh-3rem)] w-full max-w-xl flex-col overflow-hidden'>
                        <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                            <div className='min-w-0'>
                                <h2 className='text-ui text-fg truncate font-medium'>
                                    {t('web.agentNew.configureWorkspace')}
                                </h2>
                                <p className='text-caption text-muted mt-0.5 truncate'>
                                    {runtimeMode === 'existing'
                                        ? (pickedRuntime?.name ??
                                          t('web.agentNew.selectedRuntime'))
                                        : t('web.agentNew.createRuntime', {
                                              runtime: selectedRuntimeLabel
                                          })}
                                </p>
                            </div>
                            <button
                                type='button'
                                className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors'
                                aria-label={t('common.close')}
                                onClick={closeWorkspaceDialog}
                            >
                                <CloseIcon className='h-4 w-4' />
                            </button>
                        </header>
                        <div className='min-h-0 space-y-4 overflow-y-auto px-5 py-4'>
                            <label className='block'>
                                <span className='workbench-field-label'>
                                    {t('web.agentNew.workspaceDirectory')}
                                </span>
                                <input
                                    autoFocus
                                    value={workspaceDraftPath}
                                    onChange={(e) =>
                                        setWorkspaceDraftPath(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault()
                                            commitWorkspaceDraft()
                                        }
                                        if (e.key === 'Escape') {
                                            e.preventDefault()
                                            closeWorkspaceDialog()
                                        }
                                    }}
                                    placeholder={defaultWorkspaceValue}
                                    className='workbench-input font-mono'
                                    aria-label={t(
                                        'web.agentNew.workspaceDirectory'
                                    )}
                                />
                                <p className='workbench-hint mt-2'>
                                    {t('web.agentNew.workspaceHint')}
                                </p>
                                {workspaceDraftValidationMessage && (
                                    <p className='text-caption text-accent-ruby mt-1'>
                                        {workspaceDraftValidationMessage}
                                    </p>
                                )}
                            </label>
                            <div className='bg-soft shadow-ring-light rounded-md px-3 py-2'>
                                <div className='text-caption text-subtle font-medium'>
                                    {t('web.agentNew.defaultWorkspace')}
                                </div>
                                <div className='text-caption text-muted mt-0.5 truncate font-mono'>
                                    {defaultWorkspaceValue}
                                </div>
                            </div>
                        </div>
                        <footer className='border-divider/80 bg-surface-subtle/60 flex items-center justify-end gap-2 border-t px-5 py-3'>
                            <button
                                type='button'
                                className='workbench-button-secondary'
                                onClick={resetWorkspaceToDefault}
                            >
                                {t('web.agentNew.useDefault')}
                            </button>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                disabled={!!workspaceDraftValidationMessage}
                                onClick={commitWorkspaceDraft}
                            >
                                {t('common.done')}
                            </button>
                        </footer>
                    </div>
                </div>
            )}
            {renameTarget && (
                <RenameDialog
                    title={
                        renameTarget.kind === 'sandbox'
                            ? t('web.agentNew.renameSandbox')
                            : t('web.runtimeDetails.renameRuntime')
                    }
                    initialName={renameTarget.name}
                    submit={submitRename}
                    onClose={() => setRenameTarget(null)}
                />
            )}
            {confirmDialog}
            {addProvider && (
                <ModelProviderCreateDialog
                    pick={addProvider}
                    onClose={() => setAddProvider(null)}
                    onCreated={handleProviderCreated}
                />
            )}
            {connectDaemonOpen && (
                <ConnectDaemonDialog
                    framework={framework}
                    onClose={() => {
                        setConnectDaemonOpen(false)
                        void refetchRuntimes()
                    }}
                    onConnected={handleDaemonConnected}
                />
            )}
            {sandboxDialogOpen && (
                <div
                    className='fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
                    role='dialog'
                    aria-modal='true'
                    aria-label={t('web.sandboxNew.title')}
                    onClick={(e) => {
                        if (e.target === e.currentTarget && !sandboxCreating)
                            setSandboxDialogOpen(false)
                    }}
                >
                    <div className='workbench-panel flex w-full max-w-md flex-col overflow-hidden'>
                        <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                            <div className='min-w-0'>
                                <h2 className='text-ui text-fg truncate font-medium'>
                                    {t('web.sandboxNew.title')}
                                </h2>
                                <p className='text-caption text-muted mt-0.5 truncate'>
                                    {t('web.agentNew.sandboxDesc')}
                                </p>
                            </div>
                            <button
                                type='button'
                                className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors'
                                aria-label={t('common.close')}
                                disabled={sandboxCreating}
                                onClick={() => setSandboxDialogOpen(false)}
                            >
                                <CloseIcon className='h-4 w-4' />
                            </button>
                        </header>
                        <div className='space-y-4 px-5 py-4'>
                            <label className='block'>
                                <span className='workbench-field-label'>
                                    {t('web.agentNew.name')}
                                </span>
                                <input
                                    autoFocus
                                    value={sandboxDraftName}
                                    onChange={(e) =>
                                        setSandboxDraftName(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault()
                                            void createSandbox()
                                        }
                                        if (
                                            e.key === 'Escape' &&
                                            !sandboxCreating
                                        ) {
                                            e.preventDefault()
                                            setSandboxDialogOpen(false)
                                        }
                                    }}
                                    className='workbench-input font-mono'
                                    maxLength={64}
                                />
                                <p className='workbench-hint mt-2'>
                                    {t('web.agentNew.sandboxNameHint')}
                                </p>
                                {sandboxNameValidationMessage && (
                                    <p className='text-caption text-accent-ruby mt-1'>
                                        {sandboxNameValidationMessage}
                                    </p>
                                )}
                            </label>
                        </div>
                        <footer className='border-divider/80 bg-surface-subtle/60 flex items-center justify-end gap-2 border-t px-5 py-3'>
                            <button
                                type='button'
                                className='workbench-button-secondary'
                                disabled={sandboxCreating}
                                onClick={() => setSandboxDialogOpen(false)}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                disabled={
                                    sandboxCreating ||
                                    sandboxNameValidationMessage !== null
                                }
                                onClick={() => void createSandbox()}
                            >
                                {sandboxCreating
                                    ? t('web.sandboxNew.creating')
                                    : t('web.sandboxNew.create')}
                            </button>
                        </footer>
                    </div>
                </div>
            )}
            {modelProviderHelpOpen && (
                <ProductDialog
                    title={t('web.agentNew.aboutModelProvider')}
                    onClose={() => setModelProviderHelpOpen(false)}
                >
                    <div className='text-ui text-muted space-y-3'>
                        <p>{t('web.agentNew.modelProviderHelpCloud')}</p>
                        <p>{t('web.agentNew.modelProviderHelpLocal')}</p>
                        <p>{t('web.agentNew.modelProviderHelpPick')}</p>
                    </div>
                </ProductDialog>
            )}
            {advancedConfigHelpOpen && (
                <ProductDialog
                    title={t('web.agentNew.aboutAdvancedConfig')}
                    onClose={() => setAdvancedConfigHelpOpen(false)}
                >
                    <div className='text-ui text-muted space-y-3'>
                        <p>{t('web.agentNew.advancedConfigHelpMapping')}</p>
                        <p>{t('web.agentNew.advancedConfigHelpPrimary')}</p>
                        <p>{t('web.agentNew.advancedConfigHelpLocal')}</p>
                    </div>
                </ProductDialog>
            )}
            {runtimeCompareDialogOpen && (
                <div
                    className='fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
                    role='dialog'
                    aria-modal='true'
                    aria-label={t('web.agentNew.compareAgentRuntimes')}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setRuntimeCompareDialogOpen(false)
                        }
                    }}
                >
                    <div className='workbench-panel flex max-h-[calc(100vh-3rem)] w-full max-w-3xl flex-col overflow-hidden'>
                        <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                            <div className='min-w-0'>
                                <h2 className='text-ui text-fg truncate font-medium'>
                                    {t('web.agentNew.compareAgentRuntimes')}
                                </h2>
                                <p className='text-caption text-muted mt-0.5 truncate'>
                                    {t('web.agentNew.compareRuntimesDesc')}
                                </p>
                            </div>
                            <button
                                type='button'
                                className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors'
                                aria-label={t('common.close')}
                                onClick={() =>
                                    setRuntimeCompareDialogOpen(false)
                                }
                            >
                                <CloseIcon className='h-4 w-4' />
                            </button>
                        </header>
                        <div className='min-h-0 overflow-y-auto px-5 py-4'>
                            <div className='scrollbar-hidden bg-surface shadow-ring-light overflow-x-auto rounded-md'>
                                <table className='text-caption w-full min-w-[52rem] table-fixed border-collapse text-left'>
                                    <thead className='bg-surface-subtle text-subtle'>
                                        <tr>
                                            <th
                                                className='w-36 px-4 py-2.5'
                                                aria-hidden='true'
                                            />
                                            <th
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'sandbox',
                                                    !supportsSandbox(framework)
                                                )}
                                            >
                                                <span className='min-w-0'>
                                                    <span className='text-ui text-fg block font-medium'>
                                                        {t(
                                                            'web.agentNew.statefulSandbox'
                                                        )}
                                                    </span>
                                                    <span className='text-caption text-subtle mt-0.5 block font-normal'>
                                                        {t(
                                                            'web.agentNew.usageBased'
                                                        )}
                                                    </span>
                                                    {runtimeQuotaLabel(
                                                        'sandbox'
                                                    ) && (
                                                        <span className='text-caption text-muted mt-1 block font-mono'>
                                                            {runtimeQuotaLabel(
                                                                'sandbox'
                                                            )}
                                                        </span>
                                                    )}
                                                </span>
                                            </th>
                                            <th
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'persistent'
                                                )}
                                            >
                                                <span className='min-w-0'>
                                                    <span className='text-ui text-fg block font-medium'>
                                                        {t(
                                                            'web.agentNew.persistent'
                                                        )}
                                                    </span>
                                                    <span className='text-caption text-subtle mt-0.5 block font-normal'>
                                                        {t(
                                                            'web.agentNew.alwaysOnlineRented'
                                                        )}
                                                    </span>
                                                    {runtimeQuotaLabel(
                                                        'persistent'
                                                    ) && (
                                                        <span className='text-caption text-muted mt-1 block font-mono'>
                                                            {runtimeQuotaLabel(
                                                                'persistent'
                                                            )}
                                                        </span>
                                                    )}
                                                </span>
                                            </th>
                                            <th
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'daemon',
                                                    !daemonSupported
                                                )}
                                            >
                                                <span className='min-w-0'>
                                                    <span className='text-ui text-fg block font-medium'>
                                                        {t(
                                                            'web.agentNew.localDaemon'
                                                        )}
                                                    </span>
                                                    <span className='text-caption text-subtle mt-0.5 block font-normal'>
                                                        {t(
                                                            'web.agentNew.alwaysOnlineYourMachine'
                                                        )}
                                                    </span>
                                                </span>
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className='divide-divider text-muted divide-y'>
                                        <tr>
                                            <td className='text-fg px-4 py-2.5 font-medium'>
                                                {t('web.agentNew.cost')}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'sandbox',
                                                    !supportsSandbox(framework)
                                                )}
                                            >
                                                {t('web.agentNew.sandboxCost')}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'persistent'
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.persistentCost'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'daemon',
                                                    !daemonSupported
                                                )}
                                            >
                                                {t('web.agentNew.daemonCost')}
                                            </td>
                                        </tr>
                                        <tr>
                                            <td className='text-fg px-4 py-2.5 font-medium'>
                                                {t('web.agentNew.response')}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'sandbox',
                                                    !supportsSandbox(framework)
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.sandboxResponse'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'persistent'
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.persistentResponse'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'daemon',
                                                    !daemonSupported
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.daemonResponse'
                                                )}
                                            </td>
                                        </tr>
                                        <tr>
                                            <td className='text-fg px-4 py-2.5 font-medium'>
                                                {t(
                                                    'web.agentNew.backgroundTasks'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'sandbox',
                                                    !supportsSandbox(framework)
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.sandboxBackground'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'persistent'
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.persistentBackground'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'daemon',
                                                    !daemonSupported
                                                )}
                                            >
                                                {t(
                                                    'web.agentNew.daemonBackground'
                                                )}
                                            </td>
                                        </tr>
                                        <tr>
                                            <td className='text-fg px-4 py-2.5 font-medium'>
                                                {t(
                                                    'web.agentNew.deployableAgents'
                                                )}
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'sandbox',
                                                    !supportsSandbox(framework)
                                                )}
                                            >
                                                <RuntimeAgentIcons
                                                    frameworks={[
                                                        'claude-code',
                                                        'codex',
                                                        'gemini-cli',
                                                        'openclaw',
                                                        'hermes',
                                                        'narranexus'
                                                    ]}
                                                    label={t(
                                                        'web.agentNew.deployableAgentsFull'
                                                    )}
                                                />
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'persistent'
                                                )}
                                            >
                                                <RuntimeAgentIcons
                                                    frameworks={[
                                                        'claude-code',
                                                        'codex',
                                                        'gemini-cli',
                                                        'openclaw',
                                                        'hermes',
                                                        'narranexus'
                                                    ]}
                                                    label={t(
                                                        'web.agentNew.deployableAgentsFull'
                                                    )}
                                                />
                                            </td>
                                            <td
                                                className={runtimeColumnClass(
                                                    selectedRuntimeCategory ===
                                                        'daemon',
                                                    !daemonSupported
                                                )}
                                            >
                                                <RuntimeAgentIcons
                                                    frameworks={[
                                                        'claude-code',
                                                        'codex',
                                                        'gemini-cli',
                                                        'openclaw',
                                                        'hermes'
                                                    ]}
                                                    label={t(
                                                        'web.agentNew.deployableAgentsShort'
                                                    )}
                                                />
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <footer className='border-divider/80 bg-surface-subtle/60 flex items-center justify-end gap-2 border-t px-5 py-3'>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                onClick={() =>
                                    setRuntimeCompareDialogOpen(false)
                                }
                            >
                                {t('common.done')}
                            </button>
                        </footer>
                    </div>
                </div>
            )}
            {frameworkCompareDialogOpen && (
                <div
                    className='fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
                    role='dialog'
                    aria-modal='true'
                    aria-label={t('web.agentNew.compareFrameworks')}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setFrameworkCompareDialogOpen(false)
                        }
                    }}
                >
                    <div className='workbench-panel flex max-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col overflow-hidden'>
                        <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                            <div className='min-w-0'>
                                <h2 className='text-ui text-fg truncate font-medium'>
                                    {t('web.agentNew.compareFrameworks')}
                                </h2>
                                <p className='text-caption text-muted mt-0.5 truncate'>
                                    {t('web.agentNew.compareFrameworksDesc')}
                                </p>
                            </div>
                            <button
                                type='button'
                                className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors'
                                aria-label={t('common.close')}
                                onClick={() =>
                                    setFrameworkCompareDialogOpen(false)
                                }
                            >
                                <CloseIcon className='h-4 w-4' />
                            </button>
                        </header>
                        <div className='min-h-0 overflow-y-auto px-5 py-4'>
                            <div className='scrollbar-hidden bg-surface shadow-ring-light overflow-x-auto rounded-md'>
                                <table className='text-caption w-full min-w-[40rem] border-collapse text-left'>
                                    <thead className='bg-surface-subtle text-subtle'>
                                        <tr>
                                            <th className='px-4 py-2.5 font-medium'>
                                                {t('web.agentNew.framework')}
                                            </th>
                                            <th className='px-4 py-2.5 font-medium'>
                                                {t('web.agentNew.bestFor')}
                                            </th>
                                            <th className='px-4 py-2.5 font-medium'>
                                                {t('web.agentNew.runtime')}
                                            </th>
                                            <th className='px-4 py-2.5 font-medium'>
                                                {t('web.agentNew.status')}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className='divide-divider text-muted divide-y'>
                                        {localizedFrameworkOptions.map(
                                            (opt) => {
                                                const runtime = ((): string => {
                                                    if (
                                                        !isCreateableFramework(
                                                            opt.value
                                                        )
                                                    )
                                                        return '—'
                                                    if (
                                                        isExternalFramework(
                                                            opt.value
                                                        )
                                                    )
                                                        return t(
                                                            'web.agentNew.externalBinding'
                                                        )
                                                    const kinds =
                                                        reuseRuntimeKindsFor(
                                                            opt.value
                                                        )
                                                    const parts: string[] = []
                                                    if (kinds.has('sprites'))
                                                        parts.push(
                                                            t(
                                                                'web.agentNew.statefulSandbox'
                                                            )
                                                        )
                                                    if (kinds.has('k8s'))
                                                        parts.push(
                                                            t(
                                                                'web.agentNew.persistent'
                                                            )
                                                        )
                                                    if (kinds.has('daemon'))
                                                        parts.push(
                                                            t(
                                                                'web.agentNew.localDaemon'
                                                            )
                                                        )
                                                    return parts.length > 0
                                                        ? parts.join(' · ')
                                                        : '—'
                                                })()
                                                return (
                                                    <tr key={opt.value}>
                                                        <td className='text-fg px-4 py-3 align-top font-medium'>
                                                            <span className='flex items-center gap-2'>
                                                                <FrameworkLogo
                                                                    framework={
                                                                        opt.value
                                                                    }
                                                                    className='h-7 w-7'
                                                                />
                                                                <span className='truncate'>
                                                                    {opt.label}
                                                                </span>
                                                            </span>
                                                        </td>
                                                        <td className='px-4 py-3 align-top'>
                                                            {opt.description}
                                                        </td>
                                                        <td className='px-4 py-3 align-top'>
                                                            {runtime}
                                                        </td>
                                                        <td className='px-4 py-3 align-top'>
                                                            {opt.disabled ? (
                                                                <span className='tag tag-neutral'>
                                                                    {t(
                                                                        'web.agentNew.coming'
                                                                    )}
                                                                </span>
                                                            ) : (
                                                                t(
                                                                    'web.agentNew.available'
                                                                )
                                                            )}
                                                        </td>
                                                    </tr>
                                                )
                                            }
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <footer className='border-divider/80 bg-surface-subtle/60 flex items-center justify-end gap-2 border-t px-5 py-3'>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                onClick={() =>
                                    setFrameworkCompareDialogOpen(false)
                                }
                            >
                                {t('common.done')}
                            </button>
                        </footer>
                    </div>
                </div>
            )}
        </>
    )
}

export default AgentNew
