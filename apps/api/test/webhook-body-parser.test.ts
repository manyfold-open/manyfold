import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { NestFactory } from '@nestjs/core'
import {
    FastifyAdapter,
    type NestFastifyApplication
} from '@nestjs/platform-fastify'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { registerChannelFormBodyGuard } from '../src/modules/channels/webhook-body-parser'

@Module({
    providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }]
})
class BodyParserTestModule {}

const buildApp = async (): Promise<NestFastifyApplication> => {
    const app = await NestFactory.create<NestFastifyApplication>(
        BodyParserTestModule,
        new FastifyAdapter({ logger: false }),
        { logger: false }
    )
    const fastify = app.getHttpAdapter().getInstance()
    registerChannelFormBodyGuard(fastify)
    fastify.post('/api/channels/hooks/slack/chn-1', (req, reply) => {
        reply.send({ parsed: req.body })
    })
    fastify.post('/api/other', (req, reply) => {
        reply.send({ parsed: req.body })
    })
    await app.init()
    return app
}

test('Nest starts and parses form bodies on the hooks route', async () => {
    const app = await buildApp()
    const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/channels/hooks/slack/chn-1',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'command=%2Fnew&text=hi&trigger_id=1.2.3'
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
        parsed: { command: '/new', text: 'hi', trigger_id: '1.2.3' }
    })
    await app.close()
})

test('form body on a non-hooks route is rejected with 415', async () => {
    const app = await buildApp()
    const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/other',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'a=1'
    })
    assert.equal(res.statusCode, 415)
    const body = res.json()
    assert.equal(body.error.code, 'bad_request')
    assert.ok(
        body.error.message.includes('application/x-www-form-urlencoded'),
        'response should mention the unsupported content type'
    )
    await app.close()
})

