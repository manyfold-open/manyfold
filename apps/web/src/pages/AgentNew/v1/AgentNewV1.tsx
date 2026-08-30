import {
    AgentRuntimeSummary,
    CreateAgentBody,
    K8S_HOME_BASE,
    NARRANEXUS_K8S_BASE_WORKING_PATH,
    NARRANEXUS_SPRITE_BASE_WORKING_PATH,
    SPRITE_HOME_BASE,
    UserExternalAgentProviderSummary,
    UserModelProvider,
    externalSteps,
    normalizeAgentName,
    providerSupportsTarget,
    validateAgentName
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckIcon, CloseIcon, PlusIcon } from '@/components/icons'
import { useAppShellContext } from '@/components/AppShell'
import { DashboardViewToggle } from '@/components/DashboardCard'
import WorkbenchSelect, {
    type WorkbenchSelectOption
} from '@/components/WorkbenchSelect'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import {
    initialPicker,
    pickerIsValid,
    ProviderPicker,
    type ProviderPickerValue
} from '@/pages/AgentNew/components/ProviderPicker'
import { CreateProgress } from '@/pages/AgentNew/components/CreateProgress'
import { FrameworkLogo as FrameworkLogoMark } from '@/lib/frameworkMeta'
import {
    apiKeyLabelForProvider,
    buildAddRuntimeAgentBody,
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
import { preferredPrimaryModelDefault } from '@/lib/agentModelConfig'
import {
    computeSpriteTargets,
    type SpriteAttachTarget
} from '@/lib/agentCreate/spriteTargets'
import {
    openclawWorkspaceFor,
    preferredSavedProviderFor
} from '@/lib/agentCreate/providerHelpers'
import { useAgentCreate } from '@/lib/agentCreate/useAgentCreate'
import { useFrameworkModelConfig } from '@/lib/agentCreate/useFrameworkModelConfig'
import { CreateFrameworkModelConfig } from '@/pages/AgentNew/components/shared/CreateFrameworkModelConfig'
import { useI18n } from '@/lib/i18n'
import { BILLING_SURFACE } from '@/edition-capabilities'

const persistentProviderOptions: Array<{
    value: PersistentModelProvider
    label: string
}> = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' }
]

const cardClass = (active: boolean, disabled = false): string =>
    [
        'flex items-center gap-3 rounded-md px-4 py-4 text-ui transition-colors shadow-ring-light',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        disabled
            ? 'bg-[#f7f7f4] text-muted'
            : active
              ? 'bg-white text-fg shadow-card'
              : 'bg-[#f7f7f4] text-muted hover:bg-white hover:text-fg'
    ].join(' ')

const runtimeColumnClass = (_active: boolean, disabled = false): string =>
    [
        'border-divider border-l px-4 py-2.5 align-top',
        disabled ? 'text-placeholder' : 'text-muted'
    ].join(' ')

const runtimeTargetClass = (active: boolean, disabled: boolean): string =>
    [
        'shadow-ring-light focus-visible:shadow-focus flex w-full flex-col gap-2 rounded-md px-3 py-2.5 text-left transition-[color,background-color,box-shadow] focus:outline-none',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        disabled
            ? 'bg-surface text-muted'
            : active
              ? 'bg-info-bg text-fg shadow-card ring-1 ring-link/40'
              : 'bg-surface text-muted hover:bg-surface-hover'
    ].join(' ')

const runtimeSelectionIndicatorClass = (active: boolean): string =>
    [
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
        active
            ? 'border-link bg-link text-white'
            : 'border-divider bg-surface text-transparent'
    ].join(' ')

const runtimePropertyGridClass =
    'border-divider grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 border-t pt-2 sm:grid-cols-[7.5rem_minmax(0,1fr)]'

const runtimePropertyLabelClass = 'text-caption text-subtle font-medium'

// A runtime the agent can land on: either one this form provisions (`create`)
// or one that already exists (`existing`). Both shapes select the same way, so
// the picker renders one list instead of a tab per provenance.
type RuntimeTargetKind = 'sprites' | 'k8s' | 'daemon'
type RuntimeKindFilter = 'all' | RuntimeTargetKind

interface RuntimeTargetMeta {
    label: string
    value: string
    mono?: boolean
    warn?: boolean
}

interface RuntimeTarget {
    key: string
    kind: RuntimeTargetKind
    group: 'create' | 'existing'
    framework: CreateableFramework
    name: string
    tag: string | null
    detail: string
    meta: RuntimeTargetMeta[]
    selected: boolean
    disabled: boolean
    disabledReason: string | null
    onSelect: () => void
}

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

const RuntimeTargetItem: FC<{
    target: RuntimeTarget
    view: DashboardView
    kindLabel: string
}> = ({ target, view, kindLabel }): ReactNode => (
    <button
        type='button'
        disabled={target.disabled}
        onClick={target.onSelect}
        aria-pressed={target.selected}
        className={runtimeTargetClass(target.selected, target.disabled)}
    >
        <span className='flex w-full min-w-0 items-center gap-2'>
            <FrameworkLogo framework={target.framework} className='h-7 w-7' />
            <span className='min-w-0 flex-1'>
                <span className='flex min-w-0 items-center gap-1.5'>
                    <span className='tag tag-neutral'>{kindLabel}</span>
                    {target.tag && (
                        <span className='tag tag-neutral'>{target.tag}</span>
                    )}
                    <span className='text-caption text-fg min-w-0 truncate font-medium'>
                        {target.name}
                    </span>
                </span>
                <span className='text-caption text-subtle mt-0.5 block truncate'>
                    {target.disabledReason ?? target.detail}
                </span>
            </span>
            {!target.disabled && (
                <span
                    className={runtimeSelectionIndicatorClass(target.selected)}
                    aria-hidden='true'
                >
                    <CheckIcon className='h-3 w-3' />
                </span>
            )}
        </span>
        {target.meta.length > 0 &&
            (view === 'grid' ? (
                <span className={runtimePropertyGridClass}>
                    {target.meta.map((item) => (
                        <Fragment key={item.label}>
                            <span className={runtimePropertyLabelClass}>
                                {item.label}
                            </span>
                            <span
                                className={[
                                    'text-caption min-w-0 truncate',
                                    item.warn
                                        ? 'text-workflow-ship'
                                        : 'text-muted',
                                    item.mono ? 'font-mono' : ''
                                ].join(' ')}
                            >
                                {item.value}
                            </span>
                        </Fragment>
                    ))}
                </span>
            ) : (
                <span className='text-caption flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5'>
                    {target.meta.map((item) => (
                        <span key={item.label} className='min-w-0 truncate'>
                            <span className='text-subtle mr-1 font-medium'>
                                {item.label}
                            </span>
                            <span
                                className={[
                                    item.warn
                                        ? 'text-workflow-ship'
                                        : 'text-muted',
                                    item.mono ? 'font-mono' : ''
                                ].join(' ')}
                            >
                                {item.value}
                            </span>
                        </span>
                    ))}
                </span>
            ))}
    </button>
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
    const { refreshAgents } = useAppShellContext()
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
        submitAddToRuntime
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
    const [runtimeCompareDialogOpen, setRuntimeCompareDialogOpen] =
        useState(false)
    const [frameworkCompareDialogOpen, setFrameworkCompareDialogOpen] =
        useState(false)
    const [pickedRuntimeId, setPickedRuntimeId] = useState(initialRuntimeId)
    const [attachSandboxHostId, setAttachSandboxHostId] = useState('')
    const [frameworkVersionSel, setFrameworkVersionSel] = useState(() =>
        /^v?\d+\.\d+\.\d+$/.test(initialVersion) ? initialVersion : ''
    )
    const [persistentModelProvider, setPersistentModelProvider] =
        useState<PersistentModelProvider>('anthropic')
    const [primaryModelName, setPrimaryModelName] = useState('')
    const [primaryModelCustom, setPrimaryModelCustom] = useState(false)
    const [cloneEnabled, setCloneEnabled] = useState(false)
    const [cloneFromProfile, setCloneFromProfile] = useState('')
    const [picker, setPicker] = useState<ProviderPickerValue>(initialPicker)
    const [externalProviderId, setExternalProviderId] = useState('')
    const [externalRemoteId, setExternalRemoteId] = useState('')

    const credentialProvider = modelProviderForFramework(framework)
    const modelProviderForRuntime: UserModelProvider =
        usesConfigurableModelProvider(framework)
            ? persistentModelProvider
            : credentialProvider

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
            if (
                selected &&
                providerSupportsTarget(selected, modelProviderForRuntime)
            )
                return current

            const preferred = preferredSavedProviderFor(
                providers,
                modelProviderForRuntime
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
    }, [modelProviderForRuntime, providers, runtimeMode])

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

    const sandboxPreselectedRef = useRef(false)
    useEffect(() => {
        if (sandboxPreselectedRef.current) return
        if (!initialSandboxId) return
        const target = spriteAttachTargets.find(
            (t) => t.hostId === initialSandboxId
        )
        if (!target) {
            if (runtimes.length > 0 || sandboxes.length > 0)
                sandboxPreselectedRef.current = true
            return
        }
        sandboxPreselectedRef.current = true
        setRuntimeMode('sandbox')
        setAttachSandboxHostId(target.hostId)
        setPickedRuntimeId('')
    }, [initialSandboxId, spriteAttachTargets, runtimes, sandboxes])

    const pickedRuntime = useMemo(
        () => reusable.find((r) => r.id === pickedRuntimeId) ?? null,
        [reusable, pickedRuntimeId]
    )

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
        const nextPersistentProvider: PersistentModelProvider =
            usesConfigurableModelProvider(next)
                ? 'openai'
                : modelProviderForFramework(next) === 'google'
                  ? 'anthropic'
                  : (modelProviderForFramework(next) as PersistentModelProvider)
        setPersistentModelProvider(nextPersistentProvider)
        const nextTargetProvider: UserModelProvider =
            usesConfigurableModelProvider(next)
                ? nextPersistentProvider
                : modelProviderForFramework(next)
        const preferred = preferredSavedProviderFor(
            providers,
            nextTargetProvider
        )
        setPicker(
            preferred
                ? { ...initialPicker(), providerId: preferred.id }
                : initialPicker()
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
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const selectAttachSandboxTarget = (target: SpriteAttachTarget): void => {
        if (runtimeMode === 'sandbox' && attachSandboxHostId === target.hostId)
            return
        setRuntimeMode('sandbox')
        setAttachSandboxHostId(target.hostId)
        setPickedRuntimeId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const changeRuntimeView = (next: DashboardView): void => {
        setRuntimeView(next)
        writeDashboardView(AGENT_NEW_RUNTIME_VIEW_KEY, next)
    }

    const randomizeName = (): void => {
        setName(randomAgentName())
    }

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

    const canSubmit = (() => {
        if (busy || streamOpen) return false
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
            return true
        }
        if (runtimeMode === 'sandbox' && !supportsSandbox(framework))
            return false
        if (runtimeMode === 'persistent') return false
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
    const runtimeKindLabel = (kind: RuntimeTargetKind): string =>
        kind === 'sprites'
            ? t('web.agentNew.sandbox')
            : kind === 'k8s'
              ? t('web.agentNew.persistent')
              : t('web.agentNew.localDaemon')

    const quotaMeta = (category: RuntimeCategory): RuntimeTargetMeta[] => {
        const label = runtimeQuotaLabel(category)
        if (!label) return []
        return [
            {
                label: t('web.agentNew.runtime'),
                value: label,
                mono: true,
                warn:
                    category === 'sandbox'
                        ? sandboxLimitReached
                        : persistentLimitReached
            }
        ]
    }

    // Create-new and reuse targets share one list: the picker's job is "where
    // does this agent land", and that question does not split by provenance.
    // Containers are a purchased product only where a billing surface exists,
    // so on that edition renting stays a link instead of a selectable target.
    const runtimeTargets: RuntimeTarget[] = [
        ...(supportsSandbox(framework)
            ? [
                  {
                      key: 'create:sandbox',
                      kind: 'sprites' as const,
                      group: 'create' as const,
                      framework,
                      name: t('web.agentNew.createRuntimeNamed', {
                          runtime: t('web.agentNew.sandbox')
                      }),
                      tag: t('web.agentNew.recommended'),
                      detail: t('web.agentNew.sandboxDesc'),
                      meta: quotaMeta('sandbox'),
                      selected:
                          runtimeMode === 'sandbox' && !attachSandboxHostId,
                      disabled: sandboxLimitReached,
                      disabledReason: sandboxLimitReached
                          ? t('web.agentNew.limitReached')
                          : null,
                      onSelect: () => selectRuntimeCategory('sandbox')
                  }
              ]
            : []),
        ...(cloudComputerAvailable && !BILLING_SURFACE
            ? [
                  {
                      key: 'create:persistent',
                      kind: 'k8s' as const,
                      group: 'create' as const,
                      framework,
                      name: t('web.agentNew.createRuntimeNamed', {
                          runtime: t('web.agentNew.persistent')
                      }),
                      tag: null,
                      detail: t('web.agentNew.computerTagline'),
                      meta: quotaMeta('persistent'),
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
            framework: isCreateableFramework(r.framework)
                ? r.framework
                : framework,
            name: r.name,
            tag: null,
            detail:
                r.agentsCount === 1
                    ? t('web.agentNew.agentCountOne')
                    : t('web.agentNew.agentCountMany', {
                          count: String(r.agentsCount)
                      }),
            meta: [
                {
                    label: t('web.agentNew.frameworkLabel'),
                    value:
                        localizedFrameworkOptions.find(
                            (opt) => opt.value === r.framework
                        )?.label ?? r.framework
                },
                ...(r.kind === 'daemon'
                    ? [
                          {
                              label: t('web.agentNew.machine'),
                              value: r.daemonName ?? r.name
                          },
                          {
                              label: t('web.agentNew.status'),
                              value: r.daemonOnline
                                  ? t('web.agentNew.online')
                                  : t('web.agentNew.offline'),
                              warn: !r.daemonOnline
                          }
                      ]
                    : [])
            ],
            selected: runtimeMode === 'existing' && pickedRuntimeId === r.id,
            disabled: false,
            disabledReason: null,
            onSelect: () => selectExistingRuntimeTarget(r)
        })),
        ...spriteAttachTargets.map((target) => ({
            key: `sandbox:${target.hostId}`,
            kind: 'sprites' as const,
            group: 'existing' as const,
            framework,
            name: target.name ?? target.spriteName ?? target.hostId,
            tag: null,
            detail: t('web.agentNew.addFramework', {
                framework: selectedFramework.label
            }),
            meta: [
                {
                    label: t('web.agentNew.runs'),
                    value: target.frameworks
                        .map(
                            (f) =>
                                localizedFrameworkOptions.find(
                                    (o) => o.value === f
                                )?.label ?? f
                        )
                        .join(', ')
                },
                {
                    label: t('web.agentNew.runtime'),
                    value: `${target.runtimeCount}/4`,
                    mono: true
                }
            ],
            selected:
                runtimeMode === 'sandbox' &&
                attachSandboxHostId === target.hostId,
            disabled: false,
            disabledReason: null,
            onSelect: () => selectAttachSandboxTarget(target)
        }))
    ]

    const runtimeKindsPresent = Array.from(
        new Set(runtimeTargets.map((target) => target.kind))
    )
    const runtimeKindFilterOptions: RuntimeKindFilter[] = [
        'all',
        ...runtimeKindsPresent
    ]
    const visibleRuntimeTargets =
        runtimeKindFilter === 'all'
            ? runtimeTargets
            : runtimeTargets.filter(
                  (target) => target.kind === runtimeKindFilter
              )
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
            const created = await submitAddToRuntime({
                runtimeId: pickedRuntime.id,
                body: buildAddRuntimeAgentBody({
                    name: normalizedName,
                    workspace: effectiveExistingWorkspace,
                    cloneFrom:
                        pickedRuntime.framework === 'hermes' && cloneEnabled
                            ? cloneFromProfile || undefined
                            : undefined
                })
            })
            if (created) {
                await refreshAgents()
                navigate(`/agents/${created.id}/chat`)
            }
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

    const renderCreateRuntimeSettings = (): ReactNode => (
        <div className='space-y-4'>
            {usesConfigurableModelProvider(framework) && (
                <div>
                    <span className='workbench-field-label'>
                        {t('web.agentNew.apiProvider')}
                    </span>
                    <div className='grid gap-2 md:grid-cols-2'>
                        {persistentProviderOptions.map((opt) => (
                            <button
                                key={opt.value}
                                type='button'
                                onClick={() => {
                                    setPersistentModelProvider(opt.value)
                                    setPicker(initialPicker())
                                    setPrimaryModelName('')
                                    setPrimaryModelCustom(false)
                                    setFrameworkModelConfig(null)
                                }}
                                className={cardClass(
                                    persistentModelProvider === opt.value
                                )}
                            >
                                <span>{opt.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <ProviderPicker
                provider={modelProviderForRuntime}
                framework={framework}
                label={
                    usesConfigurableModelProvider(framework)
                        ? t('web.agentNew.apiKey')
                        : t('web.agentNew.apiProvider')
                }
                apiKeyLabel={
                    usesConfigurableModelProvider(framework)
                        ? persistentModelProvider === 'anthropic'
                            ? t('web.agentNew.anthropicAuthToken')
                            : t('web.agentNew.openAiApiKey')
                        : apiKeyLabelForProvider(credentialProvider)
                }
                apiKeyHint={t('web.agentNew.providerKeyHint')}
                baseUrlLabel={t('web.agentNew.baseUrlOptional')}
                baseUrlPlaceholder={t('web.agentNew.baseUrlProxyPlaceholder')}
                options={providers}
                value={picker}
                onChange={(next) => {
                    setPicker(next)
                    setFrameworkModelConfig(null)
                }}
            />

            {frameworkModelConfigRequired && (
                <CreateFrameworkModelConfig
                    view={frameworkModelConfigView}
                    draft={frameworkModelConfig}
                    validationMessage={frameworkModelValidation.message}
                    onChange={setFrameworkModelConfig}
                    onTestProvider={() => void runFrameworkProviderTest()}
                    providerTestLabel={providerTestLabel}
                    providerTesting={frameworkProviderTesting}
                    providerTestDisabled={providerTestDisabled}
                    providerTestError={frameworkProviderTestError}
                />
            )}

            {usesConfigurableModelProvider(framework) && (
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
            )}
        </div>
    )

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
                                <h2 className='text-h3 text-fg tracking-tight'>
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
                                <div className='mb-1 flex items-center justify-between gap-2'>
                                    <span className='workbench-field-label'>
                                        {t('web.agentNew.agentFramework')}
                                    </span>
                                    <button
                                        type='button'
                                        onClick={() =>
                                            setFrameworkCompareDialogOpen(true)
                                        }
                                        className='text-caption text-fg underline underline-offset-2 hover:opacity-80'
                                    >
                                        {t('web.agentNew.compareFrameworks')}
                                    </button>
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
                                    <div className='mb-2 flex flex-wrap items-center gap-2'>
                                        <span className='workbench-field-label'>
                                            {t('web.agentNew.agentRuntime')}
                                        </span>
                                        <span className='tag tag-neutral tabular-nums'>
                                            {runtimeTargets.length}
                                        </span>
                                        <span className='min-w-2 flex-1' />
                                        <button
                                            type='button'
                                            onClick={() =>
                                                setRuntimeCompareDialogOpen(
                                                    true
                                                )
                                            }
                                            className='text-caption text-fg underline underline-offset-2 hover:opacity-80'
                                        >
                                            {t('web.agentNew.compareRuntimes')}
                                        </button>
                                        <DashboardViewToggle
                                            value={runtimeView}
                                            onChange={changeRuntimeView}
                                            ariaLabel={t(
                                                'web.agentNew.agentRuntime'
                                            )}
                                        />
                                    </div>
                                    {runtimeKindFilterOptions.length > 2 && (
                                        <div
                                            role='group'
                                            aria-label={t(
                                                'web.agentNew.runtimeCategory'
                                            )}
                                            className='bg-soft shadow-ring-light mb-2 inline-flex gap-1 rounded-md p-1'
                                        >
                                            {runtimeKindFilterOptions.map(
                                                (kind) => (
                                                    <button
                                                        key={kind}
                                                        type='button'
                                                        aria-pressed={
                                                            runtimeKindFilter ===
                                                            kind
                                                        }
                                                        onClick={() =>
                                                            setRuntimeKindFilter(
                                                                kind
                                                            )
                                                        }
                                                        className={[
                                                            'text-caption inline-flex h-7 items-center rounded-sm px-2.5 transition-colors',
                                                            runtimeKindFilter ===
                                                            kind
                                                                ? 'bg-surface text-fg shadow-ring-light'
                                                                : 'text-muted hover:bg-surface-hover'
                                                        ].join(' ')}
                                                    >
                                                        {kind === 'all'
                                                            ? t(
                                                                  'web.agentNew.filterAll'
                                                              )
                                                            : runtimeKindLabel(
                                                                  kind
                                                              )}
                                                    </button>
                                                )
                                            )}
                                        </div>
                                    )}
                                    {visibleRuntimeTargets.length === 0 ? (
                                        <p className='text-caption text-muted font-medium'>
                                            {t('web.agentNew.notAvailable')}
                                        </p>
                                    ) : (
                                        <div
                                            className={
                                                runtimeView === 'grid'
                                                    ? 'grid gap-2 sm:grid-cols-2'
                                                    : 'grid gap-2'
                                            }
                                        >
                                            {visibleRuntimeTargets.map(
                                                (target) => (
                                                    <RuntimeTargetItem
                                                        key={target.key}
                                                        target={target}
                                                        view={runtimeView}
                                                        kindLabel={runtimeKindLabel(
                                                            target.kind
                                                        )}
                                                    />
                                                )
                                            )}
                                        </div>
                                    )}
                                    {newRuntimeEntries.length > 0 && (
                                        <div className='mt-2 flex flex-wrap gap-2'>
                                            {newRuntimeEntries.map((option) => {
                                                const Icon = option.icon
                                                return (
                                                    <Link
                                                        key={option.kind}
                                                        to={option.to}
                                                        className='text-caption text-muted hover:text-fg hover:bg-surface-hover border-divider inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 transition-colors'
                                                    >
                                                        <PlusIcon className='h-3.5 w-3.5 shrink-0' />
                                                        <Icon className='h-3.5 w-3.5 shrink-0' />
                                                        {t(option.labelKey)}
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

                            {!isExternalFramework(framework) &&
                                runtimeMode !== 'existing' && (
                                    <div>
                                        <span className='workbench-field-label mb-2 block'>
                                            {t(
                                                'web.agentNew.modelProviderSection'
                                            )}
                                        </span>
                                        {renderCreateRuntimeSettings()}
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
                                className='workbench-button-primary h-11 w-full'
                            >
                                {runtimeMode === 'existing'
                                    ? t('web.agentNew.addAgentToRuntime')
                                    : t('web.agentNew.createAgent')}
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
