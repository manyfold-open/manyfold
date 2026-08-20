import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '@sentry/node'
import { chatFailureCauses } from '../src/common/telemetry/chat-failure-taxonomy'
import { buildTelemetryCaptureOptions } from '../src/sentry-grouping'
import { scrubSentryEvent } from '../src/sentry-scrub'

// #786. These options ARE what production passes Sentry.captureException —
// captureTelemetryError does nothing else with them — so this file is the
// capture boundary under test. It deliberately never imports ../src/sentry,
// whose Sentry.init runs on import: a test that has to mock the SDK ends up
// asserting on source text instead of on the grouping key that actually ships.

const ATTRS = {
    userId: 'user_01HZ',
    sessionId: 'chatSession_01HZX9ABCD',
    agentId: 'agent_01HZX9ABCD',
    assistantMessageId: 'b6b1a0de-8b1e-4a0e-9f0b-2a9a2d0f1e77',
    framework: 'claude-code',
    runtimeKind: 'sprites',
    retryable: true,
    turnPhase: 'stream',
    durationMs: 4210,
    errorCode: 'claude_result_error'
}

test('a classified chat failure is fingerprinted on its cause, versioned', () => {
    const options = buildTelemetryCaptureOptions('chat.stream.error', {
        ...ATTRS,
        cause: 'balance_exhausted'
    })
    assert.deepEqual(options.fingerprint, [
        'chat.stream.error.v1',
        'balance_exhausted'
    ])
    assert.equal(options.tags['nca.event'], 'chat.stream.error')
    assert.equal(options.tags['nca.chat_cause'], 'balance_exhausted')
    assert.equal(options.tags['nca.chat_framework'], 'claude-code')
    assert.equal(options.tags['nca.chat_runtime_kind'], 'sprites')
    assert.equal(options.tags['nca.chat_turn_phase'], 'stream')
    assert.equal(options.tags['nca.chat_retryable'], 'true')
})

// The issue itself: these five arrived as one Sentry issue whose title was
// whatever landed last. Distinct fingerprints are the entire fix.
test('the causes that used to share one issue now group apart', () => {
    const fingerprintFor = (cause: string): string[] | undefined =>
        buildTelemetryCaptureOptions('chat.stream.error', {
            ...ATTRS,
            cause
        }).fingerprint
    const causes = [
        'empty_response',
        'balance_exhausted',
        'stale_resume_ref',
        'daemon_offline',
        'exec_handshake_failed'
    ]
    const keys = causes.map((c) => JSON.stringify(fingerprintFor(c)))
    assert.equal(new Set(keys).size, causes.length)
})

// #803 joins that list. A throttle used to have no cause at all, so it landed
// in the unclassified bucket beside every unrecognised failure in the fleet —
// and the two incidents it is most easily confused with are the two whose fix is
// somebody doing something, so they must not share a group with it.
test('a throttle is its own group, apart from an empty pool and a balance', () => {
    const fingerprintFor = (cause: string): string | undefined =>
        JSON.stringify(
            buildTelemetryCaptureOptions('chat.stream.error', {
                ...ATTRS,
                cause
            }).fingerprint
        )
    const keys = chatFailureCauses.map(fingerprintFor)
    assert.equal(
        new Set(keys).size,
        chatFailureCauses.length,
        'every cause in the taxonomy still groups on its own'
    )
    assert.deepEqual(
        buildTelemetryCaptureOptions('chat.stream.error', {
            ...ATTRS,
            cause: 'rate_limited'
        }).fingerprint,
        ['chat.stream.error.v1', 'rate_limited']
    )
    // And it is a tag the closed-enum gate accepts, so the throttle actually
    // reaches an operator's search instead of being dropped as unknown.
    assert.equal(
        buildTelemetryCaptureOptions('chat.stream.error', {
            ...ATTRS,
            cause: 'rate_limited'
        }).tags['nca.chat_cause'],
        'rate_limited'
    )
})

test('one cause stays one group across ids, wording and framework', () => {
    const a = buildTelemetryCaptureOptions('chat.stream.error', {
        ...ATTRS,
        cause: 'balance_exhausted',
        errorCode: 'claude_result_error',
        framework: 'claude-code',
        sessionId: 'chatSession_AAAA',
        errorMessage:
            'Failed to authenticate. API Error: 403 Insufficient account balance'
    })
    const b = buildTelemetryCaptureOptions('chat.stream.error', {
        ...ATTRS,
        cause: 'balance_exhausted',
        errorCode: 'codex_exec_failed',
        framework: 'codex',
        runtimeKind: 'daemon',
        sessionId: 'chatSession_BBBB',
        errorMessage:
            'codex exited 1: {"code":"INSUFFICIENT_BALANCE"}, request_id: req_77'
    })
    assert.deepEqual(a.fingerprint, b.fingerprint)
    // Framework is a tag, not part of the key: one exhausted account reaches
    // us through several adapters and is still one incident.
    assert.notEqual(a.tags['nca.chat_framework'], b.tags['nca.chat_framework'])
})

test('an unclassified chat failure keeps Sentry default grouping', () => {
    const options = buildTelemetryCaptureOptions('chat.stream.error', ATTRS)
    assert.ok(
        !('fingerprint' in options),
        'no fingerprint key at all, so Sentry groups on the stack as before'
    )
    assert.equal(options.fingerprint, undefined)
    assert.equal(options.tags['nca.chat_cause'], undefined)
    // The safe context still ships: an unclassified failure is exactly the one
    // an operator has to triage by hand.
    assert.equal(options.tags['nca.chat_framework'], 'claude-code')
    assert.equal(options.tags['nca.chat_turn_phase'], 'stream')
})

test('every other telemetry error is untouched', () => {
    const options = buildTelemetryCaptureOptions('agent.create.failed', {
        ...ATTRS,
        // Even if some other emitter grows these attrs, only chat.stream.error
        // opts into cause grouping.
        cause: 'balance_exhausted'
    })
    assert.ok(!('fingerprint' in options))
    assert.deepEqual(options.tags, { 'nca.event': 'agent.create.failed' })
})

test('a value outside the closed enums never becomes a tag', () => {
    const options = buildTelemetryCaptureOptions('chat.stream.error', {
        cause: 'balance_exhausted; sk-ant-api03-LEAKED',
        framework: 'claude-code (via https://gw.netmind.xyz/v1?key=secret)',
        runtimeKind: 'sprites-7f3a2b',
        turnPhase: 'chatSession_01HZX9ABCD',
        retryable: 'true'
    })
    assert.deepEqual(options.tags, { 'nca.event': 'chat.stream.error' })
    assert.ok(!('fingerprint' in options))
})

test('the dispatch path names its unknown runtime instead of inventing one', () => {
    const options = buildTelemetryCaptureOptions('chat.stream.error', {
        framework: 'gemini-cli',
        runtimeKind: 'unknown',
        turnPhase: 'dispatch',
        cause: 'daemon_offline'
    })
    assert.equal(options.tags['nca.chat_runtime_kind'], 'unknown')
    assert.equal(options.tags['nca.chat_turn_phase'], 'dispatch')
    assert.equal(options.tags['nca.chat_retryable'], undefined)
    assert.deepEqual(options.fingerprint, [
        'chat.stream.error.v1',
        'daemon_offline'
    ])
})

// #661. Tags are indexed and searchable; anything unbounded in one is both a
// cardinality bomb and a leak that survives the message redaction. The raw
// detail is allowed to ride `extra`, which beforeSend already scrubs.
test('no raw or high-cardinality input reaches a tag or the fingerprint', () => {
    const secrets = [
        'sk-ant-api03-LEAKED',
        'https://3avtktubfdf842bfx2fk.netmind.xyz/responses?token=abc',
        'chatSession_01HZX9ABCD',
        'agent_01HZX9ABCD',
        'b6b1a0de-8b1e-4a0e-9f0b-2a9a2d0f1e77',
        '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        '8f1c2d3e-cf-ray',
        '/home/sprite/.manyfold/workspaces/agent_01HZX9ABCD',
        'claude-sonnet-4-5-20250929'
    ]
    const options = buildTelemetryCaptureOptions('chat.stream.error', {
        ...ATTRS,
        cause: 'balance_exhausted',
        errorMessage: `Failed to authenticate. API Error: 403 Insufficient account balance key=${secrets[0]} url=${secrets[1]}`,
        frameworkSessionRef: secrets[5],
        model: secrets[8],
        workspacePath: secrets[7]
    })
    const indexed = JSON.stringify([options.tags, options.fingerprint])
    for (const secret of secrets)
        assert.ok(
            !indexed.includes(secret),
            `${secret} must not reach a tag or the fingerprint`
        )
    // Positively: every tag value is a member of a closed set.
    for (const [key, value] of Object.entries(options.tags))
        assert.ok(
            [
                'chat.stream.error',
                'balance_exhausted',
                'claude-code',
                'sprites',
                'stream',
                'true'
            ].includes(value),
            `${key}=${value} is not a closed-enum value`
        )
})

test('extra still carries the detail, and beforeSend still scrubs the event', () => {
    const options = buildTelemetryCaptureOptions('chat.stream.error', {
        ...ATTRS,
        cause: 'auth_invalid'
    })
    assert.equal(options.extra.sessionId, ATTRS.sessionId)
    assert.equal(options.extra.errorCode, 'claude_result_error')

    // The grouping key must survive the scrubber, and the scrubber must still
    // redact what #661 made it redact — `key`/`env`/`cmd`, the sprites exec
    // WSS query that carries the command and every injected secret.
    const scrubbed = scrubSentryEvent({
        fingerprint: options.fingerprint,
        tags: options.tags,
        extra: options.extra,
        request: {
            url: 'https://api.manyfold.dev/api/chat?key=sk-ant-api03-LEAKED',
            data: { prompt: 'private' }
        },
        exception: {
            values: [
                {
                    type: 'Error',
                    value: 'auth failed for wss://sprite.dev/exec?key=sk-ant-api03-LEAKED&cmd=claude'
                }
            ]
        }
    } as Event)
    assert.deepEqual(scrubbed.fingerprint, [
        'chat.stream.error.v1',
        'auth_invalid'
    ])
    assert.equal(scrubbed.tags?.['nca.chat_cause'], 'auth_invalid')
    assert.equal(scrubbed.request?.data, undefined)
    assert.ok(!scrubbed.request?.url?.includes('sk-ant-api03-LEAKED'))
    assert.ok(
        !scrubbed.exception?.values?.[0].value?.includes('sk-ant-api03-LEAKED')
    )
})