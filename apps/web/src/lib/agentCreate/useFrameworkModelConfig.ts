import {
    AgentModelConfig,
    AgentModelConfigView,
    OFFICIAL_PROVIDER_BASE_URL,
    ProviderTestResult,
    UserModelProvider,
    UserModelProviderSummary,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    defaultProtocolForProvider,
    providerProtocolForTarget,
    resolveClaudeCodeModelOptions,
    resolveCodexModelOptions
} from '@manyfold/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import {
    draftFromModelConfigView,
    providerModelIdsForSummary,
    validateModelConfigDraft
} from '@/lib/agentModelConfig'
import type { CreateableFramework } from '@/lib/agentCreateDraft'
import { flattenSavedModels } from '@/lib/agentCreate/savedModels'
import type { ProviderPickerValue } from '@/pages/AgentNew/components/ProviderPicker'
import type { RuntimeMode } from '@/lib/agentCreate/frameworkOptions'

const modelConfigDraftEquals = (
    left: AgentModelConfig | null,
    right: AgentModelConfig | null
): boolean => JSON.stringify(left) === JSON.stringify(right)

type ProviderTestErrorKey =
    | 'selectProviderFirst'
    | 'providerTestFailed'
    | 'apiKeyMinLength'

type ProviderTestError = { key: ProviderTestErrorKey } | { message: string }

interface Input {
    framework: CreateableFramework
    runtimeMode: RuntimeMode
    picker: ProviderPickerValue
    providers: UserModelProviderSummary[]
    setProviders: React.Dispatch<
        React.SetStateAction<UserModelProviderSummary[]>
    >
    modelProviderForRuntime: UserModelProvider
}

export interface UseFrameworkModelConfigResult {
    required: boolean
    view: AgentModelConfigView | null
    draft: AgentModelConfig | null
    setDraft: React.Dispatch<React.SetStateAction<AgentModelConfig | null>>
    validation: ReturnType<typeof validateModelConfigDraft>
    testing: boolean
    testError: string | null
    runTest: () => Promise<void>
    providerTestLabel: string
    providerTestDisabled: boolean
    inlineProviderModels: string[]
    selectedSavedProvider: UserModelProviderSummary | null
}

export const useFrameworkModelConfig = ({
    framework,
    runtimeMode,
    picker,
    providers,
    setProviders,
    modelProviderForRuntime
}: Input): UseFrameworkModelConfigResult => {
    const { t } = useI18n()
    const client = useApiClient()
    const [draft, setDraft] = useState<AgentModelConfig | null>(null)
    const [inlineTestResult, setInlineTestResult] =
        useState<ProviderTestResult | null>(null)
    const [testing, setTesting] = useState(false)
    const [testErrorState, setTestErrorState] =
        useState<ProviderTestError | null>(null)
    const testError = testErrorState
        ? 'key' in testErrorState
            ? t(`web.agentNew.${testErrorState.key}`)
            : testErrorState.message
        : null

    // Runtime mode has no platform provider to test or map models against:
    // model selection happens post-create from the runtime's own list.
    const required =
        runtimeMode !== 'existing' &&
        picker.mode !== 'runtime' &&
        (framework === 'claude-code' || framework === 'codex')

    const selectedSavedProvider =
        picker.mode === 'saved'
            ? (providers.find((option) => option.id === picker.providerId) ??
              null)
            : null

    const inlineProviderModels =
        picker.mode === 'inline' && inlineTestResult?.ok
            ? inlineTestResult.models.map((m) => m.id)
            : []

    const frameworkModelProviderModels =
        picker.mode === 'inline'
            ? inlineProviderModels
            : selectedSavedProvider
              ? (providerModelIdsForSummary(
                    selectedSavedProvider,
                    modelProviderForRuntime
                ) ?? [])
              : []

    const view = useMemo<AgentModelConfigView | null>(() => {
        if (!required) return null
        const providerModels = frameworkModelProviderModels
        const config =
            framework === 'claude-code'
                ? buildClaudeCodeDefaultModelConfig(
                      providerModels,
                      draft?.framework === 'claude-code' ? draft : null
                  )
                : framework === 'codex'
                  ? buildCodexDefaultModelConfig(
                        providerModels,
                        draft?.framework === 'codex' ? draft : null
                    )
                  : draft
        const options =
            framework === 'claude-code'
                ? resolveClaudeCodeModelOptions(
                      providerModels,
                      config?.framework === 'claude-code' ? config.modelMap : {}
                  )
                : resolveCodexModelOptions(providerModels)
        return {
            agentId: 'new',
            framework,
            source: 'platform',
            availableSources: ['platform'],
            provider: modelProviderForRuntime,
            providerBaseUrl:
                picker.mode === 'inline'
                    ? picker.baseUrl.trim() || null
                    : (selectedSavedProvider?.baseUrl ?? null),
            providerModelsStatus:
                providerModels.length > 0 ? 'ready' : 'needs_refresh',
            providerModelsSource:
                providerModels.length > 0
                    ? picker.mode === 'inline'
                        ? 'inline-test'
                        : 'saved-provider'
                    : null,
            providerModels,
            runtimeLocal: null,
            config,
            options,
            validation: {
                valid: true,
                messages: []
            }
        }
    }, [
        draft,
        framework,
        frameworkModelProviderModels,
        modelProviderForRuntime,
        picker.baseUrl,
        picker.mode,
        required,
        selectedSavedProvider
    ])

    useEffect(() => {
        setDraft(null)
        setInlineTestResult(null)
        setTestErrorState(null)
    }, [framework, modelProviderForRuntime, runtimeMode])

    useEffect(() => {
        if (!required) return
        const next = draftFromModelConfigView(view)
        if (!next) return
        if (!modelConfigDraftEquals(draft, next)) setDraft(next)
    }, [draft, required, view])

    const validation = validateModelConfigDraft(view, draft, t)

    const autoTestedRef = useRef<Set<string>>(new Set())
    useEffect(() => {
        if (!required || testing) return
        if (picker.mode !== 'saved') return
        const provider = selectedSavedProvider
        if (!provider || provider.source !== 'managed') return
        if (provider.lastTestedAt) return
        if (view?.providerModelsStatus !== 'needs_refresh') return
        if (autoTestedRef.current.has(provider.id)) return
        autoTestedRef.current.add(provider.id)
        void runTest()
    }, [required, testing, picker.mode, selectedSavedProvider, view])

    const providerTestLabel =
        picker.mode === 'inline'
            ? t('web.agentNew.testAndLoadModels')
            : t('web.agentNew.testProvider')
    const providerTestDisabled =
        picker.mode === 'saved'
            ? !selectedSavedProvider
            : picker.apiKey.trim().length < 10

    const runTest = async (): Promise<void> => {
        if (!required) return
        setTesting(true)
        setTestErrorState(null)
        setDraft(null)
        try {
            if (picker.mode === 'saved') {
                if (!selectedSavedProvider) {
                    setTestErrorState({ key: 'selectProviderFirst' })
                    return
                }
                const result = await client.modelProviders.test(
                    selectedSavedProvider.id
                )
                const protocolKey =
                    selectedSavedProvider.inferenceProtocol ??
                    providerProtocolForTarget(
                        selectedSavedProvider,
                        modelProviderForRuntime
                    ) ??
                    defaultProtocolForProvider(modelProviderForRuntime)
                const models = result.models.map((m) => m.id)
                const refreshedProviders = await client.modelProviders
                    .list()
                    .catch(() => null)
                setProviders(
                    (current) =>
                        refreshedProviders ??
                        current.map((p) =>
                            p.id === selectedSavedProvider.id
                                ? {
                                      ...p,
                                      lastTestedAt: new Date().toISOString(),
                                      lastTestStatus: result.status,
                                      lastTestMessage: result.message ?? null,
                                      lastTestModels: { [protocolKey]: models }
                                  }
                                : p
                        )
                )
                if (!result.ok)
                    setTestErrorState(
                        result.message
                            ? { message: result.message }
                            : { key: 'providerTestFailed' }
                    )
                return
            }
            const apiKey = picker.apiKey.trim()
            if (apiKey.length < 10) {
                setTestErrorState({ key: 'apiKeyMinLength' })
                return
            }
            const result = await client.modelProviders.testInline({
                inferenceProtocol: defaultProtocolForProvider(
                    modelProviderForRuntime
                ),
                apiKey,
                baseUrl:
                    picker.baseUrl.trim() ||
                    OFFICIAL_PROVIDER_BASE_URL[modelProviderForRuntime]
            })
            setInlineTestResult(result)
            if (!result.ok)
                setTestErrorState(
                    result.message
                        ? { message: result.message }
                        : { key: 'providerTestFailed' }
                )
        } catch (err) {
            setTestErrorState({ message: (err as Error).message })
        } finally {
            setTesting(false)
        }
    }

    return {
        required,
        view,
        draft,
        setDraft,
        validation,
        testing,
        testError,
        runTest,
        providerTestLabel,
        providerTestDisabled,
        inlineProviderModels,
        selectedSavedProvider
    }
}

export { flattenSavedModels }
