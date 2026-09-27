import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import type {
    ExecOptions,
    ExecResult,
    SpriteWriteFileArgs
} from '@manyfold/sprites'
import { SpriteKeepAliveLeaseService } from '../src/modules/agents/keep-alive/sprite-keepalive-lease.service'

// The keep-awake lease is the host's (ADR-0036 R7): one renewing /v1/tasks
// task per machine, ensured while host.keep_awake is on and released when it
// goes off, with the bookkeeping on the host row (keep_awake_lease). Nothing
// here starts or stops a framework service — that is the daemon's job.

const CLEAN_SUMMARY = JSON.stringify({
    deletedTasks: [],
    remainingTasks: [],
    killedPids: [],
    errors: []
})

const ok = (stdout: string): ExecResult => ({
    exitCode: 0,
    stdout,
    stderr: ''
})

const baseHost = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_x',
    userId: 'u_1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sprite-x', spriteId: 'sp_x' },
    status: 'ready',
    powerState: 'running',
    keepAwake: true,
    keepAwakeLease: null as Record<string, unknown> | null,
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    ...over
})

const baseRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'art_x',
    framework: 'hermes',
    hostId: 'sbx_x',
    dashboardEnabled: false,
    capabilitiesJson: null as Record<string, unknown> | null,
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    ...over
})

class TestLease extends SpriteKeepAliveLeaseService {
    clientThrows = false
    serviceCalls: string[] = []
    execCalls: Array<{ cmd: string[]; stdin: string }> = []
    writes: string[] = []
    spriteClient: Record<string, unknown> = {
        stopService: async () => {
            this.serviceCalls.push('stopService')
            return { state: { status: 'stopped' } }
        },
        getService: async () => {
            this.serviceCalls.push('getService')
            return { state: { status: 'stopped' } }
        },
        startService: async () => {
            this.serviceCalls.push('startService')
            return { state: { status: 'running' } }
        }
    }
    taskList: ExecResult = ok('{"tasks":[]}')
    cleanupResult: ExecResult = ok(CLEAN_SUMMARY)

    protected async clientFor(): Promise<{
        client: never
        spriteName: string
    } | null> {
        if (this.clientThrows) return null
        return { client: this.spriteClient as never, spriteName: 'sprite-x' }
    }

    protected async exec(
        _client: never,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execCalls.push({
            cmd: opts.cmd,
            stdin: typeof opts.stdin === 'string' ? opts.stdin : ''
        })
        return opts.cmd.includes('/v1/tasks')
            ? this.taskList
            : this.cleanupResult
    }

    protected async writeFile(
        _client: never,
        _spriteName: string,
        args: SpriteWriteFileArgs
    ): Promise<void> {
        this.writes.push(args.absPath)
    }
}

// Collapse recorded execs to their kind so ordering assertions stay readable:
// 'cleanup' (bash -s cleanup script), 'mv' (atomic start.sh swap), 'spawn'
// (detached keepalive.sh launch), 'tasks' (/v1/tasks verification read).
const execKinds = (calls: Array<{ cmd: string[] }>): string[] =>
    calls.map((call) =>
        call.cmd[0] === 'mv'
            ? 'mv'
            : call.cmd.includes('/v1/tasks')
              ? 'tasks'
              : call.cmd.some((token) => token.includes('keepalive.sh'))
                ? 'spawn'
                : 'cleanup'
    )

const makeLease = (
    hostOver: Record<string, unknown> = {},
    opts: { headroom?: { orgActive: number; activeCap: number } } = {}
) => {
    const host = baseHost(hostOver)
    const runtime = baseRuntime()
    const hostPatches: Array<Record<string, unknown>> = []
    const runtimePatches: Array<Record<string, unknown>> = []
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    // Pass A / Pass B candidates: whatever the sweep's two selects should see.
    const sweep: { release: Record<string, unknown>[]; ensure: Record<string, unknown>[] } = {
        release: [],
        ensure: []
    }
    let selectCount = 0
    const db = {
        select: () => ({
            from: () => ({
                where: async () => {
                    selectCount += 1
                    return selectCount % 2 === 1 ? sweep.release : sweep.ensure
                }
            })
        }),
        update: () => ({
            set: (payload: Record<string, unknown>) => {
                runtimePatches.push(payload)
                Object.assign(runtime, payload)
                return { where: async () => undefined }
            }
        })
    }
    const hosts = {
        findById: async (id: string) => (id === host.id ? host : null),
        patch: async (_id: string, values: Record<string, unknown>) => {
            hostPatches.push(values)
            Object.assign(host, values)
            return host
        }
    }
    const runtimes = {
        findById: async () => runtime,
        applyServiceReportPatch: async () => undefined
    }
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown>) => {
            events.push({ name, attrs })
        }
    }
    const runtimeAccess = {
        spritesWholesaleHeadroom: async () =>
            opts.headroom ?? { orgActive: 0, activeCap: 10 }
    }
    const lease = new TestLease(
        db as never,
        hosts as never,
        {} as never,
        runtimes as never,
        telemetry as never,
        runtimeAccess as never,
        {} as never,
        { get: () => undefined } as never
    )
    return { lease, host, runtime, hostPatches, runtimePatches, events, sweep }
}

const lastLease = (patches: Array<Record<string, unknown>>) =>
    patches.at(-1)?.keepAwakeLease as Record<string, unknown>

test('ensureLease spawns the renewer and records the verified lease on the host', async () => {
    const { lease, hostPatches } = makeLease()
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-host-x-1-abc' }] })
    )

    await lease.ensureLease(baseHost() as never)

    // WHY: keep-awake is the renewing lease and nothing else — lease-only
    // cleanup, the detached keepalive.sh spawn and the /v1/tasks verification,
    // with NO start.sh rewrite and no service calls.
    assert.deepEqual(lease.serviceCalls, [])
    assert.deepEqual(execKinds(lease.execCalls), ['cleanup', 'spawn', 'tasks'])
    assert.ok(lease.writes.includes('/home/sprite/.nca/keepalive/keepalive.sh'))
    assert.ok(!lease.writes.some((path) => path.includes('start.sh')))
    const recorded = lastLease(hostPatches)
    assert.equal(recorded.generation, 1)
    assert.match(String(recorded.taskName), /^nca-host-x-1-/)
    assert.ok(recorded.lastVerifiedAt)
    assert.equal(recorded.lastError, null)
})

test('ensureLease keeps the task recorded but marks the error when the spawn is not observed', async () => {
    const { lease, hostPatches, events } = makeLease()

    await lease.ensureLease(baseHost() as never)

    const recorded = lastLease(hostPatches)
    assert.match(String(recorded.taskName), /^nca-host-x-1-/)
    assert.equal(recorded.lastVerifiedAt, null)
    assert.match(String(recorded.lastError), /not observed after spawn/)
    assert.deepEqual(events, [])
})

test('ensureLease releases the lease it spawned when a disable raced it', async () => {
    const { lease, host } = makeLease()
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-host-x-1-abc' }] })
    )
    // The switch is read back after the spawn; a racing disable flipped it.
    host.keepAwake = false

    await lease.ensureLease(baseHost() as never)

    assert.deepEqual(execKinds(lease.execCalls), [
        'cleanup',
        'spawn',
        'tasks',
        'cleanup',
        'tasks'
    ])
})

test('releaseLease verified clears the recorded task; degraded keeps it and tells telemetry', async () => {
    const verified = makeLease({
        keepAwake: false,
        keepAwakeLease: { generation: 3, taskName: 'nca-host-x-3-old' }
    })
    const res = await verified.lease.releaseLease(verified.host as never, 'user-toggle')
    assert.deepEqual(res, { verified: true })
    assert.deepEqual(verified.lease.serviceCalls, [])
    assert.deepEqual(execKinds(verified.lease.execCalls), ['cleanup', 'tasks'])
    assert.equal(lastLease(verified.hostPatches).taskName, null)
    assert.equal(lastLease(verified.hostPatches).generation, 3)
    assert.ok(lastLease(verified.hostPatches).lastVerifiedAt)

    const degraded = makeLease({
        keepAwake: false,
        keepAwakeLease: { generation: 3, taskName: 'nca-host-x-3-old' }
    })
    degraded.lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-host-x-3-old' }] })
    )
    const bad = await degraded.lease.releaseLease(degraded.host as never, 'user-toggle')
    assert.deepEqual(bad, { verified: false })
    assert.equal(lastLease(degraded.hostPatches).taskName, 'nca-host-x-3-old')
    assert.match(String(lastLease(degraded.hostPatches).lastError), /still present/)
    assert.deepEqual(
        degraded.events.map((e) => e.name),
        ['sprite_keepalive_release_degraded']
    )
})

test('releaseLease degrades without throwing when the sprites client is unavailable', async () => {
    const { lease, hostPatches } = makeLease({ keepAwake: false })
    lease.clientThrows = true

    const res = await lease.releaseLease(baseHost() as never, 'user-toggle')

    assert.deepEqual(res, { verified: false })
    assert.match(String(lastLease(hostPatches).lastError), /provider or sprite name missing/)
    assert.deepEqual(lease.execCalls, [])
})

test('stopAndRelease is a no-op for a host that never held a lease', async () => {
    const { lease } = makeLease({ keepAwake: false, keepAwakeLease: null })

    const res = await lease.stopAndRelease(baseHost({ keepAwake: false }) as never, 'sandbox-stop')

    // WHY: stopping a sandbox that never enabled keep-awake (the common case)
    // must not touch the sprite: no exec round-trips, no false 'degraded'.
    assert.deepEqual(res, { state: 'not_applicable', maxStaleSec: 0 })
    assert.deepEqual(lease.execCalls, [])
})

test('stopAndRelease reports verified in 90s and degraded in ttl + 90s', async () => {
    const good = makeLease({
        keepAwake: false,
        keepAwakeLease: { generation: 1, taskName: 'nca-host-x-1-live' }
    })
    assert.deepEqual(
        await good.lease.stopAndRelease(good.host as never, 'sandbox-stop'),
        { state: 'verified', maxStaleSec: 90 }
    )

    const bad = makeLease({
        keepAwake: false,
        keepAwakeLease: { generation: 1, taskName: 'nca-host-x-1-live' }
    })
    bad.lease.taskList = { exitCode: 1, stdout: '', stderr: 'socket hangup' }
    const res = await bad.lease.stopAndRelease(bad.host as never, 'sandbox-stop')
    assert.equal(res.state, 'degraded')
    assert.equal(res.maxStaleSec, 390)
})

test('a runtime row names its host: the lease is still the host\'s', async () => {
    const { lease, hostPatches } = makeLease({
        keepAwake: false,
        keepAwakeLease: { generation: 2, taskName: 'nca-host-x-2-live' }
    })

    const res = await lease.releaseLease(baseRuntime() as never, 'user-toggle')

    assert.deepEqual(res, { verified: true })
    assert.equal(lastLease(hostPatches).taskName, null)
})

test('stopAndRelease is not_applicable for a machine that is not a sandbox', async () => {
    const { lease } = makeLease({
        kind: 'local',
        providerId: null,
        providerRef: null
    })

    const res = await lease.stopAndRelease(
        baseHost({ kind: 'local', providerId: null, providerRef: null }) as never,
        'sandbox-stop'
    )

    assert.deepEqual(res, { state: 'not_applicable', maxStaleSec: 0 })
})

test('ensureServiceRunning starts a stopped service through the sprites services API without touching the lease', async () => {
    const { lease } = makeLease()

    const res = await lease.ensureServiceRunning(baseRuntime() as never)

    assert.deepEqual(res, { started: true })
    assert.deepEqual(lease.serviceCalls, ['getService', 'startService'])
    assert.ok(lease.writes.some((path) => path.endsWith('/start.sh.tmp')))
    assert.ok(!lease.writes.some((path) => path.endsWith('keepalive.sh')))
})

test('ensureServiceRunning on a running service is a pure no-op', async () => {
    const { lease } = makeLease()
    lease.spriteClient.getService = async () => ({
        state: { status: 'running' }
    })

    const res = await lease.ensureServiceRunning(baseRuntime() as never)

    assert.deepEqual(res, { started: false })
    assert.deepEqual(lease.execCalls, [])
})

class ReconcileSpy extends TestLease {
    released: Array<{ id: string; reason: string }> = []
    leased: string[] = []
    leaseError: Error | null = null

    async releaseLease(
        host: { id: string },
        reason: string
    ): Promise<{ verified: boolean }> {
        this.released.push({ id: host.id, reason })
        return { verified: true }
    }

    async ensureLease(host: { id: string }): Promise<void> {
        this.leased.push(host.id)
        if (this.leaseError) throw this.leaseError
    }
}

const makeReconcile = (input: {
    release?: Array<Record<string, unknown>>
    ensure?: Array<Record<string, unknown>>
    headroom?: { orgActive: number; activeCap: number }
}) => {
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    let selectCount = 0
    const db = {
        select: () => ({
            from: () => ({
                where: async () => {
                    selectCount += 1
                    return selectCount % 2 === 1
                        ? (input.release ?? [])
                        : (input.ensure ?? [])
                }
            })
        })
    }
    const lease = new ReconcileSpy(
        db as never,
        { findById: async () => null, patch: async () => null } as never,
        {} as never,
        { findById: async () => null } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                events.push({ name, attrs })
            }
        } as never,
        {
            spritesWholesaleHeadroom: async () =>
                input.headroom ?? { orgActive: 0, activeCap: 10 }
        } as never,
        {} as never,
        { get: () => undefined } as never
    )
    return { lease, events }
}

const old = () => new Date(Date.now() - 1_000_000).toISOString()

test('reconcile Pass A releases a switched-off running host whose release never verified', async () => {
    const { lease } = makeReconcile({
        release: [
            baseHost({
                keepAwake: false,
                keepAwakeLease: {
                    generation: 1,
                    taskName: 'nca-host-x-1-live',
                    desiredStateAt: old()
                }
            })
        ]
    })

    await lease.reconcileLeases()

    assert.deepEqual(lease.released, [{ id: 'sbx_x', reason: 'reconcile' }])
})

test('reconcile Pass A waits out the release-ready window and backs off between retries', async () => {
    const { lease } = makeReconcile({
        release: [
            baseHost({
                keepAwake: false,
                keepAwakeLease: {
                    generation: 1,
                    taskName: 'nca-host-x-1-live',
                    desiredStateAt: new Date().toISOString()
                }
            })
        ]
    })

    await lease.reconcileLeases()

    // WHY: a just-flipped switch had its release on the toggle path; the
    // sweep only retries what stayed unverified past the ready window.
    assert.deepEqual(lease.released, [])
})

test('reconcile Pass A tells telemetry about a release stale past the task ttl', async () => {
    const { lease, events } = makeReconcile({
        release: [
            baseHost({
                keepAwake: false,
                keepAwakeLease: {
                    generation: 1,
                    taskName: 'nca-host-x-1-live',
                    desiredStateAt: old()
                }
            })
        ]
    })

    await lease.reconcileLeases()

    assert.deepEqual(
        events.map((e) => e.name),
        ['sprite_keepalive_release_stale']
    )
})

test('reconcile Pass B leases a kept-awake host that slept anyway', async () => {
    const { lease, events } = makeReconcile({
        ensure: [baseHost({ powerState: 'suspended' })]
    })

    await lease.reconcileLeases()

    // WHY: admission happened at enable time; re-leasing restores admitted
    // state, so no per-user re-check and no service start — the lease exec
    // is what wakes the VM.
    assert.deepEqual(lease.leased, ['sbx_x'])
    assert.deepEqual(lease.released, [])
    assert.deepEqual(
        events.map((e) => e.name),
        ['sprite_keepalive_ensure_wake']
    )
})

test('reconcile Pass B skips every wake at the org hard cap', async () => {
    const { lease, events } = makeReconcile({
        ensure: [baseHost({ powerState: 'suspended' })],
        headroom: { orgActive: 10, activeCap: 10 }
    })

    await lease.reconcileLeases()

    assert.deepEqual(lease.leased, [])
    assert.deepEqual(
        events.map((e) => e.name),
        ['sprite_keepalive_ensure_capacity_skip']
    )
})

test('reconcile Pass B backs off a failed lease — the next tick does not re-attempt', async () => {
    const { lease, events } = makeReconcile({
        ensure: [baseHost({ powerState: 'stopped' })]
    })
    lease.leaseError = new Error('exec boom')

    await lease.reconcileLeases()
    await lease.reconcileLeases()

    assert.deepEqual(lease.leased, ['sbx_x'])
    assert.deepEqual(
        events.map((e) => e.name),
        ['sprite_keepalive_ensure_failed']
    )
})

test('install writes the service start assets with the lease left alone', async () => {
    const { lease, runtimePatches } = makeLease()

    const meta = await lease.install({
        runtimeId: 'art_x',
        framework: 'hermes',
        serviceName: 'hermes',
        client: {} as never,
        spriteName: 'sprite-x',
        homeDir: '/home/sprite/.hermes',
        exec: ['hermes', 'gateway'],
        reportToken: 'report-token'
    })

    assert.equal(meta.desiredState, 'stopped')
    assert.deepEqual(execKinds(lease.execCalls), ['mv'])
    assert.ok(lease.writes.includes('/home/sprite/.hermes/start.sh.tmp'))
    const caps = runtimePatches.at(-1)?.capabilitiesJson as {
        keepAlive: { lastVerifiedAt?: string }
    }
    assert.ok(caps.keepAlive.lastVerifiedAt)
})

test('isSpritesNotFound-style 404 on stopService still counts the service as stopped', async () => {
    const { lease } = makeLease()
    lease.spriteClient.stopService = async () => {
        throw new SpritesError('not_found', 'service not found', 404)
    }

    const message = await lease.stopService(baseRuntime() as never)

    assert.equal(message, undefined)
})
