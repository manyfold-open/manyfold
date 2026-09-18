import assert from 'node:assert/strict'
import test from 'node:test'
import { agents, agentRuntimes } from '@manyfold/db'
import { AgentContextDocManageService } from '../src/modules/agents/agent-context-doc-manage.service'
import { AgentContextDocService } from '../src/modules/agent-self/agent-context-doc.service'
import { readJsonbMergePatch } from './jsonb-merge'
import { legacyConfigDelivery } from './helpers/legacy-config-delivery'

// The context doc reaches a daemon agent over the exec RPC (#781): same bash
// script a sprite gets, carried by exec.start, with the outcome recorded in
// extras.contextDoc only on MF_CTX_OK.

const agentRow = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'user-1',
    runtime: 'daemon',
    framework: 'claude-code',
    daemonId: 'dh-1',
    runtimeId: 'art-1',
    status: 'running',
    workspacePath: '/home/cy/ws',
    mountPath: '/home/cy/ws',
    extras: {},
    ...over
})

const fakeDb = (row: Record<string, unknown>) => {
    const updates: Array<Record<string, unknown>> = []
    return {
        updates,
        select: () => ({
            from: (table: unknown) => ({
                where: () => ({ limit: async () => table === agentRuntimes ? [{ id: 'art-1', userId: 'user-1', daemonId: 'dh-1', kind: 'daemon', homeDir: '/home/cy' }] : [row] })
            })
        }),
        update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => ({
                where: async () => {
                    if (table === agents) updates.push(values)
                }
            })
        })
    }
}

const fakeRegistry = (opts: { ok: boolean }) => {
    const scripts: string[] = []
    return {
        scripts,
        streamRpc: (args: {
            daemonId: string
            method: string
            payload: Record<string, unknown>
            onEvent?: (kind: string, data: string) => void
        }) => {
            assert.equal(args.method, 'exec.start')
            const cmd = args.payload.cmd as string[]
            assert.deepEqual(cmd.slice(0, 2), ['bash', '-lc'])
            scripts.push(cmd[2])
            if (opts.ok) args.onEvent?.('stdout', 'MF_CTX_OK\n')
            return {
                refId: 'ref-1',
                result: Promise.resolve({ exitCode: opts.ok ? 0 : 1 }),
                cancel: () => {}
            }
        }
    }
}

const build = (
    db: ReturnType<typeof fakeDb>,
    registry: ReturnType<typeof fakeRegistry>
): AgentContextDocManageService => {
    const contextDoc = new AgentContextDocService(
        db as never,
        {
            resolveAgentConnectionsById: async () => []
        } as never
    )
    return new AgentContextDocManageService(
        db as never,
        {} as never,
        contextDoc,
        registry as never,
        legacyConfigDelivery(db as never) as never
    )
}

test('refresh writes the context doc to a daemon over exec and records it', async () => {
    const db = fakeDb(agentRow())
    const registry = fakeRegistry({ ok: true })
    const svc = build(db, registry)

    const status = await svc.refresh('user-1', 'agent-1', false)

    assert.equal(registry.scripts.length, 1)
    const script = registry.scripts[0]
    assert.ok(script.includes("WORKSPACE='/home/cy/ws'"))
    assert.ok(script.includes('CLAUDE.md'))
    assert.ok(script.includes('AGENTS.manyfold.md'))
    const patch = readJsonbMergePatch(db.updates[0].extras)
    assert.equal(
        (patch?.contextDoc as { version?: number } | undefined)?.version,
        1
    )
    assert.equal(status.supported, true)
})

test('a failed daemon exec stays stale and records a failed delivery', async () => {
    const db = fakeDb(agentRow())
    const registry = fakeRegistry({ ok: false })
    const svc = build(db, registry)

    await assert.rejects(svc.refresh('user-1', 'agent-1', false), /configuration failed/)

    assert.equal(registry.scripts.length, 1)
    assert.equal(db.updates.length, 1)
    const patch = readJsonbMergePatch(db.updates[0].extras)
    assert.equal(patch?.contextDoc, undefined)
    assert.equal((patch?.contextDocDelivery as { status: string }).status, 'failed')
})

test('a daemon agent whose computer is offline is told to start it', async () => {
    const db = fakeDb(agentRow({ status: 'stopped' }))
    const svc = build(db, fakeRegistry({ ok: true }))
    await assert.rejects(
        () => svc.refresh('user-1', 'agent-1', false),
        /start the agent/
    )
})

test('a daemon service-framework agent stays unsupported', async () => {
    const db = fakeDb(agentRow({ framework: 'hermes' }))
    const svc = build(db, fakeRegistry({ ok: true }))
    const status = await svc.getStatus('user-1', 'agent-1', false)
    assert.equal(status.supported, false)
})
