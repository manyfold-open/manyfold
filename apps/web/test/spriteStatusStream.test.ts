import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { StreamLifecycle } from '../src/lib/spriteStatusStream'
import { createReconnectingStream } from '../src/lib/spriteStatusStream'

interface Connection {
    lifecycle: StreamLifecycle
    closed: boolean
}

interface Harness {
    stream: ReturnType<typeof createReconnectingStream>
    connections: Connection[]
    reconnects: () => number
    setVisible: (value: boolean) => void
    advance: (ms: number) => void
}

const setup = (t: TestContext, options?: { visible?: boolean }): Harness => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let clock = 0
    let visible = options?.visible ?? true
    let reconnectCount = 0
    const connections: Connection[] = []
    const stream = createReconnectingStream({
        connect: (lifecycle) => {
            const connection: Connection = { lifecycle, closed: false }
            connections.push(connection)
            return {
                close: () => {
                    connection.closed = true
                }
            }
        },
        onReconnected: () => {
            reconnectCount++
        },
        isVisible: () => visible,
        random: () => 0.5,
        now: () => clock
    })
    t.after(() => stream.dispose())
    return {
        stream,
        connections,
        reconnects: () => reconnectCount,
        setVisible: (value) => {
            visible = value
            if (value) stream.notifyVisible()
        },
        advance: (ms) => {
            clock += ms
            t.mock.timers.tick(ms)
        }
    }
}

test('start opens a single connection and stays connected', (t) => {
    const h = setup(t)
    h.stream.start()
    assert.equal(h.connections.length, 1)
    h.connections[0]!.lifecycle.onOpen()
    h.advance(600_000)
    assert.equal(h.connections.length, 1)
    assert.equal(h.reconnects(), 0)
})

test('reconnects with exponential backoff while the stream stays down', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onDown()
    assert.equal(h.connections.length, 1)
    h.advance(1_000)
    assert.equal(h.connections.length, 2)
    h.connections[1]!.lifecycle.onDown()
    h.advance(1_999)
    assert.equal(h.connections.length, 2)
    h.advance(1)
    assert.equal(h.connections.length, 3)
    h.connections[2]!.lifecycle.onDown()
    h.advance(4_000)
    assert.equal(h.connections.length, 4)
})

test('backoff is capped at the maximum', (t) => {
    const h = setup(t)
    h.stream.start()
    for (let i = 0; i < 10; i++) {
        h.connections[h.connections.length - 1]!.lifecycle.onDown()
        h.advance(30_000)
    }
    const before = h.connections.length
    h.connections[before - 1]!.lifecycle.onDown()
    h.advance(30_000)
    assert.equal(h.connections.length, before + 1)
})

test('onReconnected fires after a drop is repaired, not on first open', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onOpen()
    assert.equal(h.reconnects(), 0)
    h.advance(60_000)
    h.connections[0]!.lifecycle.onDown()
    h.advance(1_000)
    h.connections[1]!.lifecycle.onOpen()
    assert.equal(h.reconnects(), 1)
})

test('a stable connection resets the backoff after the next drop', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onDown()
    h.advance(1_000)
    h.connections[1]!.lifecycle.onDown()
    h.advance(2_000)
    h.connections[2]!.lifecycle.onOpen()
    h.advance(10_000)
    h.connections[2]!.lifecycle.onDown()
    h.advance(1_000)
    assert.equal(h.connections.length, 4)
})

test('an unstable connection keeps growing the backoff', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onDown()
    h.advance(1_000)
    h.connections[1]!.lifecycle.onOpen()
    h.advance(5_000)
    h.connections[1]!.lifecycle.onDown()
    h.advance(1_999)
    assert.equal(h.connections.length, 2)
    h.advance(1)
    assert.equal(h.connections.length, 3)
})

test('dispose closes the connection and cancels pending reconnects', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onDown()
    h.stream.dispose()
    h.advance(600_000)
    assert.equal(h.connections.length, 1)
    assert.equal(h.connections[0]!.closed, true)
})

test('stale lifecycle callbacks from a replaced connection are ignored', (t) => {
    const h = setup(t)
    h.stream.start()
    const first = h.connections[0]!
    first.lifecycle.onDown()
    h.advance(1_000)
    assert.equal(h.connections.length, 2)
    first.lifecycle.onDown()
    first.lifecycle.onDown()
    h.advance(600_000)
    assert.equal(h.connections.length, 2)
})

test('notifyOnline cancels the pending retry and reconnects immediately', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onDown()
    h.advance(1_000)
    h.connections[1]!.lifecycle.onDown()
    h.stream.notifyOnline()
    assert.equal(h.connections.length, 3)
    h.connections[2]!.lifecycle.onDown()
    h.advance(1_000)
    assert.equal(h.connections.length, 4)
})

test('a retry firing while hidden defers until the tab is visible again', (t) => {
    const h = setup(t)
    h.stream.start()
    h.connections[0]!.lifecycle.onOpen()
    h.setVisible(false)
    h.connections[0]!.lifecycle.onDown()
    h.advance(600_000)
    assert.equal(h.connections.length, 1)
    h.setVisible(true)
    assert.equal(h.connections.length, 2)
})
