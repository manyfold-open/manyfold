import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import {
    LARK_APP_REGISTRATION_CALLBACKS,
    LARK_APP_REGISTRATION_EVENTS,
    LARK_APP_REGISTRATION_SCOPES,
    beginAppRegistration,
    buildQrUrl,
    initAppRegistration,
    pollAppRegistrationOnce
} from '../src/modules/channels/providers/lark-app-registration'

interface FetchCall {
    url: string
    init: RequestInit | undefined
}

const withFetch = async (
    handler: (call: FetchCall) => Response | Promise<Response>,
    run: () => Promise<void>
): Promise<void> => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) =>
        handler({ url: String(input), init })
    try {
        await run()
    } finally {
        globalThis.fetch = originalFetch
    }
}

test('QR addons preserve every permission needed by the zero-manual-step channel', () => {
    const url = new URL(
        buildQrUrl(
            'https://open.feishu.cn/app-registration?device_code=dev',
            'Support Bot'
        )
    )
    const encoded = url.searchParams.get('addons')
    assert.ok(encoded)
    assert.doesNotMatch(encoded, /[+/=]/)
    const decoded = JSON.parse(
        gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8')
    ) as {
        scopes: { tenant: string[] }
        events: { items: { tenant: string[] } }
        callbacks: { items: string[] }
    }
    assert.deepEqual(decoded.scopes.tenant, LARK_APP_REGISTRATION_SCOPES)
    assert.equal(decoded.scopes.tenant.length, 9)
    assert.ok(decoded.scopes.tenant.includes('im:message.group_msg'))
    assert.deepEqual(decoded.events.items.tenant, LARK_APP_REGISTRATION_EVENTS)
    assert.deepEqual(decoded.callbacks.items, LARK_APP_REGISTRATION_CALLBACKS)
    assert.equal(url.searchParams.get('from'), 'sdk')
    assert.equal(url.searchParams.get('tp'), 'sdk')
    assert.equal(url.searchParams.get('source'), 'manyfold')
    assert.equal(url.searchParams.get('name'), 'Support Bot')
    assert.equal(url.searchParams.get('desc'), 'Created by Manyfold')
})

test('init and begin use the device-code wire format and retain server timing', async () => {
    const calls: FetchCall[] = []
    const responses = [
        { supported_auth_methods: ['client_secret'] },
        {
            device_code: 'dev_123',
            verification_uri_complete: 'https://example.test/verify?x=1',
            user_code: 'ABCD',
            interval: 7,
            expires_in: 3600
        }
    ]
    await withFetch(
        (call) => {
            calls.push(call)
            return new Response(JSON.stringify(responses.shift()), {
                status: 200
            })
        },
        async () => {
            await initAppRegistration()
            assert.deepEqual(await beginAppRegistration(), {
                deviceCode: 'dev_123',
                verificationUriComplete: 'https://example.test/verify?x=1',
                userCode: 'ABCD',
                intervalSec: 7,
                expireInSec: 3600
            })
        }
    )
    assert.equal(calls.length, 2)
    for (const call of calls) {
        assert.equal(
            call.url,
            'https://accounts.feishu.cn/oauth/v1/app/registration'
        )
        assert.equal(call.init?.method, 'POST')
        assert.equal(
            new Headers(call.init?.headers).get('content-type'),
            'application/x-www-form-urlencoded'
        )
    }
    assert.deepEqual(
        Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body))),
        { action: 'init' }
    )
    assert.deepEqual(
        Object.fromEntries(new URLSearchParams(String(calls[1]?.init?.body))),
        {
            action: 'begin',
            archetype: 'PersonalAgent',
            auth_method: 'client_secret',
            request_user_info: 'open_id'
        }
    )
})

test('begin falls back to safe polling defaults when timing is absent', async () => {
    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    device_code: 'dev',
                    verification_uri_complete: 'https://example.test/verify',
                    user_code: 'CODE'
                }),
                { status: 200 }
            ),
        async () => {
            const result = await beginAppRegistration()
            assert.equal(result.intervalSec, 5)
            assert.equal(result.expireInSec, 3600)
        }
    )
})

test('init fails loudly when client-secret registration is unavailable', async () => {
    await withFetch(
        () =>
            new Response(JSON.stringify({ supported_auth_methods: ['none'] }), {
                status: 200
            }),
        async () => {
            await assert.rejects(
                initAppRegistration(),
                /does not support client_secret/
            )
        }
    )
})

test('poll success keeps credentials server-side and captures the scanner identity', async () => {
    let call: FetchCall | undefined
    await withFetch(
        (value) => {
            call = value
            return new Response(
                JSON.stringify({
                    client_id: 'cli_123',
                    client_secret: 'secret_123',
                    user_info: {
                        open_id: 'ou_scanner',
                        tenant_brand: 'lark'
                    }
                }),
                { status: 200 }
            )
        },
        async () => {
            assert.deepEqual(await pollAppRegistrationOnce('lark', 'dev'), {
                status: 'success',
                appId: 'cli_123',
                appSecret: 'secret_123',
                openId: 'ou_scanner',
                tenantBrand: 'lark'
            })
        }
    )
    assert.equal(
        call?.url,
        'https://accounts.larksuite.com/oauth/v1/app/registration'
    )
    assert.deepEqual(
        Object.fromEntries(new URLSearchParams(String(call?.init?.body))),
        { action: 'poll', device_code: 'dev' }
    )
})

test('poll keeps RFC device-flow 4xx states actionable', async (t) => {
    const cases = [
        ['authorization_pending', 'pending'],
        ['slow_down', 'slow_down'],
        ['access_denied', 'denied'],
        ['expired_token', 'expired']
    ] as const
    for (const [error, status] of cases) {
        await t.test(error, async () => {
            await withFetch(
                () => new Response(JSON.stringify({ error }), { status: 400 }),
                async () => {
                    assert.deepEqual(
                        await pollAppRegistrationOnce('feishu', 'dev'),
                        { status }
                    )
                }
            )
        })
    }
})

test('poll surfaces unknown upstream failures instead of looping forever', async () => {
    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    error: 'invalid_request',
                    error_description: 'bad device code'
                }),
                { status: 400 }
            ),
        async () => {
            assert.deepEqual(await pollAppRegistrationOnce('feishu', 'dev'), {
                status: 'error',
                message: 'invalid_request: bad device code'
            })
        }
    )
})

test('poll throws on 5xx so the session can retry after its server-side interval', async () => {
    await withFetch(
        () =>
            new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
                status: 503
            }),
        async () => {
            await assert.rejects(
                pollAppRegistrationOnce('feishu', 'dev'),
                /HTTP 503/
            )
        }
    )
})

test('Feishu polling switches domain before accepting Lark credentials', async () => {
    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    client_id: 'cli_lark',
                    client_secret: 'secret_lark',
                    user_info: { tenant_brand: 'lark' }
                }),
                { status: 200 }
            ),
        async () => {
            assert.deepEqual(await pollAppRegistrationOnce('feishu', 'dev'), {
                status: 'switch_domain'
            })
        }
    )
})
