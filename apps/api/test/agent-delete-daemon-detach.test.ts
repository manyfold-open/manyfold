import test from 'node:test'
import assert from 'node:assert/strict'
import { ConflictException, InternalServerErrorException } from '@nestjs/common'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { OpenclawAgentAdapter } from '../src/modules/agents/adapters/openclaw-agent.adapter'
import { HermesAgentAdapter } from '../src/modules/agents/adapters/hermes-agent.adapter'

// #551: DELETE /api/agents/:id on a daemon agent whose daemon was offline
// returned an opaque 500 ('daemon detach failed') and the inner reason only
// survived in audit_logs. The observed staging failure was the rpc lookup
// throwing `daemon dh_… is offline; no active websocket` before anything went
// on the wire.

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'laptop-openclaw',
    framework: 'openclaw',
    kind: 'daemon',
    status: 'stopped',
    daemonId: 'dh-1',
    primaryAgentId: null,
    accountId: null,
    spriteName: null,
    spriteId: null,
    mountPath: '/home/user/.openclaw',
    createdAt: new Date('2026-07-29'),
    updatedAt: new Date('2026-07-29'),
    ...over
})

const fakeAgent = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    framework: 'openclaw',
    runtime: 'daemon',
    name: 'main',
    internalId: 'main',
    status: 'stopped',
    workspacePath: '/home/user/.openclaw/workspace',
    mountPath: '/home/user/.openclaw',
    fileRoots: [],
    extras: {},
    createdAt: new Date('2026-07-29'),
    updatedAt: new Date('2026-07-29'),
    ...over
})

const makeFakeDb = (rows: ReturnType<typeof fakeAgent>[]) => {
    const updates: Array<Record<string, unknown>> = []
    const deletes: Array<unknown> = []
    const audits: Array<{ action: string; meta: Record<string, unknown> }> = []
    return {
        updates,
        deletes,
        audits,
        select: () => ({
            from: (_table: unknown) => ({
                where: (_w: unknown) => ({
                    limit: async (_n: number) => rows.slice(0, 1),
                    orderBy: () => ({
                        limit: async (_n: number) => rows.slice(1, 2)
                    })
                }),
                limit: async (_n: number) => rows.slice(0, 1)
            })
        }),
        update: (_table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: async (_w: unknown) => {
                    updates.push(s)
                }
            })
        }),
        delete: (_table: unknown) => ({
            where: async (_w: unknown) => {
                deletes.push('agents')
            }
        }),
        insert: (_table: unknown) => ({
            values: async (v: {
                action: string
                meta: Record<string, unknown>
            }) => {
                audits.push({ action: v.action, meta: v.meta })
            }
        })
    }
}

const makeSvc = (args: {
    db: ReturnType<typeof makeFakeDb>
    runtime?: ReturnType<typeof fakeRuntime>
    removeAgent: () => Promise<void>
}) => {
    const telemetryEvents: Array<{
        name: string
        attrs: Record<string, unknown>
    }> = []
    const ctor = new Array(19).fill({}) as never[]
    ctor[0] = args.db as never
    ctor[4] = {
        findById: async () => args.runtime ?? fakeRuntime()
    } as never
    ctor[11] = {
        get: () => ({ removeAgent: args.removeAgent })
    } as never
    ctor[18] = {
        event: (name: string, attrs: Record<string, unknown>) => {
            telemetryEvents.push({ name, attrs })
        }
    } as never
    const svc = new AgentOrchestratorService(
        ...(ctor as unknown as ConstructorParameters<
            typeof AgentOrchestratorService
        >)
    )
    return { svc, telemetryEvents }
}

const auditActions = (db: ReturnType<typeof makeFakeDb>) =>
    db.audits.map((a) => a.action)

test('daemon offline at rpc lookup: typed retryable 409, row and pointer untouched', async () => {
    // The exact staging failure from #551 (trace e93771fb…): the delete threw
    // before any frame reached the daemon.
    const db = makeFakeDb([fakeAgent()])
    const { svc, telemetryEvents } = makeSvc({
        db,
        removeAgent: async () => {
            throw new Error('daemon dh-1 is offline; no active websocket')
        }
    })

    const err = await svc.delete('agent-1', 'u-1', false).then(
        () => assert.fail('delete must not succeed'),
        (e: unknown) => e
    )

    assert.ok(err instanceof ConflictException, `got ${String(err)}`)
    const body = err.getResponse() as {
        code: string
        message: string
        details: Record<string, unknown>
    }
    assert.equal(body.code, 'agent.daemon_unavailable')
    assert.equal(body.details.retryable, true)
    assert.equal(body.details.agentId, 'agent-1')
    assert.equal(body.details.runtimeId, 'rt-1')
    assert.equal(body.details.daemonId, 'dh-1')
    assert.match(String(body.details.reason), /offline; no active websocket/)
    assert.match(body.message, /revoke and permanently delete/)

    assert.equal(db.deletes.length, 0, 'agent row must survive')
    assert.equal(db.updates.length, 0, 'primary pointer must not move')
    assert.deepEqual(auditActions(db), [
        'agent.delete.started',
        'agent.delete.failed'
    ])
    assert.equal(db.audits[1].meta.failureClass, 'daemon_unavailable')
    assert.equal(db.audits[1].meta.daemonId, 'dh-1')

    assert.equal(telemetryEvents.length, 1)
    assert.equal(telemetryEvents[0].name, 'agent.delete.detach_failed')
    assert.equal(telemetryEvents[0].attrs.failureClass, 'daemon_unavailable')
    assert.match(
        String(telemetryEvents[0].attrs.reason),
        /offline; no active websocket/
    )
})

test('transport drop mid-detach and rpc timeout are the same retryable class', async () => {
    for (const message of [
        'connection replaced',
        'daemon disconnected',
        'rpc broker shutting down',
        'daemon dh-1 is not connected',
        'daemon dh-1 websocket lease is stale on this api instance',
        'rpc exec.start timed out'
    ]) {
        const db = makeFakeDb([fakeAgent()])
        const { svc } = makeSvc({
            db,
            removeAgent: async () => {
                throw new Error(message)
            }
        })
        const err = await svc.delete('agent-1', 'u-1', false).then(
            () => assert.fail(`delete must not succeed for "${message}"`),
            (e: unknown) => e
        )
        assert.ok(
            err instanceof ConflictException,
            `"${message}" should be retryable, got ${String(err)}`
        )
        assert.equal(db.deletes.length, 0)
    }
})

test('daemon answered and refused: 500 keeps the sanitized reason and identifiers', async () => {
    const db = makeFakeDb([fakeAgent()])
    const { svc, telemetryEvents } = makeSvc({
        db,
        removeAgent: async () => {
            throw new Error(
                'openclaw agents delete failed (exit 1): agent is busy'
            )
        }
    })

    const err = await svc.delete('agent-1', 'u-1', false).then(
        () => assert.fail('delete must not succeed'),
        (e: unknown) => e
    )

    assert.ok(err instanceof InternalServerErrorException, String(err))
    const body = err.getResponse() as {
        code: string
        details: Record<string, unknown>
    }
    assert.equal(body.code, 'agent.daemon_detach_failed')
    assert.equal(body.details.retryable, false)
    assert.match(String(body.details.reason), /exit 1.*agent is busy/)
    assert.equal(body.details.daemonId, 'dh-1')
    assert.equal(db.deletes.length, 0)
    assert.equal(db.audits[1].meta.failureClass, 'detach_failed')
    assert.equal(telemetryEvents[0].attrs.failureClass, 'detach_failed')
})

test('successful detach deletes the row and emits AGENT_DELETE_SUCCEEDED exactly once', async () => {
    const db = makeFakeDb([fakeAgent()])
    const { svc, telemetryEvents } = makeSvc({
        db,
        removeAgent: async () => {}
    })

    await svc.delete('agent-1', 'u-1', false)

    assert.equal(db.deletes.length, 1)
    assert.deepEqual(auditActions(db), [
        'agent.delete.started',
        'agent.delete.succeeded'
    ])
    assert.equal(db.updates.length, 0, 'non-primary: pointer untouched')
    assert.equal(telemetryEvents.length, 0)
})

test('successful primary detach promotes the oldest sibling before deleting', async () => {
    const db = makeFakeDb([
        fakeAgent(),
        fakeAgent({ id: 'agent-2', createdAt: new Date('2026-08-01') })
    ])
    const { svc } = makeSvc({
        db,
        runtime: fakeRuntime({ primaryAgentId: 'agent-1' }),
        removeAgent: async () => {}
    })

    await svc.delete('agent-1', 'u-1', false)

    assert.equal(db.deletes.length, 1)
    assert.ok(
        db.updates.some((u) => u.primaryAgentId === 'agent-2'),
        'primary pointer should advance to the surviving sibling'
    )
})

// The retryable 409 relies on re-running the detach being safe: both exec
// adapters must treat an agent the daemon no longer knows as already deleted.

const removeCtx = (internalId: string) =>
    ({
        runtime: fakeRuntime(),
        agent: fakeAgent({ internalId }),
        primaryAgentId: null
    }) as never

const execReturning = (res: {
    exitCode: number
    stdout?: string
    stderr?: string
}) =>
    ({
        forRuntime: async () => ({
            run: async () => ({
                exitCode: res.exitCode,
                stdout: res.stdout ?? '',
                stderr: res.stderr ?? ''
            })
        })
    }) as never

test('openclaw removeAgent: already-absent remote agent resolves idempotently', async () => {
    const adapter = new OpenclawAgentAdapter(
        execReturning({
            exitCode: 1,
            stderr: "Error: agent 'main' not found"
        })
    )
    await adapter.removeAgent(removeCtx('main'))
})

test('openclaw removeAgent: a real CLI failure still throws', async () => {
    const adapter = new OpenclawAgentAdapter(
        execReturning({ exitCode: 1, stderr: 'config locked by another pid' })
    )
    await assert.rejects(
        adapter.removeAgent(removeCtx('main')),
        /openclaw agents delete failed \(exit 1\)/
    )
})

test('hermes removeAgent: already-absent remote profile resolves idempotently', async () => {
    const adapter = new HermesAgentAdapter(
        execReturning({ exitCode: 1, stderr: 'no such profile: prof-9' })
    )
    await adapter.removeAgent(removeCtx('prof-9'))
})
