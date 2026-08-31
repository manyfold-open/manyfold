import {
    AgentRuntimeSummary,
    CreateAgentBody,
    DaemonHostSummary,
    ExternalAgentProviderKind,
    K8S_HOME_BASE,
    NARRANEXUS_K8S_BASE_WORKING_PATH,
    NARRANEXUS_SPRITE_BASE_WORKING_PATH,
    OFFICIAL_PROVIDER_BASE_URL,
    SPRITE_HOME_BASE,
    UserExternalAgentProviderSummary,
    UserModelProvider,
    UserModelProviderSummary,
    brandFor,
    defaultProtocolForProvider,
    externalSteps,
    frameworkSupportsProtocol,
    inputValidation,
    isManagedProtocolAllowedForFramework,
    normalizeAgentName,
    providerProtocolForTarget,
    providerSupportsTarget,
    suggestAgentName,
    validateAgentName
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg'
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg'
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter.svg'
import {
    CheckIcon,
    CloseIcon,
    InfoIcon,
    PlugIcon,
    PlusIcon,
    ProviderIcon,
    RefreshIcon
} from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useI18n } from '@/lib/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useManagedCreditGate } from '@/lib/managedCreditGate'
import { Spinner } from '@/components/Loading'
import { useAppShellContext } from '@/components/AppShell'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import WorkbenchSelect, {
    type WorkbenchSelectOption
} from '@/components/WorkbenchSelect'
import ProductDialog from '@/components/ProductDialog'
import ConnectDaemonDialog from '@/components/ConnectDaemonDialog'
import ExternalProviderDialog from '@/components/ExternalProviderDialog'
import { BrandMark } from '@/components/Brand'
import {
    CAPABILITY_ICON,
    FRAMEWORK_CAPABILITIES
} from '@/pages/AgentNew/v3/capabilities'
import { CreateProgress } from '@/pages/AgentNew/components/CreateProgress'
import { SandboxSlots } from '@/pages/AgentNew/components/SandboxSlots'
import { WorkspacePathField } from '@/pages/AgentNew/WorkspacePathField'
import {
    initialPicker,
    pickerIsValid,
    type ProviderPickerValue
} from '@/pages/AgentNew/components/ProviderPicker'
import { CreateFrameworkModelConfig } from '@/pages/AgentNew/components/shared/CreateFrameworkModelConfig'
import {
    apiKeyLabelForProvider,
    buildAddRuntimeAgentBody,
    buildCreateAgentBody,
    modelProviderForFramework,
    progressStepsForCreate,
    workspaceValidationMessage,
    type AgentCreateRuntimeMode,
    type CreateableFramework,
    type PersistentModelProvider
} from '@/lib/agentCreateDraft'
import {
    preferredPrimaryModelDefault,
    providerModelIdsForSummary
} from '@/lib/agentModelConfig'
import { fmtCost } from '@/lib/usageFormat'
import { inferenceProtocolLabel } from '@/pages/Settings/ModelProviderFields'
import {
    frameworkOptions,
    isExternalFramework,
    reuseRuntimeKindsFor,
    REUSE_FRAMEWORKS,
    remoteIdHintFor,
    remoteIdLabelFor,
    remoteIdPlaceholderFor,
    supportsSandbox,
    usesConfigurableModelProvider,
    type RuntimeMode
} from '@/lib/agentCreate/frameworkOptions'
import { randomAgentName } from '@/lib/agentCreate/agentName'
import {
    collapseManagedChannels,
    openclawWorkspaceFor,
    preferredSavedProviderFor
} from '@/lib/agentCreate/providerHelpers'
import {
    computeSpriteTargets,
    spriteHostOccupancy,
    stripFrameworkSuffix,
    type SpriteAttachTarget,
    type SpriteBlockedTarget
} from '@/lib/agentCreate/spriteTargets'
import { useFrameworkModelConfig } from '@/lib/agentCreate/useFrameworkModelConfig'
import { useAgentCreate } from '@/lib/agentCreate/useAgentCreate'
import { BILLING_SURFACE } from '@/edition-capabilities'

const PROVIDER_NEW_KEY_OPTION = '__new_key__'
const PROVIDER_INLINE_OPTION = '__inline__'

const NAME_ERROR_KEY = {
    empty: 'errors.agentName.empty',
    too_long: 'errors.agentName.tooLong',
    control_character: 'errors.agentName.controlCharacter',
    invalid_start: 'errors.agentName.invalidStart',
    invalid_character: 'errors.agentName.invalidCharacter'
} as const

const providerBrandIconSrc: Record<string, string> = {
    anthropic: anthropicIcon,
    openai: openaiIcon,
    openrouter: openrouterIcon,
    google: geminiIcon,
    antigravity: geminiIcon,
    antigravity_claude: anthropicIcon
}

interface ManagedRightLabel {
    text: string
    tone: 'success' | 'muted'
}

// Every managed row reads as one platform offer ("Manyfold managed"), which
// makes two channels of the same family indistinguishable. Appended only when a
// list really holds more than one managed channel.
const managedChannelName: Partial<Record<UserModelProvider, string>> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Gemini',
    antigravity: 'Antigravity',
    antigravity_claude: 'Antigravity Claude'
}

const providerOptionLabel = (
    o: UserModelProviderSummary,
    rightLabel: ManagedRightLabel | undefined,
    showManagedChannel: boolean,
    managedLabel: string
): ReactNode => {
    const managed = o.source === 'managed'
    const brand = brandFor(o)
    const iconSrc = brand ? providerBrandIconSrc[brand] : undefined
    const channel =
        managed && showManagedChannel && brand
            ? managedChannelName[brand]
            : undefined
    return (
        <span className='flex min-w-0 flex-1 items-center gap-2'>
            {managed ? (
                <BrandMark className='text-fg h-[18px] w-auto shrink-0' />
            ) : iconSrc ? (
                <img
                    src={iconSrc}
                    alt=''
                    aria-hidden='true'
                    className={[
                        'h-[18px] w-[18px] shrink-0',
                        brand === 'google' ? '' : 'dark:invert'
                    ].join(' ')}
                />
            ) : null}
            <span className='truncate'>
                {managed
                    ? channel
                        ? `${managedLabel} · ${channel}`
                        : managedLabel
                    : o.providerName}
            </span>
            {managed && rightLabel ? (
                <span
                    className={[
                        'tag shrink-0',
                        rightLabel.tone === 'success'
                            ? 'tag-success'
                            : 'tag-neutral'
                    ].join(' ')}
                >
                    {rightLabel.text}
                </span>
            ) : null}
        </span>
    )
}

const modelFamilyName: Record<PersistentModelProvider, string> = {
    anthropic: inferenceProtocolLabel.anthropic_messages,
    openai: inferenceProtocolLabel.openai_responses
}

const persistentProviderOptions: Array<{
    value: PersistentModelProvider
    label: string
}> = [
    { value: 'anthropic', label: modelFamilyName.anthropic },
    { value: 'openai', label: modelFamilyName.openai }
]

const defaultWorkspaceFor = (
    framework: CreateableFramework,
    runtimeMode: AgentCreateRuntimeMode
): string => {
    const home = runtimeMode === 'persistent' ? K8S_HOME_BASE : SPRITE_HOME_BASE
    if (framework === 'openclaw') return `${home}/.openclaw/workspace`
    if (framework === 'narranexus')
        return `${runtimeMode === 'persistent' ? NARRANEXUS_K8S_BASE_WORKING_PATH : NARRANEXUS_SPRITE_BASE_WORKING_PATH}/{agent-id}_<mf-user>`
    return `${home}/.manyfold/workspaces/{agent-id}`
}

const rowClass = (active: boolean, disabled = false): string =>
    [
        'shadow-ring-light focus-visible:shadow-focus w-full rounded-md px-3.5 py-3 text-left transition-[color,background-color,box-shadow] focus:outline-none',
        disabled
            ? 'bg-surface text-muted cursor-not-allowed opacity-55'
            : active
              ? 'bg-info-bg text-fg ring-link/40 ring-2'
              : 'bg-surface text-muted hover:bg-surface-hover hover:text-fg'
    ].join(' ')

// Slots use foreground-alpha fills, not fixed colors or borders: an alpha
// overlay keeps a constant relative contrast across the row's rest/hover/
// selected background swaps (a fixed fill blends into one of them), and flips
// automatically in dark mode. Occupied and empty share the same fill; the only
// distinction is the framework logo. Small square radius to echo its shape.
const modeSegmentClass = (active: boolean): string =>
    [
        'inline-flex h-8 items-center justify-center rounded-sm px-4 text-ui font-medium transition-colors',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'text-muted hover:bg-surface-hover'
    ].join(' ')

// Create-agent hierarchy (DESIGN.md §8.12 label ladder):
//   card title    text-h3                    (CardHeader)
//   option title  text-ui font-medium text-fg
//   field label   .workbench-field-label     (labels one control)
//   group label   .workbench-group-label     (quiet sentence-case section head)
const CardHeader: FC<{ title: string; right?: ReactNode }> = ({
    title,
    right
}) => (
    <div className='mb-4 flex items-center justify-between gap-2'>
        <h2 className='text-fg text-h3 tracking-tight'>{title}</h2>
        {right}
    </div>
)

const AgentNewV3: FC = (): ReactNode => {
    const { t } = useI18n()
    const localizedFrameworkOptions = frameworkOptions.map((option) => ({
        ...option,
        description: t(option.descriptionKey)
    }))
    const navigate = useNavigate()
    const { agents, refreshAgents } = useAppShellContext()
    const [params] = useSearchParams()
    const initialFramework = params.get('framework') ?? ''
    const initialDaemonId = params.get('daemonId') ?? ''
    const initialSandboxId = params.get('sandboxId') ?? ''
    const initialVersion = params.get('version') ?? ''

    const client = useApiClient()
    const create = useAgentCreate()
    const {
        providers,
        setProviders,
        setRuntimes,
        refetchRuntimes,
        externalProviders,
        externalProvidersError,
        runtimes,
        daemonHosts,
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

    // A deep link that names a sandbox (the "Provision here" button on a sandbox's
    // detail page) has to land in advanced mode — that's where the runtime picker
    // lives, so simple mode would drop the pin the user just made.
    const [mode, setMode] = useState<'simple' | 'advanced'>(
        params.get('advanced') === '1' || initialSandboxId
            ? 'advanced'
            : 'simple'
    )
    const [framework, setFramework] = useState<CreateableFramework>(() =>
        localizedFrameworkOptions.some((o) => o.value === initialFramework)
            ? (initialFramework as CreateableFramework)
            : 'claude-code'
    )
    const [name, setName] = useState(randomAgentName)
    const [picker, setPicker] = useState<ProviderPickerValue>(initialPicker)
    const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('sandbox')
    const [pickedRuntimeId, setPickedRuntimeId] = useState('')
    const [attachSandboxHostId, setAttachSandboxHostId] = useState('')
    const [persistentModelProvider, setPersistentModelProvider] =
        useState<PersistentModelProvider>(() => {
            const initial = localizedFrameworkOptions.some(
                (o) => o.value === initialFramework
            )
                ? (initialFramework as CreateableFramework)
                : 'claude-code'
            if (usesConfigurableModelProvider(initial)) return 'openai'
            const target = modelProviderForFramework(initial)
            return target === 'google'
                ? 'anthropic'
                : (target as PersistentModelProvider)
        })
    const [primaryModelName, setPrimaryModelName] = useState('')
    const [externalProviderId, setExternalProviderId] = useState('')
    const [externalRemoteId, setExternalRemoteId] = useState('')
    const [cloneEnabled, setCloneEnabled] = useState(false)
    const [cloneFromProfile, setCloneFromProfile] = useState('')
    const [workspace, setWorkspace] = useState(() => {
        const initial = localizedFrameworkOptions.some(
            (o) => o.value === initialFramework
        )
            ? (initialFramework as CreateableFramework)
            : 'claude-code'
        return defaultWorkspaceFor(initial, 'sandbox')
    })
    const credit = useManagedCreditGate()
    const [keyDialogOpen, setKeyDialogOpen] = useState(false)
    const [keyDraft, setKeyDraft] = useState<ProviderPickerValue>(initialPicker)
    const [keyChecking, setKeyChecking] = useState(false)
    const [keyError, setKeyError] = useState<string | null>(null)
    const [connectDaemonOpen, setConnectDaemonOpen] = useState(false)
    const [externalProviderDialogOpen, setExternalProviderDialogOpen] =
        useState(false)

    const streamOpen = progress !== null && !progress.done
    const isExternal = isExternalFramework(framework)
    const isConfigurable = usesConfigurableModelProvider(framework)
    const advanced = mode === 'advanced' && !isExternal
    const showQuickDefaults = !advanced && !isExternal

    const credentialProvider = modelProviderForFramework(framework)
    const modelProviderForRuntime: UserModelProvider = isConfigurable
        ? persistentModelProvider
        : credentialProvider
    const baseUrlForProvider =
        OFFICIAL_PROVIDER_BASE_URL[modelProviderForRuntime]

    const modelConfig = useFrameworkModelConfig({
        framework,
        runtimeMode,
        picker,
        providers,
        setProviders,
        modelProviderForRuntime
    })

    const preferred = useMemo(
        () =>
            preferredSavedProviderFor(
                providers,
                modelProviderForRuntime,
                framework
            ),
        [providers, modelProviderForRuntime, framework]
    )

    useEffect(() => {
        if (!isExternal) return
        void loadExternalProviders(framework as 'dify' | 'langflow' | 'a2a')
    }, [isExternal, framework, loadExternalProviders])

    useEffect(() => {
        if (!isExternal) return
        setExternalProviderId((cur) =>
            cur && externalProviders.some((r) => r.id === cur)
                ? cur
                : (externalProviders[0]?.id ?? '')
        )
    }, [isExternal, externalProviders])

    useEffect(() => {
        if (isExternal || runtimeMode === 'existing') return
        setPicker((current) => {
            if (current.mode !== 'saved') return current
            const selected = providers.find((o) => o.id === current.providerId)
            if (
                selected &&
                providerSupportsTarget(selected, modelProviderForRuntime)
            )
                return current
            return { ...initialPicker(), providerId: preferred?.id ?? '' }
        })
    }, [isExternal, runtimeMode, preferred, providers, modelProviderForRuntime])

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
    const spriteTargets = useMemo(
        () => computeSpriteTargets(runtimes, framework, sandboxes),
        [framework, runtimes, sandboxes]
    )
    const spriteAttachTargets = useMemo(
        () =>
            spriteTargets.filter(
                (target): target is SpriteAttachTarget =>
                    target.type === 'attach'
            ),
        [spriteTargets]
    )
    const spriteBlockedTargets = useMemo(
        () =>
            spriteTargets.filter(
                (target): target is SpriteBlockedTarget =>
                    target.type === 'blocked'
            ),
        [spriteTargets]
    )
    const sandboxNameByHostId = useMemo(
        () => new Map(sandboxes.map((s) => [s.id, s.name])),
        [sandboxes]
    )
    const hostOccupancy = useMemo(
        () => spriteHostOccupancy(runtimes),
        [runtimes]
    )
    const reuseDisplayName = (r: AgentRuntimeSummary): string => {
        if (r.kind === 'sprites' && r.hostId) {
            const friendly = sandboxNameByHostId.get(r.hostId)
            if (friendly) return friendly
        }
        return stripFrameworkSuffix(r.name, r.framework) || r.id
    }
    const pickedRuntime = useMemo(
        () => reusableRuntimes.find((r) => r.id === pickedRuntimeId) ?? null,
        [reusableRuntimes, pickedRuntimeId]
    )

    // Honour ?sandboxId=. The pinned sandbox is either an attach target (install
    // this framework onto it) or already runs the framework, in which case it
    // appears as a reuse runtime instead.
    //
    // The ref is only set once the pin has actually been applied, never on a
    // "haven't found it yet" pass: runtimes and sandboxes load independently, and
    // a bare sandbox (no runtimes at all) exists ONLY in the sandboxes list — so
    // giving up after the first non-empty list would silently drop the pin
    // whenever the runtimes response won the race.
    const sandboxPreselectedRef = useRef(false)
    useEffect(() => {
        if (!initialSandboxId || sandboxPreselectedRef.current) return
        const attachTarget = spriteAttachTargets.find(
            (target) => target.hostId === initialSandboxId
        )
        if (attachTarget) {
            sandboxPreselectedRef.current = true
            setRuntimeMode('sandbox')
            setAttachSandboxHostId(attachTarget.hostId)
            setPickedRuntimeId('')
            return
        }
        const reuseTarget = reusableRuntimes.find(
            (r) => r.hostId === initialSandboxId
        )
        if (reuseTarget) {
            sandboxPreselectedRef.current = true
            setRuntimeMode('existing')
            setPickedRuntimeId(reuseTarget.id)
            setAttachSandboxHostId('')
        }
    }, [initialSandboxId, spriteAttachTargets, reusableRuntimes])

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
        hermesAttach,
        cloneEnabled,
        pickedRuntime,
        runtimeAgents,
        fetchRuntimeAgents
    ])

    useEffect(() => {
        if (!hermesAttach || !cloneEnabled || !pickedRuntime) return
        const rows = runtimeAgents[pickedRuntime.id]
        if (!rows) return
        const preferredProfile =
            rows.find((r) => r.id === 'coder')?.id ??
            rows.find((r) => r.id === 'default')?.id ??
            rows[0]?.id ??
            ''
        setCloneFromProfile((cur) =>
            cur && rows.some((r) => r.id === cur) ? cur : preferredProfile
        )
    }, [hermesAttach, cloneEnabled, pickedRuntime, runtimeAgents])

    const primaryModelOptions = useMemo(
        () =>
            modelConfig.selectedSavedProvider
                ? (providerModelIdsForSummary(
                      modelConfig.selectedSavedProvider,
                      modelProviderForRuntime
                  ) ?? [])
                : [],
        [modelConfig.selectedSavedProvider, modelProviderForRuntime]
    )
    useEffect(() => {
        if (runtimeMode === 'existing' || !isConfigurable) return
        if (primaryModelName.trim()) return
        const first = preferredPrimaryModelDefault(
            primaryModelOptions,
            modelProviderForRuntime
        )
        if (first) setPrimaryModelName(first)
    }, [
        isConfigurable,
        modelProviderForRuntime,
        primaryModelName,
        primaryModelOptions,
        runtimeMode
    ])

    // Configurable frameworks pick a primary model explicitly. We probe the
    // picked saved provider for its model list and auto-fill the first; the
    // model row surfaces probing/failed so the user can fall back to typing a
    // model name without leaving the panel.
    const [modelProbe, setModelProbe] = useState<'idle' | 'probing' | 'failed'>(
        'idle'
    )
    const [modelManual, setModelManual] = useState(false)
    const autoTestedProviderRef = useRef<Set<string>>(new Set())
    const runModelProbe = (providerId: string): void => {
        autoTestedProviderRef.current.add(providerId)
        setModelProbe('probing')
        void client.modelProviders
            .test(providerId)
            .then(() => client.modelProviders.list())
            .then((rows) => {
                if (rows) setProviders(rows)
                setModelProbe('idle')
            })
            .catch(() => setModelProbe('failed'))
    }
    useEffect(() => {
        if (!isConfigurable) return
        if (picker.mode !== 'saved' || !picker.providerId) return
        if (primaryModelOptions.length > 0) {
            setModelProbe('idle')
            return
        }
        const p = providers.find((o) => o.id === picker.providerId)
        if (!p) return
        if (p.lastTestedAt) {
            // Tested but no usable models — treat as failed (manual entry).
            setModelProbe('failed')
            return
        }
        if (autoTestedProviderRef.current.has(p.id)) return
        runModelProbe(p.id)
    }, [isConfigurable, picker, primaryModelOptions, providers])
    const retryModelProbe = (): void => {
        if (picker.mode !== 'saved' || !picker.providerId) return
        autoTestedProviderRef.current.delete(picker.providerId)
        setModelManual(false)
        runModelProbe(picker.providerId)
    }

    const sandboxLimitReached =
        runtimeAccess !== null &&
        runtimeAccess.statefulSandboxUsage >= runtimeAccess.statefulSandboxLimit
    const cloudComputerAvailable = runtimeAccess?.cloudComputerEnabled === true
    const daemonSupported = reuseRuntimeKindsFor(framework).has('daemon')

    // Connected machines that can't run this framework yet — either the daemon
    // is offline, or the framework CLI isn't installed so the backend never
    // created a runtime row for it. They'd otherwise vanish from the reuse
    // list; showing them disabled (with the reason) keeps the machine the user
    // just connected visible and tells them how to unblock it.
    const unavailableDaemons = useMemo<
        Array<{ host: DaemonHostSummary; reason: 'offline' | 'missing' }>
    >(() => {
        if (!daemonSupported) return []
        const covered = new Set(
            reusableRuntimes
                .filter((r) => r.kind === 'daemon' && r.daemonId)
                .map((r) => r.daemonId)
        )
        const out: Array<{
            host: DaemonHostSummary
            reason: 'offline' | 'missing'
        }> = []
        for (const host of daemonHosts) {
            if (covered.has(host.id)) continue
            if (!host.online) {
                out.push({ host, reason: 'offline' })
                continue
            }
            const detected = host.detectedFrameworks.some(
                (d) => d.framework === framework
            )
            if (!detected) out.push({ host, reason: 'missing' })
        }
        return out
    }, [daemonSupported, daemonHosts, reusableRuntimes, framework])
    const anyMissingFramework = unavailableDaemons.some(
        (d) => d.reason === 'missing'
    )

    const [refreshingRuntimes, setRefreshingRuntimes] = useState(false)
    const refreshRuntimes = async (): Promise<void> => {
        if (refreshingRuntimes) return
        setRefreshingRuntimes(true)
        try {
            await refetchRuntimes()
        } finally {
            setRefreshingRuntimes(false)
        }
    }

    const selectFramework = (next: CreateableFramework): void => {
        setFramework(next)
        const nextPersistent: PersistentModelProvider =
            usesConfigurableModelProvider(next)
                ? 'openai'
                : modelProviderForFramework(next) === 'google'
                  ? 'anthropic'
                  : (modelProviderForFramework(next) as PersistentModelProvider)
        setPersistentModelProvider(nextPersistent)
        const nextTarget: UserModelProvider = usesConfigurableModelProvider(
            next
        )
            ? nextPersistent
            : modelProviderForFramework(next)
        const nextPreferred = preferredSavedProviderFor(
            providers,
            nextTarget,
            next
        )
        setPicker(
            nextPreferred
                ? { ...initialPicker(), providerId: nextPreferred.id }
                : initialPicker()
        )
        setPrimaryModelName(
            usesConfigurableModelProvider(next) && nextPreferred
                ? (preferredPrimaryModelDefault(
                      providerModelIdsForSummary(nextPreferred, nextTarget) ??
                          [],
                      nextTarget
                  ) ?? '')
                : ''
        )
        setPickedRuntimeId('')
        setAttachSandboxHostId('')
        setExternalProviderId('')
        setExternalRemoteId('')
        setCloneEnabled(false)
        setCloneFromProfile('')
        setModelManual(false)
        setModelProbe('idle')
        setRuntimeMode('sandbox')
        setWorkspace(defaultWorkspaceFor(next, 'sandbox'))
    }

    const randomizeName = (): void => setName(randomAgentName())

    // Deep link from Settings → Self-owned computers ("+ Create agent →").
    // Preselect the daemon's runtime, switching the framework to match what
    // that machine actually has when it differs from the default.
    const daemonPreselectedRef = useRef(false)
    useEffect(() => {
        if (daemonPreselectedRef.current) return
        if (!initialDaemonId || runtimes.length === 0) return
        daemonPreselectedRef.current = true
        const onDaemon = runtimes.filter((r) => r.daemonId === initialDaemonId)
        if (onDaemon.length === 0) return
        const pick =
            onDaemon.find((r) => r.framework === framework) ?? onDaemon[0]
        if (
            pick.framework !== framework &&
            localizedFrameworkOptions.some((o) => o.value === pick.framework)
        )
            selectFramework(pick.framework as CreateableFramework)
        setRuntimeMode('existing')
        setPickedRuntimeId(pick.id)
        setAttachSandboxHostId('')
    }, [initialDaemonId, runtimes, framework])

    const nameValidation = validateAgentName(name)
    const normalizedName = nameValidation.valid
        ? nameValidation.value
        : normalizeAgentName(name)
    const nameError = nameValidation.valid
        ? null
        : t(NAME_ERROR_KEY[nameValidation.code], {
              max: inputValidation.AGENT_NAME.MAX
          })
    const nameSuggestion = nameValidation.valid ? null : suggestAgentName(name)

    const workspaceInputEnabled =
        !isExternal &&
        runtimeMode !== 'daemon' &&
        framework !== 'hermes' &&
        (runtimeMode !== 'existing' ||
            (pickedRuntime !== null && pickedRuntime.framework !== 'hermes'))
    const existingRuntimeDefaultWorkspace = (
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
    const workspaceDefault =
        runtimeMode === 'existing' && pickedRuntime
            ? existingRuntimeDefaultWorkspace(pickedRuntime)
            : defaultWorkspaceFor(
                  framework,
                  runtimeMode === 'persistent' ? 'persistent' : 'sandbox'
              )
    const workspaceDefaultRef = useRef(workspaceDefault)
    useEffect(() => {
        const prev = workspaceDefaultRef.current
        if (prev === workspaceDefault) return
        workspaceDefaultRef.current = workspaceDefault
        setWorkspace((cur) => (cur.trim() === prev ? workspaceDefault : cur))
    }, [workspaceDefault])
    const workspaceTrimmed = workspaceInputEnabled ? workspace.trim() : ''
    const workspaceError = workspaceValidationMessage(workspaceTrimmed)
    const workspaceForRequest =
        workspaceTrimmed &&
        workspaceTrimmed !== workspaceDefault &&
        !workspaceError
            ? workspaceTrimmed
            : undefined

    const managedAvailable = credit.managedAvailable
    const balance = credit.balance
    const creditGrant = credit.creditGrant
    // Creation only needs the managed provider key provisioned (creditPhase
    // 'ready' ⇒ account.status 'ready'); the $2 signup grant is async and
    // only gates chat spending, never creation. An empty balance must not
    // block creating an agent.
    const creditReadyManaged = managedAvailable && credit.phase === 'ready'
    const creditPending =
        managedAvailable &&
        (credit.phase === 'loading' || credit.phase === 'pending')
    const managedBalanceEmpty =
        managedAvailable && credit.phase === 'ready' && (balance ?? 0) <= 0

    const providerComplete = isExternal
        ? externalProviderId.trim().length > 0 &&
          (framework !== 'langflow' || externalRemoteId.trim().length > 0)
        : runtimeMode === 'existing'
          ? pickedRuntime !== null
          : framework === 'narranexus'
            ? true
            : isConfigurable
              ? pickerIsValid(picker) &&
                (framework === 'hermes' || primaryModelName.trim().length > 0)
              : pickerIsValid(picker)
    const pickedRuntimeOffline =
        pickedRuntime?.kind === 'daemon' && !pickedRuntime.daemonOnline
    const runtimeComplete = isExternal
        ? true
        : runtimeMode === 'existing'
          ? pickedRuntime !== null && !pickedRuntimeOffline
          : runtimeMode === 'sandbox'
    const selectedProvider =
        picker.mode === 'saved' && picker.providerId
            ? (providers.find((p) => p.id === picker.providerId) ?? null)
            : null
    const selectedIsManaged = selectedProvider?.source === 'managed'
    const creditSettledSimple =
        picker.mode === 'inline'
            ? pickerIsValid(picker)
            : selectedProvider
              ? selectedIsManaged
                  ? creditReadyManaged
                  : true
              : managedAvailable
                ? creditReadyManaged
                : pickerIsValid(picker)

    const canSubmit = (() => {
        if (busy || streamOpen) return false
        if (!nameValidation.valid) return false
        if (workspaceError) return false
        if (!advanced) {
            if (isExternal) return providerComplete
            if (sandboxLimitReached) return false
            if (framework === 'narranexus') return true
            if (
                framework === 'openclaw' &&
                primaryModelName.trim().length === 0
            )
                return false
            return pickerIsValid(picker) && creditSettledSimple
        }
        if (!providerComplete) return false
        if (!runtimeComplete) return false
        if (
            runtimeMode === 'sandbox' &&
            !attachSandboxHostId &&
            sandboxLimitReached
        )
            return false
        if (runtimeMode === 'persistent') return false
        if (modelConfig.required && !modelConfig.validation.valid) return false
        if (hermesAttach && cloneEnabled) {
            if (runtimeAgentsLoading || runtimeAgentsError) return false
            if (cloneFromProfile.trim().length === 0) return false
        }
        return true
    })()

    const goAdvanced = (): void => {
        setMode('advanced')
        const q = new URLSearchParams(params)
        q.set('framework', framework)
        q.set('advanced', '1')
        navigate(`/agents/new?${q.toString()}`, { replace: true })
    }

    const backToSimple = (): void => {
        setMode('simple')
        const q = new URLSearchParams(params)
        q.delete('advanced')
        const query = q.toString()
        navigate(`/agents/new${query ? `?${query}` : ''}`, { replace: true })
    }

    const cancel = (): void => {
        if (agents.length > 0) navigate(`/agents/${agents[0].id}/chat`)
        else navigate('/')
    }

    const handleDaemonConnected = async (
        host: DaemonHostSummary
    ): Promise<void> => {
        const rows = await client.agentRuntimes.list().catch(() => null)
        if (rows) {
            setRuntimes(rows)
            const rt =
                rows.find(
                    (r) =>
                        r.kind === 'daemon' &&
                        r.daemonId === host.id &&
                        r.framework === framework
                ) ??
                rows.find((r) => r.kind === 'daemon' && r.daemonId === host.id)
            if (rt) {
                setRuntimeMode('existing')
                setPickedRuntimeId(rt.id)
            }
        }
        setConnectDaemonOpen(false)
    }

    const handleExternalProviderCreated = async (
        row: UserExternalAgentProviderSummary
    ): Promise<void> => {
        await loadExternalProviders(framework as 'dify' | 'langflow' | 'a2a')
        setExternalProviderId(row.id)
        setExternalProviderDialogOpen(false)
    }

    const submit = async (): Promise<void> => {
        if (!canSubmit) return
        setError(null)

        if (runtimeMode === 'existing' && pickedRuntime) {
            const created = await submitAddToRuntime({
                runtimeId: pickedRuntime.id,
                body: buildAddRuntimeAgentBody({
                    name: normalizedName,
                    workspace: workspaceForRequest,
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
        const steps = isExternal
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
                          workspace: workspaceForRequest
                      })
        if (!isExternal && attachSandboxHostId)
            body.sandboxId = attachSandboxHostId
        // Version comes from the sandbox detail page's framework row; v3 has no
        // version picker of its own, so honour the deep link rather than drop it.
        if (!isExternal && /^v?\d+\.\d+\.\d+$/.test(initialVersion))
            body.frameworkVersion = initialVersion
        const created = await submitCreateStream({ body, steps })
        if (created) {
            await refreshAgents()
            navigate(`/agents/${created.id}/chat`)
        }
    }

    const frameworkSelectOptions = localizedFrameworkOptions.map((opt) => ({
        value: opt.value,
        label: (
            <span className='flex min-w-0 items-center gap-2'>
                <FrameworkLogo
                    framework={opt.value}
                    size={18}
                    className='shrink-0'
                />
                <span className='truncate'>{opt.label}</span>
            </span>
        )
    }))
    const capabilities = FRAMEWORK_CAPABILITIES[framework] ?? []
    const isFirstAgent = agents.length === 0

    const managedRightLabel = ((): ManagedRightLabel | undefined => {
        if (!managedAvailable) return undefined
        if (isFirstAgent && creditGrant && creditGrant.status !== 'error') {
            const amount = fmtCost(creditGrant.amount)
            return creditGrant.status === 'pending'
                ? {
                      text: t('web.agentNewV3.creditGiftPending', { amount }),
                      tone: 'muted'
                  }
                : {
                      text: t('web.agentNewV3.creditGift', { amount }),
                      tone: 'success'
                  }
        }
        if (credit.phase === 'ready')
            return {
                text: t('web.agentNewV3.creditBalance', {
                    amount: fmtCost(balance ?? 0)
                }),
                tone: 'success'
            }
        return undefined
    })()

    const selectableProviders = useMemo(
        () =>
            providers
                .filter((o) =>
                    providerSupportsTarget(o, modelProviderForRuntime)
                )
                // Managed channels an admin switched off stay usable for agents
                // already bound to them, but must not be picked for new ones.
                .filter((o) => !o.channelDisabled)
                .filter((o) => {
                    const protocol = providerProtocolForTarget(
                        o,
                        modelProviderForRuntime
                    )
                    if (!protocol) return true
                    return frameworkSupportsProtocol(framework, protocol)
                })
                .filter((o) => {
                    if (!o.inferenceProtocol) return true
                    return isManagedProtocolAllowedForFramework(
                        framework,
                        o.source,
                        o.inferenceProtocol
                    )
                })
                .sort((a, b) => {
                    const delta =
                        (a.source === 'managed' ? 0 : 1) -
                        (b.source === 'managed' ? 0 : 1)
                    if (delta !== 0) return delta
                    return a.providerName.localeCompare(b.providerName)
                }),
        [providers, modelProviderForRuntime, framework]
    )

    // Quick mode offers platform credits as a single choice, so it collapses the
    // family's managed channels down to the preferred one; advanced mode keeps
    // every channel and names them instead.
    const pickerProviders = useMemo(
        () =>
            advanced
                ? selectableProviders
                : collapseManagedChannels(
                      selectableProviders,
                      picker.mode === 'saved' ? picker.providerId : undefined
                  ),
        [advanced, selectableProviders, picker.mode, picker.providerId]
    )

    const showManagedChannel =
        pickerProviders.filter((o) => o.source === 'managed').length > 1

    const inlineConfigured =
        picker.mode === 'inline' && picker.apiKey.length > 0

    const managedUnavailableForFamily =
        isConfigurable &&
        managedAvailable &&
        !selectableProviders.some((o) => o.source === 'managed')

    const providerSelectValue =
        picker.mode === 'inline'
            ? inlineConfigured
                ? PROVIDER_INLINE_OPTION
                : ''
            : (picker.providerId ?? '')

    const providerOptions: WorkbenchSelectOption[] = [
        ...pickerProviders.map((o) => ({
            value: o.id,
            label: providerOptionLabel(
                o,
                o.source === 'managed' ? managedRightLabel : undefined,
                showManagedChannel,
                t('web.agentNewV3.managedProvider')
            )
        })),
        ...(inlineConfigured
            ? [
                  {
                      value: PROVIDER_INLINE_OPTION,
                      label: (
                          <span className='flex min-w-0 items-center gap-2'>
                              <ProviderIcon className='text-fg h-[18px] w-[18px] shrink-0' />
                              <span className='truncate'>
                                  {picker.saveLabel ||
                                      t('web.agentNewV3.useOwnKey')}
                              </span>
                          </span>
                      )
                  }
              ]
            : []),
        {
            value: PROVIDER_NEW_KEY_OPTION,
            label: (
                <span className='text-link flex min-w-0 items-center gap-2'>
                    <PlusIcon className='h-[18px] w-[18px] shrink-0' />
                    <span className='truncate'>
                        {t('web.agentNewV3.useNewKey')}
                    </span>
                </span>
            )
        }
    ]

    const openKeyDialog = (): void => {
        setKeyDraft(
            picker.mode === 'inline'
                ? picker
                : { ...initialPicker(), mode: 'inline', save: true }
        )
        setKeyError(null)
        setKeyDialogOpen(true)
    }

    const selectProvider = (v: string): void => {
        if (v === PROVIDER_NEW_KEY_OPTION || v === PROVIDER_INLINE_OPTION) {
            openKeyDialog()
            return
        }
        setPicker((cur) => ({
            ...cur,
            mode: 'saved',
            providerId: v,
            apiKey: '',
            baseUrl: ''
        }))
        modelConfig.setDraft(null)
    }

    const confirmKeyDialog = async (): Promise<void> => {
        if (!pickerIsValid(keyDraft) || keyChecking) return
        setKeyChecking(true)
        setKeyError(null)
        try {
            const result = await client.modelProviders.testInline({
                inferenceProtocol: defaultProtocolForProvider(
                    modelProviderForRuntime
                ),
                apiKey: keyDraft.apiKey.trim(),
                baseUrl:
                    keyDraft.baseUrl.trim() ||
                    OFFICIAL_PROVIDER_BASE_URL[modelProviderForRuntime]
            })
            if (!result.ok) {
                const m = (result.message ?? '').toLowerCase()
                setKeyError(
                    /url|host|connect|resolve|enotfound|econnrefused|dns/.test(
                        m
                    )
                        ? t('web.agentNewV3.keyCheckBaseUrl')
                        : /tim(e|ed)?\s?out|timeout/.test(m)
                          ? t('web.agentNewV3.keyCheckTimeout')
                          : t('web.agentNewV3.keyRejected')
                )
                return
            }
            setPicker({
                ...keyDraft,
                mode: 'inline',
                providerId: '',
                save: true
            })
            modelConfig.setDraft(null)
            setKeyDialogOpen(false)
        } catch {
            setKeyError(t('web.agentNewV3.keyCheckFailed'))
        } finally {
            setKeyChecking(false)
        }
    }

    const summaryLine = [
        isExternal
            ? t('web.agentNew.runtimeShortExisting')
            : runtimeMode === 'existing'
              ? (pickedRuntime?.name ?? t('web.agentNew.runtime'))
              : t('web.agentNewV3.summarySandbox'),
        t('web.agentNewV3.summaryDefaultModel'),
        isExternal || !managedAvailable
            ? t('web.agentNewV3.summaryOwnKey')
            : t('web.agentNewV3.summaryPlatformCredits')
    ].join(' · ')

    const renderRuntimeSection = (): ReactNode => {
        const hasReuse =
            reusableRuntimes.length > 0 ||
            spriteAttachTargets.length > 0 ||
            spriteBlockedTargets.length > 0 ||
            unavailableDaemons.length > 0
        return (
            <section>
                <div className='space-y-2'>
                    {supportsSandbox(framework) && sandboxLimitReached && (
                        <div
                            role='alert'
                            className='bg-warning-bg text-warning text-caption flex flex-wrap items-center justify-between gap-2 rounded-sm px-3 py-2'
                        >
                            <span>
                                {t('web.agentNewV3.runtimeQuotaReached')}
                            </span>
                            <Link
                                to='/settings/runtimes'
                                className='font-medium underline underline-offset-2'
                            >
                                {t('web.agentNewV3.runtimeManageSandboxes')}
                            </Link>
                        </div>
                    )}
                    {hasReuse && (
                        <span className='workbench-group-label'>
                            {t('web.agentNewV3.runtimeCreateNewLabel')}
                        </span>
                    )}
                    {supportsSandbox(framework) && (
                        <button
                            type='button'
                            disabled={sandboxLimitReached}
                            onClick={() => {
                                setRuntimeMode('sandbox')
                                setAttachSandboxHostId('')
                                setPickedRuntimeId('')
                                setCloneEnabled(false)
                            }}
                            className={rowClass(
                                runtimeMode === 'sandbox' &&
                                    !attachSandboxHostId,
                                sandboxLimitReached
                            )}
                        >
                            <span className='flex items-center justify-between gap-2'>
                                <span className='text-fg text-ui font-medium'>
                                    {t('web.agentNewV3.runtimeNewSandbox')}
                                </span>
                                {sandboxLimitReached ? (
                                    <span className='text-muted text-caption'>
                                        {t(
                                            'web.agentNewV3.runtimeQuotaFullTag'
                                        )}
                                    </span>
                                ) : (
                                    runtimeMode === 'sandbox' &&
                                    !attachSandboxHostId && (
                                        <CheckIcon className='text-link h-4 w-4 shrink-0' />
                                    )
                                )}
                            </span>
                            <span className='text-muted text-caption mt-0.5 block'>
                                {t('web.agentNew.sandboxDesc')}
                            </span>
                        </button>
                    )}
                    {daemonSupported && (
                        <button
                            type='button'
                            onClick={() => setConnectDaemonOpen(true)}
                            className='text-muted hover:text-fg hover:bg-surface-hover border-divider flex w-full items-center gap-2 rounded-md border border-dashed px-3.5 py-3 text-left transition-colors'
                        >
                            <PlusIcon className='h-4 w-4 shrink-0' />
                            <span className='text-ui'>
                                {t('web.connectDaemon.titleRegister')}
                            </span>
                        </button>
                    )}
                    {cloudComputerAvailable && BILLING_SURFACE && (
                        <Link
                            to='/settings/plan-and-billing/buy-container'
                            className='text-muted hover:text-fg hover:bg-surface-hover border-divider flex w-full items-center gap-2 rounded-md border border-dashed px-3.5 py-3 text-left transition-colors'
                        >
                            <PlusIcon className='h-4 w-4 shrink-0' />
                            <span className='text-ui'>
                                {t('web.agentNew.persistentRent')}
                            </span>
                        </Link>
                    )}
                    {hasReuse && (
                        <>
                            <div className='flex items-center justify-between pt-1'>
                                <span className='workbench-group-label'>
                                    {t('web.agentNewV3.runtimeReuseLabel')}
                                </span>
                                <button
                                    type='button'
                                    onClick={() => void refreshRuntimes()}
                                    disabled={refreshingRuntimes}
                                    aria-label={t(
                                        'web.agentNewV3.runtimeRefresh'
                                    )}
                                    className='text-subtle hover:text-fg text-caption inline-flex items-center gap-1 transition-colors disabled:opacity-50'
                                >
                                    <RefreshIcon
                                        className={[
                                            'h-3.5 w-3.5',
                                            refreshingRuntimes && 'loading-spin'
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                    />
                                    {t('web.agentNewV3.runtimeRefresh')}
                                </button>
                            </div>
                            {reusableRuntimes.map((r: AgentRuntimeSummary) => {
                                const offline =
                                    r.kind === 'daemon' && !r.daemonOnline
                                const occ =
                                    r.kind === 'sprites' && r.hostId
                                        ? hostOccupancy.get(r.hostId)
                                        : undefined
                                return (
                                    <ShortcutTooltip
                                        key={r.id}
                                        className='w-full'
                                        placement='top'
                                        label={
                                            offline
                                                ? t(
                                                      'web.agentNewV3.runtimeOfflineHint'
                                                  )
                                                : undefined
                                        }
                                    >
                                        <button
                                            type='button'
                                            disabled={offline}
                                            onClick={() => {
                                                if (offline) return
                                                setRuntimeMode('existing')
                                                setPickedRuntimeId(r.id)
                                                setAttachSandboxHostId('')
                                                setCloneEnabled(false)
                                            }}
                                            className={rowClass(
                                                runtimeMode === 'existing' &&
                                                    pickedRuntimeId === r.id,
                                                offline
                                            )}
                                        >
                                            <span className='flex items-center justify-between gap-2'>
                                                <span className='flex min-w-0 items-center gap-2'>
                                                    <span className='tag tag-neutral'>
                                                        {r.kind === 'k8s'
                                                            ? t(
                                                                  'web.agentNew.persistent'
                                                              )
                                                            : r.kind ===
                                                                'daemon'
                                                              ? t(
                                                                    'web.agentNew.localDaemon'
                                                                )
                                                              : t(
                                                                    'web.agentNew.sandbox'
                                                                )}
                                                    </span>
                                                    <span className='text-fg text-ui min-w-0 truncate font-medium'>
                                                        {reuseDisplayName(r)}
                                                    </span>
                                                </span>
                                                {offline ? (
                                                    <span className='text-muted text-caption inline-flex shrink-0 items-center gap-1'>
                                                        <PlugIcon className='h-3.5 w-3.5' />
                                                        {t(
                                                            'web.agentNewV3.runtimeOfflineTag'
                                                        )}
                                                    </span>
                                                ) : (
                                                    <span className='flex shrink-0 items-center gap-3'>
                                                        <span className='text-subtle text-caption inline-flex items-center gap-1.5'>
                                                            <span className='bg-success h-1.5 w-1.5 rounded-full' />
                                                            {t(
                                                                'web.agentNewV3.runtimeReadyTag'
                                                            )}
                                                        </span>
                                                        {occ && (
                                                            <SandboxSlots
                                                                frameworks={
                                                                    occ.frameworks
                                                                }
                                                                frameworkLabelFor={
                                                                    frameworkLabel
                                                                }
                                                            />
                                                        )}
                                                        {runtimeMode ===
                                                            'existing' &&
                                                            pickedRuntimeId ===
                                                                r.id && (
                                                                <CheckIcon className='text-link h-4 w-4 shrink-0' />
                                                            )}
                                                    </span>
                                                )}
                                            </span>
                                        </button>
                                    </ShortcutTooltip>
                                )
                            })}
                            {spriteAttachTargets.map((target) => (
                                <button
                                    key={target.hostId}
                                    type='button'
                                    onClick={() => {
                                        setRuntimeMode('sandbox')
                                        setAttachSandboxHostId(target.hostId)
                                        setPickedRuntimeId('')
                                        setCloneEnabled(false)
                                    }}
                                    className={rowClass(
                                        runtimeMode === 'sandbox' &&
                                            attachSandboxHostId ===
                                                target.hostId
                                    )}
                                >
                                    <span className='flex items-center justify-between gap-2'>
                                        <span className='flex min-w-0 items-center gap-2'>
                                            <span className='tag tag-neutral'>
                                                {t('web.agentNew.sandbox')}
                                            </span>
                                            <span className='text-fg text-ui min-w-0 truncate font-medium'>
                                                {target.name ??
                                                    target.spriteName ??
                                                    target.hostId}
                                            </span>
                                        </span>
                                        <span className='flex shrink-0 items-center gap-3'>
                                            <span className='text-subtle text-caption inline-flex items-center gap-1'>
                                                <PlusIcon className='h-3.5 w-3.5' />
                                                {t(
                                                    'web.agentNewV3.runtimeInstallHint',
                                                    {
                                                        framework:
                                                            frameworkLabel(
                                                                framework
                                                            )
                                                    }
                                                )}
                                            </span>
                                            <SandboxSlots
                                                frameworks={target.frameworks}
                                                frameworkLabelFor={
                                                    frameworkLabel
                                                }
                                            />
                                            {runtimeMode === 'sandbox' &&
                                                attachSandboxHostId ===
                                                    target.hostId && (
                                                    <CheckIcon className='text-link h-4 w-4 shrink-0' />
                                                )}
                                        </span>
                                    </span>
                                </button>
                            ))}
                            {spriteBlockedTargets.map((target) => (
                                <div
                                    key={target.hostId}
                                    className={rowClass(false, true)}
                                >
                                    <span className='flex items-center justify-between gap-2'>
                                        <span className='flex min-w-0 items-center gap-2'>
                                            <span className='tag tag-neutral'>
                                                {t('web.agentNew.sandbox')}
                                            </span>
                                            <span className='text-fg text-ui min-w-0 truncate font-medium'>
                                                {target.name ??
                                                    target.spriteName ??
                                                    target.hostId}
                                            </span>
                                        </span>
                                        <span className='flex shrink-0 items-center gap-3'>
                                            <span className='text-muted text-caption'>
                                                {t(
                                                    'web.agentNewV3.runtimeServiceSlotTaken',
                                                    {
                                                        framework:
                                                            frameworkLabel(
                                                                target.blockedBy
                                                            )
                                                    }
                                                )}
                                            </span>
                                            <SandboxSlots
                                                frameworks={target.frameworks}
                                                frameworkLabelFor={
                                                    frameworkLabel
                                                }
                                            />
                                        </span>
                                    </span>
                                </div>
                            ))}
                            {unavailableDaemons.map(({ host, reason }) => (
                                <div
                                    key={host.id}
                                    className={rowClass(false, true)}
                                >
                                    <span className='flex items-center justify-between gap-2'>
                                        <span className='flex min-w-0 items-center gap-2'>
                                            <span className='tag tag-neutral'>
                                                {t('web.agentNew.localDaemon')}
                                            </span>
                                            <span className='text-fg text-ui min-w-0 truncate font-medium'>
                                                {host.name}
                                            </span>
                                        </span>
                                        <span className='text-caption inline-flex shrink-0 items-center gap-1'>
                                            {reason === 'offline' ? (
                                                <>
                                                    <PlugIcon className='h-3.5 w-3.5' />
                                                    {t(
                                                        'web.agentNewV3.runtimeOfflineTag'
                                                    )}
                                                </>
                                            ) : (
                                                <>
                                                    <InfoIcon className='h-3.5 w-3.5' />
                                                    {t(
                                                        'web.agentNewV3.runtimeMissingTag',
                                                        {
                                                            framework:
                                                                frameworkLabel(
                                                                    framework
                                                                )
                                                        }
                                                    )}
                                                </>
                                            )}
                                        </span>
                                    </span>
                                </div>
                            ))}
                            {anyMissingFramework && (
                                <p className='text-subtle text-caption px-1'>
                                    {t('web.agentNewV3.runtimeMissingHint', {
                                        framework: frameworkLabel(framework)
                                    })}
                                </p>
                            )}
                        </>
                    )}
                    {hermesAttach && (
                        <div className='bg-surface shadow-ring-light rounded-md px-3.5 py-3'>
                            <label className='flex items-center gap-2'>
                                <input
                                    type='checkbox'
                                    checked={cloneEnabled}
                                    onChange={(e) => {
                                        setCloneEnabled(e.target.checked)
                                        if (!e.target.checked)
                                            setCloneFromProfile('')
                                    }}
                                />
                                <span className='text-ui text-fg'>
                                    {t('web.agentNew.cloneProfile')}
                                </span>
                            </label>
                            {cloneEnabled && (
                                <div className='mt-2'>
                                    {runtimeAgentsLoading ? (
                                        <p className='text-muted text-caption inline-flex items-center gap-1.5'>
                                            <Spinner size={12} />
                                            {t('web.agentNew.loadingProfiles')}
                                        </p>
                                    ) : runtimeAgentsError ? (
                                        <p className='text-error text-caption'>
                                            {runtimeAgentsError}
                                        </p>
                                    ) : pickedRuntimeAgents.length === 0 ? (
                                        <p className='text-muted text-caption'>
                                            {t(
                                                'web.agentNew.noProfilesToClone'
                                            )}
                                        </p>
                                    ) : (
                                        <WorkbenchSelect
                                            mono
                                            ariaLabel={t(
                                                'web.agentNew.cloneProfile'
                                            )}
                                            value={cloneFromProfile}
                                            onChange={setCloneFromProfile}
                                            options={pickedRuntimeAgents.map(
                                                (a) => ({
                                                    value: a.id,
                                                    label: a.id
                                                })
                                            )}
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    <p className='text-subtle text-caption inline-flex items-center gap-1 pt-1'>
                        <InfoIcon className='h-3.5 w-3.5' />
                        {t('web.agentNewV3.runtimeIrreversible')}
                    </p>
                </div>
            </section>
        )
    }

    const renderExternalSection = (): ReactNode => (
        <section>
            <span className='workbench-field-label mb-1.5 block'>
                {t('web.agentNewV3.providerModelLabel')}
            </span>
            {externalProvidersError && (
                <p className='text-error text-caption mb-2'>
                    {externalProvidersError}
                </p>
            )}
            {externalProviders.length === 0 ? (
                <div className='border-divider rounded-md border border-dashed px-3.5 py-3'>
                    <p className='text-muted text-caption mb-1'>
                        {t('web.agentNew.noExternalProviders')}
                    </p>
                    <button
                        type='button'
                        onClick={() => setExternalProviderDialogOpen(true)}
                        className='text-link hover:text-fg text-caption font-medium'
                    >
                        {t('web.agentNew.createOneLink')}
                    </button>
                </div>
            ) : (
                <>
                    <WorkbenchSelect
                        ariaLabel={t('web.agentNewV3.providerModelLabel')}
                        value={externalProviderId}
                        onChange={setExternalProviderId}
                        options={externalProviders.map((p) => ({
                            value: p.id,
                            label: `${p.label} · ${p.endpointUrl}`
                        }))}
                    />
                    <button
                        type='button'
                        onClick={() => setExternalProviderDialogOpen(true)}
                        className='text-link hover:text-fg text-caption mt-2 inline-flex items-center gap-1 font-medium'
                    >
                        <PlusIcon className='h-3.5 w-3.5' />
                        {t('web.externalProviderDialog.addAnother')}
                    </button>
                </>
            )}
            {framework === 'langflow' && (
                <label className='mt-3 block'>
                    <span className='workbench-field-label mb-1.5 block'>
                        {remoteIdLabelFor(framework, t)}
                    </span>
                    <input
                        value={externalRemoteId}
                        onChange={(e) => setExternalRemoteId(e.target.value)}
                        placeholder={remoteIdPlaceholderFor(framework, t)}
                        className='workbench-input font-mono'
                    />
                    <p className='text-subtle text-caption mt-1'>
                        {remoteIdHintFor(framework, t)}
                    </p>
                </label>
            )}
        </section>
    )

    const renderProviderModelSection = (): ReactNode => (
        <section>
            {isConfigurable && (
                <div className='mb-4'>
                    <span className='workbench-field-label mb-1.5 block'>
                        {t('web.agentNewV3.modelFamilyLabel')}
                    </span>
                    <div className='grid grid-cols-2 gap-2'>
                        {persistentProviderOptions.map((opt) => (
                            <button
                                key={opt.value}
                                type='button'
                                onClick={() => {
                                    setPersistentModelProvider(opt.value)
                                    setPicker(initialPicker())
                                    setPrimaryModelName('')
                                    modelConfig.setDraft(null)
                                }}
                                className={rowClass(
                                    persistentModelProvider === opt.value
                                )}
                            >
                                <span className='text-fg text-ui font-medium'>
                                    {opt.label}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <span className='workbench-field-label mb-1.5 block'>
                {t('web.agentNewV3.creditLabel')}
            </span>
            <WorkbenchSelect
                ariaLabel={t('web.agentNewV3.creditLabel')}
                menuClassName='min-w-64'
                value={providerSelectValue}
                onChange={selectProvider}
                options={providerOptions}
            />
            {isConfigurable &&
                (managedUnavailableForFamily &&
                persistentModelProvider !== 'anthropic' ? (
                    <p className='text-subtle text-caption mt-1.5 inline-flex items-center gap-1'>
                        <InfoIcon className='h-3.5 w-3.5 shrink-0' />
                        <span>
                            {t('web.agentNewV3.providerManagedUnavailable', {
                                family: modelFamilyName[persistentModelProvider]
                            })}
                            {' · '}
                            <button
                                type='button'
                                onClick={openKeyDialog}
                                className='text-link hover:text-fg font-medium'
                            >
                                {t('web.agentNewV3.useNewKey')}
                            </button>
                        </span>
                    </p>
                ) : (
                    <p className='text-subtle text-caption mt-1.5'>
                        {t('web.agentNewV3.providerCompatHint', {
                            family: modelFamilyName[persistentModelProvider]
                        })}
                    </p>
                ))}
            {modelConfig.required && (
                <div className='mt-3'>
                    <CreateFrameworkModelConfig
                        view={modelConfig.view}
                        draft={modelConfig.draft}
                        validationMessage={modelConfig.validation.message}
                        onChange={modelConfig.setDraft}
                        onTestProvider={() => void modelConfig.runTest()}
                        providerTestLabel={modelConfig.providerTestLabel}
                        providerTesting={modelConfig.testing}
                        providerTestDisabled={modelConfig.providerTestDisabled}
                        providerTestError={modelConfig.testError}
                    />
                </div>
            )}
            {isConfigurable && (
                <div className='mt-3'>
                    <span className='workbench-field-label mb-1.5 block'>
                        {t('web.agentNew.primaryModel')}
                    </span>
                    {modelProbe === 'probing' ? (
                        <span className='text-muted text-caption inline-flex items-center gap-1.5'>
                            <Spinner size={12} />
                            {t('web.agentNewV3.modelProbing')}
                        </span>
                    ) : primaryModelOptions.length > 0 && !modelManual ? (
                        <WorkbenchSelect
                            mono
                            ariaLabel={t('web.agentNew.primaryModel')}
                            menuClassName='min-w-64'
                            value={primaryModelName}
                            onChange={setPrimaryModelName}
                            options={primaryModelOptions.map((m) => ({
                                value: m,
                                label: m
                            }))}
                        />
                    ) : (
                        <input
                            value={primaryModelName}
                            onChange={(e) => {
                                setModelManual(true)
                                setPrimaryModelName(e.target.value)
                            }}
                            placeholder={t(
                                'web.agentNew.primaryModelPlaceholder'
                            )}
                            className='workbench-input font-mono'
                            maxLength={255}
                        />
                    )}
                    {modelProbe === 'failed' && !modelManual && (
                        <p className='text-subtle text-caption mt-1.5'>
                            {t('web.agentNewV3.modelManualHint')}
                            {' · '}
                            <button
                                type='button'
                                onClick={retryModelProbe}
                                className='text-link hover:text-fg inline-flex items-center gap-1 font-medium'
                            >
                                <RefreshIcon className='h-3 w-3' />
                                {t('web.agentNewV3.creditRetry')}
                            </button>
                        </p>
                    )}
                </div>
            )}
        </section>
    )

    const nameSuggestionNode = nameSuggestion ? (
        <button
            type='button'
            onClick={() => setName(nameSuggestion)}
            className='text-link hover:text-fg text-caption mt-1 block font-medium'
        >
            {t('web.agentNewV3.nameFixTo', { name: nameSuggestion })}
        </button>
    ) : null

    const renderQuickDefaults = (): ReactNode => (
        <section className='bg-surface-subtle divide-divider divide-y rounded-md px-3.5'>
            <div className='py-2.5'>
                <div className='flex items-center gap-3'>
                    <span className='text-subtle text-caption w-28 shrink-0'>
                        {t('web.agentNewV3.nameLabel')}
                    </span>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        aria-label={t('web.agentNewV3.nameLabel')}
                        aria-invalid={nameError !== null}
                        className='text-fg text-caption focus-visible:shadow-focus rounded-xs -my-0.5 min-w-0 flex-1 bg-transparent py-0.5 font-mono transition-shadow focus:outline-none'
                        maxLength={64}
                    />
                    <button
                        type='button'
                        onClick={randomizeName}
                        aria-label={t('web.agentNewV3.randomize')}
                        className='text-muted hover:text-fg shrink-0 transition-colors'
                    >
                        <RefreshIcon className='h-4 w-4' />
                    </button>
                </div>
                {nameError && (
                    <div className='flex gap-3'>
                        <span className='w-28 shrink-0' />
                        <div className='mt-1 min-w-0'>
                            <p className='text-error text-caption'>
                                {nameError}
                            </p>
                            {nameSuggestionNode}
                        </div>
                    </div>
                )}
            </div>
            {workspaceInputEnabled && (
                <div className='py-2.5'>
                    <div className='flex items-center gap-3'>
                        <span className='text-subtle text-caption w-28 shrink-0'>
                            {t('web.agentNewV3.workspaceLabel')}
                        </span>
                        <WorkspacePathField
                            variant='inline'
                            value={workspace}
                            onChange={setWorkspace}
                            ariaLabel={t('web.agentNewV3.workspaceLabel')}
                        />
                    </div>
                    {workspaceError && (
                        <div className='flex gap-3'>
                            <span className='w-28 shrink-0' />
                            <p className='text-error text-caption mt-1'>
                                {workspaceError}
                            </p>
                        </div>
                    )}
                </div>
            )}
            {framework !== 'narranexus' && (
                <div className='flex items-center gap-3 py-2.5'>
                    <span className='text-subtle text-caption w-28 shrink-0'>
                        {t('web.agentNewV3.creditLabel')}
                    </span>
                    <WorkbenchSelect
                        bare
                        className='min-w-0 flex-1'
                        ariaLabel={t('web.agentNewV3.creditLabel')}
                        menuClassName='min-w-64'
                        value={providerSelectValue}
                        onChange={selectProvider}
                        options={providerOptions}
                    />
                </div>
            )}
            {framework === 'openclaw' && (
                <div className='py-2.5'>
                    <div className='flex items-center gap-3'>
                        <span className='text-subtle text-caption w-28 shrink-0'>
                            {t('web.agentNewV3.modelLabel')}
                        </span>
                        {modelProbe === 'probing' ? (
                            <span className='text-muted text-caption inline-flex flex-1 items-center gap-1.5'>
                                <Spinner size={12} />
                                {t('web.agentNewV3.modelProbing')}
                            </span>
                        ) : primaryModelOptions.length > 0 && !modelManual ? (
                            <WorkbenchSelect
                                bare
                                mono
                                className='min-w-0 flex-1'
                                ariaLabel={t('web.agentNewV3.modelLabel')}
                                menuClassName='min-w-64'
                                value={primaryModelName}
                                onChange={setPrimaryModelName}
                                options={primaryModelOptions.map((m) => ({
                                    value: m,
                                    label: m
                                }))}
                            />
                        ) : (
                            <input
                                value={primaryModelName}
                                onChange={(e) => {
                                    setModelManual(true)
                                    setPrimaryModelName(e.target.value)
                                }}
                                placeholder={t(
                                    'web.agentNew.primaryModelPlaceholder'
                                )}
                                aria-label={t('web.agentNewV3.modelLabel')}
                                className='text-fg text-caption focus-visible:shadow-focus rounded-xs -my-0.5 min-w-0 flex-1 bg-transparent py-0.5 font-mono transition-shadow focus:outline-none'
                                maxLength={255}
                            />
                        )}
                    </div>
                    {modelProbe === 'failed' && !modelManual && (
                        <div className='mt-1 flex gap-3'>
                            <span className='w-28 shrink-0' />
                            <p className='text-subtle text-caption'>
                                {t('web.agentNewV3.modelManualHint')}
                                {' · '}
                                <button
                                    type='button'
                                    onClick={retryModelProbe}
                                    className='text-link hover:text-fg inline-flex items-center gap-1 font-medium'
                                >
                                    <RefreshIcon className='h-3 w-3' />
                                    {t('web.agentNewV3.creditRetry')}
                                </button>
                            </p>
                        </div>
                    )}
                </div>
            )}
        </section>
    )

    const renderCreditSection = (): ReactNode => (
        <section>
            <span className='workbench-field-label mb-1.5 block'>
                {t('web.agentNewV3.creditLabel')}
            </span>
            <WorkbenchSelect
                ariaLabel={t('web.agentNewV3.creditLabel')}
                value={providerSelectValue}
                onChange={selectProvider}
                options={providerOptions}
            />
            {picker.mode === 'inline' ? (
                <p className='text-subtle text-caption mt-1.5'>
                    {t('web.agentNewV3.keySavedHint')}
                </p>
            ) : selectedIsManaged ? (
                credit.phase === 'error' ? (
                    <p className='text-subtle text-caption mt-1.5'>
                        {t('web.agentNewV3.creditError')}
                        {' · '}
                        <button
                            type='button'
                            onClick={credit.retry}
                            className='text-link hover:text-fg inline-flex items-center gap-1 font-medium'
                        >
                            <RefreshIcon className='h-3 w-3' />
                            {t('web.agentNewV3.creditRetry')}
                        </button>
                    </p>
                ) : credit.phase !== 'ready' ? (
                    <p className='text-subtle text-caption mt-1.5 inline-flex items-center gap-1.5'>
                        <Spinner size={12} />
                        {t('web.agentNewV3.creditGranting')}
                    </p>
                ) : (
                    <p className='text-subtle text-caption mt-1.5'>
                        {t('web.agentNewV3.creditPlatformHint')}
                    </p>
                )
            ) : selectedProvider ? (
                <p className='text-subtle text-caption mt-1.5 font-mono'>
                    {selectedProvider.apiKeyMasked}
                </p>
            ) : creditPending ? (
                <p className='text-subtle text-caption mt-1.5 inline-flex items-center gap-1.5'>
                    <Spinner size={12} />
                    {t('web.agentNewV3.creditGranting')}
                </p>
            ) : null}
        </section>
    )

    const cardCls = 'bg-surface shadow-ring-light rounded-md p-5 md:p-6'

    const frameworkSectionNode = (
        <section>
            <span className='workbench-field-label mb-1.5 block'>
                {t('web.agentNewV3.frameworkLabel')}
            </span>
            <WorkbenchSelect
                mono
                ariaLabel={t('web.agentNewV3.chooseFramework')}
                value={framework}
                onChange={(v) => selectFramework(v as CreateableFramework)}
                options={frameworkSelectOptions}
            />
            <div className='mt-2.5 flex flex-wrap items-center gap-1.5'>
                {capabilities.map((id) => {
                    const Icon = CAPABILITY_ICON[id]
                    return (
                        <span
                            key={id}
                            className='tag tag-neutral inline-flex items-center gap-1'
                        >
                            <Icon className='h-3 w-3' />
                            {t(
                                `web.agentNewV3.cap.${id}` as 'web.agentNewV3.cap.general'
                            )}
                        </span>
                    )
                })}
            </div>
        </section>
    )

    const nameSectionNode = (
        <section>
            <label className='block'>
                <span className='workbench-field-label mb-1.5 block'>
                    {t('web.agentNewV3.nameLabel')}
                </span>
                <div className='flex items-center gap-2'>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        aria-invalid={nameError !== null}
                        className='workbench-input font-mono'
                        maxLength={64}
                    />
                    <button
                        type='button'
                        onClick={randomizeName}
                        aria-label={t('web.agentNewV3.randomize')}
                        className='shadow-ring-light bg-surface text-muted hover:bg-surface-hover hover:text-fg inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm transition-colors'
                    >
                        <RefreshIcon className='h-4 w-4' />
                    </button>
                </div>
                <p
                    className={[
                        'text-caption mt-1',
                        nameError ? 'text-error' : 'text-subtle'
                    ].join(' ')}
                >
                    {nameError ??
                        t('web.agentNewV3.nameHint', {
                            max: inputValidation.AGENT_NAME.MAX
                        })}
                </p>
            </label>
            {nameSuggestionNode}
        </section>
    )

    const workspaceSectionNode = workspaceInputEnabled ? (
        <section>
            <label className='block'>
                <span className='workbench-field-label mb-1.5 block'>
                    {t('web.agentNewV3.workspaceLabel')}
                </span>
                <WorkspacePathField
                    variant='field'
                    value={workspace}
                    onChange={setWorkspace}
                    ariaLabel={t('web.agentNewV3.workspaceLabel')}
                />
                <p
                    className={[
                        'text-caption mt-1',
                        workspaceError ? 'text-error' : 'text-subtle'
                    ].join(' ')}
                >
                    {workspaceError ?? t('web.agentNewV3.workspaceHint')}
                </p>
            </label>
        </section>
    ) : null

    const effectiveManaged =
        !isExternal &&
        picker.mode !== 'inline' &&
        (selectedIsManaged || (!selectedProvider && managedAvailable))
    const showBalanceNote = effectiveManaged && managedBalanceEmpty

    const confirmSectionNode = (
        <section className='flex flex-col gap-2'>
            {!advanced &&
                !isExternal &&
                supportsSandbox(framework) &&
                sandboxLimitReached && (
                    <div
                        role='alert'
                        className='bg-warning-bg text-warning text-caption flex flex-wrap items-center justify-between gap-2 rounded-sm px-3 py-2'
                    >
                        <span>{t('web.agentNewV3.runtimeQuotaQuick')}</span>
                        <button
                            type='button'
                            onClick={goAdvanced}
                            className='font-medium underline underline-offset-2'
                        >
                            {t('web.agentNewV3.runtimeChooseExisting')}
                        </button>
                    </div>
                )}
            <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
                {!showQuickDefaults && (
                    <div className='flex min-w-0 items-center gap-2.5'>
                        <FrameworkLogo framework={framework} size={20} />
                        <div className='min-w-0'>
                            <p className='text-muted text-caption'>
                                {summaryLine}
                            </p>
                            <p className='text-subtle text-caption mt-0.5'>
                                {t('web.agentNewV3.summaryNote')}
                            </p>
                        </div>
                    </div>
                )}
                <button
                    type='button'
                    onClick={() => void submit()}
                    disabled={busy || streamOpen || !canSubmit}
                    className={[
                        'workbench-button-primary text-ui h-10 shrink-0 justify-center gap-1.5 px-5',
                        showQuickDefaults ? 'w-full' : 'max-sm:w-full'
                    ].join(' ')}
                >
                    {busy ? (
                        <>
                            <Spinner size={16} />
                            {t('web.agentNewV3.creating')}
                        </>
                    ) : !advanced && !isExternal && creditPending ? (
                        <>
                            <Spinner size={16} />
                            {t('web.agentNewV3.preparingAccount')}
                        </>
                    ) : (
                        t('web.agentNewV3.createCta')
                    )}
                </button>
            </div>
            {showBalanceNote && (
                <p className='text-subtle text-caption'>
                    {t('web.agentNewV3.balanceEmptyNote')}
                </p>
            )}
        </section>
    )

    const runtimeQuotaNode =
        supportsSandbox(framework) && runtimeAccess ? (
            <ShortcutTooltip
                label={t('web.agentNewV3.runtimeUsageTooltip', {
                    used: String(runtimeAccess.statefulSandboxUsage),
                    limit: String(runtimeAccess.statefulSandboxLimit)
                })}
            >
                <span className='text-subtle text-caption inline-flex shrink-0 items-center gap-1 font-mono'>
                    {t('web.agentNewV3.runtimeQuotaLabel')}{' '}
                    {runtimeAccess.statefulSandboxUsage}/
                    {runtimeAccess.statefulSandboxLimit}
                    <InfoIcon className='h-3 w-3' />
                </span>
            </ShortcutTooltip>
        ) : undefined

    return (
        <div className='bg-main min-h-full'>
            {connectDaemonOpen && (
                <ConnectDaemonDialog
                    framework={framework}
                    onClose={() => {
                        setConnectDaemonOpen(false)
                        void refreshRuntimes()
                    }}
                    onConnected={handleDaemonConnected}
                />
            )}
            {externalProviderDialogOpen && (
                <ExternalProviderDialog
                    provider={framework as ExternalAgentProviderKind}
                    onClose={() => setExternalProviderDialogOpen(false)}
                    onCreated={handleExternalProviderCreated}
                />
            )}
            {keyDialogOpen && (
                <ProductDialog
                    title={t('web.agentNewV3.keyDialogTitle')}
                    description={t('web.agentNewV3.keyDialogDesc')}
                    size='sm'
                    onClose={() => setKeyDialogOpen(false)}
                    closeDisabled={keyChecking}
                    onSubmit={(e) => {
                        e.preventDefault()
                        void confirmKeyDialog()
                    }}
                    bodyClassName='flex flex-col gap-4'
                    footer={
                        <>
                            <button
                                type='button'
                                onClick={() => setKeyDialogOpen(false)}
                                disabled={keyChecking}
                                className='workbench-button-secondary text-ui h-9 px-3'
                            >
                                {t('web.agentNew.cancel')}
                            </button>
                            <button
                                type='submit'
                                disabled={
                                    !pickerIsValid(keyDraft) || keyChecking
                                }
                                className='workbench-button-primary text-ui h-9 gap-1.5 px-4'
                            >
                                {keyChecking ? (
                                    <>
                                        <Spinner size={16} />
                                        {t('web.agentNewV3.keyChecking')}
                                    </>
                                ) : (
                                    t('web.agentNewV3.keyDialogConfirm')
                                )}
                            </button>
                        </>
                    }
                >
                    <label className='block'>
                        <span className='workbench-field-label mb-1.5 block'>
                            {t('web.agentNewV3.keyNameLabel')}
                        </span>
                        <input
                            value={keyDraft.saveLabel}
                            onChange={(e) =>
                                setKeyDraft((d) => ({
                                    ...d,
                                    saveLabel: e.target.value
                                }))
                            }
                            placeholder={t('web.agentNewV3.keyNamePlaceholder')}
                            className='workbench-input'
                            maxLength={64}
                        />
                    </label>
                    <label className='block'>
                        <span className='workbench-field-label mb-1.5 block'>
                            {apiKeyLabelForProvider(credentialProvider)}
                        </span>
                        <input
                            type='password'
                            autoComplete='off'
                            value={keyDraft.apiKey}
                            onChange={(e) => {
                                setKeyError(null)
                                setKeyDraft((d) => ({
                                    ...d,
                                    apiKey: e.target.value
                                }))
                            }}
                            className='workbench-input font-mono'
                            maxLength={1024}
                        />
                    </label>
                    <label className='block'>
                        <span className='workbench-field-label mb-1.5 block'>
                            {t('web.agentNew.baseUrlOptional')}
                        </span>
                        <input
                            type='url'
                            value={keyDraft.baseUrl}
                            onChange={(e) => {
                                setKeyError(null)
                                setKeyDraft((d) => ({
                                    ...d,
                                    baseUrl: e.target.value
                                }))
                            }}
                            placeholder={baseUrlForProvider ?? ''}
                            className='workbench-input font-mono'
                        />
                    </label>
                    {keyError && (
                        <p className='text-error text-caption'>{keyError}</p>
                    )}
                </ProductDialog>
            )}
            <header className='bg-main'>
                <div className='mx-auto w-full max-w-2xl px-5 pb-4 pt-7 md:pt-8'>
                    <div className='flex items-center justify-between gap-3'>
                        <h1 className='text-fg text-h1 min-w-0'>
                            {isFirstAgent
                                ? t('web.agentNewV3.welcomeTitle')
                                : t('web.agentNewV3.returningTitle')}
                        </h1>
                        {!isFirstAgent && (
                            <button
                                type='button'
                                onClick={cancel}
                                aria-label={t('web.agentNew.cancel')}
                                className='text-subtle hover:bg-surface-hover hover:text-fg inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors'
                            >
                                <CloseIcon className='h-5 w-5' />
                            </button>
                        )}
                    </div>
                    {!progress && !isExternal && (
                        <div
                            role='group'
                            aria-label={t('web.agentNewV3.modeSwitchLabel')}
                            className='bg-soft shadow-ring-light mt-4 inline-flex gap-1 rounded-md p-1'
                        >
                            <button
                                type='button'
                                aria-pressed={!advanced}
                                onClick={backToSimple}
                                className={modeSegmentClass(!advanced)}
                            >
                                {t('web.agentNewV3.modeQuick')}
                            </button>
                            <button
                                type='button'
                                aria-pressed={advanced}
                                onClick={goAdvanced}
                                className={modeSegmentClass(advanced)}
                            >
                                {t('web.agentNewV3.modeAdvanced')}
                            </button>
                        </div>
                    )}
                </div>
            </header>

            <div className='mx-auto w-full max-w-2xl px-5 pb-12'>
                {error && !progress && (
                    <div className='bg-error-bg text-error-fg text-caption mb-4 rounded-sm px-3 py-2'>
                        {error}
                    </div>
                )}

                {progress ? (
                    <div className='bg-surface shadow-ring-light rounded-md p-5 md:p-6'>
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
                ) : (
                    <>
                        {advanced ? (
                            <div className='space-y-4 md:space-y-6'>
                                <div className={cardCls}>
                                    <CardHeader
                                        title={t(
                                            'web.agentNewV3.cardBasicsTitle'
                                        )}
                                    />
                                    <div className='space-y-6'>
                                        {frameworkSectionNode}
                                        {nameSectionNode}
                                    </div>
                                </div>
                                {!isExternal && (
                                    <div className={cardCls}>
                                        <CardHeader
                                            title={t(
                                                'web.agentNewV3.cardRuntimeTitle'
                                            )}
                                            right={runtimeQuotaNode}
                                        />
                                        <div className='space-y-6'>
                                            {renderRuntimeSection()}
                                            {workspaceSectionNode}
                                        </div>
                                    </div>
                                )}
                                <div className={cardCls}>
                                    <CardHeader
                                        title={
                                            isExternal
                                                ? t(
                                                      'web.agentNewV3.cardConnectionTitle'
                                                  )
                                                : t(
                                                      'web.agentNewV3.cardModelTitle'
                                                  )
                                        }
                                    />
                                    {isExternal
                                        ? renderExternalSection()
                                        : renderProviderModelSection()}
                                </div>
                                <div className={cardCls}>
                                    {confirmSectionNode}
                                </div>
                            </div>
                        ) : (
                            <div className='bg-surface shadow-ring-light space-y-6 rounded-md p-5 md:p-6'>
                                {frameworkSectionNode}
                                {showQuickDefaults ? (
                                    renderQuickDefaults()
                                ) : (
                                    <>
                                        {nameSectionNode}
                                        {workspaceSectionNode}
                                        {isExternal
                                            ? renderExternalSection()
                                            : renderCreditSection()}
                                    </>
                                )}
                                {confirmSectionNode}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

export default AgentNewV3
