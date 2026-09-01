import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import {
    runtimeLocalCredentialStatus,
    type ClaudeCredentialFacts,
    type CodexCredentialFacts,
    type DaemonFrameworkModelCapability,
    type GeminiCredentialFacts
} from '@manyfold/shared'
import { runtimeInspectScript } from '../src/modules/agents/model-config/agent-model-config.service'

// The sandbox inspect script is a hand-mirrored copy of the daemon inspectors
// in apps/cli/src/daemon/rpc.ts. It is emitted as a string, so nothing type
// checks it — these tests run the real emitted script against fixture homes.
// Its sibling is apps/cli/test/daemon-model-inspect.test.ts; the two assert the
// same facts on purpose.

const run = promisify(execFile)

const catalog = {
    claudeAliases: ['fable', 'opus', 'sonnet', 'haiku'],
    codexModels: ['gpt-5.6-sol', 'gpt-5.5'],
    codexSpeeds: ['standard', 'fast'],
    codexIntelligence: ['low', 'medium', 'high', 'xhigh'],
    geminiModels: ['gemini-3.5-flash', 'gemini-2.5-pro'],
    geminiAliases: ['auto']
}

const CREDENTIAL_ENV = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_API_KEY',
    'GEMINI_MODEL',
    'GOOGLE_GEMINI_BASE_URL',
    'GEMINI_BASE_URL'
]

const jwt = (expSeconds: number): string => {
    const encode = (value: object): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.sig`
}

// The script probes `<cli> --version` by bare name. Left alone that reaches the
// sealed-env sentinel (or, without it, a real CLI), so each run plants its own
// stubs ahead of both — which also pins the versions these assertions would
// otherwise inherit from whatever the machine has installed.
const STUB_VERSIONS: Record<string, string> = {
    claude: '9.9.9 (Claude Code)',
    codex: 'codex-cli 9.9.9',
    gemini: '9.9.9'
}

const plantCliStubs = async (root: string): Promise<string> => {
    const bin = join(root, 'stub-bin')
    await mkdir(bin, { recursive: true })
    for (const [name, version] of Object.entries(STUB_VERSIONS))
        await writeFile(
            join(bin, name),
            `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
            { mode: 0o755 }
        )
    return bin
}

const inspect = async (
    framework: string,
    home: string,
    env: Record<string, string> = {}
): Promise<DaemonFrameworkModelCapability> => {
    const script = runtimeInspectScript(framework, catalog)
    const sanitized: Record<string, string> = { ...process.env } as Record<
        string,
        string
    >
    for (const key of CREDENTIAL_ENV) delete sanitized[key]
    const stubBin = await plantCliStubs(home)
    const { stdout } = await run(
        'bash',
        ['-c', script],
        {
            env: {
                ...sanitized,
                PATH: `${stubBin}${delimiter}${sanitized.PATH ?? ''}`,
                HOME: home,
                CODEX_HOME: join(home, '.codex'),
                ...env
            }
        }
    )
    const lines = stdout.trim().split('\n')
    const parsed = JSON.parse(lines[lines.length - 1]) as {
        frameworks: DaemonFrameworkModelCapability[]
    }
    assert.equal(parsed.frameworks.length, 1)
    return parsed.frameworks[0]
}

const withHome = async (
    fn: (home: string) => Promise<void>
): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'mf-inspect-script-'))
    await fn(home)
}

test('sandbox inspect reports an unsigned-in claude home as missing credentials', async () => {
    await withHome(async (home) => {
        // Exactly what ClaudeCodeBootstrap leaves behind before anyone signs
        // in: `mkdir -p "$HOME/.claude"` and nothing else. Seen on a
        // self-hosted sandbox [2026-09-01] reporting ready.
        await mkdir(join(home, '.claude'), { recursive: true })
        const capability = await inspect('claude-code', home)
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.envToken, false)
        assert.equal(facts.credentialsFileParsed, false)
        assert.equal(facts.oauthAccount, false)
        // The directory is ours, so it is reported but must not be believed.
        assert.equal(facts.configPresent, true)
        assert.equal(
            runtimeLocalCredentialStatus(facts, Date.now(), {
                configPresenceIsEvidence: false
            }).status,
            'missing'
        )
        // A machine the user owns keeps the benefit of the doubt (macOS holds
        // the token in the Keychain, where no inspect pass can see it).
        assert.equal(
            runtimeLocalCredentialStatus(facts, Date.now()).status,
            'unknown'
        )
    })
})

test('sandbox inspect reports claude oauth expiry and refresh capability', async () => {
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
        const capability = await inspect('claude-code', home)
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.framework, 'claude-code')
        assert.equal(facts.credentialsFileParsed, true)
        assert.equal(facts.oauthExpiresAt, 1_700_000_000_000)
        assert.equal(facts.hasRefreshToken, true)
        assert.equal(facts.configPresent, true)
        assert.equal(facts.envToken, false)
        assert.equal(
            runtimeLocalCredentialStatus(facts, 1_800_000_000_000).status,
            'valid'
        )
    })
})

test('sandbox inspect reports an expired claude token with no refresh path', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'redacted',
                    expiresAt: 1_700_000_000_000
                }
            })
        )
        const capability = await inspect('claude-code', home)
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.hasRefreshToken, false)
        assert.equal(
            runtimeLocalCredentialStatus(facts, 1_800_000_000_000).status,
            'expired'
        )
    })
})

test('sandbox inspect reads the legacy claude credentials key', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                oauthAccount: {
                    accessToken: 'redacted',
                    refreshToken: 'redacted-refresh',
                    expiresAt: 1_700_000_000_000
                }
            })
        )
        const capability = await inspect('claude-code', home)
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.oauthExpiresAt, 1_700_000_000_000)
        assert.equal(facts.hasRefreshToken, true)
    })
})

test('sandbox inspect reports the claude login record', async () => {
    await withHome(async (home) => {
        await writeFile(
            join(home, '.claude.json'),
            JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } })
        )
        const capability = await inspect('claude-code', home)
        const facts = capability.credentialFacts as ClaudeCredentialFacts
        assert.equal(facts.oauthAccount, true)
        assert.equal(facts.credentialsFileParsed, false)
    })
})

test('sandbox inspect decodes the codex access token expiry', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'auth.json'),
            JSON.stringify({
                OPENAI_API_KEY: null,
                last_refresh: '2026-08-27T12:13:10.749721Z',
                tokens: {
                    access_token: jwt(1_788_696_790),
                    refresh_token: 'redacted-refresh'
                }
            })
        )
        const capability = await inspect('codex', home)
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

test('sandbox inspect surfaces codex custom providers and profile models', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'config.toml'),
            [
                'model = "gateway-default"',
                'model_provider = "mygw"',
                '',
                '[model_providers.mygw]',
                'base_url = "https://gateway.example/v1"',
                'env_key = "MF_GATEWAY_KEY"',
                'requires_openai_auth = false',
                '',
                '[profiles.fast]',
                'model = "gateway-turbo"'
            ].join('\n')
        )
        const capability = await inspect('codex', home, {
            MF_GATEWAY_KEY: 'set-in-env'
        })
        const facts = capability.credentialFacts as CodexCredentialFacts
        assert.equal(facts.activeProvider, 'mygw')
        assert.equal(facts.customProviders.length, 1)
        assert.equal(facts.customProviders[0].id, 'mygw')
        assert.equal(facts.customProviders[0].hasBaseUrl, true)
        assert.equal(facts.customProviders[0].envKey, 'MF_GATEWAY_KEY')
        assert.equal(facts.customProviders[0].envKeyPresent, true)
        assert.ok(capability.models.includes('gateway-default'))
        assert.ok(capability.models.includes('gateway-turbo'))
        assert.equal(runtimeLocalCredentialStatus(facts, Date.now()).status, 'valid')
    })
})

// Seen on this repo [2026-08-27]: the emitted regex was over-escaped
// (`/^\\s*requires_openai_auth…/`), so it only ever matched a literal
// backslash and the sandbox treated OPENAI_API_KEY as usable even when the
// local config demanded ChatGPT auth. The daemon copy was always correct.
test('sandbox inspect honours requires_openai_auth', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'config.toml'),
            'requires_openai_auth = true\n'
        )
        const capability = await inspect('codex', home, {
            OPENAI_API_KEY: 'sk-should-be-ignored'
        })
        const facts = capability.credentialFacts as CodexCredentialFacts
        assert.equal(facts.envApiKey, false)
        assert.equal(capability.credentialReady, false)
    })
})

test('sandbox inspect reports the gemini oauth expiry date', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.gemini'), { recursive: true })
        await writeFile(
            join(home, '.gemini', 'oauth_creds.json'),
            JSON.stringify({
                refresh_token: 'redacted-refresh',
                expiry_date: 1_700_000_000_000
            })
        )
        const capability = await inspect('gemini-cli', home)
        const facts = capability.credentialFacts as GeminiCredentialFacts
        assert.equal(facts.oauthFilePresent, true)
        assert.equal(facts.oauthFileParsed, true)
        assert.equal(facts.oauthExpiryDate, 1_700_000_000_000)
        assert.equal(facts.hasRefreshToken, true)
        assert.equal(
            runtimeLocalCredentialStatus(facts, 1_800_000_000_000).status,
            'valid'
        )
    })
})

test('sandbox inspect keeps secrets out of the reported facts', async () => {
    await withHome(async (home) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'auth.json'),
            JSON.stringify({
                OPENAI_API_KEY: 'sk-super-secret-value',
                tokens: { access_token: jwt(1_788_696_790) }
            })
        )
        const capability = await inspect('codex', home)
        assert.equal(
            JSON.stringify(capability.credentialFacts).includes('sk-super'),
            false
        )
        assert.equal(
            (capability.credentialFacts as CodexCredentialFacts).apiKeyPresent,
            true
        )
    })
})
