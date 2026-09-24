import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserSentryScrubber } from '../src/browser-sentry-scrub'

const policy = createBrowserSentryScrubber({
    removedQueryParams: ['private_touch'],
    redactedFragmentParams: ['handoff_token']
})

test('every navigation phase keeps timings while removing its retained URL token', () => {
    const navigation = Object.freeze({
        name: 'https://site.test/landing?private_touch=PRIVATE_VALUE&utm_source=mail'
    })
    const phases = [
        'redirect',
        'cache',
        'DNS',
        'TLS/SSL',
        'connect',
        'request',
        'response',
        'domContentLoadedEvent',
        'loadEvent'
    ]
    for (const phase of phases) {
        const source = {
            description: navigation.name,
            op: `browser.${phase}`,
            start_timestamp: 1,
            timestamp: 1.25,
            data: { 'url.full': navigation.name, 'http.status_code': 200 }
        }
        const span = policy.scrubSpan(source)
        assert.doesNotMatch(JSON.stringify(span), /private_touch|PRIVATE_VALUE/)
        assert.match(span.description, /utm_source=mail/)
        assert.equal(span.op, source.op)
        assert.equal(span.start_timestamp, 1)
        assert.equal(span.timestamp, 1.25)
        assert.equal(span.data['http.status_code'], 200)
        assert.equal(source.description, navigation.name)
    }
    assert.match(navigation.name, /PRIVATE_VALUE/)
})

test('standalone SDK URL, query and fragment fields use the same policy', () => {
    for (const field of [
        'url',
        'url.full',
        'url.original',
        'http.url',
        'http.target',
        'from',
        'to'
    ]) {
        const span = policy.scrubSpan({
            data: {
                [field]: '/landing?PrIvAtE_ToUcH=PRIVATE_VALUE&utm_medium=mail'
            }
        })
        assert.doesNotMatch(JSON.stringify(span), /PRIVATE_VALUE|PrIvAtE_ToUcH/)
        assert.match(String(span.data[field]), /utm_medium=mail/)
    }
    const span = policy.scrubSpan({
        data: {
            'http.query':
                '?private_touch=PRIVATE_VALUE&key=KEY_VALUE&utm_id=campaign',
            'url.query': {
                private_touch: 'PRIVATE_VALUE',
                key: 'KEY_VALUE',
                page: '2'
            },
            'http.fragment': '#session=SESSION_VALUE&next=home',
            'url.fragment': 'handoff_token=HANDOFF_VALUE&error=denied',
            PRIVATE_TOUCH: 'PRIVATE_VALUE',
            count: 4
        }
    })
    assert.doesNotMatch(
        JSON.stringify(span),
        /PRIVATE_VALUE|KEY_VALUE|SESSION_VALUE|HANDOFF_VALUE|private_touch|PRIVATE_TOUCH/
    )
    assert.match(String(span.data['http.query']), /utm_id=campaign/)
    assert.deepEqual(span.data['url.query'], { key: 'REDACTED', page: '2' })
    assert.equal(span.data.count, 4)
})

test('final events backstop request, breadcrumbs, children and root trace data', () => {
    const url =
        'https://site.test/?private_touch=PRIVATE_VALUE&utm_campaign=kept'
    const event = policy.scrubEvent({
        transaction: '/agents/:agentId/chat',
        request: {
            url,
            query_string: {
                private_touch: 'PRIVATE_VALUE',
                cmd: 'COMMAND_VALUE',
                page: '2'
            },
            headers: { rEfErEr: url, 'content-type': 'text/html' }
        },
        breadcrumbs: [{ message: `GET ${url}`, data: { from: url, to: url } }],
        contexts: { trace: { data: { 'url.full': url }, trace_id: 'trace' } },
        spans: [{ description: url, data: { 'url.full': url }, timestamp: 42 }]
    })
    assert.doesNotMatch(
        JSON.stringify(event),
        /private_touch|PRIVATE_VALUE|COMMAND_VALUE/
    )
    assert.equal(event.transaction, '/agents/:agentId/chat')
    assert.deepEqual(event.request.query_string, { cmd: 'REDACTED', page: '2' })
    assert.equal(event.request.headers['content-type'], 'text/html')
    assert.equal(event.contexts.trace.trace_id, 'trace')
    assert.equal(event.spans[0].timestamp, 42)
    assert.deepEqual(policy.scrubEvent(structuredClone(event)), event)
})

test('HTTP method descriptions, protocol-relative URLs and route names remain recognizable', () => {
    assert.equal(
        policy.scrubSpan({
            description: 'GET /items?private_touch=PRIVATE_VALUE&page=2'
        }).description,
        'GET /items?page=2'
    )
    assert.equal(
        policy.scrubUrl('//site.test/items?key=KEY_VALUE&page=2'),
        '//site.test/items?key=REDACTED&page=2'
    )
    assert.equal(policy.scrubUrl('/invite/:token'), '/invite/:token')
    assert.equal(policy.scrubUrl('/invite/INVITE_VALUE'), '/invite/REDACTED')
    assert.equal(policy.scrubUrl('not a URL'), 'not a URL')
})

test('edition-specific removal lists are isolated from each other', () => {
    const other = createBrowserSentryScrubber({
        removedQueryParams: ['other_private']
    })
    assert.equal(
        policy.scrubUrl('/?private_touch=a&other_private=b'),
        '/?other_private=b'
    )
    assert.equal(
        other.scrubUrl('/?private_touch=a&other_private=b'),
        '/?private_touch=a'
    )
    assert.equal(
        policy.scrubUrl('/#handoff_token=a'),
        '/#handoff_token=REDACTED'
    )
    assert.equal(other.scrubUrl('/#handoff_token=a'), '/#handoff_token=a')
})
