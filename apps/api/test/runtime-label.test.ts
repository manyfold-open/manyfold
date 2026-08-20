import test from 'node:test'
import assert from 'node:assert/strict'
import { nextFreeLabel } from '../src/modules/agent-runtimes/runtime-label'

test('nextFreeLabel returns the base when it is free', () => {
    assert.equal(
        nextFreeLabel('dev502-claude-code', new Set(['other'])),
        'dev502-claude-code'
    )
})

test('nextFreeLabel starts suffixing at -2 when the base is taken', () => {
    assert.equal(
        nextFreeLabel('dev502-claude-code', new Set(['dev502-claude-code'])),
        'dev502-claude-code-2'
    )
})

test('nextFreeLabel walks past every taken suffix', () => {
    assert.equal(
        nextFreeLabel(
            'dev502-claude-code',
            new Set(['dev502-claude-code', 'dev502-claude-code-2'])
        ),
        'dev502-claude-code-3'
    )
})
