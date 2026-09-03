import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { RuntimeAccountProbe } from '@manyfold/shared'
import {
    ANTHROPIC_USAGE_URL,
    CODEX_USAGE_URL,
    GEMINI_LOAD_CODE_ASSIST_URL,
    GEMINI_USER_QUOTA_URL,
    inspectRuntimeAccount,
    type AccountInspectDeps
} from '../src/daemon/account-inspect'
import { rpcHandler } from '../src/daemon/rpc'
import type { RpcContext } from '../src/daemon/ws-client'

// account.inspect reads the CLIs' own credential files and calls the vendor
// usage endpoint FROM the daemon. These tests pin what leaves the machine: the
// exact request each vendor gets, the raw response echoed back, and — above
// all — that no token ever appears in the payload. Everything runs against a
// throwaway HOME with an injected fetch; no real credential or network is touched.

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)
const CLAUDE_TOKEN = 'sk-ant-oat01-claude-secret-token'
const CODEX_TOKEN_SECRET = 'codex-access-secret'

const b64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: object): string =>
    `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`

interface RecordedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: string | null
}

const stubFetch = (
    respond: (call: RecordedCall) => Response | Error
): { fetch: AccountInspectDeps['fetch']; calls: RecordedCall[] } => {
    const calls: RecordedCall[] = []
    const fetch = (async (input: unknown, init?: RequestInit) => {
        const call: RecordedCall = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: Object.fromEntries(
                Object.entries((init?.headers ?? {}) as Record<string, string>)
            ),
            body: typeof init?.body === 'string' ? init.body : null
        }
        calls.push(call)
        const out = respond(call)
        if (out instanceof Error) throw out
        return out
    }) as AccountInspectDeps['fetch']
    return { fetch, calls }
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init
    })

const CREDENTIAL_ENV = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_API_KEY',
    'GOOGLE_CLOUD_PROJECT'
]

const withHome = async (
    fn: (home: string) => Promise<void>
): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'mf-account-inspect-'))
    const prior = new Map(
        ['HOME', 'CODEX_HOME', 'PATH', ...CREDENTIAL_ENV].map(
            (key) => [key, process.env[key]] as const
        )
    )
    process.env.HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    for (const key of CREDENTIAL_ENV) delete process.env[key]
    try {
        await fn(home)
    } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

const deps = (
    fetch: AccountInspectDeps['fetch'],
    overrides: Partial<AccountInspectDeps> = {}
): Partial<AccountInspectDeps> => ({
    fetch,
    now: () => NOW,
    platform: 'linux',
    cliVersion: '2.1.7',
    ...overrides
})

const writeClaude = async (
    home: string,
    oauth: Record<string, unknown> | null
): Promise<void> => {
    await mkdir(join(home, '.claude'), { recursive: true })
    if (oauth)
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({ claudeAiOauth: oauth })
        )
    await writeFile(
        join(home, '.claude.json'),
        JSON.stringify({
            oauthAccount: {
                emailAddress: 'ying@example.com',
                displayName: 'Ying',
                organizationName: 'Example Org',
                organizationType: 'claude_team',
                userRateLimitTier: 'default_claude_max_5x',
                accountUuid: 'acc-uuid-1'
            }
        })
    )
}

test('claude: calls the oauth usage endpoint as the CLI and echoes the response', async () => {
    await withHome(async (home) => {
        await writeClaude(home, {
            accessToken: CLAUDE_TOKEN,
            refreshToken: 'refresh-secret',
            expiresAt: NOW + 3_600_000,
            subscriptionType: 'max'
        })
        const usageBody = {
            five_hour: { utilization: 12, resets_at: '2026-09-03T14:00:00Z' },
            seven_day: { utilization: 40, resets_at: '2026-09-08T00:00:00Z' }
        }
        const { fetch, calls } = stubFetch(() => json(usageBody))
        const report = await inspectRuntimeAccount('claude-code', deps(fetch))

        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, ANTHROPIC_USAGE_URL)
        assert.equal(calls[0].method, 'GET')
        assert.equal(calls[0].headers.Authorization, `Bearer ${CLAUDE_TOKEN}`)
        assert.equal(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20')
        assert.equal(calls[0].headers['User-Agent'], 'claude-code/2.1.7')

        assert.equal(report.tokenSource, 'file')
        assert.deepEqual(report.identity, {
            email: 'ying@example.com',
            name: 'Ying',
            organization: 'Example Org',
            plan: 'max',
            accountId: 'acc-uuid-1'
        })
        assert.equal(report.usage?.vendor, 'anthropic')
        assert.equal(report.usage?.status, 200)
        assert.deepEqual(report.usage?.body, usageBody)
        assert.equal(report.usage?.error, null)
        assert.equal(report.checkedAt, new Date(NOW).toISOString())

        const wire = JSON.stringify(report)
        assert.equal(wire.includes(CLAUDE_TOKEN), false, 'access token leaked')
        assert.equal(wire.includes('refresh-secret'), false, 'refresh token leaked')
    })
})

test('claude: a locally expired token is reported stale without a network call', async () => {
    await withHome(async (home) => {
        await writeClaude(home, {
            accessToken: CLAUDE_TOKEN,
            refreshToken: 'refresh-secret',
            expiresAt: NOW - 1
        })
        const { fetch, calls } = stubFetch(() => json({}))
        const report = await inspectRuntimeAccount('claude-code', deps(fetch))
        assert.equal(calls.length, 0)
        assert.equal(report.tokenSource, 'file')
        assert.equal(report.usage?.status, 0)
        assert.equal(report.usage?.error?.kind, 'stale-token')
        // No subscriptionType in the file: the plan falls back to the profile.
        assert.equal(report.identity?.plan, 'claude_team')
    })
})

test('claude: a Keychain-only sign-in on macOS keeps the identity but reads no usage', async () => {
    await withHome(async (home) => {
        await writeClaude(home, null)
        const { fetch, calls } = stubFetch(() => json({}))
        const darwin = await inspectRuntimeAccount(
            'claude-code',
            deps(fetch, { platform: 'darwin' })
        )
        assert.equal(calls.length, 0)
        assert.equal(darwin.tokenSource, 'keychain-unread')
        assert.equal(darwin.identity?.email, 'ying@example.com')
        assert.equal(darwin.usage, null)

        const linux = await inspectRuntimeAccount('claude-code', deps(fetch))
        assert.equal(linux.tokenSource, 'none')
        assert.equal(linux.usage, null)
    })
})

const writeCodexAuth = async (
    home: string,
    auth: Record<string, unknown>
): Promise<void> => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify(auth))
}

const codexTokens = (accessExpSeconds: number): Record<string, unknown> => ({
    id_token: jwt({
        email: 'ying@example.com',
        name: 'Ying Cai',
        'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-from-claim',
            chatgpt_plan_type: 'pro'
        },
        exp: accessExpSeconds
    }),
    access_token: jwt({ exp: accessExpSeconds, secret: CODEX_TOKEN_SECRET }),
    refresh_token: 'codex-refresh-secret',
    account_id: 'acct-1'
})

test('codex: reads identity from the id token and calls the ChatGPT usage endpoint', async () => {
    await withHome(async (home) => {
        await writeCodexAuth(home, {
            auth_mode: 'chatgpt',
            tokens: codexTokens(Math.floor(NOW / 1000) + 600),
            last_refresh: '2026-09-03T11:00:00Z'
        })
        const { fetch, calls } = stubFetch(() =>
            json({}, { status: 429, headers: { 'retry-after': '120' } })
        )
        const report = await inspectRuntimeAccount('codex', deps(fetch))

        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, CODEX_USAGE_URL)
        assert.match(calls[0].headers.Authorization, /^Bearer ey/)
        assert.equal(calls[0].headers['User-Agent'], 'codex-cli')
        assert.equal(calls[0].headers['OpenAI-Beta'], 'codex-1')
        assert.equal(calls[0].headers.originator, 'Codex Desktop')
        assert.equal(calls[0].headers['ChatGPT-Account-Id'], 'acct-1')

        assert.deepEqual(report.identity, {
            email: 'ying@example.com',
            name: 'Ying Cai',
            organization: null,
            plan: 'pro',
            accountId: 'acct-1'
        })
        assert.equal(report.usage?.status, 429)
        assert.equal(report.usage?.retryAfterSeconds, 120)
        assert.equal(report.usage?.body, null)
        const wire = JSON.stringify(report)
        assert.equal(wire.includes(CODEX_TOKEN_SECRET), false)
        assert.equal(wire.includes('codex-refresh-secret'), false)
    })
})

test('codex: api-key mode and expired tokens never reach the network', async () => {
    await withHome(async (home) => {
        const { fetch, calls } = stubFetch(() => json({}))
        await writeCodexAuth(home, {
            auth_mode: 'apikey',
            OPENAI_API_KEY: 'sk-openai-secret',
            tokens: codexTokens(Math.floor(NOW / 1000) + 600)
        })
        const apiKey = await inspectRuntimeAccount('codex', deps(fetch))
        assert.equal(apiKey.tokenSource, 'none')
        assert.equal(apiKey.usage, null)
        assert.equal(apiKey.identity?.email, 'ying@example.com')
        assert.equal(JSON.stringify(apiKey).includes('sk-openai'), false)

        await writeCodexAuth(home, {
            auth_mode: 'chatgpt',
            tokens: codexTokens(Math.floor(NOW / 1000) - 60)
        })
        const expired = await inspectRuntimeAccount('codex', deps(fetch))
        assert.equal(expired.tokenSource, 'file')
        assert.equal(expired.usage?.error?.kind, 'stale-token')
        assert.equal(calls.length, 0)
    })
})

const writeGemini = async (
    home: string,
    creds: Record<string, unknown> | null
): Promise<void> => {
    await mkdir(join(home, '.gemini'), { recursive: true })
    if (creds)
        await writeFile(
            join(home, '.gemini', 'oauth_creds.json'),
            JSON.stringify(creds)
        )
    await writeFile(
        join(home, '.gemini', 'google_accounts.json'),
        JSON.stringify({ active: 'ying@gmail.example', old: [] })
    )
}

test('gemini: resolves the Code Assist project, then asks for its quota', async () => {
    await withHome(async (home) => {
        await writeGemini(home, {
            access_token: 'ya29.gemini-secret',
            refresh_token: 'gemini-refresh-secret',
            expiry_date: NOW + 60_000
        })
        const quota = {
            buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }]
        }
        const { fetch, calls } = stubFetch((call) =>
            call.url === GEMINI_LOAD_CODE_ASSIST_URL
                ? json({ cloudaicompanionProject: 'proj-123' })
                : json(quota)
        )
        const report = await inspectRuntimeAccount('gemini-cli', deps(fetch))
        assert.deepEqual(
            calls.map((c) => [c.url, c.method]),
            [
                [GEMINI_LOAD_CODE_ASSIST_URL, 'POST'],
                [GEMINI_USER_QUOTA_URL, 'POST']
            ]
        )
        assert.deepEqual(JSON.parse(calls[0].body ?? ''), {
            metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
        })
        assert.deepEqual(JSON.parse(calls[1].body ?? ''), { project: 'proj-123' })
        assert.equal(calls[1].headers.Authorization, 'Bearer ya29.gemini-secret')
        assert.equal(report.identity?.email, 'ying@gmail.example')
        assert.deepEqual(report.usage?.body, quota)
        assert.equal(JSON.stringify(report).includes('ya29'), false)
    })
})

test('gemini: a rejected project lookup is the reported outcome, not a second call', async () => {
    await withHome(async (home) => {
        await writeGemini(home, {
            access_token: 'ya29.gemini-secret',
            expiry_date: NOW + 60_000
        })
        const { fetch, calls } = stubFetch(() => json({}, { status: 401 }))
        const report = await inspectRuntimeAccount('gemini-cli', deps(fetch))
        assert.equal(calls.length, 1)
        assert.equal(report.usage?.status, 401)

        await writeGemini(home, {
            access_token: 'ya29.gemini-secret',
            expiry_date: NOW - 1
        })
        const expired = await inspectRuntimeAccount('gemini-cli', deps(fetch))
        assert.equal(expired.usage?.error?.kind, 'stale-token')
        assert.equal(calls.length, 1)
    })
})

test('network failures are classified, never thrown', async () => {
    await withHome(async (home) => {
        await writeClaude(home, {
            accessToken: CLAUDE_TOKEN,
            expiresAt: NOW + 3_600_000
        })
        const down = stubFetch(() => new TypeError('fetch failed'))
        const network = await inspectRuntimeAccount('claude-code', deps(down.fetch))
        assert.equal(network.usage?.error?.kind, 'network')
        assert.equal(network.usage?.error?.message, 'fetch failed')

        const slow = stubFetch(() => {
            const err = new Error('The operation was aborted due to timeout')
            err.name = 'TimeoutError'
            return err
        })
        const timeout = await inspectRuntimeAccount('claude-code', deps(slow.fetch))
        assert.equal(timeout.usage?.error?.kind, 'timeout')
    })
})

test('rpc: account.inspect merges the credential facts and refuses other frameworks', async () => {
    const ctx: RpcContext = {
        refId: 'account-inspect-test',
        sendEvent: () => {},
        onCancel: () => {}
    }
    await withHome(async (home) => {
        // A bare `codex --version` probe must hit a stub, not the machine's CLI.
        const bin = join(home, 'stub-bin')
        await mkdir(bin, { recursive: true })
        for (const name of ['claude', 'codex', 'gemini'])
            await writeFile(join(bin, name), "#!/bin/sh\nprintf '9.9.9\\n'\n", {
                mode: 0o755
            })
        process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
        await writeCodexAuth(home, {
            auth_mode: 'apikey',
            OPENAI_API_KEY: 'sk-openai-secret'
        })
        const result = await rpcHandler('account.inspect', { framework: 'codex' }, ctx)
        assert.equal(result.ok, true)
        const probe = result.payload as unknown as RuntimeAccountProbe
        assert.equal(probe.framework, 'codex')
        assert.equal(probe.tokenSource, 'none')
        assert.equal(probe.usage, null)
        assert.equal(probe.credentialFacts?.framework, 'codex')
        assert.equal(
            (probe.credentialFacts as { apiKeyPresent: boolean }).apiKeyPresent,
            true
        )
        assert.equal(JSON.stringify(probe).includes('sk-openai'), false)

        const refused = await rpcHandler(
            'account.inspect',
            { framework: 'openclaw' },
            ctx
        )
        assert.equal(refused.ok, false)
        assert.match(refused.error ?? '', /unsupported framework/)
    })
})
