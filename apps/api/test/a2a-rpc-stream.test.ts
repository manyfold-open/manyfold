import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { A2aRpcController } from '../src/modules/a2a/a2a-rpc.controller'
import type { A2aStreamEmit } from '../src/modules/a2a/a2a.service'

test('closing an A2A SSE response aborts the subscription and removes transport listeners', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
        entered = resolve
    })
    let signal!: AbortSignal
    let emit!: A2aStreamEmit
    const frames: string[] = []
    const raw = Object.assign(new EventEmitter(), {
        writableLength: 0,
        destroyed: false,
        writeHead: () => {},
        write: (frame: string) => {
            frames.push(frame)
            return true
        },
        end: () => {}
    })
    const controller = new A2aRpcController(
        {
            getExposure: async () => ({ enabled: true }),
            resubscribe: async (
                _ctx: unknown,
                _id: string,
                onEvent: A2aStreamEmit,
                stopped: AbortSignal
            ) => {
                signal = stopped
                emit = onEvent
                entered()
                await new Promise<void>((resolve) =>
                    stopped.addEventListener('abort', () => resolve(), {
                        once: true
                    })
                )
            }
        } as never,
        {
            verifyBearerToken: async () => ({
                kind: 'legacy-runtime',
                userId: 'u',
                agentId: 'target',
                tokenId: 'external',
                scopes: ['a2a:edit']
            })
        } as never,
        { assertAndIncrement: async () => {} } as never,
        { consume: () => {} } as never,
        { isActiveExternalA2aGrant: async () => true } as never,
        { isA2aTicket: () => false } as never
    )
    const response = controller.rpc(
        'target',
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'tasks/resubscribe',
            params: { id: 'task' }
        },
        { headers: { authorization: 'Bearer nca_external' } } as never,
        { raw, hijack: () => {} } as never
    )
    await started
    raw.emit('close')
    await response
    assert.equal(signal.aborted, true)
    assert.equal(raw.listenerCount('close'), 0)
    emit({
        kind: 'status-update',
        taskId: 'task',
        contextId: 'c',
        status: { state: 'working' },
        final: false
    })
    assert.deepEqual(frames, [])
})

// A message/stream handed over at the blocking cap: the service emits a
// non-final `working` and returns, and that has to end the response cleanly
// (no error frame, no listener left behind) while the turn runs on.
test('a message/stream handed over at the blocking cap ends the response after its non-final frame', async () => {
    const frames: string[] = []
    let ended = 0
    const raw = Object.assign(new EventEmitter(), {
        writableLength: 0,
        destroyed: false,
        writeHead: () => {},
        write: (frame: string) => {
            frames.push(frame)
            return true
        },
        end: () => {
            ended++
        }
    })
    const controller = new A2aRpcController(
        {
            getExposure: async () => ({ enabled: true }),
            sendMessage: async (
                _ctx: unknown,
                _params: unknown,
                onEvent: A2aStreamEmit
            ) => {
                onEvent({
                    kind: 'status-update',
                    taskId: 'task',
                    contextId: 'c',
                    status: { state: 'working' },
                    final: false
                })
                return { kind: 'task', id: 'task', status: { state: 'working' } }
            }
        } as never,
        {
            verifyBearerToken: async () => ({
                kind: 'legacy-runtime',
                userId: 'u',
                agentId: 'target',
                tokenId: 'external',
                scopes: ['a2a:edit']
            })
        } as never,
        { assertAndIncrement: async () => {} } as never,
        { consume: () => {} } as never,
        { isActiveExternalA2aGrant: async () => true } as never,
        { isA2aTicket: () => false } as never
    )
    await controller.rpc(
        'target',
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'message/stream',
            params: {
                message: {
                    kind: 'message',
                    role: 'user',
                    messageId: 'm',
                    parts: [{ kind: 'text', text: 'work' }]
                }
            }
        },
        { headers: { authorization: 'Bearer nca_external' } } as never,
        { raw, hijack: () => {} } as never
    )
    assert.equal(frames.length, 1)
    const frame = JSON.parse(frames[0].replace(/^data: /, '')) as {
        result: { final: boolean; status: { state: string } }
        error?: unknown
    }
    assert.equal(frame.error, undefined)
    assert.equal(frame.result.final, false)
    assert.equal(frame.result.status.state, 'working')
    assert.equal(ended, 1)
    assert.equal(raw.listenerCount('close'), 0)
})
