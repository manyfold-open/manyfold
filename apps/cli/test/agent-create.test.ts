import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CommanderError } from 'commander'
import type {
    AgentRuntimeSummary,
    SandboxSummary,
    UserModelProviderSummary
} from '@manyfold/shared'
import {
    json,
    runMf as runFakeApi,
    type Call,
    type Route,
    type Run as FakeRun
} from './fixtures/fake-api'

// `mf agent create` against a fake API: what it sends for each model source
// and placement, what it refuses before sending anything, and how it follows
// a create whose stream drops or whose user presses Ctrl-C.

const line = (event: object): string => `${JSON.stringify(event)}\n`

const step = (name: string, index: number): object => ({
    type: 'step',
    step: name,
    index,
    total: 11,
    startedAt: '2026-09-29T00:00:00.000Z'
})

const agent = {
    id: 'agt_new',
    name: 'demo',
    framework: 'claude-code',
    runtime: 'sprites',
    status: 'ready',
    hostId: 'sbx_new',
    hostName: 'sandbox-4'
}

const created = (
    extra: { resumed?: boolean; requestId?: string } = {}
): Response =>
    new Response(
        [
            step('validating', 0),
            step('creating_sprite', 3),
            {
                type: 'complete',
                agent,
                ...(extra.resumed ? { resumed: true } : {})
            }
        ]
            .map(line)
            .join(''),
        {
            status: 201,
            headers: {
                'content-type': 'application/x-ndjson',
                ...(extra.requestId
                    ? { 'x-agent-create-request': extra.requestId }
                    : {})
            }
        }
    )

// A stream the API accepted that breaks after its first step.
const dropped = (requestId: string | null): Response =>
    new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(line(step('validating', 0)))
                )
                controller.error(new TypeError('terminated'))
            }
        }),
        {
            status: 201,
            headers: {
                'content-type': 'application/x-ndjson',
                ...(requestId ? { 'x-agent-create-request': requestId } : {})
            }
        }
    )

const provider = (
    over: Partial<UserModelProviderSummary> &
        Pick<UserModelProviderSummary, 'id' | 'providerName'>
): UserModelProviderSummary =>
    ({
        inferenceProtocol: null,
        builtInId: null,
        externalAccountId: null,
        apiKeyMasked: 'sk-***1234',
        baseUrl: null,
        modelsListUrl: null,
        source: 'byo',
        managedService: null,
        managedKeyId: null,
        managedBrand: null,
        lastTestedAt: null,
        lastTestStatus: 'ok',
        lastTestMessage: null,
        lastTestModels: null,
        enabledModels: null,
        createdAt: '',
        updatedAt: '',
        ...over
    }) as UserModelProviderSummary

const managedAnthropic = provider({
    id: 'ump_managed_anthropic',
    providerName: 'Managed Anthropic',
    source: 'managed',
    managedBrand: 'anthropic',
    inferenceProtocol: 'anthropic_messages',
    managedRank: 1,
    lastTestModels: {
        anthropic_messages: ['claude-sonnet-4-6', 'claude-haiku-4-5']
    }
})
const managedOther = provider({
    id: 'ump_managed_other',
    providerName: 'Managed Claude (other channel)',
    source: 'managed',
    managedBrand: 'antigravity_claude' as never,
    inferenceProtocol: 'anthropic_messages',
    managedRank: 4,
    lastTestModels: { anthropic_messages: ['claude-sonnet-4-6'] }
})
const teamOpenAI = provider({
    id: 'ump_team_openai',
    providerName: 'Team OpenAI',
    inferenceProtocol: 'openai_responses',
    lastTestModels: { openai_responses: ['gpt-5.4-mini', 'gpt-6-sol'] }
})
const untested = provider({
    id: 'ump_untested',
    providerName: 'Fresh key',
    inferenceProtocol: 'anthropic_messages',
    lastTestStatus: null
})

const sandboxRow = (
    over: Partial<SandboxSummary> & Pick<SandboxSummary, 'id' | 'name'>
): SandboxSummary =>
    ({
        status: 'ready',
        powerState: 'suspended',
        agentsCount: 1,
        createdAt: '2026-09-29T00:00:00.000Z',
        ...over
    }) as SandboxSummary

const box = sandboxRow({ id: 'sbx_box', name: 'box' })

const runtimeOn = (
    hostId: string,
    framework: string,
    status = 'ready'
): AgentRuntimeSummary =>
    ({
        id: `art_${framework}`,
        kind: 'sprites',
        hostId,
        framework,
        status
    }) as AgentRuntimeSummary

const defaultRoutes: Record<string, Route> = {
    'GET /config/capabilities': () =>
        json({
            edition: 'cloud',
            features: {},
            branding: { name: 'Manyfold', webBaseUrl: 'https://app.test/' }
        }),
    'POST /agents': () => created()
}

// Keys the CLI used to read from the shell: cleared for every run unless a
// test sets one on purpose.
const KEY_ENV = [
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'PI_API_KEY'
]

interface Run extends FakeRun {
    posts: Call[]
}

const runMf = async (
    args: string[],
    routes: Record<string, Route> = {},
    env: Record<string, string> = {}
): Promise<Run> => {
    const run = await runFakeApi(
        args,
        { ...defaultRoutes, ...routes },
        {
            ...Object.fromEntries(KEY_ENV.map((name) => [name, undefined])),
            ...env
        }
    )
    return {
        ...run,
        posts: run.calls.filter(
            (call) => call.method === 'POST' && call.path === '/agents'
        )
    }
}

const usageMessage = (run: Run): string => {
    assert.ok(
        run.error instanceof CommanderError,
        `expected a usage error, got ${String(run.error)}`
    )
    assert.equal(run.posts.length, 0, 'nothing may be created')
    return run.error.message
}

const outputJson = (
    run: Run
): Record<string, unknown> & {
    create: Record<string, unknown>
} => {
    assert.equal(run.error, undefined, String(run.error))
    return JSON.parse(run.out.join('\n'))
}

test('managed binds the best-ranked managed channel with its default model, and links the chat', async () => {
    const run = await runMf(
        ['agent', 'create', 'demo', '--model-provider', 'managed', '--json'],
        {
            'GET /me/model-providers': () =>
                json([managedOther, managedAnthropic, teamOpenAI])
        }
    )
    const result = outputJson(run)
    const body = run.posts[0].body as Record<string, unknown>
    assert.equal(body.runtime, 'sprites')
    assert.equal(body.sandboxId, undefined)
    assert.deepEqual(body.claudeCodeCredentials, {
        providerId: 'ump_managed_anthropic'
    })
    assert.equal(body.modelConfigSource, 'platform')
    assert.equal((body.modelConfig as { model: string }).model, 'sonnet')
    assert.equal(run.posts[0].headers.get('accept'), 'application/x-ndjson')
    assert.deepEqual(result.create, {
        resumed: false,
        sandbox: { id: 'sbx_new', name: 'sandbox-4', created: true },
        modelSource: {
            kind: 'managed',
            providerId: 'ump_managed_anthropic',
            providerName: 'Managed Anthropic',
            model: 'sonnet',
            providerModel: 'claude-sonnet-4-6'
        },
        chatUrl: 'https://app.test/agents/agt_new/chat',
        signInCommand: null
    })
    const progress = run.err.join('\n')
    assert.match(progress, /✓ Validating input {2}\S*\d+\.\d s/)
    assert.match(progress, /✓ Creating workspace/)
    assert.doesNotMatch(progress, /\[\d+\/\d+\]/)
})

test('a saved provider is named by id or name, and --model only from what it was tested with', async () => {
    const routes = {
        'GET /me/model-providers': () => json([teamOpenAI, untested])
    }
    const byName = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--framework',
            'codex',
            '--model-provider',
            'Team OpenAI',
            '--model',
            'gpt-6-sol',
            '--json'
        ],
        routes
    )
    const body = byName.posts[0].body as Record<string, unknown>
    assert.deepEqual(body.codexCredentials, { providerId: 'ump_team_openai' })
    assert.equal((body.modelConfig as { model: string }).model, 'gpt-6-sol')
    assert.equal(outputJson(byName).create.modelSource instanceof Object, true)

    assert.match(
        usageMessage(
            await runMf(
                [
                    'agent',
                    'create',
                    'demo',
                    '--framework',
                    'codex',
                    '--model-provider',
                    'ump_team_openai',
                    '--model',
                    'gpt-4o'
                ],
                routes
            )
        ),
        /^error: Team OpenAI was not tested with a model "gpt-4o"\.\nIt can run:\n {2}gpt-6-sol\n/
    )
    assert.match(
        usageMessage(
            await runMf(
                ['agent', 'create', 'demo', '--model-provider', 'Fresh key'],
                routes
            )
        ),
        /Fresh key has not been tested, so there is no model to run on it; test it: mf model-providers test "Fresh key"/
    )
    assert.match(
        usageMessage(
            await runMf(
                ['agent', 'create', 'demo', '--model-provider', 'nope'],
                routes
            )
        ),
        /no model provider "nope"/
    )
})

test('saying nothing about the model is a usage error listing what this account has', async () => {
    const run = await runMf(
        ['agent', 'create', 'demo', '--framework', 'codex'],
        { 'GET /me/model-providers': () => json([teamOpenAI, untested]) },
        { OPENAI_API_KEY: 'sk-in-the-shell' }
    )
    const message = usageMessage(run)
    assert.match(message, /say who serves codex's model/)
    assert.doesNotMatch(message, /--model-provider managed/)
    assert.match(message, /Team OpenAI \(ump_team_openai\)/)
    assert.doesNotMatch(message, /Fresh key/)
    assert.match(
        message,
        /OPENAI_API_KEY is set in this shell, but mf no longer reads keys from the environment/
    )
    assert.doesNotMatch(message, /sk-in-the-shell/)
})

test('flags that cannot go together are refused before anything is sent', async () => {
    for (const [args, pattern] of [
        [
            ['--openai-api-key', 'sk-x'],
            /--openai-api-key is for codex, not claude-code/
        ],
        [
            ['--anthropic-auth-token', 'sk-x', '--model-provider', 'managed'],
            /either --model-provider or --anthropic-auth-token/
        ],
        [
            ['--anthropic-base-url', 'https://x.test'],
            /goes with --anthropic-auth-token/
        ],
        [
            [
                '--sandbox',
                'box',
                '--runtime-provider',
                'rtp_x',
                '--model-provider',
                'managed'
            ],
            /--runtime-provider places a new sandbox/
        ],
        [['--framework', 'openclaw'], /argument 'openclaw' is invalid/]
    ] as const) {
        const run = await runMf(['agent', 'create', 'demo', ...args])
        assert.match(usageMessage(run), pattern)
        assert.deepEqual(run.calls, [], `${args.join(' ')} sent a request`)
    }
})

test('a pasted key goes in the credential; only gemini, pi and agy take --model with it', async () => {
    const codex = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--framework',
            'codex',
            '--openai-api-key',
            'sk-flag',
            '--json'
        ],
        {},
        { OPENAI_API_KEY: 'sk-env' }
    )
    assert.deepEqual(
        (codex.posts[0].body as Record<string, unknown>).codexCredentials,
        {
            openaiApiKey: 'sk-flag'
        }
    )
    assert.deepEqual(outputJson(codex).create.modelSource, {
        kind: 'key',
        model: null
    })
    assert.match(
        usageMessage(
            await runMf([
                'agent',
                'create',
                'demo',
                '--framework',
                'codex',
                '--openai-api-key',
                'sk-flag',
                '--model',
                'gpt-5.5'
            ])
        ),
        /--model needs a model provider for codex/
    )
    const agy = await runMf([
        'agent',
        'create',
        'demo',
        '--framework',
        'antigravity-cli',
        '--google-api-key',
        'g-key',
        '--model',
        'gemini-3.1-pro-low',
        '--json'
    ])
    assert.deepEqual(
        (agy.posts[0].body as Record<string, unknown>)
            .antigravityCliCredentials,
        { googleApiKey: 'g-key', model: 'gemini-3.1-pro-low' }
    )
    const pi = await runMf([
        'agent',
        'create',
        'demo',
        '--framework',
        'pi',
        '--pi-api-key',
        'pi-key',
        '--pi-provider',
        'openai',
        '--model',
        'gpt-5.4-mini',
        '--json'
    ])
    assert.deepEqual(
        (pi.posts[0].body as Record<string, unknown>).piCredentials,
        {
            apiKey: 'pi-key',
            provider: 'openai',
            model: 'gpt-5.4-mini'
        }
    )
})

test('--sandbox joins the framework already there, which keeps its credentials', async () => {
    const routes = {
        'GET /sandboxes': () =>
            json([box, sandboxRow({ id: 'sbx_other', name: 'other' })]),
        'GET /agent-runtimes': () =>
            json([runtimeOn('sbx_box', 'claude-code')]),
        'GET /agent-runtimes/art_claude-code/auth-profiles': () =>
            json({ availability: 'ok', defaultProfileId: 'rap_default' })
    }
    const joined = await runMf(
        ['agent', 'create', 'demo', '--sandbox', 'box', '--json'],
        routes
    )
    const body = joined.posts[0].body as Record<string, unknown>
    assert.equal(body.sandboxId, 'sbx_box')
    assert.equal(body.claudeCodeCredentials, undefined)
    assert.equal(body.modelConfigSource, undefined)
    const result = outputJson(joined)
    assert.deepEqual(result.create.modelSource, { kind: 'inherited' })
    assert.equal((result.create.sandbox as { created: boolean }).created, false)

    assert.match(
        usageMessage(
            await runMf(
                [
                    'agent',
                    'create',
                    'demo',
                    '--sandbox',
                    'box',
                    '--model-provider',
                    'managed'
                ],
                routes
            )
        ),
        /shares: leave out --model-provider, or change them for all of them after the create with mf agent credentials update/
    )

    const signedIn = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--sandbox',
            'box',
            '--model-provider',
            'subscription',
            '--json'
        ],
        routes
    )
    const subscription = signedIn.posts[0].body as Record<string, unknown>
    assert.equal(subscription.modelConfigSource, 'runtime-local')
    assert.equal(subscription.runtimeAuthProfileId, 'rap_default')
    assert.equal(outputJson(signedIn).create.signInCommand, null)

    // Asleep, so no sign-in to name: the agent takes whatever the machine is
    // signed in with, and the output says how to sign in if it is not.
    const asleep = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--sandbox',
            'box',
            '--model-provider',
            'subscription'
        ],
        {
            ...routes,
            'GET /agent-runtimes/art_claude-code/auth-profiles': () =>
                json({ availability: 'sandbox-asleep', defaultProfileId: null })
        }
    )
    assert.equal(
        (asleep.posts[0].body as Record<string, unknown>).runtimeAuthProfileId,
        undefined
    )
    assert.match(
        asleep.out.join('\n'),
        /If the sandbox is not signed in to your subscription yet/
    )
})

test('--sandbox without the framework installs it there, and a sandbox name must be unique', async () => {
    const routes = {
        'GET /sandboxes': () => json([box]),
        'GET /agent-runtimes': () => json([runtimeOn('sbx_box', 'codex')])
    }
    const run = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--sandbox',
            'box',
            '--model-provider',
            'subscription',
            '--json'
        ],
        routes
    )
    const body = run.posts[0].body as Record<string, unknown>
    assert.equal(body.sandboxId, 'sbx_box')
    assert.equal(body.modelConfigSource, 'runtime-local')
    assert.equal(body.runtimeAuthProfileId, undefined)
    assert.equal(
        outputJson(run).create.signInCommand,
        'cat | claude auth login --claudeai'
    )

    const human = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--sandbox',
            'box',
            '--model-provider',
            'subscription'
        ],
        routes
    )
    assert.match(human.out.join('\n'), /sign in to your subscription/)
    assert.match(human.out.join('\n'), /cat \| claude auth login --claudeai/)

    assert.match(
        usageMessage(
            await runMf(['agent', 'create', 'demo', '--sandbox', 'box'], {
                ...routes,
                'GET /me/model-providers': () => json([])
            })
        ),
        /say who serves claude-code's model/
    )
    assert.match(
        usageMessage(
            await runMf(
                [
                    'agent',
                    'create',
                    'demo',
                    '--sandbox',
                    'box',
                    '--model-provider',
                    'subscription'
                ],
                {
                    'GET /sandboxes': () =>
                        json([
                            box,
                            sandboxRow({ id: 'sbx_twin', name: 'box' })
                        ]),
                    'GET /agent-runtimes': () => json([])
                }
            )
        ),
        /2 sandboxes are named "box" \(sbx_box, sbx_twin\); pass the id/
    )
})

test('a dropped stream is picked up with the request the API named, never without one', async () => {
    const resumed = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--model-provider',
            'subscription',
            '--json'
        ],
        {
            'POST /agents': (_call, index) =>
                index === 0
                    ? dropped('acq_first')
                    : created({ resumed: true, requestId: 'acq_first' })
        }
    )
    assert.equal(resumed.posts.length, 2)
    assert.equal(resumed.posts[0].headers.get('x-agent-create-request'), null)
    assert.equal(
        resumed.posts[1].headers.get('x-agent-create-request'),
        'acq_first'
    )
    assert.deepEqual(resumed.posts[1].body, resumed.posts[0].body)
    assert.equal(outputJson(resumed).create.resumed, false)
    assert.match(resumed.err.join('\n'), /picking it up again \(1\/3\)/)

    // An API that names no request would start a second create.
    const older = await runMf(
        ['agent', 'create', 'demo', '--model-provider', 'subscription'],
        { 'POST /agents': () => dropped(null) }
    )
    assert.equal(older.posts.length, 1)
    assert.match(String(older.error), /terminated/)
})

test('a run that attached to a create already under way says so', async () => {
    const run = await runMf(
        ['agent', 'create', 'demo', '--model-provider', 'subscription'],
        { 'POST /agents': () => created({ resumed: true, requestId: 'acq_1' }) }
    )
    assert.equal(run.error, undefined)
    assert.match(
        run.out.join('\n'),
        /picked up the create of demo that was already under way/
    )
})

// A real child process: stdin, the exit code of a usage error, and Ctrl-C.
const cliDir = resolve(import.meta.dirname, '..')

const spawnMf = (args: string[], env: Record<string, string>) =>
    spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            '--import',
            './test/md-text-loader.mjs',
            'src/index.ts',
            ...args
        ],
        {
            cwd: cliDir,
            env: {
                PATH: process.env.PATH ?? '',
                TSX_TSCONFIG_PATH: join(cliDir, 'tsconfig.json'),
                ...env
            },
            stdio: ['pipe', 'pipe', 'pipe']
        }
    )

test(
    'a usage error exits 5 with a JSON error, before any request',
    { timeout: 60_000 },
    async (t) => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-cli-create-usage-'))
        t.after(() => rm(dir, { recursive: true, force: true }))
        const child = spawnMf(
            [
                '--api-url',
                'http://127.0.0.1:9/api',
                'agent',
                'create',
                'demo',
                '--openai-api-key',
                'sk-x',
                '--json'
            ],
            { HOME: dir, MF_CONFIG_DIR: dir, MF_API_TOKEN: 'nca_rt_env' }
        )
        child.stdin.end()
        let stderr = ''
        child.stderr.on('data', (data) => (stderr += data))
        const [code] = await once(child, 'close')
        assert.equal(code, 5)
        const error = JSON.parse(stderr.trim()).error
        assert.equal(error.code, 'invalid_usage')
        assert.match(error.message, /--openai-api-key is for codex/)
    }
)

test(
    'Ctrl-C stops watching, says the create goes on, and exits 130; a key can come from stdin',
    { timeout: 60_000 },
    async (t) => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-cli-create-sigint-'))
        let body: Record<string, unknown> | null = null
        let streaming: () => void = () => undefined
        const started = new Promise<void>((done) => (streaming = done))
        const server = createServer((req, res) => {
            let raw = ''
            req.on('data', (chunk) => (raw += chunk))
            req.on('end', () => {
                body = JSON.parse(raw)
                res.writeHead(201, {
                    'content-type': 'application/x-ndjson',
                    'x-agent-create-request': 'acq_sigint'
                })
                res.write(line(step('validating', 0)))
                streaming()
            })
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        t.after(async () => {
            server.closeAllConnections()
            server.close()
            await rm(dir, { recursive: true, force: true })
        })
        const port = (server.address() as AddressInfo).port
        const child = spawnMf(
            [
                '--api-url',
                `http://127.0.0.1:${port}/api`,
                'agent',
                'create',
                'demo',
                '--framework',
                'codex',
                '--openai-api-key',
                '-'
            ],
            { HOME: dir, MF_CONFIG_DIR: dir, MF_API_TOKEN: 'nca_rt_env' }
        )
        child.stdin.end('sk-from-stdin\n')
        let stderr = ''
        child.stderr.on('data', (data) => (stderr += data))
        const closed = once(child, 'close')
        await Promise.race([
            started,
            closed.then(() => {
                throw new Error(
                    `mf exited before it started the create: ${stderr}`
                )
            })
        ])
        await new Promise((done) => setTimeout(done, 300))
        child.kill('SIGINT')
        const [code] = await closed
        assert.equal(code, 130)
        assert.match(
            stderr,
            /The create goes on on the server: run the same command again to pick it up/
        )
        assert.deepEqual(
            (body as Record<string, unknown> | null)?.codexCredentials,
            { openaiApiKey: 'sk-from-stdin' }
        )
    }
)

// The id an alias stands for is saved as the alias, or the agent's model
// settings read it back as unmapped.
test('--model given the id an alias stands for binds the alias', async () => {
    const run = await runMf(
        [
            'agent',
            'create',
            'demo',
            '--model-provider',
            'managed',
            '--model',
            'claude-sonnet-4-6',
            '--json'
        ],
        {
            'GET /me/model-providers': () => json([managedAnthropic])
        }
    )
    const body = run.posts[0].body as { modelConfig: { model: string } }
    assert.equal(body.modelConfig.model, 'sonnet')
    const source = outputJson(run).create.modelSource as {
        model: string
        providerModel: string
    }
    assert.equal(source.model, 'sonnet')
    assert.equal(source.providerModel, 'claude-sonnet-4-6')
})
