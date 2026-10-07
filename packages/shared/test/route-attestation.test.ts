import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
    isRouteNonce,
    normalizeRouteBaseUrl,
    routeAttestationMessage
} from '../src/route-attestation'

const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

test('one endpoint has one spelling, whatever the runtime appended', () => {
    const same = [
        'https://gateway.fixture.invalid/claude',
        'https://gateway.fixture.invalid/claude/',
        'https://gateway.fixture.invalid/claude/v1',
        'https://gateway.fixture.invalid/claude/v1/',
        'https://GATEWAY.fixture.invalid:443/claude//',
        '  https://gateway.fixture.invalid/claude?x=1#frag  '
    ]
    for (const raw of same)
        assert.equal(
            normalizeRouteBaseUrl(raw),
            'https://gateway.fixture.invalid/claude',
            raw
        )
    assert.equal(
        normalizeRouteBaseUrl('https://api.fixture.invalid/v1'),
        'https://api.fixture.invalid'
    )
    assert.equal(
        normalizeRouteBaseUrl('http://127.0.0.1:8080/v1'),
        'http://127.0.0.1:8080'
    )
    // Only a trailing v1 segment is a runtime's spelling; another version or
    // a path that merely ends in "v1" is a different route.
    assert.equal(
        normalizeRouteBaseUrl('https://api.fixture.invalid/v1beta'),
        'https://api.fixture.invalid/v1beta'
    )
    assert.equal(
        normalizeRouteBaseUrl('https://api.fixture.invalid/apiv1'),
        'https://api.fixture.invalid/apiv1'
    )
    assert.notEqual(
        normalizeRouteBaseUrl('https://gateway.fixture.invalid/claude'),
        normalizeRouteBaseUrl('https://gateway.fixture.invalid/gemini')
    )
})

test('a URL that is not an http route never normalizes', () => {
    for (const raw of [
        '',
        '   ',
        'not a url',
        'ftp://files.fixture.invalid',
        'file:///etc/passwd',
        'https://user:secret@gateway.fixture.invalid/v1',
        42,
        null
    ])
        assert.equal(normalizeRouteBaseUrl(raw), null, String(raw))
})

test('a nonce is at least 16 random bytes of base64url', () => {
    assert.equal(isRouteNonce(NONCE), true)
    assert.equal(isRouteNonce('a'.repeat(22)), true)
    assert.equal(isRouteNonce('a'.repeat(21)), false)
    assert.equal(isRouteNonce('a'.repeat(129)), false)
    assert.equal(isRouteNonce('not+base64/url='), false)
    assert.equal(isRouteNonce(undefined), false)
})

test('the attested message and its HMAC are pinned byte for byte', () => {
    const message = routeAttestationMessage({
        nonce: NONCE,
        protocol: 'openai_chat_completions',
        baseUrl: 'https://Gateway.fixture.invalid/openai/v1/'
    })
    assert.equal(
        message,
        [
            'manyfold.route-attestation.v1',
            NONCE,
            'openai_chat_completions',
            'https://gateway.fixture.invalid/openai'
        ].join('\n')
    )
    // Both sides key HMAC-SHA256 with the provider key over this message;
    // the vector pins that agreement.
    assert.equal(
        createHmac('sha256', 'fixture-route-key').update(message!).digest('hex'),
        '458e75382f59ba14f7f4be93bbd8510506bab653b7bfa1e5edaa54c3f01993d1'
    )
    assert.equal(
        routeAttestationMessage({
            nonce: 'short',
            protocol: 'anthropic_messages',
            baseUrl: 'https://gateway.fixture.invalid'
        }),
        null
    )
    assert.equal(
        routeAttestationMessage({
            nonce: NONCE,
            protocol: 'anthropic_messages',
            baseUrl: 'https://user:pw@gateway.fixture.invalid'
        }),
        null
    )
})
