import test from 'node:test'
import assert from 'node:assert/strict'
import { SpritesAgentAttacher } from '../src/modules/agents/adapters/sprites-agent-attacher'
import type { AgentRuntimeRow, Agent } from '@manyfold/db'

const runtime = {
    id: 'rt-1',
    userId: 'u-1',
    name: 'rt',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: 'nca-user-abc-rt',
    spriteId: 'sp-1',
    primaryAgentId: 'agent-1',
    mountPath: '/home/sprite/.nca/workspaces/agent-1',
    namespace: null,
    ingressHost: null,
    clusterId: null,
    spriteUrl: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
} as unknown as AgentRuntimeRow

test('SpritesAgentAttacher.attach mkdirs the agent workspace and returns paths', async () => {
    const calls: Array<{ op: string; spriteName: string; path: string }> = []
    const attacher = makeAttacher({
        spriteMkdir: async (_client, spriteName, path) => {
            calls.push({ op: 'mkdir', spriteName, path })
        }
    })

    const result = await attacher.attach({ runtime, agentId: 'agent-2' })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].op, 'mkdir')
    assert.equal(calls[0].spriteName, 'nca-user-abc-rt')
    assert.equal(calls[0].path, '/home/sprite/.manyfold/workspaces/agent-2')
    assert.equal(result.workspacePath, '/home/sprite/.manyfold/workspaces/agent-2')
    assert.equal(result.internalId, 'agent-2')
})

test('SpritesAgentAttacher.detach rm -rf the agent workspace', async () => {
    const calls: Array<{
        op: string
        path: string
        recursive: boolean
    }> = []
    const attacher = makeAttacher({
        spriteRm: async (_client, _spriteName, path, opts) => {
            calls.push({
                op: 'rm',
                path,
                recursive: opts?.recursive === true
            })
        }
    })
    const agent = {
        id: 'agent-2',
        workspacePath: '/home/sprite/.nca/workspaces/agent-2'
    } as unknown as Agent

    await attacher.detach({ runtime, agent })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].op, 'rm')
    assert.equal(calls[0].path, '/home/sprite/.nca/workspaces/agent-2')
    assert.equal(calls[0].recursive, true)
})

test('SpritesAgentAttacher.detach does not rm custom workspace', async () => {
    const calls: Array<{ op: string }> = []
    const attacher = makeAttacher({
        spriteRm: async () => {
            calls.push({ op: 'rm' })
        }
    })
    const agent = {
        id: 'agent-2',
        workspacePath: '/project',
        extras: { workspaceManaged: false }
    } as unknown as Agent

    await attacher.detach({ runtime, agent })

    assert.equal(calls.length, 0)
})

test('SpritesAgentAttacher.detach swallows not-found errors', async () => {
    const attacher = makeAttacher({
        spriteRm: async () => {
            const err: Error & { code?: string } = new Error('not found')
            err.code = 'not_found'
            throw err
        }
    })
    const agent = {
        id: 'agent-2',
        workspacePath: '/home/sprite/.nca/workspaces/agent-2'
    } as unknown as Agent

    await attacher.detach({ runtime, agent })
})

test('SpritesAgentAttacher.attach throws if runtime has no spriteName', async () => {
    const attacher = makeAttacher({})
    const broken = {
        ...runtime,
        spriteName: null
    } as unknown as AgentRuntimeRow

    await assert.rejects(
        () => attacher.attach({ runtime: broken, agentId: 'agent-2' }),
        /spriteName/
    )
})

interface MakeArgs {
    spriteMkdir?: (
        client: unknown,
        spriteName: string,
        path: string
    ) => Promise<void>
    spriteRm?: (
        client: unknown,
        spriteName: string,
        path: string,
        opts?: { recursive?: boolean }
    ) => Promise<void>
}

const makeAttacher = (args: MakeArgs): SpritesAgentAttacher => {
    const fakeAccounts = {
        getById: async (_id: string) => ({
            id: 'acc-1',
            slug: 'acct',
            tokenCiphertext: 'enc',
            keyVersion: 1
        }),
        decryptToken: () => 't0k3n'
    }
    return new SpritesAgentAttacher(
        fakeAccounts as never,
        args.spriteMkdir ?? (async () => {}),
        args.spriteRm ?? (async () => {}),
        () => ({}) as never // createClient stub returns {} — we don't use it
    )
}
