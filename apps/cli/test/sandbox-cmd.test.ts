import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import type { AgentRuntimeSummary, SandboxSummary } from '@manyfold/shared'
import { json, runMf } from './fixtures/fake-api'

const sandbox = (
    over: Partial<SandboxSummary> & Pick<SandboxSummary, 'id' | 'name'>
): SandboxSummary =>
    ({
        status: 'ready',
        powerState: 'suspended',
        agentsCount: 0,
        createdAt: '2026-09-28T10:00:00.000Z',
        ...over
    }) as SandboxSummary

const busy = sandbox({
    id: 'sbx_busy',
    name: 'busy',
    agentsCount: 2,
    cliVersion: '4.8.0',
    latestCliVersion: '4.9.0',
    cliUpdateAvailable: true
})
const idle = sandbox({
    id: 'sbx_idle',
    name: 'idle',
    cliVersion: '4.9.0',
    latestCliVersion: '4.9.0',
    cliUpdateAvailable: false
})
const broken = sandbox({
    id: 'sbx_broken',
    name: 'broken',
    status: 'failed',
    failureReason:
        "the new sandbox's runner did not connect to this API at https://tunnel.example.com/api (runner_unavailable)"
})

const listRoutes = {
    'GET /sandboxes': () => json([busy, idle, broken]),
    'GET /agent-runtimes': () =>
        json([
            {
                id: 'art_1',
                hostId: 'sbx_busy',
                framework: 'claude-code',
                status: 'ready'
            },
            {
                id: 'art_2',
                hostId: 'sbx_busy',
                framework: 'codex',
                status: 'ready'
            }
        ] as AgentRuntimeSummary[]),
    'GET /me/runtime-access': () =>
        json({
            statefulSandboxUsage: 2,
            statefulSandboxLimit: 3,
            plan: { name: 'Free' }
        })
}

test('sandbox list shows what runs on each sandbox and how many the plan includes', async () => {
    const human = await runMf(['sandbox', 'list'], listRoutes)
    assert.equal(human.error, undefined, String(human.error))
    const text = human.out.join('\n')
    assert.match(text, /^ID +NAME +STATE +AGENTS +FRAMEWORKS +CLI +CREATED$/m)
    assert.match(
        text,
        /sbx_busy +\S*busy\S* +ready, suspended +2 +claude-code, codex +\S*4\.8\.0 → 4\.9\.0\S* +\S*2026-09-28/
    )
    assert.match(
        text,
        /sbx_idle +\S*idle\S* +ready, suspended +0 +nothing installed +4\.9\.0 +\S*2026-09-28/
    )
    assert.match(text, /sbx_broken +\S*broken\S* +failed.* +— +\S*2026-09-28/)
    assert.match(
        text,
        /mf sandbox update <sandbox> updates one; mf updates apply --kind cli updates them all\./
    )
    assert.match(text, /2 of 3 sandboxes in use \(Free plan\)/)
    assert.match(
        text,
        /sbx_broken .*failed.*\n {2}\S*the new sandbox's runner did not connect to this API at https:\/\/tunnel\.example\.com\/api/
    )

    const scripted = await runMf(['sandbox', 'list', '--json'], listRoutes)
    const result = JSON.parse(scripted.out.join('\n'))
    assert.deepEqual(result.quota, { used: 2, limit: 3, plan: 'Free' })
    assert.deepEqual(result.sandboxes[0].runtimes, [
        { id: 'art_1', framework: 'claude-code', status: 'ready' },
        { id: 'art_2', framework: 'codex', status: 'ready' }
    ])
})

test('sandbox delete takes a name, wants --yes, and names the agents in the way', async () => {
    const refused = await runMf(['sandbox', 'delete', 'idle'], {
        'GET /sandboxes': () => json([busy, idle])
    })
    assert.match(
        String(refused.error),
        /refusing to delete sandbox idle \(sbx_idle\) without --yes/
    )
    assert.ok(!refused.calls.some((call) => call.method === 'DELETE'))

    const deleted = await runMf(
        ['sandbox', 'delete', 'idle', '--yes', '--json'],
        {
            'GET /sandboxes': () => json([busy, idle]),
            'DELETE /sandboxes/sbx_idle': () =>
                new Response(null, { status: 204 })
        }
    )
    assert.equal(deleted.error, undefined, String(deleted.error))
    assert.deepEqual(JSON.parse(deleted.out.join('\n')), {
        ok: true,
        id: 'sbx_idle'
    })

    const inUse = await runMf(
        ['sandbox', 'delete', 'busy', '--yes', '--json'],
        {
            'GET /sandboxes': () => json([busy, idle]),
            'DELETE /sandboxes/sbx_busy': () =>
                json(
                    {
                        error: {
                            code: 'HOST_NOT_EMPTY',
                            message: 'host still has agents; delete them first'
                        }
                    },
                    409
                ),
            'GET /agents': () =>
                json([
                    { id: 'agt_a', name: 'alpha', hostId: 'sbx_busy' },
                    { id: 'agt_b', name: 'beta', hostId: 'sbx_elsewhere' }
                ])
        }
    )
    const error = JSON.parse(inUse.err.join('\n')).error
    assert.equal(error.code, 'HOST_NOT_EMPTY')
    assert.equal(
        error.hint,
        'Delete its agents first: mf agent delete agt_a --yes (alpha)'
    )
    assert.equal(inUse.exitCode, 1)

    const unknown = await runMf(['sandbox', 'delete', 'nope', '--yes'], {
        'GET /sandboxes': () => json([busy, idle])
    })
    assert.ok(unknown.error instanceof CommanderError)
    assert.match(unknown.error.message, /no sandbox named "nope"/)
})

// A sandbox's Manyfold CLI too old for what is asked of it (SANDBOX_CLI_TOO_OLD)
// is updated from here, as from the web's Update Center.
const old = sandbox({
    id: 'sbx_old',
    name: 'sandbox-002',
    cliVersion: '4.8.0',
    latestCliVersion: '4.8.0',
    cliUpdateAvailable: false
})
const catalog = {
    stable: ['4.8.0', '4.7.2'],
    dev: ['5.6.0-dev.202609291528.61f0db7', '5.5.0-dev.202609281200.aaaaaaa']
}
const updateRoutes = (after: SandboxSummary) => ({
    'GET /sandboxes': () => json([idle, old]),
    'GET /cli/versions': () => json(catalog),
    'POST /sandboxes/sbx_old/cli/upgrade': () => json(after)
})

test('sandbox update names the sandbox by name and says from which version to which', async () => {
    const run = await runMf(
        [
            'sandbox',
            'update',
            'sandbox-002',
            '--to',
            '5.6.0-dev.202609291528.61f0db7'
        ],
        updateRoutes({ ...old, cliVersion: '5.6.0-dev.202609291528.61f0db7' })
    )
    assert.equal(run.error, undefined, String(run.error))
    const upgrade = run.calls.find((call) => call.method === 'POST')
    assert.deepEqual(upgrade?.body, {
        targetVersion: '5.6.0-dev.202609291528.61f0db7'
    })
    assert.match(
        run.out.join('\n'),
        /✓ sandbox-002: Manyfold CLI 4\.8\.0 → 5\.6\.0-dev\.202609291528\.61f0db7/
    )
    const latest = await runMf(
        ['sandbox', 'update', 'sandbox-002', '--json'],
        updateRoutes({ ...old, cliVersion: '4.9.0' })
    )
    assert.deepEqual(
        latest.calls.find((call) => call.method === 'POST')?.body,
        {}
    )
    const out = JSON.parse(latest.out.join('\n'))
    assert.deepEqual(
        [out.name, out.from, out.to],
        ['sandbox-002', '4.8.0', '4.9.0']
    )
})

test('a version the catalog does not list is refused before anything is sent', async () => {
    const run = await runMf(
        ['sandbox', 'update', 'sandbox-002', '--to', '9.9.9'],
        updateRoutes(old)
    )
    assert.ok(run.error instanceof CommanderError, String(run.error))
    assert.match(
        run.error.message,
        /no Manyfold CLI version 9\.9\.9; the newest are 5\.6\.0-dev\.202609291528\.61f0db7, 5\.5\.0-dev/
    )
    assert.equal(
        run.calls.some((call) => call.method === 'POST'),
        false
    )
})

// WHY: the old message was a guess from an unchanged version; the API now
// says when the daemon deferred, and for how many sessions.
test('a deferred update says how many sessions it waits for', async () => {
    const deadline = new Date(Date.now() + 9 * 60_000 + 30_000).toISOString()
    const run = await runMf(
        ['sandbox', 'update', 'sandbox-002', '--to', '5.6.0-dev.202609291528.61f0db7'],
        updateRoutes({ ...old, cliUpdateDeferred: { activeSessions: 2, deadline } })
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.match(
        run.out.join('\n'),
        /sandbox-002 takes the update once its 2 active sessions finish, within 9m at the latest/
    )
    const one = await runMf(
        ['sandbox', 'update', 'sandbox-002', '--to', '5.6.0-dev.202609291528.61f0db7'],
        updateRoutes({ ...old, cliUpdateDeferred: { activeSessions: 1, deadline } })
    )
    assert.match(
        one.out.join('\n'),
        /sandbox-002 takes the update once its 1 active session finishes, within 9m/
    )
    const json = await runMf(
        ['sandbox', 'update', 'sandbox-002', '--json'],
        updateRoutes({ ...old, cliUpdateDeferred: { activeSessions: 1, deadline } })
    )
    assert.deepEqual(JSON.parse(json.out.join('\n')).sandbox.cliUpdateDeferred, {
        activeSessions: 1,
        deadline
    })
})

test('an update whose new CLI has not reported yet says so', async () => {
    const run = await runMf(
        ['sandbox', 'update', 'sandbox-002', '--to', '5.6.0-dev.202609291528.61f0db7'],
        updateRoutes(old)
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.match(
        run.out.join('\n'),
        /sandbox-002 has not reported the new Manyfold CLI yet/
    )
})

test('a sandbox already on its channel latest is shown the newer builds', async () => {
    const run = await runMf(
        ['sandbox', 'update', 'sandbox-002'],
        updateRoutes(old)
    )
    assert.equal(run.error, undefined, String(run.error))
    const text = run.out.join('\n')
    assert.match(
        text,
        /sandbox-002 already runs 4\.8\.0, the latest release on its channel/
    )
    assert.match(
        text,
        /Newer builds: 5\.6\.0-dev\.202609291528\.61f0db7, 5\.5\.0-dev\.202609281200\.aaaaaaa; install one with mf sandbox update sandbox-002 --to <version>/
    )
})
