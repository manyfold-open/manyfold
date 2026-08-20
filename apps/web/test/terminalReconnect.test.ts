import assert from 'node:assert/strict'
import test from 'node:test'
import { isUpstreamTerminalSessionInfo } from '../src/lib/terminalSession'

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
