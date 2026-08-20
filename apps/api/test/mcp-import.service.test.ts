import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { McpImportService } from '../src/modules/agents/mcp-import.service'
import { readJsonbMergePatch } from './jsonb-merge'

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    spriteName: 'sprite-1',
    accountId: 'acct-1',
    runtimeId: 'rt-1',
    workspacePath: '/home/test/.manyfold/workspaces/agent-1',
    mountPath: '/home/test/.manyfold/workspaces/agent-1',
    extras: { mcp: { user: '{"old":{}}', project: '{"keep":{}}' } }
}

const summary = { id: 'agent-1' }

const fakeDb = (): {
    updates: Array<Record<string, unknown>>
    select: () => unknown
    update: () => unknown
} => {
    const updates: Array<Record<string, unknown>> = []
    return {
        updates,
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ homeDir: '/home/test' }]
                })
            })
        }),
        update: () => ({
            set: (values: Record<string, unknown>) => ({
                where: async () => {
                    updates.push(values)
                }
            })
        })
    }
}

const fakeAccounts = {
    getById: async () => ({ slug: 'acct' }),
    decryptToken: () => 'token'
}

const fakeAgents = {
    findForCaller: async () => ({ ...agentRow }),
    get: async () => summary
}

class TestImport extends McpImportService {
    reads: Record<string, string | null> = {}
    failReads = false

    constructor(db: ReturnType<typeof fakeDb>) {
        super(
            db as never,
            fakeAccounts as never,
            fakeAgents as never,
            {} as never
        )
    }

    protected override async readerFor(): Promise<
        (absPath: string) => Promise<string | null>
    > {
        return async (absPath) => {
            if (this.failReads) throw new Error('sprite unreachable')
            return this.reads[absPath] ?? null
        }
    }
}

// Never-clobber at the service level: a scope whose file is absent (cold
// sprite, pre-bootstrap) keeps its stored value in the single merged write,
// and the response agent is re-read AFTER the update.
test('mcp import merges imported scopes and preserves skipped scopes', async () => {
    const db = fakeDb()
    const svc = new TestImport(db)
    svc.reads['/home/test/.claude.json'] =
        '{"theme":"dark","mcpServers":{"new":{"command":"x"}}}'

    const res = await svc.refresh('agent-1', 'user-1', false)

    assert.equal(db.updates.length, 1)
    const patch = readJsonbMergePatch(db.updates[0].extras)
    assert.ok(patch)
    const mcp = patch.mcp as Record<string, string>
    assert.deepEqual(JSON.parse(mcp.user), { new: { command: 'x' } })
    assert.equal(mcp.project, '{"keep":{}}')
    assert.equal(res.agent, summary as never)
    assert.deepEqual(
        res.scopes.map((s) => `${s.scopeId}:${s.status}`),
        ['user:imported', 'project:skipped']
    )
})

test('mcp import 503s and leaves the DB untouched when the sprite read fails', async () => {
    const db = fakeDb()
    const svc = new TestImport(db)
    svc.failReads = true

    await assert.rejects(
        () => svc.refresh('agent-1', 'user-1', false),
        ServiceUnavailableException
    )
    assert.equal(db.updates.length, 0)
})

// #781: a daemon whose CLI predates the ~/.claude.json containment gets the
// user scope declared skipped (with the unblock path) and never read; the
// readable scopes import normally and the skipped scope's stored value
// survives the merged write.
test('mcp import on an old-CLI daemon skips the claude user scope loudly', async () => {
    const db = fakeDb()
    const svc = new TestImport(db)
    const daemonAgent = {
        ...agentRow,
        runtime: 'daemon',
        daemonId: 'dh-1',
        spriteName: null,
        accountId: null
    }
    ;(
        svc as unknown as {
            agents: { findForCaller: () => Promise<unknown> }
        }
    ).agents.findForCaller = async () => ({ ...daemonAgent })
    svc.reads['/home/test/.manyfold/workspaces/agent-1/.mcp.json'] =
        '{"mcpServers":{"proj":{"command":"z"}}}'

    const res = await svc.refresh('agent-1', 'user-1', false)

    assert.deepEqual(
        res.scopes.map((s) => `${s.scopeId}:${s.status}`),
        ['user:skipped', 'project:imported']
    )
    assert.match(res.scopes[0].message ?? '', /newer mf CLI/)
    const patch = readJsonbMergePatch(db.updates[0].extras)
    const mcp = patch?.mcp as Record<string, string>
    assert.equal(mcp.user, '{"old":{}}')
    assert.deepEqual(JSON.parse(mcp.project), { proj: { command: 'z' } })
})
