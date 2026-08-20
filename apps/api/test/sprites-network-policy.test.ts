import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultNetworkPolicy } from '../src/modules/agents/orchestration/bootstrap-invariants'

test('defaultNetworkPolicy leaves sprite outbound access wide open', () => {
    assert.deepEqual(defaultNetworkPolicy(), { rules: [] })
})
