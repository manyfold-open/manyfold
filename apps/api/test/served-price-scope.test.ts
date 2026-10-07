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

test('an Antigravity CLI credential is priced on the Gemini route it rides', () => {
    const key = randomBytes(32).toString('hex')
    const provider = {
        id: 'fixture-provider',
        source: 'managed',
        managedBrand: 'antigravity',
        builtInId: null,
        inferenceProtocol: 'google_generate_content',
        baseUrl: 'https://fixture.invalid/antigravity'
    } as UserModelProviderRow
    const scope = verifiedCodingPriceScope({
        framework: 'antigravity-cli',
        credentials: {
            googleApiKey: key,
            googleGeminiBaseUrl: 'https://fixture.invalid/antigravity',
            inferenceProtocol: 'google_generate_content'
        },
        provider,
        providerApiKey: key
    })
    assert.deepEqual(scope, {
        modelProviderId: provider.id,
        modelProviderBuiltInId: null,
        modelProviderManagedBrand: 'antigravity'
    })
})

test('a Claude Code credential establishes only the scope of the provider whose key and endpoint it carries', () => {
    const anthropicKey = randomBytes(32).toString('hex')
    const antigravityKey = randomBytes(32).toString('hex')
    // Two managed brands behind one gateway endpoint serve the same model at
    // different prices; only the key the exec carries tells them apart.
    const anthropic = {
        id: 'fixture-anthropic',
        source: 'managed',
        managedBrand: 'anthropic',
        builtInId: null,
        inferenceProtocol: 'anthropic_messages',
        baseUrl: 'https://fixture.invalid/claude/'
    } as UserModelProviderRow
    const antigravity = {
        ...anthropic,
        id: 'fixture-antigravity',
        managedBrand: 'antigravity_claude'
    } as UserModelProviderRow
    const resolve = (
        patch: Record<string, unknown>,
        provider: UserModelProviderRow,
        providerApiKey: string
    ) =>
        verifiedCodingPriceScope({
            framework: 'claude-code',
            credentials: {
                anthropicAuthToken: anthropicKey,
                anthropicBaseUrl: 'https://fixture.invalid/claude',
                inferenceProtocol: 'anthropic_messages',
                ...patch
            },
            provider,
            providerApiKey
        })
    assert.deepEqual(resolve({}, anthropic, anthropicKey), {
        modelProviderId: anthropic.id,
        modelProviderBuiltInId: null,
        modelProviderManagedBrand: 'anthropic'
    })
    assert.deepEqual(
        resolve({ anthropicAuthToken: antigravityKey }, antigravity, antigravityKey),
        {
            modelProviderId: antigravity.id,
            modelProviderBuiltInId: null,
            modelProviderManagedBrand: 'antigravity_claude'
        }
    )
    assert.deepEqual(
        resolve({}, antigravity, antigravityKey),
        UNKNOWN_PRICE_SCOPE,
        'a binding that moved to the other brand never reprices this key'
    )
    assert.deepEqual(
        resolve({ anthropicBaseUrl: 'https://other.invalid/claude' }, anthropic, anthropicKey),
        UNKNOWN_PRICE_SCOPE
    )
    assert.deepEqual(
        resolve({ anthropicBaseUrl: undefined }, anthropic, anthropicKey),
        UNKNOWN_PRICE_SCOPE,
        'no base URL dispatches the official endpoint, not the managed one'
    )
    assert.deepEqual(
        resolve({ inferenceProtocol: 'openai_chat_completions' }, anthropic, anthropicKey),
        UNKNOWN_PRICE_SCOPE
    )
    const byo = {
        ...anthropic,
        id: 'fixture-byo',
        source: 'byo',
        managedBrand: null,
        baseUrl: null
    } as UserModelProviderRow
    assert.deepEqual(
        resolve({ anthropicBaseUrl: undefined }, byo, anthropicKey),
        {
            modelProviderId: byo.id,
            modelProviderBuiltInId: null,
            modelProviderManagedBrand: null
        },
        'a BYO key on the official endpoint is that provider row'
    )
    const builtIn = {
        ...byo,
        id: 'fixture-netmind',
        builtInId: 'netmind',
        inferenceProtocol: null
    } as UserModelProviderRow
    assert.deepEqual(
        resolve(
            { anthropicBaseUrl: 'https://api.netmind.ai/inference-api/anthropic' },
            builtIn,
            anthropicKey
        ),
        {
            modelProviderId: builtIn.id,
            modelProviderBuiltInId: 'netmind',
            modelProviderManagedBrand: null
        }
    )
})

test('a pi credential establishes the scope of the provider its key and vendor route to', () => {
    const key = randomBytes(32).toString('hex')
    const provider = {
        id: 'fixture-provider',
        source: 'managed',
        managedBrand: 'openai',
        builtInId: null,
        inferenceProtocol: 'openai_responses',
        baseUrl: 'https://fixture.invalid/v1'
    } as UserModelProviderRow
    const resolve = (patch: Record<string, unknown> = {}) =>
        verifiedCodingPriceScope({
            framework: 'pi',
            credentials: {
                apiKey: key,
                provider: 'openai',
                baseUrl: 'https://fixture.invalid/v1/',
                inferenceProtocol: 'openai_responses',
                ...patch
            },
            provider,
            providerApiKey: key
        })
    assert.deepEqual(resolve(), {
        modelProviderId: provider.id,
        modelProviderBuiltInId: null,
        modelProviderManagedBrand: 'openai'
    })
    // The vendor decides the protocol pi speaks, so a key the resolver bound
    // under another vendor never borrows this provider's prices.
    assert.deepEqual(
        resolve({ provider: 'anthropic', inferenceProtocol: undefined }),
        UNKNOWN_PRICE_SCOPE
    )
    assert.deepEqual(resolve({ provider: 'mistral' }), UNKNOWN_PRICE_SCOPE)
    assert.deepEqual(
        resolve({ apiKey: randomBytes(32).toString('hex') }),
        UNKNOWN_PRICE_SCOPE
    )
    assert.deepEqual(
        resolve({ baseUrl: undefined }),
        UNKNOWN_PRICE_SCOPE,
        'no base URL dispatches the official endpoint, not the managed one'
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
