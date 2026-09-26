import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateAgentDto } from '../src/modules/agents/dto/create-agent.dto'
import { UpdateAgentCredentialsDto } from '../src/modules/agents/dto/update-agent-credentials.dto'
import { CredentialsResolverService } from '../src/modules/agents/credentials/credentials-resolver.service'
import type { ResolvedAntigravityCliCredentials } from '../src/modules/agents/credentials/resolved-credentials'

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
    ump_google_gw: {
        inferenceProtocol: 'google_generate_content',
        builtInId: null,
        apiKey: 'gk-gateway',
        baseUrl: 'https://gw.example/antigravity',
        source: 'byo'
    },
    ump_anthropic: {
        inferenceProtocol: 'anthropic_messages',
        builtInId: null,
        apiKey: 'sk-ant',
        baseUrl: 'https://api.anthropic.com',
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

test('a saved Gemini-protocol provider resolves to a key and its endpoint', async () => {
    const resolved = await resolver().resolve('user-1', {
        framework: 'antigravity-cli',
        runtime: 'sprites',
        antigravityCliCredentials: {
            providerId: 'ump_google_gw',
            model: 'gemini-3.8-flash-high'
        }
    } as never)
    assert.equal(resolved.framework, 'antigravity-cli')
    assert.equal(resolved.providerId, 'ump_google_gw')
    assert.deepEqual(resolved.value, {
        googleApiKey: 'gk-gateway',
        googleGeminiBaseUrl: 'https://gw.example/antigravity',
        model: 'gemini-3.8-flash-high',
        inferenceProtocol: 'google_generate_content'
    })
})

test('a provider speaking another protocol is refused: agy’s API-key mode is Gemini only', async () => {
    await assert.rejects(
        resolver().resolve('user-1', {
            framework: 'antigravity-cli',
            antigravityCliCredentials: { providerId: 'ump_anthropic' }
        } as never),
        /google_generate_content/
    )
})

test('an inline key resolves; a create with no credentials is refused', async () => {
    const inline = await resolver().resolve('user-1', {
        framework: 'antigravity-cli',
        antigravityCliCredentials: { googleApiKey: 'gk-inline-marker' }
    } as never)
    assert.equal(
        (inline.value as ResolvedAntigravityCliCredentials).googleApiKey,
        'gk-inline-marker'
    )
    await assert.rejects(
        resolver().resolve('user-1', { framework: 'antigravity-cli' } as never),
        /antigravityCliCredentials required/
    )
})

test('a runtime-local create stores no credentials at all', async () => {
    const resolved = await resolver().resolve('user-1', {
        framework: 'antigravity-cli',
        modelConfigSource: 'runtime-local'
    } as never)
    assert.deepEqual(resolved.value, {})
    assert.equal(resolved.providerId, null)
})

test('an update patches the model alone and switches provider with the key', async () => {
    const existing = {
        framework: 'antigravity-cli' as const,
        providerId: null,
        value: {
            googleApiKey: 'gk-old',
            googleGeminiBaseUrl: undefined,
            model: 'gemini-3.1-pro-low',
            inferenceProtocol: 'google_generate_content' as const
        }
    }
    const svc = resolver()
    const modelOnly = await svc.resolveForUpdate({
        ownerUserId: 'user-1',
        framework: 'antigravity-cli',
        body: { antigravityCliCredentials: { model: 'gemini-3.8-flash-low' } },
        existing
    })
    assert.deepEqual(modelOnly.value, {
        ...existing.value,
        model: 'gemini-3.8-flash-low'
    })
    const switched = await svc.resolveForUpdate({
        ownerUserId: 'user-1',
        framework: 'antigravity-cli',
        body: { antigravityCliCredentials: { providerId: 'ump_google_gw' } },
        existing
    })
    assert.equal(switched.providerId, 'ump_google_gw')
    assert.equal(
        (switched.value as ResolvedAntigravityCliCredentials).googleApiKey,
        'gk-gateway'
    )
})

test('the credentials PATCH and the create body keep antigravityCliCredentials through validation', async () => {
    const patch = plainToInstance(UpdateAgentCredentialsDto, {
        antigravityCliCredentials: {
            googleApiKey: 'gk-marker-marker',
            model: 'gemini-3.1-pro-high'
        }
    })
    assert.deepEqual(await validate(patch, { whitelist: true }), [])
    assert.equal(
        patch.antigravityCliCredentials?.googleApiKey,
        'gk-marker-marker'
    )

    const create = plainToInstance(CreateAgentDto, {
        name: 'agy-agent',
        framework: 'antigravity-cli',
        runtime: 'sprites',
        antigravityCliCredentials: { providerId: 'ump_google_gw' }
    })
    assert.deepEqual(await validate(create, { whitelist: true }), [])
    assert.equal(create.antigravityCliCredentials?.providerId, 'ump_google_gw')
})

test('a runtime-local create refuses a key riding along and any auth profile', async () => {
    const withKey = plainToInstance(CreateAgentDto, {
        name: 'agy-agent',
        framework: 'antigravity-cli',
        runtime: 'sprites',
        modelConfigSource: 'runtime-local',
        antigravityCliCredentials: { googleApiKey: 'gk-marker-marker' }
    })
    assert.match(
        JSON.stringify(await validate(withKey)),
        /cannot be combined with credentials/
    )
    const withProfile = plainToInstance(CreateAgentDto, {
        name: 'agy-agent',
        framework: 'antigravity-cli',
        sandboxId: 'sbx_1',
        modelConfigSource: 'runtime-local',
        runtimeAuthProfileId: 'rap_agqaaaaaaaaaaaaaaaaaaaaaaa'
    })
    assert.match(
        JSON.stringify(await validate(withProfile)),
        /antigravity-cli agents have no auth profiles/
    )
})
