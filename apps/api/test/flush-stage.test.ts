import test from 'node:test'
import assert from 'node:assert/strict'
import { runFlushStage } from '../src/flush-stage'

test('a stage that never settles cannot eat more than its own cap', async () => {
    const startedAt = Date.now()
    await runFlushStage(() => new Promise<void>(() => {}), 50)
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 40, `resolved before the cap (${elapsed}ms)`)
    assert.ok(elapsed < 1_000, `cap did not bound the stall (${elapsed}ms)`)
})

test('a completed stage returns immediately instead of waiting out the cap', async () => {
    const startedAt = Date.now()
    await runFlushStage(() => Promise.resolve(), 5_000)
    assert.ok(Date.now() - startedAt < 1_000)
})

test('a rejecting stage cannot abort the flush chain behind it', async () => {
    await runFlushStage(() => Promise.reject(new Error('exporter down')), 50)
})

test('a synchronously throwing stage cannot abort the flush chain behind it', async () => {
    await runFlushStage(() => {
        throw new Error('provider torn down')
    }, 50)
})