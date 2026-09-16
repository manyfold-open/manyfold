import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChatErrorDisplay } from '../src/lib/chatErrorDisplay'

// t() is stubbed to echo the key so we can assert the friendly branch fired.
const t = ((key: string) => key) as Parameters<
    typeof resolveChatErrorDisplay
>[1]

test('provider overload keeps the API diagnostic display', () => {
    const error = {
        code: 'codex_provider_overloaded',
        cause: 'provider_overloaded' as const,
        retryable: true,
        message: 'The upstream provider asked for a later retry.'
    }
    assert.deepEqual(resolveChatErrorDisplay(error, t), {
        kind: null,
        title: error.message,
        detail: null
    })
})

test('renders the API auth cause and keeps the diagnostic detail', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'codex_exec_failed',
            message:
                'codex exited 1: unexpected status 401 Unauthorized: {"code":"INVALID_API_KEY","message":"Invalid API key"}',
            retryable: false,
            cause: 'auth_invalid'
        },
        t
    )
    assert.equal(display.kind, 'model_auth')
    assert.equal(display.title, 'web.chat.error.modelAuth')
    assert.match(display.detail ?? '', /INVALID_API_KEY/)
})

test('auth display follows the API cause independently of framework code', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'claude_exec_failed',
            message: 'authentication_error: invalid x-api-key',
            retryable: false,
            cause: 'auth_invalid'
        },
        t
    )
    assert.equal(display.kind, 'model_auth')
    assert.equal(display.title, 'web.chat.error.modelAuth')
})

test('leaves an unrelated runtime failure unclassified and shows the raw message', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'codex_exec_failed',
            message: 'codex exited 1: ENOSPC: no space left on device',
            retryable: false
        },
        t
    )
    assert.equal(display.kind, null)
    assert.match(display.title, /ENOSPC/)
    assert.equal(display.detail, null)
})

test('falls back to the code when the message is empty', () => {
    const display = resolveChatErrorDisplay(
        { code: 'codex_exec_failed', message: '', retryable: false },
        t
    )
    assert.equal(display.kind, null)
    assert.equal(display.title, 'codex_exec_failed')
    assert.equal(display.detail, null)
})

// Codex admits one writer per thread, and a TUI open in a terminal tab holds
// it for its lifetime — so a chat turn sent meanwhile fails on the refusal.
// The API keeps the session ref on purpose (the turn is retryable once the TUI
// is closed), which is exactly what the copy has to tell the user; the raw
// JSON-RPC line names nothing they did.
test('classifies a codex thread held by another writer as thread_busy and keeps the raw detail', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'codex_exec_failed',
            message:
                'codex exited 1: thread/resume failed: thread 01a07b93-bb59-7023-83ba-872ae3b88750 already has an active writer (code -32600)',
            retryable: true,
            cause: 'resume_contention'
        },
        t
    )
    assert.equal(display.kind, 'thread_busy')
    assert.equal(display.title, 'web.chat.error.threadBusy')
    assert.match(display.detail ?? '', /active writer/)
})

test('the API balance cause wins over authentication words in the message', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'claude_exec_failed',
            message: 'Failed to authenticate: insufficient account balance',
            retryable: false,
            cause: 'balance_exhausted'
        },
        t
    )
    assert.equal(display.kind, 'model_billing')
    assert.equal(display.title, 'web.chat.error.modelBilling')
})

test('the web never reclassifies an unclassified error by its wording', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'service_restarting',
            message: '401 unauthorized',
            retryable: true
        },
        t
    )
    assert.equal(display.kind, null)
    assert.equal(display.title, '401 unauthorized')
})

test('upstream and fail-fast empty pools use the same localized display', () => {
    for (const code of ['gemini_exec_failed', 'managed_channel_unavailable']) {
        const display = resolveChatErrorDisplay(
            {
                code,
                message: 'Provider diagnostic with neutral wording',
                retryable: false,
                cause: 'account_pool_empty'
            },
            t
        )
        assert.equal(display.kind, 'account_pool_empty')
        assert.equal(display.title, 'web.chat.error.accountPoolEmpty')
        assert.equal(display.detail, 'Provider diagnostic with neutral wording')
    }
})

test('empty-pool diagnostics are secondary and bounded even for long stderr', () => {
    const message = 'No available Gemini accounts: '.repeat(200)
    const display = resolveChatErrorDisplay(
        {
            code: 'gemini_exec_failed',
            message,
            retryable: true,
            cause: 'account_pool_empty'
        },
        t
    )
    assert.equal(display.title, 'web.chat.error.accountPoolEmpty')
    assert.equal(display.detail?.length, 1024)
    assert.ok(display.detail?.endsWith('...'))
    assert.notEqual(display.detail, message)
})

test('old and unknown causes retain the fallback without guessing from pool wording', () => {
    const message = 'No available Gemini accounts'
    for (const cause of [undefined, 'future_cause']) {
        const error = {
            code: 'gemini_exec_failed',
            message,
            retryable: false,
            cause
        } as Parameters<typeof resolveChatErrorDisplay>[0]
        assert.deepEqual(resolveChatErrorDisplay(error, t), {
            kind: null,
            title: message,
            detail: null
        })
    }
})
