import assert from 'node:assert/strict'
import test from 'node:test'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import {
    AwakeLeaseStillHeldError,
    type ProviderService
} from '../src/modules/hosts/providers/sandbox-provider'

// Sandbox-wide stop (ADR-0037): every wake cause the platform owns is removed
// in one action — exec sessions closed, the host's keep-awake switch turned
// off and its lease released, framework services stopped, non-managed
// services stopped, agent-registered activity tasks deleted. Nothing here is
// per agent any more: the machine is the unit.

const service = (
    name: string,
    status: ProviderService['status']
): ProviderService => ({
    name,
    command: 'noop',
    httpPort: null,
    status,
    pid: null,
    startedAt: null,
    error: null
})

const baseHost = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_1',
    userId: 'u1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-sprite', spriteId: 'spr_1' },
    status: 'ready',
    powerState: 'running',
    keepAwake: false,
    ...over
})

interface StopHarness {
    svc: SandboxesService
    // Every call the sandbox's provider adapter received.
    adapterCalls: string[]
    closed: Array<{ hostId: string; reason: string }>
    keepAwakeOff: string[]
    converged: string[]
    serviceStops: string[]
    refreshCalls: number[]
    auditRows: Array<Record<string, unknown>>
    stopServiceCalls: string[]
}

const makeStop = (opts: {
    host?: Record<string, unknown>
    agents?: Array<{ id: string; runtimeId: string }>
    runtimes?: Array<{ id: string; framework: string }>
    converge?: { state: string; message?: string }
    // A runtime whose services the daemon could not stop, and why.
    serviceStopError?: Record<string, string | undefined>
    services?: ProviderService[]
    // Whether the supervisor stopped it; a throw is a failed call.
    stopService?: (name: string, call: number) => boolean
    leases?: string[]
    // Leases still listed after their release.
    sticky?: string[]
    refreshFails?: boolean
    sessionsClosed?: number
}): StopHarness => {
    const host = opts.host ?? baseHost()
    const closed: StopHarness['closed'] = []
    const keepAwakeOff: string[] = []
    const converged: string[] = []
    const serviceStops: string[] = []
    const refreshCalls: number[] = []
    const auditRows: StopHarness['auditRows'] = []
    const stopServiceCalls: string[] = []
    const stopCounts = new Map<string, number>()
    const adapterCalls: string[] = []
    const adapter = {
        listServices: async () => {
            adapterCalls.push('listServices')
            return opts.services ?? []
        },
        stopService: async (_call: unknown, name: string) => {
            adapterCalls.push(`stopService:${name}`)
            stopServiceCalls.push(name)
            const call = (stopCounts.get(name) ?? 0) + 1
            stopCounts.set(name, call)
            return opts.stopService ? opts.stopService(name, call) : true
        },
        listAwake: async () => {
            adapterCalls.push('listAwake')
            return (opts.leases ?? []).map((name) => ({
                name,
                startedAt: null,
                expiresAt: null
            }))
        },
        releaseAwake: async (_call: unknown, lease: { name: string }) => {
            adapterCalls.push(`releaseAwake:${lease.name}`)
            if (opts.sticky?.includes(lease.name))
                throw new AwakeLeaseStillHeldError(lease.name)
        }
    }
    const hostProviders = {
        resolve: async () => ({
            provider: { id: 'rtp_1', kind: 'sprites', name: 'org' },
            adapter
        })
    }

    const view = { host, provider: null, daemon: null, agentsCount: 0 }
    const runtimes = {
        getSandboxForUser: async () => view,
        getSandboxById: async () => view,
        listAgentsByHost: async () => opts.agents ?? [],
        listRuntimesByHost: async () => opts.runtimes ?? [],
        setHostKeepAwake: async (_u: string, id: string) => {
            keepAwakeOff.push(id)
            return true
        }
    }
    const keepAwake = {
        converge: async (h: { id: string }) => {
            converged.push(h.id)
            return opts.converge ?? { state: 'unchanged' }
        }
    }
    const hostServices = {
        stopRuntime: async (rt: { id: string }) => {
            serviceStops.push(rt.id)
            const error = opts.serviceStopError?.[rt.id]
            if (error) throw new Error(error)
        }
    }
    const sessions = {
        closeForHost: (hostId: string, reason: string) => {
            closed.push({ hostId, reason })
            return opts.sessionsClosed ?? 0
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

    const svc = new SandboxesService(
        runtimes as never,
        {} as never,
        {} as never,
        hostProviders as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        spriteStatusSync as never,
        {} as never,
        {} as never,
        hostServices as never,
        {} as never,
        sessions as never,
        db as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        keepAwake as never
    )
    return {
        svc,
        adapterCalls,
        closed,
        keepAwakeOff,
        converged,
        serviceStops,
        refreshCalls,
        auditRows,
        stopServiceCalls
    }
}

const auditMeta = (h: StopHarness): Record<string, unknown> =>
    h.auditRows[0].meta as Record<string, unknown>

test('stop is a noop on a non-running sandbox and touches nothing', async () => {
    const h = makeStop({ host: baseHost({ powerState: 'suspended' }) })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.equal(res.status, 'noop')
    assert.deepEqual(h.closed, [])
    assert.deepEqual(h.converged, [])
    assert.deepEqual(h.adapterCalls, [])
    assert.equal(h.auditRows.length, 0)
})

// WHY: a stopped sandbox must not be woken again by the keep-awake reconcile,
// and turning the switch off is a flag, never an exec into the sleeping VM.
test('stop on a sleeping kept-awake sandbox turns the switch off and nothing else', async () => {
    const h = makeStop({
        host: baseHost({ powerState: 'suspended', keepAwake: true })
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.equal(res.status, 'noop')
    assert.deepEqual(h.keepAwakeOff, ['sbx_1'])
    assert.deepEqual(h.converged, [])
    assert.deepEqual(h.adapterCalls, [])
})

test('stop closes the host\'s exec sessions, turns keep-awake off and lets the machine go', async () => {
    const h = makeStop({
        host: baseHost({ keepAwake: true }),
        sessionsClosed: 2,
        converge: { state: 'released' }
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.equal(res.status, 'pending')
    assert.deepEqual(h.closed, [{ hostId: 'sbx_1', reason: 'sandbox-stop' }])
    assert.deepEqual(h.keepAwakeOff, ['sbx_1'])
    assert.deepEqual(h.converged, ['sbx_1'])
    assert.equal(res.estimatedReadyInSec, 16)
    assert.equal(auditMeta(h).closedSessions, 2)
})

test('stop stops the framework services of every service runtime on the host', async () => {
    const h = makeStop({
        runtimes: [
            { id: 'rt-hermes', framework: 'hermes' },
            { id: 'rt-claude', framework: 'claude-code' }
        ],
        serviceStopError: { 'rt-hermes': 'sandbox sbx_1 has no connected daemon' }
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.deepEqual(h.serviceStops, ['rt-hermes'], 'a coding CLI has no service to stop')
    assert.deepEqual(res.warnings, [
        'runtime rt-hermes service stop failed: sandbox sbx_1 has no connected daemon'
    ])
})

// The daemon's loop and the public port stub are the platform's: stopping the
// loop's service would take the daemon and every framework service under it
// down.
test('stop stops only the user\'s running services, never the daemon or its port', async () => {
    const h = makeStop({
        services: [
            service('mf-daemon', 'running'),
            service('mf-port', 'running'),
            service('http.server', 'running'),
            service('idle', 'stopped')
        ]
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.deepEqual(h.stopServiceCalls, ['http.server'])
    assert.deepEqual(res.stoppedServices, ['http.server'])
})

test('stop sweeps services in passes so needs-blocked stops succeed later', async () => {
    const h = makeStop({
        services: [service('a', 'running'), service('b', 'running')],
        stopService: (name, call) => !(name === 'a' && call === 1)
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.deepEqual(res.stoppedServices.sort(), ['a', 'b'])
    assert.deepEqual(res.warnings, [])
})

test('stop surfaces services that never stop as warnings, not failures', async () => {
    const h = makeStop({
        services: [service('stuck', 'running')],
        stopService: () => false
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.equal(res.status, 'pending')
    assert.deepEqual(res.stoppedServices, [])
    assert.match(res.warnings[0], /refused to stop/)
})

test('stop warns on a service whose stop failed and goes on', async () => {
    const h = makeStop({
        services: [service('gone', 'running'), service('broken', 'running')],
        stopService: (name) => {
            if (name === 'gone') return true
            throw new Error('boom')
        }
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.deepEqual(res.stoppedServices, ['gone'])
    assert.match(res.warnings[0], /failed to stop service 'broken'/)
})

test('stop deletes only agent-registered tasks and reports re-registration', async () => {
    const h = makeStop({
        leases: ['nca-host-1-lease', 'mine', 'sticky'],
        sticky: ['sticky']
    })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.deepEqual(res.deletedTasks, ['mine'])
    assert.match(res.warnings[0], /task 'sticky' is still registered/)
})

// WHY: an API instance's awake hold (ADR-0038) is what keeps a sprite up
// under a turn in progress. A user's stop deleting it froze that turn until
// the next renew woke the VM again; the stop leaves it and says why the
// sandbox is still up.
test('a user stop keeps the platform awake holds and says what still holds the sandbox', async () => {
    const h = makeStop({ leases: ['mf-hold-0123abcd', 'mine'] })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.deepEqual(res.deletedTasks, ['mine'])
    assert.ok(!h.adapterCalls.includes('releaseAwake:mf-hold-0123abcd'))
    assert.ok(
        res.warnings.some((w) => /work in progress is holding the sandbox awake/.test(w))
    )
})

// WHY: a task name inside the VM is only a claim an agent can copy. The
// active-hours enforcer must get the sandbox to sleep, so its stop deletes the
// platform's holds as well.
test('a forced stop deletes the platform awake holds too', async () => {
    const h = makeStop({ leases: ['mf-hold-0123abcd', 'mine'] })
    const res = await h.svc.stop('u1', 'sbx_1', false, { force: true })
    assert.deepEqual(res.deletedTasks, ['mf-hold-0123abcd', 'mine'])
    assert.ok(!res.warnings.some((w) => /work in progress/.test(w)))
})

test('stop estimates the auto-sleep floor, and the hold\'s TTL when its release failed', async () => {
    const floor = await makeStop({}).svc.stop('u1', 'sbx_1')
    assert.equal(floor.estimatedReadyInSec, 16)

    const degraded = makeStop({
        host: baseHost({ keepAwake: true }),
        converge: {
            state: 'failed',
            message: 'keep-awake release failed: sprite unavailable'
        }
    })
    const res = await degraded.svc.stop('u1', 'sbx_1')
    assert.equal(res.estimatedReadyInSec, 1800)
    assert.deepEqual(res.warnings, [
        'keep-awake: keep-awake release failed: sprite unavailable'
    ])
})

test('stop warns when the status refresh fails and still audits', async () => {
    const h = makeStop({ refreshFails: true })
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.match(res.warnings[0], /status refresh failed/)
    assert.equal(h.auditRows.length, 1)
    assert.equal(h.auditRows[0].action, 'sandbox.stop')
})

test('a running sandbox with nothing registered on it says so instead of reporting a clean stop', async () => {
    const h = makeStop({})
    const res = await h.svc.stop('u1', 'sbx_1')
    assert.equal(res.status, 'pending')
    assert.match(res.warnings[0], /nothing on this sandbox could be stopped/)
    assert.equal(auditMeta(h).hasNoLevers, true)
})

test('a sandbox with a session, a lease or a runtime on it gets no such warning', async () => {
    for (const opts of [
        { sessionsClosed: 1 },
        { host: baseHost({ keepAwake: true }) },
        { runtimes: [{ id: 'rt-1', framework: 'claude-code' }] }
    ]) {
        const h = makeStop(opts)
        const res = await h.svc.stop('u1', 'sbx_1')
        assert.deepEqual(res.warnings, [], JSON.stringify(Object.keys(opts)))
        assert.equal(auditMeta(h).hasNoLevers, false)
    }
})

test('an admin stop records who it was on behalf of', async () => {
    const h = makeStop({})
    await h.svc.stop('admin', 'sbx_1', true)
    assert.equal(h.auditRows[0].actorId, 'admin')
    assert.equal(auditMeta(h).onBehalfOf, 'u1')
})
