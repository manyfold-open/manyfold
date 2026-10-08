import assert from 'node:assert/strict'
import test from 'node:test'
import { isRuntimeUsable, runtimeAvailability } from '../src/host-model'
import type { RuntimeHostPowerState } from '../src/host-model'

const ready = { status: 'ready' as const }
const hosted = (powerState: RuntimeHostPowerState | null) => ({
    kind: 'hosted' as const,
    status: 'ready' as const,
    powerState
})

// A suspended VM freezes its daemon, whose last heartbeat stays inside the
// presence window for up to 45s. Seen on a local stack [2026-09-28]: that
// window drew a green agent while the concurrent-sandbox count, keyed on
// the provider's `running`, had already let the sandbox go.
test('a suspended or stopped machine is wakeable even with a fresh heartbeat', () => {
    for (const powerState of ['suspended', 'stopped'] as const)
        assert.equal(
            runtimeAvailability({
                runtime: ready,
                host: hosted(powerState),
                daemonOnline: true
            }),
            'wakeable'
        )
})

test('a running machine is available while its daemon is online', () => {
    assert.equal(
        runtimeAvailability({
            runtime: ready,
            host: hosted('running'),
            daemonOnline: true
        }),
        'available'
    )
    assert.equal(
        runtimeAvailability({
            runtime: ready,
            host: hosted('running'),
            daemonOnline: false
        }),
        'wakeable'
    )
})

// No reading yet (a machine just provisioned, a provider that reports none):
// the daemon's presence is all there is to go on.
test('a machine whose power is not known is judged by its daemon', () => {
    for (const powerState of ['unknown', null] as const) {
        assert.equal(
            runtimeAvailability({
                runtime: ready,
                host: hosted(powerState),
                daemonOnline: true
            }),
            'available'
        )
        assert.equal(
            runtimeAvailability({
                runtime: ready,
                host: hosted(powerState),
                daemonOnline: false
            }),
            'wakeable'
        )
    }
})

test('a self-owned computer answers to its daemon alone', () => {
    const local = { kind: 'local' as const, status: 'ready' as const, powerState: null }
    assert.equal(
        runtimeAvailability({ runtime: ready, host: local, daemonOnline: true }),
        'available'
    )
    assert.equal(
        runtimeAvailability({ runtime: ready, host: local, daemonOnline: false }),
        'offline'
    )
})

// Maintenance means the provider's health check found the machine broken:
// nothing may wake it, so neither a fresh heartbeat nor a running power
// reading can make it look usable.
test('a machine in maintenance is refused whatever its power or daemon say', () => {
    for (const powerState of ['running', 'suspended', 'stopped', null] as const)
        for (const daemonOnline of [true, false]) {
            const availability = runtimeAvailability({
                runtime: ready,
                host: { kind: 'hosted', status: 'maintenance', powerState },
                daemonOnline
            })
            assert.equal(availability, 'maintenance')
            assert.equal(isRuntimeUsable(availability), false)
        }
    assert.equal(
        runtimeAvailability({
            runtime: { status: 'installing' },
            host: { kind: 'hosted', status: 'maintenance', powerState: 'running' },
            daemonOnline: true
        }),
        'unavailable'
    )
})
