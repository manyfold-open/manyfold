import test from 'node:test'
import assert from 'node:assert/strict'
import { agents, agentRuntimes, type Database } from '@manyfold/db'
import { AgentRuntimeAgentResolver } from '../src/modules/auth/resolvers/agent-runtime-agent.resolver'

interface RuntimeRow {
    id: string
    userId: string
}

interface AgentRow {
    id: string
    runtimeId: string | null
    userId: string
}

class FakeDb {
    runtimes: RuntimeRow[] = [
        { id: 'rt_user1_solo', userId: 'user-1' },
        { id: 'rt_user1_multi', userId: 'user-1' },
        { id: 'rt_user2_solo', userId: 'user-2' }
    ]
    agents: AgentRow[] = [
        { id: 'agt_A', runtimeId: 'rt_user1_solo', userId: 'user-1' },
        { id: 'agt_B', runtimeId: 'rt_user1_multi', userId: 'user-1' },
        { id: 'agt_C', runtimeId: 'rt_user1_multi', userId: 'user-1' },
        { id: 'agt_D', runtimeId: 'rt_user2_solo', userId: 'user-2' }
    ]

    select(_shape?: unknown) {
        return new FakeQuery(this, 'select')
    }
}

class FakeQuery {
    private table: unknown
    private whereParams: unknown[] = []

    constructor(
        private readonly db: FakeDb,
        _op: 'select'
    ) {
        void _op
    }

    from(table: unknown) {
        this.table = table
        return this
    }

    where(cond: unknown) {
        this.whereParams = collectParams(cond)
        return this
    }

    limit(_n: number) {
        const params = this.whereParams
        const userParam = params.find(
            (p): p is string => typeof p === 'string' && p.startsWith('user-')
        )
        if (this.table === agentRuntimes) {
            const runtimeParam = params.find(
                (p): p is string => typeof p === 'string' && p.startsWith('rt_')
            )
            const row = this.db.runtimes.find(
                (r) => r.id === runtimeParam && r.userId === userParam
            )
            return Promise.resolve(row ? [{ id: row.id }] : [])
        }
        if (this.table === agents) {
            const runtimeParam = params.find(
                (p): p is string => typeof p === 'string' && p.startsWith('rt_')
            )
            const matched = this.db.agents.filter(
                (a) => a.runtimeId === runtimeParam && a.userId === userParam
            )
            return Promise.resolve(matched.map((a) => ({ id: a.id })))
        }
        return Promise.resolve([])
    }
}

const collectParams = (cond: unknown): unknown[] => {
    const out: unknown[] = []
    const seen = new WeakSet<object>()
    const walk = (node: unknown): void => {
        if (node === null || node === undefined) return
        if (typeof node !== 'object') return
        if (seen.has(node as object)) return
        seen.add(node as object)
        const rec = node as Record<string, unknown>
        if ('value' in rec && typeof rec.value !== 'object') out.push(rec.value)
        for (const key of Object.keys(rec)) walk(rec[key])
    }
    walk(cond)
    return out
}

const newResolver = () =>
    new AgentRuntimeAgentResolver(new FakeDb() as unknown as Database)

test('AgentRuntimeAgentResolver returns the agent id for a single-agent runtime', async () => {
    const resolver = newResolver()
    const result = await resolver.resolveAgentId('rt_user1_solo', 'user-1')
    assert.equal(result, 'agt_A')
})

test('AgentRuntimeAgentResolver returns null for multi-agent runtime', async () => {
    const resolver = newResolver()
    const result = await resolver.resolveAgentId('rt_user1_multi', 'user-1')
    assert.equal(result, null)
})

test('AgentRuntimeAgentResolver returns null for runtime not owned by user', async () => {
    const resolver = newResolver()
    const result = await resolver.resolveAgentId('rt_user2_solo', 'user-1')
    assert.equal(result, null)
})

test('AgentRuntimeAgentResolver returns null for unknown runtime', async () => {
    const resolver = newResolver()
    const result = await resolver.resolveAgentId('rt_missing', 'user-1')
    assert.equal(result, null)
})
