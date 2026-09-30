import test from 'node:test'
import assert from 'node:assert/strict'
import type { UserModelProviderSummary } from '../src/dtos'
import {
    managedChannelFor,
    preferredPrimaryModelDefault,
    providerBindingFor,
    testedModelsFor
} from '../src/provider-binding'
import { runtimeSignInCommandFor } from '../src/runtime-sign-in'

const providerRow = (
    over: Partial<UserModelProviderSummary> &
        Pick<UserModelProviderSummary, 'id' | 'providerName'>
): UserModelProviderSummary =>
    ({
        inferenceProtocol: null,
        builtInId: null,
        externalAccountId: null,
        apiKeyMasked: '',
        baseUrl: null,
        modelsListUrl: null,
        source: 'byo',
        managedService: null,
        managedKeyId: null,
        managedBrand: null,
        lastTestedAt: null,
        lastTestStatus: 'ok',
        lastTestMessage: null,
        lastTestModels: null,
        enabledModels: null,
        createdAt: '',
        updatedAt: '',
        ...over
    }) as UserModelProviderSummary

const managedAnthropic = providerRow({
    id: 'm-anthropic',
    providerName: 'Managed Anthropic',
    source: 'managed',
    inferenceProtocol: 'anthropic_messages',
    managedBrand: 'anthropic',
    lastTestModels: {
        anthropic_messages: ['claude-fable-5', 'claude-haiku-4-5-20251001']
    }
})
const managedClaudeViaOther = providerRow({
    id: 'm-other-claude',
    providerName: 'Managed Claude (other channel)',
    source: 'managed',
    inferenceProtocol: 'anthropic_messages',
    managedBrand: 'antigravity_claude' as never,
    lastTestModels: { anthropic_messages: ['claude-sonnet-5'] }
})
const managedOpenAI = providerRow({
    id: 'm-openai',
    providerName: 'Managed OpenAI',
    source: 'managed',
    inferenceProtocol: 'openai_responses',
    managedBrand: 'openai',
    lastTestModels: { openai_responses: ['gpt-5.4-mini', 'gpt-6-sol'] }
})

test('managed picks the best-ranked usable channel, else keeps the given order', () => {
    const rows = [managedClaudeViaOther, managedAnthropic, managedOpenAI]
    assert.equal(managedChannelFor('claude-code', rows)?.id, 'm-other-claude')
    const rank = (row: UserModelProviderSummary): number =>
        row.managedBrand === 'anthropic' ? 0 : 1
    assert.equal(
        managedChannelFor('claude-code', rows, rank)?.id,
        'm-anthropic'
    )
    assert.equal(managedChannelFor('codex', rows, rank)?.id, 'm-openai')
    const rankedByApi = [
        { ...managedClaudeViaOther, managedRank: 4 },
        { ...managedAnthropic, managedRank: 1 }
    ]
    assert.equal(
        managedChannelFor('claude-code', rankedByApi)?.id,
        'm-anthropic'
    )
})

test('managed skips closed channels and ones the framework cannot use', () => {
    assert.equal(
        managedChannelFor('claude-code', [
            { ...managedAnthropic, channelDisabled: true },
            managedOpenAI
        ]),
        null
    )
    assert.equal(managedChannelFor('gemini-cli', [managedAnthropic]), null)
})

test('a binding names the provider and a model it was tested with', () => {
    assert.deepEqual(testedModelsFor('codex', managedOpenAI), [
        'gpt-5.4-mini',
        'gpt-6-sol'
    ])
    const codex = providerBindingFor('codex', managedOpenAI)
    assert.equal(codex?.providerId, 'm-openai')
    assert.ok(
        codex?.model &&
            testedModelsFor('codex', managedOpenAI).includes(codex.model)
    )
    const untested = { ...managedOpenAI, lastTestModels: null }
    assert.deepEqual(testedModelsFor('codex', untested), [])
    assert.equal(providerBindingFor('codex', untested), null)
})

test('preferredPrimaryModelDefault prefers the economical tier per family', () => {
    assert.equal(
        preferredPrimaryModelDefault(
            ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4'],
            'openai'
        ),
        'gpt-5.4-mini'
    )
    assert.equal(
        preferredPrimaryModelDefault(
            ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
            'anthropic'
        ),
        'claude-haiku-4-5'
    )
})

test('preferredPrimaryModelDefault matches vendor-prefixed economical ids', () => {
    assert.equal(
        preferredPrimaryModelDefault(
            ['netmind/gpt-5.5', 'netmind/gpt-5.4-mini'],
            'openai'
        ),
        'netmind/gpt-5.4-mini'
    )
    assert.equal(
        preferredPrimaryModelDefault(
            ['vendor/claude-sonnet-5', 'vendor/claude-haiku-4-5'],
            'anthropic'
        ),
        'vendor/claude-haiku-4-5'
    )
})

test('preferredPrimaryModelDefault falls back to the first option', () => {
    assert.equal(
        preferredPrimaryModelDefault(
            ['codex-auto-review', 'gpt-5.5'],
            'openai'
        ),
        'codex-auto-review'
    )
    assert.equal(preferredPrimaryModelDefault([], 'openai'), undefined)
    assert.equal(
        preferredPrimaryModelDefault(['some-model'], 'google'),
        'some-model'
    )
})

// The claude literal is pinned whole on purpose: dropping the `cat |` puts
// claude back in charge of the tty, and it reads the pasted code without
// echoing a single byte of it (see the note in src/runtime-sign-in.ts), which
// is invisible to any rendering test.
test('per-framework sign-in commands cover exactly the coding CLIs', () => {
    assert.equal(
        runtimeSignInCommandFor('claude-code'),
        'cat | claude auth login --claudeai'
    )
    assert.equal(runtimeSignInCommandFor('codex'), 'codex login --device-auth')
    assert.equal(
        runtimeSignInCommandFor('gemini-cli'),
        'NO_BROWSER=true gemini'
    )
    // pi has no login subcommand: its TUI's /login runs the provider's flow.
    assert.equal(runtimeSignInCommandFor('pi'), 'pi')
    // agy signs in the first time its TUI starts without a sign-in.
    assert.equal(runtimeSignInCommandFor('antigravity-cli'), 'agy')
    assert.equal(runtimeSignInCommandFor('hermes'), null)
})
