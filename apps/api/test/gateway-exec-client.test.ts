import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayExecClient, GatewayExecError } from '../src/modules/k8s/gateway-exec.client'

const fakeConfig = (url: string, token: string) => ({
    get: (key: string) => {
        if (key === 'MF_K8S_GATEWAY_URL') return url
        if (key === 'MF_K8S_GATEWAY_TOKEN') return token
        return undefined
    }
})

const origFetch = globalThis.fetch
const installFetch = (
    impl: (url: string, init: RequestInit) => Promise<Response>
): void => {
    // @ts-expect-error overriding for tests
    globalThis.fetch = impl
}
const restoreFetch = (): void => {
    globalThis.fetch = origFetch
}

test('config: missing env is boot-safe — construction succeeds, isConfigured false', () => {
    const c = new GatewayExecClient(fakeConfig('', '') as never)
    assert.equal(c.isConfigured(), false)
    const partial = new GatewayExecClient(fakeConfig('https://gw/', '') as never)
    assert.equal(partial.isConfigured(), false)
})

test('exec: unconfigured throws typed NOT_CONFIGURED error naming both envs', async () => {
    const c = new GatewayExecClient(fakeConfig('', '') as never)
    await assert.rejects(
        c.exec(
            { namespace: 'ns', pod: 'p', container: 'agent' },
            { cmd: ['true'], timeoutMs: 1_000 }
        ),
        (err: unknown) => {
            assert.ok(err instanceof GatewayExecError)
            assert.equal(err.code, 'NOT_CONFIGURED')
            assert.match(err.message, /MF_K8S_GATEWAY_URL/)
            assert.match(err.message, /MF_K8S_GATEWAY_TOKEN/)
            return true
        }
    )
})

test('exec: success returns exitCode/stdout/stderr; sends bearer + body', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    installFetch(async (url, init) => {
        captured = { url, init }
        return new Response(
            JSON.stringify({
                exitCode: 0,
                stdout: 'ok\n',
                stderr: '',
                durationMs: 50
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        )
    })
    try {
        const c = new GatewayExecClient(
            fakeConfig('https://gw.example/', 'secret-token') as never
        )
        const r = await c.exec(
            { namespace: 'ns', pod: 'p', container: 'agent' },
            { cmd: ['echo', 'ok'], timeoutMs: 5_000 }
        )
        assert.deepEqual(r, { exitCode: 0, stdout: 'ok\n', stderr: '' })
        assert.equal(captured.url, 'https://gw.example/exec')
        const headers = captured.init?.headers as Record<string, string>
        assert.equal(headers.authorization, 'Bearer secret-token')
        const body = JSON.parse(captured.init?.body as string)
        assert.equal(body.namespace, 'ns')
        assert.equal(body.pod, 'p')
        assert.deepEqual(body.cmd, ['echo', 'ok'])
        assert.equal(body.timeoutMs, 5_000)
    } finally {
        restoreFetch()
    }
})

test('exec: 504 TIMEOUT propagates as GatewayExecError with code TIMEOUT', async () => {
    installFetch(
        async () =>
            new Response(
                JSON.stringify({
                    error: 'pod exec timed out after 5000ms',
                    code: 'TIMEOUT'
                }),
                { status: 504 }
            )
    )
    try {
        const c = new GatewayExecClient(
            fakeConfig('https://gw/', 'tok') as never
        )
        await assert.rejects(
            () =>
                c.exec(
                    { namespace: 'ns', pod: 'p', container: 'agent' },
                    { cmd: ['sleep', '60'], timeoutMs: 5_000 }
                ),
            (err: unknown) => {
                assert.ok(err instanceof GatewayExecError)
                assert.equal(err.code, 'TIMEOUT')
                assert.equal(err.httpStatus, 504)
                assert.match(err.message, /pod exec timed out/)
                return true
            }
        )
    } finally {
        restoreFetch()
    }
})

test('exec: 503 retried twice before giving up', async () => {
    let attempts = 0
    installFetch(async () => {
        attempts++
        return new Response('upstream unavailable', { status: 503 })
    })
    try {
        const c = new GatewayExecClient(
            fakeConfig('https://gw/', 'tok') as never
        )
        await assert.rejects(
            () =>
                c.exec(
                    { namespace: 'ns', pod: 'p', container: 'agent' },
                    { cmd: ['x'], timeoutMs: 5_000 }
                )
        )
        assert.equal(attempts, 3, 'should retry on 503 (1 initial + 2 retries)')
    } finally {
        restoreFetch()
    }
})

test('exec: malformed success body rejects with BAD_GATEWAY_RESPONSE', async () => {
    installFetch(async () => new Response('not json', { status: 200 }))
    try {
        const c = new GatewayExecClient(
            fakeConfig('https://gw/', 'tok') as never
        )
        await assert.rejects(
            () =>
                c.exec(
                    { namespace: 'ns', pod: 'p', container: 'agent' },
                    { cmd: ['x'], timeoutMs: 5_000 }
                ),
            (err: unknown) => {
                assert.ok(err instanceof GatewayExecError)
                assert.equal(err.code, 'BAD_GATEWAY_RESPONSE')
                return true
            }
        )
    } finally {
        restoreFetch()
    }
})
