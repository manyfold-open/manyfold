import assert from 'node:assert/strict'
import test from 'node:test'
import {
    terminalAvailabilityForAgent,
    terminalBlockedLabel
} from '../src/lib/terminalAccess'

test('terminal view is offered only for a running non-external agent', () => {
    assert.deepEqual(
        terminalAvailabilityForAgent({ runtime: 'sprites', status: 'running' }),
        { available: true, reason: null }
    )
    assert.deepEqual(
        terminalAvailabilityForAgent({ runtime: 'daemon', status: 'running' }),
        { available: true, reason: null }
    )
    assert.deepEqual(
        terminalAvailabilityForAgent({ runtime: 'k8s', status: 'running' }),
        { available: true, reason: null }
    )
})

test('a stopped agent reports the stopped reason, not the runtime one', () => {
    assert.deepEqual(
        terminalAvailabilityForAgent({ runtime: 'sprites', status: 'stopped' }),
        { available: false, reason: 'agent-not-running' }
    )
})

// External agents run on someone else's provider, so there is no shell to
// attach to even while they are happily serving turns. That gate has to win
// over the status gate or a running external agent would read as "start it".
test('an external runtime is refused even while running', () => {
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'external',
            status: 'running'
        }),
        { available: false, reason: 'external-runtime' }
    )
})

test('each blocked reason maps to its own copy', () => {
    const t = ((key: string) => key) as unknown as Parameters<
        typeof terminalBlockedLabel
    >[1]
    assert.equal(
        terminalBlockedLabel('external-runtime', t),
        'web.terminal.unavailableExternal'
    )
    assert.equal(
        terminalBlockedLabel('agent-not-running', t),
        'web.terminal.unavailableStopped'
    )
})
