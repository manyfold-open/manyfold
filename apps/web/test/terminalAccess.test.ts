import assert from 'node:assert/strict'
import test from 'node:test'
import {
    terminalAvailabilityForAgent,
    terminalBlockedLabel
} from '../src/lib/terminalAccess'

test('terminal view is offered for a usable non-external agent, asleep sandboxes included', () => {
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'sprites',
            availability: 'available'
        }),
        { available: true, reason: null }
    )
    // A sleeping sandbox wakes for the shell.
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'sprites',
            availability: 'wakeable'
        }),
        { available: true, reason: null }
    )
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'daemon',
            availability: 'available'
        }),
        { available: true, reason: null }
    )
    assert.deepEqual(
        terminalAvailabilityForAgent({ runtime: 'k8s', availability: 'available' }),
        { available: true, reason: null }
    )
})

test('an unreachable machine reports the agent reason, not the runtime one', () => {
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'daemon',
            availability: 'offline'
        }),
        { available: false, reason: 'agent-unavailable' }
    )
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'sprites',
            availability: 'unavailable'
        }),
        { available: false, reason: 'agent-unavailable' }
    )
})

// External agents run on someone else's provider, so there is no shell to
// attach to even while they are happily serving turns. That gate has to win
// over the availability gate or a working external agent would read as
// "not reachable".
test('an external runtime is refused even while available', () => {
    assert.deepEqual(
        terminalAvailabilityForAgent({
            runtime: 'external',
            availability: 'available'
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
        terminalBlockedLabel('agent-unavailable', t),
        'web.terminal.unavailableAgent'
    )
})
