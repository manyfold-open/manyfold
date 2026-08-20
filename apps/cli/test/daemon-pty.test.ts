import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePtyModule } from '../src/daemon/pty'

test('resolvePtyModule accepts direct spawn export', () => {
    const mod = { spawn: () => null }

    assert.equal(resolvePtyModule(mod), mod)
})

test('resolvePtyModule accepts default spawn export', () => {
    const inner = { spawn: () => null }
    const mod = { default: inner }

    assert.equal(resolvePtyModule(mod), inner)
})

test('resolvePtyModule rejects modules without spawn', () => {
    assert.equal(resolvePtyModule({}), null)
    assert.equal(resolvePtyModule({ default: {} }), null)
})
