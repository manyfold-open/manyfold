import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    openclawRouteSource,
    openclawTurnRoute,
    readOpenclawConfig,
    resolveOpenclawRoute,
    type OpenclawRouteSource
} from '../src/daemon/openclaw-route'

// The OpenClaw half of the route attestation: the provider the transcript
// names, resolved from the gateway's config the way the gateway resolves it,
// and nothing the daemon cannot know.

const config = (entry: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    models: { mode: 'merge', providers: { primary: entry } },
    ...extra
})
const literal = {
    baseUrl: 'https://gateway.fixture.invalid/v1',
    apiKey: 'fixture-route-key',
    api: 'openai-completions'
}

const sandbox = (): { dir: string; source: (env: Record<string, string> | null) => OpenclawRouteSource } => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-oc-route-'))
    return {
        dir,
        source: (env) => ({
            configPath: join(dir, 'openclaw.json'),
            stateDir: dir,
            gatewayEnv: env
        })
    }
}

test('a literal provider entry is the route, with its wire api as the protocol', () => {
    const { source } = sandbox()
    assert.deepEqual(
        resolveOpenclawRoute({ config: config(literal), provider: 'primary', source: source(null) }),
        {
            route: {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://gateway.fixture.invalid/v1',
                apiKey: 'fixture-route-key'
            }
        }
    )
    assert.deepEqual(
        resolveOpenclawRoute({
            config: config({ ...literal, api: 'anthropic-messages' }),
            provider: 'primary',
            source: source(null)
        }),
        {
            route: {
                protocol: 'anthropic_messages',
                baseUrl: 'https://gateway.fixture.invalid/v1',
                apiKey: 'fixture-route-key'
            }
        }
    )
})

test('a key named by env reference resolves only from an environment the daemon gave the gateway', () => {
    const { source } = sandbox()
    const byReference = config({ ...literal, apiKey: '${FIXTURE_ROUTE_KEY}' })
    assert.deepEqual(
        resolveOpenclawRoute({
            config: byReference,
            provider: 'primary',
            source: source({ FIXTURE_ROUTE_KEY: 'fixture-env-key' })
        }),
        {
            route: {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://gateway.fixture.invalid/v1',
                apiKey: 'fixture-env-key'
            }
        }
    )
    // A sprite service or a BYOD gateway: its environment is not ours to know.
    assert.deepEqual(
        resolveOpenclawRoute({ config: byReference, provider: 'primary', source: source(null) }),
        { unresolved: 'key_unresolved' }
    )
    // A missing variable fails the gateway's own load; it is never empty.
    assert.deepEqual(
        resolveOpenclawRoute({ config: byReference, provider: 'primary', source: source({}) }),
        { unresolved: 'key_unresolved' }
    )
    // `$${VAR}` is the literal text.
    assert.deepEqual(
        resolveOpenclawRoute({
            config: config({ ...literal, apiKey: 'pre-$${FIXTURE_ROUTE_KEY}' }),
            provider: 'primary',
            source: source({})
        }),
        {
            route: {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://gateway.fixture.invalid/v1',
                apiKey: 'pre-${FIXTURE_ROUTE_KEY}'
            }
        }
    )
    // A SecretRef from the env provider resolves the same way; a file or exec
    // source does not.
    assert.equal(
        'route' in
            resolveOpenclawRoute({
                config: config({
                    ...literal,
                    apiKey: { source: 'env', provider: 'default', id: 'FIXTURE_ROUTE_KEY' }
                }),
                provider: 'primary',
                source: source({ FIXTURE_ROUTE_KEY: 'fixture-env-key' })
            }),
        true
    )
    assert.deepEqual(
        resolveOpenclawRoute({
            config: config({
                ...literal,
                apiKey: { source: 'file', provider: 'filemain', id: '/providers/primary' }
            }),
            provider: 'primary',
            source: source({ FIXTURE_ROUTE_KEY: 'fixture-env-key' })
        }),
        { unresolved: 'key_unresolved' }
    )
})

test("the config's env block fills a variable only when no dotenv sits above it", () => {
    const { dir, source } = sandbox()
    const withBlock = config(
        { ...literal, apiKey: '${FIXTURE_ROUTE_KEY}' },
        { env: { vars: { FIXTURE_ROUTE_KEY: 'fixture-block-key' } } }
    )
    const resolved = resolveOpenclawRoute({ config: withBlock, provider: 'primary', source: source({ HOME: dir }) })
    assert.equal('route' in resolved && resolved.route.apiKey, 'fixture-block-key')
    // The process env wins over the block.
    const fromProcess = resolveOpenclawRoute({
        config: withBlock,
        provider: 'primary',
        source: source({ HOME: dir, FIXTURE_ROUTE_KEY: 'fixture-env-key' })
    })
    assert.equal('route' in fromProcess && fromProcess.route.apiKey, 'fixture-env-key')
    writeFileSync(join(dir, '.env'), 'FIXTURE_ROUTE_KEY=fixture-dotenv-key\n')
    assert.deepEqual(
        resolveOpenclawRoute({ config: withBlock, provider: 'primary', source: source({ HOME: dir }) }),
        { unresolved: 'key_unresolved' }
    )
    rmSync(join(dir, '.env'))
})

test('an entry the config does not hold, or holds in a way the file does not show, is unresolved', () => {
    const { source } = sandbox()
    const env = source(null)
    assert.deepEqual(
        resolveOpenclawRoute({ config: config(literal), provider: 'fallback', source: env }),
        { unresolved: 'provider_not_configured' }
    )
    assert.deepEqual(
        resolveOpenclawRoute({ config: {}, provider: 'primary', source: env }),
        { unresolved: 'provider_not_configured' }
    )
    assert.deepEqual(
        resolveOpenclawRoute({
            config: { models: { $include: './models.json5' } },
            provider: 'primary',
            source: env
        }),
        { unresolved: 'config_include' }
    )
    assert.deepEqual(
        resolveOpenclawRoute({
            config: config(literal, { gateway: { reload: { mode: 'off' } } }),
            provider: 'primary',
            source: env
        }),
        { unresolved: 'config_reload_off' }
    )
    assert.deepEqual(
        resolveOpenclawRoute({ config: config({ ...literal, api: 'ollama' }), provider: 'primary', source: env }),
        { unresolved: 'provider_api_unsupported' }
    )
    const { api: _api, ...noApi } = literal
    assert.deepEqual(
        resolveOpenclawRoute({ config: config(noApi), provider: 'primary', source: env }),
        { unresolved: 'provider_api_unsupported' }
    )
    const { apiKey: _key, ...noKey } = literal
    assert.deepEqual(
        resolveOpenclawRoute({ config: config(noKey), provider: 'primary', source: env }),
        { unresolved: 'key_unresolved' }
    )
})

test('a turn follows only the one provider its transcript names, through an unchanged config', async () => {
    const { dir, source } = sandbox()
    const env = source(null)
    const path = join(dir, 'openclaw.json')
    writeFileSync(path, JSON.stringify(config(literal)))
    const atStart = await readOpenclawConfig(env)
    assert.equal(typeof atStart, 'object')
    assert.deepEqual(
        await openclawTurnRoute({ providers: ['primary'], configAtStart: atStart, source: env }),
        {
            route: {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://gateway.fixture.invalid/v1',
                apiKey: 'fixture-route-key'
            }
        }
    )
    assert.deepEqual(
        await openclawTurnRoute({ providers: ['primary', 'fallback'], configAtStart: atStart, source: env }),
        { unresolved: 'providers_mixed' }
    )
    assert.deepEqual(
        await openclawTurnRoute({ providers: [], configAtStart: atStart, source: env }),
        { unresolved: 'provider_unrecorded' }
    )
    // Rebound while the turn ran: the calls could have gone either way.
    writeFileSync(path, JSON.stringify(config({ ...literal, apiKey: 'fixture-rebound-key' })))
    assert.deepEqual(
        await openclawTurnRoute({ providers: ['primary'], configAtStart: atStart, source: env }),
        { unresolved: 'config_changed' }
    )
    // An endpoint spelled with or without the runtime's /v1 is the same route.
    writeFileSync(path, JSON.stringify(config({ ...literal, baseUrl: 'https://gateway.fixture.invalid/' })))
    assert.equal(
        'route' in (await openclawTurnRoute({ providers: ['primary'], configAtStart: atStart, source: env })),
        true
    )
    writeFileSync(path, '{ models: { /* json5 */ } }')
    assert.deepEqual(await readOpenclawConfig(env), 'config_unreadable')
    rmSync(dir, { recursive: true, force: true })
})

test('the config path follows the gateway environment, then the daemon defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-oc-route-src-'))
    mkdirSync(join(dir, '.openclaw'), { recursive: true })
    assert.equal(
        openclawRouteSource({ OPENCLAW_CONFIG_PATH: '/srv/oc/openclaw.json', HOME: dir }).configPath,
        '/srv/oc/openclaw.json'
    )
    assert.equal(
        openclawRouteSource({ HOME: dir }).configPath,
        join(dir, '.openclaw', 'openclaw.json')
    )
    assert.equal(
        openclawRouteSource({ HOME: dir, OPENCLAW_STATE_DIR: '/srv/oc/state' }).stateDir,
        '/srv/oc/state'
    )
    rmSync(dir, { recursive: true, force: true })
})
