import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { Logger } from '@nestjs/common'
import { WebSocket } from 'ws'
import { DaemonGateway } from '../src/modules/daemon/daemon.gateway'

Logger.overrideLogger(false)

test('daemon websocket requires bearer headers and never verifies query credentials', async (t) => {
    const fastify = Fastify()
    await fastify.register(websocket)
    const verified: string[] = []
    const registered: string[] = []
    let cliVersion: string | null = '0.34.0'
    const gateway = new DaemonGateway(
        {
            select: () => ({ from: () => ({ where: async () => [] }) })
        } as never,
        { httpAdapter: { getInstance: () => fastify } } as never,
        {
            verify: async (token: string) => {
                verified.push(token)
                if (token !== 'fixture-header' && token !== 'fixture-query')
                    throw new Error('unauthorized')
                return {
                    tokenId: 'ldt_test',
                    userId: 'u_test',
                    daemonId: 'dh_test'
                }
            }
        } as never,
        {
            findById: async () => ({
                id: 'dh_test',
                cliVersion,
                userId: 'u_test',
                status: 'online'
            }),
            touchLastSeen: async () => {}
        } as never,
        {
            register: async (host: { daemonId: string }) => {
                registered.push(host.daemonId)
            },
            unregister: async () => {}
        } as never,
        {} as never
    )
    gateway.onModuleInit()
    const address = await fastify.listen({ port: 0, host: '127.0.0.1' })
    const clients: WebSocket[] = []
    t.after(async () => {
        for (const client of clients) client.terminate()
        await fastify.close()
    })
    const connect = (
        query: string,
        authorization?: string
    ): Promise<string | number> =>
        new Promise((resolve, reject) => {
            const client = new WebSocket(
                `${address.replace(/^http/, 'ws')}/api/daemon/ws${query}`,
                {
                    headers:
                        authorization === undefined
                            ? {}
                            : { Authorization: authorization }
                }
            )
            clients.push(client)
            client.once('error', reject)
            client.once('message', (data) => {
                resolve(JSON.parse(String(data)).type)
                client.close()
            })
            client.once('close', (code) => resolve(code))
        })

    assert.equal(await connect('', 'Bearer fixture-header'), 'welcome')
    assert.equal(await connect('?token=fixture-query'), 4400)
    assert.equal(await connect('?to%6ben=fixture-query'), 4400)
    assert.equal(await connect('?token=fixture-query&token=fixture-header'), 4400)
    assert.equal(
        await connect('?token=fixture-query', 'Bearer fixture-header'),
        'welcome'
    )
    assert.deepEqual(verified, ['fixture-header', 'fixture-header'])
    assert.equal(await connect('?token=fixture-query', 'Bearer invalid'), 4401)
    assert.equal(await connect('?token=fixture-query', 'Basic invalid'), 4400)
    assert.equal(await connect(''), 4400)
    assert.equal(await connect('?token=a&token=b'), 4400)
    assert.equal(registered.length, 2)
    assert.deepEqual(verified, [
        'fixture-header',
        'fixture-header',
        'invalid'
    ])
    for (const version of ['0.33.9', null, 'unknown']) {
        cliVersion = version
        assert.equal(await connect('', 'Bearer fixture-header'), 4406)
    }
    assert.equal(registered.length, 2, 'unsupported hosts never register an RPC connection')
})
