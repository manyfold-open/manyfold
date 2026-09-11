import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    RuntimeAuthListView,
    RuntimeAuthProfileView
} from '@manyfold/shared'
import {
    defaultProviderSource,
    hostApiKeyEnvFor,
    builtInEntriesFor,
    customProtocolsFor,
    protocolModelCounts,
    providerFamiliesFor,
    providerFamilyOf,
    selectableProvidersFor,
    selectableProvidersForFamilies,
    initialPickerModeFor,
    isCloudCredentialPicker,
    localSelectionValid,
    providerSourceOf,
    type ProviderTarget
} from '../src/lib/agentCreate/providerSource'

const newTarget: ProviderTarget = { runtimeMode: 'new', runtimeKind: null }
const daemonTarget: ProviderTarget = {
    runtimeMode: 'existing',
    runtimeKind: 'daemon'
}
const spritesTarget: ProviderTarget = {
    runtimeMode: 'existing',
    runtimeKind: 'sprites'
}

const profile = (
    patch: Partial<RuntimeAuthProfileView> = {}
): RuntimeAuthProfileView => ({
    id: 'rap_a',
    runtimeId: 'rt_1',
    framework: 'claude-code',
    label: 'work',
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
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...patch
})

const list = (
    patch: Partial<RuntimeAuthListView> = {}
): RuntimeAuthListView => ({
    runtimeId: 'rt_1',
    framework: 'claude-code',
    kind: 'daemon',
    availability: 'ok',
    capabilities: { manage: true, execute: true, apiKey: true },
    defaultProfileId: null,
    ambient: null,
    profiles: [],
    error: null,
    ...patch
})

// Frameworks without a runtime-local surface never see the Local side, so
// the edition default and the daemon override must not leak onto them.
test('defaultProviderSource keeps non-coding frameworks on Cloud', () => {
    assert.equal(
        defaultProviderSource('openclaw', newTarget, 'runtime'),
        'cloud'
    )
    assert.equal(
        defaultProviderSource('hermes', daemonTarget, 'runtime'),
        'cloud'
    )
})

test('defaultProviderSource follows the edition slot for platform runtimes', () => {
    assert.equal(
        defaultProviderSource('claude-code', newTarget, 'runtime'),
        'local'
    )
    assert.equal(
        defaultProviderSource('claude-code', newTarget, 'saved'),
        'cloud'
    )
    assert.equal(
        defaultProviderSource('codex', spritesTarget, 'saved'),
        'cloud'
    )
})

// A self-owned computer already carries the user's sign-in; the cloud
// edition's 'saved' preference is about platform-hosted runtimes.
test('defaultProviderSource forces Local on a daemon whatever the slot says', () => {
    assert.equal(
        defaultProviderSource('claude-code', daemonTarget, 'saved'),
        'local'
    )
    assert.equal(
        defaultProviderSource('gemini-cli', daemonTarget, 'runtime'),
        'local'
    )
})

test('initialPickerModeFor maps the source onto a picker mode per target', () => {
    assert.equal(
        initialPickerModeFor('claude-code', newTarget, 'runtime'),
        'runtime'
    )
    assert.equal(
        initialPickerModeFor('claude-code', newTarget, 'saved'),
        'saved'
    )
    // Joining an existing runtime offers no "same credentials" row: the
    // runtime's credentials are the Local list, so Cloud starts on a provider.
    assert.equal(
        initialPickerModeFor('claude-code', spritesTarget, 'saved'),
        'saved'
    )
    assert.equal(
        initialPickerModeFor('openclaw', spritesTarget, 'runtime'),
        'saved'
    )
    assert.equal(
        initialPickerModeFor('openclaw', newTarget, 'runtime'),
        'saved'
    )
})

test('providerSourceOf and the cloud picker guard agree on which modes are Local', () => {
    assert.equal(providerSourceOf('runtime'), 'local')
    assert.equal(providerSourceOf('saved'), 'cloud')
    assert.equal(isCloudCredentialPicker({ mode: 'saved' }), true)
    assert.equal(isCloudCredentialPicker({ mode: 'inline' }), true)
    assert.equal(isCloudCredentialPicker({ mode: 'runtime' }), false)
})

test('hostApiKeyEnvFor names the variable each CLI reads', () => {
    assert.equal(hostApiKeyEnvFor('claude-code'), 'ANTHROPIC_API_KEY')
    assert.equal(hostApiKeyEnvFor('codex'), 'OPENAI_API_KEY')
    assert.equal(hostApiKeyEnvFor('gemini-cli'), 'GEMINI_API_KEY')
})

// The host sign-in needs nothing from the runtime; an added account is only
// sendable when the host can list it and run under it right now.
test('localSelectionValid gates only the added-account choice on the live list', () => {
    const inherited = { profileId: '' }
    const bound = { profileId: 'rap_a' }

    assert.equal(
        localSelectionValid({ target: newTarget, local: bound, list: null }),
        true
    )
    assert.equal(
        localSelectionValid({
            target: daemonTarget,
            local: inherited,
            list: null
        }),
        true
    )

    assert.equal(
        localSelectionValid({
            target: daemonTarget,
            local: bound,
            list: list({ profiles: [profile()] })
        }),
        true
    )
    assert.equal(
        localSelectionValid({ target: daemonTarget, local: bound, list: null }),
        false
    )
    assert.equal(
        localSelectionValid({
            target: daemonTarget,
            local: bound,
            list: list({
                profiles: [profile()],
                capabilities: { manage: true, execute: false, apiKey: true }
            })
        }),
        false
    )
    assert.equal(
        localSelectionValid({
            target: daemonTarget,
            local: bound,
            list: list({ profiles: [profile({ lifecycle: 'deleting' })] })
        }),
        false
    )
    assert.equal(
        localSelectionValid({
            target: daemonTarget,
            local: bound,
            list: list({ profiles: [profile({ id: 'rap_other' })] })
        }),
        false
    )
    assert.equal(
        localSelectionValid({
            target: daemonTarget,
            local: bound,
            list: list({
                profiles: [profile()],
                availability: 'daemon-offline'
            })
        }),
        false
    )
})

const savedProvider = (
    patch: Partial<import('@manyfold/shared').UserModelProviderSummary> = {}
): import('@manyfold/shared').UserModelProviderSummary => ({
    id: 'ump_1',
    inferenceProtocol: 'anthropic_messages',
    builtInId: null,
    externalAccountId: null,
    providerName: 'personal',
    apiKeyMasked: 'sk-…abcd',
    baseUrl: null,
    modelsListUrl: null,
    source: 'byo',
    managedService: null,
    managedKeyId: null,
    managedBrand: null,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestModels: null,
    enabledModels: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...patch
})

// The list and the chip count come from one filter: a row the picker hides
// (wrong protocol for the framework, managed Anthropic on openclaw, an
// admin-disabled channel) must not be counted either.
test('selectableProvidersFor keeps only rows the framework can use, managed first', () => {
    const rows = [
        savedProvider({ id: 'byo', providerName: 'zed' }),
        savedProvider({
            id: 'managed',
            providerName: 'Managed Anthropic',
            source: 'managed',
            managedBrand: 'anthropic'
        }),
        savedProvider({
            id: 'chat',
            providerName: 'router',
            inferenceProtocol: 'openai_chat_completions'
        }),
        savedProvider({ id: 'off', providerName: 'off', channelDisabled: true })
    ]
    assert.deepEqual(
        selectableProvidersFor(rows, 'anthropic', 'claude-code').map(
            (r) => r.id
        ),
        ['managed', 'byo']
    )
    assert.deepEqual(
        selectableProvidersFor(rows, 'anthropic', 'openclaw').map((r) => r.id),
        ['byo']
    )
    assert.deepEqual(
        selectableProvidersFor(rows, 'openai', 'codex').map((r) => r.id),
        []
    )
})

test('builtInEntriesFor offers the catalog entries whose protocol fits the framework', () => {
    assert.deepEqual(
        builtInEntriesFor('claude-code', 'anthropic').map((e) => e.id),
        ['netmind', 'anthropic-cloud']
    )
    assert.deepEqual(
        builtInEntriesFor('codex', 'openai').map((e) => e.id),
        ['netmind', 'openai-cloud']
    )
    assert.deepEqual(
        builtInEntriesFor('gemini-cli', 'google').map((e) => e.id),
        ['netmind', 'google-gemini']
    )
    assert.deepEqual(
        builtInEntriesFor('openclaw', 'openai').map((e) => e.id),
        ['netmind', 'openai-cloud', 'openrouter']
    )
})

test('customProtocolsFor narrows the family protocols to what the framework speaks', () => {
    assert.deepEqual(customProtocolsFor('claude-code', 'anthropic'), [
        'anthropic_messages'
    ])
    assert.deepEqual(customProtocolsFor('codex', 'openai'), [
        'openai_responses'
    ])
    assert.deepEqual(customProtocolsFor('openclaw', 'openai'), [
        'openai_responses',
        'openai_chat_completions'
    ])
    assert.deepEqual(customProtocolsFor('gemini-cli', 'google'), [
        'google_generate_content'
    ])
})

// The row's description is what the last test found; a narrowed enabled
// list wins over the raw discovery, and an untested provider says nothing.
test('protocolModelCounts reports per-protocol counts from the last test', () => {
    assert.deepEqual(protocolModelCounts(savedProvider()), [])
    assert.deepEqual(
        protocolModelCounts(
            savedProvider({
                lastTestModels: {
                    openai_responses: ['a', 'b', 'c'],
                    openai_chat_completions: ['a']
                }
            })
        ),
        [
            { protocol: 'openai_chat_completions', count: 1 },
            { protocol: 'openai_responses', count: 3 }
        ]
    )
    assert.deepEqual(
        protocolModelCounts(
            savedProvider({
                lastTestModels: { anthropic_messages: ['a', 'b', 'c'] },
                enabledModels: { anthropic_messages: ['a'] }
            })
        ),
        [{ protocol: 'anthropic_messages', count: 1 }]
    )
})

// OpenClaw and Hermes take either vendor, so their Cloud list is the union
// of both families under Anthropic / OpenAI chips; a coding CLI keeps its
// one family.
test('providerFamiliesFor: both vendors for openclaw / hermes, the CLI vendor otherwise', () => {
    assert.deepEqual(providerFamiliesFor('openclaw', 'anthropic'), [
        'anthropic',
        'openai'
    ])
    assert.deepEqual(providerFamiliesFor('hermes', 'openai'), [
        'anthropic',
        'openai'
    ])
    assert.deepEqual(providerFamiliesFor('codex', 'openai'), ['openai'])
    assert.deepEqual(providerFamiliesFor('gemini-cli', 'google'), ['google'])
})

test('selectableProvidersForFamilies lists each usable row once, managed first, and providerFamilyOf names its family', () => {
    const rows = [
        savedProvider({ id: 'a', providerName: 'zed' }),
        savedProvider({
            id: 'o',
            providerName: 'openai key',
            inferenceProtocol: 'openai_responses'
        }),
        savedProvider({
            id: 'm',
            providerName: 'Managed OpenAI',
            source: 'managed',
            inferenceProtocol: 'openai_responses',
            managedBrand: 'openai'
        }),
        savedProvider({ id: 'off', providerName: 'off', channelDisabled: true })
    ]
    const families = ['anthropic', 'openai'] as const
    assert.deepEqual(
        selectableProvidersForFamilies(rows, families, 'openclaw').map(
            (r) => r.id
        ),
        ['m', 'o', 'a']
    )
    assert.equal(providerFamilyOf(rows[0], families), 'anthropic')
    assert.equal(providerFamilyOf(rows[1], families), 'openai')
    assert.equal(providerFamilyOf(rows[1], ['anthropic']), null)
    // The union never counts a row twice even when families overlap.
    assert.deepEqual(
        selectableProvidersForFamilies(
            rows,
            ['openai', 'openai'],
            'hermes'
        ).map((r) => r.id),
        ['m', 'o']
    )
})
