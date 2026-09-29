import test from 'node:test'
import assert from 'node:assert/strict'
import type { UserModelProviderSummary } from '@manyfold/shared'
import { json, runMf } from './fixtures/fake-api'

const row = (
    over: Partial<UserModelProviderSummary> &
        Pick<UserModelProviderSummary, 'id' | 'providerName'>
): UserModelProviderSummary =>
    ({
        inferenceProtocol: 'anthropic_messages',
        builtInId: null,
        source: 'byo',
        apiKeyMasked: 'sk-***1234',
        lastTestStatus: 'ok',
        lastTestModels: null,
        enabledModels: null,
        ...over
    }) as UserModelProviderSummary

const providers = [
    row({
        id: 'ump_managed',
        providerName: 'Managed Anthropic',
        source: 'managed',
        managedBrand: 'anthropic',
        managedRank: 1,
        lastTestModels: {
            anthropic_messages: ['claude-sonnet-4-6', 'claude-haiku-4-5']
        }
    }),
    row({ id: 'ump_fresh', providerName: 'Fresh key', lastTestStatus: null }),
    row({
        id: 'ump_openai',
        providerName: 'Team OpenAI',
        inferenceProtocol: 'openai_responses',
        lastTestModels: { openai_responses: ['gpt-6-sol'] }
    })
]
const routes = { 'GET /me/model-providers': () => json(providers) }

test('model-providers list checks each provider against a framework and names the managed pick', async () => {
    const human = await runMf(
        ['model-providers', 'list', '--framework', 'claude-code'],
        routes
    )
    assert.equal(human.error, undefined, String(human.error))
    const text = human.out.join('\n')
    assert.match(
        text,
        /ump_managed .*managed {2}usable.*what --model-provider managed picks/
    )
    assert.match(text, /models: .*sonnet/)
    assert.match(text, /ump_fresh .*saved {2}not tested yet/)
    assert.match(text, /ump_openai .*cannot serve it/)
    assert.match(text, /test it under Settings → Model providers/)

    const scripted = await runMf(
        ['model-providers', 'list', '--framework', 'codex', '--json'],
        routes
    )
    const result = JSON.parse(scripted.out.join('\n'))
    assert.equal(result.framework, 'codex')
    assert.equal(result.managed, null)
    const openai = result.providers.find(
        (p: { id: string }) => p.id === 'ump_openai'
    )
    assert.equal(openai.verdict, 'usable')
    assert.deepEqual(openai.models, ['gpt-6-sol'])
})

test('model-providers list without a framework lists the rows as the API has them', async () => {
    const run = await runMf(['model-providers', 'list', '--json'], routes)
    const result = JSON.parse(run.out.join('\n'))
    assert.deepEqual(result, { framework: null, managed: null, providers })
})
