import assert from 'node:assert/strict'
import test from 'node:test'
import { toOpenAiCompatError } from '../src/modules/openai-compat/openai-chat-completions.service'
import {
    InflightTurnConflictError,
    SessionHeldByTerminalError,
    SessionImportPendingError
} from '../src/modules/chat/chat.service'

// The OpenAI-compatible surface maps a thrown HttpException to its error by
// status and body code. The ADR-0029 refusals carry an object body, so their
// stable code reaches the caller; the older inflight error, thrown with a
// bare string, keeps the status default.
test('session ownership refusals reach the OpenAI-compatible error with their code', () => {
    const held = toOpenAiCompatError(new SessionHeldByTerminalError())
    assert.equal(held.status, 409)
    assert.equal(held.code, 'session_held_by_terminal')
    assert.equal(held.type, 'invalid_request_error')

    const pending = toOpenAiCompatError(new SessionImportPendingError())
    assert.equal(pending.status, 409)
    assert.equal(pending.code, 'session_import_pending')

    const inflight = toOpenAiCompatError(new InflightTurnConflictError())
    assert.equal(inflight.status, 409)
    assert.equal(inflight.code, 'bad_request')
})
