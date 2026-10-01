import test from 'node:test'
import assert from 'node:assert/strict'
import { applyUpdates, type ApplyDeps } from '../src/commands/updates/apply'
import { createCliClient } from '../src/transport'
import { UsageError } from '../src/usage-error'
import { apiFetch, json, runMf, type Call, type Route } from './fixtures/fake-api'

const laptop = {
    id: 'dh_laptop',
    name: 'laptop',
    online: true,
    cliVersion: '5.6.0',
    latestCliVersion: '5.8.0',
    updateAvailable: true,
    needsUpgrade: false,
    canRemoteUpgrade: true,
    canCrossChannelUpgrade: false,
    herdrVersion: '0.5.1',
    latestHerdrVersion: '0.5.1',
    herdrUpdateAvailable: false
}
const buildBox = {
    ...laptop,
    id: 'dh_build',
    name: 'build-box',
    online: false,
    updateAvailable: false,
    herdrVersion: '0.4.0',
    herdrUpdateAvailable: true
}
const sandbox = {
    id: 'sbx_1',
    name: 'sandbox-001',
    status: 'ready',
    cliVersion: '5.7.0',
    latestCliVersion: '5.8.0',
    cliUpdateAvailable: true,
    herdrVersion: '0.5.1',
    latestHerdrVersion: '0.5.1',
    herdrUpdateAvailable: false,
    detectedFrameworks: [
        { framework: 'codex', version: '0.51.0', path: '/usr/bin/codex' }
    ]
}
const claudeOnLaptop = {
    id: 'art_laptop',
    name: 'claude-code on laptop',
    framework: 'claude-code',
    kind: 'daemon',
    hostId: 'dh_laptop',
    hostName: 'laptop',
    frameworkVersion: '2.1.200'
}
const catalog = (framework: string, latest: string, versions: string[]) => ({
    framework,
    latest,
    versions,
    source: 'npm',
    sourceRepo: null,
    fetchedAt: '2026-10-01T09:12:00.000Z',
    blocked: []
})

const listRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /daemon/hosts': () => json([laptop, buildBox]),
    'GET /sandboxes': () => json([sandbox]),
    'GET /pod-hosts': () => json([]),
    'GET /agent-runtimes': () => json([claudeOnLaptop]),
    'GET /framework-versions': () =>
        json([
            catalog('claude-code', '2.1.260', ['2.1.260']),
            catalog('codex', '0.52.0', ['0.52.0', '0.51.0'])
        ]),
    'GET /skills/installed': () => json([]),
    'GET /cli/versions': () => json({ stable: ['5.8.0', '5.7.2'], dev: [] }),
    ...over
})

const runRoutes = (over: Record<string, Route> = {}): Record<string, Route> =>
    listRoutes({
        'POST /sandboxes/sbx_1/cli/upgrade': () =>
            json({ ...sandbox, cliVersion: '5.8.0' }),
        'POST /daemon/hosts/dh_laptop/upgrade': () =>
            json({ ok: true, fromVersion: '5.6.0', toVersion: '5.8.0' }),
        'POST /sandboxes/sbx_1/frameworks/codex/install': () =>
            json(
                { error: { code: 'SANDBOX_DAEMON_OFFLINE', message: 'the runner is not answering' } },
                503
            ),
        ...over
    })

const posts = (calls: Call[]): string[] =>
    calls.filter((call) => call.method === 'POST').map((call) => call.path)

test('apply runs what can run, in the batch order, and exits 1 when one fails', async () => {
    const run = await runMf(['updates', 'apply', '--yes', '--json'], runRoutes())
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(posts(run.calls), [
        '/sandboxes/sbx_1/cli/upgrade',
        '/daemon/hosts/dh_laptop/upgrade',
        '/sandboxes/sbx_1/frameworks/codex/install'
    ])
    const body = JSON.parse(run.out.join('\n'))
    assert.deepEqual(
        body.results.map((result: { id: string; state: string }) => [result.id, result.state]),
        [
            ['cli:daemon:dh_laptop', 'updated'],
            ['cli:sandbox:sbx_1', 'updated'],
            ['framework:host:sbx_1:codex', 'failed']
        ]
    )
    assert.equal(body.results[2].code, 'SANDBOX_DAEMON_OFFLINE')
    assert.deepEqual(
        body.skipped.map((skipped: { id: string; status: string }) => [skipped.id, skipped.status]),
        [
            ['herdr:daemon:dh_build', 'offline'],
            ['framework:art_laptop', 'manual']
        ]
    )
    assert.deepEqual(body.summary, { updated: 2, pending: 0, failed: 1 })
    assert.equal(run.exitCode, 1)
})

test('a human run prints each result and the summary', async () => {
    const run = await runMf(['updates', 'apply', '--kind', 'cli', '--yes'], runRoutes())
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        '✓ mf CLI · sandbox-001  5.7.0 → 5.8.0',
        '✓ mf CLI · laptop  5.6.0 → 5.8.0',
        '2 updated · 0 pending · 0 failed'
    ])
    assert.match(run.err.join('\n'), /^updating mf CLI · sandbox-001…/)
    assert.equal(run.exitCode, undefined)
})

test('an update the platform takes later is pending and exits 0', async () => {
    const run = await runMf(
        ['updates', 'apply', 'cli:daemon:dh_laptop', '--yes', '--json'],
        runRoutes({
            'POST /daemon/hosts/dh_laptop/upgrade': () =>
                json({ ok: true, fromVersion: '5.6.0', toVersion: '5.8.0', deferred: true, activeSessions: 1 })
        })
    )
    const body = JSON.parse(run.out.join('\n'))
    assert.equal(body.results[0].state, 'pending')
    assert.equal(body.results[0].message, 'waits for 1 active session to finish, then takes 5.8.0')
    assert.equal(run.exitCode, undefined)
})

test('without --yes, a shell that cannot answer a prompt sends nothing', async () => {
    const quiet = await runMf(['updates', 'apply'], runRoutes())
    assert.ok(quiet.error instanceof UsageError)
    assert.match(quiet.error.message, /non-interactive shell; pass --yes/)
    assert.equal(quiet.calls.length, 0)

    const asJson = await runMf(['updates', 'apply', '--json'], runRoutes())
    assert.ok(asJson.error instanceof UsageError)
    assert.match(asJson.error.message, /--json never prompts/)
    assert.equal(asJson.calls.length, 0)
})

test('apply refuses a selection it cannot run, before running anything', async () => {
    const cases: Array<[string[], RegExp, Record<string, Route>?]> = [
        [['cli:sandbox:sbx_1', '--kind', 'cli'], /^pass update ids or --kind\/--where, not both$/],
        [['nope'], /^no pending update nope; mf updates list --json shows the ids$/],
        [
            ['herdr:daemon:dh_build'],
            /^herdr:daemon:dh_build cannot run from here \(offline\): build-box is offline/
        ],
        [['--kind', 'cli', '--to', '5.7.2'], /^--to needs exactly one update; this selects 2$/],
        [
            ['cli:sandbox:sbx_1', '--to', '9.9.9'],
            /^cli:sandbox:sbx_1 cannot go to 9\.9\.9; pick one of 5\.8\.0, 5\.7\.2$/
        ],
        [
            ['cli:sandbox:sbx_1', '--to', '5.8.0'],
            /^cli:sandbox:sbx_1 offers no versions to choose from \(its version list did not load\)$/,
            {
                'GET /cli/versions': () =>
                    json({ error: { code: 'unauthorized', message: 'needs a login session' } }, 401)
            }
        ]
    ]
    for (const [args, message, over] of cases) {
        const run = await runMf(['updates', 'apply', ...args, '--yes'], runRoutes(over))
        assert.ok(run.error instanceof UsageError, args.join(' '))
        assert.match(run.error.message, message)
        assert.deepEqual(posts(run.calls), [], args.join(' '))
    }
})

test('--to sends the version it was given', async () => {
    const run = await runMf(
        ['updates', 'apply', 'cli:sandbox:sbx_1', '--to', '5.7.2', '--yes', '--json'],
        runRoutes({
            'POST /sandboxes/sbx_1/cli/upgrade': () => json({ ...sandbox, cliVersion: '5.7.2' })
        })
    )
    assert.equal(run.error, undefined, String(run.error))
    const call = run.calls.find((candidate) => candidate.method === 'POST')
    assert.deepEqual(call?.body, { targetVersion: '5.7.2' })
    assert.equal(JSON.parse(run.out.join('\n')).results[0].to, '5.7.2')
})

const captured = async (fn: () => Promise<void>): Promise<string[]> => {
    const out: string[] = []
    const log = console.log
    const error = console.error
    console.log = (...values: unknown[]) => {
        out.push(values.map(String).join(' '))
    }
    console.error = () => {}
    try {
        await fn()
    } finally {
        console.log = log
        console.error = error
    }
    return out
}

test('on a terminal apply shows its plan and does nothing when declined', async () => {
    const run = async (answer: boolean) => {
        const calls: Call[] = []
        const client = createCliClient({
            baseUrl: 'https://api.test/api',
            token: 't',
            fetch: apiFetch(runRoutes(), calls)
        })
        const questions: string[] = []
        const deps: ApplyDeps = {
            timers: { now: () => 0, sleep: async () => {} },
            interactive: () => true,
            confirm: async (question) => {
                questions.push(question)
                return answer
            }
        }
        const out = await captured(() =>
            applyUpdates(client, ['cli:sandbox:sbx_1'], {}, deps)
        )
        return { out, questions, posts: posts(calls) }
    }
    const declined = await run(false)
    assert.deepEqual(declined.questions, ['Apply 1 update? [Y/n] '])
    assert.deepEqual(declined.out, [
        'Updates to run (1):',
        '  mf CLI · sandbox-001  5.7.0 → 5.8.0',
        'cancelled.'
    ])
    assert.deepEqual(declined.posts, [])

    const accepted = await run(true)
    assert.deepEqual(accepted.posts, ['/sandboxes/sbx_1/cli/upgrade'])
})
