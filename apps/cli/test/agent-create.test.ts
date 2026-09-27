import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'

interface CapturedRequest {
    accept: string | null
    signal: AbortSignal | null | undefined
}

const ndjsonCreateFetch = (
    captured: CapturedRequest[]
): typeof fetch =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        captured.push({
            accept: headers.get('accept'),
            signal: init?.signal
        })
        const lines = [
            {
                type: 'step',
                step: 'validating',
                index: 0,
                total: 3,
                startedAt: '2026-07-13T00:00:00.000Z'
            },
            {
                type: 'step',
                step: 'creating_sprite',
                index: 1,
                total: 3,
                startedAt: '2026-07-13T00:00:01.000Z'
            },
            {
                type: 'complete',
                agent: {
                    id: 'agt_new',
                    name: 'demo',
                    framework: 'codex',
                    runtime: 'sprites',
                    status: 'ready',
                    availability: 'available',
                    hostName: 'sandbox-1'
                }
            }
        ]
        return new Response(
            `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
            {
                status: 201,
                headers: { 'content-type': 'application/x-ndjson' }
            }
        )
    }) as typeof fetch

const runCreate = async (
    args: string[],
    fetchImpl: typeof fetch
): Promise<{ out: string[]; err: string[] }> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-agent-create-'))
    const previousFetch = globalThis.fetch
    const previousEnv = {
        MF_CONFIG_DIR: process.env.MF_CONFIG_DIR,
        MF_PROFILE: process.env.MF_PROFILE,
        MF_API_TOKEN: process.env.MF_API_TOKEN
    }
    const previousLog = console.log
    const previousErr = console.error
    const out: string[] = []
    const err: string[] = []
    globalThis.fetch = fetchImpl
    process.env.MF_CONFIG_DIR = dir
    process.env.MF_PROFILE = 'test'
    process.env.MF_API_TOKEN = 'nca_rt_env'
    console.log = ((...values: unknown[]) => {
        out.push(values.map(String).join(' '))
    }) as typeof console.log
    console.error = ((...values: unknown[]) => {
        err.push(values.map(String).join(' '))
    }) as typeof console.error
    try {
        const program = buildProgram()
        await program.parseAsync(
            ['node', 'mf', '--api-url', 'https://api.test/api', ...args],
            { from: 'node' }
        )
        return { out, err }
    } finally {
        globalThis.fetch = previousFetch
        console.log = previousLog
        console.error = previousErr
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(dir, { recursive: true, force: true })
    }
}

const createArgs = [
    'agent',
    'create',
    'demo',
    '--framework',
    'codex',
    '--openai-api-key',
    'sk-test'
]

test('agent create provisions over the NDJSON stream, exempt from the request timeout', async () => {
    const captured: CapturedRequest[] = []
    const { out, err } = await runCreate(
        [...createArgs, '--json'],
        ndjsonCreateFetch(captured)
    )

    assert.equal(captured.length, 1)
    assert.equal(captured[0].accept, 'application/x-ndjson')
    assert.equal(captured[0].signal ?? null, null)

    const parsed = JSON.parse(out.join('\n'))
    assert.equal(parsed.id, 'agt_new')
    assert.equal(parsed.status, 'ready')

    const progress = err.join('\n')
    assert.match(progress, /\[1\/3\] validating/)
    assert.match(progress, /\[2\/3\] creating_sprite/)
})

test('agent create human output keeps the summary lines after streaming', async () => {
    const captured: CapturedRequest[] = []
    const { out } = await runCreate(createArgs, ndjsonCreateFetch(captured))
    const rendered = out.join('\n')
    assert.match(rendered, /agt_new/)
    assert.match(rendered, /host: sandbox-1/)
})

test('agent create sends an Antigravity CLI agent its Gemini key and agy model', async (t) => {
    for (const name of [
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GEMINI_BASE_URL'
    ]) {
        const prior = process.env[name]
        delete process.env[name]
        t.after(() => {
            if (prior !== undefined) process.env[name] = prior
        })
    }
    const bodies: unknown[] = []
    const replay = ndjsonCreateFetch([])
    const capturing = (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return replay(input, init)
    }) as typeof fetch
    await runCreate(
        [
            'agent',
            'create',
            'demo',
            '--framework',
            'antigravity-cli',
            '--google-api-key',
            'gk-test',
            '--agy-model',
            'gemini-3.8-flash-high',
            '--json'
        ],
        capturing
    )
    assert.deepEqual(bodies, [
        {
            name: 'demo',
            framework: 'antigravity-cli',
            antigravityCliCredentials: {
                googleApiKey: 'gk-test',
                model: 'gemini-3.8-flash-high'
            }
        }
    ])
})

test('agent create refuses a framework it cannot build a body for', async () => {
    await assert.rejects(
        runCreate(
            ['agent', 'create', 'demo', '--framework', 'hermes'],
            ndjsonCreateFetch([])
        ),
        /unsupported framework: hermes/
    )
})
