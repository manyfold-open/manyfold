import test from 'node:test'
import assert from 'node:assert/strict'
import {
    API_TOKEN_STATUS_DOT,
    apiTokenExpiryLabel,
    apiTokenStatus,
    apiTokenStatusLabelKey
} from '../src/lib/apiTokenStatus'

const NOW = new Date('2026-06-15T12:00:00.000Z')
const past = '2026-01-01T00:00:00.000Z'
const future = '2027-01-01T00:00:00.000Z'

test('a live token with no expiry is active', () => {
    assert.equal(
        apiTokenStatus({ revokedAt: null, expiresAt: null }, NOW),
        'active'
    )
})

test('a future expiry is still active', () => {
    assert.equal(
        apiTokenStatus({ revokedAt: null, expiresAt: future }, NOW),
        'active'
    )
})

test('a past expiry is expired', () => {
    assert.equal(
        apiTokenStatus({ revokedAt: null, expiresAt: past }, NOW),
        'expired'
    )
})

test('expiry is inclusive of the instant it lands', () => {
    assert.equal(
        apiTokenStatus({ revokedAt: null, expiresAt: NOW.toISOString() }, NOW),
        'expired'
    )
})

test('revocation wins over expiry', () => {
    // Both true: the reader revoked this token, and that is the fact that
    // explains why it stopped working.
    assert.equal(
        apiTokenStatus({ revokedAt: past, expiresAt: past }, NOW),
        'revoked'
    )
    assert.equal(
        apiTokenStatus({ revokedAt: past, expiresAt: future }, NOW),
        'revoked'
    )
})

test('every status has a dot class and a label key', () => {
    for (const status of ['active', 'expired', 'revoked'] as const) {
        assert.ok(API_TOKEN_STATUS_DOT[status])
        assert.match(apiTokenStatusLabelKey(status), /^web\.apiTokens\.status/)
    }
})

test('a future expiry renders as a date, not as the empty placeholder', () => {
    // The relative formatter next to this one on the dashboard returns '—'
    // for anything in the future, which is every expiry that has not fired
    // yet — so the whole column read as unknown.
    //
    // Asserting the rendered year would be asserting the runner's timezone:
    // 2027-01-01T00:00:00Z is 12/31/2026 anywhere west of UTC, which is where
    // this first went red. What matters is that it is a date at all.
    const label = apiTokenExpiryLabel({ expiresAt: future }, () => 'never')
    assert.notEqual(label, '—')
    assert.notEqual(label, 'never')
    assert.match(label, /\d/)
})

test('no expiry falls back to the catalog string', () => {
    assert.equal(
        apiTokenExpiryLabel({ expiresAt: null }, (key) => `t:${key}`),
        't:web.apiTokens.neverExpires'
    )
})
