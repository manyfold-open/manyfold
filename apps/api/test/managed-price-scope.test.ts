import assert from 'node:assert/strict'
import test from 'node:test'
import {
    UsagePricingService,
    type ScopedModelPriceConfigRow
} from '../src/modules/usage/usage-pricing.service'
import type { ManagedPriceRow } from '../src/common/ports/managed-models.ports'

const row = (
    brand: string,
    inputCostPerToken: string | null,
    pin: string | null = null
): ManagedPriceRow & { brand: string } => ({
    brand,
    modelId: ' Shared-Model ',
    inputCostPerToken,
    outputCostPerToken: null,
    cacheReadCostPerToken: null,
    cacheCreationCostPerToken: null,
    priceRefSource: pin ? 'litellm' : null,
    priceRefKey: pin
})

const serviceFor = async (
    rows: ManagedPriceRow[],
    scoped: ScopedModelPriceConfigRow[] = []
) => {
    const pricing = new UsagePricingService(
        {
            select: () => ({ from: () => ({ where: async () => scoped }) })
        } as never,
        {
            read: async (source: string) => ({
                prices: {
                    'shared-model': { input_cost_per_token: 0.000001 },
                    'reference-a': { input_cost_per_token: 0.000003 },
                    'reference-b': { input_cost_per_token: 0.000009 }
                },
                etag: source === 'litellm' ? '1:fixture' : '2:fixture',
                fetchedAt: new Date()
            })
        } as never,
        { loadManagedPriceRows: async () => rows }
    )
    await pricing.ensureLoaded()
    return pricing
}

test('provider and built-in scopes still precede the managed brand catalog', async () => {
    const pricing = await serviceFor(
        [row('brand-a', '0.000002')],
        [
            {
                ...row('unused', '0.000008'),
                providerId: null,
                builtInId: 'official'
            },
            {
                ...row('unused', '0.000010'),
                providerId: 'custom-row',
                builtInId: null
            }
        ]
    )
    const brand = { modelProviderManagedBrand: 'brand-a' }
    assert.equal(
        pricing.resolvePricing('shared-model', brand)?.pricing
            .input_cost_per_token,
        0.000002
    )
    assert.equal(
        pricing.resolvePricing('shared-model', {
            ...brand,
            modelProviderBuiltInId: 'official'
        })?.pricing.input_cost_per_token,
        0.000008
    )
    assert.equal(
        pricing.resolvePricing('shared-model', {
            ...brand,
            modelProviderBuiltInId: 'official',
            modelProviderId: 'custom-row'
        })?.pricing.input_cost_per_token,
        0.00001
    )
})

for (const size of [2, 3]) {
    for (const reversed of [false, true]) {
        test(`ambiguous normalized managed ids stay unpriced: ${size} rows, reversed=${reversed}`, async () => {
            const rows = Array.from({ length: size }, (_, index) => ({
                ...row('brand-a', `0.00000${index + 2}`),
                modelId: ['shared-model', ' SHARED-MODEL ', 'Shared-Model'][
                    index
                ]
            }))
            const pricing = await serviceFor(reversed ? rows.reverse() : rows)
            assert.equal(
                pricing.resolvePricing('shared-model', {
                    modelProviderManagedBrand: 'brand-a'
                }),
                null
            )
            assert.equal(
                pricing.hasPricing('shared-model', {
                    modelProviderManagedBrand: 'brand-a'
                }),
                false
            )
        })
    }
}

for (const reversed of [false, true]) {
    test(`managed overrides preserve brand identity, reversed=${reversed}`, async () => {
        const rows = [row('brand-a', '0.000002'), row('brand-b', '0.000007')]
        const pricing = await serviceFor(reversed ? rows.reverse() : rows)
        for (const [brand, expected] of [
            ['brand-a', 2],
            ['brand-b', 7]
        ] as const) {
            const scope = {
                modelProviderId: `provider-${brand}`,
                modelProviderManagedBrand: brand
            }
            assert.equal(
                pricing.resolvePricing('shared-model', scope)?.scope,
                'managed'
            )
            assert.equal(
                pricing.computeCost({
                    model: 'shared-model',
                    inputTokens: 1_000_000,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    ...scope
                }).costUsd,
                expected
            )
        }
        for (const scope of [
            undefined,
            { modelProviderId: 'byo' },
            {
                modelProviderId: 'unknown',
                modelProviderManagedBrand: 'unknown-brand'
            }
        ]) {
            const resolved = pricing.resolvePricing('shared-model', scope)
            assert.equal(resolved?.scope, 'auto')
            assert.equal(resolved?.pricing.input_cost_per_token, 0.000001)
        }
    })

    test(`managed pins preserve brand identity and broken pins, reversed=${reversed}`, async () => {
        const rows = [
            row('brand-a', null, 'reference-a'),
            row('brand-b', null, 'reference-b'),
            row('broken', null, 'removed-reference')
        ]
        const pricing = await serviceFor(reversed ? rows.reverse() : rows)
        for (const [brand, expected] of [
            ['brand-a', 0.000003],
            ['brand-b', 0.000009]
        ] as const) {
            const resolved = pricing.resolvePricing('shared-model', {
                modelProviderId: `provider-${brand}`,
                modelProviderManagedBrand: brand
            })
            assert.equal(resolved?.pricing.input_cost_per_token, expected)
            assert.equal(resolved?.pinned, true)
            assert.equal(resolved?.scope, 'managed')
        }
        assert.equal(
            pricing.resolvePricing('shared-model', {
                modelProviderId: 'broken-provider',
                modelProviderManagedBrand: 'broken'
            }),
            null
        )
    })
}
