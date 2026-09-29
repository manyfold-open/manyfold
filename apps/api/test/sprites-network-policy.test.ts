import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultNetworkPolicy } from '../src/modules/hosts/providers/sprites.provider'

test('defaultNetworkPolicy leaves sprite outbound access wide open', () => {
    assert.deepEqual(defaultNetworkPolicy(), { rules: [] })
})
