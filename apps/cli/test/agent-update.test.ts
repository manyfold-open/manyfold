import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import { json, runMf, type Call, type Route } from './fixtures/fake-api'
import { claudeSettings } from './fixtures/model-config-view'

// `mf agent update --model` on an agent whose framework keeps its model in
// the model settings sends it there, the same change `mf model-config
// update` makes, instead of the agent update the API refuses for it.

const models = [
    'claude-haiku-4-5-20251001',
    'claude-opus-5-5',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-5'
]

const agentRow = (over: Record<string, unknown> = {}) => ({
    id: 'agt_cc',
    name: 'coder',
    framework: 'claude-code',
    runtime: 'sprites',
    status: 'ready',
    model: 'sonnet',
    ...over
})

// A Claude Code agent on sonnet whose settings take whatever the CLI sends.
const claudeRoutes = (): Record<string, Route> => {
    let saved: string | null = 'sonnet'
    let name = 'coder'
    return {
        'GET /agents/agt_cc': () => json(agentRow({ name, model: saved })),
        'GET /agents/agt_cc/model-config': () =>
            json(claudeSettings('agt_cc', models, saved)),
        'PATCH /agents/agt_cc/model-config': (call) => {
            const body = call.body as { model?: string | null }
            saved = body.model ?? 'sonnet'
            return json(claudeSettings('agt_cc', models, saved))
        },
        'PATCH /agents/agt_cc': (call) => {
            const body = call.body as { name?: string; model?: unknown }
            if (body.model !== undefined)
                return json(
                    {
                        error: {
                            code: 'AGENT_MODEL_IN_MODEL_CONFIG',
                            message:
                                'Use /agents/agt_cc/model-config to update claude-code models',
                            details: {
                                agentId: 'agt_cc',
                                framework: 'claude-code'
                            }
                        }
                    },
                    400
                )
            name = body.name ?? name
            return json(agentRow({ name, model: saved }))
        }
    }
}

const writes = (calls: Call[]): string[] =>
    calls
        .filter((call) => call.method !== 'GET')
        .map(
            (call) => `${call.method} ${call.path} ${JSON.stringify(call.body)}`
        )

test('a Claude Code model goes to the model settings, named as people write it', async () => {
    const run = await runMf(
        ['agent', 'update', 'agt_cc', '--model', 'Haiku 4.5'],
        claudeRoutes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(writes(run.calls), [
        'PATCH /agents/agt_cc/model-config {"model":"haiku"}'
    ])
    assert.match(
        run.out.join('\n'),
        /\n {2}model {2}haiku \(claude-haiku-4-5-20251001\)$/
    )
})

test('a rename with the model is sent to the agent after the model', async () => {
    const run = await runMf(
        [
            'agent',
            'update',
            'agt_cc',
            '--name',
            'reviewer',
            '--model',
            'claude-opus-5-5',
            '--json'
        ],
        claudeRoutes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(writes(run.calls), [
        'PATCH /agents/agt_cc/model-config {"model":"opus"}',
        'PATCH /agents/agt_cc {"name":"reviewer"}'
    ])
    const agent = JSON.parse(run.out.join('\n'))
    assert.equal(agent.name, 'reviewer')
    assert.equal(agent.model, 'opus')
})

test('a model the settings do not offer is refused before anything changes', async () => {
    const run = await runMf(
        ['agent', 'update', 'agt_cc', '--name', 'x', '--model', 'sonnet-5.5'],
        claudeRoutes()
    )
    // A usage error: the entry point exits 5 on it.
    assert.ok(run.error instanceof CommanderError, String(run.error))
    assert.match(
        run.error.message,
        /offer no model "sonnet-5\.5"\. Its newest Sonnet is Sonnet 5: --model sonnet\./
    )
    assert.deepEqual(writes(run.calls), [])
})

test('--clear-model puts the settings back on their default', async () => {
    const run = await runMf(
        ['agent', 'update', 'agt_cc', '--clear-model'],
        claudeRoutes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(writes(run.calls), [
        'PATCH /agents/agt_cc/model-config {"model":null}'
    ])
    assert.match(run.out.join('\n'), /model {2}sonnet \(claude-sonnet-5\)$/)
})

test('a framework without model settings keeps the model on the agent', async () => {
    const hermes = { ...agentRow(), id: 'agt_h', framework: 'hermes' }
    const run = await runMf(['agent', 'update', 'agt_h', '--model', 'gpt-6'], {
        'GET /agents/agt_h': () => json(hermes),
        'PATCH /agents/agt_h': (call) =>
            json({ ...hermes, ...(call.body as object) })
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(writes(run.calls), [
        'PATCH /agents/agt_h {"model":"gpt-6"}'
    ])
    assert.match(run.out.join('\n'), /model {2}gpt-6$/)
})

test('a rename alone does not read the model settings', async () => {
    const run = await runMf(
        ['agent', 'update', 'agt_cc', '--name', 'reviewer'],
        claudeRoutes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(
        run.calls.map((call) => `${call.method} ${call.path}`),
        ['PATCH /agents/agt_cc']
    )
})

test('mf model-config update reads --model the same way', async () => {
    const run = await runMf(
        ['model-config', 'update', 'agt_cc', '--model', 'Sonnet 4.5'],
        claudeRoutes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(writes(run.calls), [
        'PATCH /agents/agt_cc/model-config {"model":"claude-sonnet-4-5-20250929"}'
    ])
    const refused = await runMf(
        ['model-config', 'update', 'agt_cc', '--model', 'sonnet 3.5'],
        claudeRoutes()
    )
    assert.ok(refused.error instanceof CommanderError, String(refused.error))
    assert.deepEqual(writes(refused.calls), [])
    // Moving to another source leaves the model to the API, which reads that
    // source's list.
    const moved = await runMf(
        [
            'model-config',
            'update',
            'agt_cc',
            '--source',
            'runtime-local',
            '--model',
            'claude-sonnet-5-5'
        ],
        claudeRoutes()
    )
    assert.equal(moved.error, undefined, String(moved.error))
    assert.deepEqual(writes(moved.calls), [
        'PATCH /agents/agt_cc/model-config {"modelConfigSource":"runtime-local","model":"claude-sonnet-5-5"}'
    ])
})
