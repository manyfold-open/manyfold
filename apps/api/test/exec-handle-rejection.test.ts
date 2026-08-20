import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import { observedResult } from '../src/modules/chat/adapters/exec-driver'
import type { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const rejectingRegistry = (message: string): DaemonRegistryService =>
    ({
        streamRpc: () => ({
            refId: 'r1',
            result: Promise.reject(new Error(message)),
            cancel: () => {}
        })
    }) as unknown as DaemonRegistryService

const captureUnhandled = async (
    body: () => Promise<void>
): Promise<string[]> => {
    const seen: string[] = []
    const onUnhandled = (reason: unknown): void => {
        seen.push(reason instanceof Error ? reason.message : String(reason))
    }
    process.on('unhandledRejection', onUnhandled)
    try {
        await body()
    } finally {
        process.off('unhandledRejection', onUnhandled)
    }
    return seen
}

test('an exec handle whose result rejects before anyone awaits it does not crash the process', async () => {
    const driver = new DaemonExecDriver(
        rejectingRegistry('daemon process crashed'),
        'dh_x'
    )
    const seen = await captureUnhandled(async () => {
        const handle = driver.resumeStream({
            refId: 'm1',
            fromSeq: 0,
            timeoutMs: 1_000
        })
        // The consumer order that makes this fatal, and it is the ONLY order the
        // turn pipeline uses: adapters drain stdout to completion before they
        // await handle.result, and runAdapterFromIterable persists every event,
        // so the generator parks on `yield` across macrotasks. By the time
        // anything touches result it has been rejected and unhandled for whole
        // event-loop turns.
        for await (const _chunk of handle.stdout) await sleep(5)
        await sleep(20)
        await assert.rejects(handle.result, /daemon process crashed/)
    })
    // WHY this is severity-worthy rather than noise: apps/api installs
    // process.on('unhandledRejection') -> handleFatal -> process.exit(1). One
    // early-rejecting exec handle therefore takes down the whole instance and
    // every turn on it. Staging 2026-08-03 lost 6 in-flight turns twice in one
    // day this way, and `exec.resume` answers `daemon process crashed` for any
    // daemon that restarted with buffer meta still on disk.
    assert.deepEqual(
        seen,
        [],
        'the rejection must be observed, not left for the process handler'
    )
})

test('the rejection still reaches the awaiting consumer', async () => {
    // The fix must silence the REPORT, not the error: swallowing it would turn
    // a failed exec into a turn that hangs waiting for output that never comes.
    const driver = new DaemonExecDriver(
        rejectingRegistry('daemon process crashed'),
        'dh_x'
    )
    const handle = driver.stream({ cmd: ['echo'], timeoutMs: 1_000 })
    await assert.rejects(handle.result, /daemon process crashed/)
})

test('stdout still closes when the result rejects', async () => {
    // sinks.close() runs in the rejection path; if the fix reordered that, the
    // stdout loop above would never terminate and the turn would hang instead.
    const driver = new DaemonExecDriver(
        rejectingRegistry('daemon process crashed'),
        'dh_x'
    )
    const handle = driver.stream({ cmd: ['echo'], timeoutMs: 1_000 })
    const chunks: string[] = []
    for await (const chunk of handle.stdout) chunks.push(chunk)
    assert.deepEqual(chunks, [])
    await assert.rejects(handle.result)
})

test('observedResult returns the same promise it observed', async () => {
    // The drivers hand this straight into the handle, so it must not substitute
    // a derived promise: a `.catch()` chain would resolve where the original
    // rejects and silently turn a failed exec into exitCode-undefined success.
    const original = Promise.reject(new Error('boom'))
    const returned = observedResult(original)
    assert.equal(returned, original)
    await assert.rejects(returned, /boom/)
})

test('observedResult survives a rejection nobody awaits at all', async () => {
    // The worst case is not a late await, it is no await: an adapter that
    // returns early (cancel, a guard, an exception between dispatch and drain)
    // abandons the handle entirely. Before the fix that alone was fatal.
    const seen = await captureUnhandled(async () => {
        observedResult(Promise.reject(new Error('abandoned')))
        await sleep(20)
    })
    assert.deepEqual(seen, [])
})

test('the k8s driver observes its pod-exec result too', async () => {
    // Same class of exposure, different transport: K8sExecDriver forwards the
    // pod-exec handle's promise as-is, so a dispatch failure there was fatal in
    // exactly the same way.
    const podExec = {
        stream: () => ({
            stdout: (async function* () {})(),
            stderr: (async function* () {})(),
            result: Promise.reject(new Error('pod gone')),
            abort: () => {}
        })
    }
    const { K8sExecDriver } = await import(
        '../src/modules/chat/adapters/k8s-exec-driver'
    )
    const driver = new K8sExecDriver(podExec as never)
    const seen = await captureUnhandled(async () => {
        const handle = driver.stream({ cmd: ['echo'], timeoutMs: 1_000 })
        await sleep(20)
        await assert.rejects(handle.result, /pod gone/)
    })
    assert.deepEqual(seen, [])
})
