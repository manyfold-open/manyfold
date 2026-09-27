import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isTerminalAttachedElsewhereClose,
    isUpstreamTerminalSessionInfo
} from '../src/lib/terminalSession'

test('terminal reconnect budget resets only after the Sprite session opens', () => {
    // The API sends its own session_info before it has connected to sprites.dev.
    // Treating the browser socket (or this gateway frame) as success resets the
    // retry counter on every upstream 502 and turns the three-attempt cap into
    // an infinite reconnect loop.
    assert.equal(
        isUpstreamTerminalSessionInfo({
            type: 'session_info',
            agent_id: 'agt_1'
        }),
        false
    )
    assert.equal(
        isUpstreamTerminalSessionInfo({
            type: 'session_info',
            session_id: 'ses_1'
        }),
        true
    )
    assert.equal(
        isUpstreamTerminalSessionInfo({ type: 'error', message: 'HTTP 502' }),
        false
    )
})

test('a PTY on the host daemon has no second hop, so its session_info opens it', () => {
    // The API says `terminal_pty` on every daemon PTY, whatever the placement
    // (ADR-0036): a self-owned computer and a hosted sandbox alike.
    assert.equal(
        isUpstreamTerminalSessionInfo({
            type: 'session_info',
            runtime: 'daemon',
            terminal_pty: true
        }),
        true
    )
    assert.equal(
        isUpstreamTerminalSessionInfo({
            type: 'session_info',
            runtime: 'sprites',
            terminal_pty: false
        }),
        true
    )
    // A frame that names neither a PTY nor an upstream session is the
    // gateway speaking before anything opened: not enough.
    assert.equal(
        isUpstreamTerminalSessionInfo({
            type: 'session_info',
            runtime: 'sprites',
            sandbox_id: 'host_1'
        }),
        false
    )
})

test('a terminal taken over by another tab is not reconnected to', () => {
    // 4409 says the terminal is alive elsewhere (ADR-0029 §6); reconnecting
    // would take it straight back and the two tabs would trade it forever.
    assert.equal(isTerminalAttachedElsewhereClose(4409), true)
    assert.equal(isTerminalAttachedElsewhereClose(1006), false)
    assert.equal(isTerminalAttachedElsewhereClose(4410), false)
})
