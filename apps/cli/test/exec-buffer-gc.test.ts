import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The exec buffer is the daemon's durable turn log — the thing that lets a turn
// survive an api restart. It also grew without bound: measured on 2026-07-28,
// one staging daemon advertised 20559 "inflight" streams (exactly 1 was an
// unfinished turn) and prod daemons sat at ~4800, climbing every day for a week
// with no decline. Two independent causes, one test file:
//
//   1. `enumerateInflightForHello` skipped a completed stream only when it was
//      NOT in the in-memory map — but that map sheds an entry only when GC
//      removes its buffer, so a long-lived daemon re-advertised every turn it
//      had ever run, forever. Every entry also costs a full read+parse of that
//      turn's event log (lastSeq) on every reconnect, and daemons reconnect
//      constantly (78 times in one day for one prod daemon).
//   2. GC ran once, from start(), so a daemon up for weeks never reclaimed
//      anything; and its terminal-grace branch needed an in-memory completedAt,
//      which a restarted daemon never has for earlier buffers.
//
// daemonPaths is resolved from homedir() at import time, so HOME is redirected
// before the dynamic import to keep this off the developer's real daemon.
const home = mkdtempSync(join(tmpdir(), 'mf-exec-buffer-'))
process.env.HOME = home
process.env.MF_PROFILE = 'gctest'

const {
    ExecStream,
    execStreams,
    gcStaleBuffers,
    enumerateInflightForHello
} = await import('../src/daemon/exec-buffer')
const { rpcHandler } = await import('../src/daemon/rpc')
const { daemonPaths } = await import('../src/daemon/config')

const MINUTE = 60 * 1000
// Mirrors COMPLETE_GRACE_MS: one hour since #518 — the server was still
// consuming a completed stream 5.5min after the exec finished, and the 5min
// grace let a rolling-deploy hello disown it.
const GRACE_MS = 60 * MINUTE

const startStream = (refId: string): InstanceType<typeof ExecStream> => {
    const stream = new ExecStream({
        refId,
        method: 'exec.start',
        payload: {}
    })
    execStreams.set(refId, stream)
    return stream
}

const refIds = (list: Array<{ refId: string }>): string[] =>
    list.map((s) => s.refId).sort()

test('a finished turn stops being advertised once its grace passes', () => {
    const done = startStream('finished-1')
    done.publish('stdout', 'hello\n')
    done.complete({ ok: true, payload: { exitCode: 0 } }, 'completed')
    const finishedAt = done.completedAt as number

    // Inside the grace it is still worth offering: the api may never have
    // received the final before the socket dropped.
    assert.deepEqual(
        refIds(enumerateInflightForHello(finishedAt + MINUTE)),
        ['finished-1']
    )

    // WHY this is the whole bug: the stream is STILL in the in-memory map here,
    // which is exactly the condition the old rule used to keep advertising it.
    assert.ok(execStreams.get('finished-1'), 'still in memory')
    assert.deepEqual(
        enumerateInflightForHello(finishedAt + GRACE_MS + MINUTE),
        [],
        'a long-lived daemon must not re-advertise history'
    )
})

test('a running turn is always advertised', () => {
    const live = startStream('running-1')
    live.publish('stdout', 'partial\n')

    const advertised = enumerateInflightForHello(Date.now() + 24 * 60 * MINUTE)
    const entry = advertised.find((s) => s.refId === 'running-1')
    assert.ok(entry, 'a running turn is the one thing that must never be hidden')
    assert.equal(entry.status, 'running')
    // lastSeq is what the server resumes from.
    assert.equal(entry.lastSeq, 1)
})

test('a crashed turn stays advertised so the api can collect what it produced', () => {
    const crashed = startStream('crashed-1')
    crashed.publish('stdout', 'got this far\n')
    crashed.complete({ ok: false, error: 'boom' }, 'crashed')
    const at = crashed.completedAt as number

    // WHY: resuming a crashed buffer replays its output and then reports the
    // failure, which converges the turn WITH its partial content instead of
    // leaving it hanging. That is worth offering right after the daemon comes
    // back — which is when completedAt was stamped.
    assert.ok(
        enumerateInflightForHello(at + MINUTE).some(
            (s) => s.refId === 'crashed-1'
        )
    )
})

test('gc reclaims a finished buffer after a restart, not 24h later', () => {
    const stream = startStream('restart-1')
    stream.publish('stdout', 'x\n')
    stream.complete({ ok: true }, 'completed')
    const finishedAt = stream.completedAt as number

    // A restarted daemon has an empty map, so the only completedAt available is
    // the one in meta.json. Relying on the in-memory value made every buffer
    // from a previous process wait out the full 24h age rule.
    execStreams.delete('restart-1')
    const dir = join(daemonPaths.execDir, 'restart-1')
    assert.ok(existsSync(dir))

    assert.equal(gcStaleBuffers(finishedAt + MINUTE), 0, 'grace is respected')
    assert.ok(existsSync(dir))

    assert.ok(gcStaleBuffers(finishedAt + GRACE_MS + MINUTE) >= 1)
    assert.ok(!existsSync(dir), 'buffer reclaimed')
})

test('gc never touches a running turn', () => {
    startStream('running-2')
    // Far past both the grace and the 24h age rule: an in-flight turn must
    // survive regardless, or GC would delete the log a resume needs.
    gcStaleBuffers(Date.now() + 48 * 60 * MINUTE)
    assert.ok(
        readdirSync(daemonPaths.execDir).includes('running-2'),
        'a running buffer is never collected'
    )
})

test('cancelling exec.resume detaches its live-stream subscriber', async () => {
    const stream = startStream('resume-cancel-1')
    let cancel!: () => void
    const result = rpcHandler(
        'exec.resume',
        { originalRefId: stream.refId, fromSeq: 0 },
        {
            refId: 'resume-request-1',
            sendEvent: () => undefined,
            onCancel: (handler) => {
                cancel = handler
            }
        }
    )

    try {
        assert.equal(stream.subscribers.size, 1)
        assert.ok(cancel, 'exec.resume must install a cancellation handler')
        cancel()
        assert.equal(stream.subscribers.size, 0)
        assert.deepEqual(await result, { ok: false, error: 'cancelled' })
    } finally {
        stream.complete({ ok: true }, 'completed')
        await result
    }
})
