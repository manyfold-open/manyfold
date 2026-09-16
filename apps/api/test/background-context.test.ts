import assert from 'node:assert/strict'
import test from 'node:test'
import { inRequestContinuation } from '../src/common/telemetry/background-context'

test('a continuation preserves task completion and synchronous failures when Sentry is disabled', async () => {
    let finish!: () => void
    const task = new Promise<void>((resolve) => {
        finish = resolve
    })
    const returned = inRequestContinuation(() => task)
    assert.equal(returned, task)
    finish()
    await returned
    const error = new Error('synchronous setup failure')
    assert.throws(
        () =>
            inRequestContinuation(() => {
                throw error
            }),
        (candidate) => candidate === error
    )
})
