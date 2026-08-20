import assert from 'node:assert/strict'
import test from 'node:test'
import {
    UsagePricingEngine,
    buildPricingIndex,
    costFromPrice,
    matchModelPricing,
    overridePricingFromRows,
    parseLiteLlmPricing,
    parseModelsDevPricing,
    parseNetmindPricing,
    pinsFromRows,
    scopedPricesFromRows,
    type LiteLlmModelPricing,
    type ModelPriceSource,
    type ModelPriceSnapshotPayload,
    type UsagePricingInput,
    type UsagePricingOptions
} from '../src/modules/usage/usage-pricing.service'
import { buildOpenAiUsage } from '../src/modules/chat/adapters/openai-usage'
import { LITELLM_PRICING_SAMPLE } from './litellm-pricing-sample'
import { NETMIND_PRICING_SAMPLE } from './netmind-pricing-sample'

// The engine seeds from model_price_snapshots now, so every test that needs a
// table hands one over the same way the repository would.
const storedSnapshot = (
    prices: Record<string, LiteLlmModelPricing>
): ModelPriceSnapshotPayload => ({
    prices,
    etag: null,
    fetchedAt: new Date()
})

const offline = async (): Promise<never> => {
    throw new Error('offline')
}

const findModelPricing = (
    prices: Map<string, LiteLlmModelPricing>,
    model: string | null
): LiteLlmModelPricing | null =>
    matchModelPricing(buildPricingIndex(prices), model)?.pricing ?? null

const costFromPricingMap = (
    prices: Map<string, LiteLlmModelPricing>,
    usage: UsagePricingInput
) => costFromPrice(findModelPricing(prices, usage.model), usage)

const seededEngine = (
    stored: Partial<
        Record<ModelPriceSource, Record<string, LiteLlmModelPricing>>
    >,
    options: UsagePricingOptions = {}
): UsagePricingEngine =>
    new UsagePricingEngine({
        fetchPricing: offline,
        fetchModelsDev: offline,
        fetchNetmind: offline,
        loadSnapshot: async (source) => {
            const prices = stored[source]
            return prices ? storedSnapshot(prices) : null
        },
        ...options
    })

const pricing = parseLiteLlmPricing({
    'gpt-5': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000001,
        cache_creation_input_token_cost: 0.000002
    },
    'openai/gpt-4o-mini': {
        input_cost_per_token: 0.00000015,
        output_cost_per_token: 0.0000006
    },
    'no-cache-rate': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002
    }
})

test('findModelPricing resolves aliases and provider prefixes', () => {
    assert.equal(findModelPricing(pricing, 'gpt-5-codex'), pricing.get('gpt-5'))
    assert.equal(
        findModelPricing(pricing, 'gpt-4o-mini'),
        pricing.get('openai/gpt-4o-mini')
    )
})

test('findModelPricing never collapses versioned ids onto a shorter base id', () => {
    assert.equal(findModelPricing(pricing, 'gpt-5.5'), null)
    assert.equal(findModelPricing(pricing, 'gpt-5.4-mini'), null)

    const snapshot = parseLiteLlmPricing(
        LITELLM_PRICING_SAMPLE as unknown as Record<string, unknown>
    )
    assert.equal(
        findModelPricing(snapshot, 'gpt-5.5')?.output_cost_per_token,
        0.00003
    )
    assert.equal(
        findModelPricing(snapshot, 'gpt-5.6-luna')?.input_cost_per_token,
        0.000001
    )
    assert.equal(
        findModelPricing(snapshot, 'gpt-5.5-2026-04-23')?.output_cost_per_token,
        0.00003
    )
    assert.equal(
        findModelPricing(snapshot, 'gpt-5.4-mini')?.input_cost_per_token,
        0.00000075
    )
})

test('costFromPrice does not double-charge cached input', () => {
    const cost = costFromPricingMap(pricing, {
        model: 'gpt-5',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 200,
        cacheCreationTokens: 100
    })

    assert.equal(cost.costSource, 'table')
    assert.equal(cost.costUsd, 0.00192)
})

test('costFromPrice falls back to input price for cache reads', () => {
    const cost = costFromPricingMap(pricing, {
        model: 'no-cache-rate',
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 200,
        cacheCreationTokens: 0
    })

    assert.equal(cost.costSource, 'table')
    assert.equal(cost.costUsd, 0.001)
})

test('costFromPrice preserves non-cache Anthropic input', () => {
    const cost = costFromPricingMap(pricing, {
        model: 'gpt-5',
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        inputTokensIncludeCache: false
    })

    assert.equal(cost.costSource, 'table')
    assert.equal(cost.costUsd, 0.00122)
})

test('snapshot prices Claude 5 models and legacy Opus at published rates', () => {
    const snapshot = parseLiteLlmPricing(
        LITELLM_PRICING_SAMPLE as unknown as Record<string, unknown>
    )

    assert.equal(
        findModelPricing(snapshot, 'claude-fable-5')?.input_cost_per_token,
        0.00001
    )
    assert.equal(
        findModelPricing(snapshot, 'claude-opus-4-8')?.output_cost_per_token,
        0.000025
    )
    assert.equal(
        findModelPricing(snapshot, 'claude-sonnet-5')?.input_cost_per_token,
        0.000003
    )
    assert.equal(
        findModelPricing(snapshot, 'claude-opus-4-7')?.output_cost_per_token,
        0.000025
    )
    assert.equal(
        findModelPricing(snapshot, 'claude-opus-4-6')?.input_cost_per_token,
        0.000005
    )
    assert.equal(
        findModelPricing(snapshot, 'claude-sonnet-5-20260610')
            ?.input_cost_per_token,
        0.000003
    )
})

// The stored snapshot is the whole reason it lives in Postgres rather than in a
// file: an API that boots with both origins unreachable still bills correctly,
// and metering never waits on the network to answer.
test('UsagePricingEngine prices from the stored snapshot while both fetches fail', async () => {
    const engine = seededEngine({ litellm: LITELLM_PRICING_SAMPLE })
    await engine.ensureLoaded()

    const started = Date.now()
    const cost = engine.computeCost({
        model: 'gpt-5-codex',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 100,
        cacheCreationTokens: 0
    })

    assert.equal(cost.costSource, 'table')
    assert.equal(engine.resolvePricing('gpt-5-codex')?.source, 'litellm')
    assert.ok(Date.now() - started < 50)
})

test('a cold engine reports no price rather than blocking a turn', () => {
    const engine = seededEngine({})

    assert.equal(
        engine.computeCost({
            model: 'gpt-5',
            inputTokens: 1000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0
        }).costSource,
        'unknown'
    )
})

// The gateway exposes gemini 3.6 only as reasoning tiers (-high/-medium/-low/
// -tiered); none of them exist upstream as their own price rows. They resolve
// off the base id via the boundary match, so a missing base id means every
// tiered turn silently records tokens with no cost at all.
test('snapshot prices the gemini 3.x gateway tiers off their base id', () => {
    const snapshot = parseLiteLlmPricing(
        LITELLM_PRICING_SAMPLE as unknown as Record<string, unknown>
    )
    const tiers = [
        'gemini-3.6-flash-high',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-low',
        'gemini-3.6-flash-tiered',
        'gemini-3.5-flash-low',
        'gemini-3.5-flash-extra-low'
    ]

    for (const model of tiers) {
        const cost = costFromPricingMap(snapshot, {
            model,
            inputTokens: 1000,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0
        })
        assert.equal(cost.costSource, 'table', model)
        assert.ok((cost.costUsd ?? 0) > 0, model)
    }

    assert.equal(
        findModelPricing(snapshot, 'gemini-3.6-flash-high'),
        snapshot.get('gemini-3.6-flash')
    )
})

// Admin-configured catalog prices are the operator's answer to "this model bills
// nothing"; they must beat whatever the LiteLLM table guessed for the same id.
test('port-fed override rows beat the LiteLLM table for the same model', async () => {
    const rows = [
        {
            modelId: 'gpt-5',
            inputCostPerToken: '0.000002',
            outputCostPerToken: '0.000020',
            cacheReadCostPerToken: null,
            cacheCreationCostPerToken: null
        }
    ]
    const engine = seededEngine(
        {
            litellm: {
                'gpt-5': {
                    input_cost_per_token: 0.00000125,
                    output_cost_per_token: 0.00001
                }
            }
        },
        {
            loadPriceConfig: async () => ({
                overrides: overridePricingFromRows(rows),
                pins: pinsFromRows(rows),
                scopes: new Map()
            }),
            overrideTtlMs: 0
        }
    )

    await engine.ensureLoaded()
    // The override map loads on its own TTL; one priming call arms it.
    engine.computeCost({
        model: 'gpt-5',
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    })
    await new Promise((resolve) => setImmediate(resolve))

    const cost = engine.computeCost({
        model: 'gpt-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    })

    assert.equal(cost.costSource, 'table')
    assert.equal(cost.costUsd, 2)
    assert.equal(engine.resolvePricing('gpt-5')?.source, 'override')
})

// Overrides are matched exactly on purpose: the fuzzy boundary match exists to
// stretch a sparse public table over id variants, but an operator typing a price
// for `gpt-5` must never silently reprice `gpt-5.5`.
test('port-fed override rows never fuzzy-match a different model', async () => {
    const rows = [
        {
            modelId: 'gpt-5',
            inputCostPerToken: '0.000002',
            outputCostPerToken: '0.00002',
            cacheReadCostPerToken: null,
            cacheCreationCostPerToken: null
        }
    ]
    const engine = seededEngine(
        {
            litellm: {
                'gpt-5.5': {
                    input_cost_per_token: 0.000005,
                    output_cost_per_token: 0.00003
                }
            }
        },
        {
            loadPriceConfig: async () => ({
                overrides: overridePricingFromRows(rows),
                pins: pinsFromRows(rows),
                scopes: new Map()
            }),
            overrideTtlMs: 0
        }
    )

    await engine.ensureLoaded()
    engine.computeCost({
        model: 'gpt-5.5',
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(engine.resolvePricing('gpt-5.5')?.source, 'litellm')
    const cost = engine.computeCost({
        model: 'gpt-5.5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    })
    assert.equal(cost.costUsd, 5)
})

// hasPricing gates whether a newly discovered model may auto-enable, so an
// unknown id has to read as unpriced rather than "probably fine".
test('hasPricing is false for a model no table or override knows', async () => {
    const engine = seededEngine({ litellm: LITELLM_PRICING_SAMPLE })
    await engine.ensureLoaded()

    assert.equal(engine.hasPricing('gpt-5'), true)
    assert.equal(engine.hasPricing('totally-made-up-model-xyz'), false)
    assert.equal(engine.resolvePricing('totally-made-up-model-xyz'), null)
})

// `gemini-3-pro` used to resolve to `gemini-3-pro-image` — an image model's rate
// applied to text turns — because the fuzzy match scored by substring length and
// broke ties on whatever order LiteLLM's JSON happened to be in. A suffix that
// names a different product now disqualifies the pair outright.
test('a product suffix never prices a different product', async () => {
    const engine = seededEngine({
        litellm: {
            'gemini-3-pro-image': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.00012
            },
            'gemini-3-pro-preview': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.000012
            }
        }
    })
    await engine.ensureLoaded()

    assert.equal(
        engine.resolvePricing('gemini-3-pro')?.key,
        'gemini-3-pro-preview'
    )
    // Nothing but the image row is left, and it must not be borrowed.
    const imageOnly = seededEngine({
        litellm: {
            'gemini-3-pro-image': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.00012
            }
        }
    })
    await imageOnly.ensureLoaded()
    assert.equal(imageOnly.resolvePricing('gemini-3-pro'), null)
})

// The antigravity channel serves reasoning budgets as their own ids and nothing
// upstream prices them. Six of them were metering at zero cost on real data:
// direction-A matching only rescues the ones whose base id happens to be a key,
// and `gemini-3-pro` is not — only `gemini-3-pro-preview` is. Stripping the tier
// lets the budget ride the base model it bills as.
test('a reasoning tier prices off the base model even when the base is not a key', async () => {
    const engine = seededEngine({
        litellm: {
            'gemini-3-pro-preview': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.000012
            },
            'gemini-3-pro-image': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.00012
            }
        }
    })
    await engine.ensureLoaded()

    for (const tier of [
        'gemini-3-pro-high',
        'gemini-3-pro-medium',
        'gemini-3-pro-low',
        'gemini-3-pro-tiered'
    ])
        assert.equal(
            engine.resolvePricing(tier)?.key,
            'gemini-3-pro-preview',
            tier
        )

    // Stripping removes only the budget, so the product it belongs to is kept:
    // an image model at a high budget still bills at the image model's rate.
    assert.equal(
        engine.resolvePricing('gemini-3-pro-image-high')?.key,
        'gemini-3-pro-image'
    )
})

// A size tier is its own price. `gpt-5.4-mini` must never be billed at the
// `gpt-5.4` rate just because the id starts the same way.
test('a size suffix never inherits the base model price', async () => {
    const engine = seededEngine({
        litellm: {
            'gpt-5.4': {
                input_cost_per_token: 0.0000025,
                output_cost_per_token: 0.000015
            }
        }
    })
    await engine.ensureLoaded()

    assert.equal(engine.resolvePricing('gpt-5.4-mini'), null)
})

// A reseller republishes the same model at its own markup. Whoever makes the
// model prices it; anything else is only reachable by an admin pinning it.
test('a reseller key loses to the official record', async () => {
    const engine = seededEngine({
        litellm: {
            'openrouter/google/gemini-3-flash-preview': {
                input_cost_per_token: 0.000009,
                output_cost_per_token: 0.000009
            },
            'vertex_ai/gemini-3-flash-preview': {
                input_cost_per_token: 0.0000007,
                output_cost_per_token: 0.000004
            },
            'gemini-3-flash-preview': {
                input_cost_per_token: 0.0000005,
                output_cost_per_token: 0.000003
            }
        }
    })
    await engine.ensureLoaded()

    const resolved = engine.resolvePricing('gemini-3-flash')
    assert.equal(resolved?.key, 'gemini-3-flash-preview')
    assert.equal(resolved?.pricing.input_cost_per_token, 0.0000005)
})

// models.dev publishes per MILLION tokens; everything downstream is per token.
// Getting this wrong bills 1e6 times over. Every provider is ingested — a
// reseller's rate is what a BYO key really pays, so it must be pinnable — but
// only official namespaces may feed the automatic matcher (next test).
test('parseModelsDevPricing converts per-million costs across every provider', () => {
    const parsed = parseModelsDevPricing({
        anthropic: {
            models: {
                'claude-opus-4-6': {
                    cost: {
                        input: 5,
                        output: 25,
                        cache_read: 0.5,
                        cache_write: 6.25
                    }
                }
            }
        },
        openrouter: {
            models: {
                'claude-opus-4-6': { cost: { input: 9, output: 40 } }
            }
        }
    })

    assert.equal(
        parsed.get('anthropic/claude-opus-4-6')?.input_cost_per_token,
        0.000005
    )
    assert.equal(
        parsed.get('anthropic/claude-opus-4-6')
            ?.cache_creation_input_token_cost,
        0.00000625
    )
    assert.equal(
        parsed.get('openrouter/claude-opus-4-6')?.input_cost_per_token,
        0.000009
    )
})

// Reseller records are reachable ONLY by deliberate pin or search: an id that
// exists nowhere official must stay unpriced rather than quietly adopting a
// reseller's markup.
test('a reseller-only models.dev record never feeds the automatic match', async () => {
    const engine = seededEngine({
        models_dev: {
            'zhipuai/glm-4.5-flash': {
                input_cost_per_token: 0.0000006,
                output_cost_per_token: 0.0000022
            }
        }
    })
    await engine.ensureLoaded()

    assert.equal(engine.resolvePricing('glm-4.5-flash'), null)

    const candidates = engine.priceCandidates('glm-4.5-flash', 'glm')
    const reseller = candidates.find((c) => c.key === 'zhipuai/glm-4.5-flash')
    assert.equal(reseller?.source, 'models_dev')
    assert.equal(reseller?.official, false)
    assert.equal(reseller?.matchKind, 'search')
})

// A stored snapshot from an older parser must not survive on freshness alone:
// a recent fetchedAt skips the fetch and a matching origin etag would 304 it,
// so the narrow parse would persist forever. A version mismatch forces one
// full refetch; a current version keeps trusting the row.
test('a snapshot from an older parse version is refetched immediately', async () => {
    const fetches: Array<string | null> = []
    const engine = new UsagePricingEngine({
        fetchPricing: offline,
        fetchNetmind: offline,
        fetchModelsDev: async (etag) => {
            fetches.push(etag ?? null)
            return {
                raw: {
                    zhipuai: {
                        models: {
                            'glm-4.5-flash': { cost: { input: 1, output: 2 } }
                        }
                    }
                },
                etag: '"fresh"'
            }
        },
        loadSnapshot: async (source) =>
            source === 'models_dev'
                ? {
                      prices: {
                          'google/old-model': {
                              input_cost_per_token: 0.000001,
                              output_cost_per_token: 0.00001
                          }
                      },
                      // Legacy unversioned etag = parse version 1.
                      etag: '"stale"',
                      fetchedAt: new Date()
                  }
                : null
    })
    await engine.ensureLoaded()

    // Full fetch (no If-None-Match), and the new parse replaced the old rows.
    assert.deepEqual(fetches, [null])
    assert.equal(
        engine.resolvePricing('zhipuai/glm-4.5-flash')?.source,
        'models_dev'
    )

    const current = new UsagePricingEngine({
        fetchPricing: offline,
        fetchNetmind: offline,
        fetchModelsDev: async () => {
            throw new Error('must not fetch: version is current and row fresh')
        },
        loadSnapshot: async (source) =>
            source === 'models_dev'
                ? {
                      prices: {
                          'google/kept-model': {
                              input_cost_per_token: 0.000001,
                              output_cost_per_token: 0.00001
                          }
                      },
                      etag: '2:"stale"',
                      fetchedAt: new Date()
                  }
                : null
    })
    await current.ensureLoaded()
    assert.equal(
        current.resolvePricing('google/kept-model')?.source,
        'models_dev'
    )
})

// `gemini-3.1-flash-lite-image` is the case that forces quality-major ordering:
// LiteLLM has no such key and its nearest neighbour is a TEXT model, while
// models.dev prices the image model outright. An exact record must beat a guess
// even when it comes from the lower-priority table.
test('an exact models.dev record beats a fuzzy litellm guess', async () => {
    const engine = seededEngine({
        litellm: {
            'gemini-3.1-flash-lite': {
                input_cost_per_token: 0.0000001,
                output_cost_per_token: 0.0000004
            }
        },
        models_dev: {
            'google/gemini-3.1-flash-lite-image': {
                input_cost_per_token: 0.00000025,
                output_cost_per_token: 0.00003
            }
        }
    })
    await engine.ensureLoaded()

    const resolved = engine.resolvePricing('gemini-3.1-flash-lite-image')
    assert.equal(resolved?.source, 'models_dev')
    assert.equal(resolved?.key, 'google/gemini-3.1-flash-lite-image')
    assert.equal(resolved?.pricing.output_cost_per_token, 0.00003)

    // LiteLLM still wins where it actually knows the model.
    assert.equal(
        engine.resolvePricing('gemini-3.1-flash-lite')?.source,
        'litellm'
    )
})

// A pin is an operator's deliberate answer, so it is read EXACTLY. If the record
// disappears upstream the model must read as unpriced — sliding onto the next
// fuzzy candidate would silently reprice it behind the operator's back.
test('a pin resolves exactly and never falls back when its record is gone', async () => {
    const table = {
        litellm: {
            'gemini-3-pro-preview': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.000012
            }
        },
        models_dev: {
            'google/gemini-3-pro-preview': {
                input_cost_per_token: 0.000004,
                output_cost_per_token: 0.000018
            }
        }
    }
    const pinRows = (key: string) => [
        {
            modelId: 'gemini-3-pro',
            inputCostPerToken: null,
            outputCostPerToken: null,
            cacheReadCostPerToken: null,
            cacheCreationCostPerToken: null,
            priceRefSource: 'models_dev' as const,
            priceRefKey: key
        }
    ]

    const pinned = seededEngine(table, {
        loadPriceConfig: async () => ({
            overrides: overridePricingFromRows(
                pinRows('google/gemini-3-pro-preview')
            ),
            pins: pinsFromRows(pinRows('google/gemini-3-pro-preview')),
            scopes: new Map()
        }),
        overrideTtlMs: 0
    })
    await pinned.ensureLoaded()
    await pinned.refreshOverridesNow()

    const resolved = pinned.resolvePricing('gemini-3-pro')
    assert.equal(resolved?.source, 'models_dev')
    assert.equal(resolved?.pinned, true)
    assert.equal(resolved?.pricing.input_cost_per_token, 0.000004)

    const stale = seededEngine(table, {
        loadPriceConfig: async () => ({
            overrides: overridePricingFromRows(pinRows('google/retired-model')),
            pins: pinsFromRows(pinRows('google/retired-model')),
            scopes: new Map()
        }),
        overrideTtlMs: 0
    })
    await stale.ensureLoaded()
    await stale.refreshOverridesNow()

    assert.equal(stale.resolvePricing('gemini-3-pro'), null)
    assert.equal(stale.hasPricing('gemini-3-pro'), false)
})

// A row with no usable numbers is not an override: dropping it keeps the model
// on the public pricing tables instead of pricing every token at zero.
test('overridePricingFromRows ignores rows with no input or output price', () => {
    const map = overridePricingFromRows([
        {
            modelId: 'cache-only',
            inputCostPerToken: null,
            outputCostPerToken: null,
            cacheReadCostPerToken: '0.0000001',
            cacheCreationCostPerToken: null
        },
        {
            modelId: 'Priced-Model',
            inputCostPerToken: '0.000001',
            outputCostPerToken: null,
            cacheReadCostPerToken: null,
            cacheCreationCostPerToken: null
        }
    ])

    assert.equal(map.has('cache-only'), false)
    assert.equal(map.get('priced-model')?.input_cost_per_token, 0.000001)
})

// ---------------------------------------------------------------------------
// Scoped prices: a user's own provider row beats admin's built-in default,
// which beats the port-fed global override layer, which beats the tables.
// ---------------------------------------------------------------------------

const scopedConfig =
    (): UsagePricingOptions['loadPriceConfig'] => async () => ({
        overrides: overridePricingFromRows([
            {
                modelId: 'gpt-5',
                inputCostPerToken: '0.000003',
                outputCostPerToken: '0.00003',
                cacheReadCostPerToken: null,
                cacheCreationCostPerToken: null
            }
        ]),
        pins: pinsFromRows([]),
        scopes: scopedPricesFromRows([
            {
                providerId: 'ump_row1',
                builtInId: null,
                modelId: 'gpt-5',
                inputCostPerToken: '0.000001',
                outputCostPerToken: '0.00001',
                cacheReadCostPerToken: null,
                cacheCreationCostPerToken: null,
                priceRefSource: null,
                priceRefKey: null
            },
            {
                providerId: null,
                builtInId: 'netmind',
                modelId: 'gpt-5',
                inputCostPerToken: '0.000002',
                outputCostPerToken: '0.00002',
                cacheReadCostPerToken: null,
                cacheCreationCostPerToken: null,
                priceRefSource: null,
                priceRefKey: null
            }
        ])
    })

test('scope precedence: provider row beats built-in default beats global', async () => {
    const engine = seededEngine(
        { litellm: { 'gpt-5': { input_cost_per_token: 0.000009 } } },
        { loadPriceConfig: scopedConfig(), overrideTtlMs: 0 }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    const rowHit = engine.resolvePricing('gpt-5', {
        modelProviderId: 'ump_row1',
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(rowHit?.scope, 'provider')
    assert.equal(rowHit?.pricing.input_cost_per_token, 0.000001)

    const builtInHit = engine.resolvePricing('gpt-5', {
        modelProviderId: 'ump_other',
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(builtInHit?.scope, 'built_in')
    assert.equal(builtInHit?.pricing.input_cost_per_token, 0.000002)

    const globalHit = engine.resolvePricing('gpt-5', {
        modelProviderId: 'ump_custom',
        modelProviderBuiltInId: null
    })
    assert.equal(globalHit?.scope, 'global')
    assert.equal(globalHit?.pricing.input_cost_per_token, 0.000003)

    // No scope args at all — the global override layer's callers — must resolve
    // exactly as before scoped rows existed.
    const bare = engine.resolvePricing('gpt-5')
    assert.equal(bare?.scope, 'global')
    assert.equal(bare?.pricing.input_cost_per_token, 0.000003)

    const cost = engine.computeCost({
        model: 'gpt-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelProviderId: 'ump_row1',
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(cost.costUsd, 1)
    assert.equal(cost.costSource, 'table')
})

test('a provider-scope price never leaks to another provider id', async () => {
    const engine = seededEngine(
        {},
        { loadPriceConfig: scopedConfig(), overrideTtlMs: 0 }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    const other = engine.resolvePricing('gpt-5', {
        modelProviderId: 'ump_unrelated'
    })
    assert.equal(other?.scope, 'global')
    assert.equal(other?.pricing.input_cost_per_token, 0.000003)
})

// A scope that configures a model OWNS it: a broken pin there reads as
// unpriced rather than sliding down to a number the pinner deliberately
// replaced.
test('a broken provider-scope pin reads unpriced, not the next scope down', async () => {
    const engine = seededEngine(
        { litellm: { 'gpt-5': { input_cost_per_token: 0.000009 } } },
        {
            loadPriceConfig: async () => ({
                overrides: new Map(),
                pins: new Map(),
                scopes: scopedPricesFromRows([
                    {
                        providerId: 'ump_row1',
                        builtInId: null,
                        modelId: 'gpt-5',
                        inputCostPerToken: null,
                        outputCostPerToken: null,
                        cacheReadCostPerToken: null,
                        cacheCreationCostPerToken: null,
                        priceRefSource: 'models_dev',
                        priceRefKey: 'openai/retired-record'
                    }
                ])
            }),
            overrideTtlMs: 0
        }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    assert.equal(
        engine.resolvePricing('gpt-5', { modelProviderId: 'ump_row1' }),
        null
    )
    assert.equal(
        engine.resolvePricing('gpt-5')?.pricing.input_cost_per_token,
        0.000009
    )
})

test('within a scope a typed price beats that scope pin', async () => {
    const engine = seededEngine(
        { litellm: { 'gpt-5': { input_cost_per_token: 0.000009 } } },
        {
            loadPriceConfig: async () => ({
                overrides: new Map(),
                pins: new Map(),
                scopes: scopedPricesFromRows([
                    {
                        providerId: null,
                        builtInId: 'netmind',
                        modelId: 'gpt-5',
                        inputCostPerToken: '0.000004',
                        outputCostPerToken: '0.00004',
                        cacheReadCostPerToken: null,
                        cacheCreationCostPerToken: null,
                        priceRefSource: 'litellm',
                        priceRefKey: 'gpt-5'
                    }
                ])
            }),
            overrideTtlMs: 0
        }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    const hit = engine.resolvePricing('gpt-5', {
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(hit?.scope, 'built_in')
    assert.equal(hit?.source, 'override')
    assert.equal(hit?.pricing.input_cost_per_token, 0.000004)
})

// The admin "manual add" configures nothing; it must never shadow the scopes
// below it.
test('scopedPricesFromRows drops rows with no price and no pin', () => {
    const scopes = scopedPricesFromRows([
        {
            providerId: null,
            builtInId: 'netmind',
            modelId: 'visible-only',
            inputCostPerToken: null,
            outputCostPerToken: null,
            cacheReadCostPerToken: null,
            cacheCreationCostPerToken: null,
            priceRefSource: null,
            priceRefKey: null
        }
    ])
    assert.equal(scopes.size, 0)
})

// The usage builders thread the provider through to the engine, so the live
// HUD number and the persisted usage row are the same computation.
test('buildOpenAiUsage bills a repriced provider row at its own rate', async () => {
    const engine = seededEngine(
        { litellm: { 'gpt-5': { input_cost_per_token: 0.000009 } } },
        { loadPriceConfig: scopedConfig(), overrideTtlMs: 0 }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    const usage = buildOpenAiUsage(
        { prompt_tokens: 1_000_000, completion_tokens: 0 },
        'gpt-5',
        Date.now(),
        null,
        engine as never,
        { modelProviderId: 'ump_row1', modelProviderBuiltInId: 'netmind' }
    )
    assert.equal(usage.costUsd, 1)

    const unscoped = buildOpenAiUsage(
        { prompt_tokens: 1_000_000, completion_tokens: 0 },
        'gpt-5',
        Date.now(),
        null,
        engine as never
    )
    assert.equal(unscoped.costUsd, 3)
})

// LiteLLM's table is ~25x larger than the models.dev snapshot. A shared result
// cap filled in source order would exhaust itself on LiteLLM before the
// models.dev loop ever ran, so a flooding search term could never surface a
// models.dev record no matter how exact the hit. Each source has its own
// budget instead.
test('a flooding search term still returns models.dev results', async () => {
    const litellm: Record<string, LiteLlmModelPricing> = {}
    for (let i = 0; i < 80; i++)
        litellm[`vendor-${i}/gemini-clone-${i}`] = {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.00001
        }
    const engine = seededEngine({
        litellm,
        models_dev: {
            'google/gemini-3-flash-preview': {
                input_cost_per_token: 0.0000005,
                output_cost_per_token: 0.000003
            }
        }
    })
    await engine.ensureLoaded()

    const candidates = engine.priceCandidates('no-such-model', 'gemini')
    const bySource: Record<ModelPriceSource, number> = {
        litellm: 0,
        models_dev: 0,
        netmind: 0
    }
    for (const candidate of candidates) bySource[candidate.source]++
    assert.equal(bySource.litellm, 25)
    assert.equal(bySource.models_dev, 1)
    assert.equal(bySource.netmind, 0)
    assert.equal(
        candidates.find((c) => c.source === 'models_dev')?.key,
        'google/gemini-3-flash-preview'
    )
})

// Insertion order is whatever the upstream JSON listed first, which ranked
// arbitrary resellers ahead of the official record a searcher is looking for.
test('search results rank official records and short keys first', async () => {
    const engine = seededEngine({
        litellm: {
            'llamagate/qwen3-8b': {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.00002
            },
            'qwen3-8b-instruct-2507': {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.00001
            },
            'qwen3-8b': {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.00001
            }
        }
    })
    await engine.ensureLoaded()

    const keys = engine
        .priceCandidates('no-such-model', 'qwen3')
        .map((c) => c.key)
    assert.deepEqual(keys, [
        'qwen3-8b',
        'qwen3-8b-instruct-2507',
        'llamagate/qwen3-8b'
    ])
})

// ---------------------------------------------------------------------------
// A channel that publishes its own rates (NetMind) is priced from that table
// and nothing else, in both directions.
// ---------------------------------------------------------------------------

const netmindTable = (): Record<string, LiteLlmModelPricing> =>
    Object.fromEntries(parseNetmindPricing(NETMIND_PRICING_SAMPLE))

// Deliberately DISAGREES with NetMind on every shared id: every assertion below
// that expects NetMind's number would also pass by accident if the two tables
// agreed.
const litellmRival = (): Record<string, LiteLlmModelPricing> => ({
    'openai/gpt-5.4': {
        input_cost_per_token: 0.0000009,
        output_cost_per_token: 0.000009
    },
    'anthropic/claude-sonnet-5': {
        input_cost_per_token: 0.0000008,
        output_cost_per_token: 0.000008
    },
    'gemini-3.5-flash': {
        input_cost_per_token: 0.0000007,
        output_cost_per_token: 0.000007
    },
    'gpt-5-mini': {
        input_cost_per_token: 0.0000006,
        output_cost_per_token: 0.000006
    }
})

test('parseNetmindPricing converts per-million rates to per-token', () => {
    const prices = parseNetmindPricing(NETMIND_PRICING_SAMPLE)
    assert.deepEqual(prices.get('anthropic/claude-sonnet-5'), {
        input_cost_per_token: 2 / 1_000_000,
        output_cost_per_token: 10 / 1_000_000,
        cache_read_input_token_cost: 0.2 / 1_000_000,
        cache_creation_input_token_cost: 2.5 / 1_000_000
    })
    // Input-only rows (embeddings) still price: hasBasePrice accepts them and
    // costFromPrice bills output at 0, which is what an embedding call is.
    assert.deepEqual(prices.get('BAAI/bge-m3'), {
        input_cost_per_token: 0.01 / 1_000_000,
        output_cost_per_token: undefined,
        cache_read_input_token_cost: undefined,
        cache_creation_input_token_cost: undefined
    })
})

// Every entry nests one block per competing platform holding THAT platform's
// rate, plus a membership discount we cannot attribute to an account. Reading
// either would meter NetMind turns at a price nobody is charged.
test('parseNetmindPricing ignores member_price and competitor blocks', () => {
    const prices = parseNetmindPricing(NETMIND_PRICING_SAMPLE)
    const gpt = prices.get('openai/gpt-5.4')
    assert.equal(gpt?.input_cost_per_token, 2.5 / 1_000_000)
    // 2 = member_price, 1.25 = openai's own rate, 1.3 = openrouter's.
    for (const wrong of [2, 1.25, 1.3])
        assert.notEqual(gpt?.input_cost_per_token, wrong / 1_000_000)
    const gemini = prices.get('google/gemini-3.5-flash')
    assert.equal(gemini?.input_cost_per_token, 1.5 / 1_000_000)
    assert.notEqual(gemini?.input_cost_per_token, 0.3 / 1_000_000)
})

// Long-context bands are priced separately upstream; the whole codebase meters
// with the base rate (LiteLLM's `*_above_200k_tokens` and models.dev's `tiers`
// are dropped for the same reason).
test('parseNetmindPricing takes the base tier of a tiered model', () => {
    const prices = parseNetmindPricing(NETMIND_PRICING_SAMPLE)
    const qwen = prices.get('Qwen/Qwen3.7-Plus')
    assert.equal(qwen?.input_cost_per_token, 0.274 / 1_000_000)
    assert.notEqual(qwen?.input_cost_per_token, 0.822 / 1_000_000)
})

// billing_type is the filter, not the category name: per-Image / per-Second /
// per-Page rows are not token rates at all, and costFromPrice cannot express
// them. A new token-billed category then needs no code change.
test('parseNetmindPricing keeps only 1M Tokens rows', () => {
    const prices = parseNetmindPricing(NETMIND_PRICING_SAMPLE)
    assert.equal(prices.has('google/imagen-4.0'), false)
    assert.deepEqual(
        [...prices.keys()].sort(),
        [
            'BAAI/bge-m3',
            'Qwen/Qwen3.7-Plus',
            'anthropic/claude-sonnet-5',
            'google/gemini-3.5-flash',
            'openai/gpt-5.4'
        ].sort()
    )
})

test('parseNetmindPricing survives a body that is not the shape we expect', () => {
    assert.equal(parseNetmindPricing({}).size, 0)
    assert.equal(parseNetmindPricing({ data: 'nope' }).size, 0)
    assert.equal(
        parseNetmindPricing({
            data: { Chat: [{ model: 'x', billing_type: '1M Tokens' }] }
        }).size,
        0
    )
})

test('a NetMind turn is priced from NetMind, not from the public tables', async () => {
    const engine = seededEngine({
        litellm: litellmRival(),
        netmind: netmindTable()
    })
    await engine.ensureLoaded()

    const hit = engine.resolvePricing('openai/gpt-5.4', {
        modelProviderId: 'ump_netmind',
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(hit?.source, 'netmind')
    assert.equal(hit?.scope, 'auto')
    assert.equal(hit?.key, 'openai/gpt-5.4')
    assert.equal(hit?.pricing.input_cost_per_token, 2.5 / 1_000_000)

    const cost = engine.computeCost({
        model: 'anthropic/claude-sonnet-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputTokensIncludeCache: false,
        modelProviderId: 'ump_netmind',
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(cost.costSource, 'table')
    assert.equal(cost.costUsd, 12)
})

// The gateway's markup is the wrong number for a channel that did not serve the
// turn, and NetMind's keys sit under the same official namespaces (`openai/`,
// `anthropic/`) the matcher trusts — so without the channel rule they would win
// matches everywhere.
test('a NetMind rate never prices another channel or an unscoped turn', async () => {
    const engine = seededEngine({
        litellm: litellmRival(),
        netmind: netmindTable()
    })
    await engine.ensureLoaded()

    for (const scope of [
        { modelProviderBuiltInId: 'openai-cloud' },
        { modelProviderId: 'ump_byo', modelProviderBuiltInId: null },
        undefined
    ]) {
        const hit = engine.resolvePricing('openai/gpt-5.4', scope)
        assert.equal(hit?.source, 'litellm')
        assert.equal(hit?.pricing.input_cost_per_token, 0.0000009)
    }

    // Nothing else prices `Qwen/Qwen3.7-Plus`, so a leak would show up as a
    // resolved price rather than as the wrong one.
    assert.equal(engine.resolvePricing('Qwen/Qwen3.7-Plus'), null)
})

// The literal ask: this channel does not fall back to LiteLLM / models.dev. An
// unpriced model reads red in the admin price surface, where an override or a
// pin fixes it — it never quietly bills at the model maker's rate.
test('a NetMind model NetMind does not price reads unpriced, not LiteLLM', async () => {
    const engine = seededEngine({
        litellm: litellmRival(),
        models_dev: {
            'openai/gpt-5-mini': {
                input_cost_per_token: 0.0000005,
                output_cost_per_token: 0.000005
            }
        },
        netmind: netmindTable()
    })
    await engine.ensureLoaded()

    assert.equal(
        engine.resolvePricing('gpt-5-mini', {
            modelProviderBuiltInId: 'netmind'
        }),
        null
    )
    const cost = engine.computeCost({
        model: 'gpt-5-mini',
        inputTokens: 1_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(cost.costUsd, null)
    assert.equal(cost.costSource, 'unknown')

    // Same id off the NetMind channel still resolves as it always did.
    assert.equal(engine.resolvePricing('gpt-5-mini')?.source, 'litellm')
})

// Gemini CLI reports its own bare model id in the stats it emits, so the id that
// reaches metering is `gemini-3.5-flash` while NetMind keys it under
// `google/gemini-3.5-flash`. The existing provider-prefix candidates are what
// bridge that, and exact-only matching depends on them.
test('a bare model id reaches the NetMind key through its namespace', async () => {
    const engine = seededEngine({ netmind: netmindTable() })
    await engine.ensureLoaded()

    const hit = engine.resolvePricing('gemini-3.5-flash', {
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(hit?.key, 'google/gemini-3.5-flash')
    assert.equal(hit?.pricing.input_cost_per_token, 1.5 / 1_000_000)
})

// Reasoning budgets are their own ids on the gateway and bill at the base
// model's rate; nothing upstream prices them, NetMind included.
test('a reasoning tier prices off its base NetMind model', async () => {
    const engine = seededEngine({ netmind: netmindTable() })
    await engine.ensureLoaded()

    assert.equal(
        engine.resolvePricing('gemini-3.5-flash-low', {
            modelProviderBuiltInId: 'netmind'
        })?.key,
        'google/gemini-3.5-flash'
    )
})

// Configured prices are operator intent and keep winning: the channel rule only
// replaces which table the AUTOMATIC match reads.
test('configured scopes still beat the NetMind table', async () => {
    const engine = seededEngine(
        { netmind: netmindTable() },
        {
            loadPriceConfig: async () => ({
                overrides: overridePricingFromRows([
                    {
                        modelId: 'anthropic/claude-sonnet-5',
                        inputCostPerToken: '0.000004',
                        outputCostPerToken: '0.00004',
                        cacheReadCostPerToken: null,
                        cacheCreationCostPerToken: null
                    }
                ]),
                pins: pinsFromRows([]),
                scopes: scopedPricesFromRows([
                    {
                        providerId: null,
                        builtInId: 'netmind',
                        modelId: 'openai/gpt-5.4',
                        inputCostPerToken: '0.000003',
                        outputCostPerToken: '0.00003',
                        cacheReadCostPerToken: null,
                        cacheCreationCostPerToken: null,
                        priceRefSource: null,
                        priceRefKey: null
                    }
                ])
            }),
            overrideTtlMs: 0
        }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    const builtIn = engine.resolvePricing('openai/gpt-5.4', {
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(builtIn?.scope, 'built_in')
    assert.equal(builtIn?.pricing.input_cost_per_token, 0.000003)

    const global = engine.resolvePricing('anthropic/claude-sonnet-5', {
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(global?.scope, 'global')
    assert.equal(global?.pricing.input_cost_per_token, 0.000004)
})

test('the candidate picker proposes a channel only its own table', async () => {
    const engine = seededEngine({
        litellm: litellmRival(),
        netmind: netmindTable()
    })
    await engine.ensureLoaded()

    const netmind = engine.priceCandidates(
        'openai/gpt-5.4',
        undefined,
        'netmind'
    )
    assert.deepEqual(
        netmind.map((c) => [c.source, c.key, c.matchKind]),
        [['netmind', 'openai/gpt-5.4', 'exact']]
    )

    const openai = engine.priceCandidates(
        'openai/gpt-5.4',
        undefined,
        'openai-cloud'
    )
    assert.equal(
        openai.some((c) => c.source === 'netmind'),
        false
    )
    assert.equal(openai[0]?.source, 'litellm')
})

// A typed search is operator intent, so it reaches every table — that is how a
// deliberate cross-table pin gets found for a channel the picker would not
// propose it to.
test('an explicit search reaches every table', async () => {
    const engine = seededEngine({
        litellm: litellmRival(),
        netmind: netmindTable()
    })
    await engine.ensureLoaded()

    const found = engine.priceCandidates('openai/gpt-5.4', 'gpt-5.4', 'netmind')
    assert.equal(
        found.some((c) => c.source === 'litellm'),
        true
    )
})

// Pin validators ask this rather than probing the ranked, budget-capped
// candidate list: it resolves the way resolvePin resolves, so a pin that
// validates is a pin that prices.
test('hasPriceRecord answers exactly, per table', async () => {
    const engine = seededEngine({
        litellm: litellmRival(),
        netmind: netmindTable()
    })
    await engine.ensureLoaded()

    assert.equal(engine.hasPriceRecord('netmind', 'openai/gpt-5.4'), true)
    // Case-insensitive, like every other key lookup in the engine.
    assert.equal(engine.hasPriceRecord('netmind', 'QWEN/qwen3.7-plus'), true)
    assert.equal(engine.hasPriceRecord('litellm', 'Qwen/Qwen3.7-Plus'), false)
    assert.equal(engine.hasPriceRecord('netmind', 'gpt-5-mini'), false)
})

// A pin is an explicit choice, so it keeps working across tables in both
// directions — including onto a channel whose automatic match ignores that
// table.
test('a NetMind-scope pin can name any table, and resolves exactly', async () => {
    const engine = seededEngine(
        {
            litellm: litellmRival(),
            netmind: netmindTable()
        },
        {
            loadPriceConfig: async () => ({
                overrides: new Map(),
                pins: new Map(),
                scopes: scopedPricesFromRows([
                    {
                        providerId: null,
                        builtInId: 'netmind',
                        modelId: 'openai/gpt-5.4',
                        inputCostPerToken: null,
                        outputCostPerToken: null,
                        cacheReadCostPerToken: null,
                        cacheCreationCostPerToken: null,
                        priceRefSource: 'litellm',
                        priceRefKey: 'openai/gpt-5.4'
                    },
                    {
                        providerId: null,
                        builtInId: 'openai-cloud',
                        modelId: 'gpt-5.4',
                        inputCostPerToken: null,
                        outputCostPerToken: null,
                        cacheReadCostPerToken: null,
                        cacheCreationCostPerToken: null,
                        priceRefSource: 'netmind',
                        priceRefKey: 'openai/gpt-5.4'
                    }
                ])
            }),
            overrideTtlMs: 0
        }
    )
    await engine.ensureLoaded()
    await engine.refreshOverridesNow()

    const pinnedOut = engine.resolvePricing('openai/gpt-5.4', {
        modelProviderBuiltInId: 'netmind'
    })
    assert.equal(pinnedOut?.source, 'litellm')
    assert.equal(pinnedOut?.pinned, true)
    assert.equal(pinnedOut?.pricing.input_cost_per_token, 0.0000009)

    const pinnedIn = engine.resolvePricing('gpt-5.4', {
        modelProviderBuiltInId: 'openai-cloud'
    })
    assert.equal(pinnedIn?.source, 'netmind')
    assert.equal(pinnedIn?.pricing.input_cost_per_token, 2.5 / 1_000_000)
})

// The snapshot row is what a cold machine serves before any fetch lands, so the
// channel table has to survive the round trip like the other two.
test('the NetMind table persists to and seeds from a snapshot', async () => {
    const saved = new Map<ModelPriceSource, ModelPriceSnapshotPayload>()
    const engine = new UsagePricingEngine({
        fetchPricing: offline,
        fetchModelsDev: offline,
        fetchNetmind: async () => ({
            raw: NETMIND_PRICING_SAMPLE,
            etag: null
        }),
        loadSnapshot: async () => null,
        saveSnapshot: async (source, payload) => {
            saved.set(source, payload)
        }
    })
    await engine.ensureLoaded()

    const payload = saved.get('netmind')
    assert.equal(
        payload?.prices['anthropic/claude-sonnet-5'].input_cost_per_token,
        2 / 1_000_000
    )
    // Prefixed with the parse version so a parser change cannot stay pinned to
    // rows an older build wrote.
    assert.equal(payload?.etag, '1:')

    const reloaded = seededEngine({ netmind: payload?.prices ?? {} })
    await reloaded.ensureLoaded()
    assert.equal(
        reloaded.resolvePricing('anthropic/claude-sonnet-5', {
            modelProviderBuiltInId: 'netmind'
        })?.pricing.input_cost_per_token,
        2 / 1_000_000
    )
})
