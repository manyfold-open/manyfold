import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import type { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'
import type { DaemonFencedDispatchService } from '../src/modules/chat/adapters/daemon-fenced-dispatch.service'

// The generation fence (#619) hooks in at the ONE seam every daemon-carried
// framework shares: DaemonExecDriver.stream. Claude/codex/gemini runner turns
// and daemon-runtime turns all dispatch exec.start here, so proving the
// routing at this seam is what makes the fence framework-neutral.

const makeHandles = () => {
    const calls: Array<{ via: string; method: string; refId?: string }> = []
    const handle = {
        refId: 'r',
        result: Promise.resolve({ exitCode: 0 }),
        cancel: () => {}
    }
    const registry = {
        streamRpc: (args: { method: string; refIdOverride?: string }) => {
            calls.push({
                via: 'registry',
                method: args.method,
                refId: args.refIdOverride
            })
            return handle
        }
    } as unknown as DaemonRegistryService
    const fenced = {
        streamTurnRpc: (args: { method: string; refId: string }) => {
            calls.push({ via: 'fenced', method: args.method, refId: args.refId })
            return handle
        }
    } as unknown as DaemonFencedDispatchService
    return { calls, registry, fenced }
}

test('a turn exec with an execHandle dispatches through the fence', async () => {
    const { calls, registry, fenced } = makeHandles()
    const driver = new DaemonExecDriver(registry, 'dh-1', undefined, fenced)
    const exec = driver.stream({
        cmd: ['echo'],
        timeoutMs: 1_000,
        execHandle: 'msg-1'
    })
    assert.deepEqual(await exec.result, {
        exitCode: 0,
        stdout: '',
        stderr: ''
    })
    assert.deepEqual(calls, [
        { via: 'fenced', method: 'exec.start', refId: 'msg-1' }
    ])
})

test('an exec without a stable ref keeps the plain transport', async () => {
    const { calls, registry, fenced } = makeHandles()
    const driver = new DaemonExecDriver(registry, 'dh-1', undefined, fenced)
    const exec = driver.stream({ cmd: ['echo'], timeoutMs: 1_000 })
    await exec.result
    assert.deepEqual(calls, [
        { via: 'registry', method: 'exec.start', refId: undefined }
    ])
})

test('without the fence service the driver behaves exactly as before', async () => {
    const { calls, registry } = makeHandles()
    const driver = new DaemonExecDriver(registry, 'dh-1')
    const exec = driver.stream({
        cmd: ['echo'],
        timeoutMs: 1_000,
        execHandle: 'msg-1'
    })
    await exec.result
    assert.deepEqual(calls, [
        { via: 'registry', method: 'exec.start', refId: 'msg-1' }
    ])
})

test('resume attach never routes through the fence', async () => {
    const { calls, registry, fenced } = makeHandles()
    const driver = new DaemonExecDriver(registry, 'dh-1', undefined, fenced)
    const exec = driver.resumeStream({
        refId: 'msg-1',
        fromSeq: 3,
        timeoutMs: 1_000
    })
    await exec.result
    assert.deepEqual(calls, [
        { via: 'registry', method: 'exec.resume', refId: undefined }
    ])
})
