import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'

test('ui resolve reads links without mutating or exposing credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-ui-'))
    const fetchBefore = globalThis.fetch
    const logBefore = console.log
    const configBefore = process.env.MF_CONFIG_DIR
    const tokenBefore = process.env.MF_API_TOKEN
    const lines: string[] = []
    process.env.MF_CONFIG_DIR = dir
    process.env.MF_API_TOKEN = 'test-only-secret'
    console.log = (line: unknown) => {
        lines.push(String(line))
    }
    globalThis.fetch = async (input, init) => {
        assert.equal(
            String(input),
            'https://api.example.test/api/automations/auto-1/ui'
        )
        assert.equal(init?.method ?? 'GET', 'GET')
        assert.equal(
            new Headers(init?.headers).get('authorization'),
            'Bearer test-only-secret'
        )
        return Response.json({
            resource: 'automation',
            resourceId: 'auto-1',
            url: 'https://web.example.test/automations/auto-1',
            runs: [
                {
                    runId: 'run-1',
                    sessionId: 'session-1',
                    url: 'https://web.example.test/agents/agent-1/chat?sessionId=session-1'
                }
            ]
        })
    }
    try {
        await buildProgram().parseAsync(
            [
                '--api-url',
                'https://api.example.test/api',
                'ui',
                'resolve',
                'automation',
                'auto-1',
                '--run-id',
                'run-1',
                '--json'
            ],
            { from: 'user' }
        )
        assert.equal(JSON.parse(lines[0]).sessionId, 'session-1')
        assert.match(JSON.parse(lines[0]).url, /sessionId=session-1$/)
        assert.ok(!lines.join('').includes('test-only-secret'))
        await assert.rejects(
            buildProgram().parseAsync(
                ['ui', 'resolve', 'automation', '--run-id', 'run-1'],
                { from: 'user' }
            ),
            /requires an automation id/
        )
    } finally {
        globalThis.fetch = fetchBefore
        console.log = logBefore
        if (configBefore === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = configBefore
        if (tokenBefore === undefined) delete process.env.MF_API_TOKEN
        else process.env.MF_API_TOKEN = tokenBefore
        await rm(dir, { recursive: true, force: true })
    }
})
