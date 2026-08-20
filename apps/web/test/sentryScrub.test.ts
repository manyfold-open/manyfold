import test from 'node:test'
import assert from 'node:assert/strict'
import type { Event } from '@sentry/react'
import {
    scrubSentryBreadcrumb,
    scrubSentryEvent,
    scrubSentryUrl
} from '../src/lib/sentryScrub'

// apps/admin/src/lib/sentryScrub.ts is a byte-identical copy (same convention
// as lib/axiom.ts); admin has no test runner of its own.

test('the session token in the login fragment is redacted', () => {
    // auth.tsx puts it in the fragment on purpose so it never reaches a server
    // log. Sentry reports the full href, so it has to be stripped here too.
    const scrubbed = scrubSentryUrl(
        'https://manyfold.ai/login#session=eyJhbGciOiJIUzI1NiJ9.SECRET'
    )
    assert.doesNotMatch(scrubbed, /SECRET/)
    assert.match(scrubbed, /REDACTED/)
})

test('the NarraNexus hand-off token is redacted', () => {
    const scrubbed = scrubSentryUrl('https://manyfold.ai/#nmtoken=NMSECRET')
    assert.doesNotMatch(scrubbed, /NMSECRET/)
    assert.match(scrubbed, /REDACTED/)
})

test('other fragment values survive alongside a redacted one', () => {
    const scrubbed = scrubSentryUrl(
        'https://manyfold.ai/login#session=SECRET&error=denied'
    )
    assert.doesNotMatch(scrubbed, /SECRET/)
    assert.match(scrubbed, /error=denied/)
})

test('sensitive query keys are redacted', () => {
    const scrubbed = scrubSentryUrl('https://host/exec?key=SECRET&cmd=ls&x=1')
    assert.doesNotMatch(scrubbed, /SECRET/)
    assert.match(scrubbed, /x=1/)
})

test('ordinary urls are returned untouched', () => {
    const plain = 'https://manyfold.ai/agents/agt_1/chat?page=2'
    assert.equal(scrubSentryUrl(plain), plain)
    assert.equal(scrubSentryUrl('/agents/agt_1'), '/agents/agt_1')
})

test('relative urls keep their shape', () => {
    assert.equal(
        scrubSentryUrl('/login#session=SECRET'),
        '/login#session=REDACTED'
    )
})

test('a malformed url is passed through rather than throwing', () => {
    assert.equal(scrubSentryUrl('::::'), '::::')
    assert.equal(scrubSentryUrl(''), '')
})

test('event request url and referer are both scrubbed', () => {
    const event = scrubSentryEvent({
        request: {
            url: 'https://manyfold.ai/login#session=SECRET',
            headers: { Referer: 'https://manyfold.ai/#nmtoken=NMSECRET' }
        }
    } as Event)
    assert.doesNotMatch(event.request?.url ?? '', /SECRET/)
    assert.doesNotMatch(String(event.request?.headers?.['Referer']), /NMSECRET/)
})

test('navigation breadcrumbs are scrubbed on both ends', () => {
    // react-router navigation crumbs record from/to, and the login redirect
    // lands on exactly the url that carries the token.
    const crumb = scrubSentryBreadcrumb({
        category: 'navigation',
        data: {
            from: 'https://manyfold.ai/login#session=SECRET',
            to: 'https://manyfold.ai/home'
        }
    })
    assert.doesNotMatch(String(crumb.data?.from), /SECRET/)
    assert.equal(crumb.data?.to, 'https://manyfold.ai/home')
})

test('breadcrumbs attached to an event are scrubbed too', () => {
    const event = scrubSentryEvent({
        breadcrumbs: [
            { category: 'fetch', data: { url: 'https://host/x?key=SECRET' } }
        ]
    } as Event)
    assert.doesNotMatch(String(event.breadcrumbs?.[0]?.data?.url), /SECRET/)
})

test('a breadcrumb with no data is returned as-is', () => {
    const plain = { category: 'ui.click', message: 'button' }
    assert.equal(scrubSentryBreadcrumb(plain), plain)
})
test('the waitlist invite token is a credential and never reaches Sentry', () => {
    const scrubbed = scrubSentryUrl('https://manyfold.ai/invite/tok_SECRET123')
    assert.doesNotMatch(scrubbed, /SECRET/)
    assert.match(scrubbed, /\/invite\/REDACTED/)
})

