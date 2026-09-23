import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { UpdateAgentCredentialsDto } from '../src/modules/agents/dto/update-agent-credentials.dto'
import { buildPiModelsJson } from '../src/modules/agents/credentials/pi-agent-dir'
import { CredentialsResolverService } from '../src/modules/agents/credentials/credentials-resolver.service'
import type { ResolvedPiCredentials } from '../src/modules/agents/credentials/resolved-credentials'

test('models.json exists only for a non-official base URL and names the provider it overrides', () => {
    assert.equal(buildPiModelsJson('anthropic', null), null)
    assert.equal(
        buildPiModelsJson('anthropic', 'https://api.anthropic.com/'),
        null
    )
    assert.equal(buildPiModelsJson('openai', 'https://api.openai.com/v1'), null)
    assert.equal(
        buildPiModelsJson(
            'google',
            'https://generativelanguage.googleapis.com'
        ),
        null
    )
    // Stored the gemini-cli way; pi needs the API version in the override.
    assert.deepEqual(
        JSON.parse(buildPiModelsJson('google', 'https://gw.example/google')!),
        {
            providers: {
                google: { baseUrl: 'https://gw.example/google/v1beta' }
            }
        }
    )
})

const providerRows: Record<
    string,
    {
        inferenceProtocol: string | null
        builtInId: string | null
        apiKey: string
        baseUrl: string | null
        source: 'byo' | 'managed'
    }
> = {
    ump_anthropic: {
        inferenceProtocol: 'anthropic_messages',
        builtInId: null,
        apiKey: 'sk-ant',
        baseUrl: 'https://api.anthropic.com',
        source: 'byo'
    },
    ump_openai_gw: {
        inferenceProtocol: 'openai_responses',
        builtInId: null,
        apiKey: 'sk-oai',
        baseUrl: 'https://gw.example/openai/v1',
        source: 'byo'
    },
    ump_google: {
        inferenceProtocol: 'google_generate_content',
        builtInId: null,
        apiKey: 'sk-goog',
        baseUrl: null,
        source: 'byo'
    },
    ump_chat_completions: {
        inferenceProtocol: 'openai_chat_completions',
        builtInId: null,
        apiKey: 'sk-cc',
        baseUrl: 'https://gw.example/v1',
        source: 'byo'
    },
    ump_netmind: {
        inferenceProtocol: null,
        builtInId: 'netmind',
        apiKey: 'nm-key',
        baseUrl: null,
        source: 'byo'
    }
}

const resolver = () =>
    new CredentialsResolverService({
        resolveForUser: async ({ id }: { id: string }) => {
            const row = providerRows[id]
            if (!row) throw new Error(`no provider ${id}`)
            return row
        }
    } as never)

test('a saved provider of each native protocol resolves to the matching pi provider', async () => {
    const svc = resolver()
    const anthropic = await svc.resolve('user-1', {
        framework: 'pi',
        runtime: 'sprites',
        piCredentials: { providerId: 'ump_anthropic', model: 'claude-opus-4-7' }
    } as never)
    assert.equal(anthropic.framework, 'pi')
    assert.equal(anthropic.providerId, 'ump_anthropic')
    assert.deepEqual(anthropic.value, {
        apiKey: 'sk-ant',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-opus-4-7',
        inferenceProtocol: 'anthropic_messages'
    })
    const openai = await svc.resolve('user-1', {
        framework: 'pi',
        runtime: 'sprites',
        piCredentials: { providerId: 'ump_openai_gw' }
    } as never)
    assert.equal((openai.value as ResolvedPiCredentials).provider, 'openai')
    assert.equal(
        (openai.value as ResolvedPiCredentials).baseUrl,
        'https://gw.example/openai/v1'
    )
    const google = await svc.resolve('user-1', {
        framework: 'pi',
        piCredentials: { providerId: 'ump_google' }
    } as never)
    assert.equal((google.value as ResolvedPiCredentials).provider, 'google')
    assert.equal((google.value as ResolvedPiCredentials).baseUrl, undefined)
})

test('a built-in speaking several protocols serves the vendor it was picked under', async () => {
    const svc = resolver()
    const picked = async (provider?: string) =>
        (
            await svc.resolve('user-1', {
                framework: 'pi',
                runtime: 'sprites',
                piCredentials: {
                    providerId: 'ump_netmind',
                    ...(provider ? { provider } : {})
                }
            } as never)
        ).value as ResolvedPiCredentials
    const openai = await picked('openai')
    assert.equal(openai.provider, 'openai')
    assert.equal(openai.inferenceProtocol, 'openai_responses')
    assert.equal(
        openai.baseUrl,
        'https://api.netmind.ai/inference-api/openai/v1'
    )
    assert.equal((await picked('google')).provider, 'google')
    assert.equal(
        (await picked()).provider,
        'anthropic',
        'first pi protocol it speaks'
    )
    // A custom row speaks one protocol; a vendor naming another is refused.
    await assert.rejects(
        svc.resolve('user-1', {
            framework: 'pi',
            piCredentials: { providerId: 'ump_anthropic', provider: 'openai' }
        } as never),
        /expected one of openai_responses/
    )
})

test('a provider speaking a protocol pi has no built-in for is refused', async () => {
    await assert.rejects(
        resolver().resolve('user-1', {
            framework: 'pi',
            piCredentials: { providerId: 'ump_chat_completions' }
        } as never),
        /expected one of anthropic_messages, openai_responses, google_generate_content/
    )
})

// A gateway endpoint reaches pi through the platform view each exec builds,
// so a daemon takes one exactly like a sandbox does.
test('a gateway provider resolves the same for a daemon create as for a sandbox one', async () => {
    const svc = resolver()
    for (const runtime of ['daemon', 'sprites'] as const) {
        const resolved = await svc.resolve('user-1', {
            framework: 'pi',
            runtime,
            piCredentials: { providerId: 'ump_openai_gw' }
        } as never)
        assert.equal(resolved.framework, 'pi')
        assert.equal(
            (resolved.value as ResolvedPiCredentials).baseUrl,
            'https://gw.example/openai/v1'
        )
    }
})

test('an inline key needs its provider, and a create without pi credentials is refused', async () => {
    const svc = resolver()
    const byo = await svc.resolve('user-1', {
        framework: 'pi',
        piCredentials: { apiKey: 'sk-inline-1234', provider: 'google' }
    } as never)
    assert.deepEqual(byo.value, {
        apiKey: 'sk-inline-1234',
        provider: 'google',
        baseUrl: undefined,
        model: null,
        inferenceProtocol: 'google_generate_content'
    })
    await assert.rejects(
        svc.resolve('user-1', {
            framework: 'pi',
            piCredentials: { apiKey: 'sk-inline-1234' }
        } as never),
        /piCredentials\.provider is required with apiKey/
    )
    await assert.rejects(
        svc.resolve('user-1', { framework: 'pi' } as never),
        /piCredentials required/
    )
})

test('an update patches the model alone, replaces the key with its provider, and never changes the provider without a key', async () => {
    const svc = resolver()
    const existing = {
        framework: 'pi' as const,
        providerId: 'ump_anthropic',
        value: {
            apiKey: 'sk-ant',
            provider: 'anthropic' as const,
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-sonnet-4-6',
            inferenceProtocol: 'anthropic_messages' as const
        }
    }
    const modelOnly = await svc.resolveForUpdate({
        ownerUserId: 'user-1',
        framework: 'pi',
        body: { piCredentials: { model: 'claude-opus-4-7' } },
        existing
    })
    assert.equal(modelOnly.providerId, 'ump_anthropic')
    assert.deepEqual(modelOnly.value, {
        ...existing.value,
        model: 'claude-opus-4-7'
    })

    const newKey = await svc.resolveForUpdate({
        ownerUserId: 'user-1',
        framework: 'pi',
        body: {
            piCredentials: { apiKey: 'sk-new-key-123', provider: 'openai' }
        },
        existing
    })
    assert.equal(
        newKey.providerId,
        null,
        'an inline key detaches the saved provider'
    )
    assert.deepEqual(newKey.value, {
        apiKey: 'sk-new-key-123',
        provider: 'openai',
        baseUrl: undefined,
        model: 'claude-sonnet-4-6',
        inferenceProtocol: 'openai_responses'
    })

    await assert.rejects(
        svc.resolveForUpdate({
            ownerUserId: 'user-1',
            framework: 'pi',
            body: { piCredentials: { provider: 'google' } },
            existing
        }),
        /provider can only change together with apiKey or providerId/
    )
})

test('the credentials PATCH body keeps piCredentials through validation', async () => {
    const dto = plainToInstance(UpdateAgentCredentialsDto, {
        piCredentials: {
            apiKey: 'pikey-pikey-pikey',
            provider: 'openai',
            model: 'gpt-5.5'
        }
    })
    assert.deepEqual(await validate(dto, { whitelist: true }), [])
    assert.equal(dto.piCredentials?.apiKey, 'pikey-pikey-pikey')
    assert.equal(dto.piCredentials?.provider, 'openai')
    assert.equal(dto.piCredentials?.model, 'gpt-5.5')

    const keyWithoutVendor = plainToInstance(UpdateAgentCredentialsDto, {
        piCredentials: { apiKey: 'pikey-pikey-pikey' }
    })
    assert.match(
        JSON.stringify(await validate(keyWithoutVendor)),
        /piCredentials\.provider is required with apiKey/
    )
    const badVendor = plainToInstance(UpdateAgentCredentialsDto, {
        piCredentials: { providerId: 'ump_1', provider: 'mistral' }
    })
    assert.notDeepEqual(await validate(badVendor), [])
})
