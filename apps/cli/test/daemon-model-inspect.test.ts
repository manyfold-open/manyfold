import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { delimiter, join as joinPath } from 'node:path'
import { tmpdir } from 'node:os'
import type {
    ClaudeCredentialFacts,
    CodexCredentialFacts,
    DaemonFrameworkModelCapability,
    GeminiCredentialFacts
} from '@manyfold/shared'
import { rpcHandler } from '../src/daemon/rpc'
import type { RpcContext } from '../src/daemon/ws-client'

// model.inspect reports raw credential facts (expiry timestamps, presence
// flags, configured gateways) so the API can judge validity against its own
// clock. Everything here runs against a throwaway HOME/CODEX_HOME; no real
// credential file is read or written.

const ctx: RpcContext = {
    refId: 'model-inspect-test',
    sendEvent: () => {},
    onCancel: () => {}
}

const CREDENTIAL_ENV = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_API_KEY',
    'GEMINI_MODEL',
    'MF_GATEWAY_KEY'
]

const jwt = (expSeconds: number): string => {
    const encode = (value: object): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.sig`
}

// The inspectors probe `<cli> --version` by bare name. Left alone that reaches
// the sealed-env sentinel (or, without it, a real CLI), so the fixture plants
// its own stubs ahead of both — which also pins the versions these assertions
// would otherwise inherit from whatever the machine has installed.
const STUB_VERSIONS: Record<string, string> = {
    claude: '9.9.9 (Claude Code)',
    codex: 'codex-cli 9.9.9',
    gemini: '9.9.9'
}

const plantCliStubs = async (root: string): Promise<string> => {
    const bin = joinPath(root, 'stub-bin')
    await mkdir(bin, { recursive: true })
    for (const [name, version] of Object.entries(STUB_VERSIONS))
        await writeFile(joinPath(bin, name), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {
            mode: 0o755
        })
    return bin
}

const withHome = async (
    fn: (home: string) => Promise<void>
): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'mf-model-inspect-'))
    const priorHome = process.env.HOME
    const priorCodexHome = process.env.CODEX_HOME
    const priorPath = process.env.PATH
    const priorCredentials = CREDENTIAL_ENV.map(
        (key) => [key, process.env[key]] as const
    )
    process.env.HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    process.env.PATH = `${await plantCliStubs(home)}${delimiter}${priorPath ?? ''}`
    for (const key of CREDENTIAL_ENV) delete process.env[key]
    try {
        await fn(home)
    } finally {
        if (priorHome === undefined) delete process.env.HOME
        else process.env.HOME = priorHome
        if (priorCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = priorCodexHome
        if (priorPath === undefined) delete process.env.PATH
        else process.env.PATH = priorPath
        for (const [key, value] of priorCredentials) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

const inspect = async (
    framework: string
): Promise<DaemonFrameworkModelCapability> => {
    const result = await rpcHandler('model.inspect', { framework }, ctx)
    assert.equal(result.ok, true)
    const frameworks = (
        result.payload as { frameworks: DaemonFrameworkModelCapability[] }
    ).frameworks
    assert.equal(frameworks.length, 1)
    return frameworks[0]
}

test('claude inspect reports oauth expiry and refresh capability', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'redacted',
                    refreshToken: 'redacted-refresh',
                    expiresAt: 1_700_000_000_000
                }
            })
        )
        const capability = await inspect('claude-code')
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.framework, 'claude-code')
        assert.equal(facts.credentialsFileParsed, true)
        assert.equal(facts.oauthExpiresAt, 1_700_000_000_000)
        assert.equal(facts.hasRefreshToken, true)
        assert.equal(facts.envToken, false)
        assert.equal(facts.configPresent, true)
    })
})

// Older installs wrote the oauth block under `oauthAccount` instead.
test('claude inspect reads the legacy credentials key', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                oauthAccount: {
                    accessToken: 'redacted',
                    expiresAt: 1_700_000_000_000
                }
            })
        )
        const capability = await inspect('claude-code')
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.oauthExpiresAt, 1_700_000_000_000)
        assert.equal(facts.hasRefreshToken, false)
    })
})

test('claude inspect reports the login record without reading the keychain', async () => {
    await withHome(async (home) => {
        await writeFile(
            join(home, '.claude.json'),
            JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } })
        )
        const capability = await inspect('claude-code')
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.oauthAccount, true)
        assert.equal(facts.credentialsFileParsed, false)
        assert.equal(facts.oauthExpiresAt, null)
    })
})

test('claude inspect reports no credential trace on an empty home', async () => {
    await withHome(async () => {
        const capability = await inspect('claude-code')
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.configPresent, false)
        assert.equal(facts.oauthAccount, false)
        assert.equal(facts.credentialsFileParsed, false)
    })
})

test('codex inspect decodes the access token expiry', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'auth.json'),
            JSON.stringify({
                OPENAI_API_KEY: null,
                auth_mode: 'chatgpt',
                last_refresh: '2026-08-27T12:13:10.749721Z',
                tokens: {
                    access_token: jwt(1_788_696_790),
                    refresh_token: 'redacted-refresh'
                }
            })
        )
        const capability = await inspect('codex')
        const facts = capability.credentialFacts as CodexCredentialFacts
        assert.equal(facts.authFilePresent, true)
        assert.equal(facts.authFileParsed, true)
        assert.equal(facts.apiKeyPresent, false)
        assert.equal(facts.hasAccessToken, true)
        assert.equal(facts.hasRefreshToken, true)
        assert.equal(facts.accessTokenExp, 1_788_696_790_000)
        assert.equal(facts.lastRefresh, '2026-08-27T12:13:10.749721Z')
    })
})

test('codex inspect reports a readable auth.json that holds no credentials', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(join(home, '.codex', 'auth.json'), '{}')
        const capability = await inspect('codex')
        const facts = capability.credentialFacts as CodexCredentialFacts
        assert.equal(facts.authFilePresent, true)
        assert.equal(facts.authFileParsed, true)
        assert.equal(facts.hasAccessToken, false)
        assert.equal(facts.hasRefreshToken, false)
        assert.equal(facts.accessTokenExp, null)
    })
})

test('codex inspect surfaces custom providers and profile models', async () => {
    await withHome(async (home) => {
        process.env.MF_GATEWAY_KEY = 'set-in-env'
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'config.toml'),
            [
                'model = "gateway-default"',
                'model_provider = "mygw"',
                '',
                '[model_providers.mygw]',
                'name = "My Gateway"',
                'base_url = "https://gateway.example/v1"',
                'env_key = "MF_GATEWAY_KEY"',
                'wire_api = "responses"',
                'requires_openai_auth = false',
                '',
                '[model_providers.unused]',
                'base_url = "https://other.example/v1"',
                'env_key = "MF_ABSENT_KEY"',
                '',
                '[profiles.fast]',
                'model = "gateway-turbo"'
            ].join('\n')
        )
        const capability = await inspect('codex')
        const facts = capability.credentialFacts as CodexCredentialFacts
        assert.equal(facts.activeProvider, 'mygw')
        const gateway = facts.customProviders.find(
            (provider) => provider.id === 'mygw'
        )
        assert.ok(gateway)
        assert.equal(gateway.hasBaseUrl, true)
        assert.equal(gateway.envKey, 'MF_GATEWAY_KEY')
        assert.equal(gateway.envKeyPresent, true)
        assert.equal(gateway.requiresOpenaiAuth, false)
        const unused = facts.customProviders.find(
            (provider) => provider.id === 'unused'
        )
        assert.ok(unused)
        assert.equal(unused.envKeyPresent, false)
        assert.ok(capability.models.includes('gateway-default'))
        assert.ok(capability.models.includes('gateway-turbo'))
    })
})

test('gemini inspect reports the oauth expiry date', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.gemini'), { recursive: true })
        await writeFile(
            join(home, '.gemini', 'oauth_creds.json'),
            JSON.stringify({
                access_token: 'redacted',
                refresh_token: 'redacted-refresh',
                expiry_date: 1_700_000_000_000
            })
        )
        const capability = await inspect('gemini-cli')
        const facts = capability.credentialFacts as GeminiCredentialFacts
        assert.equal(facts.oauthFilePresent, true)
        assert.equal(facts.oauthFileParsed, true)
        assert.equal(facts.oauthExpiryDate, 1_700_000_000_000)
        assert.equal(facts.hasRefreshToken, true)
        assert.equal(facts.envApiKey, false)
        assert.equal(facts.settingsApiKey, false)
    })
})

test('gemini inspect reports a settings.json api key', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.gemini'), { recursive: true })
        await writeFile(
            join(home, '.gemini', 'settings.json'),
            JSON.stringify({ apiKey: 'redacted', model: 'gemini-2.5-pro' })
        )
        const capability = await inspect('gemini-cli')
        const facts = capability.credentialFacts as GeminiCredentialFacts
        assert.equal(facts.settingsApiKey, true)
        assert.equal(facts.oauthFilePresent, false)
        assert.equal(facts.oauthExpiryDate, null)
    })
})

test('facts never carry secret values', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'auth.json'),
            JSON.stringify({
                OPENAI_API_KEY: 'sk-super-secret-value',
                tokens: { access_token: jwt(1_788_696_790) }
            })
        )
        const capability = await inspect('codex')
        assert.equal(
            JSON.stringify(capability.credentialFacts).includes('sk-super'),
            false
        )
    })
})
