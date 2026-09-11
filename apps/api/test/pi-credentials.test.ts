import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
    buildPiModelsJson,
    piAgentDirReconcileScript
} from '../src/modules/agents/credentials/pi-models-json'
import {
    CredentialsResolverService,
    assertPiCredentialsAllowedOnRuntime
} from '../src/modules/agents/credentials/credentials-resolver.service'
import type { ResolvedPiCredentials } from '../src/modules/agents/credentials/resolved-credentials'

test('models.json exists only for a non-official base URL and names the provider it overrides', () => {
    assert.equal(buildPiModelsJson('anthropic', null), null)
    assert.equal(
        buildPiModelsJson('anthropic', 'https://api.anthropic.com/'),
        null
    )
    assert.equal(buildPiModelsJson('openai', 'https://api.openai.com/v1'), null)
    assert.deepEqual(
        JSON.parse(buildPiModelsJson('google', 'https://gw.example/google')!),
        { providers: { google: { baseUrl: 'https://gw.example/google' } } }
    )
})

test('the agent-dir reconcile writes settings once and writes or removes the override', () => {
    const custom = piAgentDirReconcileScript('anthropic', 'https://gw.example')
    assert.match(custom, /^set -eu\nmkdir -p "\$HOME\/\.pi\/agent"\n/)
    assert.match(
        custom,
        /\[ -f "\$HOME\/\.pi\/agent\/settings\.json" \] \|\| cat >/
    )
    assert.match(custom, /"quietStartup": true/)
    assert.match(
        custom,
        /cat > "\$HOME\/\.pi\/agent\/models\.json" <<'MF_PI_EOF'/
    )
    assert.match(custom, /"baseUrl": "https:\/\/gw\.example"/)
    assert.ok(!custom.includes('rm -f'))

    const official = piAgentDirReconcileScript('anthropic', null)
    assert.match(official, /rm -f "\$HOME\/\.pi\/agent\/models\.json"/)
    assert.ok(!official.includes('cat > "$HOME/.pi/agent/models.json"'))
})

test('a daemon runtime refuses a gateway base URL and accepts the official one', () => {
    const creds = {
        provider: 'openai',
        baseUrl: 'https://gw.example/v1'
    } as const
    assert.throws(
        () => assertPiCredentialsAllowedOnRuntime('daemon', creds),
        (err: unknown) =>
            err instanceof BadRequestException &&
            /daemon runtime cannot use a custom base URL/.test(err.message)
    )
    assert.doesNotThrow(() =>
        assertPiCredentialsAllowedOnRuntime('sprites', creds)
    )
    assert.doesNotThrow(() =>
        assertPiCredentialsAllowedOnRuntime('daemon', {
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1/'
        })
    )
    assert.doesNotThrow(() =>
        assertPiCredentialsAllowedOnRuntime('daemon', { provider: 'openai' })
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

test('a provider speaking a protocol pi has no built-in for is refused', async () => {
    await assert.rejects(
        resolver().resolve('user-1', {
            framework: 'pi',
            piCredentials: { providerId: 'ump_chat_completions' }
        } as never),
        /expected one of anthropic_messages, openai_responses, google_generate_content/
    )
})

test('a gateway provider is refused for a daemon create but not a sandbox one', async () => {
    const svc = resolver()
    await assert.rejects(
        svc.resolve('user-1', {
            framework: 'pi',
            runtime: 'daemon',
            piCredentials: { providerId: 'ump_openai_gw' }
        } as never),
        /daemon runtime cannot use a custom base URL/
    )
    const ok = await svc.resolve('user-1', {
        framework: 'pi',
        runtime: 'sprites',
        piCredentials: { providerId: 'ump_openai_gw' }
    } as never)
    assert.equal(ok.framework, 'pi')
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
