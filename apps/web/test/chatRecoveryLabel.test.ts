import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryLabelKey } from '../src/components/chat/utils/recoveryLabel'
import type { StreamStatus } from '../src/lib/chatStreamStore'

// #674. The precedence table between the transport state the tab already knows
// and the recovery the server just announced. The production daemon sequence is
// `suspended` → `turn_status(resuming)`, and suppressing the label under
// `suspended` meant the first "Resuming…" was never shown: the hint was set,
// had reached the browser, and was then wiped by the first real output.

const statuses: StreamStatus[] = [
    'idle',
    'connecting',
    'streaming',
    'suspended',
    'cancelling',
    'error',
    'cancelled'
]

test('no recovery phase means no recovery label, whatever the status', () => {
    for (const status of statuses)
        assert.equal(
            recoveryLabelKey(status, null),
            null,
            `status ${status} invented a label out of nothing`
        )
})

test('a resume announced after a suspension is what the user is shown', () => {
    // The store only ever sets recoveryPhase from a turn_status row and clears
    // it on every suspended row, so this pairing is proof of ordering: the
    // server said "resuming" AFTER the device dropped, which makes the old
    // "waiting for this device to reconnect" the stale half of the two.
    assert.equal(
        recoveryLabelKey('suspended', 'resuming'),
        'web.chatStream.resuming'
    )
    assert.equal(
        recoveryLabelKey('suspended', 'recovering'),
        'web.chatStream.recovering'
    )
})

test('recovery outranks the mid-flight states it explains', () => {
    for (const status of [
        'idle',
        'connecting',
        'streaming',
        'error'
    ] as StreamStatus[]) {
        assert.equal(
            recoveryLabelKey(status, 'resuming'),
            'web.chatStream.resuming'
        )
        assert.equal(
            recoveryLabelKey(status, 'recovering'),
            'web.chatStream.recovering'
        )
    }
})

test('a cancel still outranks any recovery', () => {
    // Not because it is newer, but because the user asked for this turn to
    // stop: no server-side rebuild changes what they asked for, and showing
    // "Resuming…" over an accepted cancel would read as the stop being ignored.
    for (const status of ['cancelling', 'cancelled'] as StreamStatus[])
        for (const phase of ['resuming', 'recovering'] as const)
            assert.equal(
                recoveryLabelKey(status, phase),
                null,
                `${status} lost to ${phase}`
            )
})

test('the two phases never collapse into one label', () => {
    // A daemon picking its runner stream back up is a different story from
    // adoption rebuilding the answer from a transcript.
    assert.notEqual(
        recoveryLabelKey('suspended', 'resuming'),
        recoveryLabelKey('suspended', 'recovering')
    )
})
