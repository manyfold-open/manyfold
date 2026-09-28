import assert from 'node:assert/strict'
import test from 'node:test'
import type { DetectedFramework } from '@manyfold/shared'
import {
    PROBED_ENTRY_HOLD_MS,
    recordProbedEntries,
    withProbedEntries
} from '../src/modules/daemon/probed-inventory'

const NOW = new Date('2026-09-28T10:00:00.000Z')
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

const codex = (version: string, probedAt?: string): DetectedFramework => ({
    framework: 'codex',
    version,
    path: '/home/sprite/.local/bin/codex',
    ...(probedAt ? { probedAt } : {})
})
const pi: DetectedFramework = {
    framework: 'pi',
    version: '0.87.1',
    path: '/home/sprite/.local/bin/pi'
}

// Seen on a local stack [2026-09-28]: Codex moved to 0.158.0 in place read
// 0.151.0 again on the next heartbeat, the daemon's cache from before.
test("a version the API just probed outlasts the daemon's cached report", () => {
    const stored = [pi, codex('0.158.0', ago(60_000))]
    const reported = [pi, codex('codex-cli 0.151.0')]
    assert.deepEqual(withProbedEntries(stored, reported, NOW), [
        pi,
        codex('0.158.0', ago(60_000))
    ])
})

test('once the daemon has had time to re-detect, its report is the truth', () => {
    const stored = [codex('0.158.0', ago(PROBED_ENTRY_HOLD_MS + 1))]
    const reported = [codex('codex-cli 0.151.0')]
    assert.deepEqual(withProbedEntries(stored, reported, NOW), reported)
})

test('a probed CLI the daemon has not reported yet is kept too', () => {
    const stored = [pi, codex('0.158.0', ago(1_000))]
    assert.deepEqual(withProbedEntries(stored, [pi], NOW), [
        pi,
        codex('0.158.0', ago(1_000))
    ])
})

test('with nothing probed the report passes through as it came', () => {
    const reported = [pi, codex('codex-cli 0.151.0')]
    assert.equal(withProbedEntries([pi], reported, NOW), reported)
})

test('recording a probe stamps it and replaces what was there', () => {
    assert.deepEqual(
        recordProbedEntries(
            [pi, codex('codex-cli 0.151.0')],
            [codex('0.158.0')],
            NOW
        ),
        [pi, codex('0.158.0', NOW.toISOString())]
    )
})
