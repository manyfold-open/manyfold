import assert from 'node:assert/strict'
import test from 'node:test'
import { openDashboardInPopup as openWeb } from '../src/lib/openDashboard'
import { openDashboardInPopup as openAdmin } from '../../admin/src/lib/openDashboard'

for (const [surface, open] of [
    ['web', openWeb],
    ['admin', openAdmin]
] as const) {
    test(`${surface} opens synchronously and navigates the minted URL`, async () => {
        const operations: string[] = []
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                open: () => {
                    operations.push('open')
                    return {
                        location: {
                            replace: (url: string) => operations.push(url)
                        }
                    }
                },
                alert: () =>
                    assert.fail('successful navigation must not alert'),
                setTimeout,
                clearTimeout
            }
        })
        try {
            open(
                {
                    getControlUiUrl: async () => {
                        operations.push('mint')
                        return { url: 'https://dashboard.test/' }
                    }
                },
                { runtimeId: 'fixture' }
            )
            assert.deepEqual(operations, ['open', 'mint'])
            await new Promise((resolve) => setImmediate(resolve))
            assert.deepEqual(operations, [
                'open',
                'mint',
                'https://dashboard.test/'
            ])
        } finally {
            if (previous) Object.defineProperty(globalThis, 'window', previous)
            else Reflect.deleteProperty(globalThis, 'window')
        }
    })
    for (const shape of [
        'missing document',
        'closed',
        'inaccessible',
        'missing body',
        'mutation throws'
    ]) {
        test(`${surface} preserves the mint error when popup ${shape}`, async () => {
            const alerts: string[] = []
            const popup = {
                closed: shape === 'closed',
                get document() {
                    if (shape === 'inaccessible') throw new Error('denied')
                    if (shape === 'missing document') return undefined
                    return {
                        body:
                            shape === 'missing body'
                                ? undefined
                                : {
                                      replaceChildren: () => {
                                          throw new Error('DOM mutation failed')
                                      }
                                  }
                    }
                }
            }
            const previous = Object.getOwnPropertyDescriptor(
                globalThis,
                'window'
            )
            Object.defineProperty(globalThis, 'window', {
                configurable: true,
                value: {
                    open: () => popup,
                    alert: (message: string) => alerts.push(message),
                    setTimeout,
                    clearTimeout
                }
            })
            try {
                open(
                    {
                        getControlUiUrl: async () => {
                            throw new Error('original mint failure')
                        }
                    },
                    { runtimeId: 'fixture' }
                )
                await new Promise((resolve) => setImmediate(resolve))
                assert.equal(alerts.length, 1)
                assert.match(alerts[0], /original mint failure/)
                assert.doesNotMatch(alerts[0], /DOM mutation|denied/)
            } finally {
                if (previous)
                    Object.defineProperty(globalThis, 'window', previous)
                else Reflect.deleteProperty(globalThis, 'window')
            }
        })
    }
}
