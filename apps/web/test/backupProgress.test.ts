import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForSettled } from '../src/lib/backupProgress'

interface Job {
    status: 'running' | 'succeeded' | 'failed'
}

// No real waiting, and a clock the test drives: the interval only has to be
// observed, not endured.
const harness = (states: Array<Job | undefined>) => {
    let clock = 0
    const slept: number[] = []
    let reads = 0
    return {
        slept,
        reads: () => reads,
        options: {
            intervalMs: 2_000,
            timeoutMs: 10_000,
            now: () => clock,
            sleep: (ms: number) => {
                slept.push(ms)
                clock += ms
                return Promise.resolve()
            }
        },
        read: () => {
            const next = states[reads]
            reads += 1
            return Promise.resolve(next)
        }
    }
}

test('a job that is already finished is not polled at all', async () => {
    const h = harness([])
    const settled = await waitForSettled(
        { status: 'succeeded' } as Job,
        h.read,
        h.options
    )
    assert.equal(settled?.status, 'succeeded')
    assert.equal(h.reads(), 0)
    assert.deepEqual(h.slept, [])
})

test('polling continues while the job is running and stops when it settles', async () => {
    const h = harness([
        { status: 'running' },
        { status: 'running' },
        { status: 'succeeded' }
    ])
    const settled = await waitForSettled(
        { status: 'running' } as Job,
        h.read,
        h.options
    )
    assert.equal(settled?.status, 'succeeded')
    assert.equal(h.reads(), 3)
    assert.deepEqual(h.slept, [2_000, 2_000, 2_000])
})

// The caller decides what a failure means; this must not paper over it by
// returning the last successful-looking state.
test('a job that fails is reported as failed', async () => {
    const h = harness([{ status: 'failed' }])
    const settled = await waitForSettled(
        { status: 'running' } as Job,
        h.read,
        h.options
    )
    assert.equal(settled?.status, 'failed')
})

// A backup that disappears mid-wait (retention, an explicit delete) must not
// read as done — a restore started on that assumption has no safety net.
test('a job whose row disappears is reported as gone', async () => {
    const h = harness([undefined])
    const settled = await waitForSettled(
        { status: 'running' } as Job,
        h.read,
        h.options
    )
    assert.equal(settled, undefined)
})

// Timing out has to stay distinguishable from succeeding: the last state seen is
// still `running`, which the caller treats as "did not succeed".
test('waiting gives up at the deadline and still reports running', async () => {
    const h = harness(Array.from({ length: 20 }, () => ({ status: 'running' })))
    const settled = await waitForSettled(
        { status: 'running' } as Job,
        h.read,
        h.options
    )
    assert.equal(settled?.status, 'running')
    assert.equal(h.slept.length, 5)
})
