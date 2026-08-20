import assert from 'node:assert/strict'
import test from 'node:test'
import { automationModelConfigResourceKey } from '../src/pages/Automations/automationModelConfigResource'

test('model config resource identity is stable across equivalent agent objects', () => {
    const first = { id: 'agent-1', framework: 'codex' as const }
    const refreshed = { ...first }

    assert.equal(
        automationModelConfigResourceKey(first.id, first.framework),
        automationModelConfigResourceKey(refreshed.id, refreshed.framework)
    )
})

test('model config resource identity changes with the effective agent', () => {
    assert.notEqual(
        automationModelConfigResourceKey('agent-1', 'codex'),
        automationModelConfigResourceKey('agent-2', 'codex')
    )
    assert.notEqual(
        automationModelConfigResourceKey('agent-1', 'codex'),
        automationModelConfigResourceKey('agent-1', 'claude-code')
    )
})

test('unsupported agents do not create a model config resource', () => {
    assert.equal(automationModelConfigResourceKey('agent-1', 'openclaw'), null)
    assert.equal(automationModelConfigResourceKey(null, 'codex'), null)
})
