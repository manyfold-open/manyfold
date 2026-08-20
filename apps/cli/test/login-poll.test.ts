import test from 'node:test'
import assert from 'node:assert/strict'
import type { CliLoginPollResponse } from '@manyfold/shared'
import {
    parseScopes,
    pollUntilApproved,
    resolveLoginMode,
    shouldWaitForPollApproval
} from '../src/commands/login'

test('parseScopes accepts comma-separated grant scopes and deduplicates', () => {
    assert.deepEqual(parseScopes('channels:read,channels:edit'), [
        'channels:read',
        'channels:edit'
    ])
    assert.deepEqual(
        parseScopes('channels:edit, channels:read , channels:edit'),
        ['channels:edit', 'channels:read']
    )
})

test('parseScopes rejects api.full / chat.completions / unknown', () => {
    assert.throws(() => parseScopes('api.full'), /unknown grant scope/)
    assert.throws(() => parseScopes('chat.completions'), /unknown grant scope/)
    assert.throws(() => parseScopes('nonsense:read'), /unknown grant scope/)
})

test('parseScopes rejects empty list', () => {
    assert.throws(() => parseScopes(''), /at least one/)
    assert.throws(() => parseScopes(',,'), /at least one/)
})

test('resolveLoginMode poll requires --scopes and forbids --token', () => {
    assert.equal(
        resolveLoginMode({ poll: true, scopes: 'channels:read' }, false),
        'poll'
    )
    assert.throws(
        () => resolveLoginMode({ poll: true }, false),
        /--poll requires --scopes/
    )
    assert.throws(
        () =>
            resolveLoginMode(
                { poll: true, scopes: 'channels:read', token: 'nca_x' },
                false
            ),
        /cannot combine with --token/
    )
})

test('resolveLoginMode poll wins over other flag combinations', () => {
    // poll takes precedence over auth-code
    assert.equal(
        resolveLoginMode(
            { poll: true, scopes: 'channels:read', authCode: 'mf_auth_x' },
            false
        ),
        'poll'
    )
})

test('resolveLoginMode wait is limited to poll mode', () => {
    assert.equal(
        resolveLoginMode(
            { poll: true, wait: true, scopes: 'channels:read' },
            false
        ),
        'poll'
    )
    assert.throws(
        () => resolveLoginMode({ wait: true }, false),
        /--wait requires --poll/
    )
})

test('poll login waits outside agents but exits after URL inside agent context', () => {
    assert.equal(shouldWaitForPollApproval({}, false), true)
    assert.equal(shouldWaitForPollApproval({}, true), false)
    assert.equal(shouldWaitForPollApproval({ wait: true }, true), true)
})

test('resolveLoginMode resume stands alone', () => {
    assert.equal(resolveLoginMode({ resume: true }, false), 'resume')
    assert.throws(
        () =>
            resolveLoginMode(
                { resume: true, poll: true, scopes: 'channels:read' },
                false
            ),
        /--resume cannot combine with --poll/
    )
    assert.throws(
        () => resolveLoginMode({ resume: true, token: 'nca_x' }, false),
        /--resume cannot combine with --token/
    )
    assert.throws(
        () => resolveLoginMode({ resume: true, authCode: 'mf_auth_x' }, false),
        /--resume cannot combine with --auth-code/
    )
})

test('resolveLoginMode routes scoped capability requests to auth ensure', () => {
    assert.throws(
        () => resolveLoginMode({ scopes: 'channels:read' }, false, true),
        /mf auth ensure/
    )
    assert.throws(
        () => resolveLoginMode({ scopes: 'channels:read' }, false, false),
        /mf auth ensure/
    )
})

test('resolveLoginMode agent context rejects browser callback login', () => {
    assert.throws(
        () => resolveLoginMode({}, false, true),
        /agent runtimes are already authenticated/
    )
})

test('pollUntilApproved returns approved token + scopes + email', async () => {
    const responses: CliLoginPollResponse[] = [
        { status: 'pending' },
        { status: 'pending' },
        {
            status: 'approved',
            token: 'nca_grant_xyz',
            scopes: ['channels:read', 'channels:edit'],
            userEmail: 'user@example.com'
        }
    ]
    const calls: string[] = []
    const result = await pollUntilApproved(
        'https://api.test',
        'mf_dvc_aaa',
        { intervalMs: 10, timeoutMs: 60_000 },
        async (deviceCode) => {
            calls.push(deviceCode)
            return responses.shift()!
        },
        () => 1_000,
        async () => {}
    )

    assert.equal(result.token, 'nca_grant_xyz')
    assert.deepEqual(result.scopes, ['channels:read', 'channels:edit'])
    assert.equal(result.userEmail, 'user@example.com')
    assert.equal(calls.length, 3)
    assert.deepEqual(new Set(calls), new Set(['mf_dvc_aaa']))
})

test('pollUntilApproved throws on expired session', async () => {
    await assert.rejects(
        () =>
            pollUntilApproved(
                'https://api.test',
                'mf_dvc_aaa',
                { intervalMs: 10, timeoutMs: 60_000 },
                async () => ({ status: 'expired' }),
                () => 1_000,
                async () => {}
            ),
        /expired before approval/
    )
})

test('pollUntilApproved throws on timeout', async () => {
    let now = 0
    await assert.rejects(
        () =>
            pollUntilApproved(
                'https://api.test',
                'mf_dvc_aaa',
                { intervalMs: 10, timeoutMs: 100 },
                async () => ({ status: 'pending' }),
                () => now,
                async () => {
                    now += 30
                }
            ),
        /login timed out/
    )
})

test('pollUntilApproved filters approved scopes to grantable subset', async () => {
    const result = await pollUntilApproved(
        'https://api.test',
        'mf_dvc_aaa',
        { intervalMs: 10, timeoutMs: 60_000 },
        async () => ({
            status: 'approved',
            token: 'nca_x',
            scopes: ['channels:read', 'api.full' as never, 'channels:edit'],
            userEmail: null
        }),
        () => 1_000,
        async () => {}
    )
    assert.deepEqual(result.scopes, ['channels:read', 'channels:edit'])
})
