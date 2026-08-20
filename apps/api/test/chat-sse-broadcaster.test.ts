import type { ChatStreamEvent } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ChatSseBroadcaster,
    STREAM_MAX_PENDING_ROWS,
    type EmittedStreamEvent
} from '../src/modules/chat/sse-broadcaster'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import type { TurnExecutionFence } from '../src/modules/chat/turn-fence'

const collectEvents = (
    expected: number
): {
    events: ChatStreamEvent[]
    send: (event: ChatStreamEvent) => void
    done: Promise<void>
} => {
    const events: ChatStreamEvent[] = []
    let resolve = (): void => undefined
    const done = new Promise<void>((doneResolve) => {
        resolve = doneResolve
    })
    return {
        events,
        send: (event) => {
            events.push(event)
            if (events.length >= expected) resolve()
        },
        done
    }
}

test('live emit reaches a local subscriber in order via the pump', async () => {
    const store = makeStore()
    const node = makeNode(store)
    const events: ChatStreamEvent[] = []

    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'hello' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: ' world' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    await waitFor(() => events.length === 3)
    assert.deepEqual(
        events.map((event) => event.eventId),
        ['100', '101', '102']
    )
    assert.deepEqual(
        events.map((event) => event.seq),
        [1, 2, 3]
    )
    assert.deepEqual(
        events.map((event) => event.type),
        ['token', 'token', 'done']
    )
})

test('emit on one instance reaches a subscriber on another instance', async () => {
    const store = makeStore()
    const emitter = makeNode(store)
    const receiver = makeNode(store)
    const events: ChatStreamEvent[] = []

    await receiver.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    emitter.broadcaster.beginStream('session-1', 'message-1')
    await emitter.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'hello' }
    })
    await emitter.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    await waitFor(() => events.length === 2)
    assert.deepEqual(
        events.map((event) => event.eventId),
        ['100', '101']
    )
    assert.deepEqual(
        events.map((event) => event.type),
        ['token', 'done']
    )
})

test('redundant bus kicks do not duplicate delivery', async () => {
    const store = makeStore()
    const node = makeNode(store, { echoToSelf: true })
    const events: ChatStreamEvent[] = []

    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'hello' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    await waitFor(() => events.length >= 2)
    await sleep(20)
    assert.equal(events.length, 2)
})

test('module destroy closes SSE subscribers before the HTTP server closes', async () => {
    const store = makeStore()
    const node = makeNode(store)
    let closed = 0

    await node.broadcaster.subscribe(
        'session-1',
        {
            send: () => undefined,
            close: () => {
                closed += 1
            }
        },
        null
    )

    node.broadcaster.onModuleDestroy()
    node.broadcaster.onApplicationShutdown()

    assert.equal(closed, 1, 'shutdown cleanup must be idempotent')
})

test('terminal emit prevents later events from being persisted or sent', async () => {
    const store = makeStore()
    const node = makeNode(store)
    const events: ChatStreamEvent[] = []

    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'error',
        payload: {
            error: {
                code: 'adapter_failed',
                message: 'failed',
                retryable: false
            }
        }
    })
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'ignored' }
    })

    await waitFor(() => events.length === 1)
    await sleep(20)
    assert.equal(store.rows.length, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'error')
})

test('subscriber with Last-Event-ID only receives newer events', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')
    // Distinct source keys keep each emit its own row (same-key runs would
    // coalesce); this test is about cursor semantics, not row granularity.
    for (const text of ['a', 'b', 'c', 'd'])
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text },
            sourceEventKey: `key-${text}`,
            sourceEventOrdinal: 0
        })

    const events: ChatStreamEvent[] = []
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        '101'
    )

    await waitFor(() => events.length === 2)
    assert.deepEqual(
        events.map((event) => event.eventId),
        ['102', '103']
    )
})

test('fresh subscriber catches up from the start of the inflight turn only', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'old' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })
    node.broadcaster.beginStream('session-1', 'message-2')
    await node.broadcaster.emit('message-2', {
        type: 'token',
        payload: { text: 'fresh' }
    })
    store.latestInflight = 'message-2'

    const events: ChatStreamEvent[] = []
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )

    await waitFor(() => events.length === 1)
    await sleep(20)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.messageId, 'message-2')

    await node.broadcaster.emit('message-2', {
        type: 'done',
        payload: { finalMessageId: 'message-2' }
    })
    await waitFor(() => events.length === 2)
    assert.equal(events[1]?.type, 'done')
})

test('fresh subscriber with no inflight turn only receives future events', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'old' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    const events: ChatStreamEvent[] = []
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    await sleep(20)
    assert.equal(events.length, 0)

    node.broadcaster.beginStream('session-1', 'message-2')
    await node.broadcaster.emit('message-2', {
        type: 'token',
        payload: { text: 'next' }
    })
    await waitFor(() => events.length === 1)
    assert.equal(events[0]?.messageId, 'message-2')
})

test(
    'an idle page cursor delivers a turn that finishes before subscribe begins',
    { timeout: 1000 },
    async () => {
        const store = makeStore()
        const node = makeNode(store)
        node.broadcaster.beginStream('session-1', 'message-1')
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text: 'settled history' }
        })
        await node.broadcaster.emit('message-1', {
            type: 'done',
            payload: { finalMessageId: 'message-1' }
        })
        const pageCursor = String(store.rows[store.rows.length - 1]?.id)

        node.broadcaster.beginStream('session-1', 'message-2')
        await node.broadcaster.emit('message-2', {
            type: 'token',
            payload: { text: 'answer in the handoff gap' }
        })
        await node.broadcaster.emit('message-2', {
            type: 'done',
            payload: { finalMessageId: 'message-2' }
        })
        store.latestInflight = null

        const received = collectEvents(2)
        await node.broadcaster.subscribe(
            'session-1',
            { send: received.send, close: () => undefined },
            pageCursor
        )
        await received.done

        assert.deepEqual(
            received.events.map((event) => event.messageId),
            ['message-2', 'message-2']
        )
        assert.deepEqual(
            received.events.map((event) => event.type),
            ['token', 'done']
        )
    }
)

test(
    'a bare attach cannot advance past a turn terminalizing inside initialCursor',
    { timeout: 1000 },
    async () => {
        const store = makeStore()
        let terminalize = async (): Promise<void> => undefined
        const node = makeNode(store, {
            duringInitialCursor: () => terminalize()
        })
        node.broadcaster.beginStream('session-1', 'message-1')
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text: 'settled history' }
        })
        await node.broadcaster.emit('message-1', {
            type: 'done',
            payload: { finalMessageId: 'message-1' }
        })

        terminalize = async () => {
            node.broadcaster.beginStream('session-1', 'message-2')
            await node.broadcaster.emit('message-2', {
                type: 'token',
                payload: { text: 'entire unseen turn' }
            })
            await node.broadcaster.emit('message-2', {
                type: 'done',
                payload: { finalMessageId: 'message-2' }
            })
            store.latestInflight = null
        }

        const received = collectEvents(2)
        await node.broadcaster.subscribe(
            'session-1',
            { send: received.send, close: () => undefined },
            null
        )
        await received.done

        assert.deepEqual(
            received.events.map((event) => event.messageId),
            ['message-2', 'message-2']
        )
        assert.deepEqual(
            received.events.map((event) => event.type),
            ['token', 'done']
        )
    }
)

test(
    'a replay target cannot advance past its first row and terminal landing together',
    { timeout: 1000 },
    async () => {
        const store = makeStore()
        let terminalize = async (): Promise<void> => undefined
        const node = makeNode(store, {
            duringReplayCursor: () => terminalize()
        })
        node.broadcaster.beginStream('session-1', 'message-1')
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text: 'settled history' }
        })
        await node.broadcaster.emit('message-1', {
            type: 'done',
            payload: { finalMessageId: 'message-1' }
        })

        terminalize = async () => {
            node.broadcaster.beginStream('session-1', 'message-2')
            await node.broadcaster.emit('message-2', {
                type: 'token',
                payload: { text: 'first row and the rest' }
            })
            await node.broadcaster.emit('message-2', {
                type: 'done',
                payload: { finalMessageId: 'message-2' }
            })
        }

        const received = collectEvents(2)
        await node.broadcaster.subscribe(
            'session-1',
            { send: received.send, close: () => undefined },
            null,
            'message-2'
        )
        await received.done

        assert.deepEqual(
            received.events.map((event) => event.type),
            ['token', 'done']
        )
    }
)

test(
    'a replay target from another session cannot move this session cursor',
    { timeout: 1000 },
    async () => {
        const store = makeStore()
        store.rows.push(
            {
                id: 100n,
                sessionId: 'session-1',
                messageId: 'message-1',
                seq: 1,
                eventType: 'done',
                payloadJson: { finalMessageId: 'message-1' },
                sourceEventKey: null,
                sourceEventOrdinal: null,
                runnerSeq: null,
                createdAt: new Date(0)
            },
            {
                id: 999n,
                sessionId: 'session-2',
                messageId: 'foreign-message',
                seq: 1,
                eventType: 'token',
                payloadJson: { text: 'foreign' },
                sourceEventKey: null,
                sourceEventOrdinal: null,
                runnerSeq: null,
                createdAt: new Date(0)
            }
        )
        const node = makeNode(store)
        const received = collectEvents(1)
        await node.broadcaster.subscribe(
            'session-1',
            { send: received.send, close: () => undefined },
            null,
            'foreign-message'
        )
        node.broadcaster.beginStream('session-1', 'message-2')
        await node.broadcaster.emit('message-2', {
            type: 'done',
            payload: { finalMessageId: 'message-2' }
        })
        await received.done

        assert.equal(received.events[0].messageId, 'message-2')
    }
)

// The near side. The page shipped a turn's partial content plus the
// checkpoint cursor that content ends at, then the turn terminated before the
// client got its subscribe out. Resuming from that stale cursor has to pick
// up exactly the remainder — including the terminal, and without replaying
// the blocks the page already rendered.
test('a stale page checkpoint resumes after the terminal without repeating rendered content', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')
    for (const text of ['a', 'b'])
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text },
            sourceEventKey: `key-${text}`,
            sourceEventOrdinal: 0
        })
    // The cursor the page shipped: settle gives the exact durable prefix that
    // the rendered content covers, before any later event is admitted.
    const settledCheckpoint = await node.broadcaster.settle('message-1')
    assert.notEqual(settledCheckpoint, null)
    const checkpoint = String(settledCheckpoint)
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'c' },
        sourceEventKey: 'key-c',
        sourceEventOrdinal: 0
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })
    store.latestInflight = null

    const received = collectEvents(2)
    await node.broadcaster.subscribe(
        'session-1',
        { send: received.send, close: () => undefined },
        checkpoint,
        'message-1'
    )
    await received.done

    assert.deepEqual(
        received.events.map((event) => event.eventId),
        ['102', '103']
    )
    assert.deepEqual(
        received.events.map((event) => event.type),
        ['token', 'done']
    )
})

test('replayMessageId replays a finished turn from its start, including the terminal', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'a' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'b' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })
    store.latestInflight = null

    const events: ChatStreamEvent[] = []
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null,
        'message-1'
    )

    await waitFor(() => events.length === 3)
    await sleep(20)
    assert.deepEqual(
        events.map((event) => event.type),
        ['token', 'token', 'done']
    )
    assert.deepEqual(
        events.map((event) => event.eventId),
        ['100', '101', '102']
    )
})

test('lastEventId takes precedence over replayMessageId', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')
    for (const text of ['a', 'b', 'c'])
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text },
            sourceEventKey: `key-${text}`,
            sourceEventOrdinal: 0
        })

    const events: ChatStreamEvent[] = []
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        '101',
        'message-1'
    )

    await waitFor(() => events.length === 1)
    await sleep(20)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.eventId, '102')
})

test('unsubscribe stops delivery', async () => {
    const store = makeStore()
    const node = makeNode(store)
    const events: ChatStreamEvent[] = []

    const unsubscribe = await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'hello' }
    })
    await waitFor(() => events.length === 1)
    unsubscribe()
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'late' }
    })
    await sleep(20)
    assert.equal(events.length, 1)
})

// A write the test holds open. The safety timer is deliberately NOT unref'd:
// a regression that never lets the producer go would otherwise end the run
// with "promise resolution is still pending" instead of the assertion that
// says what actually broke. Every passing path clears it in release().
const makeGate = (): { hold: () => Promise<void>; release: () => void } => {
    let release = (): void => undefined
    const opened = new Promise<void>((resolve) => {
        release = resolve
    })
    const safety = setTimeout(() => release(), 5_000)
    return {
        hold: () => opened,
        release: () => {
            clearTimeout(safety)
            release()
        }
    }
}

const toolEvent = (n: number): EmittedStreamEvent => ({
    type: 'tool_call',
    payload: { type: 'tool_call', toolCallId: `call-${n}` },
    sourceEventKey: `key-${n}`,
    sourceEventOrdinal: 0
})

test('a detached emit returns before its row is written', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    let returned = 0
    for (let i = 0; i < 8; i += 1) {
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
        returned += 1
    }

    assert.equal(returned, 8, 'every detached emit must return unblocked')
    assert.equal(store.rows.length, 0, 'no write may have committed yet')
    gate.release()
    await waitFor(() => store.rows.length === 8)
})

test('detached writes stop at the pending cap when the database is slower than the stream', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    const total = STREAM_MAX_PENDING_ROWS * 4
    let returned = 0
    const burst = (async () => {
        for (let i = 0; i < total; i += 1) {
            await node.broadcaster.emitDetached('message-1', toolEvent(i))
            returned += 1
        }
    })()

    // Long enough that an unbounded producer would have drained the whole
    // burst into the chain many times over.
    await sleep(50)
    assert.equal(
        returned,
        STREAM_MAX_PENDING_ROWS,
        'the producer must block once the row cap is reached'
    )
    assert.equal(store.rows.length, 0)

    gate.release()
    await burst
    await waitFor(() => store.rows.length === total)
    assert.deepEqual(
        store.rows.map((row) => row.seq),
        Array.from({ length: total }, (_, i) => i + 1)
    )
})

test('detached writes land in emit order however long each one takes', async () => {
    const store = makeStore()
    // Alternating latency: a chain that let writes overlap would commit the
    // fast rows ahead of the slow ones and the seq/id orders would diverge.
    const node = makeNode(store, {
        beforeInsert: (row) => sleep(row.seq % 2 === 0 ? 0 : 15)
    })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (let i = 0; i < 12; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    assert.equal(store.rows.length, 13)
    assert.deepEqual(
        store.rows.map((row) => row.seq),
        Array.from({ length: 13 }, (_, i) => i + 1)
    )
    assert.deepEqual(
        store.rows
            .filter((row) => row.eventType === 'tool_call')
            .map((row) => row.payloadJson.toolCallId),
        Array.from({ length: 12 }, (_, i) => `call-${i}`)
    )
    assert.equal(store.rows.at(-1)?.eventType, 'done')
})

// runner_seq on a durable row claims that everything before it is durable
// too, and the exact resume cursor is max(runner_seq) — so a row landing over
// an earlier hole is how a runner resume comes to skip content permanently.
// Awaiting each write used to make that impossible by killing the turn; the
// latch has to buy the same guarantee back.
test('a failed write abandons the rows behind it and stops the producer', async () => {
    const store = makeStore()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
        rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
        const node = makeNode(store, {
            beforeInsert: async (row) => {
                if (row.seq === 2) throw new Error('write blew up')
            }
        })
        const delivered: ChatStreamEvent[] = []
        await node.broadcaster.subscribe(
            'session-1',
            { send: (event) => delivered.push(event), close: () => undefined },
            null
        )
        node.broadcaster.beginStream('session-1', 'message-1')

        for (let i = 0; i < 3; i += 1)
            await node.broadcaster.emitDetached('message-1', toolEvent(i))
        await sleep(20)
        assert.deepEqual(
            store.rows.map((row) => row.seq),
            [1],
            'seq 2 failed, so seq 3 must not land over the hole it left'
        )

        await assert.rejects(
            () => node.broadcaster.emitDetached('message-1', toolEvent(9)),
            /write blew up/,
            'the producer has to learn, exactly as the old await told it'
        )

        // The terminal is exempt: its write releases the inflight claim, and
        // a turn that reached a terminal is never a resume cursor's input.
        const terminal = await node.broadcaster.emit('message-1', {
            type: 'error',
            payload: {
                type: 'error',
                error: { code: 'adapter_failed', message: 'x', retryable: true }
            }
        })
        assert.equal(terminal.persisted, true)
        assert.deepEqual(
            store.rows.map((row) => row.eventType),
            ['tool_call', 'error']
        )
        await waitFor(() => delivered.length === 2)
        await sleep(20)
        assert.deepEqual(
            delivered.map((event) => event.type),
            ['tool_call', 'error'],
            'a reconnecting reader sees no row from behind the failure'
        )
        assert.deepEqual(rejections, [])
    } finally {
        process.off('unhandledRejection', onRejection)
    }
})

test('a producer waiting for capacity observes the failure that freed it', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, {
        beforeInsert: async (row) => {
            if (row.seq !== 1) return
            await gate.hold()
            throw new Error('first queued write failed')
        }
    })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (let i = 0; i < STREAM_MAX_PENDING_ROWS; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    const waiting = node.broadcaster.emitDetached(
        'message-1',
        toolEvent(STREAM_MAX_PENDING_ROWS)
    )
    gate.release()

    await assert.rejects(
        waiting,
        /first queued write failed/,
        'capacity becoming available because the head failed is not success'
    )
    await sleep(20)
    assert.deepEqual(store.rows, [])
})

test('runner_seq never advances past a row that failed to persist', async () => {
    const store = makeStore()
    const node = makeNode(store, {
        beforeInsert: async (row) => {
            if (row.runnerSeq === 11) throw new Error('write blew up')
        }
    })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (const runnerSeq of [10, 11, 12])
        await node.broadcaster.emitDetached('message-1', {
            ...toolEvent(runnerSeq),
            runnerSeq
        })
    await sleep(20)

    // What exactResumeSeqForMessage() computes, against the rows that
    // actually landed. 12 here would send a runner resume past content that
    // never reached the table.
    const cursor = store.rows.reduce(
        (max, row) => Math.max(max, row.runnerSeq ?? 0),
        0
    )
    assert.equal(cursor, 10)
})

test('a detached emit at capacity keeps its place ahead of a concurrent terminal', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    // Exactly to the cap, so the next admission is the first to cross it.
    // Filling past the cap here would park this loop instead, and `late`
    // would then be admitted against a draining queue — never reaching the
    // branch this test is about.
    for (let i = 0; i < STREAM_MAX_PENDING_ROWS; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    // Over capacity, so this one has to wait — but it must be admitted
    // first. An offline cancel terminalizes the same message meanwhile.
    const late = node.broadcaster.emitDetached('message-1', toolEvent(900))
    const terminal = node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    gate.release()
    await late
    await terminal
    await waitFor(() => store.rows.length === STREAM_MAX_PENDING_ROWS + 2)
    await sleep(20)
    assert.equal(
        store.rows.at(-1)?.eventType,
        'done',
        'no row may commit after the terminal'
    )
    assert.deepEqual(
        store.rows.map((row) => row.seq),
        Array.from({ length: STREAM_MAX_PENDING_ROWS + 2 }, (_, i) => i + 1)
    )
})

// #701. A terminal used to close admission only AFTER its own row committed:
// emit() set stream.ended and dropped the map entry on the far side of its
// await. Everything the producer handed over during that window — a detached
// tool row, a buffered token, a second terminal — still found a live stream,
// drew a seq and queued BEHIND the terminal, so the durable log ended
// `done, tool_call`. The pump delivers the late row, and a client that already
// returned the turn to idle makes it live again with nothing left to close it.
const terminalEvent = (type: 'done' | 'error'): EmittedStreamEvent =>
    type === 'done'
        ? { type, payload: { type: 'done', finalMessageId: 'message-1' } }
        : {
              type,
              payload: {
                  type: 'error',
                  error: {
                      code: 'cancelled_by_user',
                      message: 'stopped',
                      retryable: false
                  }
              }
          }

// One per event type that can reach a stream after its terminal: the three
// the adapter loop detaches, and the two it buffers.
const LATE_EVENTS: EmittedStreamEvent[] = [
    { type: 'tool_call', payload: { type: 'tool_call', toolCallId: 'late' } },
    {
        type: 'tool_result',
        payload: { type: 'tool_result', toolCallId: 'late' }
    },
    { type: 'replace', payload: { type: 'replace', text: 'redacted' } },
    { type: 'token', payload: { type: 'token', text: 'late' } },
    { type: 'thinking', payload: { type: 'thinking', text: 'late' } }
]

const DETACHED_LATE = new Set(['tool_call', 'tool_result', 'replace'])

for (const kind of ['done', 'error'] as const)
    for (const late of LATE_EVENTS)
        test(`no ${late.type} may be admitted behind a pending ${kind} terminal`, async () => {
            const store = makeStore()
            const gate = makeGate()
            const node = makeNode(store, { beforeInsert: gate.hold })
            node.broadcaster.beginStream('session-1', 'message-1')

            // Held open, so the terminal is admitted but not yet durable —
            // the window an offline cancel racing a live adapter runs in.
            const terminal = node.broadcaster.emit(
                'message-1',
                terminalEvent(kind)
            )
            if (DETACHED_LATE.has(late.type))
                await node.broadcaster.emitDetached('message-1', late)
            else
                assert.equal(
                    (await node.broadcaster.emit('message-1', late)).persisted,
                    false,
                    'a refused event must not report a durable write'
                )

            gate.release()
            assert.equal((await terminal).persisted, true)
            await sleep(20)
            assert.deepEqual(
                store.rows.map((row) => row.eventType),
                [kind],
                'no row may reach the table behind the terminal'
            )
        })

// The buffered path's own way out. A token accepted after the terminal does
// not write inline — it arms the merge window's flush timer, so its row is
// written from a timer callback long after the terminal committed and after
// every assertion a fast test would make.
test('a token refused after the terminal arms no flush timer behind it', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    const terminal = node.broadcaster.emit('message-1', terminalEvent('done'))
    for (const text of ['a', 'b', 'c'])
        assert.equal(
            (
                await node.broadcaster.emit('message-1', {
                    type: 'token',
                    payload: { type: 'token', text }
                })
            ).persisted,
            false,
            'a terminal must close the buffered path too'
        )

    gate.release()
    assert.equal((await terminal).persisted, true)
    // Well past the 120ms merge window, so a timer armed by any of those
    // tokens has fired by now.
    await sleep(300)
    assert.deepEqual(
        store.rows.map((row) => row.eventType),
        ['done']
    )
})

// The reverse of the same window, and the reason admission does not simply
// reopen: a second terminal must be refused rather than queued, and has to
// say so through `persisted` so the caller does not report a turn it did not
// terminalize.
test('a second terminal is refused while the first one is still writing', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    const first = node.broadcaster.emit('message-1', terminalEvent('done'))
    const second = node.broadcaster.emit('message-1', terminalEvent('error'))

    gate.release()
    assert.equal((await first).persisted, true)
    assert.equal(
        (await second).persisted,
        false,
        'the loser of a terminal race must not report a durable write'
    )
    await sleep(20)
    assert.deepEqual(
        store.rows.map((row) => row.eventType),
        ['done']
    )
})

// Failing closed has to happen at admission, before the capacity wait: a
// refused event queued nothing, so there is nothing for it to wait behind.
// With the gate still shut, a call that waited could only return when the
// gate's safety net fires — by which time the rows have committed and the
// count below is no longer zero.
test('a refused detached emit does not wait on the pending queue', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (let i = 0; i < STREAM_MAX_PENDING_ROWS; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    const terminal = node.broadcaster.emit('message-1', terminalEvent('done'))
    await node.broadcaster.emitDetached('message-1', toolEvent(900))
    assert.equal(
        store.rows.length,
        0,
        'a refused emit must return without waiting for a commit'
    )

    gate.release()
    assert.equal((await terminal).persisted, true)
    await waitFor(() => store.rows.length === STREAM_MAX_PENDING_ROWS + 1)
    await sleep(20)
    assert.equal(store.rows.at(-1)?.eventType, 'done')
    assert.equal(store.rows.length, STREAM_MAX_PENDING_ROWS + 1)
})

test('a rejected terminal write releases admission for a resumed retry', async () => {
    const store = makeStore()
    let reject = true
    const node = makeNode(store, {
        beforeInsert: async (row) => {
            if (reject && row.eventType === 'done') {
                reject = false
                throw new Error('terminal insert failed')
            }
        }
    })
    node.broadcaster.beginStream('session-1', 'message-1')

    await assert.rejects(
        () => node.broadcaster.emit('message-1', terminalEvent('done')),
        /terminal insert failed/
    )
    assert.equal(node.broadcaster.hasStream('message-1'), false)
    assert.equal(store.rows.length, 0)

    await node.broadcaster.beginResumeStream('session-1', 'message-1')
    assert.equal(
        (await node.broadcaster.emit('message-1', terminalEvent('done')))
            .persisted,
        true
    )
    assert.deepEqual(
        store.rows.map((row) => [row.seq, row.eventType]),
        [[1, 'done']]
    )
})

test('a refused terminal cannot replace the winning final content', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')
    const firstContent = {
        contentBlocksJson: [{ type: 'text' as const, text: 'winner' }],
        contentCheckpointEventId: null
    }
    const losingContent = {
        contentBlocksJson: [{ type: 'text' as const, text: 'loser' }],
        contentCheckpointEventId: null
    }

    const first = node.broadcaster.emit(
        'message-1',
        terminalEvent('done'),
        firstContent
    )
    const second = await node.broadcaster.emit(
        'message-1',
        terminalEvent('error'),
        losingContent
    )

    assert.equal(second.persisted, false)
    gate.release()
    assert.equal((await first).persisted, true)
})

// The other half of the same rule: closing admission must not strand content
// the stream had already accepted. A token still sitting in the merge window
// when the terminal arrives is detached by the terminal itself and written in
// front of it, exactly as before.
test('a token buffered before the terminal still commits ahead of it', async () => {
    const store = makeStore()
    const node = makeNode(store)
    node.broadcaster.beginStream('session-1', 'message-1')

    // 'a' paints on the leading edge; 'b' lands inside the window and is
    // still unwritten when the terminal is admitted.
    for (const text of ['a', 'b'])
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { type: 'token', text }
        })
    await waitFor(() => store.rows.length === 1)

    const terminal = await node.broadcaster.emit(
        'message-1',
        terminalEvent('done')
    )
    assert.equal(terminal.persisted, true)
    assert.deepEqual(
        store.rows.map((row) => row.eventType),
        ['token', 'token', 'done']
    )
    assert.deepEqual(
        store.rows.map((row) => row.seq),
        [1, 2, 3]
    )
    assert.equal(store.rows[1]?.payloadJson.text, 'b')
})

test('a terminal waits for detached writes queued ahead of it', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, {
        beforeInsert: (row) => (row.seq <= 3 ? gate.hold() : Promise.resolve())
    })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (let i = 0; i < 3; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    let terminalDone = false
    const terminal = node.broadcaster
        .emit('message-1', {
            type: 'done',
            payload: { finalMessageId: 'message-1' }
        })
        .then((result) => {
            terminalDone = true
            return result
        })

    await sleep(20)
    assert.equal(terminalDone, false, 'the terminal must not overtake them')
    assert.equal(store.rows.length, 0)
    gate.release()
    assert.equal((await terminal).persisted, true)
    assert.deepEqual(
        store.rows.map((row) => row.seq),
        [1, 2, 3, 4]
    )
})

test('a suspended event waits for detached writes queued ahead of it', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, {
        beforeInsert: (row) => (row.seq <= 2 ? gate.hold() : Promise.resolve())
    })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (let i = 0; i < 2; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    let suspendedDone = false
    const suspended = node.broadcaster
        .emit('message-1', {
            type: 'suspended',
            payload: { type: 'suspended', reason: 'transport gone' }
        })
        .then((result) => {
            suspendedDone = true
            return result
        })

    await sleep(20)
    assert.equal(suspendedDone, false)
    gate.release()
    await suspended
    node.broadcaster.endStream('message-1')
    assert.deepEqual(
        store.rows.map((row) => row.eventType),
        ['tool_call', 'tool_call', 'suspended']
    )
})

test('endStream does not drop writes already queued', async () => {
    const store = makeStore()
    const gate = makeGate()
    const node = makeNode(store, { beforeInsert: gate.hold })
    node.broadcaster.beginStream('session-1', 'message-1')

    for (let i = 0; i < 4; i += 1)
        await node.broadcaster.emitDetached('message-1', toolEvent(i))
    // A trailing token so endStream's buffer flush is queued behind them too.
    await node.broadcaster.emitDetached('message-1', {
        type: 'token',
        payload: { type: 'token', text: 'tail' }
    })
    node.broadcaster.endStream('message-1')
    assert.equal(store.rows.length, 0)

    gate.release()
    await waitFor(() => store.rows.length === 5)
    assert.deepEqual(
        store.rows.map((row) => row.seq),
        [1, 2, 3, 4, 5]
    )
})

test('a fenced-out old stream cannot delete or close its replacement', async () => {
    const store = makeStore()
    const gate = makeGate()
    const oldFence = {
        messageId: 'message-1',
        ownerId: 'replica-a',
        generation: 1
    }
    const freshFence = { ...oldFence, generation: 2 }
    const node = makeNode(store, {
        beforeInsert: (_row, fence) =>
            fence?.generation === 1 ? gate.hold() : Promise.resolve(),
        insertResult: (_row, fence) =>
            fence?.generation === 1 ? { id: null, fenceLost: true } : undefined
    })
    node.broadcaster.beginStream('session-1', 'message-1', 0, oldFence)
    await node.broadcaster.emitDetached('message-1', toolEvent(1))
    await node.broadcaster.emitDetached('message-1', toolEvent(2))

    await node.broadcaster.beginResumeStream(
        'session-1',
        'message-1',
        freshFence
    )
    node.broadcaster.endStream('message-1', oldFence)
    assert.equal(node.broadcaster.hasStream('message-1'), true)

    gate.release()
    await sleep(20)
    assert.equal(
        node.broadcaster.hasStream('message-1'),
        true,
        'the old write completion is scoped to the old ActiveStream object'
    )
    assert.equal(
        await node.broadcaster.emitDetached('message-1', toolEvent(3)),
        true
    )
    const terminal = await node.broadcaster.emit(
        'message-1',
        terminalEvent('done')
    )
    assert.equal(terminal.persisted, true)
    assert.deepEqual(
        store.rows.map((row) => row.eventType),
        ['tool_call', 'done'],
        'rows buffered behind the lost fence are abandoned'
    )
})

interface StreamRow {
    id: bigint
    sessionId: string
    messageId: string
    seq: number
    eventType: EmittedStreamEvent['type']
    payloadJson: Record<string, unknown>
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
    runnerSeq: number | null
    createdAt: Date
}

interface Store {
    rows: StreamRow[]
    latestInflight: string | null
    nodes: FakeBus[]
}

class FakeBus {
    private readonly messageHandlers: Array<(sessionId: string) => void> = []

    constructor(
        private readonly store: Store,
        private readonly echoToSelf: boolean
    ) {}

    onMessage(handler: (sessionId: string) => void): void {
        this.messageHandlers.push(handler)
    }

    onListenEstablished(): void {}

    dropNotifies = false

    notify(sessionId: string): void {
        if (this.dropNotifies) return
        for (const node of this.store.nodes) {
            if (node === this && !this.echoToSelf) continue
            node.deliver(sessionId)
        }
    }

    deliver(sessionId: string): void {
        for (const handler of this.messageHandlers) handler(sessionId)
    }
}

const makeStore = (): Store => ({
    rows: [],
    latestInflight: null,
    nodes: []
})

const makeNode = (
    store: Store,
    opts: {
        echoToSelf?: boolean
        // Runs before the row is appended, so a test can hold a write open or
        // fail it. Awaiting it here is what makes the fake repo model a real
        // commit latency instead of resolving on a microtask.
        beforeInsert?: (
            row: Omit<StreamRow, 'id'>,
            fence?: TurnExecutionFence
        ) => Promise<void>
        insertResult?: (
            row: Omit<StreamRow, 'id'>,
            fence?: TurnExecutionFence
        ) => { id: bigint | null; fenceLost: boolean } | undefined
        duringInitialCursor?: () => Promise<void>
        duringReplayCursor?: () => Promise<void>
    } = {}
): { broadcaster: ChatSseBroadcaster; bus: FakeBus } => {
    const repo = {
        insertStreamEvent: async (
            row: Omit<StreamRow, 'id'>,
            terminalContent?: unknown,
            fence?: TurnExecutionFence
        ) => {
            if (opts.beforeInsert) await opts.beforeInsert(row, fence)
            void terminalContent
            const result = opts.insertResult?.(row, fence)
            if (result) return result
            const id = 100n + BigInt(store.rows.length)
            store.rows.push({ ...row, id })
            return { id, fenceLost: false }
        },
        maxStreamEventSeq: async (messageId: string) => {
            let value = 0
            for (const row of store.rows)
                if (row.messageId === messageId && row.seq > value)
                    value = row.seq
            return value
        },
        latestInflightMessageId: async () => {
            const inflight = store.latestInflight
            await opts.duringInitialCursor?.()
            return inflight
        },
        streamAttachAnchor: async (sessionId: string) => {
            const inflightMessageId = store.latestInflight
            let maxEventId = 0n
            for (const row of store.rows)
                if (row.sessionId === sessionId && row.id > maxEventId)
                    maxEventId = row.id
            await opts.duringInitialCursor?.()
            return { inflightMessageId, maxEventId }
        },
        minStreamEventId: async (messageId: string) => {
            let value: bigint | null = null
            for (const row of store.rows)
                if (
                    row.messageId === messageId &&
                    (value === null || row.id < value)
                )
                    value = row.id
            await opts.duringReplayCursor?.()
            return value
        },
        streamReplayCursor: async (sessionId: string, messageId: string) => {
            let messageMin: bigint | null = null
            let sessionMax = 0n
            for (const row of store.rows) {
                if (
                    row.sessionId === sessionId &&
                    row.messageId === messageId &&
                    (messageMin === null || row.id < messageMin)
                )
                    messageMin = row.id
                if (row.sessionId === sessionId && row.id > sessionMax)
                    sessionMax = row.id
            }
            await opts.duringReplayCursor?.()
            return messageMin === null ? sessionMax : messageMin - 1n
        },
        maxSessionStreamEventId: async (sessionId: string) => {
            let value = 0n
            for (const row of store.rows)
                if (row.sessionId === sessionId && row.id > value)
                    value = row.id
            return value
        },
        findTerminalStreamEvent: async (messageId: string) => {
            const row = store.rows.find(
                (candidate) =>
                    candidate.messageId === messageId &&
                    (candidate.eventType === 'done' ||
                        candidate.eventType === 'error')
            )
            return row
                ? { eventType: row.eventType, payloadJson: row.payloadJson }
                : null
        },
        listSessionStreamEventsSince: async (
            sessionId: string,
            afterId: bigint,
            limit: number
        ) =>
            store.rows
                .filter(
                    (row) => row.sessionId === sessionId && row.id > afterId
                )
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .slice(0, limit)
    }
    const bus = new FakeBus(store, opts.echoToSelf ?? false)
    store.nodes.push(bus)
    const broadcaster = new ChatSseBroadcaster(
        repo as never,
        bus as unknown as ChatStreamBus
    )
    return { broadcaster, bus }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 1000
): Promise<void> => {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
        await sleep(5)
    }
}

test('safety re-poll recovers a cross-instance stream whose NOTIFY was lost', async () => {
    const store = makeStore()
    const emitter = makeNode(store)
    const receiver = makeNode(store)
    const events: ChatStreamEvent[] = []

    await receiver.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    emitter.bus.dropNotifies = true
    emitter.broadcaster.beginStream('session-1', 'message-1')
    await emitter.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    // No bus wakeup ever arrives; only the receiver's 2.5s safety tick can
    // find the persisted terminal event.
    assert.equal(events.length, 0)
    await waitFor(() => events.length === 1, 6000)
    assert.equal(events[0].type, 'done')
})

test('a subscriber whose send throws is dropped and closed', async () => {
    const store = makeStore()
    const node = makeNode(store)
    const good: ChatStreamEvent[] = []
    let closed = false

    await node.broadcaster.subscribe(
        'session-1',
        {
            send: () => {
                throw new Error('broken pipe')
            },
            close: () => {
                closed = true
            }
        },
        null
    )
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => good.push(event), close: () => undefined },
        null
    )
    node.broadcaster.beginStream('session-1', 'message-1')
    await node.broadcaster.emit('message-1', {
        type: 'token',
        payload: { text: 'hello' }
    })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    await waitFor(() => good.length === 2)
    assert.equal(closed, true)
})

test('rapid same-source tokens coalesce into one row, byte-identical for subscribers', async () => {
    const store = makeStore()
    const node = makeNode(store)
    const events: ChatStreamEvent[] = []
    await node.broadcaster.subscribe(
        'session-1',
        { send: (event) => events.push(event), close: () => undefined },
        null
    )
    node.broadcaster.beginStream('session-1', 'message-1')
    // 'a' paints leading-edge; 'b'..'d' land inside the flush window with the
    // same (null) source key, so they merge into a single row.
    for (const text of ['a', 'b', 'c', 'd'])
        await node.broadcaster.emit('message-1', {
            type: 'token',
            payload: { text }
        })
    await node.broadcaster.emit('message-1', {
        type: 'done',
        payload: { finalMessageId: 'message-1' }
    })

    await waitFor(() => events.at(-1)?.type === 'done')
    const tokenRows = store.rows.filter((row) => row.eventType === 'token')
    assert.equal(tokenRows.length, 2)
    const streamedText = events
        .filter((event) => event.type === 'token')
        .map((event) => (event as { text?: string }).text ?? '')
        .join('')
    assert.equal(streamedText, 'abcd')
    // seq stays contiguous across the merge: a=1, bcd=2, done=3
    assert.deepEqual(
        events.map((event) => event.seq),
        [1, 2, 3]
    )
})
