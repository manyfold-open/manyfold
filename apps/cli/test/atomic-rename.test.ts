import assert from 'node:assert/strict'
import test from 'node:test'
import { renameWithWindowsRetry } from '../src/atomic-rename'

const denied = (code: string) => Object.assign(new Error(code), { code })

test('Windows rename retries the same paths with bounded backoff', async () => {
    let now = 0
    const waits: number[] = []
    const paths: unknown[][] = []
    await renameWithWindowsRetry('temporary', 'target', {
        platform: 'win32',
        now: () => now,
        wait: async (ms) => {
            waits.push(ms)
            now += ms
        },
        renameFile: async (...args) => {
            paths.push(args)
            if (paths.length < 4) throw denied('EPERM')
        }
    })
    assert.deepEqual(
        paths,
        Array.from({ length: 4 }, () => ['temporary', 'target'])
    )
    assert.deepEqual(waits, [10, 20, 40])
})

test('persistent Windows permission denial exhausts finite attempts and surfaces the last error', async () => {
    let attempts = 0
    const errors: Error[] = []
    await assert.rejects(
        renameWithWindowsRetry('temporary', 'target', {
            platform: 'win32',
            now: () => 0,
            wait: async () => {},
            renameFile: async () => {
                attempts += 1
                const error = denied('EACCES')
                errors.push(error)
                throw error
            }
        }),
        (error) => error === errors.at(-1)
    )
    assert.equal(attempts, 12)
})

test('the monotonic deadline stops retries even when a wait wakes late', async () => {
    let now = 0
    let attempts = 0
    const error = denied('EBUSY')
    await assert.rejects(
        renameWithWindowsRetry('temporary', 'target', {
            platform: 'win32',
            now: () => now,
            wait: async (ms) => {
                assert.equal(ms, 10)
                now = 1_001
            },
            renameFile: async () => {
                attempts += 1
                throw error
            }
        }),
        (actual) => actual === error
    )
    assert.equal(attempts, 1)
})

test('time spent in rename consumes the same budget and the last wait cannot exceed it', async () => {
    let now = 0
    let attempts = 0
    const waits: number[] = []
    await assert.rejects(
        renameWithWindowsRetry('temporary', 'target', {
            platform: 'win32',
            now: () => now,
            wait: async (ms) => {
                waits.push(ms)
                now += ms
            },
            renameFile: async () => {
                attempts += 1
                now += 490
                throw denied('EPERM')
            }
        }),
        { code: 'EPERM' }
    )
    assert.equal(attempts, 2)
    assert.deepEqual(waits, [10, 10])
    assert.equal(now, 1_000)
})

for (const [platform, code] of [
    ['linux', 'EPERM'],
    ['darwin', 'EACCES'],
    ['win32', 'ENOENT'],
    ['win32', 'EIO'],
    ['win32', 'EXDEV']
] as const) {
    test(`${platform} ${code} is not retried`, async () => {
        let attempts = 0
        const error = denied(code)
        await assert.rejects(
            renameWithWindowsRetry('temporary', 'target', {
                platform,
                renameFile: async () => {
                    attempts += 1
                    throw error
                },
                wait: async () => {
                    assert.fail('unexpected retry')
                }
            }),
            (actual) => actual === error
        )
        assert.equal(attempts, 1)
    })
}
