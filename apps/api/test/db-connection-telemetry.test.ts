import test from 'node:test'
import assert from 'node:assert/strict'
import { onDbConnectionClosed } from '../src/db/connection-telemetry'

test('a closed pool connection is one low-cardinality event naming its pool', () => {
    const events: Array<[string, Record<string, unknown>]> = []
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown>) =>
            events.push([name, attrs])
    }
    onDbConnectionClosed(telemetry as never, 'app')()
    onDbConnectionClosed(telemetry as never, 'broker')()
    assert.deepEqual(events, [
        ['db.connection.closed', { pool: 'app' }],
        ['db.connection.closed', { pool: 'broker' }]
    ])
})

test('without telemetry the hook is inert', () => {
    assert.doesNotThrow(() => onDbConnectionClosed(undefined, 'bus')())
})
