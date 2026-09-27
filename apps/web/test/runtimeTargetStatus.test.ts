import assert from 'node:assert/strict'
import test from 'node:test'
import { sandboxTargetStatus } from '../src/lib/agentCreate/runtimeTargetStatus'

// WHY: the sandbox cards used to say "Ready" whatever the VM was doing; the
// status line now follows the daemon the form is starting for the picked
// sandbox and the machine itself for the rest.
test('the picked sandbox reports the daemon being started, then answering', () => {
    assert.deepEqual(
        sandboxTargetStatus({
            hostStatus: 'ready',
            powerState: 'stopped',
            picked: true,
            prewarming: true,
            availability: 'sandbox-asleep'
        }),
        { kind: 'starting-runner' }
    )
    assert.deepEqual(
        sandboxTargetStatus({
            hostStatus: 'ready',
            powerState: 'running',
            picked: true,
            prewarming: false,
            availability: 'ok'
        }),
        { kind: 'runner-online' }
    )
})

test("every other sandbox reports the machine in the runtime list's words", () => {
    assert.deepEqual(
        sandboxTargetStatus({
            hostStatus: 'ready',
            powerState: 'running',
            picked: false,
            prewarming: true,
            availability: 'ok'
        }),
        { kind: 'host', label: 'Running', tone: 'success' }
    )
    assert.deepEqual(
        sandboxTargetStatus({
            hostStatus: 'ready',
            powerState: 'suspended',
            picked: false,
            prewarming: false,
            availability: null
        }),
        { kind: 'host', label: 'Suspended', tone: 'warning' }
    )
    // A machine still being set up says so before its power state means
    // anything.
    assert.deepEqual(
        sandboxTargetStatus({
            hostStatus: 'provisioning',
            powerState: 'unknown',
            picked: true,
            prewarming: false,
            availability: 'sandbox-asleep'
        }),
        { kind: 'host', label: 'Provisioning', tone: 'info' }
    )
})
