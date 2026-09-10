import assert from 'node:assert/strict'
import test from 'node:test'
import {
    redactCredentialText,
    redactCredentialValue
} from '../src/common/telemetry/redact-credentials'
import { redactSensitiveUrlQuery } from '../src/common/telemetry/redact-url'
import { credentialDiagLogger } from '../src/common/telemetry/credential-diag-logger'
import { describeFatalError } from '../src/fatal-error'

const secret = 'sentinel-sensitive/+='
const encoded = encodeURIComponent(secret)
const examples = [
    `wss://api.test/api/daemon/ws?token=${encoded}&state=ready`,
    `/api/daemon/ws?ToKeN=${encoded}&state=ready`,
    `/api/daemon/ws?to%6ben=${encoded}&token=${encoded}&state=ready`,
    `wss://api.test/api/daemon/ws?token=${secret}`,
    `wss://[invalid/api/daemon/ws?token=${encoded}&state=ready`,
    `https://user:${encoded}@api.test/path?state=ready`
]

const assertScrubbed = (value: unknown): void => {
    const text = JSON.stringify(value)
    assert(!text.includes(secret), 'raw credential survives')
    assert(!text.includes(encoded), 'encoded credential survives')
}

test('URL redaction handles relative, malformed, duplicate and encoded credential keys', () => {
    for (const raw of examples) {
        const clean = redactSensitiveUrlQuery(raw)
        assertScrubbed(clean)
        if (raw.includes('state=ready')) assert(clean.includes('state=ready'))
    }
})

test('free-text redaction preserves diagnostics around credential-bearing URLs', () => {
    for (const raw of examples) {
        const clean = redactCredentialText(
            `runner failed: ${raw} unauthorized 4401`
        )
        assertScrubbed(clean)
        assert(clean.startsWith('runner failed: '))
        assert(clean.endsWith(' unauthorized 4401'))
        if (raw.includes('state=ready')) assert(clean.includes('state=ready'))
    }
    assertScrubbed(redactCredentialText(`Authorization: Bearer ${secret}`))
    assertScrubbed(redactCredentialText(`{"access_token":"${secret}"}`))
    assertScrubbed(redactCredentialText(`token=${encoded}`))
})

test('structured records scrub headers, nested credentials and error causes', () => {
    const cause = new Error(`runner tail ${examples[0]}`)
    const error = new Error('bring-up failed', { cause })
    const value = {
        error,
        headers: { Authorization: `Bearer ${secret}`, Cookie: secret },
        accounts: [{ apiKey: secret, accessToken: secret, tokenId: 'ldt_id' }],
        'http.request.header.authorization': `Bearer ${secret}`,
        'url.query': `token=${encoded}`,
        state: 'failed'
    }
    const clean = redactCredentialValue(value) as typeof value
    assertScrubbed(clean)
    assert.equal(clean.state, 'failed')
    assert.equal(clean.accounts[0].tokenId, 'ldt_id')
    assert(!('url.query' in clean))
    assert(
        cause.message.includes(encoded),
        'redaction must not mutate the original error'
    )
    assert.equal(value.accounts[0].apiKey, secret)
})

test('logging circular or uninspectable values does not throw', () => {
    const circular: Record<string, unknown> = { token: secret }
    circular.self = circular
    assertScrubbed(redactCredentialValue(circular))
    assert.equal(redactCredentialValue(new Date('invalid')), 'Invalid Date')
    const uninspectable = {
        get value(): never {
            throw new Error(secret)
        }
    }
    assert.equal(redactCredentialValue(uninspectable), '[Unserializable]')
})

test('OTel diagnostic logging scrubs every console level', (t) => {
    const output: string[] = []
    // DiagConsoleLogger retains the original console methods at module load.
    // Capture their real destinations rather than replacing console afterward.
    for (const stream of [process.stdout, process.stderr])
        t.mock.method(stream, 'write', (chunk: unknown) => {
            output.push(String(chunk))
            return true
        })
    const logger = credentialDiagLogger()
    for (const level of ['error', 'warn', 'info', 'debug', 'verbose'] as const)
        logger[level](`export failed ${examples[0]}`, {
            authorization: `Bearer ${secret}`
        })
    assert.equal(output.join('').match(/export failed/g)?.length, 5)
    assertScrubbed(output)
})

test('fatal error diagnostics scrub before truncation and direct console output', () => {
    const error = new Error(`failed ${examples[0]}`)
    const detail = describeFatalError(error)
    assert.equal(detail.errorClass, 'Error')
    assert(detail.stack?.includes('failed'))
    assertScrubbed(detail)
    assertScrubbed(
        describeFatalError({
            authorization: `Bearer ${secret}`,
            url: examples[0]
        })
    )
})
