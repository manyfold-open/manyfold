import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { withLiveSprite } from './live-sprite-harness'

const name = 'nca-probe-detach-local-fixture'
const created = { id: 'fixture', name, status: 'running' }

test('a passing body cannot hide a failed owned Sprite delete', async (t) => {
    const error = new Error('delete unavailable')
    const logs: string[] = [],
        waits: number[] = []
    let deletes = 0,
        nameWasVisible = false
    await assert.rejects(
        withLiveSprite(
            t,
            {
                createSprite: async () => {
                    nameWasVisible = Boolean(logs[0]?.includes(name))
                    return created
                },
                deleteSprite: async (target) => {
                    assert.equal(target, name)
                    deletes++
                    throw error
                }
            },
            name,
            async () => {},
            {
                log: (message) => logs.push(message),
                wait: async (ms) => {
                    waits.push(ms)
                }
            }
        ),
        (failure: unknown) => {
            assert.ok(failure instanceof Error)
            assert.match(failure.message, new RegExp(name))
            assert.equal(failure.cause, error)
            return true
        }
    )
    assert.equal(deletes, 3)
    assert.equal(nameWasVisible, true, 'name is visible before create')
    assert.deepEqual(waits, [500, 1500])
    assert.equal(
        logs.filter((line) => line.includes('cleanup failed')).length,
        1
    )
})

test('body and cleanup failures both remain visible with the resource name', async (t) => {
    const primary = new Error('body failed'),
        cleanup = new Error('delete failed')
    await assert.rejects(
        withLiveSprite(
            t,
            {
                createSprite: async () => created,
                deleteSprite: async () => {
                    throw cleanup
                }
            },
            name,
            async () => {
                throw primary
            },
            {
                log: () => {},
                wait: async () => {}
            }
        ),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError)
            assert.equal(error.errors[0], primary)
            assert.equal(error.errors[1].cause, cleanup)
            assert.match(error.message, new RegExp(name))
            return true
        }
    )
})

test('successful cleanup preserves a failed body unchanged', async (t) => {
    const primary = new Error('original body failure')
    let deletes = 0
    const logs: string[] = []
    await assert.rejects(
        withLiveSprite(
            t,
            {
                createSprite: async () => created,
                deleteSprite: async () => {
                    deletes++
                }
            },
            name,
            async () => {
                throw primary
            },
            { log: (line) => logs.push(line) }
        ),
        (error) => error === primary
    )
    assert.equal(deletes, 1)
    assert.equal(
        logs.filter((line) => line.includes('cleanup deleted')).length,
        1
    )
})

test('a failed create never deletes an unconfirmed resource', async (t) => {
    const primary = new Error('create refused')
    let deletes = 0,
        bodies = 0
    await assert.rejects(
        withLiveSprite(
            t,
            {
                createSprite: async () => {
                    throw primary
                },
                deleteSprite: async () => {
                    deletes++
                }
            },
            name,
            async () => {
                bodies++
            },
            { log: () => {} }
        ),
        (error) => error === primary
    )
    assert.equal(deletes, 0)
    assert.equal(bodies, 0)
})

test('transient delete failures end in exactly one successful cleanup outcome', async (t) => {
    let deletes = 0
    const waits: number[] = [],
        logs: string[] = []
    await withLiveSprite(
        t,
        {
            createSprite: async () => created,
            deleteSprite: async () => {
                if (++deletes < 3) throw new Error('temporary fixture failure')
            }
        },
        name,
        async () => {},
        {
            log: (line) => logs.push(line),
            wait: async (ms) => {
                waits.push(ms)
            }
        }
    )
    assert.equal(deletes, 3)
    assert.deepEqual(waits, [500, 1500])
    assert.equal(
        logs.filter((line) => line.includes('cleanup deleted')).length,
        1
    )
    assert.equal(
        logs.some((line) => line.includes('cleanup failed')),
        false
    )
})

for (const mode of [
    'success',
    'delete-fails',
    'delete-timeout',
    'timeout',
    'late-create',
    'wss-cancel',
    'exec-cancel'
]) {
    test(`real node:test lifecycle observes cleanup before exit: ${mode}`, () => {
        const env: NodeJS.ProcessEnv = { ...process.env, MF_LIVE_SPRITE_FIXTURE: mode }
        delete env.NODE_TEST_CONTEXT
        delete env.SPRITES_TOKEN
        delete env.RUN_SPRITES_E2E
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--test',
                '--test-reporter=tap',
                path.join(__dirname, 'fixtures/live-sprite-lifecycle.test.ts')
            ],
            {
                cwd: path.resolve(__dirname, '..'),
                env,
                encoding: 'utf8',
                timeout: 15_000,
                killSignal: 'SIGKILL'
            }
        )
        assert.equal(result.error, undefined, result.stderr)
        assert.equal(
            result.status,
            mode === 'success' ? 0 : 1,
            result.stdout + result.stderr
        )
        assert.match(result.stdout, /creating nca-probe-detach-owned-local/)
        const deleteFailed =
            mode === 'delete-fails' || mode === 'delete-timeout'
        const terminal = deleteFailed ? 'cleanup failed' : 'cleanup deleted'
        assert.equal(result.stdout.split(terminal).length - 1, 1, result.stdout)
        assert.ok(
            result.stdout.indexOf(terminal) < result.stdout.indexOf('# tests '),
            result.stdout
        )
        const match = /fixture-counts (\{[^\n]+\})/.exec(result.stdout)
        assert.ok(match, result.stdout)
        const counts = JSON.parse(match[1])
        assert.equal(counts.create, 1)
        assert.equal(counts.delete, deleteFailed ? 3 : 1)
        assert.equal(counts.body, mode === 'late-create' ? 0 : 1)
        if (mode === 'timeout') assert.match(result.stdout, /test timed out/)
        if (mode === 'wss-cancel') assert.equal(counts.connections, 1)
        if (mode === 'exec-cancel') assert.equal(counts.connections, 3)
    })
}

for (const optedIn of [false, true]) {
    test(`live entry without credentials ${optedIn ? 'fails when opted in' : 'skips without opt-in'}`, () => {
        const env = { ...process.env }
        delete env.NODE_TEST_CONTEXT
        delete env.SPRITES_TOKEN
        delete env.RUN_SPRITES_E2E
        if (optedIn) env.RUN_SPRITES_E2E = '1'
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--test',
                '--test-reporter=tap',
                path.join(__dirname, 'live/exec-detach.test.ts')
            ],
            {
                cwd: path.resolve(__dirname, '..'),
                env,
                encoding: 'utf8',
                timeout: 10_000,
                killSignal: 'SIGKILL'
            }
        )
        assert.equal(result.error, undefined)
        assert.equal(
            result.status,
            optedIn ? 1 : 0,
            result.stdout + result.stderr
        )
        assert.match(
            result.stdout,
            optedIn ? /SPRITES_TOKEN is required/ : /SKIP set RUN_SPRITES_E2E=1/
        )
        assert.doesNotMatch(result.stdout, /\[sprites live\] creating/)
    })
}
