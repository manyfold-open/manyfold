import assert from 'node:assert/strict'
import test from 'node:test'
import { validateApiEnv } from '../src/common/validate-api-env'

test('canonical configuration passes through without mutation', () => {
    const env = { MF_WEB_URL: 'https://example.test', MF_VERSION: '5.0.0' }
    assert.equal(validateApiEnv(env), env)
})

test('retired configuration fails startup without revealing its value', () => {
    const value = 'https://private.example.test/credential'
    assert.throws(
        () => validateApiEnv({ NCA_WEB_URL: value, MF_WEB_URL: value }),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.match(error.message, /NCA_WEB_URL/)
            assert.ok(!error.message.includes(value))
            return true
        }
    )
})

test('the retired startup migration cannot silently ignore a configured timeout', () => {
    assert.throws(
        () => validateApiEnv({ A2A_TURN_TIMEOUT_MS: '123456' }),
        /A2A_TURN_TIMEOUT_MS/
    )
    assert.doesNotThrow(() => validateApiEnv({ WEB_BASE_URL: '  ' }))
})
