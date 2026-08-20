import test from 'node:test'
import assert from 'node:assert/strict'
import { SpanStatusCode, type Span } from '@opentelemetry/api'
import {
    HTTP_RESPONSE_STATUS_CODE,
    setHttpResponseStatus,
    setHttpServerRequestAttributes
} from '../src/common/telemetry/http-span'

const fakeSpan = () => {
    const attributes = new Map<string, unknown>()
    let status: unknown
    const span = {
        setAttribute: (key: string, value: unknown) => {
            attributes.set(key, value)
            return span
        },
        setStatus: (next: unknown) => {
            status = next
            return span
        }
    } as Span
    return { span, attributes, getStatus: () => status }
}

test('setHttpResponseStatus writes the status code attribute', () => {
    const { span, attributes, getStatus } = fakeSpan()

    setHttpResponseStatus(span, 201)

    assert.equal(attributes.get(HTTP_RESPONSE_STATUS_CODE), 201)
    assert.equal(getStatus(), undefined)
})

test('setHttpResponseStatus marks 5xx spans as errors', () => {
    const { span, attributes, getStatus } = fakeSpan()

    setHttpResponseStatus(span, 503)

    assert.equal(attributes.get(HTTP_RESPONSE_STATUS_CODE), 503)
    assert.deepEqual(getStatus(), { code: SpanStatusCode.ERROR })
})

test('setHttpResponseStatus ignores missing spans and invalid status codes', () => {
    const { span, attributes } = fakeSpan()

    setHttpResponseStatus(undefined, 200)
    setHttpResponseStatus(span, undefined)
    setHttpResponseStatus(span, 0)

    assert.equal(attributes.size, 0)
})

test('setHttpServerRequestAttributes adds stable method and query-free path fields', () => {
    const { span, attributes } = fakeSpan()

    setHttpServerRequestAttributes(span, {
        method: 'GET',
        url: '/api/agents?token=secret'
    })

    assert.equal(attributes.get('http.request.method'), 'GET')
    assert.equal(attributes.get('url.path'), '/api/agents')
    assert.equal(attributes.has('url.query'), false)
})

test('setHttpServerRequestAttributes ignores outbound request shapes', () => {
    const { span, attributes } = fakeSpan()

    setHttpServerRequestAttributes(span, { method: 'POST' })

    assert.equal(attributes.size, 0)
})
