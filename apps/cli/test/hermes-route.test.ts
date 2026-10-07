import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Hermes half of the route attestation: the config.yaml model section a
// per-turn `hermes acp` child loads and the provider key it is given, after
// the dotenv hermes loads over that env; every other credential layer hermes
// has is unresolved rather than guessed. HOME is redirected before the import
// so the session records stay out of the developer's daemon directory.
const root = mkdtempSync(join(tmpdir(), 'mf-hermes-route-'))
process.env.HOME = root
process.env.MF_PROFILE = 'hermesroutetest'

const { resolveHermesRoute, hermesTurnRoute, HermesSessionRoutes } = await import(
    '../src/daemon/hermes-route'
)

const CMD = ['hermes', 'acp', '--accept-hooks']
let n = 0
const hermesHome = (files: Record<string, string>): { env: Record<string, string>; home: string } => {
    const home = join(root, `home-${++n}`)
    mkdirSync(home, { recursive: true })
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(home, name, '..'), { recursive: true })
        writeFileSync(join(home, name), text)
    }
    return { env: { HERMES_HOME: home, PATH: process.env.PATH ?? '' }, home }
}
const customConfig = (lines: string[] = []) =>
    [
        'profile: default',
        'model:',
        '  provider: custom',
        '  default: fixture-model',
        '  base_url: https://gateway.fixture.invalid/v1',
        '  api_key: fixture-config-key',
        ...lines,
        'platforms: {}'
    ].join('\n') + '\n'
const openrouterConfig = (lines: string[] = []) =>
    ['profile: default', 'model:', '  provider: openrouter', '  default: fixture/model', ...lines].join('\n') + '\n'

test('a custom endpoint is the route its config section names, keyed from the config', () => {
    const { env, home } = hermesHome({ 'config.yaml': customConfig() })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: { ...env, OPENAI_API_KEY: 'fixture-alias-key' } }), {
        home,
        route: {
            provider: 'custom',
            protocol: 'openai_chat_completions',
            baseUrl: 'https://gateway.fixture.invalid/v1',
            apiKey: 'fixture-config-key'
        }
    })
    const anthropicPath = hermesHome({
        'config.yaml': customConfig().replace('/v1', '/anthropic')
    })
    const resolved = resolveHermesRoute({ cmd: CMD, env: anthropicPath.env })
    assert.equal('route' in resolved && resolved.route.protocol, 'anthropic_messages')
    const responses = hermesHome({ 'config.yaml': customConfig(['  api_mode: codex_responses']) })
    const viaMode = resolveHermesRoute({ cmd: CMD, env: responses.env })
    assert.equal('route' in viaMode && viaMode.route.protocol, 'openai_responses')
})

test('OpenRouter is keyed from the env the child is spawned with, after the dotenv hermes loads over it', () => {
    const plain = hermesHome({ 'config.yaml': openrouterConfig() })
    assert.deepEqual(
        resolveHermesRoute({ cmd: CMD, env: { ...plain.env, OPENROUTER_API_KEY: 'fixture-alias-key' } }),
        {
            home: plain.home,
            route: {
                provider: 'openrouter',
                protocol: 'openai_chat_completions',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'fixture-alias-key'
            }
        }
    )
    const mirror = hermesHome({ 'config.yaml': openrouterConfig(['  base_url: https://mirror.fixture.invalid/api/v1']) })
    const mirrored = resolveHermesRoute({ cmd: CMD, env: { ...mirror.env, OPENROUTER_API_KEY: 'fixture-alias-key' } })
    assert.equal('route' in mirrored && mirrored.route.baseUrl, 'https://mirror.fixture.invalid/api/v1')
    // hermes loads ~/.hermes/.env over the inherited environment.
    const overridden = hermesHome({
        'config.yaml': openrouterConfig(),
        '.env': '# OPENROUTER_API_KEY=commented\nexport OPENROUTER_API_KEY="fixture-dotenv-key"\n'
    })
    const fromDotenv = resolveHermesRoute({
        cmd: CMD,
        env: { ...overridden.env, OPENROUTER_API_KEY: 'fixture-alias-key' }
    })
    assert.equal('route' in fromDotenv && fromDotenv.route.apiKey, 'fixture-dotenv-key')
    const interpolated = hermesHome({
        'config.yaml': openrouterConfig(),
        '.env': 'OPENROUTER_API_KEY=${OTHER_KEY}\n'
    })
    assert.deepEqual(
        resolveHermesRoute({ cmd: CMD, env: { ...interpolated.env, OPENROUTER_API_KEY: 'fixture-alias-key' } }),
        { unresolved: 'hermes_dotenv' }
    )
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: plain.env }), { unresolved: 'key_unresolved' })
})

test('every credential layer the resolver cannot see is unresolved, not guessed', () => {
    const withKey = (env: Record<string, string>) => ({ ...env, OPENROUTER_API_KEY: 'fixture-alias-key' })
    const profileRoot = hermesHome({ 'config.yaml': openrouterConfig(), active_profile: 'work\n' })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: withKey(profileRoot.env) }), {
        unresolved: 'hermes_profile'
    })
    const defaultProfile = hermesHome({ 'config.yaml': openrouterConfig(), active_profile: 'default\n' })
    assert.equal('route' in resolveHermesRoute({ cmd: CMD, env: withKey(defaultProfile.env) }), true)
    assert.deepEqual(
        resolveHermesRoute({ cmd: [...CMD, '--profile', 'work'], env: withKey(defaultProfile.env) }),
        { unresolved: 'hermes_profile' }
    )
    assert.deepEqual(
        resolveHermesRoute({
            cmd: CMD,
            env: withKey({ HERMES_HOME: join(root, 'profiles', 'work') })
        }),
        { unresolved: 'hermes_profile' }
    )
    assert.deepEqual(
        resolveHermesRoute({ cmd: CMD, env: withKey({ ...defaultProfile.env, HERMES_MANAGED_DIR: root }) }),
        { unresolved: 'hermes_managed_scope' }
    )
    const sources = hermesHome({
        'config.yaml': openrouterConfig() + 'secrets:\n  bitwarden:\n    enabled: true\n'
    })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: withKey(sources.env) }), {
        unresolved: 'hermes_secret_sources'
    })
    const pool = hermesHome({
        'config.yaml': openrouterConfig(),
        'auth.json': JSON.stringify({ credential_pool: { openrouter: [{ id: 'one' }] } })
    })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: withKey(pool.env) }), {
        unresolved: 'hermes_credential_pool'
    })
    const emptyPool = hermesHome({
        'config.yaml': openrouterConfig(),
        'auth.json': JSON.stringify({ credential_pool: { openrouter: [] } })
    })
    assert.equal('route' in resolveHermesRoute({ cmd: CMD, env: withKey(emptyPool.env) }), true)
    const keyCommand = hermesHome({ 'config.yaml': customConfig(['  key_cmd: print-key']) })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: keyCommand.env }), { unresolved: 'key_unresolved' })
    const anthropic = hermesHome({ 'config.yaml': customConfig().replace('provider: custom', 'provider: anthropic') })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: anthropic.env }), { unresolved: 'provider_unsupported' })
    const custom = hermesHome({ 'config.yaml': customConfig() })
    assert.deepEqual(
        resolveHermesRoute({ cmd: CMD, env: { ...custom.env, CUSTOM_BASE_URL: 'https://elsewhere.fixture.invalid' } }),
        { unresolved: 'hermes_env_base_url' }
    )
    const checkoutEnv = hermesHome({
        'config.yaml': customConfig(),
        'hermes-agent/.env': 'CUSTOM_BASE_URL=https://elsewhere.fixture.invalid\n'
    })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: checkoutEnv.env }), { unresolved: 'hermes_dotenv' })
    const unreadable = hermesHome({ 'config.yaml': 'model: [unterminated' })
    assert.deepEqual(resolveHermesRoute({ cmd: CMD, env: unreadable.env }), { unresolved: 'config_unreadable' })
})

test('a resumed session is attested only on the route this daemon saw it created on', async () => {
    const sessions = new HermesSessionRoutes(join(root, 'session-routes.json'))
    const { env, home } = hermesHome({ 'config.yaml': customConfig() })
    const turn = (overrides: Record<string, unknown>) =>
        hermesTurnRoute({
            atSpawn: resolveHermesRoute({ cmd: CMD, env }),
            sessionId: 'sess_fixture_1',
            resumed: false,
            prompt: 'say hello',
            modelOverride: null,
            currentModelId: 'custom:fixture-model',
            sessions,
            ...overrides
        })
    // Before any record: a resumed session's route is whatever hermes
    // persisted when it created it, which this daemon never saw.
    assert.deepEqual(await turn({ resumed: true }), { unresolved: 'hermes_session_route_unknown' })
    const created = await turn({})
    assert.equal('route' in created && created.route.apiKey, 'fixture-config-key')
    const resumed = await turn({ resumed: true })
    assert.equal('route' in resumed && resumed.route.baseUrl, 'https://gateway.fixture.invalid/v1')
    // The session persisted the old endpoint; a config that moved since is
    // not the route the resumed child calls.
    writeFileSync(join(home, 'config.yaml'), customConfig().replace('gateway.fixture.invalid', 'moved.fixture.invalid'))
    assert.deepEqual(await turn({ resumed: true }), { unresolved: 'hermes_session_route_unknown' })
    writeFileSync(join(home, 'config.yaml'), customConfig())
    assert.equal('route' in (await turn({ resumed: true })), true)
    assert.deepEqual(await turn({ resumed: true, currentModelId: 'openrouter:other' }), {
        unresolved: 'hermes_session_provider'
    })
    // A slash command or a cross-provider pick can move the session itself.
    assert.deepEqual(await turn({ resumed: true, prompt: '/model openrouter:other' }), {
        unresolved: 'hermes_slash_command'
    })
    assert.deepEqual(await turn({ resumed: true }), { unresolved: 'hermes_session_route_unknown' })
    await turn({})
    assert.deepEqual(await turn({ resumed: true, modelOverride: 'openrouter:other' }), {
        unresolved: 'hermes_model_override_provider'
    })
    assert.deepEqual(await turn({ resumed: true }), { unresolved: 'hermes_session_route_unknown' })
    await turn({})
    assert.equal('route' in (await turn({ resumed: true, modelOverride: 'fixture-model-b' })), true)
    // The spawn-time route is what the child loaded: a rebind after the child
    // started does not move this turn's answer.
    const atSpawn = resolveHermesRoute({ cmd: CMD, env })
    writeFileSync(join(home, 'config.yaml'), customConfig().replace('fixture-config-key', 'fixture-rebound-key'))
    const afterRebind = await hermesTurnRoute({
        atSpawn,
        sessionId: 'sess_fixture_2',
        resumed: false,
        prompt: 'say hello',
        modelOverride: null,
        currentModelId: null,
        sessions
    })
    assert.equal('route' in afterRebind && afterRebind.route.apiKey, 'fixture-config-key')
    rmSync(root, { recursive: true, force: true })
})
