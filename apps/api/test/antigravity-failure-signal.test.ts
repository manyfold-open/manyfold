import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { classifyAntigravityFailureSignal } from '../src/modules/chat/managed-channel-failure-signal'

// agy 1.2.11 against a local endpoint answering the gateway's exact empty-pool
// body (see fixtures/antigravity-cli/1.2.11/README.md): the AGY_ERROR line's
// short_error is the Gemini SDK's rendering of the refusal.
const shortErrorOf = (stderr: string): string => {
    const line = stderr.split('\n').find((l) => l.startsWith('AGY_ERROR: '))!
    return JSON.parse(line.slice('AGY_ERROR: '.length)).short_error
}
const CAPTURED = shortErrorOf(
    readFileSync(
        join(
            __dirname,
            'fixtures',
            'antigravity-cli',
            '1.2.11',
            'turn-pool-empty-503.stderr.txt'
        ),
        'utf8'
    )
)

const refusal = (code: number, message: string, status = 'UNAVAILABLE') =>
    `agent executor error: generating and executing: Error ${code}, Message: ${message}, Status: ${status}, Details: []`

test('the empty-pool 503 agy printed marks the managed channel', () => {
    assert.equal(
        classifyAntigravityFailureSignal(CAPTURED),
        'account_pool_empty'
    )
    assert.equal(
        classifyAntigravityFailureSignal(
            refusal(503, 'No available Antigravity accounts')
        ),
        'account_pool_empty'
    )
})

test('lookalikes never mark it', () => {
    for (const shortError of [
        refusal(503, 'The model is overloaded. Please try again later.'),
        refusal(502, 'Service temporarily unavailable'),
        refusal(503, 'Service temporarily unavailable, please retry later'),
        refusal(
            429,
            'Resource has been exhausted (e.g. check quota).',
            'RESOURCE_EXHAUSTED'
        ),
        'Service temporarily unavailable',
        ''
    ])
        assert.equal(
            classifyAntigravityFailureSignal(shortError),
            null,
            shortError
        )
    assert.equal(classifyAntigravityFailureSignal(null), null)
})
