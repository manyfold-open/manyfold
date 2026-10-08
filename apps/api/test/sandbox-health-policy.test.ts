import assert from 'node:assert/strict'
import test from 'node:test'
import type { SandboxHealthVerdict } from '@manyfold/shared'
import {
    RECHECK_LADDER_MS,
    decideTransition,
    maintenanceReasonText,
    recheckDelayMs,
    truncateReason
} from '../src/modules/sandboxes/health/sandbox-health-policy'

const ALL: SandboxHealthVerdict[] = [
    'healthy',
    'unhealthy',
    'needs_repair',
    'repaired',
    'unknown'
]

// Measured on staging [2026-10-08]: a sleeping machine answers needs_repair
// and a stopped one repaired, so neither is a fault. Only unhealthy, a machine
// that failed to start, is.
test('healthy, needs_repair and repaired bring a sandbox out and leave a ready one alone', () => {
    for (const verdict of ['healthy', 'needs_repair', 'repaired'] as const)
        for (const source of ['manual', 'failure', 'recheck', 'sweep'] as const) {
            assert.deepEqual(
                decideTransition({
                    verdict,
                    status: 'maintenance',
                    source,
                    autoEnter: true,
                    budgetLeft: true
                }),
                { action: 'exit' },
                `${verdict} from ${source}`
            )
            assert.deepEqual(
                decideTransition({
                    verdict,
                    status: 'ready',
                    source,
                    autoEnter: true,
                    budgetLeft: true
                }),
                { action: 'none' },
                `${verdict} from ${source}`
            )
        }
})

// A status the platform has not seen yet is no evidence either way.
test('an unrecognised status moves nothing', () => {
    assert.deepEqual(
        decideTransition({
            verdict: 'unknown',
            status: 'maintenance',
            source: 'recheck',
            autoEnter: true,
            budgetLeft: true
        }),
        { action: 'stay' }
    )
    for (const source of ['manual', 'failure', 'sweep'] as const)
        assert.deepEqual(
            decideTransition({
                verdict: 'unknown',
                status: 'ready',
                source,
                autoEnter: true,
                budgetLeft: true
            }),
            { action: 'none' }
        )
})

test('unhealthy keeps a sandbox in maintenance', () => {
    assert.deepEqual(
        decideTransition({
            verdict: 'unhealthy',
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
test('unhealthy puts a ready sandbox in: always for an admin, gated for automatic checks', () => {
    const at = (
        source: 'manual' | 'failure' | 'sweep',
        autoEnter: boolean,
        budgetLeft: boolean
    ) =>
        decideTransition({
            verdict: 'unhealthy',
            status: 'ready',
            source,
            autoEnter,
            budgetLeft
        })
    assert.deepEqual(at('manual', false, false), { action: 'enter' })
    for (const source of ['failure', 'sweep'] as const) {
        assert.deepEqual(at(source, true, true), { action: 'enter' })
        assert.deepEqual(at(source, false, true), {
            action: 'none',
            suppressed: 'shadow'
        })
        assert.deepEqual(at(source, true, false), {
            action: 'none',
            suppressed: 'capped'
        })
    }
})

test('a sandbox that is not ready or in maintenance is never moved', () => {
    for (const status of ['provisioning', 'failed', 'deleting', 'retired'] as const)
        for (const verdict of ALL)
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
// hourly.
test('re-checks back off along the ladder', () => {
    assert.deepEqual(
        [1, 2, 3, 4, 9].map((n) => recheckDelayMs(n)),
        [
            RECHECK_LADDER_MS[0],
            RECHECK_LADDER_MS[1],
            RECHECK_LADDER_MS[2],
            RECHECK_LADDER_MS[3],
            RECHECK_LADDER_MS[3]
        ]
    )
    assert.equal(recheckDelayMs(0), RECHECK_LADDER_MS[0])
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
