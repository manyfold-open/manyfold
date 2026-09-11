import assert from 'node:assert/strict'
import test from 'node:test'
import { sandboxTargetStatus } from '../src/lib/agentCreate/runtimeTargetStatus'

// WHY: the sandbox cards used to say "Ready" whatever the VM was doing; the
// status line now follows the runner the form is starting for the picked
// sandbox and the VM lifecycle for the rest.
test('the picked sandbox reports the runner being started, then answering', () => {
    assert.deepEqual(
        sandboxTargetStatus({
            spriteStatus: 'cold',
            picked: true,
            prewarming: true,
            availability: 'sandbox-asleep'
        }),
        { kind: 'starting-runner' }
    )
    assert.deepEqual(
        sandboxTargetStatus({
            spriteStatus: 'running',
            picked: true,
            prewarming: false,
            availability: 'ok'
        }),
        { kind: 'runner-online' }
    )
})

test("every other sandbox reports the VM lifecycle in the runtime list's words", () => {
    assert.deepEqual(
        sandboxTargetStatus({
            spriteStatus: 'running',
            picked: false,
            prewarming: true,
            availability: 'ok'
        }),
        { kind: 'sprite', label: 'Active', tone: 'success' }
    )
    assert.deepEqual(
        sandboxTargetStatus({
            spriteStatus: 'warm',
            picked: false,
            prewarming: false,
            availability: null
        }),
        { kind: 'sprite', label: 'Warm', tone: 'warning' }
    )
    assert.deepEqual(
        sandboxTargetStatus({
            spriteStatus: null,
            picked: true,
            prewarming: false,
            availability: 'sandbox-asleep'
        }),
        { kind: 'sprite', label: 'Provisioning', tone: 'idle' }
    )
})
