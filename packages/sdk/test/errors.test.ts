import assert from 'node:assert/strict'
import test from 'node:test'
import { apiError } from '@manyfold/shared'
import { createClient } from '../src/client'
import { ApiError, buildApiError } from '../src/errors'

test('canonical API errors preserve machine fields and caller context', async () => {
    const payload = apiError('quota_exceeded', 'Quota exhausted', {
        traceId: 'trace-1',
        limit: 3
    })
    const error = await buildApiError(
        new Response(JSON.stringify(payload), { status: 429 }),
        { prefix: 'SSE' }
    )
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, payload.error.code)
    assert.equal(error.serverMessage, payload.error.message)
    assert.equal(error.message, 'SSE: Quota exhausted')
    assert.deepEqual(error.details, payload.error.details)
    assert.equal(error.status, 429)
})

test('flat legacy fields are not treated as a structured API error', async () => {
    const body = JSON.stringify({
        code: 'old_quota_code',
        message: 'LEGACY_MESSAGE',
        details: { traceId: 'old-trace' }
    })
    const error = await buildApiError(new Response(body, { status: 409 }))
    assert.equal(error.code, 'conflict')
    assert.equal(error.serverMessage, undefined)
    assert.equal(error.details, undefined)
    assert.equal(error.body, body)
})

test('the nested error is authoritative when a response also has flat fields', async () => {
    const error = await buildApiError(
        new Response(
            JSON.stringify({
                ...apiError('forbidden', 'Scope required', {
                    scopes: ['agents:read']
                }),
                code: 'old_code',
                message: 'OLD_MESSAGE',
                details: { traceId: 'old-trace' }
            }),
            { status: 403 }
        )
    )
    assert.equal(error.code, 'forbidden')
    assert.equal(error.serverMessage, 'Scope required')
    assert.deepEqual(error.details, { scopes: ['agents:read'] })
})

test('proxy text and empty error responses retain HTTP diagnostics', async () => {
    const body = '<html>gateway unavailable</html>'
    const proxy = await buildApiError(new Response(body, { status: 502 }), {
        prefix: 'SSE'
    })
    assert.equal(proxy.code, 'internal_error')
    assert.equal(proxy.serverMessage, undefined)
    assert.equal(proxy.message, `SSE: ${body}`)
    assert.equal(proxy.body, body)
    const empty = await buildApiError(
        new Response(null, { status: 503, statusText: 'Unavailable' })
    )
    assert.equal(empty.message, 'Unavailable')
    assert.equal(empty.code, 'internal_error')
    const noText = await buildApiError(new Response(null, { status: 503 }))
    assert.equal(noText.message, 'HTTP 503')
})

test('invalid JSON and non-object error values fall back to HTTP status', async () => {
    for (const body of ['{', 'null', '[]', '{"error":"no"}', '{"error":[]}']) {
        const error = await buildApiError(new Response(body, { status: 400 }))
        assert.equal(error.code, 'bad_request')
        assert.equal(error.serverMessage, undefined)
        assert.equal(error.details, undefined)
    }
})

test('the SDK request path uses the same canonical-only error contract', async () => {
    const payloads = [
        apiError('account_disabled', 'Account disabled'),
        { code: 'old_account_disabled', message: 'Legacy account disabled' }
    ]
    for (const [index, payload] of payloads.entries()) {
        const client = createClient({
            baseUrl: 'https://api.test/api',
            token: 'test-token',
            fetch: async () =>
                new Response(JSON.stringify(payload), { status: 403 })
        })
        await assert.rejects(client.auth.whoami(), (error: unknown) => {
            assert.ok(error instanceof ApiError)
            assert.equal(
                error.code,
                index === 0 ? 'account_disabled' : 'forbidden'
            )
            assert.equal(
                error.serverMessage,
                index === 0 ? 'Account disabled' : undefined
            )
            return true
        })
    }
})
