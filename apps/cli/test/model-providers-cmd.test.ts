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
    assert.match(
        text,
        /\n {4}Sonnet {2}sonnet → claude-sonnet-4-6 \(Sonnet 4\.6\), sonnet\[1m\] \(Sonnet 4\.6 1M\)/
    )
    assert.match(
        text,
        /An alias \(sonnet, opus, …\) follows its family's newest/
    )
    assert.match(text, /ump_fresh .*saved {2}not tested yet/)
    assert.match(text, /ump_openai .*cannot serve it/)
    assert.match(text, /mf model-providers test <id\|name> tests it/)

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
    assert.deepEqual(openai.models, [
        {
            value: 'gpt-6-sol',
            label: 'GPT-6 Sol',
            providerModel: 'gpt-6-sol',
            family: null,
            alias: false
        }
    ])
})

test('model-providers list without a framework lists the rows as the API has them', async () => {
    const run = await runMf(['model-providers', 'list', '--json'], routes)
    const result = JSON.parse(run.out.join('\n'))
    assert.deepEqual(result, { framework: null, managed: null, providers })
})

test('model-providers test re-tests a provider and shows what --model now takes', async () => {
    const tested: string[] = []
    const run = await runMf(
        ['model-providers', 'test', 'Team OpenAI', '--framework', 'codex'],
        {
            ...routes,
            'POST /me/model-providers/ump_openai/test': (call) => {
                tested.push(call.path)
                return json({
                    ok: true,
                    status: 'ok',
                    latencyMs: 420,
                    models: [{ id: 'gpt-6-sol' }]
                })
            }
        }
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(tested, ['/me/model-providers/ump_openai/test'])
    assert.match(run.out.join('\n'), /✓ Team OpenAI: 1 model {2}\S*420 ms/)
    assert.match(run.out.join('\n'), /\n {4}gpt-6-sol/)

    const failed = await runMf(
        ['model-providers', 'test', 'ump_fresh', '--json'],
        {
            ...routes,
            'POST /me/model-providers/ump_fresh/test': () =>
                json({
                    ok: false,
                    status: 'auth_failed',
                    message: 'invalid x-api-key',
                    latencyMs: 90,
                    models: []
                })
        }
    )
    assert.equal(failed.exitCode, 1)
    assert.equal(JSON.parse(failed.out.join('\n')).result.status, 'auth_failed')
})
