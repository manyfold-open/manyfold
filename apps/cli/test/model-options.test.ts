import test from 'node:test'
import assert from 'node:assert/strict'
import {
    buildClaudeCodeDefaultModelConfig,
    claudeCodeModelAliases,
    claudeLocalModelCatalog,
    type AgentModelConfigView,
    type UserModelProviderSummary
} from '@manyfold/shared'
import {
    formatModelOptions,
    modelOptionsFor,
    resolveAgentModel,
    resolveModelChoice
} from '../src/model-options'
import { UsageError } from '../src/usage-error'
import { claudeSettings } from './fixtures/model-config-view'

const provider = (
    over: Partial<UserModelProviderSummary> &
        Pick<UserModelProviderSummary, 'id' | 'providerName'>
): UserModelProviderSummary =>
    ({
        inferenceProtocol: 'anthropic_messages',
        builtInId: null,
        source: 'byo',
        lastTestStatus: 'ok',
        lastTestedAt: '2026-09-29T16:12:40.000Z',
        lastTestModels: null,
        enabledModels: null,
        ...over
    }) as UserModelProviderSummary

// The tested list of a local stack's Anthropic provider, as reported in the
// feedback that prompted this (2026-09-29).
const anthropic = provider({
    id: 'ump_anthropic',
    providerName: 'anthropic',
    lastTestModels: {
        anthropic_messages: [
            'claude-3-5-haiku-20241022',
            'claude-3-5-sonnet-20240620',
            'claude-3-5-sonnet-20241022',
            'claude-3-7-sonnet-20250219',
            'claude-fable-5',
            'claude-fable-5-1',
            'claude-haiku-4-5-20251001',
            'claude-opus-4-1-20250805',
            'claude-opus-4-20250514',
            'claude-opus-4-5-20251101',
            'claude-opus-4-6',
            'claude-opus-4-7',
            'claude-opus-4-8',
            'claude-opus-5',
            'claude-opus-5-5',
            'claude-sonnet-4-20250514',
            'claude-sonnet-4-5-20250929',
            'claude-sonnet-4-6',
            'claude-sonnet-5'
        ]
    }
})

const usageMessage = (fn: () => unknown): string => {
    try {
        fn()
    } catch (err) {
        assert.ok(err instanceof UsageError, String(err))
        return err.message
    }
    assert.fail('expected a usage error')
}

test('--model takes an alias, the id an alias stands for, or the name people write', () => {
    const cases: Array<[string, string]> = [
        ['sonnet', 'sonnet'],
        ['sonnet[1m]', 'sonnet[1m]'],
        // Saved as the alias: the agent's settings list the id only through it.
        ['claude-sonnet-5', 'sonnet'],
        ['claude-opus-5-5', 'opus'],
        ['claude-haiku-4-5-20251001', 'haiku'],
        ['Sonnet 5', 'sonnet'],
        ['sonnet 5 1m', 'sonnet[1m]'],
        ['opus 5.5', 'opus'],
        ['Fable 5.1', 'fable'],
        ['fable 5', 'claude-fable-5'],
        ['sonnet 4.5', 'claude-sonnet-4-5-20250929'],
        ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
        ['sonnet 3.7', 'claude-3-7-sonnet-20250219'],
        ['claude-opus-4-8', 'claude-opus-4-8']
    ]
    for (const [typed, value] of cases)
        assert.equal(
            resolveModelChoice('claude-code', anthropic, typed),
            value,
            typed
        )
})

test('a name two models share asks which one', () => {
    assert.match(
        usageMessage(() =>
            resolveModelChoice('claude-code', anthropic, 'sonnet 3.5')
        ),
        /"sonnet 3\.5" could be claude-3-5-sonnet-20241022 or claude-3-5-sonnet-20240620 on anthropic/
    )
})

test('a model the provider was not tested with points at its family and a re-test', () => {
    const message = usageMessage(() =>
        resolveModelChoice('claude-code', anthropic, 'sonnet-5.5')
    )
    const lines = message.split('\n')
    assert.equal(
        lines[0],
        'anthropic was not tested with a model "sonnet-5.5". Its newest Sonnet is Sonnet 5: --model sonnet.'
    )
    assert.equal(lines[1], 'It can run:')
    assert.deepEqual(lines.slice(2, 6), [
        '  Fable   fable → claude-fable-5-1 (Fable 5.1), claude-fable-5',
        '  Opus    opus → claude-opus-5-5 (Opus 5.5), opus[1m] (Opus 5.5 1M), claude-opus-5, claude-opus-4-8, claude-opus-4-7, +4 older',
        '  Sonnet  sonnet → claude-sonnet-5 (Sonnet 5), sonnet[1m] (Sonnet 5 1M), claude-sonnet-4-6, claude-sonnet-4-5-20250929, claude-sonnet-4-20250514, +3 older',
        '  Haiku   haiku → claude-haiku-4-5-20251001 (Haiku 4.5), claude-3-5-haiku-20241022'
    ])
    assert.equal(
        lines[6],
        'anthropic was last tested 2026-09-29 16:12 UTC; for a model released since, test it again: mf model-providers test anthropic'
    )
})

test('a list without a limit shows every pinned id', () => {
    const options = modelOptionsFor('claude-code', anthropic) ?? []
    const opus = formatModelOptions(options).find((line) =>
        line.startsWith('  Opus')
    )
    assert.match(opus ?? '', /claude-opus-4-20250514$/)
})

test('Codex takes a model without the prefix its provider lists it under', () => {
    const openai = provider({
        id: 'ump_openai',
        providerName: 'Team OpenAI',
        inferenceProtocol: 'openai_responses',
        lastTestModels: {
            openai_responses: ['openai/gpt-6-sol', 'openai/gpt-5.5']
        }
    })
    assert.equal(
        resolveModelChoice('codex', openai, 'gpt-6-sol'),
        'openai/gpt-6-sol'
    )
    assert.equal(
        resolveModelChoice('codex', openai, 'GPT 6 Sol'),
        'openai/gpt-6-sol'
    )
    assert.equal(
        resolveModelChoice('codex', openai, 'gpt-5.5'),
        'openai/gpt-5.5'
    )
    assert.match(
        usageMessage(() => resolveModelChoice('codex', openai, 'gpt-7')),
        /Team OpenAI was not tested with a model "gpt-7"\.\nIt can run:\n {2}openai\/gpt-6-sol, openai\/gpt-5\.5\n.*mf model-providers test "Team OpenAI"$/
    )
})

const claudeModels = anthropic.lastTestModels?.anthropic_messages ?? []

const platformView = (
    over: Partial<AgentModelConfigView> = {}
): AgentModelConfigView => ({
    ...claudeSettings('agt_1', claudeModels, 'sonnet'),
    ...over
})

test('an agent takes the same names for its model as a create does', () => {
    const view = platformView()
    const cases: Array<[string, string]> = [
        ['haiku', 'haiku'],
        ['Haiku 4.5', 'haiku'],
        ['claude-haiku-4-5-20251001', 'haiku'],
        ['opus 5.5', 'opus'],
        ['sonnet 4.5', 'claude-sonnet-4-5-20250929']
    ]
    for (const [typed, value] of cases)
        assert.equal(resolveAgentModel(view, typed), value, typed)
    const lines = usageMessage(() =>
        resolveAgentModel(view, 'sonnet-5.5')
    ).split('\n')
    assert.equal(
        lines[0],
        'The model settings of agt_1 offer no model "sonnet-5.5". Its newest Sonnet is Sonnet 5: --model sonnet.'
    )
    // Listed by name and newest first, as on a create, whatever labels and
    // order the API gives its options.
    assert.deepEqual(lines.slice(1, 6), [
        'It can run:',
        '  Fable   fable → claude-fable-5-1 (Fable 5.1), claude-fable-5',
        '  Opus    opus → claude-opus-5-5 (Opus 5.5), opus[1m] (Opus 5.5 1M), claude-opus-5, claude-opus-4-8, claude-opus-4-7, +4 older',
        '  Sonnet  sonnet → claude-sonnet-5 (Sonnet 5), sonnet[1m] (Sonnet 5 1M), claude-sonnet-4-6, claude-sonnet-4-5-20250929, claude-sonnet-4-20250514, +3 older',
        '  Haiku   haiku → claude-haiku-4-5-20251001 (Haiku 4.5), claude-3-5-haiku-20241022'
    ])
    assert.equal(
        lines.at(-1),
        'For a model released since they were read: mf model-config refresh-models agt_1'
    )
})

test('a model the API lists beyond the named ones is still taken', () => {
    // With Haiku left unmapped the API still lists its versions; the named
    // options only follow mapped families.
    const view = claudeSettings('agt_1', claudeModels, 'sonnet', {
        ...buildClaudeCodeDefaultModelConfig(claudeModels).modelMap,
        haiku: undefined
    })
    assert.equal(
        resolveAgentModel(view, 'claude-3-5-haiku-20241022'),
        'claude-3-5-haiku-20241022'
    )
    assert.equal(
        resolveAgentModel(view, 'haiku 4.5'),
        'claude-haiku-4-5-20251001'
    )
})

test("on a sign-in the names are the ones the machine's CLI reported", () => {
    const view = platformView({
        source: 'runtime-local',
        options: [],
        runtimeLocal: {
            aliases: [...claudeCodeModelAliases],
            models: [...claudeLocalModelCatalog]
        } as AgentModelConfigView['runtimeLocal']
    })
    assert.equal(resolveAgentModel(view, 'haiku'), 'haiku')
    assert.equal(resolveAgentModel(view, 'Sonnet 5.5'), 'claude-sonnet-5-5')
    const message = usageMessage(() => resolveAgentModel(view, 'sonnet 7'))
    // Nothing says what an alias stands for on a subscription.
    assert.match(
        message,
        /^The model settings of agt_1 offer no model "sonnet 7"\.\n/
    )
    assert.match(
        message,
        /\n {2}Sonnet {2}sonnet, sonnet\[1m\], claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-4-6, \+2 older\n/
    )
})

test('a model outside a list the API does not hold to is left to the API', () => {
    const gemini = platformView({
        framework: 'gemini-cli',
        config: null,
        options: [
            { value: 'gemini-3-pro', label: 'Gemini 3 Pro', enabled: true }
        ]
    })
    assert.equal(
        resolveAgentModel(gemini, 'google/gemini-3-flash-low'),
        'google/gemini-3-flash-low'
    )
    const untested = platformView({ providerModels: [], options: [] })
    assert.equal(resolveAgentModel(untested, 'Sonnet 5'), 'Sonnet 5')
})
