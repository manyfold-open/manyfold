import assert from 'node:assert/strict'
import test from 'node:test'
import type { A2aStreamEvent, MessageSendParams } from '@manyfold/a2a'
import type { A2aTask } from '@manyfold/db'
import type { ChatStreamEvent } from '@manyfold/shared'
import { A2aService, type A2aAuthContext } from '../src/modules/a2a/a2a.service'
import type { BroadcastSubscriber } from '../src/modules/chat/sse-broadcaster'

const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
const ctx: A2aAuthContext = {
    userId: 'u',
    targetAgentId: 'target',
    callerAgentId: 'caller',
    externalSubject: null
}
const params = (messageId = 'm'): MessageSendParams => ({
    message: {
        kind: 'message',
        role: 'user',
        messageId,
        parts: [{ kind: 'text', text: 'work' }]
    }
})

const harness = () => {
    const rows = new Map<string, A2aTask>()
    const entered = deferred()
    const dispatch = deferred()
    const attached = deferred()
    let observer!: (event: unknown) => void
    let sessions = 0
    let turns = 0
    let cancels = 0
    let subscriber: BroadcastSubscriber | undefined
    let unsubscribed = 0
    const subscribed = deferred()
    let cancelGate: ReturnType<typeof deferred> | undefined
    const cancelEntered = deferred()
    const db = { insert: () => ({ values: async () => {} }) }
    const tasks = {
        withUserLock: async (
            _user: string,
            run: (tasks: unknown, db: unknown) => Promise<unknown>
        ) => run(tasks, db),
        create: async (input: object) => {
            const row = {
                ...input,
                state: 'submitted',
                createdAt: new Date(),
                updatedAt: new Date(),
                completedAt: null,
                artifactJson: null,
                errorJson: null,
                usageJson: null,
                assistantMessageId: null,
                userMessageId: null
            } as A2aTask
            rows.set(row.id, row)
            return { ...row }
        },
        findById: async (id: string) =>
            rows.has(id) ? { ...rows.get(id)! } : null,
        findByClientMessage: async (_scope: unknown, id: string) => {
            const row = [...rows.values()].find(
                (row) => row.clientMessageId === id
            )
            return row ? { ...row } : null
        },
        countInflightForUser: async () => 0,
        update: async (id: string, patch: object) => {
            Object.assign(rows.get(id)!, patch)
            attached.resolve()
        },
        updateIfActive: async (id: string, patch: Partial<A2aTask>) => {
            if (patch.state === 'canceled' && cancelGate) {
                cancelEntered.resolve()
                await cancelGate.promise
            }
            const row = rows.get(id)!
            if (row.state !== 'submitted' && row.state !== 'working')
                return false
            Object.assign(row, patch)
            return true
        }
    }
    const chat = {
        createSession: async () => ({ id: `session-${++sessions}` }),
        announceSessionCreated: () => {},
        sendMessage: async (...args: unknown[]) => {
            turns++
            observer = args[13] as typeof observer
            entered.resolve()
            await dispatch.promise
            return {
                userMessage: { id: 'user-message' },
                assistantMessageId: 'assistant'
            }
        },
        cancelMessage: async () => {
            cancels++
            observer({
                type: 'error',
                error: { code: 'cancelled_by_user', message: 'cancelled' }
            })
        },
        terminalizeDeadInflightMessage: async () => {}
    }
    const broadcaster = {
        subscribe: async (
            _session: string,
            sub: BroadcastSubscriber,
            _last: unknown,
            messageId: string
        ) => {
            assert.equal(messageId, 'assistant')
            subscriber = sub
            subscribed.resolve()
            return () => {
                unsubscribed++
                subscriber = undefined
            }
        }
    }
    const service = new A2aService(
        db as never,
        chat as never,
        tasks as never,
        undefined,
        undefined,
        undefined,
        broadcaster as never
    )
    return {
        service,
        rows,
        entered,
        dispatch,
        attached,
        subscribed,
        cancelEntered,
        counts: () => ({ sessions, turns, cancels, unsubscribed }),
        holdCancel: () => {
            cancelGate = deferred()
            return cancelGate
        },
        finish: () => {
            observer({ type: 'token', text: 'answer' })
            observer({ type: 'done' })
        },
        stream: (event: object) => subscriber?.send(event as ChatStreamEvent),
        row: () => [...rows.values()][0]
    }
}

test('retrying the first message reuses the task and session without a second turn', async () => {
    const h = harness()
    const first = h.service.sendMessage(ctx, params())
    await h.entered.promise
    const retry = await h.service.sendMessage(ctx, params())
    assert.equal(retry.id, h.row().id)
    assert.equal(h.counts().sessions, 1)
    assert.equal(h.counts().turns, 1)
    h.dispatch.resolve()
    h.finish()
    assert.equal((await first).id, retry.id)
    const events: A2aStreamEvent[] = []
    await h.service.sendMessage(ctx, params(), (event) => events.push(event))
    assert.equal(events.at(-1)?.kind, 'status-update')
    assert.equal(h.counts().turns, 1)
})

test('cancel before the assistant ID is attached aborts after startup and returns canceled', async () => {
    const h = harness()
    const sending = h.service.sendMessage(ctx, params())
    await h.entered.promise
    const canceled = await h.service.cancelTask(ctx, h.row().id)
    assert.equal(canceled.status.state, 'canceled')
    h.dispatch.resolve()
    assert.equal((await sending).status.state, 'canceled')
    assert.equal(h.counts().cancels, 1)
})

test('cancel re-reads an ID attached after its original read', async () => {
    const h = harness()
    const sending = h.service.sendMessage(ctx, params())
    await h.entered.promise
    const gate = h.holdCancel()
    const canceling = h.service.cancelTask(ctx, h.row().id)
    await h.cancelEntered.promise
    h.dispatch.resolve()
    await h.attached.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    gate.resolve()
    assert.equal((await canceling).status.state, 'canceled')
    assert.equal((await sending).status.state, 'canceled')
    assert.equal(h.counts().cancels, 1)
})

test('resubscribe stays open, filters other turns, relays replacements and ends at the durable terminal', async () => {
    const h = harness()
    const sending = h.service.sendMessage(ctx, params())
    await h.entered.promise
    h.dispatch.resolve()
    await h.attached.promise
    const events: A2aStreamEvent[] = []
    let ended = false
    const streaming = h.service
        .resubscribe(ctx, h.row().id, (event) => events.push(event))
        .then(() => {
            ended = true
        })
    await h.subscribed.promise
    assert.equal(ended, false)
    h.stream({ type: 'token', messageId: 'unrelated', text: 'secret' })
    h.stream({ type: 'token', messageId: 'assistant', text: 'draft' })
    h.stream({ type: 'replace', messageId: 'assistant', text: 'answer' })
    h.finish()
    await sending
    await streaming
    const artifacts = events.filter((event) => event.kind === 'artifact-update')
    assert.deepEqual(
        artifacts.map((event) => [event.artifact.parts, event.append]),
        [
            [[{ kind: 'text', text: '' }], false],
            [[{ kind: 'text', text: 'draft' }], true],
            [[{ kind: 'text', text: 'answer' }], false],
            [[{ kind: 'text', text: 'answer' }], false]
        ]
    )
    assert.equal(events.at(-1)?.kind, 'status-update')
    const terminal = events.at(-1) as {
        final: boolean
        status: { state: string }
    }
    assert.equal(terminal.final, true)
    assert.equal(terminal.status.state, 'completed')
    assert.ok(h.counts().unsubscribed > 0)
})

test('disconnecting resubscribe releases its subscription without canceling the turn', async () => {
    const h = harness()
    const sending = h.service.sendMessage(ctx, params())
    await h.entered.promise
    h.dispatch.resolve()
    await h.attached.promise
    const controller = new AbortController()
    const events: A2aStreamEvent[] = []
    const streaming = h.service.resubscribe(
        ctx,
        h.row().id,
        (event) => events.push(event),
        controller.signal
    )
    await h.subscribed.promise
    controller.abort()
    await streaming
    assert.ok(h.counts().unsubscribed > 0)
    assert.equal(h.counts().cancels, 0)
    assert.equal(
        events.some((event) => event.kind === 'status-update' && event.final),
        false
    )
    h.finish()
    await sending
})
