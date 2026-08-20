import test from 'node:test'
import assert from 'node:assert/strict'
import { gaPageLocation } from '../src/lib/googleAnalyticsUrl'

test('the login hand-off fragment cannot reach GA', () => {
    // react-router keeps the hash in location.hash, and gaPageLocation has
    // nowhere to put it — so /login#session=SECRET reports as bare /login.
    const location = gaPageLocation('https://manyfold.ai', '/login', '')
    assert.equal(location, 'https://manyfold.ai/login')
})

test('sensitive query keys are redacted, the rest survive', () => {
    const location = gaPageLocation(
        'https://manyfold.ai',
        '/exec',
        '?key=SECRET&cmd=ls&tab=logs'
    )
    assert.doesNotMatch(location, /SECRET/)
    assert.match(location, /tab=logs/)
})

test('an ordinary route is reported verbatim, as an absolute URL', () => {
    const location = gaPageLocation(
        'https://manyfold.ai',
        '/agents/agt_01jd/chat',
        '?tab=files'
    )
    // GA4 rejects a bare path: page_location has to start with the protocol.
    assert.equal(location, 'https://manyfold.ai/agents/agt_01jd/chat?tab=files')
})
test('ObjectId path segments collapse to the route shape for GA', () => {
    const location = gaPageLocation(
        'https://manyfold.ai',
        '/agents/agt_aaaaaaaaaaaaaaaaaaaaaaaaaa/chat',
        ''
    )
    assert.equal(location, 'https://manyfold.ai/agents/:id/chat')
})

