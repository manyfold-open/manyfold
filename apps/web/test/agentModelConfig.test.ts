import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    AgentModelConfigView,
    UserModelProviderSummary
} from '@manyfold/shared'
import {
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    claudeCliModel,
    claudeCodeDefaultEffortForModel,
    claudeCodeEffortsForModel,
    claudeModelMapEnv,
    normalizeClaudeCodeEffortForModel,
    providerProtocolForTarget,
    providerSupportsTarget,
    resolveClaudeCodeProviderModel,
    resolveClaudeCodeModelOptions
} from '@manyfold/shared'
import {
    buildAgentModelSupportMatrix,
    claudeEffortOptionsForDraft,
    draftFromModelConfigView,
    formatClaudeEffortLabel,
    frameworkUsesModelConfig,
    mergeCachedRuntimeLocalModelConfigView,
    modelConfigDisplayLabel,
    preferredPrimaryModelDefault,
    providerModelIdsForSummary,
    readCachedModelConfigView,
    reconcileModelConfigDraftForProviderModels,
    validateModelConfigDraft,
    withClaudeModel,
    writeCachedModelConfigView
} from '../src/lib/agentModelConfig'

const testT = (key: string): string =>
    ({
        'web.composer.validation.testProvider':
            'Test this provider in Source to load its models',
        'web.composer.validation.configureClaudeMapping':
            'Configure Claude model mapping',
        'web.composer.validation.chooseTestedClaudeModel':
            'Choose a tested Claude model',
        'web.composer.validation.useTestedProviderModels':
            'Use tested provider models for Claude mapping',
        'web.composer.validation.chooseSupportedCodexModel':
            'Choose a supported Codex model',
        'web.composer.validation.chooseFastCapableModel':
            'Choose a fast-capable model',
        'web.composer.validation.chooseSupportedGeminiModel':
            'Choose a supported Gemini model',
        'web.composer.runtimeLocalUsingTitle': 'Runtime local config',
        'web.composer.intelligence.low': 'Low',
        'web.composer.intelligence.medium': 'Medium',
        'web.composer.intelligence.high': 'High',
        'web.composer.intelligence.xhigh': 'Extra high',
        'web.composer.intelligence.max': 'Maximum',
        'web.composer.intelligence.unknown': 'Unknown',
        'web.composer.speedLabels.fast': 'Fast',
        'web.composer.speedLabels.standard': 'Standard',
        'web.composer.speedLabels.unknown': 'Unknown'
    })[key] ?? key

const codexView: AgentModelConfigView = {
    agentId: 'agent-1',
    framework: 'codex',
    source: 'platform',
    availableSources: ['platform'],
    provider: 'openai',
    providerBaseUrl: null,
    providerModelsStatus: 'ready',
    providerModelsSource: 'saved-provider',
    providerModels: ['provider/gpt-5.5', 'foo/gpt-5.4-mini'],
    runtimeLocal: null,
    config: {
        framework: 'codex',
        model: 'provider/gpt-5.5',
        speed: 'fast',
        intelligence: 'high'
    },
    options: [
        {
            value: 'provider/gpt-5.5',
            label: 'provider/gpt-5.5',
            providerModel: 'provider/gpt-5.5',
            canonicalModel: 'gpt-5.5',
            supportsFast: true,
            enabled: true,
            reason: null
        },
        {
            value: 'foo/gpt-5.4-mini',
            label: 'foo/gpt-5.4-mini',
            providerModel: 'foo/gpt-5.4-mini',
            canonicalModel: 'gpt-5.4-mini',
            supportsFast: false,
            enabled: true,
            reason: null
        }
    ],
    validation: { valid: true, messages: [] }
}

const providerSummary = (
    patch: Partial<UserModelProviderSummary>
): UserModelProviderSummary => ({
    id: 'provider-1',
    inferenceProtocol: 'openai_responses',
    builtInId: null,
    externalAccountId: null,
    providerName: 'provider',
    apiKeyMasked: 'sk-***test',
    baseUrl: 'https://api.example.test/v1',
    modelsListUrl: null,
    source: 'byo',
    managedService: null,
    managedKeyId: null,
    managedBrand: null,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestModels: null,
    enabledModels: null,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    ...patch
})

test('draftFromModelConfigView preserves Codex config', () => {
    assert.deepEqual(draftFromModelConfigView(codexView), codexView.config)
})

test('provider compatibility includes custom protocol providers', () => {
    const anthropic = providerSummary({
        inferenceProtocol: 'anthropic_messages',
        providerName: 'custom anthropic'
    })
    const openaiChat = providerSummary({
        inferenceProtocol: 'openai_chat_completions',
        providerName: 'custom openai-compatible'
    })

    assert.equal(providerSupportsTarget(anthropic, 'anthropic'), true)
    assert.equal(providerSupportsTarget(anthropic, 'openai'), false)
    assert.equal(providerSupportsTarget(openaiChat, 'openai'), true)
    assert.equal(
        providerProtocolForTarget(openaiChat, 'openai'),
        'openai_chat_completions'
    )
})

test('providerModelIdsForSummary selects the matching built-in protocol', () => {
    const netmind = providerSummary({
        builtInId: 'netmind',
        inferenceProtocol: null,
        providerName: 'NetMind API',
        lastTestModels: {
            anthropic_messages: ['claude-sonnet-4-6'],
            openai_responses: ['netmind/gpt-5.5'],
            openai_chat_completions: ['netmind/gpt-5.5'],
            google_generate_content: ['google/gemini-3.5-flash']
        }
    })

    assert.deepEqual(providerModelIdsForSummary(netmind, 'anthropic'), [
        'claude-sonnet-4-6'
    ])
    // NetMind now exposes openai_responses, which sorts ahead of
    // openai_chat_completions for the openai target, so this reads that bucket.
    assert.deepEqual(providerModelIdsForSummary(netmind, 'openai'), [
        'netmind/gpt-5.5'
    ])
    assert.deepEqual(providerModelIdsForSummary(netmind, 'google'), [
        'google/gemini-3.5-flash'
    ])
})

test('providerModelIdsForSummary ignores incompatible custom protocols', () => {
    const anthropic = providerSummary({
        inferenceProtocol: 'anthropic_messages',
        lastTestModels: {
            anthropic_messages: ['claude-sonnet-4-6']
        }
    })

    assert.deepEqual(providerModelIdsForSummary(anthropic, 'anthropic'), [
        'claude-sonnet-4-6'
    ])
    assert.deepEqual(providerModelIdsForSummary(anthropic, 'openai'), null)
})

// A managed antigravity_claude row carries only the anthropic bucket, so the
// claude-code picker reads it and the gemini picker must not.
test('providerModelIdsForSummary reads the anthropic bucket of a managed antigravity claude row', () => {
    const antigravityClaude = providerSummary({
        inferenceProtocol: 'anthropic_messages',
        providerName: 'Managed Antigravity Claude',
        source: 'managed',
        managedBrand: 'antigravity_claude',
        lastTestModels: {
            anthropic_messages: ['claude-opus-4-6', 'claude-sonnet-4-6']
        }
    })

    assert.deepEqual(
        providerModelIdsForSummary(antigravityClaude, 'anthropic'),
        ['claude-opus-4-6', 'claude-sonnet-4-6']
    )
    assert.equal(providerModelIdsForSummary(antigravityClaude, 'google'), null)
})

test('preferredPrimaryModelDefault prefers the economical tier per family', () => {
    assert.equal(
        preferredPrimaryModelDefault(
            ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4'],
            'openai'
        ),
        'gpt-5.4-mini'
    )
    assert.equal(
        preferredPrimaryModelDefault(
            ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
            'anthropic'
        ),
        'claude-haiku-4-5'
    )
})

test('preferredPrimaryModelDefault matches vendor-prefixed economical ids', () => {
    assert.equal(
        preferredPrimaryModelDefault(
            ['netmind/gpt-5.5', 'netmind/gpt-5.4-mini'],
            'openai'
        ),
        'netmind/gpt-5.4-mini'
    )
    assert.equal(
        preferredPrimaryModelDefault(
            ['vendor/claude-sonnet-5', 'vendor/claude-haiku-4-5'],
            'anthropic'
        ),
        'vendor/claude-haiku-4-5'
    )
})

test('preferredPrimaryModelDefault falls back to the first option', () => {
    assert.equal(
        preferredPrimaryModelDefault(
            ['codex-auto-review', 'gpt-5.5'],
            'openai'
        ),
        'codex-auto-review'
    )
    assert.equal(preferredPrimaryModelDefault([], 'openai'), undefined)
    assert.equal(
        preferredPrimaryModelDefault(['some-model'], 'google'),
        'some-model'
    )
})

test('frameworkUsesModelConfig includes local daemon coding agents', () => {
    assert.equal(frameworkUsesModelConfig('claude-code', 'sprites'), true)
    assert.equal(frameworkUsesModelConfig('codex', 'k8s'), true)
    assert.equal(frameworkUsesModelConfig('claude-code', 'daemon'), true)
    assert.equal(frameworkUsesModelConfig('codex', 'daemon'), true)
})

test('validateModelConfigDraft accepts runtime-local source even when inspect cache is empty', () => {
    const result = validateModelConfigDraft(
        {
            ...codexView,
            source: 'runtime-local',
            availableSources: ['platform', 'runtime-local'],
            providerModelsStatus: 'needs_refresh',
            providerModelsSource: null,
            providerModels: [],
            options: [],
            runtimeLocal: {
                available: true,
                ready: false,
                source: null,
                framework: 'codex',
                cliVersion: null,
                credentialReady: null,
                configReadable: null,
                current: null,
                models: [],
                aliases: [],
                speeds: [],
                intelligence: [],
                lastCheckedAt: null,
                error: null
            }
        },
        null,
        testT
    )

    assert.deepEqual(result, { valid: true, message: null })
})

test('validateModelConfigDraft allows runtime-local source after inspect is ready', () => {
    const result = validateModelConfigDraft(
        {
            ...codexView,
            source: 'runtime-local',
            availableSources: ['platform', 'runtime-local'],
            providerModelsStatus: 'needs_refresh',
            providerModelsSource: null,
            providerModels: [],
            options: [],
            runtimeLocal: {
                available: true,
                ready: true,
                source: 'sprites-local',
                framework: 'codex',
                cliVersion: 'codex 0.118.0',
                credentialReady: true,
                configReadable: true,
                current: 'gpt-5.5 · fast · xhigh',
                models: ['gpt-5.5'],
                aliases: [],
                speeds: ['standard', 'fast'],
                intelligence: ['medium', 'xhigh'],
                lastCheckedAt: '2026-05-07T10:00:00.000Z',
                error: null
            }
        },
        null,
        testT
    )

    assert.deepEqual(result, { valid: true, message: null })
})

test('model config view cache round-trips runtime inspect results by agent id', () => {
    withMockLocalStorage(() => {
        const view: AgentModelConfigView = {
            ...codexView,
            source: 'runtime-local',
            availableSources: ['platform', 'runtime-local'],
            providerModelsStatus: 'needs_refresh',
            providerModelsSource: null,
            providerModels: [],
            options: [],
            runtimeLocal: {
                available: true,
                ready: true,
                source: 'daemon-local',
                framework: 'codex',
                cliVersion: 'codex 0.118.0',
                credentialReady: true,
                configReadable: true,
                current: 'gpt-5.5 · fast · xhigh',
                models: ['gpt-5.5'],
                aliases: [],
                speeds: ['standard', 'fast'],
                intelligence: ['medium', 'xhigh'],
                lastCheckedAt: '2026-05-07T10:00:00.000Z',
                error: null
            }
        }

        writeCachedModelConfigView(view)

        assert.deepEqual(readCachedModelConfigView('agent-1'), view)
        assert.equal(readCachedModelConfigView('agent-2'), null)
    })
})

test('mergeCachedRuntimeLocalModelConfigView keeps newer cached local capability', () => {
    const apiView: AgentModelConfigView = {
        ...codexView,
        availableSources: ['platform'],
        runtimeLocal: {
            available: true,
            ready: false,
            source: null,
            framework: 'codex',
            cliVersion: null,
            credentialReady: null,
            configReadable: null,
            current: null,
            models: [],
            aliases: [],
            speeds: [],
            intelligence: [],
            lastCheckedAt: null,
            error: null
        }
    }
    const cachedView: AgentModelConfigView = {
        ...apiView,
        source: 'runtime-local',
        availableSources: ['platform', 'runtime-local'],
        runtimeLocal: {
            available: true,
            ready: true,
            source: 'daemon-local',
            framework: 'codex',
            cliVersion: 'codex 0.118.0',
            credentialReady: true,
            configReadable: true,
            current: 'gpt-5.5 · fast · xhigh',
            models: ['gpt-5.5'],
            aliases: [],
            speeds: ['standard', 'fast'],
            intelligence: ['medium', 'xhigh'],
            lastCheckedAt: '2026-05-07T10:00:00.000Z',
            error: null
        }
    }

    const merged = mergeCachedRuntimeLocalModelConfigView(apiView, cachedView)

    assert.equal(merged.runtimeLocal?.ready, true)
    assert.equal(merged.source, 'runtime-local')
    assert.deepEqual(merged.availableSources, ['platform', 'runtime-local'])
})

test('validateModelConfigDraft blocks fast speed for non-fast Codex model', () => {
    const result = validateModelConfigDraft(codexView, {
        framework: 'codex',
        model: 'foo/gpt-5.4-mini',
        speed: 'fast',
        intelligence: 'medium'
    }, testT)

    assert.equal(result.valid, false)
    assert.match(result.message ?? '', /fast-capable/)
})

test('modelConfigDisplayLabel includes Codex parameters', () => {
    assert.equal(
        modelConfigDisplayLabel(codexView, codexView.config, 'Codex', testT),
        'provider/gpt-5.5 · Fast · High'
    )
})

test('buildAgentModelSupportMatrix shows supported and unsupported Codex models', () => {
    const matrix = buildAgentModelSupportMatrix(codexView, codexView.config, [
        'provider/gpt-5.5',
        'foo/gpt-5.4-mini',
        'other/llama-3'
    ])

    assert.equal(matrix?.framework, 'codex')
    assert.equal(matrix?.supportedCount, 2)
    assert.equal(
        matrix?.rows.find((row) => row.canonicalModel === 'gpt-5.5')
            ?.providerModel,
        'provider/gpt-5.5'
    )
    assert.equal(
        matrix?.rows.find((row) => row.canonicalModel === 'gpt-5.4')?.status,
        'unsupported'
    )
})

test('providerModelIdsForSummary excludes disabled provider models', () => {
    const provider: UserModelProviderSummary = {
        id: 'ump_test',
        inferenceProtocol: 'openai_responses',
        builtInId: null,
        externalAccountId: null,
        providerName: 'OpenAI',
        apiKeyMasked: 'sk-...',
        baseUrl: null,
        modelsListUrl: null,
        source: 'byo',
        managedService: null,
        managedKeyId: null,
        managedBrand: null,
        lastTestedAt: '2026-05-08T10:00:00.000Z',
        lastTestStatus: 'ok',
        lastTestMessage: null,
        lastTestModels: {
            openai_responses: ['provider/gpt-5.5', 'foo/gpt-5.4-mini']
        },
        enabledModels: {
            openai_responses: ['provider/gpt-5.5']
        },
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z'
    }

    assert.deepEqual(providerModelIdsForSummary(provider, 'openai'), [
        'provider/gpt-5.5'
    ])
    assert.deepEqual(
        providerModelIdsForSummary(
            {
                ...provider,
                enabledModels: { openai_responses: [] }
            },
            'openai'
        ),
        []
    )
    assert.deepEqual(
        providerModelIdsForSummary(
            {
                ...provider,
                enabledModels: null
            },
            'openai'
        ),
        ['provider/gpt-5.5', 'foo/gpt-5.4-mini']
    )
})

test('Claude effort helpers follow selected provider model support', () => {
    assert.deepEqual(claudeCodeEffortsForModel('claude-sonnet-4-6'), [
        'low',
        'medium',
        'high',
        'max'
    ])
    assert.equal(
        normalizeClaudeCodeEffortForModel('xhigh', 'claude-sonnet-4-6'),
        'medium'
    )
    assert.equal(
        normalizeClaudeCodeEffortForModel(
            'xhigh',
            'anthropic/claude-opus-4-7'
        ),
        'xhigh'
    )
    assert.equal(
        claudeCodeDefaultEffortForModel('anthropic/claude-opus-4-7'),
        'high'
    )
    assert.deepEqual(claudeCodeEffortsForModel('anthropic/claude-opus-4-7'), [
        'low',
        'medium',
        'high',
        'xhigh',
        'max'
    ])
    assert.equal(
        normalizeClaudeCodeEffortForModel('max', 'anthropic/claude-opus-4-5'),
        'high'
    )
    assert.equal(
        normalizeClaudeCodeEffortForModel('high', 'anthropic/claude-haiku-4-5'),
        null
    )
})

test('Claude effort helpers keep xhigh model-specific', () => {
    assert.deepEqual(claudeCodeEffortsForModel('claude-mythos-5'), [
        'low',
        'medium',
        'high',
        'xhigh',
        'max'
    ])
    assert.deepEqual(claudeCodeEffortsForModel('claude-mythos-preview'), [
        'low',
        'medium',
        'high',
        'max'
    ])
})

test('Claude effort labels cover every advertised level', () => {
    assert.equal(formatClaudeEffortLabel('xhigh', testT), 'Extra high')
    assert.equal(formatClaudeEffortLabel('max', testT), 'Maximum')
})

test('buildAgentModelSupportMatrix uses generated Claude alias mappings', () => {
    const view: AgentModelConfigView = {
        ...codexView,
        framework: 'claude-code',
        provider: 'anthropic',
        config: null,
        providerModels: [],
        options: []
    }
    const matrix = buildAgentModelSupportMatrix(view, null, [
        'anthropic/claude-sonnet-4-6',
        'anthropic/claude-3-5-haiku-20241022'
    ])
    const explicitMatrix = buildAgentModelSupportMatrix(
        view,
        {
            framework: 'claude-code',
            model: 'sonnet',
            effort: 'xhigh',
            modelMap: {
                sonnet: 'anthropic/claude-sonnet-4-6'
            }
        },
        ['anthropic/claude-sonnet-4-6', 'anthropic/claude-3-5-haiku-20241022']
    )

    assert.equal(matrix?.framework, 'claude-code')
    assert.equal(
        matrix?.rows.find((row) => row.value === 'sonnet')?.providerModel,
        'anthropic/claude-sonnet-4-6'
    )
    assert.equal(
        matrix?.rows.find((row) => row.value === 'opus')?.status,
        'unsupported'
    )
    assert.equal(
        matrix?.rows.find((row) => row.value === 'haiku')?.enabled,
        true
    )
    assert.equal(
        explicitMatrix?.rows.find((row) => row.value === 'sonnet')
            ?.providerModel,
        'anthropic/claude-sonnet-4-6'
    )
})

test('reconcileModelConfigDraftForProviderModels defaults Codex to best supported provider model', () => {
    const next = reconcileModelConfigDraftForProviderModels(
        codexView,
        {
            framework: 'codex',
            model: 'provider/gpt-5.2',
            speed: 'standard',
            intelligence: 'high'
        },
        ['other/gpt-5.4-mini', 'other/gpt-5.5']
    )

    assert.deepEqual(next, {
        framework: 'codex',
        model: 'other/gpt-5.5',
        speed: 'standard',
        intelligence: 'high'
    })
})

test('reconcileModelConfigDraftForProviderModels resets Codex fast mode for non-fast models', () => {
    const next = reconcileModelConfigDraftForProviderModels(
        codexView,
        {
            framework: 'codex',
            model: 'provider/gpt-5.5',
            speed: 'fast',
            intelligence: 'xhigh'
        },
        ['other/gpt-5.4-mini']
    )

    assert.deepEqual(next, {
        framework: 'codex',
        model: 'other/gpt-5.4-mini',
        speed: 'standard',
        intelligence: 'xhigh'
    })
})

test('buildCodexDefaultModelConfig prefers GPT-5.6 Sol when the provider exposes it', () => {
    assert.deepEqual(
        buildCodexDefaultModelConfig([
            'other/gpt-5.5',
            'other/gpt-5.6-luna',
            'other/gpt-5.6-sol'
        ]),
        {
            framework: 'codex',
            model: 'other/gpt-5.6-sol',
            speed: 'standard',
            intelligence: 'medium'
        }
    )
})

test('buildCodexDefaultModelConfig picks gpt-5.5 when no model is chosen yet', () => {
    assert.deepEqual(
        buildCodexDefaultModelConfig(['other/gpt-5.4-mini', 'other/gpt-5.5']),
        {
            framework: 'codex',
            model: 'other/gpt-5.5',
            speed: 'standard',
            intelligence: 'medium'
        }
    )
})

test('buildCodexDefaultModelConfig falls back to the best supported model when gpt-5.5 is absent', () => {
    assert.deepEqual(
        buildCodexDefaultModelConfig(['other/gpt-5.2', 'other/gpt-5.4']),
        {
            framework: 'codex',
            model: 'other/gpt-5.4',
            speed: 'standard',
            intelligence: 'medium'
        }
    )
})

test('buildCodexDefaultModelConfig keeps the current model and parameters when still supported', () => {
    assert.deepEqual(
        buildCodexDefaultModelConfig(['other/gpt-5.4', 'other/gpt-5.5'], {
            framework: 'codex',
            model: 'other/gpt-5.4',
            speed: 'fast',
            intelligence: 'high'
        }),
        {
            framework: 'codex',
            model: 'other/gpt-5.4',
            speed: 'fast',
            intelligence: 'high'
        }
    )
})

test('buildCodexDefaultModelConfig leaves the model empty until the provider is tested', () => {
    assert.deepEqual(buildCodexDefaultModelConfig([]), {
        framework: 'codex',
        model: null,
        speed: 'standard',
        intelligence: 'medium'
    })
})

test('validateModelConfigDraft blocks missing Claude mapping', () => {
    const result = validateModelConfigDraft(
        {
            ...codexView,
            framework: 'claude-code',
            provider: 'anthropic',
            config: {
                framework: 'claude-code',
                model: 'sonnet',
                effort: 'medium',
                modelMap: {}
            },
            options: [
                {
                    value: 'sonnet',
                    label: 'Sonnet · not mapped',
                    providerModel: null,
                    canonicalModel: 'sonnet',
                    enabled: false,
                    reason: 'Map this alias'
                }
            ],
            validation: {
                valid: false,
                messages: ['Configure Claude model mapping.']
            }
        },
        {
            framework: 'claude-code',
            model: 'sonnet',
            effort: 'medium',
            modelMap: {}
        },
        testT
    )

    assert.equal(result.valid, false)
    assert.equal(result.message, 'Configure Claude model mapping')
})

test('draftFromModelConfigView keeps missing Claude mapping explicit', () => {
    const view: AgentModelConfigView = {
        ...codexView,
        framework: 'claude-code',
        provider: 'anthropic',
        providerModels: [
            'anthropic/claude-3-5-sonnet-20240620',
            'anthropic/claude-sonnet-4-20250514',
            'anthropic/claude-sonnet-4-5-20250929',
            'anthropic/claude-3-opus-20240229',
            'anthropic/claude-opus-4-1-20250805',
            'anthropic/claude-3-haiku-20240307',
            'anthropic/claude-3-5-haiku-20241022'
        ],
        config: {
            framework: 'claude-code',
            model: null,
            effort: null,
            modelMap: {}
        },
        options: [],
        validation: {
            valid: false,
            messages: ['Configure Claude model mapping.']
        }
    }

    assert.deepEqual(draftFromModelConfigView(view), {
        framework: 'claude-code',
        model: null,
        effort: null,
        modelMap: {}
    })
})

test('draftFromModelConfigView preserves saved Claude mappings without suggestions', () => {
    const view: AgentModelConfigView = {
        ...codexView,
        framework: 'claude-code',
        provider: 'anthropic',
        providerModels: [
            'anthropic/claude-sonnet-4-5-20250929',
            'custom/claude-sonnet-local'
        ],
        config: {
            framework: 'claude-code',
            model: 'sonnet',
            effort: 'high',
            modelMap: {
                sonnet: 'custom/claude-sonnet-local'
            }
        },
        options: [],
        validation: { valid: true, messages: [] }
    }

    assert.deepEqual(draftFromModelConfigView(view), {
        framework: 'claude-code',
        model: 'sonnet',
        effort: null,
        modelMap: {
            sonnet: 'custom/claude-sonnet-local'
        }
    })
})

test('reconcileModelConfigDraftForProviderModels infers Claude mappings without overwriting saved choices', () => {
    const view: AgentModelConfigView = {
        ...codexView,
        framework: 'claude-code',
        provider: 'anthropic',
        providerModels: ['anthropic/claude-sonnet-4-5'],
        config: null,
        options: [],
        validation: {
            valid: false,
            messages: ['Configure Claude model mapping.']
        }
    }

    assert.deepEqual(
        reconcileModelConfigDraftForProviderModels(
            view,
            {
                framework: 'claude-code',
                model: 'sonnet',
                effort: 'xhigh',
                modelMap: {}
            },
            ['anthropic/claude-sonnet-4-5']
        ),
        {
            framework: 'claude-code',
            model: 'sonnet',
            effort: null,
            modelMap: {
                sonnet: 'anthropic/claude-sonnet-4-5'
            }
        }
    )
    assert.deepEqual(
        reconcileModelConfigDraftForProviderModels(
            view,
            {
                framework: 'claude-code',
                model: 'sonnet',
                effort: 'high',
                modelMap: {
                    sonnet: 'custom/claude-sonnet-local'
                }
            },
            ['anthropic/claude-sonnet-4-6', 'custom/claude-sonnet-local']
        ),
        {
            framework: 'claude-code',
            model: 'sonnet',
            effort: null,
            modelMap: {
                sonnet: 'custom/claude-sonnet-local'
            }
        }
    )
})

test('validateModelConfigDraft accepts unsaved Claude draft mapping', () => {
    const view: AgentModelConfigView = {
        ...codexView,
        framework: 'claude-code',
        provider: 'anthropic',
        providerModels: ['anthropic/claude-sonnet-4-5'],
        config: {
            framework: 'claude-code',
            model: 'sonnet',
            effort: 'medium',
            modelMap: {}
        },
        options: [
            {
                value: 'sonnet',
                label: 'Sonnet · not mapped',
                providerModel: null,
                canonicalModel: 'sonnet',
                enabled: false,
                reason: 'Map this alias'
            }
        ],
        validation: {
            valid: false,
            messages: ['Configure Claude model mapping.']
        }
    }

    const draft = {
        framework: 'claude-code' as const,
        model: 'sonnet' as const,
        effort: 'medium' as const,
        modelMap: {
            sonnet: 'anthropic/claude-sonnet-4-5'
        }
    }

    assert.deepEqual(validateModelConfigDraft(view, draft, testT), {
        valid: true,
        message: null
    })
    assert.equal(
        modelConfigDisplayLabel(view, draft, 'Claude Code', testT),
        'Sonnet · anthropic/claude-sonnet-4-5'
    )
})

test('validateModelConfigDraft accepts Claude 1M aliases through base mapping', () => {
    const view: AgentModelConfigView = {
        ...codexView,
        framework: 'claude-code',
        provider: 'anthropic',
        providerModels: ['anthropic/claude-sonnet-4-6'],
        config: null,
        options: [],
        validation: {
            valid: false,
            messages: ['Configure Claude model mapping.']
        }
    }
    const draft = {
        framework: 'claude-code' as const,
        model: 'sonnet[1m]' as const,
        effort: 'xhigh' as const,
        modelMap: {
            sonnet: 'anthropic/claude-sonnet-4-6'
        }
    }

    assert.deepEqual(validateModelConfigDraft(view, draft, testT), {
        valid: true,
        message: null
    })
    assert.equal(
        modelConfigDisplayLabel(view, draft, 'Claude Code', testT),
        'Sonnet 1M · anthropic/claude-sonnet-4-6'
    )
})

test('resolveClaudeCodeModelOptions exposes additional provider model versions', () => {
    const options = resolveClaudeCodeModelOptions(
        [
            'anthropic/claude-opus-4-7',
            'anthropic/claude-opus-4-6',
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-sonnet-4-5'
        ],
        {
            opus: 'anthropic/claude-opus-4-7',
            sonnet: 'anthropic/claude-sonnet-4-6'
        }
    )

    assert.deepEqual(
        options.map((option) => option.value),
        [
            'fable',
            'opus',
            'opus[1m]',
            'anthropic/claude-opus-4-6',
            'sonnet',
            'sonnet[1m]',
            'anthropic/claude-sonnet-4-5',
            'haiku'
        ]
    )
    assert.equal(
        options.find((option) => option.value === 'anthropic/claude-opus-4-6')
            ?.label,
        'Opus 4.6'
    )
})

test('resolveClaudeCodeModelOptions hides Claude-version options for families mapped to non-Claude models', () => {
    const options = resolveClaudeCodeModelOptions(
        [
            'deepseek-ai/DeepSeek-V4-Pro',
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-opus-4-7',
            'anthropic/claude-haiku-4-5-20251001'
        ],
        {
            opus: 'deepseek-ai/DeepSeek-V4-Pro',
            sonnet: 'deepseek-ai/DeepSeek-V4-Pro',
            haiku: 'deepseek-ai/DeepSeek-V4-Pro'
        }
    )

    assert.deepEqual(
        options.map((option) => option.value),
        ['fable', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku']
    )
    assert.equal(
        options.find((option) => option.value === 'fable')?.enabled,
        false
    )
    assert.equal(
        options
            .filter((option) => option.value !== 'fable')
            .every((option) => option.enabled),
        true
    )
    assert.equal(
        options.find((option) => option.value === 'sonnet')?.label,
        'Sonnet · deepseek-ai/DeepSeek-V4-Pro'
    )
    assert.equal(
        options.find((option) => option.value === 'sonnet[1m]')?.label,
        'Sonnet 1M · deepseek-ai/DeepSeek-V4-Pro'
    )
})

test('Fable family maps, injects env and keeps the full effort range', () => {
    const config = buildClaudeCodeDefaultModelConfig([
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-haiku-4-5'
    ])

    assert.equal(config.model, 'sonnet')
    assert.deepEqual(config.modelMap, {
        fable: 'claude-fable-5',
        opus: 'claude-opus-4-8',
        sonnet: 'claude-sonnet-5',
        haiku: 'claude-haiku-4-5'
    })

    const env = claudeModelMapEnv({
        framework: 'claude-code',
        model: 'fable',
        modelMap: config.modelMap
    })
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5')

    assert.equal(
        claudeCliModel(
            { framework: 'claude-code', model: 'claude-fable-5', modelMap: {} },
            null
        ),
        'fable'
    )

    for (const model of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
        assert.deepEqual(claudeCodeEffortsForModel(model), [
            'low',
            'medium',
            'high',
            'xhigh',
            'max'
        ])
        assert.equal(claudeCodeDefaultEffortForModel(model), 'high')
    }
})

test('claudeModelMapEnv emits ANTHROPIC_DEFAULT_*_MODEL for each mapped family', () => {
    const env = claudeModelMapEnv({
        framework: 'claude-code',
        model: 'sonnet',
        modelMap: {
            opus: 'deepseek-ai/DeepSeek-V4-Pro',
            sonnet: 'deepseek-ai/DeepSeek-V4-Pro',
            haiku: 'deepseek-ai/DeepSeek-V4-Pro'
        }
    })

    assert.deepEqual(env, {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-ai/DeepSeek-V4-Pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-ai/DeepSeek-V4-Pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-ai/DeepSeek-V4-Pro'
    })
})

test('claudeModelMapEnv overrides the alias env when a raw model id is selected', () => {
    const env = claudeModelMapEnv({
        framework: 'claude-code',
        model: 'anthropic/claude-sonnet-4-5',
        modelMap: {
            sonnet: 'anthropic/claude-sonnet-4-6'
        }
    })

    assert.equal(
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        'anthropic/claude-sonnet-4-5'
    )
})

test('claudeModelMapEnv leaves 1M context on the CLI alias', () => {
    const env = claudeModelMapEnv({
        framework: 'claude-code',
        model: 'sonnet[1m]',
        modelMap: {
            sonnet: 'anthropic/claude-sonnet-4-6[1m]'
        }
    })

    assert.equal(
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        'anthropic/claude-sonnet-4-6'
    )
})

test('claudeCliModel returns the alias verbatim and collapses raw ids to their family', () => {
    assert.equal(
        claudeCliModel(
            {
                framework: 'claude-code',
                model: 'sonnet',
                modelMap: { sonnet: 'deepseek-ai/DeepSeek-V4-Pro' }
            },
            null
        ),
        'sonnet'
    )
    assert.equal(
        claudeCliModel(
            {
                framework: 'claude-code',
                model: 'anthropic/claude-sonnet-4-6',
                modelMap: {}
            },
            null
        ),
        'sonnet'
    )
    assert.equal(claudeCliModel(null, null), null)
})

test('resolveClaudeCodeModelOptions still surfaces version options for Claude-mapped families', () => {
    const options = resolveClaudeCodeModelOptions(
        [
            'deepseek-ai/DeepSeek-V4-Pro',
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-sonnet-4-5',
            'anthropic/claude-opus-4-7'
        ],
        {
            opus: 'deepseek-ai/DeepSeek-V4-Pro',
            sonnet: 'anthropic/claude-sonnet-4-6',
            haiku: 'deepseek-ai/DeepSeek-V4-Pro'
        }
    )

    const values = options.map((option) => option.value)
    assert.ok(values.includes('anthropic/claude-sonnet-4-5'))
    assert.equal(values.includes('anthropic/claude-opus-4-7'), false)
})

test('buildClaudeCodeDefaultModelConfig chooses newest provider model per Claude family', () => {
    const config = buildClaudeCodeDefaultModelConfig([
        'anthropic/claude-sonnet-4-5-20250929',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'claude-opus-4-6',
        'claude-haiku-4-5@20240901',
        'claude-sonnet-4-6',
        'us.anthropic.claude-opus-4-7'
    ])

    assert.equal(config.model, 'sonnet')
    assert.equal(config.effort, 'medium')
    assert.deepEqual(config.modelMap, {
        opus: 'us.anthropic.claude-opus-4-7',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'anthropic.claude-haiku-4-5-20251001-v1:0'
    })
})

test('buildClaudeCodeDefaultModelConfig fills missing aliases without overwriting saved choices', () => {
    const config = buildClaudeCodeDefaultModelConfig(
        [
            'anthropic/claude-opus-4-7',
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-sonnet-4-5',
            'anthropic/claude-haiku-4-5-20251001'
        ],
        {
            framework: 'claude-code',
            model: 'opus',
            effort: 'high',
            modelMap: {
                sonnet: 'anthropic/claude-sonnet-4-5'
            }
        }
    )

    assert.equal(config.model, 'opus')
    assert.equal(config.effort, 'high')
    assert.deepEqual(config.modelMap, {
        opus: 'anthropic/claude-opus-4-7',
        sonnet: 'anthropic/claude-sonnet-4-5',
        haiku: 'anthropic/claude-haiku-4-5-20251001'
    })
})

test('Claude draft model changes normalize effort options', () => {
    const draft = {
        framework: 'claude-code' as const,
        model: 'opus' as const,
        effort: 'xhigh' as const,
        modelMap: {
            opus: 'anthropic/claude-opus-4-7',
            sonnet: 'anthropic/claude-sonnet-4-6',
            haiku: 'anthropic/claude-haiku-4-5'
        }
    }

    assert.equal(
        resolveClaudeCodeProviderModel(draft.model, draft.modelMap),
        'anthropic/claude-opus-4-7'
    )
    const sonnet = withClaudeModel(draft, 'sonnet')
    assert.equal(sonnet.effort, 'medium')
    assert.deepEqual(claudeEffortOptionsForDraft(sonnet), [
        'low',
        'medium',
        'high',
        'max'
    ])

    const haiku = withClaudeModel(draft, 'haiku')
    assert.equal(haiku.effort, null)
    assert.deepEqual(claudeEffortOptionsForDraft(haiku), [])
})

const withMockLocalStorage = (run: () => void): void => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    const storage: Storage = {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => {
            values.set(key, value)
        }
    }

    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage
    })

    try {
        run()
    } finally {
        if (previous) {
            Object.defineProperty(globalThis, 'localStorage', previous)
        } else {
            Reflect.deleteProperty(globalThis, 'localStorage')
        }
    }
}

// Real shapes from the 2026-07-27 staging incident: a gemini-cli agent was
// moved from Managed Antigravity (bare ids, serves `gemini-3-flash`) to the
// NetMind gateway (`google/…` ids, serves `gemini-3-flash-preview` instead).
const geminiGatewayView: AgentModelConfigView = {
    agentId: 'agent-2',
    framework: 'gemini-cli',
    source: 'platform',
    availableSources: ['platform'],
    provider: 'google',
    providerBaseUrl: 'https://api.netmind.ai/inference-api/gemini',
    providerModelsStatus: 'ready',
    providerModelsSource: 'saved-provider',
    providerModels: [
        'google/gemini-3.6-flash',
        'google/gemini-3-flash-preview',
        'google/gemini-2.5-flash'
    ],
    runtimeLocal: null,
    config: { framework: 'gemini-cli', model: 'google/gemini-3.6-flash' },
    // A gateway drops the `auto` alias row: the CLI router only calls Google's
    // own hardcoded ids, so the API never offers it here.
    options: [
        {
            value: 'google/gemini-3.6-flash',
            label: 'google/gemini-3.6-flash',
            providerModel: 'google/gemini-3.6-flash',
            canonicalModel: 'gemini-3.6-flash',
            enabled: true,
            reason: null
        },
        {
            value: 'google/gemini-3-flash-preview',
            label: 'google/gemini-3-flash-preview',
            providerModel: 'google/gemini-3-flash-preview',
            canonicalModel: 'gemini-3-flash-preview',
            enabled: true,
            reason: null
        },
        {
            value: 'google/gemini-2.5-flash',
            label: 'google/gemini-2.5-flash',
            providerModel: 'google/gemini-2.5-flash',
            canonicalModel: 'gemini-2.5-flash',
            enabled: true,
            reason: null
        }
    ],
    validation: { valid: true, messages: [] }
}

test('gemini validation stays as loose as the API on a gateway', () => {
    // `auto` has no option row on a gateway, but mergeGeminiConfig substitutes
    // the gateway default server-side — blocking it here would strand every
    // auto agent the moment it is pointed at a gateway.
    assert.deepEqual(
        validateModelConfigDraft(geminiGatewayView, {
            framework: 'gemini-cli',
            model: 'auto'
        }, testT),
        { valid: true, message: null }
    )
    // The provider list is the source of truth: a stored bare id is the same
    // model as the gateway's prefixed id, which assertGeminiConfig accepts.
    assert.deepEqual(
        validateModelConfigDraft(geminiGatewayView, {
            framework: 'gemini-cli',
            model: 'gemini-2.5-flash'
        }, testT),
        { valid: true, message: null }
    )
    // Still rejected: the gateway serves gemini-3-flash-preview, never plain
    // gemini-3-flash, so there is no model behind this selection.
    assert.deepEqual(
        validateModelConfigDraft(geminiGatewayView, {
            framework: 'gemini-cli',
            model: 'gemini-3-flash'
        }, testT),
        { valid: false, message: 'Choose a supported Gemini model' }
    )
})

test('gemini draft reconciles onto the newly picked provider', () => {
    // Bare id the new provider serves under a prefix: keep the model, adopt the
    // provider's spelling so the saved config matches what the CLI is given.
    assert.deepEqual(
        reconcileModelConfigDraftForProviderModels(
            geminiGatewayView,
            { framework: 'gemini-cli', model: 'gemini-2.5-flash' },
            geminiGatewayView.providerModels
        ),
        { framework: 'gemini-cli', model: 'google/gemini-2.5-flash' }
    )
    // The incident: an antigravity-era model the gateway does not serve at all.
    // Without this the dialog could never save — it has no Gemini picker to fix
    // the draft with — so fall back to a model the provider does serve.
    assert.deepEqual(
        reconcileModelConfigDraftForProviderModels(
            geminiGatewayView,
            { framework: 'gemini-cli', model: 'gemini-3-flash' },
            geminiGatewayView.providerModels
        ),
        { framework: 'gemini-cli', model: 'google/gemini-3.6-flash' }
    )
    // `auto` belongs to the API's healing path, not ours: leave it alone.
    assert.deepEqual(
        reconcileModelConfigDraftForProviderModels(
            geminiGatewayView,
            { framework: 'gemini-cli', model: 'auto' },
            geminiGatewayView.providerModels
        ),
        { framework: 'gemini-cli', model: 'auto' }
    )
})
