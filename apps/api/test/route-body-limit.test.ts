import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { applyRouteBodyLimits } from '../src/common/route-body-limit'

// The JSON parser the way Nest registers it: with the server's own 1 MiB limit.
const nestLikeServer = () => {
    const fastify = Fastify()
    fastify.addContentTypeParser(
        'application/json',
        { parseAs: 'string', bodyLimit: fastify.initialConfig.bodyLimit },
        fastify.getDefaultJsonParser('error', 'error')
    )
    return fastify
}

const post = (fastify: ReturnType<typeof Fastify>, url: string, bytes: number) =>
    fastify.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ blob: 'x'.repeat(bytes) })
    })

test('a route that raises its bodyLimit in config accepts the larger body', async (t) => {
    const fastify = nestLikeServer()
    t.after(() => fastify.close())
    applyRouteBodyLimits(fastify)
    fastify.post(
        '/big',
        { config: { bodyLimit: 4 * 1024 * 1024 } },
        async () => ({ ok: true })
    )
    fastify.post('/small', async () => ({ ok: true }))

    const oneAndAHalfMiB = 1.5 * 1024 * 1024
    assert.equal((await post(fastify, '/big', oneAndAHalfMiB)).statusCode, 200)
    assert.equal((await post(fastify, '/small', oneAndAHalfMiB)).statusCode, 413)
})

test('without the hook the config bodyLimit is ignored, which is the bug it fixes', async (t) => {
    const fastify = nestLikeServer()
    t.after(() => fastify.close())
    fastify.post(
        '/big',
        { config: { bodyLimit: 4 * 1024 * 1024 } },
        async () => ({ ok: true })
    )

    assert.equal(
        (await post(fastify, '/big', 1.5 * 1024 * 1024)).statusCode,
        413
    )
})
