import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'

const withEnv = async (
    env: Record<string, string | undefined>,
    fn: () => Promise<void>
): Promise<void> => {
    const prev: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await fn()
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

const captureConsole = async (fn: () => Promise<void>): Promise<string[]> => {
    const previous = console.log
    const lines: string[] = []
    console.log = ((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
    }) as typeof console.log
    try {
        await fn()
        return lines
    } finally {
        console.log = previous
    }
}

test('auth ensure requests missing scopes for the current agent identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-'))
    const previousFetch = globalThis.fetch
    const requests: Array<{
        url: string
        authorization: string | null
        method: string
        body: unknown
    }> = []
    globalThis.fetch = (async (input, init) => {
        requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get('authorization'),
            method: init?.method ?? 'GET',
            body: JSON.parse(String(init?.body ?? '{}')) as unknown
        })
        return new Response(
            JSON.stringify({
                consentUrl: 'http://localhost:3002/grant-permission?token=t',
                scopes: ['a2a:read'],
                expiresAt: new Date().toISOString()
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        )
    }) as typeof fetch

    try {
        const lines = await captureConsole(() =>
            withEnv(
                {
                    MF_CONFIG_DIR: dir,
                    MF_PROFILE: 'test',
                    MF_API_TOKEN: 'nca_rt_env',
                    MF_AGENT_ID: 'agt_env'
                },
                async () => {
                    const program = buildProgram()
                    await program.parseAsync(
                        [
                            'node',
                            'mf',
                            '--api-url',
                            'https://api.test/api',
                            'auth',
                            'ensure',
                            '--scopes',
                            'a2a:read'
                        ],
                        { from: 'node' }
                    )
                }
            )
        )

        assert.deepEqual(requests, [
            {
                url: 'https://api.test/api/agents/agt_env/permissions/request',
                authorization: 'Bearer nca_rt_env',
                method: 'POST',
                body: { scopes: ['a2a:read'] }
            }
        ])
        const output = lines.join('\n')
        assert.match(output, /Authorization approval required/)
        assert.match(output, /Consent URL: .*grant-permission/)
    } finally {
        globalThis.fetch = previousFetch
        await rm(dir, { recursive: true, force: true })
    }
})
