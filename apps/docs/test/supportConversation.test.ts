import test from 'node:test'
import assert from 'node:assert/strict'
import type * as conversation from '../src/lib/support/conversation'
import type { HistoryItem } from '../src/lib/support/difyClient'

// conversation.ts keeps the transcript in module state and wires itself to the
// page lifecycle at import time, so a "realm" here is one fresh import over one
// fresh set of browser globals. A back/forward cache restore reuses a realm; a
// full navigation builds a new one over the storage the old one left behind —
// which is exactly the difference these tests are about (#562).

type Conversation = typeof conversation

const MODULE_PATH = '../src/lib/support/conversation.ts'

const CONTEXT = {
    page_url: 'https://docs.manyfold.ai/docs/getting-started/',
    page_title: 'Getting started',
    page_locale: 'en'
}

const QUESTION = 'how do I install the CLI?'

const globals = globalThis as unknown as Record<string, unknown>
const realDateNow = Date.now
const realFetch = globals.fetch

// Everything the module awaits resolves on microtasks; a few real macrotask
// hops therefore drain it completely without touching the fake clock the
// settle loop runs on.
const drain = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1)
        await new Promise((resolve) => {
            setTimeout(resolve, 0)
        })
}

const createStorage = (seed: Map<string, string> = new Map()) => {
    const entries = new Map(seed)
    return {
        entries,
        getItem: (key: string): string | null => entries.get(key) ?? null,
        setItem: (key: string, value: string): void => {
            entries.set(key, value)
        },
        removeItem: (key: string): void => {
            entries.delete(key)
        }
    }
}

type Storage = ReturnType<typeof createStorage>

const createClock = () => {
    let now = 1_700_000_000_000
    let timers: { at: number; run: () => void }[] = []
    return {
        now: (): number => now,
        schedule: (run: () => void, delay: number): number => {
            timers.push({ at: now + delay, run })
            return timers.length
        },
        advance: async (ms: number): Promise<void> => {
            const target = now + ms
            for (;;) {
                const due = timers
                    .filter((timer) => timer.at <= target)
                    .sort((left, right) => left.at - right.at)[0]
                if (!due) break
                timers = timers.filter((timer) => timer !== due)
                now = due.at
                due.run()
                await drain()
            }
            now = target
            await drain()
        }
    }
}

const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body)
})

const failedRequest = (status: number) => () => ({
    ok: false,
    status,
    statusText: 'Server Error',
    json: () => Promise.resolve({ code: 'internal', message: 'boom' })
})

const encoder = new TextEncoder()

const frame = (event: Record<string, unknown>): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

// A stream the test drives: frames land when it pushes them, and the tab freeze
// is modelled by erroring the body the way an aborted fetch does.
const openStream = () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
            source = controller
        }
    })
    return {
        respond: () => ({ ok: true, status: 200, statusText: 'OK', body }),
        push: (event: Record<string, unknown>): void => {
            source.enqueue(frame(event))
        },
        finish: (): void => {
            source.close()
        },
        tearDown: (): void => {
            source.error(new Error('net::ERR_ABORTED'))
        }
    }
}

const completedStream = (answer: string) => () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
        start: (source) => {
            source.enqueue(
                frame({
                    event: 'message',
                    conversation_id: 'conv-1',
                    task_id: 'task-1',
                    answer
                })
            )
            source.enqueue(frame({ event: 'message_end', message_id: 'msg-1' }))
            source.close()
        }
    })
})

const historyItem = (answer: string): HistoryItem => ({
    id: 'msg-1',
    query: QUESTION,
    answer,
    retriever_resources: [],
    feedback: null,
    error: null
})

type Realm = {
    chat: Conversation
    clock: ReturnType<typeof createClock>
    local: Storage
    session: Storage
    history: HistoryItem[]
    setHistory: (items: HistoryItem[]) => void
    onChat: (respond: () => unknown) => void
    emit: (type: 'pagehide' | 'pageshow', persisted: boolean) => void
}

let realmSeed = 0

const enterRealm = async (carriedOver?: {
    local: Storage
    session: Storage
}): Promise<Realm> => {
    const clock = createClock()
    const local = createStorage(carriedOver?.local.entries)
    const session = createStorage(carriedOver?.session.entries)
    const listeners = new Map<string, (() => void)[]>()
    const state = {
        history: [] as HistoryItem[],
        chat: failedRequest(500) as () => unknown
    }

    globals.window = {
        addEventListener: (type: string, listener: () => void): void => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener])
        },
        setTimeout: (run: () => void, delay: number): number =>
            clock.schedule(run, delay)
    }
    globals.localStorage = local
    globals.sessionStorage = session
    globals.fetch = (url: string): Promise<unknown> => {
        if (url.includes('/api/passport'))
            return Promise.resolve(okJson({ access_token: 'passport-1' }))
        if (url.includes('/api/messages'))
            return Promise.resolve(okJson({ data: state.history }))
        if (url.includes('/api/chat-messages'))
            return Promise.resolve(state.chat())
        throw new Error(`unrouted request: ${url}`)
    }
    Date.now = clock.now

    realmSeed += 1
    const chat = (await import(
        `${MODULE_PATH}?realm=${realmSeed}`
    )) as Conversation

    return {
        chat,
        clock,
        local,
        session,
        get history() {
            return state.history
        },
        setHistory: (items) => {
            state.history = items
        },
        onChat: (respond) => {
            state.chat = respond
        },
        emit: (type, persisted) => {
            const event = { persisted } as unknown as Event
            listeners
                .get(type)
                ?.forEach((listener) => (listener as (e: Event) => void)(event))
        }
    }
}

const leaveRealms = (): void => {
    Date.now = realDateNow
    globals.fetch = realFetch
    delete globals.window
    delete globals.localStorage
    delete globals.sessionStorage
}

const lastMessage = (chat: Conversation) => {
    const { messages } = chat.getState()
    return messages[messages.length - 1]
}

// Drives a realm up to the moment a freeze interrupts a turn: the workflow has
// started (so a conversation id exists) but no answer text has arrived yet.
const interruptTurnWithFreeze = async (realm: Realm): Promise<void> => {
    await realm.chat.init()
    const stream = openStream()
    realm.onChat(() => stream.respond())
    const sending = realm.chat.send(QUESTION, CONTEXT)
    await drain()
    stream.push({
        event: 'workflow_started',
        conversation_id: 'conv-1',
        task_id: 'task-1'
    })
    await drain()
    realm.emit('pagehide', true)
    stream.tearDown()
    await sending
}

test('a stream failure after a back/forward cache round trip is visible and retryable', async (t) => {
    t.after(leaveRealms)
    const realm = await enterRealm()
    await realm.chat.init()

    realm.emit('pagehide', true)
    realm.emit('pageshow', true)

    realm.onChat(failedRequest(500))
    await realm.chat.send(QUESTION, CONTEXT)

    const failed = realm.chat.getState()
    assert.equal(failed.streaming, false)
    assert.equal(failed.error, 'generic')
    assert.equal(failed.announcement, 'error')
    assert.equal(lastMessage(realm.chat).streaming, false)
    assert.equal(lastMessage(realm.chat).failed, true)

    // Retry is only reachable if the send gate reopened, so this asserts the
    // recovered state as much as the error strip does.
    realm.onChat(completedStream('Run `mf login`.'))
    await realm.chat.retry(CONTEXT)

    const retried = realm.chat.getState()
    assert.equal(retried.error, null)
    assert.equal(retried.streaming, false)
    assert.equal(retried.announcement, 'ready')
    assert.equal(retried.messages.length, 2)
    assert.equal(lastMessage(realm.chat).text, 'Run `mf login`.')
    assert.equal(lastMessage(realm.chat).streaming, false)
})

test('a turn interrupted by the freeze settles from history after the restore', async (t) => {
    t.after(leaveRealms)
    const realm = await enterRealm()
    await interruptTurnWithFreeze(realm)

    // Frozen: the teardown was swallowed as an unload, so the turn is still
    // marked in flight and the pending marker is still armed.
    assert.equal(realm.chat.getState().streaming, true)
    assert.equal(lastMessage(realm.chat).streaming, true)
    assert.equal(realm.session.getItem('mf-support-pending'), '1')

    realm.emit('pageshow', true)

    const restored = realm.chat.getState()
    assert.equal(restored.streaming, false)
    assert.equal(restored.announcement, 'answering')
    assert.equal(lastMessage(realm.chat).streaming, true)

    realm.setHistory([historyItem('')])
    await realm.clock.advance(2000)
    assert.equal(lastMessage(realm.chat).text, '')
    assert.equal(lastMessage(realm.chat).streaming, true)

    realm.setHistory([historyItem('Run `mf login`.')])
    await realm.clock.advance(2000)

    const settled = realm.chat.getState()
    assert.equal(settled.streaming, false)
    assert.equal(settled.announcement, 'ready')
    assert.equal(settled.messages.length, 2)
    assert.equal(lastMessage(realm.chat).text, 'Run `mf login`.')
    assert.equal(lastMessage(realm.chat).streaming, false)
})

test('restore discards a stream frame queued while the page was frozen', async (t) => {
    t.after(leaveRealms)
    const realm = await enterRealm()
    await realm.chat.init()
    const stream = openStream()
    realm.onChat(() => stream.respond())
    const sending = realm.chat.send(QUESTION, CONTEXT)
    await drain()
    stream.push({
        event: 'workflow_started',
        conversation_id: 'conv-1',
        task_id: 'task-1'
    })
    await drain()

    realm.emit('pagehide', true)
    // The read promise is now fulfilled, but its continuation cannot run until
    // after the frozen page resumes. pageshow must make history recovery the
    // sole state owner even though this stale frame was already queued.
    stream.push({ event: 'message', answer: 'stale partial' })
    realm.emit('pageshow', true)
    await sending

    const restored = realm.chat.getState()
    assert.equal(restored.announcement, 'answering')
    assert.equal(lastMessage(realm.chat).text, '')
    assert.equal(lastMessage(realm.chat).streaming, true)

    realm.setHistory([historyItem('Run `mf login`.')])
    await realm.clock.advance(2000)
    assert.equal(lastMessage(realm.chat).text, 'Run `mf login`.')
    assert.equal(lastMessage(realm.chat).streaming, false)
})

test('restore keeps ownership when the old stream closes while frozen', async (t) => {
    t.after(leaveRealms)
    const realm = await enterRealm()
    await realm.chat.init()
    const stream = openStream()
    realm.onChat(() => stream.respond())
    const sending = realm.chat.send(QUESTION, CONTEXT)
    await drain()
    stream.push({
        event: 'workflow_started',
        conversation_id: 'conv-1',
        task_id: 'task-1'
    })
    await drain()

    realm.emit('pagehide', true)
    // Closing fulfills the pending read, but its completion is still queued
    // until the page resumes. An aborted stream must not report normal success
    // over the recovery that pageshow has just started.
    stream.finish()
    realm.emit('pageshow', true)
    await sending

    assert.equal(realm.chat.getState().announcement, 'answering')
    assert.equal(lastMessage(realm.chat).streaming, true)

    realm.setHistory([historyItem('Run `mf login`.')])
    await realm.clock.advance(2000)
    assert.equal(lastMessage(realm.chat).text, 'Run `mf login`.')
    assert.equal(lastMessage(realm.chat).streaming, false)
})

test('a turn that never lands leaves thinking at the settle limit rather than sticking', async (t) => {
    t.after(leaveRealms)
    const realm = await enterRealm()
    await interruptTurnWithFreeze(realm)

    realm.emit('pageshow', true)
    realm.setHistory([historyItem('')])

    await realm.clock.advance(44000)
    assert.equal(lastMessage(realm.chat).streaming, true)

    await realm.clock.advance(2000)
    assert.equal(realm.chat.getState().streaming, false)
    assert.equal(lastMessage(realm.chat).streaming, false)

    // Still usable: the panel takes a new question instead of needing a reload.
    realm.onChat(completedStream('Run `mf login`.'))
    await realm.chat.send('anything else?', CONTEXT)
    assert.equal(lastMessage(realm.chat).text, 'Run `mf login`.')
    assert.equal(realm.chat.getState().streaming, false)
})

test('a turn frozen before Dify names the conversation fails visibly instead of hanging', async (t) => {
    t.after(leaveRealms)
    const realm = await enterRealm()
    await realm.chat.init()
    const stream = openStream()
    realm.onChat(() => stream.respond())
    const sending = realm.chat.send(QUESTION, CONTEXT)
    await drain()
    // No frame arrived, so there is no conversation to poll: history cannot
    // reach this turn and pretending otherwise would just stall for 45s.
    realm.emit('pagehide', true)
    stream.tearDown()
    await sending

    realm.emit('pageshow', true)

    const failed = realm.chat.getState()
    assert.equal(failed.streaming, false)
    assert.equal(failed.error, 'generic')
    assert.equal(lastMessage(realm.chat).streaming, false)
    assert.equal(lastMessage(realm.chat).failed, true)
    assert.equal(realm.session.getItem('mf-support-pending'), null)

    // No settle loop was armed, so waiting past the limit changes nothing.
    await realm.clock.advance(50000)
    assert.equal(realm.chat.getState().error, 'generic')
    assert.equal(lastMessage(realm.chat).streaming, false)
})

test('a turn interrupted by a full navigation still recovers on the next load', async (t) => {
    t.after(leaveRealms)
    const leaving = await enterRealm()
    await leaving.chat.init()
    const stream = openStream()
    leaving.onChat(() => stream.respond())
    const sending = leaving.chat.send(QUESTION, CONTEXT)
    await drain()
    stream.push({
        event: 'workflow_started',
        conversation_id: 'conv-1',
        task_id: 'task-1'
    })
    await drain()
    leaving.emit('pagehide', false)
    stream.tearDown()
    await sending

    // The turn is still running server-side, so the unload must not paint it as
    // a failure and must leave the marker for the next document to pick up.
    assert.equal(leaving.chat.getState().error, null)
    assert.equal(leaving.session.getItem('mf-support-pending'), '1')
    assert.equal(leaving.local.getItem('mf-support-conversation'), 'conv-1')

    const arriving = await enterRealm(leaving)
    arriving.setHistory([historyItem('')])
    await arriving.chat.init()

    assert.equal(arriving.chat.getState().announcement, 'answering')
    assert.equal(lastMessage(arriving.chat).streaming, true)

    arriving.setHistory([historyItem('Run `mf login`.')])
    await arriving.clock.advance(2000)

    const settled = arriving.chat.getState()
    assert.equal(settled.announcement, 'ready')
    assert.equal(settled.streaming, false)
    assert.equal(lastMessage(arriving.chat).text, 'Run `mf login`.')
    assert.equal(lastMessage(arriving.chat).streaming, false)
})