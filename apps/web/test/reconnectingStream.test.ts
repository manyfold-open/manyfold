import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    createReconnectingStream,
    type StreamLifecycle
} from '../src/lib/spriteStatusStream'

/**
 * Deterministic helpers to exercise createReconnectingStream without timers.
 * We use { initialBackoffMs: 0 } so scheduled reconnects fire synchronously.
 */
const immediate = (): ReconnectingStreamOptions => ({
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    random: () => 0,
    now: () => 0
})

interface ReconnectingStreamOptions {
    initialBackoffMs?: number
    maxBackoffMs?: number
    random?: () => number
    now?: () => number
}

describe('createReconnectingStream', () => {
    it('closes the old handle before opening a replacement on reconnect', async () => {
        const handles: Array<{ closed: boolean; lifecycle: StreamLifecycle }> =
            []

        const stream = createReconnectingStream({
            connect: (lifecycle) => {
                const h = { closed: false, lifecycle }
                handles.push(h)
                // Simulate async onOpen
                queueMicrotask(() => lifecycle.onOpen())
                return { close: () => { h.closed = true } }
            },
            ...immediate()
        })

        stream.start()
        // Let onOpen fire
        await new Promise((r) => setTimeout(r, 10))

        assert.equal(handles.length, 1, 'initial connection')
        assert.equal(handles[0].closed, false, 'first handle is open')

        // Simulate onDown (e.g., network drop or parse error)
        handles[0].lifecycle.onDown()

        // With backoff=0, the reconnect timer fires synchronously via setTimeout(fn, 0)
        await new Promise((r) => setTimeout(r, 10))

        assert.equal(handles.length, 2, 'reconnect opened a second connection')
        assert.equal(
            handles[0].closed,
            true,
            'first handle must be closed before replacement opens'
        )
        assert.equal(handles[1].closed, false, 'second handle is active')

        stream.dispose()
        assert.equal(handles[1].closed, true, 'dispose closes the active handle')
    })

    it('a malformed-frame onError→onDown does not leave multiple live streams', async () => {
        const handles: Array<{ closed: boolean; lifecycle: StreamLifecycle }> =
            []

        const stream = createReconnectingStream({
            connect: (lifecycle) => {
                const h = { closed: false, lifecycle }
                handles.push(h)
                queueMicrotask(() => lifecycle.onOpen())
                return { close: () => { h.closed = true } }
            },
            ...immediate()
        })

        stream.start()
        await new Promise((r) => setTimeout(r, 10))

        // Simulate what happens when dispatchSpriteStatusFrame hits a JSON
        // parse error: the consumer's onError fires, which calls onDown(),
        // but the read loop in runSpriteStatusStream continues reading.
        // The old handle must be closed when the reconnect opens.
        handles[0].lifecycle.onDown()
        await new Promise((r) => setTimeout(r, 10))

        const liveHandles = handles.filter((h) => !h.closed)
        assert.equal(
            liveHandles.length,
            1,
            `expected exactly 1 live stream, got ${liveHandles.length}`
        )

        stream.dispose()
    })

    it('close is idempotent and does not throw on double-close', async () => {
        let closeCount = 0

        const stream = createReconnectingStream({
            connect: (lifecycle) => {
                queueMicrotask(() => lifecycle.onOpen())
                return {
                    close: () => {
                        closeCount++
                    }
                }
            },
            ...immediate()
        })

        stream.start()
        await new Promise((r) => setTimeout(r, 10))

        // onDown → reconnect will close the handle once, then open() creates
        // a new one. dispose() should only close the active one.
        stream.dispose()
        assert.equal(closeCount, 1, 'handle closed exactly once')
    })

    it('notifyOnline closes the stale handle before reconnecting', async () => {
        const handles: Array<{ closed: boolean; lifecycle: StreamLifecycle }> =
            []

        const stream = createReconnectingStream({
            connect: (lifecycle) => {
                const h = { closed: false, lifecycle }
                handles.push(h)
                queueMicrotask(() => lifecycle.onOpen())
                return { close: () => { h.closed = true } }
            },
            ...immediate()
        })

        stream.start()
        await new Promise((r) => setTimeout(r, 10))

        // Simulate onDown to enter the retry state
        handles[0].lifecycle.onDown()
        // Don't let the timer fire — call notifyOnline immediately which
        // should clear the timer and open a new connection
        stream.notifyOnline()
        await new Promise((r) => setTimeout(r, 10))

        // The old handle should be closed
        assert.equal(handles[0].closed, true, 'old handle closed on notifyOnline')
        const liveHandles = handles.filter((h) => !h.closed)
        assert.equal(
            liveHandles.length,
            1,
            `expected exactly 1 live stream after notifyOnline, got ${liveHandles.length}`
        )

        stream.dispose()
    })
})
