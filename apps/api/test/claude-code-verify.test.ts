import assert from 'node:assert/strict'
import test from 'node:test'
import { BootstrapError } from '../src/modules/agents/bootstrap/framework-bootstrap'
import { assertClaudePrintSucceeded } from '../src/modules/agents/bootstrap/claude-code-verify'
import {
    CLAUDE_VERIFY_TIMEOUT_MS,
    claudeVerifyTimeoutMs
} from '../src/modules/agents/bootstrap/claude-code'

test('claudeVerifyTimeoutMs does not inherit the short setup command budget', () => {
    assert.equal(claudeVerifyTimeoutMs(60_000), CLAUDE_VERIFY_TIMEOUT_MS)
    assert.equal(claudeVerifyTimeoutMs(240_000), 240_000)
})

test('assertClaudePrintSucceeded surfaces Claude JSON error from stdout', () => {
    assert.throws(
        () =>
            assertClaudePrintSucceeded(
                {
                    exitCode: 1,
                    stdout: JSON.stringify({
                        type: 'result',
                        is_error: true,
                        result: 'Failed to authenticate. API Error: 403 Insufficient account balance'
                    }),
                    stderr: ''
                },
                'claude-verify'
            ),
        (err: unknown) => {
            assert.ok(err instanceof BootstrapError)
            assert.equal(err.step, 'claude-verify')
            assert.match(err.message, /403 Insufficient account balance/)
            return true
        }
    )
})

test('assertClaudePrintSucceeded falls back to stdout for non-json process failures', () => {
    assert.throws(
        () =>
            assertClaudePrintSucceeded(
                {
                    exitCode: 1,
                    stdout: 'plain stdout failure',
                    stderr: ''
                },
                'claude-verify'
            ),
        /claude --print exited 1: plain stdout failure/
    )
})

test('assertClaudePrintSucceeded accepts successful Claude JSON', () => {
    assert.doesNotThrow(() =>
        assertClaudePrintSucceeded(
            {
                exitCode: 0,
                stdout: JSON.stringify({ is_error: false, result: 'pong' }),
                stderr: ''
            },
            'claude-verify'
        )
    )
})

test('assertClaudePrintSucceeded rejects non-json success output', () => {
    assert.throws(
        () =>
            assertClaudePrintSucceeded(
                { exitCode: 0, stdout: 'not json', stderr: '' },
                'claude-verify'
            ),
        /claude --print did not return JSON: not json/
    )
})
