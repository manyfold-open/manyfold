import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DAEMON_FEATURE_AUTH_CONTEXT,
    RUNTIME_AUTH_ERROR
} from '@manyfold/shared'
import {
    AuthContextUnsupportedError,
    assertHostHonoursAuthContext,
    authContextRefFor,
    effectiveModelConfigSource,
    runtimeAuthSelectionFor
} from '../src/modules/agents/model-config/runtime-auth-selection'

const agent = (over: Record<string, unknown> = {}) =>
    ({
        framework: 'codex',
        runtimeId: 'art_1',
        extras: {},
        runtimeAuthProfileId: null,
        runtimeAuthBindingVersion: 0,
        ...over
    }) as never

test('the effective source mirrors the model-config default: daemon → runtime-local, sandbox → platform, stored wins when allowed', () => {
    assert.equal(effectiveModelConfigSource(agent(), 'daemon'), 'runtime-local')
    assert.equal(effectiveModelConfigSource(agent(), 'sprites'), 'platform')
    assert.equal(
        effectiveModelConfigSource(
            agent({ extras: { modelConfig: { source: 'runtime-local' } } }),
            'sprites'
        ),
        'runtime-local'
    )
    assert.equal(
        effectiveModelConfigSource(
            agent({ extras: { modelConfig: { source: 'platform' } } }),
            'daemon'
        ),
        'platform'
    )
    assert.equal(
        effectiveModelConfigSource(
            agent({
                framework: 'hermes',
                extras: { modelConfig: { source: 'runtime-local' } }
            }),
            'daemon'
        ),
        'platform',
        'a service framework can never be runtime-local'
    )
})

test('a binding only selects a profile while the agent runs runtime-local', () => {
    assert.deepEqual(runtimeAuthSelectionFor(agent(), 'daemon'), {
        mode: 'inherited'
    })
    assert.deepEqual(
        runtimeAuthSelectionFor(
            agent({
                runtimeAuthProfileId: 'rap_x',
                runtimeAuthBindingVersion: 3
            }),
            'daemon'
        ),
        { mode: 'profile', profileId: 'rap_x', bindingVersion: 3 }
    )
    assert.deepEqual(
        runtimeAuthSelectionFor(
            agent({
                runtimeAuthProfileId: 'rap_x',
                extras: { modelConfig: { source: 'platform' } }
            }),
            'daemon'
        ),
        { mode: 'inherited' },
        'a platform agent keeps its platform key even with a stale binding'
    )
    assert.deepEqual(
        authContextRefFor(
            agent({
                runtimeAuthProfileId: 'rap_x',
                runtimeAuthBindingVersion: 2
            }),
            'daemon'
        ),
        {
            framework: 'codex',
            runtimeId: 'art_1',
            profileId: 'rap_x',
            bindingVersion: 2
        }
    )
    assert.equal(authContextRefFor(agent(), 'daemon'), null)
    assert.equal(
        authContextRefFor(
            agent({ runtimeAuthProfileId: 'rap_x', runtimeId: null }),
            'daemon'
        ),
        null
    )
})

test('a profile-bound execution is refused by hosts that cannot honour it, never downgraded', () => {
    const ref = authContextRefFor(
        agent({ runtimeAuthProfileId: 'rap_x' }),
        'daemon'
    )
    assert.doesNotThrow(
        () => assertHostHonoursAuthContext(null, null, 'anything'),
        'inherited needs no host'
    )
    assert.throws(
        () => assertHostHonoursAuthContext(ref, null, 'a bare sprite'),
        (err: unknown) =>
            err instanceof AuthContextUnsupportedError &&
            err.code === RUNTIME_AUTH_ERROR.contextUnsupported
    )
    assert.throws(
        () =>
            assertHostHonoursAuthContext(
                ref,
                { clientFeatures: ['auth-profiles.v1'] },
                'this machine'
            ),
        (err: unknown) =>
            err instanceof AuthContextUnsupportedError &&
            err.code === RUNTIME_AUTH_ERROR.daemonUpgradeRequired,
        'listing accounts is not executing under one'
    )
    assert.doesNotThrow(() =>
        assertHostHonoursAuthContext(
            ref,
            { clientFeatures: [DAEMON_FEATURE_AUTH_CONTEXT] },
            'this machine'
        )
    )
})
