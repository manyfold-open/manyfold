import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenclawRpcClient } from '../src/modules/chat/adapters/openclaw-rpc-client'
import type { ExecStreamRequest } from '../src/modules/chat/adapters/exec-driver'
import { NOOP_HOLD } from '../src/modules/hosts/host-awake.service'

const rig = (stdout: string, stderr = '', exitCode = 0) => {
    const calls: ExecStreamRequest[] = []
    const events: string[] = []
    const chunks = async function* (value: string) {
        yield value.slice(0, 5)
        yield value.slice(5)
    }
    const client = new OpenclawRpcClient(
        {
            stream: (req) => {
                calls.push(req)
                events.push('exec')
                return {
                    stdout: chunks(stdout),
                    stderr: chunks(stderr),
                    result: Promise.resolve({ stdout, stderr, exitCode }),
                    abort() {}
                }
            }
        },
        () => {
            events.push('hold')
            return {
                ...NOOP_HOLD,
                release: async () => {
                    events.push('release')
                }
            }
        }
    )
    return { client, calls, events }
}

test('a gateway query holds its machine for exactly its own run', async () => {
    for (const [stdout, exitCode] of [
        ['{"sessions":[]}', 0],
        ['', 7]
    ] as const) {
        const { client, events } = rig(stdout, '', exitCode)
        await client.call('sessions.list').catch(() => undefined)
        assert.deepEqual(events, ['hold', 'exec', 'release'], `exit ${exitCode}`)
    }
})

test('runner gateway queries preserve arguments and tolerate CLI startup notes', async () => {
    for (const stdout of [
        '{"sessions":[]}',
        'OpenClaw startup\nNotes: ready\n{\n "sessions": []\n}\n'
    ]) {
        const { client, calls } = rig(stdout)
        assert.deepEqual(
            await client.call('sessions.list', { limit: 2 }, 9000),
            { sessions: [] }
        )
        assert.deepEqual(calls[0].cmd, [
            'openclaw',
            'gateway',
            'call',
            'sessions.list',
            '--params',
            '{"limit":2}',
            '--json',
            '--timeout',
            '9000'
        ])
        assert.equal(calls[0].timeoutMs, 14000)
        assert.deepEqual(calls[0].env, {
            OPENCLAW_HIDE_BANNER: '1',
            OPENCLAW_SUPPRESS_NOTES: '1'
        })
    }
})

test('runner gateway failures retain bounded redacted stderr', async () => {
    const { client } = rig(
        '',
        'x'.repeat(2000) + '\nconnection refused; token=private-fixture-token',
        7
    )
    await assert.rejects(client.call('sessions.history'), (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /exit 7/)
        assert.match(err.message, /connection refused/)
        assert.doesNotMatch(err.message, /private-fixture-token/)
        assert.ok(err.message.length < 1100)
        return true
    })
})

test('invalid JSON fails without exposing session contents', async () => {
    for (const stdout of ['no JSON', '{"private-session-data": invalid}']) {
        await assert.rejects(
            rig(stdout).client.call('sessions.history'),
            /^Error: runner gateway session query returned invalid JSON$/
        )
    }
})
