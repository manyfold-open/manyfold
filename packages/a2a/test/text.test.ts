import assert from 'node:assert/strict'
import test from 'node:test'
import { A2aTextAccumulator } from '../src/text'
import type { TaskArtifactUpdateEvent } from '../src/types'

const chunk = (
    text: string,
    append = false,
    artifactId = 'a',
    taskId = 't'
): TaskArtifactUpdateEvent => ({
    kind: 'artifact-update',
    taskId,
    contextId: 'c',
    append,
    artifact: { artifactId, parts: [{ kind: 'text', text }] }
})

test('artifact snapshots replace, clear and deduplicate streamed text', () => {
    const output = new A2aTextAccumulator()
    assert.equal(output.apply(chunk('hello')), 'hello')
    assert.equal(output.apply(chunk(' world', true)), 'hello world')
    assert.equal(output.apply(chunk('hello world')), 'hello world')
    assert.equal(output.apply(chunk('corrected')), 'corrected')
    assert.equal(output.apply(chunk('')), '')
})

test('replacement is scoped by task and artifact, including task snapshots', () => {
    const output = new A2aTextAccumulator()
    output.apply(chunk('first', true))
    assert.equal(output.apply(chunk('second', false, 'b')), 'first\nsecond')
    assert.equal(
        output.apply(chunk('other task', false, 'a', 't2')),
        'first\nsecond\nother task'
    )
    assert.equal(output.apply(chunk('updated')), 'updated\nsecond\nother task')
    assert.equal(
        output.apply({
            kind: 'task',
            id: 't',
            contextId: 'c',
            status: { state: 'completed' },
            artifacts: [
                chunk('updated').artifact,
                chunk('second', false, 'b').artifact
            ]
        }),
        'updated\nsecond\nother task'
    )
})

for (const state of ['input-required', 'auth-required'] as const) {
    test(`${state} preserves the status message alongside existing artifacts`, () => {
        const output = new A2aTextAccumulator()
        output.apply(chunk('partial result'))
        const status = { state, message: {
            kind: 'message' as const, role: 'agent' as const, messageId: 'question',
            parts: [{ kind: 'text' as const, text: 'More information needed' }]
        } }
        const update = { kind: 'status-update' as const, taskId: 't', contextId: 'c', status, final: true }
        assert.equal(output.apply(update), 'partial result\nMore information needed')
        assert.equal(output.apply(update), 'partial result\nMore information needed')
        assert.equal(new A2aTextAccumulator().apply({ kind: 'task', id: 't', contextId: 'c', status }),
            'More information needed')
    })
}
