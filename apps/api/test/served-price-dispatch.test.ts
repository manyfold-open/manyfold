import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import { UsagePricingEngine } from '../src/modules/usage/usage-pricing.service'
import {
    UNKNOWN_PRICE_SCOPE,
    type ServedPriceScope
} from '../src/modules/usage/served-price-scope'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import type { ExecStreamRequest } from '../src/modules/chat/adapters/exec-driver'

const original: ServedPriceScope = {
    modelProviderId: 'provider-original',
    modelProviderBuiltInId: null,
    modelProviderManagedBrand: 'fixture-brand'
}
const makePricing = async () => {
    const pricing = new UsagePricingEngine({
        loadSnapshot: async (source) => ({
            prices: { 'shared-model': { input_cost_per_token: 0.000001 } },
            etag: source === 'litellm' ? '1:fixture' : '2:fixture',
            fetchedAt: new Date()
        }),
        loadPriceConfig: async () => ({
            overrides: new Map(),
            pins: new Map(),
            scopes: new Map([
                [
                    'managed:fixture-brand',
                    new Map([
                        [
                            'shared-model',
                            { override: { input_cost_per_token: 0.000007 } }
                        ]
                    ])
                ]
            ])
        })
    })
    await pricing.ensureLoaded()
    return pricing
}
const drain = async (events: AsyncIterable<EmittedChatEvent>) => {
    const result: EmittedChatEvent[] = []
    for await (const event of events) result.push(event)
    return result
}
const message = {
    id: 'prompt',
    sessionId: 'session',
    role: 'user' as const,
    contentBlocks: [{ type: 'text' as const, text: 'Fixture prompt' }],
    createdAt: new Date().toISOString()
}

test('Gemini platform execution refuses an old daemon before scope resolution or dispatch', async () => {
    let resolutions = 0,
        dispatches = 0
    const adapter = new GeminiCliAdapter(
        {
            forAgent: async () => ({
                runtime: 'daemon',
                agent: {},
                creds: { googleApiKey: 'fixture' },
                supportsExecResources: async () => false,
                resolvePriceScope: async () => {
                    resolutions++
                    return original
                },
                driver: {
                    stream: () => {
                        dispatches++
                        throw new Error('unexpected dispatch')
                    }
                }
            })
        } as never,
        {} as never,
        {} as never
    )
    const events = await drain(
        adapter.sendMessage(
            {
                framework: 'gemini-cli',
                runtimeKind: 'daemon',
                model: 'shared-model',
                modelConfig: { framework: 'gemini-cli', model: 'shared-model' },
                history: []
            } as unknown as ApiChatAdapterContext,
            message
        )
    )
    assert.equal(
        events[0]?.type === 'error' && events[0].error.code,
        'gemini_platform_exec_unsupported'
    )
    assert.equal(resolutions, 0)
    assert.equal(dispatches, 0)
})

for (const framework of ['codex', 'gemini-cli'] as const) {
    const handle = () => ({
        stdout: (async function* () {
            yield JSON.stringify(
                framework === 'codex'
                    ? {
                          type: 'turn.completed',
                          model: 'shared-model',
                          usage: { input_tokens: 1000000, output_tokens: 0 }
                      }
                    : {
                          type: 'result',
                          status: 'success',
                          stats: {
                              models: {
                                  'shared-model': {
                                      input_tokens: 1000000,
                                      output_tokens: 0
                                  }
                              }
                          }
                      }
            ) + '\n'
        })(),
        stderr: (async function* () {})(),
        result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
        abort: () => {}
    })
    for (const runtime of ['daemon', 'sprites', 'k8s'] as const) {
        for (const mode of ['platform', 'local', 'profile'] as const) {
            test(`${framework} ${runtime} ${mode} prices only the frozen dispatched scope`, async () => {
                const order: string[] = []
                const requests: ExecStreamRequest[] = []
                let stamped: ServedPriceScope | undefined
                let resolutions = 0
                const drivers = {
                    forAgent: async () => ({
                        agent: {
                            daemonId: 'fixture-daemon',
                            workspacePath: '/fixture'
                        },
                        runtime,
                        creds: {
                            openaiApiKey: 'fixture',
                            googleApiKey: 'fixture',
                            openaiBaseUrl: 'https://fixture.invalid',
                            googleGeminiBaseUrl: 'https://fixture.invalid'
                        },
                        resolvePriceScope: async () => {
                            resolutions++
                            if (mode !== 'platform')
                                throw new Error(
                                    'stale provider cannot be decrypted'
                                )
                            return original
                        },
                        supportsExecResources: async () => true,
                        authContext:
                            mode === 'profile'
                                ? { profileId: 'fixture-profile' }
                                : null,
                        driver: {
                            stream: (request: ExecStreamRequest) => {
                                order.push('dispatch')
                                requests.push(request)
                                return handle()
                            }
                        }
                    })
                }
                const Adapter =
                    framework === 'codex' ? CodexAdapter : GeminiCliAdapter
                const adapter = new Adapter(
                    drivers as never,
                    {} as never,
                    (await makePricing()) as never
                )
                const ctx = {
                    agentId: 'agent',
                    sessionId: 'session',
                    messageId: 'message',
                    framework,
                    runtimeKind: runtime,
                    model: 'shared-model',
                    modelOverride: null,
                    modelProviderManagedBrand: 'wrong-current-brand',
                    modelConfig:
                        mode === 'local'
                            ? null
                            : { framework, model: 'shared-model' },
                    runtimeLocalTuning: mode === 'local' ? {} : null,
                    frameworkSessionRef: null,
                    history: [],
                    onServedPriceScope: async (scope: ServedPriceScope) => {
                        order.push('stamp')
                        stamped = scope
                    }
                } as unknown as ApiChatAdapterContext
                const events = await drain(adapter.sendMessage(ctx, message))
                assert.deepEqual(order, ['stamp', 'dispatch'])
                assert.deepEqual(
                    stamped,
                    mode === 'platform' ? original : UNKNOWN_PRICE_SCOPE
                )
                assert.equal(resolutions, mode === 'platform' ? 1 : 0)
                const usage = events.find((event) => event.type === 'usage')
                assert.equal(
                    usage?.type === 'usage' && usage.usage.costUsd,
                    mode === 'platform' ? 7 : 1
                )
                assert.equal(Boolean(requests[0].env), mode === 'platform')
                if (mode !== 'platform')
                    assert.ok(
                        !requests[0].cmd.some((part) =>
                            part.includes('mf-gemini-platform-')
                        )
                    )
            })
        }
    }
    test(`${framework} metadata failure stops before dispatch`, async () => {
        let dispatches = 0
        const Adapter = framework === 'codex' ? CodexAdapter : GeminiCliAdapter
        const adapter = new Adapter(
            {
                forAgent: async () => ({
                    runtime: 'daemon',
                    agent: {},
                    creds: { openaiApiKey: 'fixture', googleApiKey: 'fixture' },
                    resolvePriceScope: async () => original,
                    supportsExecResources: async () => true,
                    driver: {
                        stream: () => {
                            dispatches++
                            return handle()
                        }
                    }
                })
            } as never,
            {} as never,
            (await makePricing()) as never
        )
        await assert.rejects(
            drain(
                adapter.sendMessage(
                    {
                        framework,
                        runtimeKind: 'daemon',
                        model: 'shared-model',
                        modelConfig: { framework, model: 'shared-model' },
                        history: [],
                        onServedPriceScope: async () => {
                            throw new Error('scope unavailable')
                        }
                    } as unknown as ApiChatAdapterContext,
                    message
                )
            ),
            /scope unavailable/
        )
        assert.equal(dispatches, 0)
    })
    test(`${framework} resumed usage uses the original scope without resolving current credentials`, async () => {
        let freshReads = 0
        const Adapter = framework === 'codex' ? CodexAdapter : GeminiCliAdapter
        const adapter = new Adapter(
            {
                forAgent: async () => {
                    freshReads++
                    throw new Error('must not resolve current credentials')
                },
                daemonDriverFor: () => ({ resumeStream: () => handle() }),
                recoveryFsForAgent: async () => ({
                    fs: { exec: async () => '1' }
                })
            } as never,
            { setRuntimeSourceCursor: async () => {} } as never,
            (await makePricing()) as never
        )
        const events = await drain(
            adapter.resumeMessage({
                framework,
                runtimeKind: 'daemon',
                agentId: 'agent',
                sessionId: 'session',
                messageId: 'message',
                model: 'shared-model',
                daemonId: 'fixture-daemon',
                daemonExecRef: 'fixture-ref',
                fromSeq: 0,
                frameworkSessionRef: null,
                ...original
            } as never)
        )
        assert.equal(freshReads, 0)
        const usage = events.find((event) => event.type === 'usage')
        assert.equal(usage?.type === 'usage' && usage.usage.costUsd, 7)
    })
}
