import assert from 'node:assert/strict'
import test from 'node:test'
import { buildK8sTerminalCommand } from '../src/modules/terminal/k8s-terminal'
import {
    buildSpritesTerminalExecUrl,
    terminalHandshakeRetryDelayMs
} from '../src/modules/terminal/sprites-terminal'

test('sprites terminal exec URL uses requested cwd as dir', () => {
    const url = new URL(
        buildSpritesTerminalExecUrl('wss://api.sprites.dev/v1', 'sprite one', {
            cmd: ['bash', '-il'],
            dir: '/home/sprite/.codex',
            cols: 80,
            rows: 24
        })
    )

    assert.equal(url.pathname, '/v1/sprites/sprite%20one/exec')
    assert.equal(url.searchParams.get('dir'), '/home/sprite/.codex')
})

test('sprites terminal retries transient gateway handshake failures with a bound', () => {
    // A downstream browser WebSocket can be healthy while sprites.dev is still
    // waking. Retry that upstream handshake in-place, but never loop forever or
    // retry auth/client failures.
    assert.equal(terminalHandshakeRetryDelayMs(502, 1), 250)
    assert.equal(terminalHandshakeRetryDelayMs(503, 2), 750)
    assert.equal(terminalHandshakeRetryDelayMs(504, 3), null)
    assert.equal(terminalHandshakeRetryDelayMs(401, 1), null)
})

test('k8s terminal command cd uses requested cwd with shell quoting', () => {
    const command = buildK8sTerminalCommand("/home/node/project's dir")

    assert.deepEqual(command.slice(0, 2), ['sh', '-c'])
    assert.match(
        command[2],
        /cd '\/home\/node\/project'\\''s dir' && \(command -v bash/
    )
})
