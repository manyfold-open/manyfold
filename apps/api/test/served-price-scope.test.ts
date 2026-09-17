import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import type { UserModelProviderRow } from '@manyfold/db'
import {
    priceScopeFromMetadata,
    UNKNOWN_PRICE_SCOPE,
    verifiedCodingPriceScope
} from '../src/modules/usage/served-price-scope'
import { CreateMessageDto } from '../src/modules/chat/dto/create-message.dto'

test('only the exact dispatched credential route establishes a managed pricing scope', () => {
    const key = randomBytes(32).toString('hex')
    const provider = {
        id: 'fixture-provider',
        source: 'managed',
        managedBrand: 'google',
        builtInId: null,
        inferenceProtocol: 'google_generate_content',
        baseUrl: 'https://fixture.invalid/v1beta/'
    } as UserModelProviderRow
    const credentials = {
        googleApiKey: key,
        googleGeminiBaseUrl: 'https://fixture.invalid/v1beta',
        inferenceProtocol: 'google_generate_content'
    }
    const resolve = (patch: Record<string, unknown> = {}, row = provider) =>
        verifiedCodingPriceScope({
            framework: 'gemini-cli',
            credentials: { ...credentials, ...patch },
            provider: row,
            providerApiKey: key
        })
    assert.deepEqual(resolve(), {
        modelProviderId: provider.id,
        modelProviderBuiltInId: null,
        modelProviderManagedBrand: 'google'
    })
    assert.deepEqual(
        resolve({ googleApiKey: randomBytes(32).toString('hex') }),
        UNKNOWN_PRICE_SCOPE
    )
    assert.deepEqual(
        resolve({ googleGeminiBaseUrl: 'https://other.invalid/v1beta' }),
        UNKNOWN_PRICE_SCOPE
    )
    assert.deepEqual(
        resolve({ inferenceProtocol: 'openai_responses' }),
        UNKNOWN_PRICE_SCOPE
    )
    assert.deepEqual(
        resolve({}, { ...provider, inferenceProtocol: 'openai_responses' }),
        UNKNOWN_PRICE_SCOPE
    )
    assert.equal(
        resolve({}, { ...provider, source: 'byo' }).modelProviderManagedBrand,
        null,
        'a stale brand column on BYO never grants managed catalog pricing'
    )
})

test('request DTO validation cannot supply a served pricing scope', async () => {
    const body = plainToInstance(CreateMessageDto, {
        text: 'Fixture prompt',
        pricingScope: {
            version: 1,
            modelProviderId: 'attacker-choice',
            modelProviderManagedBrand: 'google'
        },
        modelProviderManagedBrand: 'google'
    })
    await validate(body, { whitelist: true })
    assert.ok(!Object.prototype.hasOwnProperty.call(body, 'pricingScope'))
    assert.ok(
        !Object.prototype.hasOwnProperty.call(body, 'modelProviderManagedBrand')
    )
})

test('legacy and malformed metadata never guess a current provider scope', () => {
    for (const metadata of [
        null,
        {},
        { model: 'model' },
        { pricingScope: {} },
        { pricingScope: { version: 2, ...UNKNOWN_PRICE_SCOPE } },
        { pricingScope: { version: 1, modelProviderManagedBrand: 'google' } },
        {
            pricingScope: {
                version: 1,
                ...UNKNOWN_PRICE_SCOPE,
                modelProviderId: 42
            }
        },
        {
            pricingScope: {
                version: 1,
                ...UNKNOWN_PRICE_SCOPE,
                modelProviderManagedBrand: 'google'
            }
        }
    ]) {
        assert.deepEqual(priceScopeFromMetadata(metadata), UNKNOWN_PRICE_SCOPE)
    }
    const scope = {
        modelProviderId: 'fixture-provider',
        modelProviderBuiltInId: null,
        modelProviderManagedBrand: 'google'
    }
    assert.deepEqual(
        priceScopeFromMetadata({ pricingScope: { version: 1, ...scope } }),
        scope
    )
})
