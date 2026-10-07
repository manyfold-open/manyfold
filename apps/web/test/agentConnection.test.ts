import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiTokenSummary } from '@manyfold/shared'
import {
    IN_USE_WINDOW_MS,
    STALE_AFTER_MS,
    hasNewSignIn,
    isAgentSignIn,
    summarizeAgentConnection
} from '../src/lib/agentConnection'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

const token = (patch: Partial<ApiTokenSummary> = {}): ApiTokenSummary => ({
    id: 'tok-1',
    name: 'mf CLI 2026-10-01',
    scopes: ['api.full'],
    lastUsedAt: null,
    expiresAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null,
    createdAt: ago(86_400_000),
    agentId: null,
    createdVia: 'cli-browser',
    ...patch
})

test('only mf login sign-ins count as an agent connection', () => {
    assert.equal(isAgentSignIn(token()), true)
    assert.equal(isAgentSignIn(token({ createdVia: 'cli-poll' })), true)
    assert.equal(
        isAgentSignIn(token({ createdVia: 'api', name: 'mf CLI 2026-10-01' })),
        false
    )
    assert.equal(
        isAgentSignIn(token({ createdVia: null, name: 'deploy script' })),
        false
    )
    assert.equal(isAgentSignIn(token({ agentId: 'agent-1' })), false)
})

test('untagged sign-ins from before the API tagged them still count', () => {
    assert.equal(
        isAgentSignIn(token({ createdVia: null, name: 'mf CLI 2026-08-30' })),
        true
    )
    assert.equal(
        isAgentSignIn(token({ createdVia: null, name: 'mf CLI backup' })),
        false
    )
})

test('no live sign-in reads as not connected', () => {
    assert.equal(summarizeAgentConnection([], NOW).state, 'none')
    assert.equal(
        summarizeAgentConnection(
            [token({ revokedAt: ago(1000), lastUsedAt: ago(1000) })],
            NOW
        ).state,
        'none'
    )
    assert.equal(
        summarizeAgentConnection(
            [token({ expiresAt: ago(1000), lastUsedAt: ago(5000) })],
            NOW
        ).state,
        'none'
    )
})

test('a request inside the window reads as in use, just outside as connected', () => {
    const inside = token({ lastUsedAt: ago(IN_USE_WINDOW_MS - 1000) })
    const outside = token({ lastUsedAt: ago(IN_USE_WINDOW_MS + 1000) })
    assert.equal(summarizeAgentConnection([inside], NOW).state, 'in-use')
    assert.equal(summarizeAgentConnection([outside], NOW).state, 'connected')
})

test('a fresh sign-in that has not called yet is connected', () => {
    const fresh = token({ createdAt: ago(10_000), lastUsedAt: null })
    const summary = summarizeAgentConnection([fresh], NOW)
    assert.equal(summary.state, 'connected')
    assert.equal(summary.lastUsedAt, null)
})

test('a sign-in idle for longer than the stale window offers setup again', () => {
    const stale = token({
        createdAt: ago(STALE_AFTER_MS + 2 * 86_400_000),
        lastUsedAt: ago(STALE_AFTER_MS + 86_400_000)
    })
    assert.equal(summarizeAgentConnection([stale], NOW).state, 'none')
})

test('several sign-ins report the latest request and the first sign-in', () => {
    const older = token({
        id: 'tok-old',
        createdAt: ago(5 * 86_400_000),
        lastUsedAt: ago(30_000)
    })
    const newer = token({
        id: 'tok-new',
        createdAt: ago(86_400_000),
        lastUsedAt: ago(3_600_000)
    })
    const summary = summarizeAgentConnection([older, newer], NOW)
    assert.equal(summary.state, 'in-use')
    assert.deepEqual(
        summary.signIns.map((t) => t.id),
        ['tok-new', 'tok-old']
    )
    assert.equal(summary.lastUsedAt, ago(30_000))
    assert.equal(summary.firstSignedInAt, older.createdAt)
})

test('a sign-in missing from the snapshot is the one just connected', () => {
    const existing = token({ id: 'tok-1' })
    const before = summarizeAgentConnection([existing], NOW)
    const after = summarizeAgentConnection(
        [existing, token({ id: 'tok-2', createdAt: ago(1000) })],
        NOW
    )
    const known = new Set(before.signIns.map((t) => t.id))
    assert.equal(hasNewSignIn(before, known), false)
    assert.equal(hasNewSignIn(after, known), true)
})
