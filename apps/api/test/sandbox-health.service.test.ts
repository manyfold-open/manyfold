import assert from 'node:assert/strict'
import test from 'node:test'
import { SandboxHealthService } from '../src/modules/sandboxes/health/sandbox-health.service'

// The failure hook runs inside a bring-up that has a turn to end: it must hand
// back at once, never throw into it, and ask once for a burst of failures on
// one machine (a turn and its retries, every agent on the same sandbox).

const build = (isFeatureEnabled: () => Promise<boolean>) => {
    const asked: string[] = []
    const service = new SandboxHealthService(
        {} as never,
        {} as never,
        {
            isFeatureEnabled: async (key: string) => {
                asked.push(key)
                return isFeatureEnabled()
            }
        } as never,
        { event: () => {} } as never,
        {} as never
    )
    return { service, asked }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a failure is noted without waiting, and a burst on one machine is asked about once', async () => {
    const { service, asked } = build(async () => false)

    assert.equal(service.noteFailure('sbx_1', 'bring_up'), undefined)
    service.noteFailure('sbx_1', 'exec_probe')
    service.noteFailure('sbx_2', 'bring_up')
    await settle()

    assert.equal(asked.length, 2, 'one per machine')
})

test('a failure hook that cannot read its switch fails quietly', async () => {
    const { service } = build(async () => {
        throw new Error('settings unavailable')
    })
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
        service.noteFailure('sbx_1', 'bring_up')
        await settle()
    } finally {
        process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [])
})
