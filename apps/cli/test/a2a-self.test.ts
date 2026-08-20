import test from 'node:test'
import assert from 'node:assert/strict'
import { A2aSelfAuthError } from '../src/commands/a2a/self'

test('A2A self auth error covers both agent (scope) and user (--agent-id) paths', () => {
    const message = new A2aSelfAuthError().message
    assert.match(message, /mf auth ensure --scopes a2a:read/)
    assert.match(message, /post exactly the consent URL/)
    assert.match(message, /--agent-id/)
    assert.doesNotMatch(message, /mf login --poll/)
})

test('A2A management auth errors request the edit scope', () => {
    const message = new A2aSelfAuthError(undefined, 'a2a:edit').message
    assert.match(message, /missing the a2a:edit scope/)
    assert.match(message, /mf auth ensure --scopes a2a:edit/)
    assert.doesNotMatch(message, /mf auth ensure --scopes a2a:read/)
})
