import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserModelProviderRow } from '@manyfold/db'
import { ScopedModelPricesService } from '../src/modules/model-providers/scoped-model-prices.service'

// The service validates before it touches the database, so a throwing fake is
// enough for the rejection paths — reaching it means validation failed open.
const explodingDb = new Proxy(
    {},
    {
        get: (_target, prop) => {
            if (prop === 'then') return undefined
            return () => {
                throw new Error('db must not be touched on a rejected request')
            }
        }
    }
)

const pricingWithKeys = (keys: Array<{ source: string; key: string }>) => ({
    ensureLoaded: async () => undefined,
    refreshOverridesNow: async () => undefined,
    resolvePricing: () => null,
    hasPriceRecord: (source: string, key: string) =>
        keys.some((entry) => entry.source === source && entry.key === key),
    priceCandidates: () =>
        keys.map((entry) => ({
            source: entry.source,
            key: entry.key,
            pricing: {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.00001
            },
            official: true,
            matchKind: 'exact' as const
        })),
    sourceStatuses: () => []
})

const service = (keys: Array<{ source: string; key: string }> = []) =>
    new ScopedModelPricesService(
        explodingDb as never,
        pricingWithKeys(keys) as never
    )

const managedRow = {
    id: 'ump_managed',
    source: 'managed',
    builtInId: null,
    lastTestModels: { anthropic_messages: ['claude-sonnet-4-6'] }
} as unknown as UserModelProviderRow

test('an unknown built-in id is rejected before any write', async () => {
    await assert.rejects(
        service().adminUpsert(
            { builtInId: 'not-a-provider', modelId: 'gpt-5' },
            'admin'
        ),
        /not a built-in provider/
    )
})

test('an empty model id is rejected', async () => {
    await assert.rejects(
        service().adminUpsert({ builtInId: 'netmind', modelId: '  ' }, 'admin'),
        /modelId must not be empty/
    )
})

test('half a pin is rejected', async () => {
    await assert.rejects(
        service().adminUpsert(
            {
                builtInId: 'netmind',
                modelId: 'gpt-5',
                priceRefSource: 'litellm'
            },
            'admin'
        ),
        /must be sent together/
    )
})

// A pin naming nothing would leave the model unpriced with no hint why, so it
// is validated against the loaded table, not just shape-checked.
test('a pin to a key the source does not have is rejected', async () => {
    await assert.rejects(
        service([{ source: 'litellm', key: 'gpt-5' }]).adminUpsert(
            {
                builtInId: 'netmind',
                modelId: 'gpt-5',
                priceRefSource: 'models_dev',
                priceRefKey: 'openai/nope'
            },
            'admin'
        ),
        /not a known models_dev pricing record/
    )
})

// Managed rows are the platform's numbers; a user restating them would let one
// account rewrite what its own usage reports cost.
test('writes against a managed provider row are refused', async () => {
    await assert.rejects(
        service().providerUpsert(
            managedRow,
            { modelId: 'claude-sonnet-4-6', inputCostPerToken: 0 },
            'usr_1'
        ),
        /platform-administered/
    )
    await assert.rejects(
        service().providerDelete(managedRow, 'claude-sonnet-4-6', 'usr_1'),
        /platform-administered/
    )
})
