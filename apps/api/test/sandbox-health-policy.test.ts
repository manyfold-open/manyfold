import assert from 'node:assert/strict'
import test from 'node:test'
import type { SandboxHealthVerdict } from '@manyfold/shared'
import {
    RECHECK_LADDER_MS,
    REPAIRED_RECHECK_MS,
    decideTransition,
    maintenanceReasonText,
    recheckDelayMs,
    truncateReason
} from '../src/modules/sandboxes/health/sandbox-health-policy'

const PROBLEMS: SandboxHealthVerdict[] = [
    'unhealthy',
    'needs_repair',
    'repaired',
    'unknown'
]

// Healthy is the only way out, and the only verdict that never puts a sandbox
// in: an unknown status is a problem until a check says otherwise.
test('healthy exits maintenance and leaves a ready sandbox alone', () => {
    for (const source of ['manual', 'failure', 'recheck', 'sweep'] as const) {
        assert.deepEqual(
            decideTransition({
                verdict: 'healthy',
                status: 'maintenance',
                source,
                autoEnter: true,
                budgetLeft: true
            }),
            { action: 'exit' }
        )
        assert.deepEqual(
            decideTransition({
                verdict: 'healthy',
                status: 'ready',
                source,
                autoEnter: true,
                budgetLeft: true
            }),
            { action: 'none' }
        )
    }
})

test('any other verdict keeps a sandbox in maintenance', () => {
    for (const verdict of PROBLEMS)
        assert.deepEqual(
            decideTransition({
                verdict,
                status: 'maintenance',
                source: 'recheck',
                autoEnter: false,
                budgetLeft: false
            }),
            { action: 'stay' }
        )
})

// An admin's check always applies; an automatic one only while automatic entry
// is on (otherwise it is shadow mode) and the hourly budget has room (the
// circuit breaker against a provider-wide fault).
test('a problem verdict puts a ready sandbox in: always for an admin, gated for automatic checks', () => {
    for (const verdict of PROBLEMS) {
        assert.deepEqual(
            decideTransition({
                verdict,
                status: 'ready',
                source: 'manual',
                autoEnter: false,
                budgetLeft: false
            }),
            { action: 'enter' }
        )
        for (const source of ['failure', 'sweep'] as const) {
            assert.deepEqual(
                decideTransition({
                    verdict,
                    status: 'ready',
                    source,
                    autoEnter: true,
                    budgetLeft: true
                }),
                { action: 'enter' }
            )
            assert.deepEqual(
                decideTransition({
                    verdict,
                    status: 'ready',
                    source,
                    autoEnter: false,
                    budgetLeft: true
                }),
                { action: 'none', suppressed: 'shadow' }
            )
            assert.deepEqual(
                decideTransition({
                    verdict,
                    status: 'ready',
                    source,
                    autoEnter: true,
                    budgetLeft: false
                }),
                { action: 'none', suppressed: 'capped' }
            )
        }
    }
})

test('a sandbox that is not ready or in maintenance is never moved', () => {
    for (const status of ['provisioning', 'failed', 'deleting', 'retired'] as const)
        for (const verdict of [...PROBLEMS, 'healthy'] as const)
            assert.deepEqual(
                decideTransition({
                    verdict,
                    status,
                    source: 'manual',
                    autoEnter: true,
                    budgetLeft: true
                }),
                { action: 'none' }
            )
})

// Soon at first, because a fault that clears by itself clears fast; then
// hourly. A repair is checked within minutes whatever the step.
test('re-checks back off along the ladder, and a repair is checked again soon', () => {
    assert.deepEqual(
        [1, 2, 3, 4, 9].map((n) => recheckDelayMs('unhealthy', n)),
        [
            RECHECK_LADDER_MS[0],
            RECHECK_LADDER_MS[1],
            RECHECK_LADDER_MS[2],
            RECHECK_LADDER_MS[3],
            RECHECK_LADDER_MS[3]
        ]
    )
    assert.equal(recheckDelayMs('repaired', 4), REPAIRED_RECHECK_MS)
    assert.equal(recheckDelayMs(null, 0), RECHECK_LADDER_MS[0])
    assert.equal(RECHECK_LADDER_MS[RECHECK_LADDER_MS.length - 1], 60 * 60_000)
})

test('the reason names the verdict, and an unknown status keeps its literal', () => {
    assert.equal(
        maintenanceReasonText('unhealthy', 'unhealthy', 'failed to start machine'),
        'Health check: unhealthy — failed to start machine'
    )
    assert.equal(
        maintenanceReasonText('unknown', 'quarantined', null),
        'Health check: status "quarantined"'
    )
    const long = 'x'.repeat(2_000)
    assert.equal(truncateReason(long)?.length, 512)
    assert.equal(truncateReason(null), null)
})
