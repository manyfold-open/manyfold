import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isDaemonNotDispatchedError,
    isDaemonOfflineTransportError
} from '../src/modules/chat/chat-adapter'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'

// These two predicates split every daemon rpc failure into the only two
// outcomes a daemon-carried turn can correctly have.
//
// SUSPEND (isDaemonOfflineTransportError): the frame reached the daemon and the
// socket died afterwards. The daemon is still running the work and will report
// the stream in its next hello, so writing a terminal here would make the turn
// unfindable by the resume path — the answer finishes with nowhere to go.
// `connection replaced` is the one that mattered: it is emitted by the RECONNECT
// itself, so the single most important recovery case read as a hard failure
// (staging 2026-07-26 restart drill: `claude_exec_failed: connection replaced`).
//
// FAIL RETRYABLY (isDaemonNotDispatchedError): the rpc never left the api. The
// connection lookup found no socket, or the rpc lease named an instance that
// does not hold one. Nothing started on the runner, so no hello will ever
// report this stream and no resume can match it — suspending parks the turn
// until the unmatched-turn sweep ages it out minutes later (staging 2026-08-03:
// two codex turns, zero tokens emitted, `server_restart` five minutes later).
//
// The two sets must stay disjoint, and every string here is one the daemon
// registry actually produces.

test('mid-stream socket loss suspends the turn', () => {
    for (const reason of [
        // register() superseding an old socket — the reconnect's own failPending
        'daemon dh_x rpc failed: connection replaced',
        // unregister() on socket close
        'exec stream failed: connection closed',
        // disconnectLocal() / forced disconnect
        'daemon disconnected',
        // broker onModuleDestroy: a rolling restart rejects RPCs relayed to a
        // peer instance with this — the daemon and its work are untouched, only
        // the relay process died (staging 2026-07-29 lost a hermes turn to it).
        'daemon rpc broker shutting down'
    ]) {
        assert.ok(
            isDaemonOfflineTransportError(reason),
            `must suspend, not terminalize: ${reason}`
        )
        assert.ok(
            !isDaemonNotDispatchedError(reason),
            `already dispatched, must not look re-sendable: ${reason}`
        )
    }
})

test('a lookup failure fails the turn instead of suspending it', () => {
    for (const reason of [
        // resolveRemoteInbox: no lease row inside DAEMON_RPC_LEASE_MS
        'daemon dh_x is offline; no active websocket',
        // streamRpcLocal / rpcLocal: this.conns has no socket. Reaches a turn
        // via the broker when the lease named an instance that has restarted.
        'daemon dh_x is not connected',
        // resolveRemoteInbox: the lease names us but conns disagrees
        'daemon dh_x websocket lease is stale on this api instance'
    ]) {
        assert.ok(
            isDaemonNotDispatchedError(reason),
            `nothing ran, must fail retryably: ${reason}`
        )
        // WHY this assertion is the point of the whole test: while these lived
        // in the suspend set, a turn that never emitted a byte sat inflight for
        // five minutes and then reported `server_restart`.
        assert.ok(
            !isDaemonOfflineTransportError(reason),
            `must not suspend a turn that never started: ${reason}`
        )
    }
})

test('an ambiguous reason favours suspend over failure', () => {
    // A forced disconnect can carry an arbitrary reason string. If one ever
    // reads like both classes, suspend must win: downgrading a mid-stream loss
    // to a failure discards output the daemon can still hand back, whereas the
    // reverse only costs a re-send.
    const reason = 'daemon disconnected: daemon dh_x is not connected'
    assert.ok(isDaemonOfflineTransportError(reason))
    assert.ok(!isDaemonNotDispatchedError(reason))
})

test('a real execution failure is neither', () => {
    // WHY: the suspend path leaves the turn open, so over-matching there hangs
    // genuinely broken turns; over-matching the not-dispatched set would tell
    // callers to re-send work that already burned tokens.
    for (const reason of [
        'claude exited 1: unknown option --effort',
        'spawn claude ENOENT',
        'exec timed out after 7200000ms',
        'HTTP 502'
    ]) {
        assert.ok(
            !isDaemonOfflineTransportError(reason),
            `must fail, not suspend: ${reason}`
        )
        assert.ok(
            !isDaemonNotDispatchedError(reason),
            `must not look re-sendable: ${reason}`
        )
    }
})

test('a daemon response is not reclassified by transport-like wording', () => {
    const error = new DaemonRpcResponseError('connection closed')

    assert.equal(isDaemonOfflineTransportError(error), false)
    assert.equal(isDaemonNotDispatchedError(error), false)
})
