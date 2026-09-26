import assert from 'node:assert/strict'
import test from 'node:test'
import {
    dispatchWorkbenchEvents,
    subscribeWorkbenchEvents
} from '../src/lib/workbenchEvents'
import {
    publishResourceChanged,
    subscribeResourceChanges
} from '../src/lib/resourceChanges'

test('shared stream observers receive updates and reconnects and stop on layout disposal', () => {
    const calls: string[] = []
    const shell = subscribeWorkbenchEvents({
        onReconnected: () => calls.push('shell')
    })
    const settings = subscribeWorkbenchEvents({
        onReconnected: () => calls.push('settings'),
        onHostUpdate: (event) => calls.push(event.hostId)
    })
    dispatchWorkbenchEvents((h) => h.onReconnected?.())
    shell()
    dispatchWorkbenchEvents((h) => h.onReconnected?.())
    dispatchWorkbenchEvents((h) =>
        h.onHostUpdate?.({
            type: 'host-update',
            hostId: 'host-1',
            spriteStatus: 'running',
            at: new Date().toISOString()
        } as never)
    )
    settings()
    dispatchWorkbenchEvents((h) => h.onReconnected?.())
    assert.deepEqual(calls, ['shell', 'settings', 'settings', 'host-1'])
})

test('resource views receive a wildcard invalidation when the shared stream reconnects', () => {
    const received: unknown[] = []
    const unsubscribe = subscribeResourceChanges((event) =>
        received.push(event)
    )
    publishResourceChanged({ resource: '*' })
    unsubscribe()
    assert.deepEqual(received, [{ resource: '*' }])
})
