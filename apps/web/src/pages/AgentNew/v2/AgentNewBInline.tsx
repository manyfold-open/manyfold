import {
    AgentFramework,
    AgentRuntimeSummary,
    CreateAgentBody,
    K8S_HOME_BASE,
    NARRANEXUS_K8S_BASE_WORKING_PATH,
    NARRANEXUS_SPRITE_BASE_WORKING_PATH,
    OFFICIAL_PROVIDER_BASE_URL,
    SPRITE_HOME_BASE,
    UserModelProvider,
    externalSteps,
    isConfigurableFramework,
    normalizeAgentName,
    providerSupportsTarget,
    validateAgentName
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAppShellContext } from '@/components/AppShell'
import { Spinner } from '@/components/Loading'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { CreateProgress } from '@/pages/AgentNew/components/CreateProgress'
import {
    initialPicker,
    initialPickerForFramework,
    pickerIsValid,
    ProviderPicker,
    type ProviderPickerValue
} from '@/pages/AgentNew/components/ProviderPicker'
import { CreateFrameworkModelConfig } from '@/pages/AgentNew/components/shared/CreateFrameworkModelConfig'
import { useFrameworkModelConfig } from '@/lib/agentCreate/useFrameworkModelConfig'
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
    remoteIdHintFor,
    remoteIdLabelFor,
    remoteIdPlaceholderFor,
    runtimeCategoryShortLabel,
    supportsSandbox,
    usesConfigurableModelProvider,
    type RuntimeCategory,
    type RuntimeMode
} from '@/lib/agentCreate/frameworkOptions'
import { randomAgentName } from '@/lib/agentCreate/agentName'
import { preferredSavedProviderFor } from '@/lib/agentCreate/providerHelpers'
import { flattenSavedModels } from '@/lib/agentCreate/savedModels'
import { preferredPrimaryModelDefault } from '@/lib/agentModelConfig'
import {
    computeSpriteTargets,
    type SpriteAttachTarget
} from '@/lib/agentCreate/spriteTargets'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useAgentCreate } from '@/lib/agentCreate/useAgentCreate'
import { useI18n, type TFn } from '@/lib/i18n'
import { BILLING_SURFACE } from '@/edition-capabilities'

type StepStatus = 'pending' | 'active' | 'done'

const StepBadge: FC<{ index: number; status: StepStatus }> = ({
    index,
    status
}) => {
    const { t } = useI18n()
    const base =
        'text-caption inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-medium'
    if (status === 'done')
        return (
            <span
                aria-label={t('web.agentNew.completed')}
                className={`${base} bg-info-bg text-link shadow-ring-light`}
            >
                ✓
            </span>
        )
    if (status === 'active')
        return (
            <span
                aria-current='step'
                className={`${base} bg-strong text-strong-fg font-mono`}
            >
                {index}
            </span>
        )
    return (
        <span
            className={`${base} bg-soft text-subtle shadow-ring-light font-mono`}
        >
            {index}
        </span>
    )
}

const SectionCard: FC<{
    index: number
    status: StepStatus
    title: string
    description?: ReactNode
    accessory?: ReactNode
    children?: ReactNode
}> = ({ index, status, title, description, accessory, children }) => (
    <section
        className={[
            'bg-surface shadow-ring-light rounded-md p-5 transition-opacity md:p-6',
            status === 'pending' && !children ? 'opacity-60' : ''
        ].join(' ')}
    >
        <header className='mb-4 flex items-start gap-3'>
            <StepBadge index={index} status={status} />
            <div className='min-w-0 flex-1'>
                <h2 className='text-fg text-h3 flex items-center gap-2'>
                    <span>{title}</span>
                    {accessory}
                </h2>
                {description && (
                    <p className='text-muted text-ui mt-1.5 leading-relaxed'>
                        {description}
                    </p>
                )}
            </div>
        </header>
        {children && <div className='mt-4'>{children}</div>}
    </section>
)

const PendingSection: FC<{
    index: number
    title: string
    description: string
}> = ({ index, title, description }) => (
    <section
        aria-disabled='true'
        className='bg-surface shadow-ring-light rounded-md p-5 opacity-60 md:p-6'
    >
        <header className='flex items-start gap-3'>
            <StepBadge index={index} status='pending' />
            <div className='min-w-0 flex-1'>
                <h2 className='text-fg text-h3'>{title}</h2>
                <p className='text-muted text-ui mt-1.5 leading-relaxed'>
                    {description}
                </p>
            </div>
        </header>
    </section>
)

const FrameworkGrid: FC<{
    value: AgentFramework | null
    onChange: (next: AgentFramework) => void
}> = ({ value, onChange }) => {
    const { t } = useI18n()
    const localizedFrameworkOptions = frameworkOptions.map((option) => ({
        ...option,
        description: t(option.descriptionKey)
    }))
    return (
        <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'>
            {localizedFrameworkOptions.map((option) => {
                const active = value !== null && option.value === value
                const disabled = option.disabled
                const ext =
                    option.value === 'dify' ||
                    option.value === 'langflow' ||
                    option.value === 'a2a'
                return (
                    <button
                        key={option.value}
                        type='button'
                        disabled={disabled}
                        onClick={() => !disabled && onChange(option.value)}
                        className={[
                            'group flex flex-col items-center gap-2 rounded-md px-2 py-3 text-center transition-colors',
                            disabled
                                ? 'bg-surface text-subtle shadow-ring-light cursor-not-allowed opacity-55'
                                : active
                                  ? 'bg-info-bg text-fg ring-link/40 ring-2'
                                  : 'bg-surface text-muted shadow-ring-light hover:bg-surface-hover'
                        ].join(' ')}
                    >
                        <FrameworkLogo
                            framework={option.value}
                            size={28}
                            className='shrink-0'
                        />
                        <span className='text-ui flex items-center gap-1 font-medium leading-tight'>
                            <span className='truncate'>{option.label}</span>
                            {ext && (
                                <span className='tag tag-neutral font-mono'>
                                    {t('web.agentNew.externalTag')}
                                </span>
                            )}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

const RuntimeCard: FC<{
    label: string
    slot?: string
    description: ReactNode
    active?: boolean
    disabled?: boolean
    onClick?: () => void
    to?: string
}> = ({ label, slot, description, active, disabled, onClick, to }) => {
    const base =
        'flex w-full flex-col gap-1.5 rounded-md p-3 text-left transition-colors'
    if (disabled)
        return (
            <div
                aria-disabled='true'
                className={`${base} bg-surface text-subtle shadow-ring-light cursor-not-allowed opacity-70`}
            >
                <div className='flex items-center justify-between gap-2'>
                    <span className='text-ui text-fg/60 font-medium'>
                        {label}
                    </span>
                    {slot && (
                        <span className='text-caption text-subtle font-mono'>
                            {slot}
                        </span>
                    )}
                </div>
                <div className='text-caption text-subtle leading-relaxed'>
                    {description}
                </div>
            </div>
        )
    if (to)
        return (
            <Link
                to={to}
                className={`${base} bg-surface shadow-ring-light hover:bg-surface-hover`}
            >
                <div className='flex items-center justify-between gap-2'>
                    <span className='text-ui text-fg font-medium'>{label}</span>
                    {slot && (
                        <span className='text-caption text-subtle font-mono'>
                            {slot}
                        </span>
                    )}
                </div>
                <div className='text-caption text-muted leading-relaxed'>
                    {description}
                </div>
            </Link>
        )
    return (
        <button
            type='button'
            onClick={onClick}
            aria-pressed={active}
            className={[
                base,
                active
                    ? 'bg-info-bg ring-link/40 ring-2'
                    : 'bg-surface shadow-ring-light hover:bg-surface-hover'
            ].join(' ')}
        >
            <div className='flex items-center justify-between gap-2'>
                <span className='text-ui text-fg font-medium'>{label}</span>
                {slot && (
                    <span className='text-caption text-subtle font-mono'>
                        {slot}
                    </span>
                )}
            </div>
            <div className='text-caption text-muted leading-relaxed'>
                {description}
            </div>
        </button>
    )
}

const runtimeKindShortLabel = (
    kind: AgentRuntimeSummary['kind'],
    t: TFn
): string => {
    if (kind === 'daemon') return t('web.agentNew.localDaemon')
    if (kind === 'k8s') return t('web.agentNew.persistent')
    if (kind === 'sprites') return t('web.agentNew.sandbox')
    return t('web.agentNew.runtime')
}

const ExistingRuntimeRow: FC<{
    runtime: AgentRuntimeSummary
    active: boolean
    onSelect: () => void
}> = ({ runtime, active, onSelect }) => {
    const { t } = useI18n()
    return (
        <button
            type='button'
            onClick={onSelect}
            className={[
                'w-full rounded-md px-3 py-2 text-left transition-colors',
                active
                    ? 'bg-info-bg ring-link/40 ring-2'
                    : 'bg-surface shadow-ring-light hover:bg-surface-hover'
            ].join(' ')}
        >
            <div className='flex min-w-0 items-center gap-1.5'>
                <span className='tag tag-neutral'>
                    {t('web.agentNew.runtime')} -{' '}
                    {runtimeKindShortLabel(runtime.kind, t)}
                </span>
                <span className='text-ui text-fg min-w-0 truncate font-medium'>
                    {runtime.name || runtime.id}
                </span>
            </div>
            <div className='text-caption text-subtle mt-0.5 truncate font-mono'>
                {runtime.framework}
            </div>
        </button>
    )
}

const persistentProviderOptions: Array<{
    value: PersistentModelProvider
    label: string
}> = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' }
]

const defaultRuntimeMode = (
    framework: AgentFramework,
    initialRuntimeId: string
): RuntimeMode => {
    if (initialRuntimeId) return 'existing'
    if (!isCreateableFramework(framework)) return 'sandbox'
    if (isExternalFramework(framework)) return 'sandbox'
    if (isK8sOnlyFramework(framework as CreateableFramework))
        return 'persistent'
    if (supportsSandbox(framework as CreateableFramework)) return 'sandbox'
    return 'persistent'
}

const defaultWorkspaceFor = (
    framework: CreateableFramework,
    runtimeMode: RuntimeMode
): string => {
    if (runtimeMode === 'sandbox') {
        if (framework === 'openclaw')
            return `${SPRITE_HOME_BASE}/.openclaw/workspace`
        if (framework === 'hermes') return `${SPRITE_HOME_BASE}/.hermes`
        if (framework === 'narranexus')
            return `${NARRANEXUS_SPRITE_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
        return `${SPRITE_HOME_BASE}/.manyfold/workspaces/{agent-id}`
    }
    if (framework === 'openclaw') return `${K8S_HOME_BASE}/.openclaw/workspace`
    if (framework === 'hermes') return `${K8S_HOME_BASE}/.hermes`
    if (framework === 'narranexus')
        return `${NARRANEXUS_K8S_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
    return `${K8S_HOME_BASE}/.manyfold/workspaces/{agent-id}`
}

const AgentNewBInline: FC = (): ReactNode => {
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
    const [frameworkSelected, setFrameworkSelected] = useState(
        initialRuntimeId.length > 0 || initialSandboxId.length > 0
    )
    const [name, setName] = useState<string>('')
    const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
        defaultRuntimeMode('claude-code', initialRuntimeId)
    )
    const [runtimePicked, setRuntimePicked] = useState(
        initialRuntimeId.length > 0
    )
    const [pickedRuntimeId, setPickedRuntimeId] = useState(initialRuntimeId)
    const [attachSandboxHostId, setAttachSandboxHostId] = useState('')
    const [frameworkVersionSel, setFrameworkVersionSel] = useState(() =>
        /^v?\d+\.\d+\.\d+$/.test(initialVersion) ? initialVersion : ''
    )
    const [picker, setPicker] = useState<ProviderPickerValue>(() =>
        initialPickerForFramework(framework)
    )
    const [externalProviderUserPicked, setExternalProviderUserPicked] =
        useState(false)
    const [persistentModelProvider, setPersistentModelProvider] =
        useState<PersistentModelProvider>('anthropic')
    const [primaryModelName, setPrimaryModelName] = useState('')
    const [externalProviderId, setExternalProviderId] = useState('')
    const [externalRemoteId, setExternalRemoteId] = useState('')
    const [workspacePath, setWorkspacePath] = useState('')
    const [cloneEnabled, setCloneEnabled] = useState(false)
    const [cloneFromProfile, setCloneFromProfile] = useState('')

    const nameValidation = useMemo(() => validateAgentName(name), [name])
    const nameError = nameValidation.valid ? null : nameValidation.message
    const normalizedName = nameValidation.valid
        ? nameValidation.value
        : normalizeAgentName(name)

    const credentialProvider = isCreateableFramework(framework)
        ? modelProviderForFramework(framework)
        : 'anthropic'
    const modelProviderForRuntime: UserModelProvider =
        isCreateableFramework(framework) &&
        usesConfigurableModelProvider(framework)
            ? persistentModelProvider
            : credentialProvider

    const externalNow = isExternalFramework(framework)
    const isPersistent = runtimeMode === 'persistent'
    const useConfigurableProvider =
        isCreateableFramework(framework) &&
        usesConfigurableModelProvider(framework)

    const modelConfig = useFrameworkModelConfig({
        framework,
        runtimeMode,
        picker,
        providers,
        setProviders,
        modelProviderForRuntime
    })

    useEffect(() => {
        if (!externalNow) return
        void loadExternalProviders(framework as 'dify' | 'langflow' | 'a2a')
    }, [externalNow, framework, loadExternalProviders])

    useEffect(() => {
        if (!externalNow) return
        setExternalProviderId((cur) =>
            cur && externalProviders.some((r) => r.id === cur) ? cur : ''
        )
    }, [externalNow, externalProviders])

    useEffect(() => {
        if (runtimeMode === 'existing') return
        if (externalNow) return
        setPicker((current) => {
            if (current.mode !== 'saved') return current
            const selected = providers.find((p) => p.id === current.providerId)
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
    }, [externalNow, modelProviderForRuntime, providers, runtimeMode])

    useEffect(() => {
        if (runtimeMode === 'existing') return
        if (!isCreateableFramework(framework)) return
        if (!usesConfigurableModelProvider(framework)) return
        if (primaryModelName.trim().length > 0) return
        const options = flattenSavedModels(
            modelConfig.selectedSavedProvider?.lastTestModels
        )
        if (options.length === 0) return
        const preferred = preferredPrimaryModelDefault(
            options,
            modelProviderForRuntime
        )
        if (preferred) setPrimaryModelName(preferred)
    }, [
        framework,
        modelConfig.selectedSavedProvider,
        modelProviderForRuntime,
        primaryModelName,
        runtimeMode
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
        setRuntimePicked(true)
        setRuntimeMode('existing')
        if (
            pick.framework !== framework &&
            isCreateableFramework(pick.framework)
        ) {
            setFramework(pick.framework)
        }
        setFrameworkSelected(true)
        daemonPreselectedRef.current = true
    }, [initialDaemonId, initialRuntimeId, runtimes, framework])

    const onFrameworkChange = (next: AgentFramework): void => {
        if (!isCreateableFramework(next)) return
        setFramework(next)
        setFrameworkSelected(true)
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
        setExternalProviderId('')
        setExternalRemoteId('')
        setPickedRuntimeId('')
        setAttachSandboxHostId('')
        setFrameworkVersionSel('')
        setWorkspacePath('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setRuntimeMode(defaultRuntimeMode(next, ''))
        setRuntimePicked(isExternalFramework(next))
        setExternalProviderUserPicked(false)
    }

    const onChangeRuntimeMode = (mode: RuntimeMode): void => {
        if (mode === 'sandbox' && !supportsSandbox(framework)) return
        if (mode === 'daemon') return
        if (mode === 'persistent') return
        setRuntimeMode(mode)
        setRuntimePicked(true)
        setAttachSandboxHostId('')
        if (mode !== 'existing') {
            setPickedRuntimeId('')
            setCloneEnabled(false)
            setCloneFromProfile('')
        }
    }

    const onPickExistingRuntime = (runtime: AgentRuntimeSummary): void => {
        setRuntimeMode('existing')
        setRuntimePicked(true)
        setPickedRuntimeId(runtime.id)
        setAttachSandboxHostId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
    }

    const onAttachSandbox = (target: SpriteAttachTarget): void => {
        setRuntimeMode('sandbox')
        setRuntimePicked(true)
        setAttachSandboxHostId(target.hostId)
        setPickedRuntimeId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
    }

    const reusableRuntimes = useMemo(
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
    const spriteAttachTargets = useMemo(
        () =>
            computeSpriteTargets(runtimes, framework, sandboxes).filter(
                (t): t is SpriteAttachTarget => t.type === 'attach'
            ),
        [framework, runtimes, sandboxes]
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
        setRuntimePicked(true)
        setAttachSandboxHostId(target.hostId)
        setPickedRuntimeId('')
    }, [initialSandboxId, spriteAttachTargets, runtimes, sandboxes])

    const pickedRuntime = useMemo(
        () => reusableRuntimes.find((r) => r.id === pickedRuntimeId) ?? null,
        [reusableRuntimes, pickedRuntimeId]
    )
    const hermesAttach =
        runtimeMode === 'existing' && pickedRuntime?.framework === 'hermes'
    const pickedRuntimeAgents = pickedRuntime
        ? (runtimeAgents[pickedRuntime.id] ?? [])
        : []

    useEffect(() => {
        if (!hermesAttach || !cloneEnabled || !pickedRuntime) return
        if (runtimeAgents[pickedRuntime.id]) return
        void fetchRuntimeAgents(pickedRuntime.id)
    }, [
        cloneEnabled,
        fetchRuntimeAgents,
        hermesAttach,
        pickedRuntime,
        runtimeAgents
    ])

    useEffect(() => {
        if (!hermesAttach || !cloneEnabled || !pickedRuntime) return
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
    }, [cloneEnabled, hermesAttach, pickedRuntime, runtimeAgents])

    const sandboxLimitReached =
        runtimeAccess !== null &&
        runtimeAccess.statefulSandboxUsage >= runtimeAccess.statefulSandboxLimit
    const cloudComputerAvailable = runtimeAccess?.cloudComputerEnabled === true

    const sandboxSlot = runtimeAccess
        ? `${runtimeAccess.statefulSandboxUsage} / ${runtimeAccess.statefulSandboxLimit}`
        : undefined

    const workspaceInputEnabled =
        !externalNow &&
        runtimeMode !== 'daemon' &&
        framework !== 'hermes' &&
        (runtimeMode !== 'existing' ||
            (pickedRuntime !== null && pickedRuntime.framework !== 'hermes'))

    const trimmedWorkspace = workspaceInputEnabled ? workspacePath.trim() : ''
    const workspaceValidation = validateWorkspacePath(trimmedWorkspace)

    const providerComplete = externalNow
        ? externalProviderUserPicked &&
          externalProviderId.trim().length > 0 &&
          (framework !== 'langflow' || externalRemoteId.trim().length > 0)
        : runtimeMode === 'existing'
          ? pickedRuntime !== null
          : useConfigurableProvider
            ? pickerIsValid(picker) && primaryModelName.trim().length > 0
            : pickerIsValid(picker)

    const runtimeComplete = externalNow
        ? true
        : runtimeMode === 'existing'
          ? pickedRuntime !== null
          : runtimePicked && runtimeMode === 'sandbox'

    const nameComplete = !nameError && name.trim().length > 0

    const completion = useMemo(() => {
        let done = 0
        if (frameworkSelected) done += 1
        if (frameworkSelected && runtimeComplete) done += 1
        if (frameworkSelected && providerComplete) done += 1
        if (frameworkSelected && nameComplete) done += 1
        const total = externalNow ? 3 : 4
        return Math.round((done / total) * 100)
    }, [
        externalNow,
        frameworkSelected,
        nameComplete,
        providerComplete,
        runtimeComplete
    ])

    const canSubmit = (() => {
        if (busy) return false
        if (!frameworkSelected) return false
        if (!nameComplete) return false
        if (!providerComplete) return false
        if (!runtimeComplete) return false
        if (workspaceValidation) return false
        if (
            runtimeMode === 'sandbox' &&
            !attachSandboxHostId &&
            sandboxLimitReached
        )
            return false
        if (runtimeMode === 'persistent') return false
        if (modelConfig.required && !modelConfig.validation.valid) return false
        if (
            hermesAttach &&
            cloneEnabled &&
            (runtimeAgentsLoading ||
                runtimeAgentsError ||
                cloneFromProfile.trim().length === 0)
        )
            return false
        return true
    })()

    const baseUrlForProvider =
        modelProviderForRuntime === 'anthropic'
            ? OFFICIAL_PROVIDER_BASE_URL.anthropic
            : modelProviderForRuntime === 'openai'
              ? OFFICIAL_PROVIDER_BASE_URL.openai
              : OFFICIAL_PROVIDER_BASE_URL.google

    const submit = async (): Promise<void> => {
        if (!canSubmit) return
        setError(null)

        if (runtimeMode === 'existing' && pickedRuntime) {
            const created = await submitAddToRuntime({
                runtimeId: pickedRuntime.id,
                body: buildAddRuntimeAgentBody({
                    name: normalizedName,
                    workspace: trimmedWorkspace || undefined,
                    cloneFrom:
                        hermesAttach && cloneEnabled
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
                      difyBinding: { providerId: externalProviderId }
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
                          a2aBinding: { providerId: externalProviderId }
                      }
                    : buildCreateAgentBody({
                          framework,
                          name: normalizedName,
                          picker,
                          runtimeMode: filesystemRuntimeMode,
                          persistentModelProvider,
                          primaryModelName,
                          modelConfig: modelConfig.draft ?? undefined,
                          workspace: trimmedWorkspace || undefined,
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

    const providerSummary = externalNow
        ? externalProviderId
            ? t('web.agentNew.providerSummaryExternalBound')
            : t('web.agentNew.providerSummaryPickExternal')
        : runtimeMode === 'existing'
          ? t('web.agentNew.providerSummaryInherited')
          : picker.mode === 'saved'
            ? picker.providerId
                ? t('web.agentNew.providerSummarySaved')
                : t('web.agentNew.providerSummaryPickX', {
                      provider: modelProviderForRuntime
                  })
            : picker.apiKey.length >= 10
              ? t('web.agentNew.providerSummaryInlineKey')
              : t('web.agentNew.providerSummaryEnterKey')

    const workspaceSummary = workspaceInputEnabled
        ? trimmedWorkspace ||
          defaultWorkspaceFor(
              framework,
              isPersistent ? 'persistent' : 'sandbox'
          )
        : null

    const runtimeCategory: RuntimeCategory | null =
        runtimeMode === 'existing'
            ? pickedRuntime?.kind === 'sprites'
                ? 'sandbox'
                : pickedRuntime?.kind === 'k8s'
                  ? 'persistent'
                  : pickedRuntime?.kind === 'daemon'
                    ? 'daemon'
                    : null
            : runtimeMode === 'sandbox'
              ? 'sandbox'
              : runtimeMode === 'persistent'
                ? 'persistent'
                : runtimeMode === 'daemon'
                  ? 'daemon'
                  : null

    const runtimeShortLabel =
        runtimeMode === 'existing'
            ? t('web.agentNew.runtimeShortExisting')
            : runtimeCategory
              ? runtimeCategoryShortLabel(runtimeCategory, t)
              : '—'

    const showRuntimeStep = frameworkSelected && !externalNow
    const showProviderStep =
        frameworkSelected && (externalNow || runtimeComplete)
    const showNameStep = frameworkSelected && providerComplete

    const sectionStatuses: {
        framework: StepStatus
        runtime: StepStatus
        provider: StepStatus
        name: StepStatus
    } = {
        framework: frameworkSelected ? 'done' : 'active',
        runtime: !frameworkSelected
            ? 'pending'
            : runtimeComplete
              ? 'done'
              : 'active',
        provider: !showProviderStep
            ? 'pending'
            : providerComplete
              ? 'done'
              : 'active',
        name: !showNameStep ? 'pending' : nameComplete ? 'done' : 'active'
    }

    return (
        <div className='bg-main min-h-full'>
            <header className='bg-main sticky top-0 z-20'>
                <div className='mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 pb-4 pt-7 md:px-6 md:pt-8'>
                    <h1 className='text-fg text-h1 truncate'>
                        {t('web.agentNew.title')}
                    </h1>
                    <div className='flex items-center gap-2'>
                        <button
                            type='button'
                            onClick={() => navigate('/agents')}
                            className='workbench-button-secondary'
                            disabled={busy}
                        >
                            {t('web.agentNew.cancel')}
                        </button>
                    </div>
                </div>
            </header>
            <div className='mx-auto w-full max-w-6xl px-5 pb-8 md:px-6'>
                <div className='grid gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_340px]'>
                    <div className='min-w-0 space-y-4'>
                        <SectionCard
                            index={1}
                            status={sectionStatuses.framework}
                            title={t('web.agentNew.framework')}
                            description={t('web.agentNew.frameworkDesc')}
                        >
                            <FrameworkGrid
                                value={frameworkSelected ? framework : null}
                                onChange={onFrameworkChange}
                            />
                        </SectionCard>

                        {!externalNow && !showRuntimeStep && (
                            <PendingSection
                                index={2}
                                title={t('web.agentNew.runtime')}
                                description={t('web.agentNew.runtimePending')}
                            />
                        )}

                        {showRuntimeStep && (
                            <SectionCard
                                index={2}
                                status={sectionStatuses.runtime}
                                title={t('web.agentNew.runtime')}
                                description={
                                    runtimeMode === 'existing'
                                        ? t('web.agentNew.runtimeDescAttached')
                                        : t('web.agentNew.runtimeDescDefault')
                                }
                            >
                                <div className='space-y-3'>
                                    {supportsSandbox(framework) && (
                                        <RuntimeCard
                                            label={t('web.agentNew.sandbox')}
                                            slot={sandboxSlot}
                                            description={t(
                                                'web.agentNew.sandboxDesc'
                                            )}
                                            active={
                                                runtimePicked &&
                                                runtimeMode === 'sandbox' &&
                                                !attachSandboxHostId
                                            }
                                            onClick={() =>
                                                onChangeRuntimeMode('sandbox')
                                            }
                                        />
                                    )}
                                    <div className='text-caption flex flex-wrap items-center gap-x-4 gap-y-1.5'>
                                        {reuseRuntimeKindsFor(framework).has(
                                            'daemon'
                                        ) && (
                                            <Link
                                                to='/settings/runtimes/local-daemons'
                                                className='text-link font-medium hover:underline'
                                            >
                                                {t(
                                                    'web.agentNew.localDaemonRegister'
                                                )}
                                            </Link>
                                        )}
                                        {cloudComputerAvailable &&
                                            BILLING_SURFACE && (
                                                <Link
                                                    to='/settings/plan-and-billing/buy-container'
                                                    className='text-link font-medium hover:underline'
                                                >
                                                    {t(
                                                        'web.agentNew.persistentRent'
                                                    )}
                                                </Link>
                                            )}
                                    </div>
                                    {(reusableRuntimes.length > 0 ||
                                        spriteAttachTargets.length > 0) && (
                                        <div className='mt-4 space-y-2'>
                                            <div className='text-caption flex items-center justify-between'>
                                                <span className='text-muted font-medium'>
                                                    {t(
                                                        'web.agentNew.orAttachExisting'
                                                    )}
                                                </span>
                                                <span className='text-subtle font-mono'>
                                                    {t(
                                                        'web.agentNew.availableCount',
                                                        {
                                                            count:
                                                                reusableRuntimes.length +
                                                                spriteAttachTargets.length
                                                        }
                                                    )}
                                                </span>
                                            </div>
                                            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                                                {reusableRuntimes.map(
                                                    (runtime) => (
                                                        <ExistingRuntimeRow
                                                            key={runtime.id}
                                                            runtime={runtime}
                                                            active={
                                                                runtimeMode ===
                                                                    'existing' &&
                                                                pickedRuntimeId ===
                                                                    runtime.id
                                                            }
                                                            onSelect={() =>
                                                                onPickExistingRuntime(
                                                                    runtime
                                                                )
                                                            }
                                                        />
                                                    )
                                                )}
                                                {spriteAttachTargets.map(
                                                    (target) => {
                                                        const active =
                                                            runtimeMode ===
                                                                'sandbox' &&
                                                            attachSandboxHostId ===
                                                                target.hostId
                                                        const runs =
                                                            target.frameworks
                                                                .map(
                                                                    (f) =>
                                                                        localizedFrameworkOptions.find(
                                                                            (
                                                                                o
                                                                            ) =>
                                                                                o.value ===
                                                                                f
                                                                        )
                                                                            ?.label ??
                                                                        f
                                                                )
                                                                .join(', ')
                                                        return (
                                                            <button
                                                                key={
                                                                    target.hostId
                                                                }
                                                                type='button'
                                                                onClick={() =>
                                                                    onAttachSandbox(
                                                                        target
                                                                    )
                                                                }
                                                                className={[
                                                                    'w-full rounded-md px-3 py-2 text-left transition-colors',
                                                                    active
                                                                        ? 'bg-info-bg ring-link/40 ring-2'
                                                                        : 'bg-surface shadow-ring-light hover:bg-surface-hover'
                                                                ].join(' ')}
                                                            >
                                                                <div className='flex min-w-0 items-center gap-1.5'>
                                                                    <span className='tag tag-neutral'>
                                                                        {t(
                                                                            'web.agentNew.sandbox'
                                                                        )}
                                                                    </span>
                                                                    <span className='text-ui text-fg min-w-0 truncate font-medium'>
                                                                        {target.name ??
                                                                            target.spriteName ??
                                                                            target.hostId}
                                                                    </span>
                                                                </div>
                                                                <div className='text-caption text-subtle mt-0.5 truncate'>
                                                                    {`+ ${
                                                                        localizedFrameworkOptions.find(
                                                                            (
                                                                                o
                                                                            ) =>
                                                                                o.value ===
                                                                                framework
                                                                        )
                                                                            ?.label ??
                                                                        framework
                                                                    } · ${t(
                                                                        'web.agentNew.runs'
                                                                    )} ${runs} · ${
                                                                        target.runtimeCount
                                                                    }/4`}
                                                                </div>
                                                            </button>
                                                        )
                                                    }
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {hermesAttach && (
                                        <div className='bg-soft mt-3 space-y-2 rounded-md p-3'>
                                            <label className='text-ui text-fg flex items-center gap-2 font-medium'>
                                                <input
                                                    type='checkbox'
                                                    checked={cloneEnabled}
                                                    onChange={(e) => {
                                                        setCloneEnabled(
                                                            e.target.checked
                                                        )
                                                        if (!e.target.checked)
                                                            setCloneFromProfile(
                                                                ''
                                                            )
                                                    }}
                                                    className='accent-fg'
                                                />
                                                {t('web.agentNew.cloneProfile')}
                                            </label>
                                            {cloneEnabled && (
                                                <div className='pl-6'>
                                                    {runtimeAgentsLoading && (
                                                        <p className='text-muted text-caption'>
                                                            {t(
                                                                'web.agentNew.loadingProfiles'
                                                            )}
                                                        </p>
                                                    )}
                                                    {runtimeAgentsError && (
                                                        <p className='text-workflow-ship text-caption'>
                                                            {runtimeAgentsError}
                                                        </p>
                                                    )}
                                                    {!runtimeAgentsLoading &&
                                                        !runtimeAgentsError &&
                                                        pickedRuntimeAgents.length >
                                                            0 && (
                                                            <div className='block'>
                                                                <span className='workbench-field-label'>
                                                                    {t(
                                                                        'web.agentNew.sourceProfile'
                                                                    )}
                                                                </span>
                                                                <WorkbenchSelect
                                                                    mono
                                                                    ariaLabel={t(
                                                                        'web.agentNew.sourceProfile'
                                                                    )}
                                                                    value={
                                                                        cloneFromProfile
                                                                    }
                                                                    onChange={
                                                                        setCloneFromProfile
                                                                    }
                                                                    options={pickedRuntimeAgents.map(
                                                                        (
                                                                            p
                                                                        ) => ({
                                                                            value: p.id,
                                                                            label: p.id
                                                                        })
                                                                    )}
                                                                />
                                                            </div>
                                                        )}
                                                    {!runtimeAgentsLoading &&
                                                        !runtimeAgentsError &&
                                                        pickedRuntimeAgents.length ===
                                                            0 && (
                                                            <p className='text-muted text-caption'>
                                                                {t(
                                                                    'web.agentNew.noProfilesToClone'
                                                                )}
                                                            </p>
                                                        )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </SectionCard>
                        )}

                        {!showProviderStep && (
                            <PendingSection
                                index={externalNow ? 2 : 3}
                                title={t('web.agentNew.provider')}
                                description={
                                    !frameworkSelected
                                        ? t('web.agentNew.providerPendingNoFw')
                                        : t('web.agentNew.providerPending')
                                }
                            />
                        )}

                        {showProviderStep && (
                            <SectionCard
                                index={externalNow ? 2 : 3}
                                status={sectionStatuses.provider}
                                title={t('web.agentNew.provider')}
                                description={
                                    externalNow
                                        ? t('web.agentNew.providerDescExternal')
                                        : runtimeMode === 'existing'
                                          ? t(
                                                'web.agentNew.providerDescInherited'
                                            )
                                          : t('web.agentNew.providerDescNew')
                                }
                            >
                                {externalNow ? (
                                    <div className='space-y-3'>
                                        {externalProvidersError && (
                                            <p className='text-workflow-ship text-caption'>
                                                {externalProvidersError}
                                            </p>
                                        )}
                                        {externalProviders.length === 0 ? (
                                            <p className='text-muted text-ui'>
                                                {t(
                                                    'web.agentNew.noExternalProviders'
                                                )}{' '}
                                                <Link
                                                    to='/settings/runtimes/external-agent-providers'
                                                    className='text-link hover:text-fg font-medium'
                                                >
                                                    {t(
                                                        'web.agentNew.createOneLink'
                                                    )}
                                                </Link>{' '}
                                                {t('web.agentNew.firstSuffix')}
                                            </p>
                                        ) : (
                                            <div className='block'>
                                                <span className='workbench-field-label'>
                                                    {t('web.agentNew.provider')}
                                                </span>
                                                <WorkbenchSelect
                                                    mono
                                                    ariaLabel={t(
                                                        'web.agentNew.provider'
                                                    )}
                                                    placeholder={t(
                                                        'web.agentNew.pickAProvider'
                                                    )}
                                                    value={externalProviderId}
                                                    onChange={(next) => {
                                                        setExternalProviderId(
                                                            next
                                                        )
                                                        setExternalProviderUserPicked(
                                                            next.length > 0
                                                        )
                                                    }}
                                                    options={[
                                                        {
                                                            value: '',
                                                            label: t(
                                                                'web.agentNew.pickAProvider'
                                                            )
                                                        },
                                                        ...externalProviders.map(
                                                            (p) => ({
                                                                value: p.id,
                                                                label: `${p.label} · ${p.endpointUrl}`
                                                            })
                                                        )
                                                    ]}
                                                />
                                            </div>
                                        )}
                                        {framework === 'langflow' && (
                                            <label className='block'>
                                                <span className='workbench-field-label'>
                                                    {remoteIdLabelFor(
                                                        framework,
                                                        t
                                                    )}
                                                </span>
                                                <input
                                                    value={externalRemoteId}
                                                    onChange={(e) =>
                                                        setExternalRemoteId(
                                                            e.target.value
                                                        )
                                                    }
                                                    placeholder={remoteIdPlaceholderFor(
                                                        framework,
                                                        t
                                                    )}
                                                    className='workbench-input font-mono'
                                                />
                                                <p className='workbench-hint mt-2'>
                                                    {remoteIdHintFor(
                                                        framework,
                                                        t
                                                    )}
                                                </p>
                                            </label>
                                        )}
                                    </div>
                                ) : runtimeMode === 'existing' ? (
                                    <div className='bg-soft text-ui text-muted rounded-md p-3'>
                                        {t('web.agentNew.usingCredentialsFrom')}{' '}
                                        <span className='text-fg font-mono'>
                                            {pickedRuntime?.name ?? '—'}
                                        </span>
                                        .
                                    </div>
                                ) : (
                                    <div className='space-y-4'>
                                        {useConfigurableProvider && (
                                            <div>
                                                <span className='workbench-field-label'>
                                                    {t(
                                                        'web.agentNew.apiProvider'
                                                    )}
                                                </span>
                                                <div className='grid grid-cols-2 gap-2'>
                                                    {persistentProviderOptions.map(
                                                        (opt) => (
                                                            <button
                                                                key={opt.value}
                                                                type='button'
                                                                onClick={() => {
                                                                    setPersistentModelProvider(
                                                                        opt.value
                                                                    )
                                                                    setPicker(
                                                                        initialPicker()
                                                                    )
                                                                    setPrimaryModelName(
                                                                        ''
                                                                    )
                                                                }}
                                                                className={[
                                                                    'shadow-ring-light text-ui rounded-md px-3 py-2 font-medium transition-colors',
                                                                    persistentModelProvider ===
                                                                    opt.value
                                                                        ? 'bg-info-bg text-fg ring-link/40 ring-2'
                                                                        : 'bg-surface text-muted hover:bg-surface-hover'
                                                                ].join(' ')}
                                                            >
                                                                {opt.label}
                                                            </button>
                                                        )
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        <ProviderPicker
                                            provider={modelProviderForRuntime}
                                            framework={framework}
                                            allowRuntimeMode={isConfigurableFramework(
                                                framework
                                            )}
                                            apiKeyLabel={apiKeyLabelForProvider(
                                                credentialProvider
                                            )}
                                            baseUrlLabel={t(
                                                'web.agentNew.baseUrlOptional'
                                            )}
                                            baseUrlPlaceholder={
                                                baseUrlForProvider
                                            }
                                            defaultBaseUrl={baseUrlForProvider}
                                            options={providers}
                                            value={picker}
                                            onChange={setPicker}
                                            autoSelectFirst={
                                                useConfigurableProvider
                                            }
                                        />
                                        {modelConfig.required && (
                                            <CreateFrameworkModelConfig
                                                view={modelConfig.view}
                                                draft={modelConfig.draft}
                                                validationMessage={
                                                    modelConfig.validation
                                                        .message
                                                }
                                                onChange={modelConfig.setDraft}
                                                onTestProvider={() =>
                                                    void modelConfig.runTest()
                                                }
                                                providerTestLabel={
                                                    modelConfig.providerTestLabel
                                                }
                                                providerTesting={
                                                    modelConfig.testing
                                                }
                                                providerTestDisabled={
                                                    modelConfig.providerTestDisabled
                                                }
                                                providerTestError={
                                                    modelConfig.testError
                                                }
                                            />
                                        )}
                                        {useConfigurableProvider && (
                                            <label className='block'>
                                                <span className='workbench-field-label'>
                                                    {t(
                                                        'web.agentNew.primaryModel'
                                                    )}
                                                </span>
                                                <input
                                                    value={primaryModelName}
                                                    onChange={(e) =>
                                                        setPrimaryModelName(
                                                            e.target.value
                                                        )
                                                    }
                                                    placeholder={t(
                                                        'web.agentNew.primaryModelPlaceholder'
                                                    )}
                                                    className='workbench-input font-mono'
                                                />
                                            </label>
                                        )}
                                    </div>
                                )}
                            </SectionCard>
                        )}

                        {!showNameStep && (
                            <PendingSection
                                index={externalNow ? 3 : 4}
                                title={t('web.agentNew.nameWorkspace')}
                                description={
                                    !frameworkSelected
                                        ? t(
                                              'web.agentNew.nameWorkspacePendingDesc'
                                          )
                                        : t(
                                              'web.agentNew.nameWorkspacePendingDesc2'
                                          )
                                }
                            />
                        )}

                        {showNameStep && (
                            <SectionCard
                                index={externalNow ? 3 : 4}
                                status={sectionStatuses.name}
                                title={t('web.agentNew.nameWorkspace')}
                                description={
                                    workspaceInputEnabled
                                        ? t('web.agentNew.nameWorkspaceDesc')
                                        : t(
                                              'web.agentNew.nameWorkspaceDescNoWs'
                                          )
                                }
                            >
                                <div className='space-y-3'>
                                    <label className='block'>
                                        <span className='workbench-field-label'>
                                            {t('web.agentNew.agentName')}
                                        </span>
                                        <div className='flex gap-2'>
                                            <input
                                                type='text'
                                                value={name}
                                                onChange={(e) =>
                                                    setName(e.target.value)
                                                }
                                                placeholder={t(
                                                    'web.agentNew.agentNamePlaceholder'
                                                )}
                                                className='workbench-input flex-1 font-mono'
                                            />
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    setName(randomAgentName())
                                                }
                                                className='workbench-button-secondary text-ui shrink-0 px-3'
                                            >
                                                {t('web.agentNew.random')}
                                            </button>
                                        </div>
                                        {nameError && (
                                            <p className='text-workflow-ship text-caption mt-1.5'>
                                                {nameError}
                                            </p>
                                        )}
                                    </label>
                                    {workspaceInputEnabled && (
                                        <label className='block'>
                                            <span className='workbench-field-label'>
                                                {t(
                                                    'web.agentNew.workspacePath'
                                                )}
                                            </span>
                                            <input
                                                value={workspacePath}
                                                onChange={(e) =>
                                                    setWorkspacePath(
                                                        e.target.value
                                                    )
                                                }
                                                placeholder={defaultWorkspaceFor(
                                                    framework,
                                                    isPersistent
                                                        ? 'persistent'
                                                        : 'sandbox'
                                                )}
                                                className='workbench-input font-mono'
                                            />
                                            {workspaceValidation && (
                                                <p className='text-workflow-ship text-caption mt-1.5'>
                                                    {workspaceValidation}
                                                </p>
                                            )}
                                        </label>
                                    )}
                                </div>
                            </SectionCard>
                        )}

                        {error && (
                            <div className='bg-danger-bg shadow-ring-light rounded-md p-3'>
                                <pre className='text-workflow-ship text-caption whitespace-pre-wrap font-mono'>
                                    {error}
                                </pre>
                            </div>
                        )}
                    </div>

                    <aside className='self-start lg:sticky lg:top-[88px]'>
                        <div className='bg-surface shadow-ring-light rounded-md p-5 md:p-6'>
                            <div className='flex items-center gap-2'>
                                <h3 className='text-fg text-h3 flex-1'>
                                    {t('web.agentNew.whatWillBeCreated')}
                                </h3>
                                <span
                                    aria-label={t('web.agentNew.livePreview')}
                                    className='tag tag-info'
                                >
                                    <span
                                        aria-hidden='true'
                                        className='tag-dot animate-pulse'
                                    />
                                    {t('web.agentNew.live')}
                                </span>
                            </div>

                            <div className='mt-4'>
                                <div className='bg-soft h-1 overflow-hidden rounded-full'>
                                    <div
                                        className='bg-workflow-develop h-full transition-all'
                                        style={{ width: `${completion}%` }}
                                    />
                                </div>
                                <div className='text-caption text-subtle mt-1.5 flex justify-between'>
                                    <span>
                                        {t('web.agentNew.percentComplete', {
                                            percent: completion
                                        })}
                                    </span>
                                    <span>
                                        {completion < 100
                                            ? t('web.agentNew.fillRemaining')
                                            : t('web.agentNew.ready')}
                                    </span>
                                </div>
                            </div>

                            <dl className='text-ui mt-5 space-y-2.5'>
                                <AsideRow
                                    label={t('web.agentNew.framework')}
                                    mono={frameworkSelected}
                                    empty={!frameworkSelected}
                                    value={
                                        frameworkSelected ? (
                                            <span className='inline-flex items-center gap-1.5'>
                                                <FrameworkLogo
                                                    framework={framework}
                                                    size={16}
                                                    className='shrink-0'
                                                />
                                                <span>{framework}</span>
                                            </span>
                                        ) : (
                                            t('web.agentNew.notPicked')
                                        )
                                    }
                                />
                                {!externalNow && (
                                    <AsideRow
                                        label={t('web.agentNew.runtime')}
                                        value={
                                            runtimeComplete
                                                ? runtimeShortLabel
                                                : t('web.agentNew.notPicked')
                                        }
                                        empty={!runtimeComplete}
                                    />
                                )}
                                <AsideRow
                                    label={t('web.agentNew.provider')}
                                    value={
                                        providerComplete
                                            ? providerSummary
                                            : t('web.agentNew.notPicked')
                                    }
                                    empty={!providerComplete}
                                />
                                {frameworkSelected &&
                                    useConfigurableProvider && (
                                        <AsideRow
                                            label={t('web.credentials.model')}
                                            mono={
                                                primaryModelName.trim().length >
                                                0
                                            }
                                            value={
                                                primaryModelName.trim() ||
                                                t('web.agentNew.required')
                                            }
                                            empty={!primaryModelName.trim()}
                                        />
                                    )}
                                <AsideRow
                                    label={t('web.agentNew.agentName')}
                                    mono={nameComplete}
                                    value={
                                        nameComplete
                                            ? name
                                            : t('web.agentNew.notSet')
                                    }
                                    empty={!nameComplete}
                                />
                                {frameworkSelected &&
                                    !externalNow &&
                                    workspaceSummary && (
                                        <AsideRow
                                            label={t('web.agentNew.workspace')}
                                            mono
                                            value={workspaceSummary}
                                            truncate
                                        />
                                    )}
                                {frameworkSelected &&
                                    hermesAttach &&
                                    cloneEnabled && (
                                        <AsideRow
                                            label={t('web.agentNew.clonedFrom')}
                                            mono
                                            value={
                                                cloneFromProfile ||
                                                t('web.agentNew.selectProfile')
                                            }
                                            empty={!cloneFromProfile}
                                        />
                                    )}
                            </dl>

                            <div className='mt-5 space-y-2'>
                                {modelConfig.required &&
                                    !modelConfig.validation.valid && (
                                        <p className='workbench-hint'>
                                            {modelConfig.testing
                                                ? t(
                                                      'web.agentNew.loadingProviderModels'
                                                  )
                                                : modelConfig.validation
                                                      .message}
                                        </p>
                                    )}
                                <button
                                    type='button'
                                    onClick={() => void submit()}
                                    disabled={!canSubmit}
                                    className='workbench-button-primary text-ui h-10 w-full justify-center'
                                >
                                    {busy
                                        ? t('web.agentNew.creating')
                                        : t('web.agentNew.createAgent')}
                                </button>
                            </div>
                        </div>
                    </aside>
                </div>
            </div>

            {progress && (
                <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm'>
                    <div className='bg-surface shadow-elevated w-full max-w-lg rounded-md p-6'>
                        <div className='flex items-start gap-3'>
                            {!progress.failedStep && !progress.done && (
                                <Spinner size={20} className='text-info mt-1' />
                            )}
                            <div className='min-w-0 flex-1'>
                                <h3 className='text-fg text-h3 tracking-tight'>
                                    {t('web.agentNew.creatingTitle')}{' '}
                                    <code className='font-mono'>
                                        {normalizedName}
                                    </code>
                                </h3>
                                <p className='text-muted text-caption mt-1 leading-relaxed'>
                                    {progress.failedStep
                                        ? t('web.agentNew.creatingFailed')
                                        : t('web.agentNew.creatingNormal')}
                                </p>
                            </div>
                        </div>
                        <div className='border-divider mt-5 border-t pt-5'>
                            <CreateProgress
                                steps={progress.steps}
                                currentIndex={progress.currentIndex}
                                failedStep={progress.failedStep}
                                errorMessage={progress.errorMessage}
                            />
                        </div>
                        {progress.done && progress.failedStep && (
                            <div className='border-divider mt-5 flex items-center justify-between border-t pt-4'>
                                <span className='text-caption text-subtle'>
                                    {t('web.agentNew.provisioningHalted', {
                                        current: progress.currentIndex + 1,
                                        total: progress.steps.length
                                    })}
                                </span>
                                <button
                                    type='button'
                                    onClick={resetProgress}
                                    className='workbench-button-secondary text-ui h-9 px-3'
                                >
                                    {t('web.agentNew.dismiss')}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

const AsideRow: FC<{
    label: string
    value: ReactNode
    empty?: boolean
    truncate?: boolean
    mono?: boolean
}> = ({ label, value, empty, truncate, mono }) => (
    <div className='flex items-baseline justify-between gap-3'>
        <dt className='text-subtle shrink-0'>{label}</dt>
        <ShortcutTooltip
            label={typeof value === 'string' ? value : undefined}
            placement='bottom-end'
            className='min-w-0'
        >
            <dd
                className={[
                    'w-full min-w-0 text-right',
                    mono ? 'font-mono' : '',
                    truncate ? 'truncate' : 'break-words',
                    empty ? 'text-placeholder italic' : 'text-fg'
                ].join(' ')}
            >
                {value || '—'}
            </dd>
        </ShortcutTooltip>
    </div>
)

export default AgentNewBInline
