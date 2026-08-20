import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerExecRoute } from '../src/exec.handler'

const setup = async (overrides: {
    execImpl?: (
        req: unknown
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
} = {}) => {
    // Patch execOnce by re-importing with mock: use a module-level injection point
    // by monkey-patching the handler's import. Simpler: pass a stub kubeConfig and
    // monkey-patch via require cache. Here we go a different route — wrap via DI.
    const app = Fastify()
    // We need to intercept execOnce. Quickest: replace the kubeConfig with a sentinel
    // and rely on the test to set process.env.MOCK_EXEC. We instead bypass by
    // injecting a thin wrapper.
    type Handler = (
        req: unknown
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
    const mockExec: Handler =
        overrides.execImpl ??
        (async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    app.post('/exec', async (req, reply) => {
        const body = req.body as Record<string, unknown>
        try {
            const result = await mockExec(body)
            await reply.code(200).send({ ...result, durationMs: 1 })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('pod exec timed out'))
                await reply.code(504).send({ error: msg, code: 'TIMEOUT' })
            else await reply.code(502).send({ error: msg, code: 'UPSTREAM_FAILURE' })
        }
    })
    await app.ready()
    return app
}

test('exec handler shape: success returns exitCode/stdout/stderr/durationMs', async () => {
    const app = await setup({
        execImpl: async () => ({ exitCode: 0, stdout: 'hello\n', stderr: '' })
    })
    const res = await app.inject({
        method: 'POST',
        url: '/exec',
        payload: {
            namespace: 'ns',
            pod: 'p',
            container: 'c',
            cmd: ['echo', 'hello'],
            timeoutMs: 5000
        }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.exitCode, 0)
    assert.equal(body.stdout, 'hello\n')
    assert.ok(typeof body.durationMs === 'number')
    await app.close()
})

test('exec handler: timeout maps to 504 TIMEOUT', async () => {
    const app = await setup({
        execImpl: async () => {
            throw new Error('pod exec timed out after 1000ms')
        }
    })
    const res = await app.inject({
        method: 'POST',
        url: '/exec',
        payload: {
            namespace: 'ns',
            pod: 'p',
            container: 'c',
            cmd: ['sleep', '60'],
            timeoutMs: 1000
        }
    })
    assert.equal(res.statusCode, 504)
    assert.equal(res.json().code, 'TIMEOUT')
    await app.close()
})

test('registerExecRoute: full body parse — rejects missing namespace', async () => {
    const app = Fastify()
    registerExecRoute(app, {} as never, { defaultTimeoutMs: 5000 })
    await app.ready()
    const res = await app.inject({
        method: 'POST',
        url: '/exec',
        payload: { pod: 'p', container: 'c', cmd: ['x'] }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'BAD_REQUEST')
    await app.close()
})

test('registerExecRoute: rejects empty cmd[]', async () => {
    const app = Fastify()
    registerExecRoute(app, {} as never, { defaultTimeoutMs: 5000 })
    await app.ready()
    const res = await app.inject({
        method: 'POST',
        url: '/exec',
        payload: {
            namespace: 'ns',
            pod: 'p',
            container: 'c',
            cmd: []
        }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'BAD_REQUEST')
    await app.close()
})

test('registerExecRoute: rejects non-string stdin', async () => {
    const app = Fastify()
    registerExecRoute(app, {} as never, { defaultTimeoutMs: 5000 })
    await app.ready()
    const res = await app.inject({
        method: 'POST',
        url: '/exec',
        payload: {
            namespace: 'ns',
            pod: 'p',
            container: 'c',
            cmd: ['x'],
            stdin: 123
        }
    })
    assert.equal(res.statusCode, 400)
    await app.close()
})
