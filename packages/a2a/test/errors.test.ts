import assert from 'node:assert/strict'
import test from 'node:test'
import { A2aError, A2aErrorCode, defaultMessageForCode } from '../src/errors'

test('A2aError maps a JSON-RPC error body and round-trips back', () => {
    const e = A2aError.fromJsonRpc({
        code: A2aErrorCode.taskNotFound,
        message: 'nope',
        data: { id: 't1' }
    })
    assert.ok(e instanceof A2aError)
    assert.equal(e.code, -32001)
    assert.equal(e.message, 'nope')
    assert.deepEqual(e.data, { id: 't1' })
    assert.deepEqual(e.toJsonRpc(), {
        code: -32001,
        message: 'nope',
        data: { id: 't1' }
    })
})

test('error code table matches A2A v0.3 reserved codes', () => {
    assert.equal(A2aErrorCode.taskNotFound, -32001)
    assert.equal(A2aErrorCode.taskNotCancelable, -32002)
    assert.equal(A2aErrorCode.pushNotificationNotSupported, -32003)
    assert.equal(A2aErrorCode.unsupportedOperation, -32004)
    assert.equal(A2aErrorCode.contentTypeNotSupported, -32005)
    assert.equal(A2aErrorCode.invalidAgentResponse, -32006)
    assert.equal(A2aErrorCode.authenticatedExtendedCardNotConfigured, -32007)
    assert.equal(A2aErrorCode.methodNotFound, -32601)
    assert.equal(A2aErrorCode.invalidParams, -32602)
})

test('default message falls back from the code when none provided', () => {
    assert.equal(defaultMessageForCode(-32601), 'Method not found')
    assert.equal(new A2aError(-32001).message, 'Task not found')
    assert.equal(new A2aError(-99999).message, 'A2A error -99999')
})

test('toJsonRpc omits data when undefined', () => {
    assert.deepEqual(new A2aError(-32603, 'boom').toJsonRpc(), {
        code: -32603,
        message: 'boom'
    })
})
