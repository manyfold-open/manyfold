import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChatErrorDisplay } from '../src/lib/chatErrorDisplay'

// t() is stubbed to echo the key so we can assert the friendly branch fired.
const t = ((key: string) => key) as Parameters<
    typeof resolveChatErrorDisplay
>[1]

test('classifies a codex 401 INVALID_API_KEY failure as model_auth and keeps the raw detail', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'codex_exec_failed',
            message:
                'codex exited 1: unexpected status 401 Unauthorized: {"code":"INVALID_API_KEY","message":"Invalid API key"}',
            retryable: false
        },
        t
    )
    assert.equal(display.kind, 'model_auth')
    assert.equal(display.title, 'web.chat.error.modelAuth')
    assert.match(display.detail ?? '', /INVALID_API_KEY/)
})

test('classifies an anthropic invalid x-api-key failure as model_auth regardless of framework code', () => {
    const display = resolveChatErrorDisplay(
        {
            code: 'claude_exec_failed',
            message: 'authentication_error: invalid x-api-key',
            retryable: false
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
