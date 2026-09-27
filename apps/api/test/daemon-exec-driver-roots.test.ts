import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'

// ADR-0038: a turn's roots ride on exec.start, and a first exec.start lost
// to a socket the thaw replaced is sent once more on the fresh lease. The
// registry is faked at the streamRpc seam the driver dispatches through.

type Dispatch = { payload: Record<string, unknown>; refId?: string }

const fakeRegistry = (
    outcomes: Array<{ reject?: Error; exitCode?: number; events?: string[] }>
) => {
    const calls: Dispatch[] = []
    return {
        calls,
        registry: {
            streamRpc: (args: {
                payload: Record<string, unknown>
                refIdOverride?: string
                onEvent: (kind: 'stdout', data: string, seq?: number) => void
            }) => {
                calls.push({ payload: args.payload, refId: args.refIdOverride })
                const outcome = outcomes.shift() ?? { exitCode: 0 }
                if (outcome.reject && !outcome.events) throw outcome.reject
                for (const [i, data] of (outcome.events ?? []).entries())
                    args.onEvent('stdout', data, i + 1)
                return {
                    refId: 'ref',
                    result: outcome.reject
                        ? Promise.reject(outcome.reject)
                        : Promise.resolve({ exitCode: outcome.exitCode ?? 0 }),
                    cancel() {}
                }
            }
        }
    }
}

test('the exec.start payload carries the turn roots and nothing else new', async () => {
    const { registry, calls } = fakeRegistry([{ exitCode: 0 }])
    const driver = new DaemonExecDriver(registry as never, 'sbx_1', undefined, undefined, null, {
        roots: ['/home/sprite/project', '/home/sprite/.claude']
    })
    await driver.stream({ cmd: ['echo'], dir: '/home/sprite/project', timeoutMs: 1_000 })
        .result
    assert.deepEqual(calls[0].payload.roots, [
        '/home/sprite/project',
        '/home/sprite/.claude'
    ])
    const bare = fakeRegistry([{ exitCode: 0 }])
    await new DaemonExecDriver(bare.registry as never, 'sbx_1')
        .stream({ cmd: ['echo'], timeoutMs: 1_000 }).result
    assert.equal('roots' in bare.calls[0].payload, false)
})

test('a first exec.start lost to a closed socket is sent again once the daemon is back', async () => {
    const { registry, calls } = fakeRegistry([
        { reject: new Error('daemon sbx_1 is not connected') },
        { exitCode: 0 }
    ])
    const waits: Date[] = []
    const driver = new DaemonExecDriver(registry as never, 'sbx_1', undefined, undefined, null, {
        reconnect: async (since) => {
            waits.push(since)
            return true
        }
    })
    const result = await driver.stream({ cmd: ['echo'], timeoutMs: 1_000 }).result
    assert.equal(result.exitCode, 0)
    assert.equal(calls.length, 2)
    assert.equal(waits.length, 1)
})

test('a daemon that never comes back, a refusal, or a lost stream with output already delivered is not retried', async () => {
    const gone = fakeRegistry([{ reject: new Error('connection closed') }])
    await assert.rejects(
        new DaemonExecDriver(gone.registry as never, 'sbx_1', undefined, undefined, null, {
            reconnect: async () => false
        }).stream({ cmd: ['echo'], timeoutMs: 1_000 }).result,
        /connection closed/
    )
    assert.equal(gone.calls.length, 1)

    const refused = fakeRegistry([{ reject: new DaemonRpcResponseError('cmd required') }])
    await assert.rejects(
        new DaemonExecDriver(refused.registry as never, 'sbx_1', undefined, undefined, null, {
            reconnect: async () => true
        }).stream({ cmd: ['echo'], timeoutMs: 1_000 }).result,
        /cmd required/
    )
    assert.equal(refused.calls.length, 1)

    const midway = fakeRegistry([
        { reject: new Error('connection closed'), events: ['partial output'] }
    ])
    const handle = new DaemonExecDriver(midway.registry as never, 'sbx_1', undefined, undefined, null, {
        reconnect: async () => true
    }).stream({ cmd: ['echo'], timeoutMs: 1_000 })
    await assert.rejects(handle.result, /connection closed/)
    assert.equal(midway.calls.length, 1)
})

test('without a reconnect hook the driver dispatches exactly as before', async () => {
    const { registry, calls } = fakeRegistry([
        { reject: new Error('daemon sbx_1 is not connected') }
    ])
    await assert.rejects(
        new DaemonExecDriver(registry as never, 'sbx_1').stream({ cmd: ['echo'], timeoutMs: 1_000 }).result,
        /is not connected/
    )
    assert.equal(calls.length, 1)
})
