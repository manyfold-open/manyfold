import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// #843: work owned by a transaction whose connection closed must settle
// through its own promise, and never reach a connection that is gone or
// already serves someone else. postgres.js 3.4.9 broke all of it; the fix is
// the pnpm patch of upstream porsager/postgres#1215.
const RUN = process.env.RUN_PG_E2E === '1'

interface Report {
    result?: Record<string, unknown>
    error?: string
    escaped: string[]
}

const runScenario = async (name: string): Promise<Report> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const child = spawn(
        process.execPath,
        [
            '--import',
            pathToFileURL(require.resolve('tsx')).href,
            join(__dirname, 'fixtures/postgres-connection-close.ts'),
            name
        ],
        {
            env: { ...process.env, DATABASE_URL: url },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    )
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 45_000)
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', resolve)
        })
        assert.equal(code, 0, output)
    } finally {
        clearTimeout(watchdog)
    }
    const line = output.split('\n').find((l) => l.startsWith('RESULT '))
    assert.ok(line, output)
    return JSON.parse(line.slice('RESULT '.length)) as Report
}

const closed = { outcome: 'rejected', code: 'CONNECTION_CLOSED' }

test(
    'a transaction whose backend dies mid-query rejects without touching the dead socket',
    { skip: !RUN, timeout: 60_000 },
    async () => {
        const report = await runScenario('inflight')
        assert.deepEqual(report, {
            result: { transaction: closed, after: 1 },
            escaped: []
        })
    }
)

test(
    'queries queued inside the transaction settle when it loses its connection',
    { skip: !RUN, timeout: 60_000 },
    async () => {
        const report = await runScenario('queued')
        assert.deepEqual(report, {
            result: {
                transaction: closed,
                queries: ['rejected', 'rejected', 'rejected'],
                after: 1
            },
            escaped: []
        })
    }
)

test(
    'a late query from a disconnected transaction never runs on the reused connection',
    { skip: !RUN, timeout: 60_000 },
    async () => {
        const report = await runScenario('late-query')
        assert.deepEqual(report, {
            result: {
                original: closed,
                replacement: { code: 'CONNECTION_CLOSED' }
            },
            escaped: []
        })
    }
)

for (const [scenario, how] of [
    ['late-commit', 'commit'],
    ['late-rollback', 'roll back']
] as const)
    test(
        `a disconnected transaction cannot ${how} the transaction that reused its connection`,
        { skip: !RUN, timeout: 60_000 },
        async () => {
            const report = await runScenario(scenario)
            assert.deepEqual(report, {
                result: {
                    original: closed,
                    replacement: { sameTransaction: true }
                },
                escaped: []
            })
        }
    )
