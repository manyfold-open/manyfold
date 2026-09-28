import test from 'node:test'
import assert from 'node:assert/strict'
import {
    HEARTBEAT_PROVES_RUNNING_MS,
    correctedPower
} from '../src/modules/agents/sprite-status/corrected-power'

const now = new Date('2026-09-28T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

// WHY: availability, the concurrency caps and active-hours metering all read
// this one value; if any of them derived "running" differently, a sandbox
// could hold a slot without accruing, or accrue without holding one.
test('correctedPower raises a listing to running only while the daemon proves it', () => {
    const cases: Array<{
        listed: 'running' | 'suspended' | 'stopped' | 'unknown'
        heartbeatAt: Date | null
        expected: string
    }> = [
        { listed: 'running', heartbeatAt: null, expected: 'running' },
        { listed: 'running', heartbeatAt: ago(60_000), expected: 'running' },
        { listed: 'suspended', heartbeatAt: null, expected: 'suspended' },
        { listed: 'suspended', heartbeatAt: ago(5_000), expected: 'running' },
        { listed: 'stopped', heartbeatAt: ago(5_000), expected: 'running' },
        { listed: 'unknown', heartbeatAt: ago(5_000), expected: 'running' },
        {
            listed: 'stopped',
            heartbeatAt: ago(HEARTBEAT_PROVES_RUNNING_MS - 1),
            expected: 'running'
        },
        {
            listed: 'stopped',
            heartbeatAt: ago(HEARTBEAT_PROVES_RUNNING_MS),
            expected: 'stopped'
        },
        { listed: 'suspended', heartbeatAt: ago(60_000), expected: 'suspended' }
    ]
    for (const { listed, heartbeatAt, expected } of cases)
        assert.equal(
            correctedPower({ listed, heartbeatAt, now }),
            expected,
            `${listed} with heartbeat ${heartbeatAt?.toISOString() ?? 'none'}`
        )
})
