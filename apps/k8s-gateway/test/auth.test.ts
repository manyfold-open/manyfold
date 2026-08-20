import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { makeBearerAuth } from '../src/auth'

const setup = async (tokens: string[]) => {
    const app = Fastify()
    const auth = makeBearerAuth(new Set(tokens))
    app.addHook('preHandler', async (req, reply) => {
        if (req.url === '/healthz') return
        await auth(req, reply)
    })
    app.get('/healthz', async () => ({ ok: true }))
    app.get('/protected', async () => ({ secret: 42 }))
    await app.ready()
    return app
}

test('healthz is public', async () => {
    const app = await setup(['t1'])
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(res.statusCode, 200)
    await app.close()
})

test('missing token → 401', async () => {
    const app = await setup(['t1'])
    const res = await app.inject({ method: 'GET', url: '/protected' })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().code, 'UNAUTHORIZED')
    await app.close()
})

test('wrong token → 401', async () => {
    const app = await setup(['t1'])
    const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer bogus' }
    })
    assert.equal(res.statusCode, 401)
    await app.close()
})

test('valid token → 200', async () => {
    const app = await setup(['t1', 't2'])
    const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer t2' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().secret, 42)
    await app.close()
})

test('multiple tokens supported for rotation', async () => {
    const app = await setup(['old', 'new'])
    for (const token of ['old', 'new']) {
        const res = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: { authorization: `Bearer ${token}` }
        })
        assert.equal(res.statusCode, 200, `token=${token}`)
    }
    await app.close()
})
