import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AgentSetupController,
    requestApiUrl
} from '../src/modules/config/agent-setup.controller'

interface Served {
    headers: Record<string, string>
    body: string
}

const serve = async (
    env: Record<string, string>,
    request: { host?: string; proto?: string; protocol?: 'http' | 'https' }
): Promise<Served> => {
    const controller = new AgentSetupController({
        get: (key: string) => env[key]
    } as never)
    const served: Served = { headers: {}, body: '' }
    const reply = {
        header(name: string, value: string) {
            served.headers[name] = value
            return reply
        },
        send(body: string) {
            served.body = body
            return reply
        }
    }
    await controller.guide(
        {
            headers: {
                host: request.host,
                'x-forwarded-proto': request.proto
            },
            protocol: request.protocol ?? 'http'
        } as never,
        reply as never
    )
    return served
}

test('agent-setup.md is served as uncached markdown', async () => {
    const { headers } = await serve(
        { PUBLIC_API_BASE_URL: 'https://api.example.com' },
        { host: 'api.example.com', proto: 'https' }
    )
    assert.equal(headers['content-type'], 'text/markdown; charset=utf-8')
    assert.equal(headers['cache-control'], 'no-store')
    assert.equal(headers['x-content-type-options'], 'nosniff')
})

// Behind a reverse proxy the Host header is often the upstream's own address,
// which a remote agent cannot reach; the configured public URL is the truth.
test('the configured public API URL wins over the request Host', async () => {
    const { body } = await serve(
        {
            PUBLIC_API_BASE_URL: 'https://api.example.com',
            MF_WEB_URL: 'https://app.example.com'
        },
        { host: '127.0.0.1:2222' }
    )
    assert.match(body, /--api-url 'https:\/\/api\.example\.com\/api'/)
    assert.doesNotMatch(body, /--api-url 'http:\/\/127\.0\.0\.1/)
    assert.match(
        body,
        /You fetched this guide through `http:\/\/127\.0\.0\.1:2222\/api`/
    )
    assert.match(body, /- Web app: `https:\/\/app\.example\.com`/)
})

test('without a configured URL the request address is used once validated', async () => {
    const { body } = await serve({}, { host: 'mf.example.org:2222' })
    assert.match(body, /--api-url 'http:\/\/mf\.example\.org:2222\/api'/)
    assert.match(body, /- Web app: not published by this deployment/)
})

test('a Host header that is not a bare host:port yields no API URL', async () => {
    for (const host of [
        'localhost:2222@evil.example',
        'evil.example/path',
        'evil.example extra',
        "evil.example'",
        ''
    ])
        assert.equal(requestApiUrl(host, 'http'), undefined, host)
    assert.equal(requestApiUrl('mf.example.org', 'javascript'), undefined)
    assert.equal(requestApiUrl('[::1]:7180', 'http'), 'http://[::1]:7180/api')

    const { body } = await serve({}, { host: 'localhost:2222@evil.example' })
    assert.doesNotMatch(body, /--api-url/)
    assert.match(body, /PUBLIC_API_BASE_URL/)
})

test('a configured URL that is not plain http(s) is not trusted', async () => {
    for (const configured of [
        'javascript:alert(1)',
        'https://user:pass@api.example.com'
    ]) {
        const { body } = await serve(
            { PUBLIC_API_BASE_URL: configured },
            { host: 'api.example.com' }
        )
        assert.doesNotMatch(body, /--api-url/, configured)
    }
})

test('staging deployments send agents to the dev CLI channel', async () => {
    const { body } = await serve(
        {
            PUBLIC_API_BASE_URL: 'https://api-staging.example.com',
            MF_DEPLOY_ENV: 'staging'
        },
        { host: 'api-staging.example.com', proto: 'https' }
    )
    assert.match(body, /MF_CHANNEL=dev MF_INSTALL_DIR=/)
    assert.match(body, /- CLI profile: `staging-example-com`/)
})

test('the default API falls back to the default web app URL', async () => {
    const { body } = await serve(
        { PUBLIC_API_BASE_URL: 'https://api.manyfold.ai' },
        { host: 'api.manyfold.ai', proto: 'https' }
    )
    assert.match(body, /- Web app: `https:\/\/manyfold\.ai`/)
    assert.match(body, /--profile <profile>/)
    assert.doesNotMatch(body, /MF_CHANNEL/)
})
