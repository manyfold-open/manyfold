import assert from 'node:assert/strict'
import test from 'node:test'
import {
    canCheckHealth,
    checkedAgo,
    healthLabel,
    healthTone,
    maintenanceLine
} from '../src/lib/sandboxHealth'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

// A broken machine reads as the error, a repair as needing attention, and an
// unrecognised status stays neutral rather than borrowing a colour it has not
// earned.
test('each verdict has its tone and a readable label', () => {
    assert.equal(healthTone('healthy'), 'success')
    assert.equal(healthTone('unhealthy'), 'error')
    assert.equal(healthTone('needs_repair'), 'warning')
    assert.equal(healthTone('repaired'), 'warning')
    assert.equal(healthTone('unknown'), 'neutral')
    assert.equal(healthLabel('needs_repair'), 'needs repair')
})

test('only a ready sandbox or one in maintenance can be checked', () => {
    assert.equal(canCheckHealth('ready'), true)
    assert.equal(canCheckHealth('maintenance'), true)
    for (const status of ['provisioning', 'failed', 'deleting', 'retired'] as const)
        assert.equal(canCheckHealth(status), false)
})

test('a sandbox in maintenance says for how long, when it is asked again and how many bad checks', () => {
    assert.equal(
        maintenanceLine(
            {
                status: 'maintenance',
                maintenanceSince: at(-2 * 3_600_000),
                health: {
                    status: 'unhealthy',
                    reason: 'failed to start machine',
                    checkedAt: at(-60_000),
                    nextCheckAt: at(8 * 60_000),
                    failureCount: 3
                }
            },
            NOW
        ),
        'maintenance for 2 h · next check in 8 min · 3 bad checks in a row'
    )
    assert.equal(
        maintenanceLine(
            {
                status: 'maintenance',
                maintenanceSince: at(-90_000),
                health: {
                    status: 'repaired',
                    reason: null,
                    checkedAt: at(-90_000),
                    nextCheckAt: at(-1_000),
                    failureCount: 1
                }
            },
            NOW
        ),
        'maintenance for 2 min · re-check due · 1 bad check in a row'
    )
    assert.equal(
        maintenanceLine(
            { status: 'ready', maintenanceSince: null, health: null },
            NOW
        ),
        null
    )
})

test('the last check reads as a coarse age', () => {
    assert.equal(checkedAgo(at(-10_000), NOW), 'checked just now')
    assert.equal(checkedAgo(at(-25 * 60_000), NOW), 'checked 25 min ago')
    assert.equal(checkedAgo(at(-3 * 86_400_000), NOW), 'checked 3 d ago')
})
