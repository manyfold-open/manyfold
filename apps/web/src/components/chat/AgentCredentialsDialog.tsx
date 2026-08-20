import {
    AgentCredentialsView,
    AgentFramework,
    AgentModelConfig,
    AgentModelConfigSource,
    AgentModelConfigView,
    BuiltInProviderEntry,
    UpdateAgentCredentialsBody,
    UserModelProvider,
    UserModelProviderSummary,
    claudeCodeModelAliasMapKey,
    claudeCodeModelMapAliases,
    defaultProtocolForProvider,
    frameworkSupportsProtocol,
    isClaudeCodeModelAlias,
    isManagedProtocolAllowedForFramework,
    lookupBuiltIn,
    providerProtocolForTarget,
    providerSupportsTarget
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg'
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg'
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter.svg'
import {
    CheckIcon,
    ChevronDownIcon,
    InfoIcon,
    ProviderIcon,
    RefreshIcon
} from '@/components/icons'
import { Spinner } from '@/components/Loading'
import ProductDialog from '@/components/ProductDialog'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { useApiClient } from '@/lib/apiClient'
import { NetmindMark } from '@/lib/brandMarks'
import { apiErrorMessage } from '@/lib/errorMessage'
import { publishAgentCredentialsUpdated } from '@/lib/agentCredentialsEvents'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import {
    buildAgentModelSupportMatrix,
    claudeEffortOptionsForDraft,
    draftFromModelConfigView,
    formatClaudeAliasLabel,
    formatClaudeEffortLabel,
    frameworkUsesModelConfig,
    isAgentModelSupportRowActive,
    modelConfigViewForProviderModels,
    normalizeClaudeModelConfigDraft,
    providerModelIdsForSummary,
    reconcileModelConfigDraftForProviderModels,
    validateModelConfigDraft,
    withAgentModelSupportSelection,
    writeCachedModelConfigView,
    type AgentModelSupportMatrix,
    type AgentModelSupportRow
} from '@/lib/agentModelConfig'
import {
    initialPicker,
    type ProviderPickerValue
} from '@/pages/AgentNew/components/ProviderPicker'
import {
    inferenceProtocolLabel,
    providerLabel
} from '@/pages/Settings/ModelProviderFields'

interface Props {
    agentId: string
    agentName: string
    framework: AgentFramework
    onClose: () => void
    onUpdated?: (view: AgentCredentialsView) => void
}

const FRAMEWORK_LABEL: Record<AgentFramework, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'gemini-cli': 'Gemini CLI',
    openclaw: 'OpenClaw',
    hermes: 'Hermes Agent',
    narranexus: 'NarraNexus',
    dify: 'Dify',
    langflow: 'Langflow',
    a2a: 'A2A'
}

const DEFAULT_PROVIDER_BY_FRAMEWORK: Record<AgentFramework, UserModelProvider> =
    {
        'claude-code': 'anthropic',
        codex: 'openai',
        'gemini-cli': 'google',
        openclaw: 'anthropic',
        hermes: 'openrouter',
        narranexus: 'anthropic',
        dify: 'anthropic',
        langflow: 'anthropic',
        a2a: 'anthropic'
    }

const providerIconSrc: Record<UserModelProvider, string> = {
    anthropic: anthropicIcon,
    openai: openaiIcon,
    openrouter: openrouterIcon,
    google: geminiIcon,
    antigravity: geminiIcon,
    antigravity_claude: anthropicIcon
}

const builtInIcons: Record<string, FC<{ className?: string }>> = {
    netmind: NetmindMark
}

const successMessageFor = (
    framework: AgentFramework,
    t: TFn,
    localManaged?: boolean
): string => {
    if (localManaged) return t('web.credentials.successUpdated')
    if (framework === 'codex') return t('web.credentials.successUpdatedCodex')
    if (framework === 'claude-code' || framework === 'gemini-cli')
        return t('web.credentials.successUpdatedClaude')
    return t('web.credentials.successUpdatedDefault')
}

const FRAMEWORK_SUPPORTS_MODEL: Record<AgentFramework, boolean> = {
    'claude-code': false,
    codex: false,
    'gemini-cli': true,
    openclaw: true,
    hermes: true,
    narranexus: false,
    dify: false,
    langflow: false,
    a2a: false
}

const applyModel = (
    framework: AgentFramework,
    body: UpdateAgentCredentialsBody,
    model: string
): UpdateAgentCredentialsBody => {
    const m = model.trim()
    if (!m) return body
    if (framework === 'gemini-cli' && body.geminiCliCredentials)
        body.geminiCliCredentials.model = m
    if (framework === 'openclaw' && body.openclawCredentials)
        body.openclawCredentials.primaryModelName = m
    if (framework === 'hermes' && body.hermesCredentials)
        body.hermesCredentials.primaryModelName = m
    return body
}

const buildBody = (
    framework: AgentFramework,
    picker: ProviderPickerValue,
    model: string
): UpdateAgentCredentialsBody => {
    const baseUrl = picker.baseUrl.trim()
    const baseUrlOpt = baseUrl.length > 0 ? baseUrl : undefined
    const saveCredentialAs =
        picker.mode === 'inline' &&
        picker.save &&
        picker.saveLabel.trim().length > 0
            ? { providerName: picker.saveLabel.trim() }
            : undefined
    if (picker.mode === 'saved') {
        if (framework === 'claude-code')
            return applyModel(
                framework,
                {
                    claudeCodeCredentials: { providerId: picker.providerId }
                },
                model
            )
        if (framework === 'codex')
            return applyModel(
                framework,
                {
                    codexCredentials: { providerId: picker.providerId }
                },
                model
            )
        if (framework === 'gemini-cli')
            return applyModel(
                framework,
                {
                    geminiCliCredentials: { providerId: picker.providerId }
                },
                model
            )
        if (framework === 'openclaw')
            return applyModel(
                framework,
                {
                    openclawCredentials: { providerId: picker.providerId }
                },
                model
            )
        return applyModel(
            framework,
            {
                hermesCredentials: { primaryProviderId: picker.providerId }
            },
            model
        )
    }
    if (framework === 'claude-code')
        return applyModel(
            framework,
            {
                claudeCodeCredentials: {
                    anthropicAuthToken: picker.apiKey,
                    anthropicBaseUrl: baseUrlOpt
                },
                saveCredentialAs
            },
            model
        )
    if (framework === 'codex')
        return applyModel(
            framework,
            {
                codexCredentials: {
                    openaiApiKey: picker.apiKey,
                    openaiBaseUrl: baseUrlOpt
                },
                saveCredentialAs
            },
            model
        )
    if (framework === 'gemini-cli')
        return applyModel(
            framework,
            {
                geminiCliCredentials: {
                    googleApiKey: picker.apiKey,
                    googleGeminiBaseUrl: baseUrlOpt
                },
                saveCredentialAs
            },
            model
        )
    if (framework === 'openclaw')
        return applyModel(
            framework,
            {
                openclawCredentials: {
                    apiKey: picker.apiKey,
                    baseUrl: baseUrlOpt
                },
                saveCredentialAs
            },
            model
        )
    return applyModel(
        framework,
        {
            hermesCredentials: {
                primaryModelApiKey: picker.apiKey,
                primaryModelBaseUrl: baseUrlOpt
            },
            saveCredentialAs
        },
        model
    )
}

const AgentCredentialsDialog: FC<Props> = ({
    agentId,
    agentName,
    framework,
    onClose,
    onUpdated
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const frameworkModelConfigSupported = frameworkUsesModelConfig(framework)
    const [view, setView] = useState<AgentCredentialsView | null>(null)
    const [modelConfigView, setModelConfigView] =
        useState<AgentModelConfigView | null>(null)
    const [modelConfigDraft, setModelConfigDraft] =
        useState<AgentModelConfig | null>(null)
    const [modelConfigSourceDraft, setModelConfigSourceDraft] =
        useState<AgentModelConfigSource>('platform')
    const [savedProviders, setSavedProviders] = useState<
        UserModelProviderSummary[]
    >([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [picker, setPicker] = useState<ProviderPickerValue>(initialPicker)
    const [providerListOpen, setProviderListOpen] = useState(false)
    const providerAnchorRef = useRef<HTMLDivElement | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [successMsg, setSuccessMsg] = useState<string | null>(null)
    const [model, setModel] = useState<string>('')
    const [initialModel, setInitialModel] = useState<string>('')
    const [modelConfigError, setModelConfigError] = useState<string | null>(
        null
    )
    const [providerTesting, setProviderTesting] = useState(false)

    const providerHint =
        view?.provider ?? DEFAULT_PROVIDER_BY_FRAMEWORK[framework]
    const boundProviderId = view?.savedProvider?.id ?? null
    const filteredSaved = useMemo(
        () =>
            savedProviders
                .filter((o) => providerSupportsTarget(o, providerHint))
                // Managed channels an admin switched off drop out of the list,
                // except the one this agent is already bound to — keeping it
                // selectable is what lets an existing agent change its model
                // without being forced onto a different provider.
                .filter((o) => !o.channelDisabled || o.id === boundProviderId)
                .filter((o) => {
                    const protocol = providerProtocolForTarget(o, providerHint)
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
                }),
        [savedProviders, providerHint, framework, boundProviderId]
    )
    const showCurrentInline =
        !!view && !view.savedProvider && !!view.apiKeyMasked

    useEffect(() => {
        const load = async (): Promise<void> => {
            try {
                const modelConfigPromise = frameworkModelConfigSupported
                    ? client.agents.getModelConfig(agentId).catch((err) => {
                          setModelConfigError((err as Error).message)
                          return null
                      })
                    : Promise.resolve(null)
                const [viewRes, savedRes, modelConfigRes] = await Promise.all([
                    client.agents.credentials.get(agentId),
                    client.modelProviders
                        .list()
                        .catch(() => [] as UserModelProviderSummary[]),
                    modelConfigPromise
                ])
                setView(viewRes)
                setSavedProviders(savedRes)
                if (modelConfigRes) {
                    setModelConfigView(modelConfigRes)
                    setModelConfigSourceDraft('platform')
                    setModelConfigDraft(
                        draftFromModelConfigView(modelConfigRes)
                    )
                }
                setPicker({
                    ...initialPicker(),
                    mode: 'saved',
                    providerId: viewRes.savedProvider?.id ?? '',
                    baseUrl: ''
                })
                const currentModel =
                    (viewRes.extras?.model as string | undefined) ??
                    (viewRes.extras?.primaryModelName as string | undefined) ??
                    ''
                setModel(currentModel)
                setInitialModel(currentModel)
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setLoading(false)
            }
        }
        void load()
    }, [agentId, client, frameworkModelConfigSupported])

    useEffect(() => {
        if (loading || !picker.providerId) return
        const selectedExists = filteredSaved.some(
            (provider) => provider.id === picker.providerId
        )
        if (!selectedExists) setPicker((p) => ({ ...p, providerId: '' }))
    }, [filteredSaved, loading, picker.providerId])

    const selectedSaved = useMemo(
        () => savedProviders.find((o) => o.id === picker.providerId) ?? null,
        [savedProviders, picker.providerId]
    )
    const selectedSavedProviderModels = useMemo(
        () =>
            selectedSaved
                ? providerModelIdsForSummary(selectedSaved, providerHint)
                : null,
        [providerHint, selectedSaved]
    )

    const selectedProviderModels = useMemo(() => {
        if (!frameworkModelConfigSupported) return null
        if (selectedSaved) return selectedSavedProviderModels
        if (
            showCurrentInline &&
            !selectedSaved &&
            modelConfigView?.providerModelsStatus === 'ready'
        )
            return modelConfigView.providerModels
        return null
    }, [
        frameworkModelConfigSupported,
        modelConfigView,
        selectedSavedProviderModels,
        selectedSaved,
        showCurrentInline
    ])
    const selectedProviderModelsKey = selectedProviderModels?.join('\n') ?? ''
    const useCloudAgentsConfig = modelConfigSourceDraft === 'platform'
    const activeProviderModels = useCloudAgentsConfig
        ? selectedProviderModels
        : null
    const selectedModelConfigView = useMemo(
        () =>
            modelConfigView
                ? modelConfigViewForProviderModels(
                      modelConfigView,
                      activeProviderModels,
                      modelConfigDraft,
                      modelConfigSourceDraft
                  )
                : null,
        [
            activeProviderModels,
            modelConfigDraft,
            modelConfigSourceDraft,
            modelConfigView
        ]
    )
    const modelSupportMatrix = useMemo(
        () =>
            useCloudAgentsConfig && selectedModelConfigView
                ? buildAgentModelSupportMatrix(
                      selectedModelConfigView,
                      modelConfigDraft,
                      activeProviderModels
                  )
                : null,
        [
            activeProviderModels,
            modelConfigDraft,
            selectedModelConfigView,
            useCloudAgentsConfig
        ]
    )
    const modelConfigValidation = validateModelConfigDraft(
        selectedModelConfigView,
        modelConfigDraft,
        t
    )
    const legacyModelChanged =
        FRAMEWORK_SUPPORTS_MODEL[framework] &&
        model.trim() !== initialModel.trim()
    const modelConfigChanged =
        frameworkModelConfigSupported &&
        useCloudAgentsConfig &&
        selectedProviderModels !== null &&
        modelConfigKey(modelConfigDraft) !==
            modelConfigKey(modelConfigView?.config ?? null)
    const modelConfigSourceChanged =
        frameworkModelConfigSupported &&
        !!modelConfigView &&
        modelConfigSourceDraft !== modelConfigView.source
    const credentialsChanged =
        picker.providerId.length > 0 &&
        picker.providerId !== (view?.savedProvider?.id ?? '')
    const providerSelectionActive =
        !frameworkModelConfigSupported || useCloudAgentsConfig
    const effectiveCredentialsChanged =
        providerSelectionActive && credentialsChanged
    const frameworkNeedsProviderTest =
        frameworkModelConfigSupported &&
        useCloudAgentsConfig &&
        selectedProviderModels === null
    const frameworkModelBlocked =
        frameworkModelConfigSupported &&
        (useCloudAgentsConfig
            ? frameworkNeedsProviderTest ||
              !selectedModelConfigView ||
              !modelConfigDraft ||
              !modelConfigValidation.valid
            : !selectedModelConfigView || !modelConfigValidation.valid)

    const noChange = useMemo(() => {
        if (!view) return true
        if (
            legacyModelChanged ||
            modelConfigChanged ||
            modelConfigSourceChanged
        )
            return false
        return !effectiveCredentialsChanged
    }, [
        effectiveCredentialsChanged,
        legacyModelChanged,
        modelConfigChanged,
        modelConfigSourceChanged,
        view
    ])

    useEffect(() => {
        if (
            !frameworkModelConfigSupported ||
            !modelConfigView ||
            !useCloudAgentsConfig
        )
            return
        setModelConfigDraft((current) =>
            reconcileModelConfigDraftForProviderModels(
                modelConfigView,
                current,
                selectedProviderModels
            )
        )
    }, [
        frameworkModelConfigSupported,
        modelConfigView,
        selectedProviderModels,
        selectedProviderModelsKey,
        useCloudAgentsConfig
    ])

    const testSelectedProvider = async (): Promise<void> => {
        setProviderTesting(true)
        setModelConfigError(null)
        try {
            if (selectedSaved) {
                const result = await client.modelProviders.test(
                    selectedSaved.id
                )
                const protocol =
                    selectedSaved.inferenceProtocol ??
                    providerProtocolForTarget(selectedSaved, providerHint) ??
                    defaultProtocolForProvider(providerHint)
                const refreshedProviders = await client.modelProviders
                    .list()
                    .catch(() => null)
                setSavedProviders(
                    (current) =>
                        refreshedProviders ??
                        current.map((provider) =>
                            provider.id === selectedSaved.id
                                ? {
                                      ...provider,
                                      lastTestedAt: new Date().toISOString(),
                                      lastTestStatus: result.status,
                                      lastTestMessage: result.message ?? null,
                                      lastTestModels: {
                                          [protocol]: result.models.map(
                                              (m) => m.id
                                          )
                                      }
                                  }
                                : provider
                        )
                )
                if (!result.ok)
                    setModelConfigError(
                        result.message ??
                            t('web.credentials.providerTestFailed')
                    )
                return
            }
            if (showCurrentInline) {
                const result = await client.agents.refreshModelConfigModels(
                    agentId,
                    { source: 'platform' }
                )
                writeCachedModelConfigView(result.view)
                setModelConfigView(result.view)
                setModelConfigDraft(draftFromModelConfigView(result.view))
                if (!result.ok)
                    setModelConfigError(
                        result.message ??
                            t('web.credentials.providerTestFailed')
                    )
            }
        } catch (err) {
            setModelConfigError((err as Error).message)
        } finally {
            setProviderTesting(false)
        }
    }

    const submit = useCallback(
        async (e: FormEvent<HTMLFormElement>): Promise<void> => {
            e.preventDefault()
            if (!view || view.unsupported) return
            if (effectiveCredentialsChanged && picker.providerId.length === 0) {
                setError(t('web.credentials.pickProvider'))
                return
            }
            if (frameworkModelBlocked) {
                setError(
                    frameworkNeedsProviderTest
                        ? t('web.credentials.testProviderBeforeSave')
                        : (modelConfigValidation.message ??
                              t('web.credentials.chooseSupportedModel'))
                )
                return
            }
            setSubmitting(true)
            setError(null)
            setModelConfigError(null)
            try {
                let updated = view
                if (effectiveCredentialsChanged || legacyModelChanged) {
                    updated = await client.agents.credentials.update(
                        agentId,
                        buildBody(framework, picker, model)
                    )
                }

                let savedModelConfigView: AgentModelConfigView | null = null
                if (frameworkModelConfigSupported) {
                    if (modelConfigSourceDraft === 'runtime-local') {
                        savedModelConfigView =
                            await client.agents.updateModelConfig(agentId, {
                                modelConfigSource: 'runtime-local'
                            })
                        writeCachedModelConfigView(savedModelConfigView)
                        setModelConfigView(savedModelConfigView)
                        setModelConfigSourceDraft(savedModelConfigView.source)
                        setModelConfigDraft(
                            draftFromModelConfigView(savedModelConfigView)
                        )
                    } else if (
                        modelConfigDraft &&
                        selectedProviderModels !== null
                    ) {
                        const refreshed =
                            await client.agents.refreshModelConfigModels(
                                agentId,
                                {
                                    source: 'platform'
                                }
                            )
                        const nextDraft =
                            reconcileModelConfigDraftForProviderModels(
                                refreshed.view,
                                modelConfigDraft,
                                selectedProviderModels
                            )
                        const nextView = modelConfigViewForProviderModels(
                            refreshed.view,
                            selectedProviderModels,
                            nextDraft
                        )
                        const validation = validateModelConfigDraft(
                            nextView,
                            nextDraft,
                            t
                        )
                        if (!nextDraft || !validation.valid)
                            throw new Error(
                                // A failed provider test is the cause, not the
                                // model choice: report it first, otherwise the
                                // generic "choose a model" hint hides why the
                                // list came back empty.
                                (refreshed.ok ? null : refreshed.message) ??
                                    validation.message ??
                                    t('web.credentials.chooseSupportedModel')
                            )
                        savedModelConfigView =
                            await client.agents.updateModelConfig(agentId, {
                                modelConfigSource: 'platform',
                                modelConfig: nextDraft
                            })
                        writeCachedModelConfigView(savedModelConfigView)
                        setModelConfigView(savedModelConfigView)
                        setModelConfigSourceDraft(savedModelConfigView.source)
                        setModelConfigDraft(
                            draftFromModelConfigView(savedModelConfigView)
                        )
                    }
                }

                setView(updated)
                publishAgentCredentialsUpdated(agentId, updated)
                onUpdated?.(updated)
                setSuccessMsg(
                    savedModelConfigView
                        ? `${successMessageFor(
                              framework,
                              t,
                              updated.localManaged
                          )} ${t('web.shell.defaultModelUpdated')}`
                        : successMessageFor(framework, t, updated.localManaged)
                )
                setPicker({
                    ...initialPicker(),
                    mode: 'saved',
                    providerId: updated.savedProvider?.id ?? '',
                    baseUrl: updated.baseUrl ?? ''
                })
                const updatedModel =
                    (updated.extras?.model as string | undefined) ??
                    (updated.extras?.primaryModelName as string | undefined) ??
                    ''
                setModel(updatedModel)
                setInitialModel(updatedModel)
                setProviderListOpen(false)
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setSubmitting(false)
            }
        },
        [
            agentId,
            client,
            effectiveCredentialsChanged,
            framework,
            frameworkModelBlocked,
            frameworkModelConfigSupported,
            frameworkNeedsProviderTest,
            legacyModelChanged,
            model,
            modelConfigDraft,
            modelConfigSourceDraft,
            modelConfigValidation.message,
            onUpdated,
            picker,
            selectedProviderModels,
            t,
            view
        ]
    )

    return (
        <ProductDialog
            title={t('web.credentials.heading')}
            description={
                <>
                    {agentName}
                    <span className='text-placeholder'> · </span>
                    {FRAMEWORK_LABEL[framework]}
                </>
            }
            onClose={onClose}
            onSubmit={(event) => void submit(event)}
            closeDisabled={submitting}
            bodyClassName='space-y-4'
            surfaceClassName='max-w-[36rem]'
            noValidate
            footer={
                !loading && view && !view.unsupported ? (
                    <>
                        <button
                            type='button'
                            className='workbench-button-secondary h-9'
                            onClick={onClose}
                            disabled={submitting}
                        >
                            {t('common.close')}
                        </button>
                        <button
                            type='submit'
                            className='workbench-button-primary h-9'
                            disabled={
                                submitting || noChange || frameworkModelBlocked
                            }
                        >
                            {submitting
                                ? t('web.credentials.saving')
                                : t('common.save')}
                        </button>
                    </>
                ) : undefined
            }
        >
            {loading && (
                <div className='text-ui text-muted flex items-center gap-2'>
                    <Spinner size={16} />
                    {t('web.credentials.loading')}
                </div>
            )}

            {!loading && view?.unsupported && (
                <div className='workbench-panel-subtle px-4 py-3'>
                    <div className='text-ui text-fg font-medium'>
                        {t('web.credentials.comingSoon')}
                    </div>
                    <p className='text-caption text-muted mt-1'>
                        {t('web.credentials.notAvailable', {
                            framework: FRAMEWORK_LABEL[framework]
                        })}
                    </p>
                </div>
            )}

            {!loading && view && !view.unsupported && (
                <>
                    {providerSelectionActive && (
                        <div className='space-y-2.5'>
                            <h3 className='text-ui text-fg font-medium'>
                                {t('web.credentials.provider')}
                            </h3>

                            <div ref={providerAnchorRef} className='relative'>
                                <button
                                    type='button'
                                    className='bg-surface shadow-ring-light hover:bg-surface-hover focus-visible:shadow-focus flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-[color,background-color,box-shadow] focus:outline-none'
                                    aria-haspopup='listbox'
                                    aria-expanded={providerListOpen}
                                    aria-controls='agent-provider-dropdown-menu'
                                    aria-label={t('web.credentials.change')}
                                    onClick={() =>
                                        setProviderListOpen(
                                            (current) => !current
                                        )
                                    }
                                >
                                    {selectedSaved ? (
                                        <ProviderItemContent
                                            row={selectedSaved}
                                            showTag={false}
                                        />
                                    ) : showCurrentInline ? (
                                        <CurrentProviderItemContent
                                            provider={
                                                view.provider ?? providerHint
                                            }
                                            baseUrl={view.baseUrl}
                                        />
                                    ) : (
                                        <EmptyProviderItemContent />
                                    )}
                                    <ChevronDownIcon
                                        className='text-muted h-4 w-4 shrink-0'
                                        aria-hidden='true'
                                    />
                                </button>

                                {providerListOpen && (
                                    <ProviderDropdownMenu
                                        anchorRef={providerAnchorRef}
                                        rows={filteredSaved}
                                        providerHint={providerHint}
                                        selectedId={picker.providerId}
                                        onClose={() =>
                                            setProviderListOpen(false)
                                        }
                                        onSelect={(id) => {
                                            setPicker((p) => ({
                                                ...p,
                                                mode: 'saved',
                                                providerId: id
                                            }))
                                            setProviderListOpen(false)
                                            setError(null)
                                            setModelConfigError(null)
                                            setSuccessMsg(null)
                                        }}
                                    />
                                )}
                            </div>
                        </div>
                    )}

                    {FRAMEWORK_SUPPORTS_MODEL[framework] && (
                        <section className='space-y-2.5'>
                            <div className='min-w-0'>
                                <h3 className='text-ui text-fg font-medium'>
                                    {t('web.credentials.model')}
                                </h3>
                                <div className='text-caption text-muted mt-0.5'>
                                    {t('web.credentials.frameworkDefault')}
                                </div>
                            </div>
                            {selectedSaved &&
                            selectedSavedProviderModels &&
                            selectedSavedProviderModels.length > 0 ? (
                                <WorkbenchSelect
                                    size='sm'
                                    mono
                                    ariaLabel={t('web.credentials.model')}
                                    value={model}
                                    onChange={setModel}
                                    options={[
                                        {
                                            value: '',
                                            label: t(
                                                'web.credentials.useFrameworkDefault'
                                            )
                                        },
                                        ...selectedSavedProviderModels.map(
                                            (id) => ({ value: id, label: id })
                                        )
                                    ]}
                                />
                            ) : (
                                <input
                                    type='text'
                                    value={model}
                                    onChange={(e) => setModel(e.target.value)}
                                    placeholder={
                                        selectedSaved
                                            ? t(
                                                  'web.credentials.placeholderSaved'
                                              )
                                            : t(
                                                  'web.credentials.placeholderUnsaved'
                                              )
                                    }
                                    className='workbench-input h-9 rounded-sm font-mono text-xs'
                                />
                            )}
                        </section>
                    )}

                    {frameworkModelConfigSupported &&
                        useCloudAgentsConfig &&
                        modelSupportMatrix &&
                        selectedModelConfigView && (
                            <>
                                {selectedModelConfigView.framework ===
                                    'claude-code' &&
                                    selectedProviderModels !== null && (
                                        <ClaudeModelMappingCard
                                            view={selectedModelConfigView}
                                            draft={modelConfigDraft}
                                            validationMessage={
                                                modelConfigValidation.message
                                            }
                                            onChange={(nextDraft) => {
                                                setModelConfigDraft(nextDraft)
                                                setError(null)
                                                setModelConfigError(null)
                                                setSuccessMsg(null)
                                            }}
                                        />
                                    )}
                                <AgentModelsCard
                                    matrix={modelSupportMatrix}
                                    view={selectedModelConfigView}
                                    draft={modelConfigDraft}
                                    validationMessage={
                                        selectedModelConfigView.framework ===
                                        'claude-code'
                                            ? null
                                            : modelConfigValidation.message
                                    }
                                    footerAccessory={
                                        selectedModelConfigView.framework ===
                                        'claude-code' ? (
                                            <ClaudeEffortControl
                                                draft={modelConfigDraft}
                                                onChange={(nextDraft) => {
                                                    setModelConfigDraft(
                                                        nextDraft
                                                    )
                                                    setError(null)
                                                    setModelConfigError(null)
                                                    setSuccessMsg(null)
                                                }}
                                            />
                                        ) : undefined
                                    }
                                    needsTest={frameworkNeedsProviderTest}
                                    testing={providerTesting}
                                    testDisabled={
                                        providerTesting ||
                                        (!selectedSaved && !showCurrentInline)
                                    }
                                    onTest={() => void testSelectedProvider()}
                                    onSelect={(row) => {
                                        if (!row.enabled) return
                                        setModelConfigDraft(
                                            withAgentModelSupportSelection(
                                                selectedModelConfigView,
                                                modelConfigDraft,
                                                row
                                            )
                                        )
                                    }}
                                />
                            </>
                        )}

                    {modelConfigError && (
                        <div className='workbench-alert-error'>
                            {modelConfigError}
                        </div>
                    )}

                    {successMsg && (
                        <div className='text-caption text-fg shadow-ring-light rounded-md bg-white/85 px-3.5 py-2.5'>
                            {successMsg}
                        </div>
                    )}

                    {error && (
                        <div className='workbench-alert-error'>{error}</div>
                    )}
                </>
            )}
        </ProductDialog>
    )
}

const ClaudeModelMappingCard: FC<{
    view: AgentModelConfigView
    draft: AgentModelConfig | null
    validationMessage: string | null
    onChange: (
        draft: Extract<AgentModelConfig, { framework: 'claude-code' }>
    ) => void
}> = ({ view, draft, validationMessage, onChange }): ReactNode => {
    const { t } = useI18n()
    const existing = draft?.framework === 'claude-code' ? draft : null
    const currentDraft = existing
        ? normalizeClaudeModelConfigDraft(existing)
        : null
    const modelMap = currentDraft?.modelMap ?? {}
    const update = (
        patch: Partial<Extract<AgentModelConfig, { framework: 'claude-code' }>>
    ): void =>
        onChange(
            normalizeClaudeModelConfigDraft({
                framework: 'claude-code',
                model: currentDraft?.model ?? null,
                effort: currentDraft?.effort ?? null,
                modelMap,
                ...patch
            })
        )
    const updateMapping = (
        alias: (typeof claudeCodeModelMapAliases)[number],
        value: string
    ): void => {
        const nextMap = { ...modelMap }
        if (value) nextMap[alias] = value
        else delete nextMap[alias]

        let nextModel = currentDraft?.model ?? null
        if (!nextModel && value) nextModel = alias
        if (
            nextModel &&
            isClaudeCodeModelAlias(nextModel) &&
            !nextMap[claudeCodeModelAliasMapKey(nextModel)]
        ) {
            nextModel = null
        }

        update({
            model: nextModel,
            modelMap: nextMap
        })
    }

    return (
        <section className='space-y-2.5'>
            <h3 className='text-ui text-fg font-medium'>
                {t('web.credentials.claudeMapping')}
            </h3>
            <div className='grid gap-2'>
                {claudeCodeModelMapAliases.map((alias) => (
                    <div
                        key={alias}
                        className='grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3'
                    >
                        <span className='text-ui text-muted truncate font-medium'>
                            {formatClaudeAliasLabel(alias)}
                        </span>
                        <WorkbenchSelect
                            size='sm'
                            mono
                            className='min-w-0'
                            ariaLabel={formatClaudeAliasLabel(alias)}
                            placeholder={t(
                                'web.credentials.selectProviderModel'
                            )}
                            value={modelMap[alias] ?? ''}
                            onChange={(next) => updateMapping(alias, next)}
                            options={[
                                {
                                    value: '',
                                    label: t(
                                        'web.credentials.selectProviderModel'
                                    )
                                },
                                ...view.providerModels.map((providerModel) => ({
                                    value: providerModel,
                                    label: providerModel
                                }))
                            ]}
                        />
                    </div>
                ))}
            </div>
            {validationMessage && (
                <div className='text-caption text-error'>
                    {validationMessage}
                </div>
            )}
        </section>
    )
}

const ClaudeEffortControl: FC<{
    draft: AgentModelConfig | null
    onChange: (
        draft: Extract<AgentModelConfig, { framework: 'claude-code' }>
    ) => void
}> = ({ draft, onChange }): ReactNode => {
    const { t } = useI18n()
    const currentDraft =
        draft?.framework === 'claude-code'
            ? normalizeClaudeModelConfigDraft(draft)
            : null
    const effortOptions = claudeEffortOptionsForDraft(currentDraft)
    if (!currentDraft || effortOptions.length === 0) return null
    return (
        <div className='grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3'>
            <span className='text-ui text-muted truncate font-medium'>
                {t('web.credentials.effort')}
            </span>
            <WorkbenchSelect
                size='sm'
                className='min-w-0'
                ariaLabel={t('web.credentials.effort')}
                value={currentDraft.effort ?? ''}
                onChange={(next) =>
                    onChange(
                        normalizeClaudeModelConfigDraft({
                            ...currentDraft,
                            effort: next as (typeof effortOptions)[number]
                        })
                    )
                }
                options={effortOptions.map((effort) => ({
                    value: effort,
                    label: formatClaudeEffortLabel(effort, t)
                }))}
            />
        </div>
    )
}

const AgentModelsCard: FC<{
    matrix: AgentModelSupportMatrix
    view: AgentModelConfigView
    draft: AgentModelConfig | null
    validationMessage: string | null
    needsTest: boolean
    testing: boolean
    testDisabled: boolean
    onTest: () => void
    onSelect: (row: AgentModelSupportRow) => void
    footerAccessory?: ReactNode
}> = ({
    matrix,
    view,
    draft,
    validationMessage,
    needsTest,
    testing,
    testDisabled,
    onTest,
    onSelect,
    footerAccessory
}): ReactNode => {
    const { t } = useI18n()
    return (
        <section className='space-y-2.5'>
            <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <h3 className='text-ui text-fg font-medium'>
                        {t('web.shell.defaultModelTitle')}
                    </h3>
                    <div className='text-caption text-muted mt-0.5'>
                        {matrix.ready
                            ? t('web.shell.defaultModelSubtitle', {
                                  supported: matrix.supportedCount,
                                  total: matrix.totalCount
                              })
                            : t('web.shell.supportedModelsNeedsTest')}
                    </div>
                </div>
                <button
                    type='button'
                    onClick={onTest}
                    disabled={testDisabled}
                    className='workbench-button-secondary h-8 shrink-0 gap-2 px-2.5 text-xs'
                >
                    <RefreshIcon
                        className={[
                            'h-3.5 w-3.5',
                            testing ? 'loading-spin' : ''
                        ].join(' ')}
                    />
                    {testing
                        ? t('web.shell.testingProvider')
                        : t('web.shell.testProvider')}
                </button>
            </div>

            {needsTest && (
                <div className='border-divider/60 text-caption text-muted bg-soft flex gap-2 rounded-sm border px-3 py-2.5'>
                    <InfoIcon className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                    <span>
                        {t('web.shell.supportedModelsTestHint', {
                            framework:
                                matrix.framework === 'codex'
                                    ? 'Codex'
                                    : 'Claude Code'
                        })}
                    </span>
                </div>
            )}

            <div className='border-divider/60 divide-divider/60 divide-y overflow-hidden rounded-md border'>
                {matrix.rows.map((row) => {
                    const active = isAgentModelSupportRowActive(
                        view,
                        draft,
                        row
                    )
                    const detail =
                        row.detail ??
                        row.providerModel ??
                        (row.status === 'needs_test'
                            ? t('web.shell.modelNeedsTest')
                            : t('web.shell.modelUnsupported'))
                    const disabledTag = !row.enabled
                        ? row.status === 'needs_test'
                            ? t('web.shell.modelNeedsTest')
                            : t('web.shell.modelUnsupported')
                        : null
                    return (
                        <ShortcutTooltip
                            key={row.key}
                            label={row.reason ?? undefined}
                            className='w-full'
                        >
                            <button
                                type='button'
                                role='option'
                                aria-selected={active}
                                disabled={!row.enabled}
                                onClick={() => onSelect(row)}
                                className={[
                                    'flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                                    active
                                        ? 'bg-soft shadow-ring-light'
                                        : row.enabled
                                          ? 'bg-surface hover:bg-surface-hover'
                                          : 'bg-surface opacity-60'
                                ].join(' ')}
                            >
                                <span className='min-w-0 flex-1'>
                                    <span className='text-ui text-fg block truncate font-medium'>
                                        {row.label}
                                    </span>
                                    <span className='text-caption text-muted block truncate font-mono'>
                                        {detail}
                                    </span>
                                </span>
                                {disabledTag ? (
                                    <span
                                        className={
                                            row.status === 'unsupported'
                                                ? 'tag tag-error'
                                                : 'tag tag-neutral'
                                        }
                                    >
                                        {disabledTag}
                                    </span>
                                ) : active ? (
                                    <span className='text-caption text-link flex shrink-0 items-center gap-1.5 font-medium'>
                                        {t('web.shell.currentDefaultModel')}
                                        <CheckIcon
                                            className='h-4 w-4'
                                            aria-hidden='true'
                                        />
                                    </span>
                                ) : null}
                            </button>
                        </ShortcutTooltip>
                    )
                })}
            </div>

            {footerAccessory}

            {!needsTest && validationMessage && (
                <div className='text-caption text-error'>
                    {validationMessage}
                </div>
            )}
        </section>
    )
}

const ProviderDropdownMenu: FC<{
    anchorRef: RefObject<HTMLDivElement | null>
    rows: UserModelProviderSummary[]
    providerHint: UserModelProvider
    selectedId: string
    onSelect: (id: string) => void
    onClose: () => void
}> = ({
    anchorRef,
    rows,
    providerHint,
    selectedId,
    onSelect,
    onClose
}): ReactNode => {
    const { t } = useI18n()
    const menuRef = useRef<HTMLDivElement | null>(null)
    const menuStyle = useAnchoredMenuPosition(true, anchorRef, menuRef)
    return createPortal(
        <>
            <button
                type='button'
                aria-label={t('web.credentials.closeProviderMenu')}
                className='fixed inset-0 z-[105] cursor-default bg-transparent'
                onClick={onClose}
            />
            <div
                ref={menuRef}
                id='agent-provider-dropdown-menu'
                role='listbox'
                aria-label={t('web.credentials.modelProviders')}
                className={[
                    'popover-panel bg-surface-elevated shadow-elevated fixed z-[110] overflow-auto overscroll-contain rounded-md p-1',
                    menuStyle ? '' : 'invisible'
                ].join(' ')}
                style={menuStyle}
                onWheel={(event) => event.stopPropagation()}
                onTouchMove={(event) => event.stopPropagation()}
            >
                {rows.length > 0 ? (
                    <>
                        <div className='text-caption text-placeholder px-2 py-1 font-medium'>
                            {t('web.credentials.savedProviders', {
                                provider: providerLabel[providerHint]
                            })}
                        </div>
                        {rows.map((row) => (
                            <ProviderOptionRow
                                key={row.id}
                                row={row}
                                selected={selectedId === row.id}
                                onClick={() => onSelect(row.id)}
                            />
                        ))}
                    </>
                ) : (
                    <div className='workbench-note'>
                        {t('web.credentials.noSavedProviders', {
                            provider: providerLabel[providerHint]
                        })}{' '}
                        <a
                            className='text-link hover:text-fg'
                            href='/settings/model-providers/new'
                        >
                            {t('web.credentials.addOne')}
                        </a>
                        {t('web.credentials.inSettings')}
                    </div>
                )}
            </div>
        </>,
        document.body
    )
}

const ProviderOptionRow: FC<{
    row: UserModelProviderSummary
    selected: boolean
    onClick: () => void
}> = ({ row, selected, onClick }): ReactNode => {
    return (
        <button
            type='button'
            role='option'
            aria-selected={selected}
            onClick={onClick}
            className={[
                'hover:bg-soft hover:text-fg flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors',
                selected ? 'text-fg font-medium' : 'text-muted'
            ].join(' ')}
        >
            <ProviderItemContent row={row} selected={selected} />
        </button>
    )
}

const ProviderItemContent: FC<{
    row: UserModelProviderSummary
    showTag?: boolean
    selected?: boolean
}> = ({ row, showTag = true, selected = false }): ReactNode => {
    const { t } = useI18n()
    const builtInEntry = row.builtInId ? lookupBuiltIn(row.builtInId) : null
    const counts = totalModelCounts(row)
    return (
        <>
            <span className='bg-surface shadow-ring-light flex h-9 w-9 shrink-0 items-center justify-center rounded-sm'>
                {builtInEntry ? (
                    <BuiltInLogo entry={builtInEntry} />
                ) : (
                    <span className='text-caption text-muted font-mono'>
                        {row.providerName.charAt(0).toUpperCase()}
                    </span>
                )}
            </span>
            <span className='min-w-0 flex-1'>
                <span className='text-ui text-fg block truncate font-medium'>
                    {row.providerName}
                </span>
                <span className='text-caption text-muted block truncate'>
                    {builtInEntry?.label ??
                        (row.inferenceProtocol
                            ? inferenceProtocolLabel[row.inferenceProtocol]
                            : t('web.credentials.custom'))}
                    {counts.total > 0 && (
                        <>
                            {' · '}
                            {t('web.credentials.modelsCount', {
                                count: `${counts.enabled}/${counts.total}`
                            })}
                        </>
                    )}
                </span>
            </span>
            {showTag && (
                <span className='tag tag-neutral'>{providerTagFor(row, t)}</span>
            )}
            {selected && (
                <CheckIcon
                    className='text-link h-4 w-4 shrink-0'
                    aria-hidden='true'
                />
            )}
        </>
    )
}

const CurrentProviderItemContent: FC<{
    provider: UserModelProvider
    baseUrl: string | null
}> = ({ provider, baseUrl }): ReactNode => {
    const { t } = useI18n()
    return (
        <>
            <span className='bg-surface shadow-ring-light flex h-9 w-9 shrink-0 items-center justify-center rounded-sm'>
                <ProviderLogo provider={provider} />
            </span>
            <span className='min-w-0 flex-1'>
                <span className='text-ui text-fg block truncate font-medium'>
                    {t('web.credentials.currentProvider')}
                </span>
                <span className='text-caption text-muted block truncate'>
                    {providerLabel[provider]}
                    {baseUrl && (
                        <>
                            {' · '}
                            {baseUrl}
                        </>
                    )}
                </span>
            </span>
        </>
    )
}

const EmptyProviderItemContent: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <>
            <span className='bg-surface shadow-ring-light flex h-9 w-9 shrink-0 items-center justify-center rounded-sm'>
                <ProviderIcon className='text-muted h-4 w-4' />
            </span>
            <span className='min-w-0 flex-1'>
                <span className='text-ui text-fg block truncate font-medium'>
                    {t('web.credentials.selectProvider')}
                </span>
                <span className='text-caption text-muted block truncate'>
                    {t('web.credentials.pickSavedProvider')}
                </span>
            </span>
        </>
    )
}

const ProviderLogo: FC<{ provider: UserModelProvider }> = ({
    provider
}): ReactNode => (
    <img
        src={providerIconSrc[provider]}
        alt=''
        aria-hidden='true'
        className={['h-4 w-4', provider === 'google' ? '' : 'dark:invert'].join(
            ' '
        )}
    />
)

const BuiltInLogo: FC<{ entry: BuiltInProviderEntry }> = ({
    entry
}): ReactNode => {
    const Icon = builtInIcons[entry.id]
    if (Icon) return <Icon className='text-fg' />
    if (entry.brand) return <ProviderLogo provider={entry.brand} />
    return (
        <span className='text-caption text-muted font-mono'>
            {entry.label.charAt(0).toUpperCase()}
        </span>
    )
}

const providerTagFor = (row: UserModelProviderSummary, t: TFn): string => {
    if (row.builtInId) return t('web.credentials.builtIn')
    if (row.source === 'managed') return t('web.credentials.managed')
    return t('web.credentials.custom')
}

const totalModelCounts = (
    row: UserModelProviderSummary
): { total: number; enabled: number } => {
    let total = 0
    if (row.lastTestModels) {
        for (const list of Object.values(row.lastTestModels))
            total += list.length
    }
    if (total === 0) return { total: 0, enabled: 0 }
    if (row.enabledModels === null) return { total, enabled: total }
    let enabled = 0
    for (const list of Object.values(row.enabledModels)) enabled += list.length
    return { total, enabled }
}

const modelConfigKey = (config: AgentModelConfig | null): string =>
    JSON.stringify(config ?? null)

export default AgentCredentialsDialog
