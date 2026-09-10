import 'reflect-metadata'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { Logger } from '@nestjs/common'
import { WebSocket } from 'ws'
import { DaemonGateway } from '../src/modules/daemon/daemon.gateway'

Logger.overrideLogger(false)

const harness = async (t: TestContext, failure: 'pong' | 'close' | 'early') => {
    const app = Fastify()
    await app.register(websocket)
    const warnings: string[] = []
    const gateway = new DaemonGateway(
        {
            select: () => ({ from: () => ({ where: async () => [] }) })
        } as never,
        { httpAdapter: { getInstance: () => app } } as never,
        {
            verify: async () => {
                if (failure === 'early')
                    await new Promise((resolve) => setTimeout(resolve, 25))
                return {
                    tokenId: 'fixture',
                    userId: 'owner',
                    daemonId: 'daemon'
                }
            }
        } as never,
        {
            findById: async () => ({
                id: 'daemon',
                userId: 'owner',
                status: 'active'
            }),
            touchLastSeen: async () => {}
        } as never,
        {
            register: async () => {},
            unregister: async () => {
                if (failure === 'close')
                    throw new Error('CONNECTION_CLOSED fixture')
            },
            touchConnection: async () => {
                if (failure === 'pong')
                    throw new Error('CONNECTION_CLOSED fixture')
            }
        } as never,
        {} as never
    )
    t.mock.method(
        (gateway as unknown as { log: { warn: (message: string) => void } })
            .log,
        'warn',
        (message: string) => {
            warnings.push(message)
        }
    )
    gateway.onModuleInit()
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const sockets: WebSocket[] = []
    t.after(async () => {
        for (const socket of sockets) socket.terminate()
        await app.close()
    })
    const connect = (early?: string) => {
        const socket = new WebSocket(
            `${address.replace(/^http/, 'ws')}/api/daemon/ws`,
            { headers: { Authorization: 'Bearer fixture' } }
        )
        sockets.push(socket)
        socket.on('error', () => {})
        if (early) socket.once('open', () => socket.send(early))
        const closed = new Promise<number>((resolve) =>
            socket.once('close', resolve)
        )
        const welcome = new Promise<void>((resolve) =>
            socket.once('message', () => resolve())
        )
        return { socket, closed, welcome }
    }
    return { warnings, connect }
}

test(
    'a rejected pong update closes its connection without escaping the handler',
    { timeout: 15000 },
    async (t) => {
        const h = await harness(t, 'pong')
        const first = h.connect()
        await first.welcome
        first.socket.send(JSON.stringify({ type: 'pong' }))
        assert.equal(await first.closed, 1011)
        assert.ok(
            h.warnings.some((message) =>
                message.includes('daemon.ws.frame_failed')
            )
        )
        const next = h.connect()
        await next.welcome
        next.socket.close()
    }
)

test(
    'buffered malformed frames cannot escape the asynchronous handler',
    { timeout: 15000 },
    async (t) => {
        const h = await harness(t, 'early')
        const client = h.connect('null')
        assert.equal(await client.closed, 1011)
        assert.ok(
            h.warnings.some((message) =>
                message.includes('daemon.ws.frame_failed')
            )
        )
    }
)

test(
    'a rejected connection cleanup is observed without an unhandled rejection',
    { timeout: 15000 },
    async (t) => {
        const h = await harness(t, 'close')
        const client = h.connect()
        await client.welcome
        client.socket.close()
        await client.closed
        const deadline = Date.now() + 5000
        while (
            !h.warnings.some((message) =>
                message.includes('daemon.ws.unregister_failed')
            ) &&
            Date.now() < deadline
        )
            await new Promise((resolve) => setTimeout(resolve, 10))
        assert.ok(
            h.warnings.some((message) =>
                message.includes('daemon.ws.unregister_failed')
            )
        )
    }
)
