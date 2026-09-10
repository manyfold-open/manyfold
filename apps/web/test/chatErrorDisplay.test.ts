import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChatErrorDisplay } from '../src/lib/chatErrorDisplay'

// t() is stubbed to echo the key so we can assert the friendly branch fired.
const t = ((key: string) => key) as Parameters<
    typeof resolveChatErrorDisplay
>[1]

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
