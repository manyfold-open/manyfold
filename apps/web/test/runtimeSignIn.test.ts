import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentModelConfigView } from '@manyfold/shared'
import {
    runtimeSignInCommandFor,
    shouldShowRuntimeSignIn
} from '../src/lib/runtimeSignIn'
import { initialPickerForFramework } from '../src/pages/AgentNew/components/ProviderPicker'
import { PROVIDER_PICKER_DEFAULT_MODE } from '../src/lib/agentCreate/providerDefaultMode'

type SignInView = Pick<
    AgentModelConfigView,
    'framework' | 'source' | 'runtimeLocal'
>

const runtimeLocalStatus = (
    patch: Partial<NonNullable<SignInView['runtimeLocal']>> = {}
): NonNullable<SignInView['runtimeLocal']> => ({
    available: true,
    ready: false,
    source: 'sprites-local',
    framework: 'claude-code',
    cliVersion: null,
    credentialReady: null,
    credentialStatus: 'missing',
    credentialReason: 'no-credentials',
    configReadable: null,
    current: null,
    models: [],
    aliases: [],
    speeds: [],
    intelligence: [],
    lastCheckedAt: null,
    error: null,
    ...patch
})

test('sign-in card shows for a runtime-local coding agent that is not ready', () => {
    for (const framework of ['claude-code', 'codex', 'gemini-cli'] as const) {
        assert.equal(
            shouldShowRuntimeSignIn({
                framework,
                source: 'runtime-local',
                runtimeLocal: runtimeLocalStatus({ framework })
            }),
            true,
            framework
        )
    }
})

test('sign-in card shows before the first probe has run', () => {
    assert.equal(
        shouldShowRuntimeSignIn({
            framework: 'claude-code',
            source: 'runtime-local',
            runtimeLocal: null
        }),
        true
    )
})

test('sign-in card hides once the runtime sign-in is ready', () => {
    assert.equal(
        shouldShowRuntimeSignIn({
            framework: 'claude-code',
            source: 'runtime-local',
            runtimeLocal: runtimeLocalStatus({
                ready: true,
                credentialStatus: 'valid',
                credentialReason: 'oauth-live'
            })
        }),
        false
    )
})

test('sign-in card hides for platform source and non-coding frameworks', () => {
    assert.equal(
        shouldShowRuntimeSignIn({
            framework: 'claude-code',
            source: 'platform',
            runtimeLocal: runtimeLocalStatus()
        }),
        false
    )
    assert.equal(
        shouldShowRuntimeSignIn({
            framework: 'openclaw',
            source: 'runtime-local',
            runtimeLocal: null
        }),
        false
    )
    assert.equal(shouldShowRuntimeSignIn(null), false)
})

test('per-framework sign-in commands cover exactly the coding CLIs', () => {
    assert.equal(runtimeSignInCommandFor('claude-code'), 'claude')
    assert.equal(runtimeSignInCommandFor('codex'), 'codex login --device-auth')
    assert.equal(runtimeSignInCommandFor('gemini-cli'), 'NO_BROWSER=true gemini')
    assert.equal(runtimeSignInCommandFor('hermes'), null)
})

// The OSS half of the editions slot: the cloud overlay pins 'saved' on its
// side (protagolabs/manyfold apps/web-cloud/test/providerDefaultMode.test.ts),
// and this literal is what that test starts asserting against on the pin bump.
test('self-hosted defaults the create-form picker to the subscription sign-in', () => {
    assert.equal(PROVIDER_PICKER_DEFAULT_MODE, 'runtime')
})

test('initialPickerForFramework applies the slot only to coding frameworks', () => {
    assert.equal(initialPickerForFramework('claude-code').mode, 'runtime')
    assert.equal(initialPickerForFramework('codex').mode, 'runtime')
    assert.equal(initialPickerForFramework('gemini-cli').mode, 'runtime')
    assert.equal(initialPickerForFramework('hermes').mode, 'saved')
    assert.equal(initialPickerForFramework('openclaw').mode, 'saved')
})
