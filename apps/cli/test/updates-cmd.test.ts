import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCliError } from '../src/output'
import { UsageError } from '../src/usage-error'
import { json, runMf, type Route } from './fixtures/fake-api'

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
    cliVersion: '5.8.0',
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
        { framework: 'codex', version: '0.40.0', path: '/usr/bin/codex' }
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
const catalog = (framework: string, fields: object) => ({
    framework,
    latest: null,
    versions: [],
    source: 'npm',
    sourceRepo: null,
    fetchedAt: '2026-10-01T09:12:00.000Z',
    blocked: [],
    ...fields
})
const claudeCatalog = catalog('claude-code', {
    latest: '2.1.260',
    versions: ['2.1.260', '2.1.259']
})
const codexCatalog = catalog('codex', {
    latest: '0.52.0',
    versions: ['0.52.0', '0.51.0'],
    blocked: [
        { min: '0.40.0', max: '0.41.0', reason: 'drops tool results from resumed sessions' }
    ]
})
const research = {
    agent: { id: 'agt_research', name: 'research' },
    skills: [
        {
            skillId: 'skl_pdf',
            agentId: 'agt_research',
            name: 'pdf-tools',
            readonly: false,
            installedRevision: '1a2b3c4d5e6f',
            latestRevision: '9f8e7d6c5b4a',
            materializeStatus: 'failed',
            materializeError: 'clone timed out'
        }
    ]
}

const routes = (over: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /daemon/hosts': () => json([laptop, buildBox]),
    'GET /sandboxes': () => json([sandbox]),
    'GET /pod-hosts': () => json([]),
    'GET /agent-runtimes': () => json([claudeOnLaptop]),
    'GET /framework-versions': () => json([claudeCatalog, codexCatalog]),
    'GET /skills/installed': () => json([research]),
    'GET /cli/versions': () => json({ stable: ['5.8.0', '5.7.2'], dev: [] }),
    ...over
})

const unauthorized = (): Response =>
    json(
        {
            error: {
                code: 'unauthorized',
                message: 'this endpoint requires a login session or a full-access token'
            }
        },
        401
    )

test('mf updates lists every pending update the way the Update Center does', async () => {
    for (const args of [['updates'], ['updates', 'ls']]) {
        const run = await runMf(args, routes())
        assert.equal(run.error, undefined, String(run.error))
        const lines = run.out.join('\n').split('\n')
        assert.match(lines[0] ?? '', /^KIND +SUBJECT +WHERE +FROM +TO +STATUS$/)
        assert.deepEqual(
            lines.slice(1).map((line) => line.replace(/(\S) +/g, '$1 ')),
            [
                'framework Codex sandbox-001 0.40.0 0.52.0 required',
                '  drops tool results from resumed sessions',
                'cli mf CLI laptop 5.6.0 5.8.0 ready',
                'cli mf CLI sandbox-001 5.7.0 5.8.0 ready',
                'herdr herdr build-box 0.4.0 0.5.1 offline',
                '  build-box is offline: start its daemon there (mf daemon start), then run this again',
                'framework Claude Code laptop 2.1.200 2.1.260 by hand',
                '  on laptop: npm install -g @anthropic-ai/claude-code@latest',
                'skill pdf-tools research 1a2b3c4 9f8e7d6 failed',
                '  last install failed: clone timed out',
                '6 updates, 4 can run from here: mf updates apply'
            ]
        )
    }
})

test('mf updates --json carries each row with its stable id, status and guidance', async () => {
    const run = await runMf(['updates', '--json'], routes())
    assert.equal(run.error, undefined, String(run.error))
    const body = JSON.parse(run.out.join('\n'))
    assert.deepEqual(body.errors, [])
    assert.deepEqual(
        body.updates.map((row: { id: string; status: string; runnable: boolean }) => [
            row.id,
            row.status,
            row.runnable
        ]),
        [
            ['framework:host:sbx_1:codex', 'required', true],
            ['cli:daemon:dh_laptop', 'ready', true],
            ['cli:sandbox:sbx_1', 'ready', true],
            ['herdr:daemon:dh_build', 'offline', false],
            ['framework:art_laptop', 'manual', false],
            ['skill:agt_research:skl_pdf', 'ready', true]
        ]
    )
    assert.equal(
        body.updates[4].guidance,
        'on laptop: npm install -g @anthropic-ai/claude-code@latest'
    )
    assert.equal(run.err.length, 0)
})

test('a source that does not load is a warning, and the rest still lists', async () => {
    const run = await runMf(
        ['updates'],
        routes({ 'GET /framework-versions': unauthorized })
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(run.exitCode, undefined)
    assert.match(
        run.err.join('\n'),
        /^warning: framework versions did not load: this endpoint requires a login session/
    )
    const text = run.out.join('\n')
    assert.doesNotMatch(text, /Claude Code|Codex/)
    assert.match(text, /cli +mf CLI +laptop/)

    const asJson = await runMf(
        ['updates', '--json'],
        routes({ 'GET /framework-versions': unauthorized })
    )
    const body = JSON.parse(asJson.out.join('\n'))
    assert.deepEqual(body.errors, [
        {
            source: 'frameworkCatalog',
            code: 'unauthorized',
            status: 401,
            message: 'this endpoint requires a login session or a full-access token'
        }
    ])
    assert.equal(asJson.err.length, 0)
})

test('when nothing loads, the first failure decides the exit', async () => {
    const all = (route: Route): Record<string, Route> =>
        Object.fromEntries(Object.keys(routes()).map((key) => [key, route]))
    const denied = await runMf(['updates'], all(unauthorized))
    assert.equal(normalizeCliError(denied.error).exitCode, 3)
    const offline = await runMf(
        ['updates'],
        all(() => {
            throw new TypeError('fetch failed')
        })
    )
    assert.equal(normalizeCliError(offline.error).exitCode, 2)
})

test('--kind keeps one kind and --where one place, by name or id', async () => {
    const usage = await runMf(['updates', '--kind', 'cli-usage'], routes())
    assert.deepEqual(usage.out, ['No cli-usage updates.'])

    for (const where of ['laptop', 'dh_laptop', 'host:dh_laptop']) {
        const run = await runMf(['updates', '--where', where, '--json'], routes())
        assert.deepEqual(
            JSON.parse(run.out.join('\n')).updates.map((row: { id: string }) => row.id),
            ['cli:daemon:dh_laptop', 'framework:art_laptop'],
            where
        )
    }
    const byRuntime = await runMf(
        ['updates', '--where', 'art_laptop', '--json'],
        routes()
    )
    assert.deepEqual(
        JSON.parse(byRuntime.out.join('\n')).updates.map((row: { id: string }) => row.id),
        ['framework:art_laptop']
    )

    const bad = await runMf(['updates', '--kind', 'bogus'], routes())
    assert.match(String(bad.error), /Allowed choices are cli, herdr, framework, cli-usage, skill/)
})

test('a word that names no subcommand is refused, not run as list', async () => {
    const typo = await runMf(['updates', 'lsit'], routes())
    assert.ok(typo.error instanceof UsageError)
    assert.equal(
        typo.error.message,
        "unknown command 'lsit': mf updates has list, apply and versions"
    )
    assert.equal(normalizeCliError(typo.error).exitCode, 5)
    assert.deepEqual(typo.calls, [])

    const bare = await runMf(['updates', '--kind', 'cli'], routes())
    assert.equal(bare.error, undefined, String(bare.error))
    assert.ok(bare.calls.length > 0)
})

test('--where refuses a name two places share and a name nothing has', async () => {
    const twins = await runMf(
        ['updates', '--where', 'twin'],
        routes({
            'GET /daemon/hosts': () =>
                json([
                    { ...laptop, id: 'dh_a', name: 'twin' },
                    { ...laptop, id: 'dh_b', name: 'twin' }
                ])
        })
    )
    assert.ok(twins.error instanceof UsageError)
    assert.match(twins.error.message, /^2 places are named "twin" \(dh_a, dh_b\); pass the id$/)

    const none = await runMf(['updates', '--where', 'nowhere'], routes())
    assert.ok(none.error instanceof UsageError)
    assert.match(none.error.message, /^nothing named "nowhere"/)

    const known = await runMf(['updates', '--where', 'research', '--kind', 'cli'], routes())
    assert.equal(known.error, undefined)
    assert.deepEqual(known.out, ['No cli updates on research.'])

    // With a source missing, an unknown name may live in it: no error.
    const partial = await runMf(
        ['updates', '--where', 'nowhere'],
        routes({ 'GET /sandboxes': unauthorized })
    )
    assert.equal(partial.error, undefined)
    assert.deepEqual(partial.out, ['No updates on nowhere.'])
})

test('mf updates versions sums up the latest of each list', async () => {
    const run = await runMf(['updates', 'versions'], routes())
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(
        run.out.map((line) => line.replace(/ +/g, ' ')),
        [
            'NAME LATEST SOURCE',
            'cli 5.8.0 stable',
            'claude-code 2.1.260 npm',
            'codex 0.52.0 npm',
            'mf updates versions <name> lists every version.'
        ]
    )
    const asJson = await runMf(['updates', 'versions', '--json'], routes())
    const body = JSON.parse(asJson.out.join('\n'))
    assert.deepEqual(body.cli, { stable: '5.8.0', dev: null })
    assert.equal(body.frameworks.length, 2)
    assert.deepEqual(body.errors, [])
})

test('mf updates versions cli and <framework> list every version', async () => {
    const cli = await runMf(
        ['updates', 'versions', 'cli'],
        routes({
            'GET /cli/versions': () =>
                json({ stable: ['5.8.0', '5.7.2'], dev: ['5.9.0-dev.202610011200.abc1234'] })
        })
    )
    assert.equal(cli.error, undefined, String(cli.error))
    assert.match(cli.out[0] ?? '', /^VERSION +CHANNEL +NOTE$/)
    assert.match(cli.out[1] ?? '', /^5\.8\.0 +stable +latest/)
    assert.match(cli.out[3] ?? '', /^5\.9\.0-dev\.202610011200\.abc1234 +dev +latest$/)

    const codex = await runMf(['updates', 'versions', 'codex'], routes())
    assert.equal(codex.error, undefined, String(codex.error))
    assert.deepEqual(
        codex.out.map((line) => line.replace(/ +/g, ' ')),
        [
            'codex: npm, fetched 2026-10-01T09:12:00.000Z',
            'VERSION NOTE',
            '0.52.0 latest',
            '0.51.0',
            'BLOCKED REASON',
            '0.40.0–0.41.0 drops tool results from resumed sessions'
        ]
    )
    const asJson = await runMf(['updates', 'versions', 'codex', '--json'], routes())
    assert.deepEqual(JSON.parse(asJson.out.join('\n')), codexCatalog)
})

test('an unknown version list is a usage error that names the real ones', async () => {
    const run = await runMf(['updates', 'versions', 'bogus'], routes())
    assert.ok(run.error instanceof UsageError)
    assert.match(
        run.error.message,
        /^unknown version list "bogus"; pick cli or one of claude-code, codex$/
    )
    const denied = await runMf(
        ['updates', 'versions', 'codex'],
        routes({ 'GET /framework-versions': unauthorized })
    )
    assert.equal(normalizeCliError(denied.error).exitCode, 3)
})
