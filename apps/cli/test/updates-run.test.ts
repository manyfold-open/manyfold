import test from 'node:test'
import assert from 'node:assert/strict'
import type { BatchStep, UpdateRow } from '@manyfold/shared'
import { runUpdateSteps, type RunEvent } from '../src/commands/updates/run'
import { createCliClient } from '../src/transport'
import { apiFetch, json, type Call, type Route } from './fixtures/fake-api'

const clientFor = (routes: Record<string, Route>, calls: Call[]) =>
    createCliClient({
        baseUrl: 'https://api.test/api',
        token: 'nca_rt_test',
        fetch: apiFetch(routes, calls)
    })

const fakeTimers = () => {
    const clock = { now: 0 }
    const sleeps: number[] = []
    return {
        clock,
        sleeps,
        timers: {
            now: () => clock.now,
            sleep: async (ms: number) => {
                sleeps.push(ms)
                clock.now += ms
            }
        }
    }
}

const row = (id: string, installedVersion: string | null = null) =>
    ({ id, installedVersion }) as UpdateRow

const rowsOf = (...rows: UpdateRow[]): Map<string, UpdateRow> =>
    new Map(rows.map((r) => [r.id, r]))

const daemonCli = (n: number): BatchStep => ({
    type: 'daemonCli',
    rowId: `cli:daemon:dh_${n}`,
    hostId: `dh_${n}`,
    targetVersion: null
})

test('a sixth computer update waits out the window the API allows five in', async () => {
    const { clock, sleeps, timers } = fakeTimers()
    const routes: Record<string, Route> = {}
    for (let n = 1; n <= 6; n++)
        routes[`POST /daemon/hosts/dh_${n}/upgrade`] = () => {
            clock.now += 1000
            return json({ ok: true, fromVersion: '5.7.0', toVersion: '5.8.0' })
        }
    const events: RunEvent[] = []
    const outcomes = await runUpdateSteps(
        clientFor(routes, []),
        [1, 2, 3, 4, 5, 6].map(daemonCli),
        rowsOf(),
        { timers, onEvent: (event) => events.push(event) }
    )
    assert.deepEqual(sleeps, [62_000 - 5_000])
    assert.ok(events.some((event) => event.type === 'waiting'))
    assert.deepEqual(
        [...outcomes.values()].map((outcome) => outcome.state),
        ['updated', 'updated', 'updated', 'updated', 'updated', 'updated']
    )
})

test('a 429 waits one window and tries once more', async () => {
    const { sleeps, timers } = fakeTimers()
    const calls: Call[] = []
    const ok = await runUpdateSteps(
        clientFor(
            {
                'POST /daemon/hosts/dh_1/upgrade': (_call, index) =>
                    index === 0
                        ? json({ error: { code: 'too_many_requests', message: 'slow down' } }, 429)
                        : json({ ok: true, fromVersion: '5.7.0', toVersion: '5.8.0' })
            },
            calls
        ),
        [daemonCli(1)],
        rowsOf(),
        { timers }
    )
    assert.deepEqual(sleeps, [62_000])
    assert.equal(calls.length, 2)
    assert.deepEqual(ok.get('cli:daemon:dh_1'), { state: 'updated' })

    const twice = await runUpdateSteps(
        clientFor(
            {
                'POST /daemon/hosts/dh_1/upgrade': () =>
                    json({ error: { code: 'too_many_requests', message: 'slow down' } }, 429)
            },
            []
        ),
        [daemonCli(1)],
        rowsOf(),
        { timers: fakeTimers().timers }
    )
    assert.equal(twice.get('cli:daemon:dh_1')?.state, 'failed')
})

test('herdr on a computer counts toward the same window', async () => {
    const { sleeps, timers } = fakeTimers()
    const routes: Record<string, Route> = {
        'POST /daemon/hosts/dh_9/herdr/upgrade': () =>
            json({ ok: true, fromVersion: '0.4.0', toVersion: '0.5.1' })
    }
    for (let n = 1; n <= 5; n++)
        routes[`POST /daemon/hosts/dh_${n}/upgrade`] = () =>
            json({ ok: true, fromVersion: '5.7.0', toVersion: '5.8.0' })
    await runUpdateSteps(
        clientFor(routes, []),
        [
            ...[1, 2, 3, 4, 5].map(daemonCli),
            { type: 'daemonHerdr', rowId: 'herdr:daemon:dh_9', hostId: 'dh_9' }
        ],
        rowsOf(),
        { timers }
    )
    assert.deepEqual(sleeps, [62_000])
})

test('a failing step marks its row and the next one still runs', async () => {
    const outcomes = await runUpdateSteps(
        clientFor(
            {
                'POST /sandboxes/sbx_1/herdr/upgrade': () =>
                    json({ error: { code: 'SANDBOX_DAEMON_OFFLINE', message: 'the runner is not answering' } }, 503),
                'POST /sandboxes/sbx_2/cli/upgrade': () =>
                    json({ id: 'sbx_2', cliVersion: '5.8.0' })
            },
            []
        ),
        [
            { type: 'sandboxHerdr', rowId: 'herdr:sandbox:sbx_1', hostId: 'sbx_1' },
            { type: 'sandboxCli', rowId: 'cli:sandbox:sbx_2', hostId: 'sbx_2', targetVersion: null }
        ],
        rowsOf(row('cli:sandbox:sbx_2', '5.7.0')),
        { timers: fakeTimers().timers }
    )
    assert.deepEqual(outcomes.get('herdr:sandbox:sbx_1'), {
        state: 'failed',
        code: 'SANDBOX_DAEMON_OFFLINE',
        message: 'the runner is not answering'
    })
    assert.deepEqual(outcomes.get('cli:sandbox:sbx_2'), { state: 'updated' })
})

test('a skill batch reports each agent from its own result', async () => {
    const outcomes = await runUpdateSteps(
        clientFor(
            {
                'POST /skills/install/batch': () =>
                    json({
                        results: [
                            { agentId: 'agt_a', status: 'installed', skill: { materializeStatus: 'installed' } },
                            { agentId: 'agt_b', status: 'failed', error: 'repository unreachable' },
                            { agentId: 'agt_c', status: 'installed', skill: { materializeStatus: 'installing' } }
                        ]
                    })
            },
            []
        ),
        [
            {
                type: 'skillBatch',
                skillId: 'skl_pdf',
                agentIds: ['agt_a', 'agt_b', 'agt_c', 'agt_d'],
                rowIds: ['skill:agt_a:skl_pdf', 'skill:agt_b:skl_pdf', 'skill:agt_c:skl_pdf', 'skill:agt_d:skl_pdf']
            }
        ],
        rowsOf(),
        { timers: fakeTimers().timers }
    )
    assert.deepEqual(
        [...outcomes.entries()].map(([id, outcome]) => [id, outcome.state]),
        [
            ['skill:agt_a:skl_pdf', 'updated'],
            ['skill:agt_b:skl_pdf', 'failed'],
            ['skill:agt_c:skl_pdf', 'pending'],
            ['skill:agt_d:skl_pdf', 'failed']
        ]
    )
})

test('what the platform takes later is pending, not done', async () => {
    const outcomes = await runUpdateSteps(
        clientFor(
            {
                'POST /daemon/hosts/dh_1/upgrade': () =>
                    json({ ok: true, fromVersion: '5.7.0', toVersion: '5.8.0', deferred: true, activeSessions: 2 }),
                'POST /sandboxes/sbx_1/cli/upgrade': () =>
                    json({
                        id: 'sbx_1',
                        cliVersion: '5.7.0',
                        cliUpdateDeferred: {
                            activeSessions: 1,
                            deadline: new Date(10 * 60_000).toISOString()
                        }
                    }),
                'POST /sandboxes/sbx_2/cli/upgrade': () =>
                    json({ id: 'sbx_2', cliVersion: '5.7.0' })
            },
            []
        ),
        [
            daemonCli(1),
            { type: 'sandboxCli', rowId: 'cli:sandbox:sbx_1', hostId: 'sbx_1', targetVersion: null },
            { type: 'sandboxCli', rowId: 'cli:sandbox:sbx_2', hostId: 'sbx_2', targetVersion: null }
        ],
        rowsOf(row('cli:sandbox:sbx_1', '5.7.0'), row('cli:sandbox:sbx_2', '5.7.0')),
        { timers: fakeTimers().timers }
    )
    assert.deepEqual(outcomes.get('cli:daemon:dh_1'), {
        state: 'pending',
        message: 'waits for 2 active sessions to finish, then takes 5.8.0'
    })
    assert.deepEqual(outcomes.get('cli:sandbox:sbx_1'), {
        state: 'pending',
        message: 'waits for 1 active session to finish, within 10m at the latest'
    })
    assert.deepEqual(outcomes.get('cli:sandbox:sbx_2'), {
        state: 'pending',
        message: 'has not reported the new Manyfold CLI yet; mf updates list shows when it does'
    })
})

test('a rebuild streams its phases; an npm framework does not stream', async () => {
    const calls: Call[] = []
    const events: RunEvent[] = []
    const outcomes = await runUpdateSteps(
        clientFor(
            {
                'POST /agent-runtimes/art_h/framework-version/upgrade-stream': () =>
                    new Response(
                        [
                            JSON.stringify({ type: 'step', step: 'stopping_service' }),
                            JSON.stringify({ type: 'step', step: 'rebuilding' }),
                            JSON.stringify({ type: 'complete', runtime: { id: 'art_h' } })
                        ].join('\n') + '\n',
                        { headers: { 'content-type': 'application/x-ndjson' } }
                    ),
                'POST /agent-runtimes/art_c/framework-version/upgrade': () =>
                    json({ id: 'art_c' })
            },
            calls
        ),
        [
            { type: 'framework', rowId: 'framework:art_c', runtimeId: 'art_c', framework: 'claude-code', mode: 'npm', targetVersion: '2.1.260' },
            { type: 'framework', rowId: 'framework:art_h', runtimeId: 'art_h', framework: 'hermes', mode: 'rebuild', targetVersion: 'v2026.9.24' }
        ],
        rowsOf(),
        { timers: fakeTimers().timers, onEvent: (event) => events.push(event) }
    )
    assert.deepEqual(
        events.filter((event) => event.type === 'phase').map((event) => event.type === 'phase' && event.phase),
        ['stopping_service', 'rebuilding']
    )
    assert.equal(outcomes.get('framework:art_h')?.state, 'updated')
    assert.equal(outcomes.get('framework:art_c')?.state, 'updated')
    assert.deepEqual(calls.map((call) => call.body), [
        { targetVersion: '2.1.260' },
        { targetVersion: 'v2026.9.24' }
    ])
})

test('a picked version rides in the body and no pick sends none', async () => {
    const calls: Call[] = []
    await runUpdateSteps(
        clientFor(
            {
                'POST /sandboxes/sbx_1/cli/upgrade': () => json({ id: 'sbx_1', cliVersion: '5.7.2' }),
                'POST /daemon/hosts/dh_1/upgrade': () =>
                    json({ ok: true, fromVersion: '5.7.0', toVersion: '5.8.0' })
            },
            calls
        ),
        [
            { type: 'sandboxCli', rowId: 'cli:sandbox:sbx_1', hostId: 'sbx_1', targetVersion: '5.7.2' },
            daemonCli(1)
        ],
        rowsOf(row('cli:sandbox:sbx_1', '5.7.0')),
        { timers: fakeTimers().timers }
    )
    assert.deepEqual(calls.map((call) => call.body), [{ targetVersion: '5.7.2' }, {}])
})
