import test from 'node:test'
import assert from 'node:assert/strict'
import type { Event } from '@sentry/node'
import {
    scrubSentryBreadcrumb,
    scrubSentryEvent
} from '../src/sentry-scrub'

test('sensitive query values are redacted out of the request url', () => {
    // The sprites exec WSS URL carries the command and every injected env
    // secret in its query (#264); shipping it to a third party would leak them.
    const event = scrubSentryEvent({
        request: { url: 'wss://sprites.dev/exec?key=SECRETTOKEN&cmd=ls' }
    } as Event)
    assert.doesNotMatch(event.request?.url ?? '', /SECRETTOKEN/)
    assert.match(event.request?.url ?? '', /REDACTED/)
})

test('the standalone query_string is redacted too', () => {
    const event = scrubSentryEvent({
        request: { query_string: 'key=SECRETTOKEN&page=2' }
    } as Event)
    assert.doesNotMatch(String(event.request?.query_string), /SECRETTOKEN/)
    assert.match(String(event.request?.query_string), /REDACTED/)
    assert.match(String(event.request?.query_string), /page=2/)
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

test('events with nothing sensitive pass through unchanged', () => {
    const event = scrubSentryEvent({
        request: { url: 'https://api.manyfold.ai/api/agents?page=2' },
        message: 'boom'
    } as Event)
    assert.equal(
        event.request?.url,
        'https://api.manyfold.ai/api/agents?page=2'
    )
    assert.equal(event.message, 'boom')
})

test('breadcrumb urls are redacted, other breadcrumbs untouched', () => {
    const crumb = scrubSentryBreadcrumb({
        category: 'http',
        data: { url: 'https://host/x?key=SECRETTOKEN', status_code: 500 }
    })
    assert.doesNotMatch(String(crumb.data?.url), /SECRETTOKEN/)
    assert.equal(crumb.data?.status_code, 500)

    const plain = { category: 'ui.click', message: 'button' }
    assert.equal(scrubSentryBreadcrumb(plain), plain)
})