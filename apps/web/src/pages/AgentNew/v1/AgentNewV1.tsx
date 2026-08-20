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
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
    CheckIcon,
    ChevronDownIcon,
    CloseIcon,
    MenuIcon,
    ProviderIcon
} from '@/components/icons'
import { useAppShellContext } from '@/components/AppShell'
import WorkbenchSelect from '@/components/WorkbenchSelect'
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
    runtimeTopChoices,
    supportsSandbox,
    topChoiceForCategory,
    usesConfigurableModelProvider,
    remoteIdHintFor,
    remoteIdLabelFor,
    remoteIdPlaceholderFor,
    type FrameworkChoice,
    type RuntimeCategory,
    type RuntimeMode,
    type RuntimeTopChoice
} from '@/lib/agentCreate/frameworkOptions'
import { randomAgentName } from '@/lib/agentCreate/agentName'
import { flattenSavedModels } from '@/lib/agentCreate/savedModels'
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
import { providerLabel } from '@/pages/Settings/ModelProviderFields'
import { useI18n, type TFn } from '@/lib/i18n'

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

// The sr-only radio delegates its browser-determined `:focus-visible` state to
// the card, keeping pointer selection distinct from Tab/arrow navigation.
const frameworkLogoButtonClass = (active: boolean, disabled = false): string =>
    [
        'group relative flex h-28 w-full flex-col items-center justify-center rounded-md px-3 text-center text-ui transition-[color,background-color,box-shadow] shadow-ring-light has-[:focus-visible]:shadow-focus',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        disabled
            ? 'bg-surface text-muted'
            : active
              ? 'bg-info-bg text-fg shadow-elevated ring-2 ring-link ring-offset-2 ring-offset-main'
              : 'bg-surface text-muted hover:bg-surface-hover'
    ].join(' ')

const runtimeColumnClass = (_active: boolean, disabled = false): string =>
    [
        'border-divider border-l px-4 py-2.5 align-top',
        disabled ? 'text-placeholder' : 'text-muted'
    ].join(' ')

const runtimeCreateCardClass = (active: boolean, disabled = false): string =>
    [
        'shadow-ring-light focus-visible:shadow-focus flex w-full flex-col gap-2 rounded-md px-2.5 py-2 text-left transition-[color,background-color,box-shadow] focus:outline-none',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        disabled
            ? 'bg-surface text-muted'
            : active
              ? 'bg-info-bg text-fg shadow-card ring-1 ring-link/40'
              : 'bg-surface text-muted hover:bg-surface-hover'
    ].join(' ')

const runtimeExistingCardClass = (active: boolean): string =>
    [
        'shadow-ring-light flex w-full flex-col gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
        active
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

const runtimePropertyValueClass =
    'text-caption text-fg min-w-0 break-all font-mono'

const runtimeKindShortLabel = (
    kind: AgentRuntimeSummary['kind'],
    t: TFn
): string => {
    if (kind === 'daemon') return t('web.agentNew.localDaemon')
    if (kind === 'k8s') return t('web.agentNew.persistent')
    if (kind === 'sprites') return t('web.agentNew.sandbox')
    return t('web.agentNew.runtime')
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

const mobileHeaderButtonClass =
    'shadow-ring-light bg-surface text-muted hover:bg-surface-hover inline-flex h-9 shrink-0 items-center justify-center rounded-md transition-colors'

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
                            to='/settings/external-agent-providers'
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
                        to='/settings/external-agent-providers'
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
    const { openMobileSidebar, refreshAgents } = useAppShellContext()
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
    const [frameworkPickerOpen, setFrameworkPickerOpen] = useState(false)
    const [runtimePickerOpen, setRuntimePickerOpen] = useState(false)
    const [runtimeCompareDialogOpen, setRuntimeCompareDialogOpen] =
        useState(false)
    const [frameworkCompareDialogOpen, setFrameworkCompareDialogOpen] =
        useState(false)
    const [runtimeConfigDialogCategory, setRuntimeConfigDialogCategory] =
        useState<RuntimeCategory | null>(null)
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
        setFrameworkPickerOpen(false)
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
        setRuntimeConfigDialogCategory(null)
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
        setExternalProviderId('')
        setExternalRemoteId('')
        if (isK8sOnlyFramework(next)) {
            setRuntimeMode('persistent')
        } else if (runtimeMode === 'existing') {
            setRuntimeMode('sandbox')
        }
        setRuntimePickerOpen(false)
    }

    const selectRuntimeCategory = (next: RuntimeCategory): void => {
        if (next === 'sandbox' && !supportsSandbox(framework)) return
        if (next === 'persistent' && !cloudComputerAvailable) return
        if (next === 'daemon' && !reuseRuntimeKindsFor(framework).has('daemon'))
            return
        setRuntimeMode(next)
        setPickedRuntimeId('')
        setAttachSandboxHostId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
    }

    const selectTopChoice = (choice: RuntimeTopChoice): void => {
        if (choice === 'sandbox') {
            selectRuntimeCategory('sandbox')
            return
        }
        const daemonSupportedNow = reuseRuntimeKindsFor(framework).has('daemon')
        if (daemonSupportedNow) {
            selectRuntimeCategory('daemon')
            return
        }
        if (cloudComputerAvailable) selectRuntimeCategory('persistent')
    }

    const openCreateRuntimeConfig = (category: RuntimeCategory): void => {
        if (category === 'daemon') return
        if (category === 'sandbox' && !supportsSandbox(framework)) return
        if (category === 'sandbox' && sandboxLimitReached) return
        if (category === 'persistent' && !cloudComputerAvailable) return
        if (category === 'persistent' && persistentLimitReached) return
        selectRuntimeCategory(category)
        setRuntimeConfigDialogCategory(category)
    }

    const selectExistingRuntimeTarget = (
        runtime: AgentRuntimeSummary
    ): void => {
        if (runtimeMode === 'existing' && pickedRuntimeId === runtime.id) return
        setRuntimeMode('existing')
        setPickedRuntimeId(runtime.id)
        setAttachSandboxHostId('')
        setRuntimeConfigDialogCategory(null)
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
        setRuntimeConfigDialogCategory(null)
        setCloneEnabled(false)
        setCloneFromProfile('')
        setWorkspacePath('')
        setWorkspaceDraftPath('')
        setWorkspaceDialogOpen(false)
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
            : runtimeMode !== 'daemon' && framework !== 'hermes'
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
        if (runtimeMode === 'daemon') return false
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
              : runtimeMode === 'daemon'
                ? 'daemon'
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
    const selectedTopChoice: RuntimeTopChoice = topChoiceForCategory(
        selectedRuntimeCategory
    )
    const computerTabSupported = daemonSupported || cloudComputerAvailable
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
    const selectedRuntimeQuotaCategory: RuntimeCategory =
        selectedRuntimeCategory === 'daemon'
            ? 'persistent'
            : selectedRuntimeCategory
    const selectedRuntimeQuota =
        runtimeMode === 'existing'
            ? null
            : runtimeQuotaItems.find(
                  (item) => item.category === selectedRuntimeQuotaCategory
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
    const modelProviderSummary = selectedSavedProvider
        ? selectedSavedProvider.providerName
        : picker.mode === 'inline'
          ? t('web.agentNew.newProviderApiKey', {
                provider: providerLabel[modelProviderForRuntime]
            })
          : t('web.agentNew.selectProvider', {
                provider: providerLabel[modelProviderForRuntime]
            })
    const modelProviderDetail = selectedSavedProvider
        ? selectedSavedProvider.apiKeyMasked
        : picker.mode === 'inline' && picker.apiKey
          ? t('web.agentNew.newApiKeyEntered')
          : t('web.agentNew.credentialsRequired')
    const modelProviderConfigured =
        pickerIsValid(picker) &&
        (!usesConfigurableModelProvider(framework) ||
            primaryModelName.trim().length > 0)
    const modelProviderActionLabel = modelProviderConfigured
        ? t('web.agentNew.change')
        : t('web.agentNew.configure')
    const createRuntimeConfigItems: Array<{
        label: string
        value: string
        mono?: boolean
        required?: boolean
    }> = [
        ...(usesConfigurableModelProvider(framework)
            ? [
                  {
                      label: t('web.agentNew.apiProvider'),
                      value: providerLabel[persistentModelProvider]
                  },
                  {
                      label: t('web.agentNew.primaryModel'),
                      value:
                          primaryModelName.trim() || t('web.agentNew.required'),
                      mono: primaryModelName.trim().length > 0,
                      required: primaryModelName.trim().length === 0
                  }
              ]
            : [])
    ]

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

    const runtimeSummaryItems: Array<{
        label: string
        value: string
        mono?: boolean
    }> =
        runtimeMode === 'existing'
            ? [
                  {
                      label: t('web.agentNew.target'),
                      value:
                          pickedRuntime?.name ?? t('web.agentNew.runtimeSelect')
                  },
                  ...(pickedRuntime
                      ? [
                            {
                                label: t('web.agentNew.frameworkLabel'),
                                value:
                                    localizedFrameworkOptions.find(
                                        (opt) =>
                                            opt.value ===
                                            pickedRuntime.framework
                                    )?.label ?? pickedRuntime.framework
                            }
                        ]
                      : []),
                  ...(pickedRuntime?.framework === 'hermes'
                      ? [
                            {
                                label: t('web.agentNew.cloneProfile'),
                                value: cloneEnabled
                                    ? cloneFromProfile ||
                                      t('web.agentNew.selectProfile')
                                    : t('web.agentNew.off'),
                                mono: cloneEnabled
                            }
                        ]
                      : []),
                  {
                      label: t('web.agentNew.credentials'),
                      value: pickedRuntime
                          ? pickedRuntime.kind === 'daemon'
                              ? t('web.agentNew.managedOnMachine')
                              : t('web.agentNew.providerDescInherited')
                          : t('web.agentNew.runtimeSelect')
                  }
              ]
            : runtimeMode === 'daemon'
              ? [
                    {
                        label: t('web.agentNew.target'),
                        value: t('web.agentNew.selectConnectedComputer')
                    },
                    {
                        label: t('web.agentNew.credentials'),
                        value: t('web.agentNew.managedOnMachine')
                    },
                    {
                        label: t('web.agentNew.workspace'),
                        value: t('web.agentNew.configuredAfterRuntime')
                    }
                ]
              : [
                    {
                        label: t('web.agentNew.target'),
                        value: t('web.agentNew.createRuntimeNamed', {
                            runtime: selectedRuntimeLabel
                        })
                    },
                    {
                        label: t('web.agentNew.provider'),
                        value:
                            modelProviderDetail ===
                            t('web.agentNew.credentialsRequired')
                                ? modelProviderSummary
                                : `${modelProviderSummary} · ${modelProviderDetail}`,
                        mono:
                            picker.mode === 'saved' || picker.mode === 'inline'
                    },
                    ...(usesConfigurableModelProvider(framework)
                        ? [
                              {
                                  label: t('web.agentNew.primaryModel'),
                                  value:
                                      primaryModelName.trim() ||
                                      t('web.agentNew.primaryModelRequired'),
                                  mono: primaryModelName.trim().length > 0
                              }
                          ]
                        : [])
                ]

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
        if (!externalNow && runtimeMode === 'daemon') return
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

    const renderCreateRuntimeOption = (
        category: RuntimeCategory
    ): ReactNode => {
        const selected =
            runtimeMode !== 'existing' &&
            selectedRuntimeCategory === category &&
            !(category === 'sandbox' && attachSandboxHostId)
        const unsupported =
            category === 'sandbox' && !supportsSandbox(framework)
        const limitReached =
            category === 'sandbox'
                ? sandboxLimitReached
                : persistentLimitReached
        const buyCloudComputer =
            category === 'persistent' && cloudComputerAvailable
        const disabled = unsupported || limitReached || buyCloudComputer
        if (disabled) {
            return (
                <div className='text-caption text-muted font-medium'>
                    {unsupported ? (
                        t('web.agentNew.notAvailable')
                    ) : buyCloudComputer ? (
                        <Link
                            to='/settings/plan-and-billing/buy-container'
                            className='text-link hover:underline'
                        >
                            {t('web.agentNew.persistentRent')}
                        </Link>
                    ) : (
                        t('web.agentNew.limitReached')
                    )}
                </div>
            )
        }

        return (
            <div
                role='button'
                tabIndex={0}
                className={runtimeCreateCardClass(selected)}
                onClick={() => selectRuntimeCategory(category)}
                onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        selectRuntimeCategory(category)
                    }
                }}
            >
                <span className='flex w-full items-start gap-2'>
                    <span className='grid min-w-0 flex-1 gap-1'>
                        <span className='grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2'>
                            <span className='text-caption text-subtle font-medium'>
                                {t('web.agentNew.provider')}
                            </span>
                            <span className='text-caption text-muted min-w-0 truncate'>
                                {modelProviderSummary}
                            </span>
                        </span>
                        <span className='grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2'>
                            <span className='text-caption text-subtle font-medium'>
                                {t('web.agentNew.credentials')}
                            </span>
                            <span
                                className={[
                                    'text-caption min-w-0 truncate',
                                    modelProviderDetail ===
                                    t('web.agentNew.credentialsRequired')
                                        ? 'text-workflow-ship'
                                        : 'text-muted font-mono'
                                ].join(' ')}
                            >
                                {modelProviderDetail}
                            </span>
                        </span>
                        {createRuntimeConfigItems.map((item) => (
                            <span
                                key={item.label}
                                className='grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2'
                            >
                                <span className='text-caption text-subtle font-medium'>
                                    {item.label}
                                </span>
                                <span
                                    className={[
                                        'text-caption min-w-0 truncate',
                                        item.required
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
                    <span
                        className={runtimeSelectionIndicatorClass(selected)}
                        aria-hidden='true'
                    >
                        <CheckIcon className='h-3 w-3' />
                    </span>
                </span>
                <button
                    type='button'
                    className='text-caption text-link hover:text-fg focus-visible:shadow-focus self-end font-medium transition-shadow focus:outline-none'
                    onClick={(e) => {
                        e.stopPropagation()
                        openCreateRuntimeConfig(category)
                    }}
                >
                    {modelProviderActionLabel} {t('web.agentNew.provider')}
                </button>
                <div className={runtimePropertyGridClass}>
                    {framework !== 'hermes' && (
                        <>
                            <span className={runtimePropertyLabelClass}>
                                {t('web.agentNew.workspace')}
                            </span>
                            {renderWorkspaceValue({
                                defaultPath:
                                    createRuntimeDefaultWorkspaceValue(
                                        category
                                    ),
                                active: selected,
                                onActivate: () => {
                                    if (!selected)
                                        selectRuntimeCategory(category)
                                }
                            })}
                        </>
                    )}
                </div>
            </div>
        )
    }

    const renderSelfOwnedComputerOption = (): ReactNode => {
        const disabled = !daemonSupported
        if (disabled) {
            return (
                <div className='text-caption text-muted font-medium'>
                    {t('web.agentNew.notAvailableFramework')}
                </div>
            )
        }
        return (
            <div className='text-caption text-muted font-medium'>
                <Link
                    to='/settings/local-daemons'
                    className='text-link hover:underline'
                >
                    {t('web.agentNew.localDaemonRegister')}
                </Link>
            </div>
        )
    }

    const renderAttachSandboxOptions = (
        targets: SpriteAttachTarget[]
    ): ReactNode => (
        <div className='grid gap-2'>
            {targets.map((target) => {
                const selected =
                    runtimeMode === 'sandbox' &&
                    attachSandboxHostId === target.hostId
                const runsLabel = target.frameworks
                    .map(
                        (f) =>
                            localizedFrameworkOptions.find((o) => o.value === f)
                                ?.label ?? f
                    )
                    .join(', ')
                return (
                    <div
                        key={target.hostId}
                        className={runtimeExistingCardClass(selected)}
                    >
                        <button
                            type='button'
                            onClick={() => selectAttachSandboxTarget(target)}
                            className='focus-visible:shadow-focus flex w-full items-center gap-2 rounded-md text-left transition-shadow focus:outline-none'
                        >
                            <FrameworkLogo
                                framework={framework}
                                className='h-7 w-7'
                            />
                            <span className='min-w-0 flex-1'>
                                <span className='flex min-w-0 items-center gap-1.5'>
                                    <span className='tag tag-neutral'>
                                        {t('web.agentNew.sandbox')}
                                    </span>
                                    <span className='text-caption text-fg min-w-0 truncate font-medium'>
                                        {target.name ??
                                            target.spriteName ??
                                            target.hostId}
                                    </span>
                                </span>
                                <span className='text-caption text-subtle mt-0.5 block truncate'>
                                    {t('web.agentNew.addFramework', {
                                        framework: selectedFramework.label
                                    })}{' '}
                                    · {t('web.agentNew.runs')} {runsLabel} ·{' '}
                                    {target.runtimeCount}/4
                                </span>
                            </span>
                            <span
                                className={runtimeSelectionIndicatorClass(
                                    selected
                                )}
                                aria-hidden='true'
                            >
                                <CheckIcon className='h-3 w-3' />
                            </span>
                        </button>
                        {selected && (
                            <div className={runtimePropertyGridClass}>
                                <span className={runtimePropertyLabelClass}>
                                    {t('web.agentNew.provider')}
                                </span>
                                <span className='text-caption text-muted min-w-0 truncate'>
                                    {modelProviderSummary}
                                </span>
                                <span className={runtimePropertyLabelClass}>
                                    {t('web.agentNew.credentials')}
                                </span>
                                <button
                                    type='button'
                                    onClick={() =>
                                        setRuntimeConfigDialogCategory(
                                            'sandbox'
                                        )
                                    }
                                    className='text-caption text-link hover:text-fg focus-visible:shadow-focus justify-self-start font-medium transition-shadow focus:outline-none'
                                >
                                    {modelProviderActionLabel}{' '}
                                    {t('web.agentNew.provider')}
                                </button>
                                {framework !== 'hermes' && (
                                    <>
                                        <span
                                            className={
                                                runtimePropertyLabelClass
                                            }
                                        >
                                            {t('web.agentNew.workspace')}
                                        </span>
                                        {renderWorkspaceValue({
                                            defaultPath:
                                                createRuntimeDefaultWorkspaceValue(
                                                    'sandbox'
                                                ),
                                            active: true,
                                            onActivate: () =>
                                                selectAttachSandboxTarget(
                                                    target
                                                )
                                        })}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )

    const renderExistingRuntimeOptions = (
        options: AgentRuntimeSummary[],
        emptyState: ReactNode = t('web.agentNew.notAvailable')
    ): ReactNode => {
        if (options.length === 0) {
            return (
                <div className='text-caption text-muted font-medium'>
                    {emptyState}
                </div>
            )
        }

        return (
            <div className='grid gap-2'>
                {options.map((r) => {
                    const selected =
                        runtimeMode === 'existing' && pickedRuntimeId === r.id
                    const runtimeProfiles = runtimeAgents[r.id] ?? []
                    const runtimeFrameworkOption =
                        localizedFrameworkOptions.find(
                            (opt) => opt.value === r.framework
                        ) ?? selectedFramework

                    return (
                        <div
                            key={r.id}
                            className={runtimeExistingCardClass(selected)}
                        >
                            <button
                                type='button'
                                onClick={() => selectExistingRuntimeTarget(r)}
                                className='focus-visible:shadow-focus flex w-full items-center gap-2 rounded-md text-left transition-shadow focus:outline-none'
                            >
                                <FrameworkLogo
                                    framework={r.framework}
                                    className='h-7 w-7'
                                />
                                <span className='min-w-0 flex-1'>
                                    <span className='flex min-w-0 items-center gap-1.5'>
                                        <span className='tag tag-neutral'>
                                            {t('web.agentNew.runtime')} -{' '}
                                            {runtimeKindShortLabel(r.kind, t)}
                                        </span>
                                        <span className='text-caption text-fg min-w-0 truncate font-medium'>
                                            {r.name}
                                        </span>
                                    </span>
                                    <span className='text-caption text-subtle mt-0.5 block truncate'>
                                        {runtimeFrameworkOption.label} ·{' '}
                                        {r.agentsCount === 1
                                            ? t('web.agentNew.agentCountOne')
                                            : t('web.agentNew.agentCountMany', {
                                                  count: String(r.agentsCount)
                                              })}
                                    </span>
                                </span>
                                <span
                                    className={runtimeSelectionIndicatorClass(
                                        selected
                                    )}
                                    aria-hidden='true'
                                >
                                    <CheckIcon className='h-3 w-3' />
                                </span>
                            </button>
                            {r.framework !== 'hermes' && (
                                <div className={runtimePropertyGridClass}>
                                    <span className={runtimePropertyLabelClass}>
                                        {t('web.agentNew.workspace')}
                                    </span>
                                    {renderWorkspaceValue({
                                        defaultPath:
                                            existingRuntimeDefaultWorkspaceValue(
                                                r
                                            ),
                                        active: selected,
                                        onActivate: () =>
                                            selectExistingRuntimeTarget(r)
                                    })}
                                    {r.kind === 'daemon' && (
                                        <>
                                            <span
                                                className={
                                                    runtimePropertyLabelClass
                                                }
                                            >
                                                {t('web.agentNew.machine')}
                                            </span>
                                            <span className='text-caption text-muted min-w-0 truncate'>
                                                {r.daemonName ?? r.name}
                                            </span>
                                            <span
                                                className={
                                                    runtimePropertyLabelClass
                                                }
                                            >
                                                {t('web.agentNew.status')}
                                            </span>
                                            <span
                                                className={[
                                                    'text-caption min-w-0 truncate',
                                                    r.daemonOnline
                                                        ? 'text-fg'
                                                        : 'text-workflow-ship'
                                                ].join(' ')}
                                            >
                                                {r.daemonOnline
                                                    ? t('web.agentNew.online')
                                                    : t('web.agentNew.offline')}
                                            </span>
                                        </>
                                    )}
                                    {r.framework === 'openclaw' && (
                                        <>
                                            <span
                                                className={
                                                    runtimePropertyLabelClass
                                                }
                                            >
                                                {t('web.agentNew.credentials')}
                                            </span>
                                            <span className='text-caption text-muted'>
                                                {t(
                                                    'web.agentNew.providerDescInherited'
                                                )}
                                            </span>
                                        </>
                                    )}
                                </div>
                            )}
                            {r.framework === 'hermes' && (
                                <div className={runtimePropertyGridClass}>
                                    <span className={runtimePropertyLabelClass}>
                                        {t('web.agentNew.displayName')}
                                    </span>
                                    <span className={runtimePropertyValueClass}>
                                        {normalizedName || name}
                                    </span>
                                    <span className={runtimePropertyLabelClass}>
                                        {t('web.agentNew.cloneProfile')}
                                    </span>
                                    <label
                                        className={[
                                            'text-caption inline-flex min-w-0 items-center gap-2 transition-colors',
                                            selected && cloneEnabled
                                                ? 'text-fg'
                                                : 'text-muted'
                                        ].join(' ')}
                                    >
                                        <input
                                            type='checkbox'
                                            checked={selected && cloneEnabled}
                                            onChange={(e) => {
                                                const next = e.target.checked
                                                if (!selected) {
                                                    selectExistingRuntimeTarget(
                                                        r
                                                    )
                                                }
                                                setCloneEnabled(next)
                                                if (next) {
                                                    const preferred =
                                                        runtimeProfiles.find(
                                                            (profile) =>
                                                                profile.id ===
                                                                'coder'
                                                        )?.id ??
                                                        runtimeProfiles.find(
                                                            (profile) =>
                                                                profile.id ===
                                                                'default'
                                                        )?.id ??
                                                        runtimeProfiles[0]
                                                            ?.id ??
                                                        ''
                                                    setCloneFromProfile(
                                                        preferred
                                                    )
                                                } else {
                                                    setCloneFromProfile('')
                                                }
                                            }}
                                            className='accent-fg'
                                        />
                                        <span className='min-w-0 truncate'>
                                            {selected && cloneEnabled
                                                ? t('web.agentNew.enabled')
                                                : t('web.agentNew.off')}
                                        </span>
                                    </label>
                                    <span className={runtimePropertyLabelClass}>
                                        {t('web.agentNew.sourceProfile')}
                                    </span>
                                    {(!selected || !cloneEnabled) && (
                                        <span className='text-caption text-muted min-w-0 truncate'>
                                            {selected
                                                ? t('web.agentNew.notCloning')
                                                : t(
                                                      'web.agentNew.selectRuntimeToLoadProfiles'
                                                  )}
                                        </span>
                                    )}
                                    {selected &&
                                        cloneEnabled &&
                                        runtimeAgentsLoading && (
                                            <span className='text-caption text-subtle'>
                                                {t(
                                                    'web.agentNew.loadingProfiles'
                                                )}
                                            </span>
                                        )}
                                    {selected &&
                                        cloneEnabled &&
                                        runtimeAgentsError && (
                                            <span className='text-caption text-workflow-ship min-w-0 break-words'>
                                                {runtimeAgentsError}
                                            </span>
                                        )}
                                    {selected &&
                                        cloneEnabled &&
                                        !runtimeAgentsLoading &&
                                        !runtimeAgentsError &&
                                        pickedRuntimeAgents.length > 0 && (
                                            <WorkbenchSelect
                                                size='sm'
                                                mono
                                                className='min-w-0'
                                                ariaLabel={t(
                                                    'web.agentNew.cloneFromProfile'
                                                )}
                                                value={cloneFromProfile}
                                                onChange={setCloneFromProfile}
                                                options={pickedRuntimeAgents.map(
                                                    (profile) => ({
                                                        value: profile.id,
                                                        label: profile.name
                                                    })
                                                )}
                                            />
                                        )}
                                    {selected &&
                                        cloneEnabled &&
                                        !runtimeAgentsLoading &&
                                        !runtimeAgentsError &&
                                        pickedRuntimeAgents.length === 0 && (
                                            <span className='text-caption text-subtle'>
                                                {t(
                                                    'web.agentNew.noProfilesFound'
                                                )}
                                            </span>
                                        )}
                                    <span className={runtimePropertyLabelClass}>
                                        {t('web.agentNew.credentials')}
                                    </span>
                                    <span className='text-caption text-muted'>
                                        {t(
                                            'web.agentNew.providerDescInherited'
                                        )}
                                    </span>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        )
    }

    return (
        <>
            <header className='border-divider/80 bg-surface/90 relative z-[80] flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 backdrop-blur md:hidden'>
                <div className='flex min-w-0 items-center gap-3'>
                    <button
                        type='button'
                        className={`${mobileHeaderButtonClass} w-9`}
                        aria-label={t('web.agentNew.openMenu')}
                        onClick={openMobileSidebar}
                    >
                        <MenuIcon className='h-4 w-4' />
                    </button>
                    <div className='min-w-0'>
                        <h1 className='text-ui text-fg truncate font-medium'>
                            {t('web.agentNew.newAgent')}
                        </h1>
                        <div className='text-caption text-placeholder mt-0.5 truncate'>
                            {t('web.agentNew.createAgent')}
                        </div>
                    </div>
                </div>
                <Link
                    to='/workspace'
                    className={`${mobileHeaderButtonClass} text-ui px-3 font-medium`}
                >
                    {t('web.agentNew.workspace')}
                </Link>
            </header>
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
                                <button
                                    type='button'
                                    className={[
                                        'bg-surface shadow-ring-light hover:bg-surface-hover focus-visible:shadow-focus flex w-full items-start gap-3 px-3.5 py-3 text-left transition-[color,background-color,box-shadow] focus:outline-none',
                                        frameworkPickerOpen
                                            ? 'rounded-t-lg'
                                            : 'rounded-md'
                                    ].join(' ')}
                                    aria-expanded={frameworkPickerOpen}
                                    aria-controls='agent-framework-picker'
                                    onClick={() =>
                                        setFrameworkPickerOpen((open) => !open)
                                    }
                                >
                                    <FrameworkLogo
                                        framework={selectedFramework.value}
                                        className='h-10 w-10'
                                    />
                                    <span className='min-w-0 flex-1'>
                                        <span className='flex flex-wrap items-center gap-2'>
                                            <span className='text-ui text-fg font-medium'>
                                                {selectedFramework.label}
                                            </span>
                                            {selectedFramework.disabled && (
                                                <span className='tag tag-neutral'>
                                                    {t('web.agentNew.coming')}
                                                </span>
                                            )}
                                        </span>
                                        <span className='text-ui text-muted mt-1 block'>
                                            {selectedFramework.description}
                                        </span>
                                    </span>
                                    <ChevronDownIcon
                                        className={[
                                            'text-muted mt-2 h-4 w-4 shrink-0 transition-transform',
                                            frameworkPickerOpen
                                                ? ''
                                                : '-rotate-90'
                                        ].join(' ')}
                                        aria-hidden='true'
                                    />
                                </button>
                                {frameworkPickerOpen && (
                                    <div
                                        id='agent-framework-picker'
                                        className='bg-surface-subtle shadow-ring-light rounded-b-lg p-3'
                                        role='radiogroup'
                                        aria-label={t(
                                            'web.agentNew.agentFramework'
                                        )}
                                    >
                                        <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'>
                                            {localizedFrameworkOptions.map(
                                                (opt) => {
                                                    const selected =
                                                        framework === opt.value
                                                    const disabled =
                                                        opt.disabled === true
                                                    return (
                                                        <label
                                                            key={opt.value}
                                                            className={frameworkLogoButtonClass(
                                                                selected,
                                                                disabled
                                                            )}
                                                        >
                                                            <input
                                                                type='radio'
                                                                name='framework'
                                                                value={
                                                                    opt.value
                                                                }
                                                                checked={
                                                                    selected
                                                                }
                                                                disabled={
                                                                    disabled
                                                                }
                                                                onChange={() => {
                                                                    if (
                                                                        !disabled &&
                                                                        isCreateableFramework(
                                                                            opt.value
                                                                        )
                                                                    ) {
                                                                        selectFramework(
                                                                            opt.value
                                                                        )
                                                                    }
                                                                }}
                                                                className='sr-only'
                                                            />
                                                            {disabled && (
                                                                <span className='tag tag-neutral absolute right-1.5 top-1.5'>
                                                                    {t(
                                                                        'web.agentNew.coming'
                                                                    )}
                                                                </span>
                                                            )}
                                                            <FrameworkLogo
                                                                framework={
                                                                    opt.value
                                                                }
                                                            />
                                                            <span className='mt-2 flex max-w-full flex-col items-center gap-1'>
                                                                <span className='max-w-full truncate font-medium'>
                                                                    {opt.label}
                                                                </span>
                                                            </span>
                                                        </label>
                                                    )
                                                }
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {!isExternalFramework(framework) && (
                                <div>
                                    <div className='mb-1 flex items-center justify-between gap-2'>
                                        <span className='workbench-field-label'>
                                            {t('web.agentNew.agentRuntime')}
                                        </span>
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
                                    </div>
                                    <div
                                        className={[
                                            'bg-surface shadow-ring-light overflow-hidden transition-colors',
                                            runtimePickerOpen
                                                ? 'rounded-t-lg'
                                                : 'rounded-md'
                                        ].join(' ')}
                                    >
                                        <button
                                            type='button'
                                            className='hover:bg-surface-hover focus-visible:shadow-focus flex w-full items-start justify-between gap-3 px-3.5 py-3 text-left transition-[color,background-color,box-shadow] focus:outline-none'
                                            aria-expanded={runtimePickerOpen}
                                            aria-controls='agent-runtime-picker'
                                            onClick={() =>
                                                setRuntimePickerOpen(
                                                    (open) => !open
                                                )
                                            }
                                        >
                                            <span className='min-w-0 flex-1'>
                                                <span className='flex flex-wrap items-center gap-2'>
                                                    <span className='text-ui text-fg font-medium'>
                                                        {selectedRuntimeLabel}
                                                    </span>
                                                    {selectedRuntimeQuota && (
                                                        <span
                                                            className={[
                                                                'tag tag-neutral font-mono tabular-nums',
                                                                selectedRuntimeQuota.reached
                                                                    ? 'text-workflow-ship'
                                                                    : ''
                                                            ].join(' ')}
                                                        >
                                                            {
                                                                selectedRuntimeQuota.usage
                                                            }
                                                            /
                                                            {
                                                                selectedRuntimeQuota.limit
                                                            }{' '}
                                                            {t(
                                                                'web.agentNew.runtimeUsedSuffix'
                                                            )}
                                                        </span>
                                                    )}
                                                    {selectedRuntimeCategory ===
                                                        'sandbox' && (
                                                        <span className='tag tag-neutral'>
                                                            {t(
                                                                'web.agentNew.recommended'
                                                            )}
                                                        </span>
                                                    )}
                                                </span>
                                                <ul className='text-caption text-muted mt-2 list-disc space-y-1 pl-4'>
                                                    {runtimeSummaryItems.map(
                                                        (item) => (
                                                            <li
                                                                key={item.label}
                                                                className='min-w-0 pl-0.5'
                                                            >
                                                                <span className='text-subtle mr-1 font-medium'>
                                                                    {item.label}
                                                                    :
                                                                </span>
                                                                <span
                                                                    className={[
                                                                        'text-muted',
                                                                        item.mono
                                                                            ? 'font-mono'
                                                                            : ''
                                                                    ].join(' ')}
                                                                >
                                                                    {item.value}
                                                                </span>
                                                            </li>
                                                        )
                                                    )}
                                                </ul>
                                            </span>
                                            <ChevronDownIcon
                                                className={[
                                                    'text-muted mt-2 h-4 w-4 shrink-0 transition-transform',
                                                    runtimePickerOpen
                                                        ? ''
                                                        : '-rotate-90'
                                                ].join(' ')}
                                                aria-hidden='true'
                                            />
                                        </button>
                                    </div>
                                    {runtimePickerOpen && (
                                        <div id='agent-runtime-picker'>
                                            <div className='bg-surface-subtle shadow-ring-light overflow-hidden rounded-b-lg'>
                                                <div
                                                    role='tablist'
                                                    aria-label={t(
                                                        'web.agentNew.runtimeCategory'
                                                    )}
                                                    className='border-divider flex gap-1 border-b p-1.5'
                                                >
                                                    {runtimeTopChoices.map(
                                                        (choice) => {
                                                            const isActive =
                                                                selectedTopChoice ===
                                                                choice
                                                            const unsupported =
                                                                (choice ===
                                                                    'sandbox' &&
                                                                    !supportsSandbox(
                                                                        framework
                                                                    )) ||
                                                                (choice ===
                                                                    'computer' &&
                                                                    !computerTabSupported)
                                                            const tabLabel =
                                                                choice ===
                                                                'sandbox'
                                                                    ? t(
                                                                          'web.agentNew.sandbox'
                                                                      )
                                                                    : t(
                                                                          'web.agentNew.computers'
                                                                      )
                                                            const tagline =
                                                                choice ===
                                                                'sandbox'
                                                                    ? t(
                                                                          'web.agentNew.sandboxTagline'
                                                                      )
                                                                    : t(
                                                                          'web.agentNew.computerTagline'
                                                                      )
                                                            const quotaLabel =
                                                                choice ===
                                                                'sandbox'
                                                                    ? runtimeQuotaLabel(
                                                                          'sandbox'
                                                                      )
                                                                    : runtimeQuotaLabel(
                                                                          'persistent'
                                                                      )
                                                            return (
                                                                <button
                                                                    key={choice}
                                                                    type='button'
                                                                    role='tab'
                                                                    aria-selected={
                                                                        isActive
                                                                    }
                                                                    disabled={
                                                                        unsupported
                                                                    }
                                                                    onClick={() => {
                                                                        if (
                                                                            selectedTopChoice ===
                                                                            choice
                                                                        )
                                                                            return
                                                                        selectTopChoice(
                                                                            choice
                                                                        )
                                                                    }}
                                                                    className={[
                                                                        'focus-visible:shadow-focus flex-1 rounded-md px-3 py-2 text-left transition-[color,background-color,box-shadow] focus:outline-none',
                                                                        unsupported
                                                                            ? 'cursor-not-allowed opacity-50'
                                                                            : '',
                                                                        isActive
                                                                            ? 'bg-surface text-fg shadow-ring-light'
                                                                            : !unsupported
                                                                              ? 'text-muted hover:text-fg'
                                                                              : 'text-muted'
                                                                    ].join(' ')}
                                                                >
                                                                    <span className='flex flex-col items-start gap-0.5'>
                                                                        <span className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5'>
                                                                            <span className='text-ui font-medium'>
                                                                                {
                                                                                    tabLabel
                                                                                }
                                                                            </span>
                                                                            {quotaLabel && (
                                                                                <span className='text-caption text-muted font-mono'>
                                                                                    {
                                                                                        quotaLabel
                                                                                    }
                                                                                </span>
                                                                            )}
                                                                        </span>
                                                                        <span className='text-caption text-muted'>
                                                                            {
                                                                                tagline
                                                                            }
                                                                        </span>
                                                                    </span>
                                                                </button>
                                                            )
                                                        }
                                                    )}
                                                </div>

                                                <div
                                                    role='tabpanel'
                                                    className='space-y-4 p-4'
                                                >
                                                    {selectedTopChoice ===
                                                        'sandbox' && (
                                                        <>
                                                            <div>
                                                                <div className='text-caption text-subtle mb-2 font-medium uppercase tracking-wider'>
                                                                    {t(
                                                                        'web.agentNew.createNewRuntime'
                                                                    )}
                                                                </div>
                                                                {renderCreateRuntimeOption(
                                                                    'sandbox'
                                                                )}
                                                            </div>
                                                            <div className='border-divider border-t pt-4'>
                                                                <div className='text-caption text-subtle mb-2 font-medium uppercase tracking-wider'>
                                                                    {t(
                                                                        'web.agentNew.addToExistingRuntime'
                                                                    )}
                                                                </div>
                                                                {existingRuntimeOptionsByKind
                                                                    .sprites
                                                                    .length ===
                                                                    0 &&
                                                                spriteAttachTargets.length ===
                                                                    0 ? (
                                                                    <div className='text-caption text-muted font-medium'>
                                                                        {t(
                                                                            'web.agentNew.notAvailable'
                                                                        )}
                                                                    </div>
                                                                ) : (
                                                                    <div className='space-y-2'>
                                                                        {existingRuntimeOptionsByKind
                                                                            .sprites
                                                                            .length >
                                                                            0 &&
                                                                            renderExistingRuntimeOptions(
                                                                                existingRuntimeOptionsByKind.sprites
                                                                            )}
                                                                        {spriteAttachTargets.length >
                                                                            0 &&
                                                                            renderAttachSandboxOptions(
                                                                                spriteAttachTargets
                                                                            )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </>
                                                    )}
                                                    {selectedTopChoice ===
                                                        'computer' && (
                                                        <>
                                                            <div>
                                                                <div className='text-caption text-subtle mb-2 font-medium uppercase tracking-wider'>
                                                                    {t(
                                                                        'web.agentNew.addSelfOwnedComputer'
                                                                    )}
                                                                </div>
                                                                {renderSelfOwnedComputerOption()}
                                                            </div>
                                                            {cloudComputerAvailable && (
                                                                <div>
                                                                    <div className='text-caption text-subtle mb-2 font-medium uppercase tracking-wider'>
                                                                        {t(
                                                                            'web.agentNew.rentCloudComputer'
                                                                        )}
                                                                    </div>
                                                                    {renderCreateRuntimeOption(
                                                                        'persistent'
                                                                    )}
                                                                </div>
                                                            )}
                                                            <div className='border-divider border-t pt-4'>
                                                                <div className='text-caption text-subtle mb-2 font-medium uppercase tracking-wider'>
                                                                    {t(
                                                                        'web.agentNew.addToExistingComputer'
                                                                    )}
                                                                </div>
                                                                {renderExistingRuntimeOptions(
                                                                    [
                                                                        ...existingRuntimeOptionsByKind.daemon,
                                                                        ...existingRuntimeOptionsByKind.k8s
                                                                    ],
                                                                    <>
                                                                        {t(
                                                                            'web.agentNew.noComputerConnected'
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    {runtimesError && (
                                        <p className='text-caption text-workflow-ship mt-2'>
                                            {runtimesError}
                                        </p>
                                    )}
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
                                {runtimeMode === 'daemon'
                                    ? t('web.agentNew.selectSelfOwnedComputer')
                                    : runtimeMode === 'existing'
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
            {runtimeConfigDialogCategory && (
                <div
                    className='fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
                    role='dialog'
                    aria-modal='true'
                    aria-label={t('web.agentNew.configureRuntimeSettings')}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setRuntimeConfigDialogCategory(null)
                        }
                    }}
                >
                    <div className='workbench-panel flex max-h-[calc(100vh-3rem)] w-full max-w-2xl flex-col overflow-hidden'>
                        <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                            <div className='flex min-w-0 items-center gap-3'>
                                <span
                                    className='bg-soft text-muted shadow-ring-light inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm'
                                    aria-hidden='true'
                                >
                                    <ProviderIcon className='h-4 w-4' />
                                </span>
                                <div className='min-w-0'>
                                    <h2 className='text-ui text-fg truncate font-medium'>
                                        {t(
                                            'web.agentNew.configureRuntimeSettings'
                                        )}
                                    </h2>
                                    <p className='text-caption text-muted mt-0.5 truncate'>
                                        {runtimeConfigDialogCategory ===
                                        'sandbox'
                                            ? t(
                                                  'web.agentNew.createStatefulSandbox'
                                              )
                                            : t('web.agentNew.rentCloud')}
                                    </p>
                                </div>
                            </div>
                            <button
                                type='button'
                                className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors'
                                aria-label={t('common.close')}
                                onClick={() =>
                                    setRuntimeConfigDialogCategory(null)
                                }
                            >
                                <CloseIcon className='h-4 w-4' />
                            </button>
                        </header>
                        <div className='min-h-0 overflow-y-auto px-5 py-4'>
                            {renderCreateRuntimeSettings()}
                        </div>
                        <footer className='border-divider/80 bg-surface-subtle/60 flex items-center justify-end gap-2 border-t px-5 py-3'>
                            <button
                                type='button'
                                className='workbench-button-primary'
                                onClick={() =>
                                    setRuntimeConfigDialogCategory(null)
                                }
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
