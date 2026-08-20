import assert from 'node:assert/strict'
import test from 'node:test'
import {
    redactedQueryString,
    redactSensitiveUrlQuery
} from '../src/common/telemetry/redact-url'

test('redactSensitiveUrlQuery redacts key query parameters in absolute URLs', () => {
    assert.equal(
        redactSensitiveUrlQuery(
            'https://gateway.test/v1beta/models?key=sk-secret&alt=json'
        ),
        'https://gateway.test/v1beta/models?key=REDACTED&alt=json'
    )
})

test('redactSensitiveUrlQuery redacts key query parameters in relative paths', () => {
    assert.equal(
        redactSensitiveUrlQuery('/v1beta/models?key=sk-secret&alt=json'),
        '/v1beta/models?key=REDACTED&alt=json'
    )
})

test('redactedQueryString returns the scrubbed query only', () => {
    assert.equal(
        redactedQueryString('/v1beta/models?key=sk-secret&alt=json'),
        'key=REDACTED&alt=json'
    )
})

// The sprites exec WSS URL carries the command and every injected env secret
// as repeated cmd=/env= query params (#264). Both must be scrubbed, and the
// repeated params collapse to a single REDACTED value.
test('redactSensitiveUrlQuery redacts sprites exec env and cmd values', () => {
    const raw =
        'wss://api.sprites.dev/v1/sprites/sbx/exec?path=bash&cmd=bash&cmd=-c&env=TOKEN%3Dsupersecret&env=API_KEY%3Dabc123&stdin=true'
    const out = redactSensitiveUrlQuery(raw)
    assert.ok(!out.includes('supersecret'), 'env secret must not survive')
    assert.ok(!out.includes('abc123'), 'second env secret must not survive')
    const params = new URL(out).searchParams
    assert.equal(params.get('env'), 'REDACTED')
    assert.equal(params.get('cmd'), 'REDACTED')
    assert.equal(params.get('path'), 'bash')
})
