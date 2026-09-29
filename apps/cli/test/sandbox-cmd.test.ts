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

const busy = sandbox({ id: 'sbx_busy', name: 'busy', agentsCount: 2 })
const idle = sandbox({ id: 'sbx_idle', name: 'idle' })

const listRoutes = {
    'GET /sandboxes': () => json([busy, idle]),
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
    assert.match(
        text,
        /sbx_busy {2}\S*busy\S* {2}ready, suspended {2}2 agents {2}claude-code, codex/
    )
    assert.match(
        text,
        /sbx_idle {2}\S*idle\S* {2}ready, suspended {2}0 agents {2}nothing installed/
    )
    assert.match(text, /2 of 3 sandboxes in use \(Free plan\)/)

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
