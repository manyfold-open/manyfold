import type { ProtocolModelMap } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCredentials, agents } from '@manyfold/db'
import { AgentModelConfigService } from '../src/modules/agents/model-config/agent-model-config.service'
import { readJsonbMergePatch } from './jsonb-merge'

const date = new Date('2026-05-07T10:00:00.000Z')

const baseAgent = {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Agent',
    framework: 'codex',
    runtime: 'sprites',
    status: 'running',
    accountId: null,
    clusterId: null,
    daemonId: null,
    runtimeId: 'runtime-1',
    internalId: 'agent-1',
    model: null,
    extras: {},
    workspacePath: '/workspace',
    spriteName: null,
    spriteId: null,
    spriteStatus: 'running',
    k8sPodPhase: null,
    mountPath: '/workspace',
    fileRoots: [],
    namespace: null,
    ingressHost: null,
    currentPhase: null,
    failureReason: null,
    startedAt: date,
    lastBootstrappedAt: date,
    lastReconciledAt: date,
    createdAt: date,
    updatedAt: date
}

test('AgentModelConfigService resolves valid Claude alias mapping', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: 'sonnet',
        extras: {
            modelConfig: {
                claudeCode: {
                    effort: 'high',
                    modelMap: {
                        sonnet: 'anthropic/claude-sonnet-x'
                    }
                }
            }
        }
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, ['anthropic/claude-sonnet-x'])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.validation.valid, true)
    assert.equal(view.config?.framework, 'claude-code')
    assert.equal(view.options.find((o) => o.value === 'sonnet')?.enabled, true)
    assert.equal(
        view.options.find((o) => o.value === 'sonnet[1m]')?.enabled,
        true
    )
})

test('AgentModelConfigService accepts tested Claude provider model versions', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: 'anthropic/claude-opus-4-6',
        extras: {
            modelConfig: {
                claudeCode: {
                    effort: 'xhigh',
                    modelMap: {
                        opus: 'anthropic/claude-opus-4-7'
                    }
                }
            }
        }
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, [
        'anthropic/claude-opus-4-7',
        'anthropic/claude-opus-4-6'
    ])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.validation.valid, true)
    assert.equal(
        view.config?.framework === 'claude-code' ? view.config.effort : null,
        'high'
    )
    assert.equal(
        view.options.find((o) => o.value === 'anthropic/claude-opus-4-6')
            ?.enabled,
        true
    )
})

test('AgentModelConfigService generates default Claude config when no mapping is saved', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, [
        'anthropic/claude-opus-4-7',
        'anthropic/claude-sonnet-4-6',
        'anthropic/claude-haiku-4-5-20251001'
    ])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.validation.valid, true)
    assert.deepEqual(view.config, {
        framework: 'claude-code',
        model: 'sonnet',
        effort: 'medium',
        modelMap: {
            opus: 'anthropic/claude-opus-4-7',
            sonnet: 'anthropic/claude-sonnet-4-6',
            haiku: 'anthropic/claude-haiku-4-5-20251001'
        }
    })
})

test('AgentModelConfigService suggests and accepts the Fable family end to end', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, [
        'claude-fable-5',
        'anthropic/claude-sonnet-5'
    ])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(
        view.config?.framework === 'claude-code'
            ? view.config.modelMap?.fable
            : null,
        'claude-fable-5'
    )
    assert.equal(view.options.find((o) => o.value === 'fable')?.enabled, true)

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        { modelConfig: { framework: 'claude-code', model: 'fable' } },
        false
    )

    assert.equal(updated.validation.valid, true)
    assert.equal(
        updated.config?.framework === 'claude-code'
            ? updated.config.model
            : null,
        'fable'
    )
})

test('AgentModelConfigService persists Claude defaults for create path', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, [
        'anthropic/claude-opus-4-7',
        'anthropic/claude-sonnet-4-6'
    ])

    const view = await service.ensureProviderModelsReady(
        'user-1',
        'agent-1',
        false
    )

    assert.equal(view.validation.valid, true)
    assert.equal(db.agent.model, 'sonnet')
    assert.deepEqual(db.agent.extras?.modelConfig, {
        source: 'platform',
        claudeCode: {
            effort: 'medium',
            modelMap: {
                opus: 'anthropic/claude-opus-4-7',
                sonnet: 'anthropic/claude-sonnet-4-6'
            }
        }
    })
})

test('AgentModelConfigService normalizes unsupported Claude effort on save', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, [
        'anthropic/claude-opus-4-7',
        'anthropic/claude-sonnet-4-6'
    ])

    const view = await service.updateForAgent(
        'user-1',
        'agent-1',
        {
            modelConfig: {
                framework: 'claude-code',
                model: 'sonnet',
                effort: 'xhigh',
                modelMap: {
                    sonnet: 'anthropic/claude-sonnet-4-6'
                }
            }
        },
        false
    )

    assert.equal(
        view.config?.framework === 'claude-code' ? view.config.effort : null,
        'medium'
    )
    assert.deepEqual(db.agent.extras?.modelConfig, {
        source: 'platform',
        claudeCode: {
            effort: 'medium',
            modelMap: {
                opus: 'anthropic/claude-opus-4-7',
                sonnet: 'anthropic/claude-sonnet-4-6'
            }
        }
    })
})

test('AgentModelConfigService rejects invalid raw Claude effort on save', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, ['anthropic/claude-sonnet-4-6'])

    await assert.rejects(
        () =>
            service.updateForAgent(
                'user-1',
                'agent-1',
                {
                    modelConfig: {
                        framework: 'claude-code',
                        model: 'sonnet',
                        effort: 'turbo',
                        modelMap: {
                            sonnet: 'anthropic/claude-sonnet-4-6'
                        }
                    } as never
                },
                false
            ),
        /invalid Claude Code effort/
    )
})

test('AgentModelConfigService refresh fills missing Claude aliases without overwriting saved ones', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'claude-code',
        model: 'sonnet',
        extras: {
            modelConfig: {
                claudeCode: {
                    effort: 'high',
                    modelMap: {
                        sonnet: 'anthropic/claude-sonnet-4-5'
                    }
                }
            }
        }
    })
    db.credentialPayload = {
        anthropicAuthToken: 'sk-ant-test',
        anthropicBaseUrl: 'https://anthropic.example.test'
    }
    const service = makeService(db, [
        'anthropic/claude-opus-4-7',
        'anthropic/claude-sonnet-4-6',
        'anthropic/claude-sonnet-4-5',
        'anthropic/claude-haiku-4-5-20251001'
    ])

    const result = await service.refreshProviderModels(
        'user-1',
        'agent-1',
        false
    )

    assert.equal(result.ok, true)
    assert.deepEqual(db.agent.extras?.modelConfig, {
        source: 'platform',
        claudeCode: {
            effort: null,
            modelMap: {
                opus: 'anthropic/claude-opus-4-7',
                sonnet: 'anthropic/claude-sonnet-4-5',
                haiku: 'anthropic/claude-haiku-4-5-20251001'
            }
        }
    })
})

test('AgentModelConfigService degrades legacy Codex intelligence none to low', async () => {
    const db = new FakeDb({
        ...baseAgent,
        model: 'provider/gpt-5.5',
        extras: {
            modelConfig: {
                codex: { speed: 'standard', intelligence: 'none' }
            }
        }
    })
    db.credentialPayload = { openaiApiKey: 'sk-test' }
    const service = makeService(db, ['provider/gpt-5.5'])

    const view = await service.getForAgent('user-1', 'agent-1', false)
    assert.equal(
        view.config?.framework === 'codex' ? view.config.intelligence : null,
        'low'
    )

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        { modelConfig: { framework: 'codex', model: 'provider/gpt-5.5' } },
        false
    )
    assert.equal(
        updated.config?.framework === 'codex'
            ? updated.config.intelligence
            : null,
        'low'
    )
})

test('AgentModelConfigService filters Codex models and rejects ineligible fast', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'codex',
        model: 'provider/gpt-5.4-mini',
        extras: {
            modelConfig: {
                codex: {
                    speed: 'fast',
                    intelligence: 'medium'
                }
            }
        }
    })
    db.credentialPayload = { openaiApiKey: 'sk-openai-test' }
    const service = makeService(db, [
        'provider/gpt-5.5',
        'foo/gpt-5.4-mini',
        'gpt-4.1'
    ])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.deepEqual(
        view.options.map((option) => option.value),
        ['provider/gpt-5.5', 'foo/gpt-5.4-mini']
    )
    assert.equal(view.validation.valid, false)
    assert.match(view.validation.messages.join('\n'), /fast speed/)
})

test('AgentModelConfigService excludes disabled saved provider models', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'codex',
        model: 'foo/gpt-5.4-mini'
    })
    db.credentialPayload = { openaiApiKey: 'sk-openai-test' }
    const service = makeService(
        db,
        ['provider/gpt-5.5', 'foo/gpt-5.4-mini'],
        undefined,
        undefined,
        { openai_responses: ['provider/gpt-5.5'] }
    )

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.deepEqual(view.providerModels, ['provider/gpt-5.5'])
    assert.deepEqual(
        view.options.map((option) => option.value),
        ['provider/gpt-5.5']
    )
    assert.equal(view.validation.valid, false)
    assert.match(view.validation.messages.join('\n'), /supported Codex model/)
})

test('AgentModelConfigService persists Codex defaults in agent extras', async () => {
    const db = new FakeDb(baseAgent)
    db.credentialPayload = { openaiApiKey: 'sk-openai-test' }
    const service = makeService(db, ['provider/gpt-5.5'])

    await service.updateForAgent(
        'user-1',
        'agent-1',
        {
            modelConfig: {
                framework: 'codex',
                model: 'provider/gpt-5.5',
                speed: 'fast',
                intelligence: 'high'
            }
        },
        false
    )

    assert.equal(db.lastAgentPatch?.model, 'provider/gpt-5.5')
    assert.deepEqual(db.lastAgentPatch?.extras?.modelConfig, {
        source: 'platform',
        codex: {
            speed: 'fast',
            intelligence: 'high'
        }
    })
})

test('AgentModelConfigService rejects saves without tested provider models', async () => {
    const db = new FakeDb(baseAgent)
    db.credentialPayload = { openaiApiKey: 'sk-openai-test' }
    const service = makeService(db, [])

    await assert.rejects(
        () =>
            service.updateForAgent(
                'user-1',
                'agent-1',
                {
                    modelConfig: {
                        framework: 'codex',
                        model: 'gpt-5.5',
                        speed: 'standard',
                        intelligence: 'medium'
                    }
                },
                false
            ),
        /Test provider/
    )
})

test('AgentModelConfigService hides Gemini auto on gateways and fails loud on undiscovered models', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: 'gemini-2.5-pro',
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://gateway.test'
    }
    const service = makeService(db, null)

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.provider, 'google')
    assert.equal(view.providerModelsStatus, 'needs_refresh')
    // Auto is the CLI's own router: its hardcoded gemini-3-* ids only exist
    // on the official endpoint, so a gateway must not offer it at all.
    assert.deepEqual(
        view.options.map((option) => option.value),
        ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']
    )
    assert.equal(
        view.options.find((option) => option.value === 'gemini-2.5-pro')
            ?.enabled,
        false
    )
    assert.equal(view.validation.valid, false)
})

test('AgentModelConfigService enables every discovered Gemini model and defaults gateways to a concrete model', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://gateway.test'
    }
    const service = makeService(db, ['gemini-3.5-flash', 'gemini-2.5-flash'])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.providerModelsStatus, 'ready')
    assert.equal(view.validation.valid, true)
    assert.equal(
        view.options.find((option) => option.value === 'gemini-3.5-flash')
            ?.enabled,
        true
    )
    // Catalog rows the provider never reported are placeholders, not options.
    assert.equal(
        view.options.find((option) => option.value === 'gemini-2.5-pro'),
        undefined
    )
    assert.equal(
        view.config?.framework === 'gemini-cli' ? view.config.model : null,
        'gemini-3.5-flash'
    )

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        { modelConfig: { framework: 'gemini-cli' } },
        false
    )
    assert.equal(
        updated.config?.framework === 'gemini-cli'
            ? updated.config.model
            : null,
        'gemini-3.5-flash'
    )
    assert.equal(updated.validation.valid, true)
})

test('AgentModelConfigService matches prefixed Gemini provider models by canonical id', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://api.netmind.ai/inference-api/gemini'
    }
    const service = makeService(db, [
        'google/gemini-2.5-pro',
        'google/gemini-2.5-flash'
    ])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.providerModelsStatus, 'ready')
    const pro = view.options.find(
        (option) => option.canonicalModel === 'gemini-2.5-pro'
    )
    assert.equal(pro?.enabled, true)
    assert.equal(pro?.value, 'google/gemini-2.5-pro')
    assert.equal(pro?.providerModel, 'google/gemini-2.5-pro')
    assert.equal(
        view.options.find((option) => option.value === 'auto'),
        undefined
    )
    assert.equal(
        view.options.find(
            (option) => option.canonicalModel === 'gemini-3.5-flash'
        ),
        undefined
    )
    assert.equal(view.validation.valid, true)
})

test('AgentModelConfigService keeps Gemini auto selectable on the official endpoint', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://generativelanguage.googleapis.com'
    }
    const service = makeService(db, ['gemini-3.5-flash', 'gemini-2.5-pro'])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(
        view.options.find((option) => option.value === 'auto')?.enabled,
        true
    )
    assert.equal(
        view.config?.framework === 'gemini-cli' ? view.config.model : null,
        'auto'
    )
    assert.equal(view.validation.valid, true)
})

test('AgentModelConfigService accepts gateway model ids the catalog never knew', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-managed upstream-test',
        googleGeminiBaseUrl: 'https://gateway.test/antigravity'
    }
    // Managed antigravity shape: bare ids with variants the static catalog
    // has no canonical row for (-low, gemini-3-flash, image models).
    const service = makeService(db, [
        'gemini-2.5-flash',
        'gemini-2.5-flash-image',
        'gemini-3-flash',
        'gemini-3.5-flash-low',
        'gemini-3-pro-preview'
    ])

    const view = await service.getForAgent('user-1', 'agent-1', false)

    assert.equal(view.providerModelsStatus, 'ready')
    assert.equal(view.validation.valid, true)
    for (const id of [
        'gemini-2.5-flash',
        'gemini-3-flash',
        'gemini-3.5-flash-low'
    ]) {
        assert.equal(
            view.options.find((option) => option.value === id)?.enabled,
            true,
            `expected ${id} to be selectable`
        )
    }
    // Catalog-known canonical floats to the top as the gateway default.
    assert.equal(
        view.config?.framework === 'gemini-cli' ? view.config.model : null,
        'gemini-2.5-flash'
    )

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        {
            modelConfig: {
                framework: 'gemini-cli',
                model: 'gemini-3.5-flash-low'
            }
        },
        false
    )
    assert.equal(db.agent.model, 'gemini-3.5-flash-low')
    assert.equal(updated.validation.valid, true)

    await assert.rejects(
        service.updateForAgent(
            'user-1',
            'agent-1',
            {
                modelConfig: {
                    framework: 'gemini-cli',
                    model: 'gemini-9-imaginary'
                }
            },
            false
        ),
        /not in the tested provider model list/
    )
})

test('AgentModelConfigService stores the provider-exact Gemini id from the picker', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://api.netmind.ai/inference-api/gemini'
    }
    const service = makeService(db, [
        'google/gemini-2.5-pro',
        'google/gemini-2.5-flash'
    ])

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        {
            modelConfig: {
                framework: 'gemini-cli',
                model: 'google/gemini-2.5-pro'
            }
        },
        false
    )

    assert.equal(db.agent.model, 'google/gemini-2.5-pro')
    assert.equal(
        updated.config?.framework === 'gemini-cli'
            ? updated.config.model
            : null,
        'google/gemini-2.5-pro'
    )
    assert.equal(updated.validation.valid, true)
})

test('AgentModelConfigService resolves a bare Gemini key to the provider-exact id on save', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://api.netmind.ai/inference-api/gemini'
    }
    const service = makeService(db, ['google/gemini-2.5-pro'])

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        { modelConfig: { framework: 'gemini-cli', model: 'gemini-2.5-pro' } },
        false
    )

    assert.equal(db.agent.model, 'google/gemini-2.5-pro')
    assert.equal(
        updated.config?.framework === 'gemini-cli'
            ? updated.config.model
            : null,
        'google/gemini-2.5-pro'
    )
    assert.equal(updated.validation.valid, true)
})

test('AgentModelConfigService accepts a tagged Gemini provider id', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: null,
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://api.netmind.ai/inference-api/gemini'
    }
    const service = makeService(db, ['gemini-2.5-pro:latest'])

    const view = await service.getForAgent('user-1', 'agent-1', false)
    const pro = view.options.find(
        (option) => option.canonicalModel === 'gemini-2.5-pro'
    )
    assert.equal(pro?.enabled, true)
    assert.equal(pro?.value, 'gemini-2.5-pro:latest')

    const updated = await service.updateForAgent(
        'user-1',
        'agent-1',
        {
            modelConfig: {
                framework: 'gemini-cli',
                model: 'gemini-2.5-pro:latest'
            }
        },
        false
    )
    assert.equal(db.agent.model, 'gemini-2.5-pro:latest')
    assert.equal(updated.validation.valid, true)
})

test('AgentModelConfigService resolves Gemini chat turns to the provider-exact id', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: 'gemini-2.5-pro',
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://api.netmind.ai/inference-api/gemini'
    }
    const service = makeService(db, ['google/gemini-2.5-pro'])

    const turn = await service.resolveTurnConfig({
        callerUserId: 'user-1',
        agentId: 'agent-1'
    })

    assert.equal(turn.model, 'google/gemini-2.5-pro')
    assert.equal(
        turn.modelConfig?.framework === 'gemini-cli'
            ? turn.modelConfig.model
            : null,
        'google/gemini-2.5-pro'
    )
})

test('AgentModelConfigService replaces stored Gemini auto with the gateway default on chat turns', async () => {
    // Agents saved before the gateway auto ban must heal at turn time instead
    // of letting the CLI router call hardcoded ids the gateway cannot serve.
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: 'auto',
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://api.netmind.ai/inference-api/gemini'
    }
    const service = makeService(db, ['google/gemini-2.5-pro'])

    const turn = await service.resolveTurnConfig({
        callerUserId: 'user-1',
        agentId: 'agent-1'
    })

    assert.equal(turn.model, 'google/gemini-2.5-pro')
})

test('AgentModelConfigService keeps the Gemini auto router on official-endpoint chat turns', async () => {
    const db = new FakeDb({
        ...baseAgent,
        framework: 'gemini-cli',
        model: 'auto',
        extras: {}
    })
    db.credentialPayload = {
        googleApiKey: 'sk-google-test',
        googleGeminiBaseUrl: 'https://generativelanguage.googleapis.com'
    }
    const service = makeService(db, ['gemini-2.5-pro'])

    const turn = await service.resolveTurnConfig({
        callerUserId: 'user-1',
        agentId: 'agent-1'
    })

    assert.equal(turn.model, 'auto')
})

test('AgentModelConfigService defaults daemon chat turns to runtime-local source', async () => {
    const codexDb = new FakeDb({
        ...baseAgent,
        runtime: 'daemon',
        framework: 'codex',
        model: null,
        extras: {
            runtimeLocalModelConfig: readyRuntimeLocal('codex', 'daemon-local')
        }
    })
    const codexService = makeService(codexDb, [])

    const codexTurn = await codexService.resolveTurnConfig({
        callerUserId: 'user-1',
        agentId: 'agent-1',
        model: null,
        modelConfig: {
            framework: 'codex',
            model: 'gpt-5.5',
            speed: 'fast',
            intelligence: 'xhigh'
        },
        saveAsDefault: true
    })

    assert.deepEqual(codexTurn, {
        model: null,
        modelConfig: null
    })
    assert.equal(codexDb.lastAgentPatch, null)

    const claudeDb = new FakeDb({
        ...baseAgent,
        runtime: 'daemon',
        framework: 'claude-code',
        model: null,
        extras: {
            runtimeLocalModelConfig: readyRuntimeLocal(
                'claude-code',
                'daemon-local'
            )
        }
    })
    const claudeService = makeService(claudeDb, [])

    const claudeTurn = await claudeService.resolveTurnConfig({
        callerUserId: 'user-1',
        agentId: 'agent-1',
        model: null,
        modelConfig: {
            framework: 'claude-code',
            model: 'sonnet',
            effort: 'xhigh',
            modelMap: {}
        },
        saveAsDefault: true
    })

    assert.deepEqual(claudeTurn, {
        model: null,
        modelConfig: null
    })
    assert.equal(claudeDb.lastAgentPatch, null)
})

test('AgentModelConfigService exposes runtime-local for sprites and k8s and lets users select it without a refresh', async () => {
    for (const runtime of ['sprites', 'k8s'] as const) {
        const db = new FakeDb({
            ...baseAgent,
            runtime,
            framework: 'codex',
            model: null,
            extras: {}
        })
        const service = makeService(db, [])

        const view = await service.getForAgent('user-1', 'agent-1', false)

        assert.equal(view.source, 'platform')
        assert.deepEqual(view.availableSources, ['platform', 'runtime-local'])
        assert.equal(view.runtimeLocal?.ready, false)

        const updated = await service.updateForAgent(
            'user-1',
            'agent-1',
            { modelConfigSource: 'runtime-local' },
            false
        )
        assert.equal(updated.source, 'runtime-local')
        assert.equal(updated.validation.valid, true)

        const turn = await service.resolveTurnConfig({
            callerUserId: 'user-1',
            agentId: 'agent-1',
            modelConfigSource: 'runtime-local',
            saveAsDefault: true
        })
        assert.deepEqual(turn, { model: null, modelConfig: null })
    }
})

test('AgentModelConfigService allows sprites runtime-local after inspect cache is ready', async () => {
    const db = new FakeDb({
        ...baseAgent,
        runtime: 'sprites',
        framework: 'codex',
        model: 'gpt-5.5',
        extras: {
            runtimeLocalModelConfig: readyRuntimeLocal('codex', 'sprites-local')
        }
    })
    const service = makeService(db, [])

    const view = await service.updateForAgent(
        'user-1',
        'agent-1',
        { modelConfigSource: 'runtime-local' },
        false
    )
    const turn = await service.resolveTurnConfig({
        callerUserId: 'user-1',
        agentId: 'agent-1',
        modelConfigSource: 'runtime-local',
        saveAsDefault: true
    })

    assert.equal(view.source, 'runtime-local')
    assert.deepEqual(turn, {
        model: null,
        modelConfig: null
    })
})

test('AgentModelConfigService ignores daemon-local cache for platform validation', async () => {
    const db = new FakeDb({
        ...baseAgent,
        runtime: 'daemon',
        framework: 'codex',
        model: null,
        extras: {
            modelConfig: {
                source: 'platform'
            },
            modelProviderModels: {
                provider: null,
                baseUrl: null,
                models: ['gpt-5.5'],
                testedAt: date.toISOString(),
                source: 'daemon-local'
            }
        }
    })
    const service = makeService(db, [])

    await assert.rejects(
        () =>
            service.resolveTurnConfig({
                callerUserId: 'user-1',
                agentId: 'agent-1',
                modelConfigSource: 'platform',
                modelConfig: {
                    framework: 'codex',
                    model: 'gpt-5.5',
                    speed: 'fast',
                    intelligence: 'xhigh'
                },
                saveAsDefault: true
            }),
        /Test provider/
    )
})

test('AgentModelConfigService refreshes daemon runtime-local capability', async () => {
    const db = new FakeDb({
        ...baseAgent,
        runtime: 'daemon',
        daemonId: 'daemon-1',
        framework: 'codex',
        model: null,
        extras: {
            modelConfig: {
                source: 'runtime-local'
            }
        }
    })
    const service = makeService(db, [], {
        rpc: async () => ({
            frameworks: [
                {
                    framework: 'codex',
                    cliVersion: 'codex 0.118.0',
                    ready: true,
                    credentialReady: true,
                    configReadable: true,
                    current: 'gpt-5.5 · fast · xhigh',
                    models: ['gpt-5.5'],
                    aliases: [],
                    speeds: ['standard', 'fast'],
                    intelligence: ['medium', 'xhigh'],
                    lastCheckedAt: date.toISOString(),
                    error: null
                }
            ]
        })
    })

    const result = await service.refreshProviderModels(
        'user-1',
        'agent-1',
        false,
        'runtime-local'
    )

    assert.equal(result.ok, true)
    assert.deepEqual(db.agent.extras?.runtimeLocalModelConfig, {
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
        lastCheckedAt: date.toISOString(),
        error: null
    })
    assert.equal(db.agent.extras?.modelProviderModels, undefined)
})

test('AgentModelConfigService refreshes sprites runtime-local capability through exec inspect', async () => {
    const db = new FakeDb({
        ...baseAgent,
        runtime: 'sprites',
        framework: 'codex',
        model: null,
        extras: {
            modelConfig: {
                source: 'platform'
            }
        }
    })
    const payload = JSON.stringify({
        frameworks: [
            {
                framework: 'codex',
                cliVersion: 'codex 0.118.0',
                ready: true,
                credentialReady: true,
                configReadable: true,
                current: 'gpt-5.5 · fast · xhigh',
                models: ['gpt-5.5'],
                aliases: [],
                speeds: ['standard', 'fast'],
                intelligence: ['medium', 'xhigh'],
                lastCheckedAt: date.toISOString(),
                error: null
            }
        ]
    })
    const service = makeService(db, [], undefined, {
        forAgent: async () => ({
            driver: {
                stream: () => ({
                    stdout: chunks(`${payload}\n`),
                    stderr: chunks(''),
                    result: Promise.resolve({
                        exitCode: 0,
                        stdout: payload,
                        stderr: ''
                    }),
                    abort: () => {}
                })
            }
        })
    })

    const result = await service.refreshProviderModels(
        'user-1',
        'agent-1',
        false,
        'runtime-local'
    )

    assert.equal(result.ok, true)
    const runtimeLocal = db.agent.extras?.runtimeLocalModelConfig as
        | Record<string, unknown>
        | undefined
    assert.equal(runtimeLocal?.source, 'sprites-local')
    assert.equal(runtimeLocal?.ready, true)
})

const readyRuntimeLocal = (
    framework: 'codex' | 'claude-code',
    source: 'daemon-local' | 'sprites-local' | 'k8s-local'
) => ({
    available: true,
    ready: true,
    source,
    framework,
    cliVersion: framework === 'codex' ? 'codex 0.118.0' : 'claude 2.0.0',
    credentialReady: true,
    configReadable: true,
    current: framework === 'codex' ? 'gpt-5.5 · fast · xhigh' : 'Sonnet',
    models: framework === 'codex' ? ['gpt-5.5'] : ['claude-sonnet-4-6'],
    aliases: framework === 'codex' ? [] : ['sonnet'],
    speeds: framework === 'codex' ? ['standard', 'fast'] : [],
    intelligence: framework === 'codex' ? ['medium', 'xhigh'] : [],
    lastCheckedAt: date.toISOString(),
    error: null
})

const makeFakeCatalog = () => {
    const models = {
        'claude-code': [
            {
                modelKey: 'fable',
                kind: 'alias',
                capabilities: {},
                isDefault: false
            },
            {
                modelKey: 'opus',
                kind: 'alias',
                capabilities: {},
                isDefault: false
            },
            {
                modelKey: 'opus[1m]',
                kind: 'alias',
                capabilities: { longContext: true },
                isDefault: false
            },
            {
                modelKey: 'sonnet',
                kind: 'alias',
                capabilities: {},
                isDefault: true
            },
            {
                modelKey: 'sonnet[1m]',
                kind: 'alias',
                capabilities: { longContext: true },
                isDefault: false
            },
            {
                modelKey: 'haiku',
                kind: 'alias',
                capabilities: {},
                isDefault: false
            }
        ],
        codex: [
            {
                modelKey: 'gpt-5.6-sol',
                kind: 'model',
                capabilities: { fast: true },
                isDefault: false
            },
            {
                modelKey: 'gpt-5.6-terra',
                kind: 'model',
                capabilities: { fast: true },
                isDefault: false
            },
            {
                modelKey: 'gpt-5.6-luna',
                kind: 'model',
                capabilities: { fast: true },
                isDefault: false
            },
            {
                modelKey: 'gpt-5.5',
                kind: 'model',
                capabilities: { fast: true },
                isDefault: true
            },
            {
                modelKey: 'gpt-5.4',
                kind: 'model',
                capabilities: { fast: true },
                isDefault: false
            },
            {
                modelKey: 'gpt-5.4-mini',
                kind: 'model',
                capabilities: {},
                isDefault: false
            },
            {
                modelKey: 'gpt-5.3-codex',
                kind: 'model',
                capabilities: {},
                isDefault: false
            },
            {
                modelKey: 'gpt-5.2',
                kind: 'model',
                capabilities: {},
                isDefault: false
            }
        ],
        'gemini-cli': [
            {
                modelKey: 'auto',
                kind: 'alias',
                capabilities: {},
                isDefault: false
            },
            {
                modelKey: 'gemini-3.5-flash',
                kind: 'model',
                capabilities: {},
                isDefault: false
            },
            {
                modelKey: 'gemini-2.5-pro',
                kind: 'model',
                capabilities: {},
                isDefault: true
            },
            {
                modelKey: 'gemini-2.5-flash',
                kind: 'model',
                capabilities: {},
                isDefault: false
            }
        ]
    } as const
    const enums = {
        codex: {
            speed: [
                { value: 'standard', isDefault: true },
                { value: 'fast', isDefault: false }
            ],
            intelligence: [
                { value: 'low', isDefault: false },
                { value: 'medium', isDefault: true },
                { value: 'high', isDefault: false },
                { value: 'xhigh', isDefault: false }
            ]
        },
        'claude-code': {
            effort: [
                { value: 'low', isDefault: false },
                { value: 'medium', isDefault: true },
                { value: 'high', isDefault: false },
                { value: 'xhigh', isDefault: false },
                { value: 'max', isDefault: false }
            ]
        }
    } as Record<
        string,
        Record<string, Array<{ value: string; isDefault: boolean }>>
    >
    return {
        listModels: async (framework: string) =>
            (models[framework as keyof typeof models] ?? []).map((m) => ({
                ...m,
                id: `fmc_${framework}_${m.modelKey}`,
                framework,
                displayName: m.modelKey,
                sortOrder: 0,
                isActive: true
            })),
        listEnums: async (framework: string, enumKey: string) =>
            (enums[framework]?.[enumKey] ?? []).map((e) => ({
                ...e,
                id: `fec_${framework}_${enumKey}_${e.value}`,
                framework,
                enumKey,
                displayName: e.value,
                sortOrder: 0,
                isActive: true
            })),
        getDefaultModel: async (framework: string, kind = 'model') => {
            const list = models[framework as keyof typeof models] ?? []
            const found = list.find((m) => m.kind === kind && m.isDefault)
            return found
                ? { ...found, framework, displayName: found.modelKey }
                : null
        },
        getDefaultEnumValue: async (framework: string, enumKey: string) => {
            const list = enums[framework]?.[enumKey] ?? []
            const found = list.find((e) => e.isDefault)
            return found
                ? { ...found, framework, enumKey, displayName: found.value }
                : null
        },
        isModelKeyActive: async (framework: string, modelKey: string) => {
            const list = models[framework as keyof typeof models] ?? []
            return list.some((m) => m.modelKey === modelKey)
        },
        isEnumValueActive: async (
            framework: string,
            enumKey: string,
            value: string
        ) => {
            const list = enums[framework]?.[enumKey] ?? []
            return list.some((e) => e.value === value)
        },
        modelHasCapability: async (
            framework: string,
            modelKey: string,
            capability: string
        ) => {
            const list = models[framework as keyof typeof models] ?? []
            const found = list.find((m) => m.modelKey === modelKey)
            return (
                (found?.capabilities as Record<string, unknown>)?.[
                    capability
                ] === true
            )
        }
    }
}

const makeService = (
    db: FakeDb,
    models: string[] | null,
    daemonRegistry?: { rpc: () => Promise<Record<string, unknown>> },
    execDrivers?: { forAgent: () => Promise<unknown> },
    enabledModels: ProtocolModelMap | null = null
): AgentModelConfigService =>
    new AgentModelConfigService(
        db as never,
        {
            decrypt: ({ ciphertext }: { ciphertext: string }) => ciphertext
        } as never,
        {
            findByApiKey: async () => {
                const provider =
                    db.agent.framework === 'claude-code'
                        ? 'anthropic'
                        : db.agent.framework === 'gemini-cli'
                          ? 'google'
                          : 'openai'
                const protocol =
                    provider === 'anthropic'
                        ? 'anthropic_messages'
                        : provider === 'google'
                          ? 'google_generate_content'
                          : 'openai_responses'
                return {
                    id: 'provider-1',
                    label: 'Provider',
                    provider,
                    inferenceProtocol: protocol,
                    builtInId: null,
                    apiKeyMasked: 'sk-***test',
                    baseUrl: null,
                    modelsListUrl: null,
                    source: 'user',
                    managedService: null,
                    managedKeyId: null,
                    lastTestedAt: date.toISOString(),
                    lastTestStatus: 'ok',
                    lastTestMessage: null,
                    lastTestModels:
                        models === null ? null : { [protocol]: models },
                    enabledModels,
                    createdAt: date.toISOString(),
                    updatedAt: date.toISOString()
                }
            },
            testSaved: async () => ({
                ok: true,
                status: 'ok',
                message: null,
                latencyMs: 1,
                models: (models ?? []).map((id) => ({ id }))
            }),
            testInline: async () => ({
                ok: true,
                status: 'ok',
                message: null,
                latencyMs: 1,
                models: (models ?? []).map((id) => ({ id }))
            })
        } as never,
        makeFakeCatalog() as never,
        daemonRegistry as never,
        execDrivers as never
    )

const chunks = async function* (...values: string[]): AsyncIterable<string> {
    for (const value of values) yield value
}

class FakeDb {
    credentialPayload: Record<string, unknown> = {}
    lastAgentPatch:
        | (Record<string, unknown> & { extras?: Record<string, unknown> })
        | null = null

    constructor(
        public agent: Record<string, unknown> & {
            extras?: Record<string, unknown>
        }
    ) {}

    select(): FakeQuery {
        return new FakeQuery(this, 'select')
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private table: unknown
    private patch: Record<string, unknown> = {}

    constructor(
        private readonly db: FakeDb,
        private readonly kind: 'select' | 'update',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown): this {
        this.table = table
        return this
    }

    where(): this {
        return this
    }

    limit(): this {
        return this
    }

    set(patch: Record<string, unknown>): this {
        const merge = readJsonbMergePatch(patch.extras)
        const resolved = merge
            ? {
                  ...patch,
                  extras: {
                      ...((this.db.agent.extras as
                          | Record<string, unknown>
                          | undefined) ?? {}),
                      ...merge
                  }
              }
            : patch
        this.patch = resolved
        if (this.table === agents) this.db.lastAgentPatch = resolved
        return this
    }

    returning(): Promise<unknown[]> {
        if (this.kind === 'update' && this.table === agents) {
            this.db.agent = {
                ...this.db.agent,
                ...this.patch
            }
            return Promise.resolve([this.db.agent])
        }
        return Promise.resolve([])
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | undefined
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | undefined
            | null
    ): PromiseLike<TResult1 | TResult2> {
        const value =
            this.table === agents
                ? [this.db.agent]
                : this.table === agentCredentials
                  ? [
                        {
                            runtimeId: 'runtime-1',
                            payloadCiphertext: JSON.stringify(
                                this.db.credentialPayload
                            ),
                            keyVersion: 1
                        }
                    ]
                  : []
        return Promise.resolve(value).then(onfulfilled, onrejected)
    }
}
