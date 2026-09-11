import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    RuntimeAuthListView,
    RuntimeAuthProfileView
} from '@manyfold/shared'
import en from '../../../packages/i18n/src/langs/en'
import {
    INHERITED_AUTH_OPTION,
    initialRuntimeAuthSelection,
    profileBindable,
    profileDisplayName,
    profileNeedsSignIn,
    profileStatusTag,
    profileSubline,
    runtimeAuthOptions,
    runtimeAuthPickerState
} from '../src/lib/runtimeAuth'

const t = (key: string): string => {
    const value = key.split('.').reduce<unknown>((node, part) => {
        if (node && typeof node === 'object')
            return (node as Record<string, unknown>)[part]
        return undefined
    }, en)
    assert.equal(typeof value, 'string', `missing en key ${key}`)
    return value as string
}

const profile = (
    patch: Partial<RuntimeAuthProfileView> = {}
): RuntimeAuthProfileView => ({
    id: 'rap_1',
    runtimeId: 'art_1',
    framework: 'codex',
    label: 'Work',
    authMethod: 'subscription',
    lifecycle: 'ready',
    credentialStatus: 'valid',
    credentialGeneration: 1,
    identity: null,
    vendorUserId: null,
    vendorAccountId: null,
    checkedAt: null,
    lastErrorCode: null,
    agentCount: 0,
    isDefault: false,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...patch
})

const list = (
    patch: Partial<RuntimeAuthListView> = {}
): RuntimeAuthListView => ({
    runtimeId: 'art_1',
    framework: 'codex',
    kind: 'daemon',
    availability: 'ok',
    capabilities: { manage: true, execute: true, apiKey: true },
    defaultProfileId: null,
    ambient: null,
    profiles: [],
    error: null,
    ...patch
})

test('a profile is named by who it is signed in as, falling back to its label', () => {
    assert.equal(profileDisplayName(profile()), 'Work')
    assert.equal(
        profileDisplayName(
            profile({
                identity: {
                    email: 'a@example.com',
                    name: 'A',
                    organization: null,
                    plan: null,
                    accountId: null
                }
            })
        ),
        'a@example.com'
    )
    assert.equal(
        profileDisplayName(
            profile({
                identity: {
                    email: null,
                    name: 'Only Name',
                    organization: null,
                    plan: null,
                    accountId: null
                }
            })
        ),
        'Only Name'
    )
})

test('lifecycle outranks the credential probe in the status tag', () => {
    assert.deepEqual(
        profileStatusTag(profile({ lifecycle: 'signed-out' }), t),
        { tone: 'idle', label: 'Signed out' }
    )
    assert.deepEqual(profileStatusTag(profile({ lifecycle: 'deleting' }), t), {
        tone: 'idle',
        label: 'Removing'
    })
    assert.deepEqual(profileStatusTag(profile(), t), {
        tone: 'success',
        label: 'Signed in'
    })
    assert.equal(
        profileStatusTag(profile({ credentialStatus: 'reauth-required' }), t)
            .tone,
        'warning'
    )
    assert.equal(
        profileStatusTag(profile({ credentialStatus: 'missing' }), t).tone,
        'error'
    )
    assert.equal(
        profileStatusTag(profile({ credentialStatus: 'unknown' }), t).tone,
        'idle'
    )
    // A stored key reads as a key, like the host row's own key-based sign-in;
    // a key the host lost is still "Not signed in".
    assert.deepEqual(profileStatusTag(profile({ authMethod: 'api-key' }), t), {
        tone: 'info',
        label: 'API key'
    })
    assert.equal(
        profileStatusTag(
            profile({ authMethod: 'api-key', credentialStatus: 'missing' }),
            t
        ).tone,
        'error'
    )
})

test('the profile subline leads with the default, then label, plan, organization and agent count', () => {
    const identity = {
        email: 'dev@example.com',
        name: 'Dev',
        organization: 'Acme',
        plan: 'pro',
        accountId: null
    }
    assert.equal(
        profileSubline(profile({ identity, agentCount: 2 }), t as never),
        'Work · Pro · Acme · Used by {{count}} agents'
    )
    assert.equal(
        profileSubline(profile({ identity, isDefault: true }), t as never),
        'Default for new agents · Work · Pro · Acme'
    )
    // The label is the headline when there is no identity; it is not repeated.
    assert.equal(profileSubline(profile(), t as never), null)
    assert.equal(
        profileSubline(profile({ identity: { ...identity, plan: null } }), t as never),
        'Work · Acme'
    )
})

test('only a profile on its way out is unbindable; a stale sign-in still binds', () => {
    assert.equal(profileBindable(profile()), true)
    assert.equal(
        profileBindable(profile({ credentialStatus: 'missing' })),
        true
    )
    assert.equal(profileBindable(profile({ lifecycle: 'signed-out' })), true)
    assert.equal(profileBindable(profile({ lifecycle: 'deleting' })), false)
    assert.equal(profileBindable(profile({ lifecycle: 'deleted' })), false)
    assert.equal(profileNeedsSignIn(profile()), false)
    assert.equal(profileNeedsSignIn(profile({ lifecycle: 'pending' })), true)
    assert.equal(
        profileNeedsSignIn(profile({ credentialStatus: 'reauth-required' })),
        true
    )
})

test('picker options lead with the host sign-in and flag rows needing attention', () => {
    const options = runtimeAuthOptions(
        [
            profile({ id: 'rap_a', label: 'A' }),
            profile({ id: 'rap_b', label: 'B', lifecycle: 'signed-out' }),
            profile({ id: 'rap_c', label: 'C', lifecycle: 'deleting' }),
            profile({ id: 'rap_d', label: 'D', lifecycle: 'deleted' })
        ],
        t
    )
    assert.deepEqual(options, [
        {
            value: INHERITED_AUTH_OPTION,
            label: 'Host sign-in (default)',
            disabled: false
        },
        { value: 'rap_a', label: 'A', disabled: false },
        { value: 'rap_b', label: 'B · Signed out', disabled: false },
        { value: 'rap_c', label: 'C · Removing', disabled: true }
    ])
})

test('the wizard pre-selects the runtime default only while it is bindable', () => {
    assert.equal(
        initialRuntimeAuthSelection(
            list({
                defaultProfileId: 'rap_a',
                profiles: [profile({ id: 'rap_a' })]
            })
        ),
        'rap_a'
    )
    assert.equal(
        initialRuntimeAuthSelection(
            list({
                defaultProfileId: 'rap_a',
                profiles: [profile({ id: 'rap_a', lifecycle: 'deleting' })]
            })
        ),
        INHERITED_AUTH_OPTION
    )
    assert.equal(
        initialRuntimeAuthSelection(
            list({ defaultProfileId: 'rap_gone', profiles: [profile()] })
        ),
        INHERITED_AUTH_OPTION
    )
})

test('the picker hides without a reachable host or bindable profile and warns on an old mf', () => {
    assert.equal(runtimeAuthPickerState(null), 'hidden')
    assert.equal(
        runtimeAuthPickerState(list({ availability: 'daemon-offline' })),
        'hidden'
    )
    assert.equal(runtimeAuthPickerState(list()), 'hidden')
    assert.equal(
        runtimeAuthPickerState(
            list({ profiles: [profile({ lifecycle: 'deleting' })] })
        ),
        'hidden'
    )
    assert.equal(
        runtimeAuthPickerState(list({ profiles: [profile()] })),
        'ready'
    )
    assert.equal(
        runtimeAuthPickerState(
            list({
                profiles: [profile()],
                capabilities: { manage: true, execute: false, apiKey: true }
            })
        ),
        'execute-unsupported'
    )
})
