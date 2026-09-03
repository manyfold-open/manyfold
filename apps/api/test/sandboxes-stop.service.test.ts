import type { AgentStopResponse } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import type {
    ExecOptions,
    ExecResult,
    ServiceObject,
    SpritesClient
} from '@manyfold/sprites'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

const ok = (stdout: string): ExecResult => ({
    exitCode: 0,
    stdout,
    stderr: ''
})

const service = (
    name: string,
    status: ServiceObject['state']['status']
): ServiceObject =>
    ({
        name,
        cmd: 'noop',
        state: { name, status }
    }) as ServiceObject

class TestSandboxes extends SandboxesService {
    execCalls: ExecOptions[] = []
    // Queue consumed per exec; empty queue falls back to an empty task list.
    execResults: ExecResult[] = []
    execError: Error | null = null
    fakeClient: Partial<SpritesClient> = {}

    protected exec(
        _client: SpritesClient,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execCalls.push(opts)
        if (this.execError) return Promise.reject(this.execError)
        return Promise.resolve(this.execResults.shift() ?? ok('{"tasks":[]}'))
    }

    protected spritesClientFor(): SpritesClient {
        return this.fakeClient as SpritesClient
    }
}

const baseHost = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_1',
    userId: 'u1',
    spriteId: 'spr_1',
    spriteName: 'sbx-sprite',
    accountId: 'spa_1',
    spriteStatus: 'running',
    ...over
})

interface StopHarness {
    svc: TestSandboxes
    stopSpriteCalls: Array<{
        agentId: string
        caller: string
        isAdmin: boolean
    }>
    keepAliveDisabled: string[]
    releaseCalls: Array<{ runtimeId: string; reason: string }>
    refreshCalls: number[]
    auditRows: Array<Record<string, unknown>>
    stopServiceCalls: string[]
}

const makeStop = (opts: {
    host?: Record<string, unknown>
    agents?: Array<{ id: string; runtimeId: string }>
    stopResponses?: Record<string, AgentStopResponse | Error>
    runtimes?: Array<{ id: string; keepAliveEnabled: boolean }>
    releaseResults?: Record<
        string,
        { state: string; maxStaleSec: number; message?: string }
    >
    services?: ServiceObject[]
    stopService?: (name: string, call: number) => ServiceObject
    refreshFails?: boolean
}): StopHarness => {
    const host = opts.host ?? baseHost()
    const stopSpriteCalls: StopHarness['stopSpriteCalls'] = []
    const keepAliveDisabled: string[] = []
    const releaseCalls: StopHarness['releaseCalls'] = []
    const refreshCalls: number[] = []
    const auditRows: StopHarness['auditRows'] = []
    const stopServiceCalls: string[] = []
    const stopCounts = new Map<string, number>()

    const runtimes = {
        getSandboxForUser: async () => ({ host }),
        getSandboxById: async () => ({ host }),
        listAgentsByHost: async () => opts.agents ?? [],
        listRuntimesByHost: async () => opts.runtimes ?? [],
        setKeepAliveEnabled: async (id: string) => {
            keepAliveDisabled.push(id)
        }
    }
    const accounts = {
        getById: async () => ({ id: 'spa_1', slug: 'acct' }),
        decryptToken: () => 'tok'
    }
    const agents = {
        stopSprite: async (
            agentId: string,
            caller: string,
            isAdmin: boolean
        ) => {
            stopSpriteCalls.push({ agentId, caller, isAdmin })
            const res = opts.stopResponses?.[agentId]
            if (res instanceof Error) throw res
            return (
                res ?? {
                    status: 'pending',
                    estimatedReadyInSec: 35,
                    closedSessions: 0
                }
            )
        }
    }
    const keepAliveLease = {
        stopAndRelease: async (
            rt: { id: string },
            reason: string
        ): Promise<unknown> => {
            releaseCalls.push({ runtimeId: rt.id, reason })
            return (
                opts.releaseResults?.[rt.id] ?? {
                    state: 'not_applicable',
                    maxStaleSec: 0
                }
            )
        }
    }
    const spriteStatusSync = {
        refreshSandboxHost: async () => {
            refreshCalls.push(1)
            if (opts.refreshFails) throw new Error('refresh boom')
        }
    }
    const db = {
        insert: () => ({
            values: (row: Record<string, unknown>) => {
                auditRows.push(row)
                return Promise.resolve()
            }
        })
    }

    const svc = new TestSandboxes(
        runtimes as never,
        {} as never,
        accounts as never,
        {} as never,
        {} as never,
        spriteStatusSync as never,
        {} as never,
        agents as never,
        keepAliveLease as never,
        db as never
    )
    svc.fakeClient = {
        listServices: async () => (opts.services ?? []) as never,
        stopService: async (_sprite: string, name: string) => {
            stopServiceCalls.push(name)
            const call = (stopCounts.get(name) ?? 0) + 1
            stopCounts.set(name, call)
            if (!opts.stopService) return service(name, 'stopped') as never
            const out = opts.stopService(name, call)
            return out as never
        }
    }
    return {
        svc,
        stopSpriteCalls,
        keepAliveDisabled,
        releaseCalls,
        refreshCalls,
        auditRows,
        stopServiceCalls
    }
}

const auditMeta = (h: StopHarness): Record<string, unknown> =>
    h.auditRows[0].meta as Record<string, unknown>

test('stop is a noop on a non-running sandbox and touches nothing', async () => {
    const h = makeStop({ host: baseHost({ spriteStatus: 'warm' }) })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.status, 'noop')
    assert.equal(h.stopSpriteCalls.length, 0)
    assert.equal(h.stopServiceCalls.length, 0)
    assert.equal(h.svc.execCalls.length, 0)
    assert.equal(h.refreshCalls.length, 0)
})

test('stop stops only non-managed, non-stopped services', async () => {
    const h = makeStop({
        services: [
            service('hermes', 'running'),
            service('hermes-proxy', 'running'),
            service('my-http', 'running'),
            service('old', 'stopped'),
            service('crashy', 'failed')
        ]
    })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.deepEqual(h.stopServiceCalls.sort(), ['crashy', 'my-http'])
    assert.deepEqual(res.stoppedServices.sort(), ['crashy', 'my-http'])
    assert.equal(res.warnings.length, 0)
})

test('stop sweeps services in passes so needs-blocked stops succeed later', async () => {
    // A refuses while B runs (needs); once B stops, pass 2 stops A.
    let bStopped = false
    const h = makeStop({
        services: [service('a', 'running'), service('b', 'running')],
        stopService: (name) => {
            if (name === 'b') {
                bStopped = true
                return service('b', 'stopped')
            }
            return service('a', bStopped ? 'stopped' : 'running')
        }
    })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.deepEqual(res.stoppedServices.sort(), ['a', 'b'])
    assert.equal(res.warnings.length, 0)
})

test('stop surfaces services that never stop as warnings, not failures', async () => {
    const h = makeStop({
        services: [service('stubborn', 'running')],
        stopService: (name) => service(name, 'running')
    })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.stoppedServices.length, 0)
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /refused to stop/)
})

test('stop treats a vanished service as stopped and warns on other errors', async () => {
    const gone = new SpritesError('not_found', 'gone', 404)
    const boom = new SpritesError('transient', 'boom', 500)
    const h = makeStop({
        services: [service('gone', 'running'), service('broken', 'running')]
    })
    h.svc.fakeClient.stopService = async (_s: string, name: string) => {
        h.stopServiceCalls.push(name)
        throw name === 'gone' ? gone : boom
    }

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.deepEqual(res.stoppedServices, ['gone'])
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /failed to stop service 'broken'/)
})

test('stop deletes only agent-registered tasks and reports re-registration', async () => {
    const h = makeStop({})
    h.svc.execResults = [
        // task list read
        ok(
            JSON.stringify({
                tasks: [
                    { name: 'nca-hermes-abc-1' },
                    { name: 'hermes-keepalive' },
                    { name: 'my-task' },
                    { name: 'sticky' }
                ]
            })
        ),
        // delete my-task → verify list without it
        ok('{"tasks":[{"name":"sticky"}]}'),
        // delete sticky → verify list still contains it (re-registered)
        ok('{"tasks":[{"name":"sticky"}]}')
    ]

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.deepEqual(res.deletedTasks, ['my-task'])
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /task 'sticky' is still registered/)
    // list + two delete round-trips, never one for the platform leases
    assert.equal(h.svc.execCalls.length, 3)
})

test('stop aggregates estimatedReadyInSec across agents and releases', async () => {
    const agents = [
        { id: 'agt_1', runtimeId: 'art_1' },
        { id: 'agt_2', runtimeId: 'art_2' }
    ]
    const h = makeStop({
        agents,
        stopResponses: {
            agt_1: {
                status: 'pending',
                estimatedReadyInSec: 90,
                closedSessions: 1
            },
            agt_2: { status: 'noop', estimatedReadyInSec: 0, closedSessions: 0 }
        },
        // agt_2 noop'd, so its runtime falls through to the belt-and-braces
        // pass, which reports a degraded release.
        runtimes: [
            { id: 'art_1', keepAliveEnabled: false },
            { id: 'art_2', keepAliveEnabled: true }
        ],
        releaseResults: {
            art_2: { state: 'degraded', maxStaleSec: 390, message: 'stale' }
        }
    })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.stoppedAgents, 1)
    assert.equal(res.estimatedReadyInSec, 390)
    assert.deepEqual(h.keepAliveDisabled, ['art_2'])
    assert.deepEqual(h.releaseCalls, [
        { runtimeId: 'art_2', reason: 'sandbox-stop' }
    ])
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /runtime art_2: stale/)
})

test('stop defaults the estimate to the auto-sleep floor', async () => {
    const h = makeStop({})

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.estimatedReadyInSec, 35)
})

test('stop releases orphan runtimes no agent points at', async () => {
    const h = makeStop({
        agents: [{ id: 'agt_1', runtimeId: 'art_1' }],
        runtimes: [
            { id: 'art_1', keepAliveEnabled: false },
            { id: 'art_orphan', keepAliveEnabled: true }
        ]
    })

    await h.svc.stop('u1', 'sbx_1')

    // art_1 was handled via its agent's pending stop; only the orphan is
    // released directly.
    assert.deepEqual(h.keepAliveDisabled, ['art_orphan'])
    assert.deepEqual(
        h.releaseCalls.map((c) => c.runtimeId),
        ['art_orphan']
    )
})

test('stop passes the real caller through to per-agent stops', async () => {
    const h = makeStop({ agents: [{ id: 'agt_1', runtimeId: 'art_1' }] })

    await h.svc.stop('admin1', 'sbx_1', true)

    assert.deepEqual(h.stopSpriteCalls, [
        { agentId: 'agt_1', caller: 'admin1', isAdmin: true }
    ])
})

test('stop keeps going when a single agent stop throws', async () => {
    const h = makeStop({
        agents: [
            { id: 'agt_bad', runtimeId: 'art_bad' },
            { id: 'agt_ok', runtimeId: 'art_ok' }
        ],
        stopResponses: { agt_bad: new Error('boom') }
    })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.stoppedAgents, 1)
    assert.equal(h.stopSpriteCalls.length, 2)
    assert.match(res.warnings[0], /agent agt_bad stop failed: boom/)
})

test('stop warns when the status refresh fails and still audits', async () => {
    const h = makeStop({ refreshFails: true })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.match(res.warnings[0], /status refresh failed/)
    assert.equal(h.auditRows.length, 1)
    assert.equal(h.auditRows[0].action, 'sandbox.stop')
    assert.equal(h.auditRows[0].subject, 'sbx_1')
})

// WHY this test exists: agents, runtimes, services and tasks are every lever a
// stop has. A running VM with none of them is being held awake by something
// out of reach, so the stop cannot work — and saying `pending` with empty
// arrays is how prod hid that for three days (2026-09-03: 60 audited stops in
// one day on a sandbox billing 52h against a 5h quota, because a leaked exec
// session was holding it and the agent had already been deleted).
test('a running sandbox with nothing registered on it says so instead of reporting a clean stop', async () => {
    const h = makeStop({})

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.status, 'pending')
    assert.equal(res.stoppedAgents, 0)
    assert.match(
        res.warnings.join('\n'),
        /nothing on this sandbox could be stopped/
    )
    assert.equal(auditMeta(h).hasNoLevers, true)
})

// The other half: a stop with something to work on must not carry the warning,
// or it becomes noise on every ordinary stop and stops meaning anything.
test('a sandbox with an agent on it gets no such warning', async () => {
    const h = makeStop({ agents: [{ id: 'agt_1', runtimeId: 'rt_1' }] })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.equal(res.stoppedAgents, 1)
    assert.deepEqual(res.warnings, [])
    assert.equal(auditMeta(h).hasNoLevers, false)
})

// Registered-but-unstoppable is NOT the same fault: the levers exist, one of
// them refused. That case already surfaces its own warning and must not also
// claim there was nothing to stop.
test('a service that refuses to stop is not reported as having no levers', async () => {
    const h = makeStop({
        services: [service('deck', 'running')],
        stopService: (name) => service(name, 'running')
    })

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.match(res.warnings.join('\n'), /refused to stop/)
    assert.ok(
        !res.warnings.join('\n').includes('nothing on this sandbox'),
        'a present-but-stuck service is a different diagnosis'
    )
    assert.equal(auditMeta(h).hasNoLevers, false)
})

// A task the platform owns (a keep-alive lease) is deliberately not deleted by
// stop(), so deletedTasks stays empty — but the task is exactly the explanation
// for the VM being up, so this is not the no-levers case either.
test('a platform task on the sprite counts as a lever even though stop leaves it alone', async () => {
    const h = makeStop({})
    h.svc.execResults = [ok('{"tasks":[{"name":"nca-claude-code-abc-1"}]}')]

    const res = await h.svc.stop('u1', 'sbx_1')

    assert.deepEqual(res.deletedTasks, [])
    assert.ok(
        !res.warnings.join('\n').includes('nothing on this sandbox'),
        'a platform keep-alive task explains the running VM'
    )
    assert.equal(auditMeta(h).hasNoLevers, false)
})
