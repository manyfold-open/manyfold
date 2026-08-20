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

test('whoami uses the runtime-safe auth endpoint for injected agent identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-'))
    const previousFetch = globalThis.fetch
    const previousExitCode = process.exitCode
    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = (async (input, init) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        requests.push({
            url,
            authorization: headers.get('authorization')
        })
        assert.equal(url, 'https://api.test/api/auth/whoami')
        return new Response(
            JSON.stringify({
                kind: 'agent-runtime',
                userId: 'user-1',
                agentId: 'agt_env'
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
                            'whoami'
                        ],
                        { from: 'node' }
                    )
                }
            )
        )

        assert.deepEqual(requests, [
            {
                url: 'https://api.test/api/auth/whoami',
                authorization: 'Bearer nca_rt_env'
            }
        ])
        assert.match(lines.join('\n'), /Signed in as agent agt_env/)
        assert.equal(process.exitCode, previousExitCode)
    } finally {
        globalThis.fetch = previousFetch
        process.exitCode = previousExitCode
        await rm(dir, { recursive: true, force: true })
    }
})
