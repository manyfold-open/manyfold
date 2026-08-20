import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenclawAgentAdapter } from '../src/modules/agents/adapters/openclaw-agent.adapter'

const WS = '/home/sprite/.nca/workspaces/agent-1'

const fakeRuntime = {
    id: 'rt-1',
    mountPath: WS
}

const makeAdapter = (result: { exitCode?: number; stdout: string }) => {
    const exec = {
        run: async (req: { cmd: string[] }) => {
            assert.deepEqual(
                req.cmd,
                ['openclaw', 'agents', 'list', '--json'],
                'listAgents must shell out to openclaw agents list --json'
            )
            return {
                exitCode: result.exitCode ?? 0,
                stdout: result.stdout,
                stderr: ''
            }
        }
    }
    return new OpenclawAgentAdapter({
        forRuntime: async () => exec
    } as never)
}

const listCtx = { runtime: fakeRuntime, primaryAgentId: 'agent-1' } as never

test('openclaw listAgents: exit 0 with empty stdout rejects', async () => {
    const adapter = makeAdapter({ stdout: '' })
    await assert.rejects(
        adapter.listAgents(listCtx),
        /empty output/,
        'the CLI always prints JSON with --json; silence is a broken pipe, not an empty runtime — returning [] here would orphan-mark every agent'
    )
})

test('openclaw listAgents: exit 0 with non-JSON stdout rejects', async () => {
    const adapter = makeAdapter({ stdout: 'not json' })
    await assert.rejects(
        adapter.listAgents(listCtx),
        /invalid JSON/,
        'garbage output must surface as a throw into reconcile backoff, never be coerced into a confirmed-empty list'
    )
})

test('openclaw listAgents: valid JSON without an agents array rejects', async () => {
    const adapter = makeAdapter({ stdout: '{"ok":true}' })
    await assert.rejects(
        adapter.listAgents(listCtx),
        /unexpected JSON shape/,
        'a gateway error envelope must not read as an empty fleet — only a recognized agents array counts as enumeration'
    )
})

test('openclaw listAgents: {"agents":[]} resolves confirmed-empty []', async () => {
    const adapter = makeAdapter({ stdout: '{"agents":[]}' })
    const agents = await adapter.listAgents(listCtx)
    assert.deepEqual(
        agents,
        [],
        'a healthy CLI explicitly reporting zero agents is the ONLY legal empty result under the truth contract'
    )
})

test('openclaw listAgents: top-level array parses (documented shape regression)', async () => {
    const adapter = makeAdapter({
        stdout: JSON.stringify([
            {
                id: 'main',
                workspace: WS,
                model: 'claude',
                identity: { name: 'Main' }
            }
        ])
    })
    const agents = await adapter.listAgents(listCtx)
    assert.equal(
        agents.length,
        1,
        'the documented top-level-array shape must keep parsing so strictness never breaks healthy listings'
    )
    assert.equal(agents[0].id, 'main')
    assert.equal(agents[0].name, 'Main')
    assert.equal(agents[0].workspace, WS)
    assert.equal(agents[0].model, 'claude')
})
