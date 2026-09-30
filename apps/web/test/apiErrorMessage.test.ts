import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@manyfold/sdk'
import { apiErrorMessage } from '../src/lib/errorMessage'

const apiError = (code: string, details?: unknown): ApiError =>
    new ApiError({
        status: 503,
        statusText: 'Service Unavailable',
        code,
        message: `server said ${code}`,
        serverMessage: `server said ${code}`,
        body: '',
        details
    })

// The sandbox errors name the address the sandbox had to reach, which only
// the envelope's details carry.
test('a translated API error names the values its details carry', () => {
    assert.equal(
        apiErrorMessage(
            apiError('SANDBOX_RUNNER_NOT_CONNECTED', {
                hostId: 'sbx_1',
                apiUrl: 'https://tunnel.example.com/api',
                reason: 'runner_unavailable',
                registerFailure: 'cli Error: Unable to connect.'
            })
        ),
        "The new sandbox couldn't connect back to Manyfold at https://tunnel.example.com/api. Retry it; if it fails again, the sandbox provider can't reach that address."
    )
    assert.match(
        apiErrorMessage(
            apiError('SANDBOX_API_UNREACHABLE', {
                apiUrl: 'http://localhost:7170/api'
            })
        ),
        /^Sandboxes can't connect back to Manyfold at http:\/\/localhost:7170\/api, so none was built\./
    )
})

test('a code with no translation keeps what the server said', () => {
    assert.equal(
        apiErrorMessage(apiError('SOMETHING_NEW', { apiUrl: 'x' })),
        'server said SOMETHING_NEW'
    )
})

test('a translation without placeholders reads the same with details or without', () => {
    const plain = apiErrorMessage(apiError('RUNTIME_LIMIT_REACHED'))
    assert.equal(
        apiErrorMessage(
            apiError('RUNTIME_LIMIT_REACHED', { current: 1, limit: 1, kind: 'sprites' })
        ),
        plain
    )
    assert.match(plain, /number of sandboxes your plan allows/)
})
