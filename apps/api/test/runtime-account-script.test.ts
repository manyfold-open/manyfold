import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { RuntimeAccountProbe } from '@manyfold/shared'
import { runtimeAccountScript } from '../src/modules/agent-runtimes/account/runtime-account-script'

// The sandbox account script is a hand-mirrored copy of the daemon's
// account-inspect.ts, emitted as a string, so nothing type checks it: these
// tests run the real emitted script against a fixture HOME and a local HTTP
// stub standing in for the vendors. Its sibling is
// apps/cli/test/daemon-account-inspect.test.ts; the two pin the same contract
// (exact request, raw response echoed, no token in the output) on purpose.

const run = promisify(execFile)

const CREDENTIAL_ENV = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_API_KEY',
    'GOOGLE_CLOUD_PROJECT'
]

const b64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: object): string =>
    `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`

interface Recorded {
    method: string
    path: string
    headers: IncomingMessage['headers']
    body: string
}

interface Stub {
    server: Server
    base: string
    calls: Recorded[]
    respond: (
        req: Recorded
    ) => { status: number; body: unknown; headers?: Record<string, string> }
}

const startStub = async (): Promise<Stub> => {
    const stub: Stub = {
        server: createServer(),
        base: '',
        calls: [],
        respond: () => ({ status: 200, body: {} })
    }
    stub.server.on('request', (req, res) => {
        let body = ''
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8')
        })
        req.on('end', () => {
            const recorded: Recorded = {
                method: req.method ?? 'GET',
                path: req.url ?? '/',
                headers: req.headers,
                body
            }
            stub.calls.push(recorded)
            const out = stub.respond(recorded)
            res.writeHead(out.status, {
                'content-type': 'application/json',
                ...(out.headers ?? {})
            })
            res.end(JSON.stringify(out.body))
        })
    })
    await new Promise<void>((resolve) =>
        stub.server.listen(0, '127.0.0.1', () => resolve())
    )
    const address = stub.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    stub.base = `http://127.0.0.1:${address.port}`
    return stub
}

const endpointsFor = (base: string) => ({
    anthropicUsage: `${base}/anthropic/usage`,
    codexUsage: `${base}/codex/usage`,
    geminiLoadCodeAssist: `${base}/gemini/load`,
    geminiUserQuota: `${base}/gemini/quota`
})

// `claude --version` feeds the User-Agent; plant a stub so the assertion does
// not depend on (or reach) whatever the machine has installed.
const plantClaudeStub = async (root: string): Promise<string> => {
    const bin = join(root, 'stub-bin')
    await mkdir(bin, { recursive: true })
    await writeFile(
        join(bin, 'claude'),
        `#!/bin/sh\nprintf '%s\\n' '2.1.7 (Claude Code)'\n`,
        { mode: 0o755 }
    )
    return bin
}

const inspect = async (
    framework: 'claude-code' | 'codex' | 'gemini-cli',
    home: string,
    base: string
): Promise<{ probe: RuntimeAccountProbe; stdout: string }> => {
    const sanitized: Record<string, string> = { ...process.env } as Record<
        string,
        string
    >
    for (const key of CREDENTIAL_ENV) delete sanitized[key]
    const stubBin = await plantClaudeStub(home)
    const { stdout } = await run(
        'bash',
        ['-c', runtimeAccountScript(framework, endpointsFor(base))],
        {
            env: {
                ...sanitized,
                PATH: `${stubBin}${delimiter}${sanitized.PATH ?? ''}`,
                HOME: home,
                CODEX_HOME: join(home, '.codex')
            }
        }
    )
    const lines = stdout.trim().split('\n')
    const parsed = JSON.parse(lines[lines.length - 1]) as {
        account: RuntimeAccountProbe
    }
    return { probe: parsed.account, stdout }
}

const withFixture = async (
    fn: (home: string, stub: Stub) => Promise<void>
): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'mf-account-script-'))
    const stub = await startStub()
    try {
        await fn(home, stub)
    } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()))
    }
}

test('sandbox account script: claude calls the usage endpoint as the CLI and echoes the body', async () => {
    await withFixture(async (home, stub) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'sk-ant-oat01-sandbox-secret',
                    refreshToken: 'refresh-secret',
                    expiresAt: Date.now() + 3_600_000,
                    subscriptionType: 'max'
                }
            })
        )
        await writeFile(
            join(home, '.claude.json'),
            JSON.stringify({
                oauthAccount: {
                    emailAddress: 'ying@example.com',
                    organizationName: 'Example Org',
                    accountUuid: 'acc-1'
                }
            })
        )
        const body = { five_hour: { utilization: 12, resets_at: '2026-09-03T14:00:00Z' } }
        stub.respond = () => ({ status: 200, body })
        const { probe, stdout } = await inspect('claude-code', home, stub.base)

        assert.equal(stub.calls.length, 1)
        assert.equal(stub.calls[0].path, '/anthropic/usage')
        assert.equal(
            stub.calls[0].headers.authorization,
            'Bearer sk-ant-oat01-sandbox-secret'
        )
        assert.equal(stub.calls[0].headers['anthropic-beta'], 'oauth-2025-04-20')
        assert.equal(stub.calls[0].headers['user-agent'], 'claude-code/2.1.7')

        assert.equal(probe.framework, 'claude-code')
        assert.equal(probe.tokenSource, 'file')
        assert.deepEqual(probe.identity, {
            email: 'ying@example.com',
            name: null,
            organization: 'Example Org',
            plan: 'max',
            accountId: 'acc-1'
        })
        assert.equal(probe.usage?.vendor, 'anthropic')
        assert.equal(probe.usage?.status, 200)
        assert.deepEqual(probe.usage?.body, body)
        assert.equal(stdout.includes('sandbox-secret'), false, 'token leaked')
        assert.equal(stdout.includes('refresh-secret'), false, 'refresh leaked')
    })
})

test('sandbox account script: an expired claude token is stale, not fetched', async () => {
    await withFixture(async (home, stub) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'sk-ant-oat01-sandbox-secret',
                    expiresAt: Date.now() - 1
                }
            })
        )
        const { probe } = await inspect('claude-code', home, stub.base)
        assert.equal(stub.calls.length, 0)
        assert.equal(probe.tokenSource, 'file')
        assert.equal(probe.identity, null)
        assert.equal(probe.usage?.error?.kind, 'stale-token')
    })
})

test('sandbox account script: codex sends the ChatGPT headers and surfaces a 429 with Retry-After', async () => {
    await withFixture(async (home, stub) => {
        const exp = Math.floor(Date.now() / 1000) + 600
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'auth.json'),
            JSON.stringify({
                auth_mode: 'chatgpt',
                tokens: {
                    id_token: jwt({
                        email: 'ying@example.com',
                        'https://api.openai.com/auth': {
                            chatgpt_plan_type: 'pro',
                            chatgpt_account_id: 'acct-claim'
                        },
                        exp
                    }),
                    access_token: jwt({ exp, secret: 'codex-secret-marker' }),
                    refresh_token: 'codex-refresh-secret',
                    account_id: 'acct-1'
                }
            })
        )
        stub.respond = () => ({
            status: 429,
            body: { error: 'slow down' },
            headers: { 'retry-after': '90' }
        })
        const { probe, stdout } = await inspect('codex', home, stub.base)
        assert.equal(stub.calls.length, 1)
        assert.equal(stub.calls[0].path, '/codex/usage')
        assert.equal(stub.calls[0].headers['user-agent'], 'codex-cli')
        assert.equal(stub.calls[0].headers['openai-beta'], 'codex-1')
        assert.equal(stub.calls[0].headers.originator, 'Codex Desktop')
        assert.equal(stub.calls[0].headers['chatgpt-account-id'], 'acct-1')
        assert.deepEqual(probe.identity, {
            email: 'ying@example.com',
            name: null,
            organization: null,
            plan: 'pro',
            accountId: 'acct-1'
        })
        assert.equal(probe.usage?.status, 429)
        assert.equal(probe.usage?.retryAfterSeconds, 90)
        assert.equal(probe.usage?.body, null)
        assert.equal(stdout.includes('codex-secret-marker'), false)
        assert.equal(stdout.includes('codex-refresh-secret'), false)
    })
})

test('sandbox account script: api-key codex has no account to read', async () => {
    await withFixture(async (home, stub) => {
        await mkdir(join(home, '.codex'), { recursive: true })
        await writeFile(
            join(home, '.codex', 'auth.json'),
            JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-openai-secret' })
        )
        const { probe, stdout } = await inspect('codex', home, stub.base)
        assert.equal(stub.calls.length, 0)
        assert.equal(probe.tokenSource, 'none')
        assert.equal(probe.identity, null)
        assert.equal(probe.usage, null)
        assert.equal(stdout.includes('sk-openai'), false)
    })
})

test('sandbox account script: gemini resolves its project before asking for quota', async () => {
    await withFixture(async (home, stub) => {
        await mkdir(join(home, '.gemini'), { recursive: true })
        await writeFile(
            join(home, '.gemini', 'oauth_creds.json'),
            JSON.stringify({
                access_token: 'ya29.sandbox-secret',
                expiry_date: Date.now() + 60_000
            })
        )
        await writeFile(
            join(home, '.gemini', 'google_accounts.json'),
            JSON.stringify({ active: 'ying@gmail.example' })
        )
        const quota = { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.4 }] }
        stub.respond = (req) =>
            req.path === '/gemini/load'
                ? { status: 200, body: { cloudaicompanionProject: 'proj-9' } }
                : { status: 200, body: quota }
        const { probe, stdout } = await inspect('gemini-cli', home, stub.base)
        assert.deepEqual(
            stub.calls.map((c) => [c.method, c.path]),
            [
                ['POST', '/gemini/load'],
                ['POST', '/gemini/quota']
            ]
        )
        assert.deepEqual(JSON.parse(stub.calls[0].body), {
            metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
        })
        assert.deepEqual(JSON.parse(stub.calls[1].body), { project: 'proj-9' })
        assert.equal(probe.identity?.email, 'ying@gmail.example')
        assert.deepEqual(probe.usage?.body, quota)
        assert.equal(stdout.includes('ya29'), false)
    })
})

test('sandbox account script: an unreachable vendor is reported, never thrown', async () => {
    await withFixture(async (home, stub) => {
        await mkdir(join(home, '.claude'), { recursive: true })
        await writeFile(
            join(home, '.claude', '.credentials.json'),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'sk-ant-oat01-sandbox-secret',
                    expiresAt: Date.now() + 3_600_000
                }
            })
        )
        // Point the script at a closed port: a connection refusal, not a stub.
        const closed = await startStub()
        const port = (closed.server.address() as { port: number }).port
        await new Promise<void>((resolve) => closed.server.close(() => resolve()))
        const { probe } = await inspect(
            'claude-code',
            home,
            `http://127.0.0.1:${port}`
        )
        assert.equal(stub.calls.length, 0)
        assert.equal(probe.usage?.status, 0)
        assert.equal(probe.usage?.error?.kind, 'network')
    })
})
