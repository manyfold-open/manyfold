import test from 'node:test'
import assert from 'node:assert/strict'
import type { Event } from '@sentry/node'
import {
    scrubSentryBreadcrumb,
    scrubSentryEvent,
    scrubSentrySpan
} from '../src/sentry-scrub'

test('SDK query and fragment carriers are removed from breadcrumbs and attached events', () => {
    const query =
        'customer=synthetic-customer&since=synthetic-cursor&key=synthetic-key&env=synthetic-env&cmd=synthetic-command'
    const crumb = {
        category: 'http',
        data: {
            url: `https://example.test/sync?${query}#synthetic-fragment`,
            'http.query': query,
            'http.fragment': 'synthetic-fragment',
            'url.query': query,
            'url.fragment': 'synthetic-fragment',
            nested: {
                'http.query': query,
                url: `https://example.test/sync?${query}`
            },
            method: 'GET',
            status_code: 500
        }
    }
    for (const value of [
        scrubSentryBreadcrumb(crumb),
        scrubSentryEvent({ breadcrumbs: [structuredClone(crumb)] })
    ]) {
        assert.doesNotMatch(
            JSON.stringify(value),
            /synthetic-|http.query|url.query|http.fragment|url.fragment/
        )
        assert.match(JSON.stringify(value), /https:\/\/example.test\/sync/)
        assert.match(JSON.stringify(value), /GET/)
        assert.match(JSON.stringify(value), /500/)
    }
})

test('span hook and transaction backstop remove URL queries without discarding performance data', () => {
    const url =
        'https://example.test/sync?customer=synthetic-customer#synthetic-fragment'
    const span = {
        trace_id: '1'.repeat(32),
        span_id: '2'.repeat(16),
        start_timestamp: 1,
        timestamp: 2,
        op: 'http.client',
        description: `GET ${url}`,
        data: {
            'url.full': url,
            'http.url': url,
            'http.target': '/sync?since=synthetic-cursor#synthetic-fragment',
            'http.query': 'customer=synthetic-customer',
            'url.query': 'since=synthetic-cursor',
            'http.fragment': 'synthetic-fragment',
            'url.fragment': 'synthetic-fragment',
            'http.response.status_code': 200,
            'server.address': 'example.test'
        }
    }
    const transaction = scrubSentryEvent({
        type: 'transaction',
        transaction: 'chat.turn',
        spans: [structuredClone(span)],
        contexts: {
            trace: {
                trace_id: span.trace_id,
                span_id: span.span_id,
                data: structuredClone(span.data)
            }
        }
    } as Event)
    for (const value of [scrubSentrySpan(span), transaction]) {
        assert.doesNotMatch(
            JSON.stringify(value),
            /synthetic-|http.query|url.query|http.fragment|url.fragment/
        )
        assert.match(JSON.stringify(value), /http.response.status_code/)
        assert.match(JSON.stringify(value), /example.test/)
    }
    assert.equal(transaction.transaction, 'chat.turn')
    assert.equal(transaction.spans?.length, 1)
    assert.equal(transaction.spans?.[0].timestamp, 2)
})

test('sensitive query values are redacted out of the request url', () => {
    // The sprites exec WSS URL carries the command and every injected env
    // secret in its query (#264); shipping it to a third party would leak them.
    const event = scrubSentryEvent({
        request: { url: 'wss://sprites.dev/exec?key=SECRETTOKEN&cmd=ls' }
    } as Event)
    assert.doesNotMatch(event.request?.url ?? '', /SECRETTOKEN/)
    assert.equal(event.request?.url, 'wss://sprites.dev/exec')
})

test('standalone request query and referer components are removed', () => {
    const event = scrubSentryEvent({
        request: {
            query_string: 'customer=synthetic-customer&key=SECRETTOKEN&page=2',
            headers: {
                Referer:
                    'https://example.test/path?since=synthetic-cursor#synthetic-fragment'
            }
        }
    } as Event)
    assert.equal(event.request?.query_string, undefined)
    assert.equal(event.request?.headers?.Referer, 'https://example.test/path')
    assert.doesNotMatch(JSON.stringify(event), /synthetic-|SECRETTOKEN/)
})

test('the request body is dropped even when something collected one', () => {
    // httpIntegration is configured with maxIncomingRequestBodySize:'none';
    // this is the backstop, because a body here can hold a provider API key
    // or a whole chat message.
    const event = scrubSentryEvent({
        request: {
            url: 'https://api.manyfold.ai/api/model-providers',
            data: { apiKey: 'sk-live-SECRET' }
        }
    } as Event)
    assert.equal(event.request?.data, undefined)
})

test('exception values are redacted', () => {
    // HttpExceptionFilter deliberately returns the real failure text, which is
    // exactly the text Sentry receives.
    const event = scrubSentryEvent({
        exception: {
            values: [
                {
                    type: 'Error',
                    value: 'connect failed wss://sprites.dev/exec?env=API_KEY%3Dsecret'
                }
            ]
        }
    } as Event)
    assert.doesNotMatch(event.exception?.values?.[0]?.value ?? '', /secret/)
    assert.match(event.exception?.values?.[0]?.value ?? '', /REDACTED/)
})

test('the message is redacted', () => {
    const event = scrubSentryEvent({
        message: 'failed calling https://host/x?key=SECRETTOKEN'
    } as Event)
    assert.doesNotMatch(event.message ?? '', /SECRETTOKEN/)
})

test('request paths and ordinary messages survive query minimization', () => {
    const event = scrubSentryEvent({
        request: { url: 'https://api.manyfold.ai/api/agents?page=2' },
        message: 'boom'
    } as Event)
    assert.equal(event.request?.url, 'https://api.manyfold.ai/api/agents')
    assert.equal(event.message, 'boom')
})

test('breadcrumb urls are redacted, other breadcrumbs untouched', () => {
    const crumb = scrubSentryBreadcrumb({
        category: 'http',
        data: { url: 'https://host/x?key=SECRETTOKEN', status_code: 500 }
    })
    assert.doesNotMatch(String(crumb.data?.url), /SECRETTOKEN/)
    assert.equal(crumb.data?.url, 'https://host/x')
    assert.equal(crumb.data?.status_code, 500)

    const plain = { category: 'ui.click', message: 'button' }
    assert.equal(scrubSentryBreadcrumb(plain), plain)
})
