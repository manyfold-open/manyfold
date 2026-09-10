import assert from 'node:assert/strict'
import test from 'node:test'
import {
    classifyChatFailureCause,
    normalizeChatError,
    normalizeChatErrorPayload
} from '../src/modules/chat/chat-failure-cause'

test('adapter errors carry the same cause used by terminal telemetry without changing retry policy', () => {
    for (const [code, message, cause] of [
        [
            'claude_exec_failed',
            'authentication_error: invalid x-api-key',
            'auth_invalid'
        ],
        [
            'codex_exec_failed',
            'Failed to authenticate: insufficient account balance',
            'balance_exhausted'
        ],
        [
            'codex_exec_failed',
            'thread already has an active writer',
            'resume_contention'
        ],
        ['external_provider_failed', 'Payment required', 'balance_exhausted'],
        ['dify_http_429', 'quota exceeded', 'rate_limited'],
        ['langflow_http_402', 'payment required', 'balance_exhausted'],
        [
            'provider_kind_mismatch',
            'binding is for the wrong provider',
            'invalid_request'
        ]
    ] as const) {
        for (const retryable of [true, false]) {
            const normalized = normalizeChatError({ code, message, retryable })
            assert.equal(normalized.cause, cause)
            assert.equal(
                normalized.cause,
                classifyChatFailureCause({ errorCode: code, message })
            )
            assert.equal(normalized.retryable, retryable)
            assert.equal(normalized.message, message)
        }
    }
})

test('old payloads get the current contract and untrusted causes cannot override API classification', () => {
    const payload = {
        type: 'error',
        error: {
            code: 'claude_exec_failed',
            message: 'invalid api key',
            retryable: true,
            cause: 'balance_exhausted'
        }
    }
    assert.deepEqual(normalizeChatErrorPayload(payload), {
        type: 'error',
        error: {
            code: 'claude_exec_failed',
            message: 'invalid api key',
            retryable: true,
            cause: 'auth_invalid'
        }
    })
    assert.equal(payload.error.cause, 'balance_exhausted')
    assert.equal(
        normalizeChatError({
            code: 'service_restarting',
            message: 'invalid api key',
            retryable: true
        }).cause,
        undefined
    )
    assert.deepEqual(normalizeChatErrorPayload({ error: 'invalid' }), {
        error: 'invalid'
    })
})

test('classification sees the same JSONB-safe text as persisted history', () => {
    const normalized = normalizeChatError({
        code: 'claude_exec_failed',
        message: 'invalid\0 api key',
        retryable: false
    })
    assert.equal(normalized.message, 'invalid api key')
    assert.equal(normalized.cause, 'auth_invalid')
})
