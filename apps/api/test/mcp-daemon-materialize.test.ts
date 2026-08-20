import assert from 'node:assert/strict'
import test from 'node:test'
import { agentRuntimes, agents, runtimeHosts } from '@manyfold/db'
import { McpConfigMaterializer } from '../src/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { readJsonbMergePatch } from './jsonb-merge'

// Daemon delivery for the MCP materializer (#781): scopes go over the daemon
// fs RPCs, the claude-code user scope is gated on the CLI's advertised
// containment feature (skipped, never attempted, on older CLIs), and every
// push persists a per-scope outcome to extras.mcpDelivery — a daemon has no
// bootstrap to re-materialize at, so the last outcome must survive.

const CLAUDE_USER = '/home/cy/.claude.json'
const PROJECT = '/home/cy/ws/.mcp.json'

const agentRow = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'user-1',
    runtime: 'daemon',
    framework: 'claude-code',
    daemonId: 'dh-1',
    runtimeId: 'art-1',
    workspacePath: '/home/cy/ws',
    mountPath: '/home/cy/ws',
    extras: {
        mcp: {
            user: '{"srv":{"command":"x"}}',
            project: '{"proj":{"command":"y"}}'
        }
    },
    ...over
})

const fakeDb = (opts: { clientFeatures: string[] }) => {
    const updates: Array<Record<string, unknown>> = []
    return {
        updates,
        select: () => ({
            from: (table: unknown) => ({
                where: () => ({
                    limit: async () => {
                        if (table === agentRuntimes)
                            return [{ homeDir: '/home/cy' }]
                        if (table === runtimeHosts)
                            return [{ clientFeatures: opts.clientFeatures }]
                        return []
                    }
                })
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

interface RpcCall {
    method: string
    payload: Record<string, unknown>
}

const fakeRegistry = (opts: {
    offline?: boolean
    files?: Record<string, string>
}) => {
    const calls: RpcCall[] = []
    return {
        calls,
        rpc: async (args: RpcCall & { daemonId: string }) => {
            if (opts.offline)
                throw new Error(`daemon ${args.daemonId} is not connected`)
            calls.push({ method: args.method, payload: args.payload })
            if (args.method === 'fs.read') {
                const content = opts.files?.[String(args.payload.path)]
                if (content === undefined)
                    throw new Error('ENOENT: no such file or directory')
                return { content, chunked: false }
            }
            return {}
        }
    }
}

const build = (
    db: ReturnType<typeof fakeDb>,
    registry: ReturnType<typeof fakeRegistry>
): McpConfigMaterializer =>
    new McpConfigMaterializer(
        db as never,
        {} as never,
        {} as never,
        registry as never
    )

test('a new-CLI daemon gets every scope written with mode 600', async () => {
    const db = fakeDb({
        clientFeatures: ['fs.claude-user-config', 'fs.write.mode']
    })
    const registry = fakeRegistry({ files: {} })
    const svc = build(db, registry)

    const results = await svc.materializeForAgent(agentRow() as never)

    assert.deepEqual(
        results.map((r) => `${r.scopeId}:${r.status}`),
        ['user:delivered', 'project:delivered']
    )
    const writes = registry.calls.filter((c) => c.method === 'fs.write')
    assert.deepEqual(writes.map((w) => w.payload.path).sort(), [
        CLAUDE_USER,
        PROJECT
    ])
    for (const write of writes) assert.equal(write.payload.mode, '600')
    const patch = readJsonbMergePatch(db.updates[0].extras)
    const delivery = patch?.mcpDelivery as Record<string, { status: string }>
    assert.equal(delivery.user.status, 'delivered')
    assert.equal(delivery.project.status, 'delivered')
})

test('an old-CLI daemon skips the claude user scope without attempting it', async () => {
    const db = fakeDb({ clientFeatures: [] })
    const registry = fakeRegistry({ files: {} })
    const svc = build(db, registry)

    const results = await svc.materializeForAgent(agentRow() as never)

    assert.deepEqual(
        results.map((r) => `${r.scopeId}:${r.status}`),
        ['user:skipped', 'project:delivered']
    )
    assert.match(
        results[0].message ?? '',
        /newer mf CLI/,
        'the skip must say how to unblock'
    )
    // Never attempted: no fs RPC ever names ~/.claude.json.
    assert.equal(
        registry.calls.some((c) => c.payload.path === CLAUDE_USER),
        false
    )
    // No mode field without fs.write.mode.
    const write = registry.calls.find((c) => c.method === 'fs.write')
    assert.equal(write?.payload.mode, undefined)
    const patch = readJsonbMergePatch(db.updates[0].extras)
    const delivery = patch?.mcpDelivery as Record<
        string,
        { status: string; message?: string }
    >
    assert.equal(delivery.user.status, 'skipped')
})

test('an offline daemon persists failed outcomes instead of a log line', async () => {
    const db = fakeDb({
        clientFeatures: ['fs.claude-user-config', 'fs.write.mode']
    })
    const registry = fakeRegistry({ offline: true })
    const svc = build(db, registry)

    const results = await svc.materializeForAgent(agentRow() as never)

    assert.deepEqual(
        results.map((r) => `${r.scopeId}:${r.status}`),
        ['user:failed', 'project:failed']
    )
    const patch = readJsonbMergePatch(db.updates[0].extras)
    const delivery = patch?.mcpDelivery as Record<
        string,
        { status: string; message?: string }
    >
    assert.match(delivery.user.message ?? '', /not connected/)
})

test('an unchanged scope persists as delivered and writes nothing', async () => {
    const db = fakeDb({
        clientFeatures: ['fs.claude-user-config', 'fs.write.mode']
    })
    // Files already carry exactly the desired content.
    const registry = fakeRegistry({ files: {} })
    const svc = build(db, registry)
    const first = await svc.materializeForAgent(agentRow() as never)
    assert.deepEqual(
        first.map((r) => r.status),
        ['delivered', 'delivered']
    )
    const written = Object.fromEntries(
        registry.calls
            .filter((c) => c.method === 'fs.write')
            .map((c) => [String(c.payload.path), String(c.payload.content)])
    )
    const registry2 = fakeRegistry({ files: written })
    const db2 = fakeDb({
        clientFeatures: ['fs.claude-user-config', 'fs.write.mode']
    })
    const second = await build(db2, registry2).materializeForAgent(
        agentRow() as never
    )
    assert.deepEqual(
        second.map((r) => r.status),
        ['unchanged', 'unchanged']
    )
    assert.equal(
        registry2.calls.some((c) => c.method === 'fs.write'),
        false
    )
    const patch = readJsonbMergePatch(db2.updates[0].extras)
    const delivery = patch?.mcpDelivery as Record<string, { status: string }>
    assert.equal(delivery.user.status, 'delivered')
})

test('a k8s agent cannot be pushed to and says so', async () => {
    const db = fakeDb({ clientFeatures: [] })
    const svc = build(db, fakeRegistry({}))
    await assert.rejects(
        () => svc.materializeForAgent(agentRow({ runtime: 'k8s' }) as never),
        /cannot be pushed/
    )
})
