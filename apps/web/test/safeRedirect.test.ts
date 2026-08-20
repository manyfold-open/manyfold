import assert from 'node:assert/strict'
import test from 'node:test'
import {
    parseOriginSuffixes,
    safeRedirectWith
} from '../src/lib/safeRedirect'

const CLOUD = parseOriginSuffixes(undefined)

test('safeRedirect: internal paths pass, protocol-relative do not', () => {
    assert.equal(safeRedirectWith(CLOUD, '/agents'), '/agents')
    assert.equal(safeRedirectWith(CLOUD, '//evil.com/agents'), null)
    assert.equal(safeRedirectWith(CLOUD, null), null)
})

test('safeRedirect: default allowlist is the official cloud domain', () => {
    assert.equal(
        safeRedirectWith(CLOUD, 'https://agent-x-dashboard.manyfold.ai/'),
        'https://agent-x-dashboard.manyfold.ai/'
    )
    assert.equal(
        safeRedirectWith(CLOUD, 'https://manyfold.ai/pricing'),
        'https://manyfold.ai/pricing'
    )
    assert.equal(safeRedirectWith(CLOUD, 'https://evil.com/'), null)
    // Suffix must be a dot boundary: evilmanyfold.ai is not manyfold.ai.
    assert.equal(safeRedirectWith(CLOUD, 'https://evilmanyfold.ai/'), null)
})

test('safeRedirect: non-http(s) schemes are rejected', () => {
    assert.equal(
        safeRedirectWith(CLOUD, 'javascript:alert(1)'),
        null
    )
    assert.equal(safeRedirectWith(CLOUD, 'ftp://manyfold.ai/x'), null)
})

test('safeRedirect: http normalizes to https (tunnel rd= stamping)', () => {
    assert.equal(
        safeRedirectWith(CLOUD, 'http://a-dashboard.manyfold.ai/x'),
        'https://a-dashboard.manyfold.ai/x'
    )
})

test('safeRedirect: deployment-owned suffixes replace the default', () => {
    const selfHost = parseOriginSuffixes('example.dev, dash.example.org')
    assert.equal(
        safeRedirectWith(selfHost, 'https://agent.dash.example.org/'),
        'https://agent.dash.example.org/'
    )
    assert.equal(
        safeRedirectWith(selfHost, 'https://manyfold.ai/'),
        null,
        'cloud domain is not implicitly trusted on other deployments'
    )
})

test('safeRedirect: empty suffix list allows same-origin paths only', () => {
    const none = parseOriginSuffixes('')
    assert.equal(safeRedirectWith(none, '/settings'), '/settings')
    assert.equal(safeRedirectWith(none, 'https://manyfold.ai/'), null)
})
