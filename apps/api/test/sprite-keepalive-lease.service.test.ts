import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import type {
    ExecOptions,
    ExecResult,
    SpriteWriteFileArgs
} from '@manyfold/sprites'
import { SpriteKeepAliveLeaseService } from '../src/modules/agents/keep-alive/sprite-keepalive-lease.service'

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

const baseRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'art_x',
    framework: 'hermes',
    kind: 'sprites',
    accountId: 'acc_1',
    spriteName: 'sprite-x',
    homeDir: '/home/sprite/.hermes',
    capabilitiesJson: null as Record<string, unknown> | null,
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    ...over
})

const lastKeepAlive = (
    patches: Array<Record<string, unknown>>
): Record<string, unknown> => {
    const caps = patches.at(-1)?.capabilitiesJson as {
        keepAlive: Record<string, unknown>
    }
    return caps.keepAlive
}

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
        account: never
        client: never
        spriteName: string
    } | null> {
        if (this.clientThrows) throw new Error('decrypt boom')
        return {
            account: {} as never,
            client: this.spriteClient as never,
            spriteName: 'sprite-x'
        }
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

const makeLease = () => {
    const patches: Array<Record<string, unknown>> = []
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const store = baseRuntime()
    const db = {
        update: () => ({
            set: (payload: Record<string, unknown>) => {
                patches.push(payload)
                Object.assign(store, payload)
                return { where: async () => undefined }
            }
        })
    }
    const runtimes = { findById: async () => store }
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown>) => {
            events.push({ name, attrs })
        }
    }
    const runtimeAccess = {
        spritesWholesaleHeadroom: async () => ({ orgActive: 0, activeCap: 10 })
    }
    const lease = new TestLease(
        db as never,
        {} as never,
        runtimes as never,
        telemetry as never,
        runtimeAccess as never,
        {} as never,
        { get: () => undefined } as never
    )
    return { lease, patches, store, events }
}

test('stopAndRelease verifies release when no keep-alive tasks remain', async () => {
    const { lease, patches } = makeLease()

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'verified')
    assert.equal(res.maxStaleSec, 90)
    const meta = lastKeepAlive(patches)
    assert.equal(meta.desiredState, 'stopped')
    assert.ok(
        meta.lastVerifiedAt,
        'lastVerifiedAt should be stamped on success'
    )
})

test('stopAndRelease degrades — never verifies — when the task list cannot be read', async () => {
    const { lease } = makeLease()
    lease.taskList = { exitCode: 1, stdout: '', stderr: 'socket hangup' }

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'degraded')
    assert.equal(res.maxStaleSec, 390)
    assert.match(res.message ?? '', /verification failed/)
})

test('stopAndRelease degrades when the task list returns a non-JSON body', async () => {
    const { lease } = makeLease()
    lease.taskList = ok('<html>502 Bad Gateway</html>')

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'degraded')
})

test('stopAndRelease degrades when a matching task is still present', async () => {
    const { lease } = makeLease()
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-hermes-x-stale' }] })
    )

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'degraded')
    assert.match(res.message ?? '', /still present/)
})

test('stopAndRelease still verifies when stopService 404s but tasks are gone', async () => {
    const { lease } = makeLease()
    lease.spriteClient.stopService = async () => {
        throw new SpritesError('not_found', 'service not found', 404)
    }

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'verified')
})

test('stopAndRelease degrades instead of throwing when client setup fails', async () => {
    const { lease } = makeLease()
    lease.clientThrows = true

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'degraded')
    assert.equal(res.maxStaleSec, 390)
    assert.match(res.message ?? '', /stopAndRelease error/)
})

test('stopAndRelease on a kept-alive exec-kind framework is a lease-only release — no stopService, no start.sh', async () => {
    const { lease } = makeLease()
    const runtime = baseRuntime({
        framework: 'claude-code',
        homeDir: '/home/sprite',
        keepAliveEnabled: true
    })

    const res = await lease.stopAndRelease(runtime as never, 'user-stop')

    // WHY: a coding sprite has no framework service to stop — keep-alive is
    // the renewing /v1/tasks lease alone, so releasing it (and letting the VM
    // suspend on its own) IS the stop. stopService would be a no-op and there
    // is no managed start.sh to rewrite.
    assert.equal(res.state, 'verified')
    assert.equal(res.maxStaleSec, 90)
    assert.deepEqual(lease.serviceCalls, [])
    assert.deepEqual(execKinds(lease.execCalls), ['cleanup', 'tasks'])
    assert.ok(
        !lease.writes.some((path) => path.includes('start.sh')),
        'exec-kind release must never write a start.sh'
    )
})

test('stopAndRelease on an exec-kind framework that never held a lease is a no-op', async () => {
    const { lease } = makeLease()
    // keepAliveEnabled falsy + capabilitiesJson null → no lease was ever held.
    const runtime = baseRuntime({
        framework: 'claude-code',
        homeDir: '/home/sprite'
    })

    const res = await lease.stopAndRelease(runtime as never, 'user-stop')

    // WHY: stopping a coding agent that never enabled keep-alive (the common
    // case — stop via QuotaConflictModal/admin) must not touch the sprite:
    // no lease to release, no exec round-trips, no false 'degraded' telemetry.
    assert.deepEqual(res, { state: 'not_applicable', maxStaleSec: 0 })
    assert.deepEqual(lease.execCalls, [])
    assert.deepEqual(lease.serviceCalls, [])
})

test('ensureLease on an exec-kind framework spawns the lease without a start.sh', async () => {
    const { lease, patches } = makeLease()
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-claude-code-x-fresh' }] })
    )
    const runtime = baseRuntime({
        framework: 'claude-code',
        homeDir: '/home/sprite'
    })

    await lease.ensureLease(runtime as never)

    // WHY: keep-alive for a coding sprite is the renewing lease and nothing
    // else — lease-only cleanup, the detached keepalive.sh spawn, and the
    // /v1/tasks verification, with NO start.sh rewrite (the 'mv' step) and no
    // service calls.
    assert.deepEqual(lease.serviceCalls, [])
    assert.deepEqual(execKinds(lease.execCalls), ['cleanup', 'spawn', 'tasks'])
    assert.ok(lease.writes.includes('/home/sprite/.nca/keepalive/keepalive.sh'))
    assert.ok(
        !lease.writes.some((path) => path.includes('start.sh')),
        'exec-kind ensureLease must never write a start.sh'
    )
    const meta = lastKeepAlive(patches)
    assert.equal(meta.desiredState, 'running')
    assert.equal(
        meta.serviceName,
        undefined,
        'lease-only metadata names no service'
    )
    assert.ok(meta.lastVerifiedAt)
})

test('releaseLease on an exec-kind framework is lease-only with no start.sh rewrite', async () => {
    const { lease, patches } = makeLease()
    const runtime = baseRuntime({
        framework: 'claude-code',
        homeDir: '/home/sprite'
    })

    const res = await lease.releaseLease(runtime as never, 'user-toggle')

    assert.deepEqual(res, { verified: true })
    assert.deepEqual(lease.serviceCalls, [])
    // No 'mv': a coding sprite has no managed start.sh to converge.
    assert.deepEqual(execKinds(lease.execCalls), ['cleanup', 'tasks'])
    assert.ok(!lease.writes.some((path) => path.includes('start.sh')))
    assert.equal(lastKeepAlive(patches).desiredState, 'stopped')
})

test('stopAndRelease is not_applicable for non-sprite runtimes', async () => {
    const { lease } = makeLease()

    const res = await lease.stopAndRelease(
        baseRuntime({ kind: 'k8s' }) as never,
        'user-stop'
    )

    assert.deepEqual(res, { state: 'not_applicable', maxStaleSec: 0 })
})

test('desiredStateAt is stamped on transition and preserved across stopped->stopped', async () => {
    const { lease, patches, store } = makeLease()

    await lease.stopAndRelease(baseRuntime() as never, 'user-stop')
    const first = lastKeepAlive(patches).desiredStateAt
    assert.ok(first)

    await lease.stopAndRelease(store as never, 'reconcile')
    const second = lastKeepAlive(patches).desiredStateAt
    assert.equal(
        second,
        first,
        'a stopped->stopped retry must not reset the age anchor'
    )
})

const keepAlive = (over: Record<string, unknown> = {}) => ({
    serviceName: 'hermes',
    taskPrefix: 'nca-hermes-x-',
    taskName: 'nca-hermes-x-gen',
    generation: 'gen',
    ttlSec: 300,
    refreshSec: 60,
    desiredState: 'stopped',
    stateDir: '/home/sprite/.hermes/.nca/keepalive',
    startScriptPath: '/home/sprite/.hermes/start.sh',
    exec: ['hermes', 'gateway'],
    legacyTaskNames: ['hermes-keepalive'],
    ...over
})

test('ensureServiceRunning on a stopped service starts it without touching the lease', async () => {
    const { lease, patches } = makeLease()
    const runtime = baseRuntime({
        capabilitiesJson: { keepAlive: keepAlive() }
    })

    const res = await lease.ensureServiceRunning(runtime as never)

    assert.deepEqual(res, { started: true })
    assert.deepEqual(lease.serviceCalls, ['getService', 'startService'])
    // start.sh rewritten atomically (tmp + mv) before the FULL pre-start
    // cleanup — and that is ALL: no task verification, no metadata patch.
    // WHY: traffic wake must not resurrect the lease the user turned off
    // (the core Phase 2 split).
    assert.deepEqual(execKinds(lease.execCalls), ['mv', 'cleanup'])
    assert.ok(lease.writes.includes('/home/sprite/.hermes/start.sh.tmp'))
    const cleanup = lease.execCalls.find((call) => call.cmd[1] === '-s')
    assert.ok(cleanup)
    assert.ok(
        cleanup.stdin.includes('export KILL_APP_PROCESSES=1'),
        'pre-start cleanup must be FULL (straggler/port clearing)'
    )
    assert.equal(
        patches.length,
        0,
        'wake must never assert lease intent via desiredState'
    )
})

test('ensureServiceRunning on a running service is a pure no-op returning started:false', async () => {
    const { lease, patches } = makeLease()
    lease.spriteClient.getService = async () => ({
        state: { status: 'running' }
    })

    const res = await lease.ensureServiceRunning(baseRuntime() as never)

    // WHY: chat traffic on a healthy sprite must cost zero execs and zero
    // writes — wake is lease-free and idempotent.
    assert.deepEqual(res, { started: false })
    assert.deepEqual(lease.serviceCalls, [])
    assert.deepEqual(lease.execCalls, [])
    assert.deepEqual(lease.writes, [])
    assert.equal(patches.length, 0)
})

test('ensureLease never restarts the framework and replaces any existing renewer', async () => {
    const { lease, patches } = makeLease()
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-hermes-x-fresh' }] })
    )
    const runtime = baseRuntime({
        capabilitiesJson: { keepAlive: keepAlive() }
    })

    await lease.ensureLease(runtime as never)

    // WHY: toggling on must not restart a mid-turn framework service.
    assert.deepEqual(
        lease.serviceCalls,
        [],
        'ensureLease must not call stopService/startService/getService'
    )
    // Lease-only cleanup FIRST (kills any legacy fused renewer via the
    // shared renew.pid so exactly one renewer survives), then the start.sh
    // rewrite, the detached spawn, and the /v1/tasks verification.
    assert.deepEqual(execKinds(lease.execCalls), [
        'cleanup',
        'mv',
        'spawn',
        'tasks'
    ])
    const cleanup = lease.execCalls[0]
    assert.ok(
        cleanup.stdin.includes('export KILL_APP_PROCESSES=0'),
        'pre-spawn cleanup must be lease-only — never kills the framework'
    )
    assert.ok(
        lease.writes.includes(
            '/home/sprite/.hermes/.nca/keepalive/keepalive.sh'
        )
    )
    const meta = lastKeepAlive(patches)
    assert.equal(meta.desiredState, 'running')
    assert.ok(meta.lastVerifiedAt, 'verified spawn stamps lastVerifiedAt')
})

test('releaseLease is lease-only: no stopService, renewer-only kill, start.sh rewritten', async () => {
    const { lease, patches, events } = makeLease()
    const runtime = baseRuntime({
        capabilitiesJson: {
            keepAlive: keepAlive({ desiredState: 'running' })
        }
    })

    const res = await lease.releaseLease(runtime as never, 'reconcile')

    // WHY: a real release must not interrupt a running turn — this is the
    // no-restart toggle-off and the reconcile loop's only action.
    assert.deepEqual(res, { verified: true })
    assert.deepEqual(lease.serviceCalls, [])
    assert.deepEqual(execKinds(lease.execCalls), ['cleanup', 'mv', 'tasks'])
    const cleanup = lease.execCalls[0]
    assert.ok(cleanup.stdin.includes('export KILL_APP_PROCESSES=0'))
    assert.ok(
        lease.writes.includes('/home/sprite/.hermes/start.sh.tmp'),
        'release rewrites start.sh so a fused legacy script can never run again'
    )
    const meta = lastKeepAlive(patches)
    assert.equal(meta.desiredState, 'stopped')
    assert.ok(meta.lastVerifiedAt)
    assert.deepEqual(events, [])
})

// WHY: lastVerifiedAt and desiredStateAt must come from ONE clock reading —
// when lastVerifiedAt was stamped before patchMetadata's findById round-trip,
// every running→stopped flip landed with lastVerifiedAt < desiredStateAt and
// Pass A re-released every already-converged sprite exactly once (~2min
// later), doubling the deploy-moment legacy fleet drain.
test('a verified releaseLease lands atomically and the next reconcile tick performs zero actions', async () => {
    const patches: Array<Record<string, unknown>> = []
    const store = baseRuntime({
        keepAliveEnabled: false,
        capabilitiesJson: {
            keepAlive: keepAlive({
                desiredState: 'running',
                desiredStateAt: new Date(Date.now() - 1_000_000).toISOString()
            })
        }
    })
    const db = {
        update: () => ({
            set: (payload: Record<string, unknown>) => {
                patches.push(payload)
                Object.assign(store, payload)
                return { where: async () => undefined }
            }
        }),
        select: () => ({
            from: () => ({
                innerJoin: () => ({
                    where: async () => [
                        { runtime: store, spriteStatus: 'running' }
                    ]
                }),
                where: async () => []
            })
        })
    }
    const runtimes = {
        findById: async () => {
            // Real DB read latency — exactly what skewed the two clocks.
            await new Promise((resolve) => setTimeout(resolve, 5))
            return store
        }
    }
    const lease = new TestLease(
        db as never,
        {} as never,
        runtimes as never,
        { event: () => undefined } as never,
        {
            spritesWholesaleHeadroom: async () => ({
                orgActive: 0,
                activeCap: 10
            })
        } as never,
        {} as never,
        { get: () => undefined } as never
    )

    const res = await lease.releaseLease(store as never, 'reconcile')

    assert.equal(res.verified, true)
    const meta = lastKeepAlive(patches)
    assert.ok(
        new Date(String(meta.lastVerifiedAt)).getTime() >=
            new Date(String(meta.desiredStateAt)).getTime(),
        'verified release must land with lastVerifiedAt >= desiredStateAt'
    )

    // Age both stamps past the 90s recent-verify grace (preserving their
    // relative order) so ONLY the landed gate can skip this runtime.
    const ageMs = 120_000
    const aged = {
        ...(store.capabilitiesJson as { keepAlive: Record<string, unknown> })
            .keepAlive
    }
    aged.lastVerifiedAt = new Date(
        new Date(String(aged.lastVerifiedAt)).getTime() - ageMs
    ).toISOString()
    aged.desiredStateAt = new Date(
        new Date(String(aged.desiredStateAt)).getTime() - ageMs
    ).toISOString()
    store.capabilitiesJson = { keepAlive: aged }

    lease.execCalls = []
    await lease.reconcileLeases()
    assert.deepEqual(
        execKinds(lease.execCalls),
        [],
        'a landed release must not be re-released by Pass A'
    )
})

// WHY: a disable racing an in-flight ensureLease can run its lease-only
// cleanup BEFORE the spawn lands — without the post-verify column re-check
// the surviving loop would renew (and bill) a runtime whose column already
// reads disabled, with both reconcile passes blind to it.
test('ensureLease releases the lease it spawned when a disable raced it', async () => {
    const { lease, patches, store } = makeLease()
    Object.assign(store, { keepAliveEnabled: false })
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-hermes-x-fresh' }] })
    )
    const runtime = baseRuntime({
        keepAliveEnabled: true,
        capabilitiesJson: { keepAlive: keepAlive() }
    })

    await lease.ensureLease(runtime as never)

    assert.deepEqual(lease.serviceCalls, [])
    // ensure (cleanup, mv, spawn, tasks) then the raced-disable release
    // (cleanup, mv, tasks): the just-spawned renewer is killed
    // deterministically instead of leaning on a later Pass A tick.
    assert.deepEqual(execKinds(lease.execCalls), [
        'cleanup',
        'mv',
        'spawn',
        'tasks',
        'cleanup',
        'mv',
        'tasks'
    ])
    assert.equal(lastKeepAlive(patches).desiredState, 'stopped')
})

// WHY: stopService TERMs a legacy fused start.sh whose EXIT trap rm's
// renew.pid — killing the renewer FIRST, while the pid file is still valid,
// is what prevents a user-stop on an enabled un-converged sprite from
// orphaning the v2 lease loop into a permanent billing leak.
test('stopAndRelease kills the renewer lease-only BEFORE stopService, full cleanup after', async () => {
    const { lease } = makeLease()
    lease.spriteClient.stopService = async () => {
        lease.execCalls.push({ cmd: ['<stopService>'], stdin: '' })
        return { state: { status: 'stopped' } }
    }

    const res = await lease.stopAndRelease(baseRuntime() as never, 'user-stop')

    assert.equal(res.state, 'verified')
    const order = lease.execCalls.map((call) =>
        call.cmd[0] === '<stopService>'
            ? 'stopService'
            : call.cmd[0] === 'mv'
              ? 'mv'
              : call.cmd.includes('/v1/tasks')
                ? 'tasks'
                : call.stdin.includes('export KILL_APP_PROCESSES=0')
                  ? 'lease-cleanup'
                  : 'full-cleanup'
    )
    assert.deepEqual(order, [
        'lease-cleanup',
        'stopService',
        'full-cleanup',
        'tasks'
    ])
})

test('releaseLease reports verified:false and emits degraded telemetry when tasks remain', async () => {
    const { lease, patches, events } = makeLease()
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-hermes-x-stale' }] })
    )
    const runtime = baseRuntime({
        capabilitiesJson: { keepAlive: keepAlive() }
    })

    const res = await lease.releaseLease(runtime as never, 'user-toggle')

    // WHY: a falsely-verified release stops reconcile retries and bills
    // forever — degraded releases must stay loud and retryable.
    assert.equal(res.verified, false)
    assert.deepEqual(lease.serviceCalls, [])
    assert.equal(lastKeepAlive(patches).desiredState, 'stopped')
    const degraded = events.find(
        (e) => e.name === 'sprite_keepalive_release_degraded'
    )
    assert.ok(degraded)
    assert.equal(degraded.attrs.reason, 'user-toggle')
})

test('install stamps desiredState stopped + lastVerifiedAt so a fresh runtime is never a Pass A candidate', async () => {
    const { lease, patches } = makeLease()

    const meta = await lease.install({
        runtimeId: 'art_x',
        framework: 'hermes',
        serviceName: 'hermes',
        client: {} as never,
        spriteName: 'sprite-x',
        homeDir: '/home/sprite/.hermes',
        exec: ['hermes', 'gateway'],
        legacyTaskNames: ['hermes-keepalive'],
        reportToken: 'report-token'
    })

    // WHY: a fresh sprite is verified-leaseless by construction — without
    // the lastVerifiedAt stamp every new runtime would eat a cleanup exec
    // per reconcile tick.
    assert.equal(meta.desiredState, 'stopped')
    const last = lastKeepAlive(patches)
    assert.equal(last.desiredState, 'stopped')
    assert.ok(last.lastVerifiedAt)
    assert.ok(
        new Date(String(last.lastVerifiedAt)).getTime() >=
            new Date(String(last.desiredStateAt)).getTime(),
        'lastVerifiedAt must land at-or-after desiredStateAt to defuse Pass A'
    )
    // Plain start.sh only — no lease spawn, no /v1/tasks registration.
    assert.deepEqual(execKinds(lease.execCalls), ['mv'])
    assert.ok(lease.writes.includes('/home/sprite/.hermes/start.sh.tmp'))
})

class ReconcileSpy extends TestLease {
    released: Array<{ id: string; reason: string }> = []
    stopAndReleaseCalls: string[] = []
    wakes: string[] = []
    leased: string[] = []
    wakeError: Error | null = null

    async releaseLease(
        runtime: { id: string },
        reason: string
    ): Promise<{ verified: boolean }> {
        this.released.push({ id: runtime.id, reason })
        return { verified: true }
    }

    async stopAndRelease(runtime: { id: string }): Promise<never> {
        this.stopAndReleaseCalls.push(runtime.id)
        return { state: 'verified', maxStaleSec: 90 } as never
    }

    async ensureServiceRunning(runtime: {
        id: string
    }): Promise<{ started: boolean }> {
        this.wakes.push(runtime.id)
        if (this.wakeError) throw this.wakeError
        return { started: true }
    }

    async ensureLease(runtime: { id: string }): Promise<void> {
        this.leased.push(runtime.id)
    }
}

const makeReconcile = (input: {
    passA?: Array<Record<string, unknown>>
    passB?: Array<Record<string, unknown>>
    headroom?: { orgActive: number; activeCap: number }
}) => {
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    // Both passes join agents now; the projection key tells them apart
    // (Pass B selects agentStatus, Pass A does not).
    const db = {
        select: (projection?: Record<string, unknown>) => ({
            from: () => ({
                innerJoin: () => ({
                    where: async () =>
                        projection && 'agentStatus' in projection
                            ? (input.passB ?? [])
                            : (input.passA ?? [])
                })
            })
        })
    }
    const lease = new ReconcileSpy(
        db as never,
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

test('reconcileLeases Pass A releases an un-converged legacy runtime via releaseLease', async () => {
    const old = new Date(Date.now() - 1_000_000).toISOString()
    const { lease } = makeReconcile({
        passA: [
            {
                runtime: baseRuntime({
                    id: 'art_legacy',
                    capabilitiesJson: {
                        keepAlive: keepAlive({
                            desiredState: 'running',
                            desiredStateAt: old
                        })
                    }
                }),
                spriteStatus: 'running'
            }
        ]
    })

    await lease.reconcileLeases()

    // WHY: the pre-Phase-2 fleet (fused script, desiredState 'running',
    // column false) must converge to default-off with zero manual ops.
    assert.deepEqual(lease.released, [
        { id: 'art_legacy', reason: 'reconcile' }
    ])
    assert.deepEqual(lease.stopAndReleaseCalls, [])
})

test('reconcileLeases Pass A skips a disabled runtime whose release already landed even while running', async () => {
    const now = Date.now()
    const old = new Date(now - 1_000_000).toISOString()
    const recent = new Date(now - 10_000).toISOString()
    const { lease } = makeReconcile({
        passA: [
            {
                runtime: baseRuntime({
                    id: 'art_active',
                    capabilitiesJson: {
                        keepAlive: keepAlive({
                            desiredStateAt: old,
                            lastVerifiedAt: recent
                        })
                    }
                }),
                spriteStatus: 'running'
            }
        ]
    })

    await lease.reconcileLeases()

    // WHY: under default-off EVERY chat-active disabled sprite is
    // desiredState 'stopped' + spriteStatus 'running'; acting on it (the
    // pre-Phase-2 stopAndRelease) would kill its framework service
    // mid-conversation every ~90s.
    assert.deepEqual(lease.released, [])
    assert.deepEqual(lease.stopAndReleaseCalls, [])
})

test('reconcileLeases Pass A retries an aged unverified stopped lease via releaseLease, never stopAndRelease', async () => {
    const old = new Date(Date.now() - 1_000_000).toISOString()
    const { lease } = makeReconcile({
        passA: [
            {
                runtime: baseRuntime({
                    id: 'art_aged',
                    capabilitiesJson: {
                        keepAlive: keepAlive({ desiredStateAt: old })
                    }
                }),
                spriteStatus: 'running'
            }
        ]
    })

    await lease.reconcileLeases()

    // WHY: degraded user-stop releases must converge without stopping a
    // legitimately re-woken service.
    assert.deepEqual(lease.released, [{ id: 'art_aged', reason: 'reconcile' }])
    assert.deepEqual(lease.stopAndReleaseCalls, [])
})

test('reconcileLeases Pass B wakes an enabled runtime that slept anyway', async () => {
    const { lease, events } = makeReconcile({
        passB: [
            {
                runtime: baseRuntime({
                    id: 'art_on',
                    keepAliveEnabled: true,
                    status: 'ready'
                }),
                agentStatus: 'running',
                spriteStatus: 'warm'
            }
        ]
    })

    await lease.reconcileLeases()

    // WHY: acceptance — an enabled sprite that slept anyway (SIGKILLed
    // loop, TTL expiry, eviction) is re-woken server-side within one tick.
    assert.deepEqual(lease.wakes, ['art_on'])
    assert.deepEqual(lease.leased, ['art_on'])
    const wake = events.find((e) => e.name === 'sprite_keepalive_ensure_wake')
    assert.equal(wake?.attrs.runtimeId, 'art_on')
})

test('reconcileLeases Pass B skips an enabled runtime whose agents are all stopped', async () => {
    const { lease, events } = makeReconcile({
        passB: [
            {
                runtime: baseRuntime({
                    id: 'art_orphan',
                    keepAliveEnabled: true,
                    status: 'ready'
                }),
                agentStatus: 'stopped',
                spriteStatus: 'warm'
            }
        ]
    })

    await lease.reconcileLeases()

    // WHY: re-waking restores previously-admitted state — a sprite whose
    // every agent is stopped (user-stop or orphan-confirm) serves nobody,
    // and without this skip the ensure pass re-wakes it every ~2min forever
    // (#107: wake billing on a dead staging runtime).
    assert.deepEqual(lease.wakes, [])
    assert.deepEqual(lease.leased, [])
    assert.equal(
        events.find((e) => e.name === 'sprite_keepalive_ensure_wake'),
        undefined
    )
})

test('reconcileLeases Pass B wakes once when any agent on the runtime is not stopped', async () => {
    const runtime = baseRuntime({
        id: 'art_mixed',
        keepAliveEnabled: true,
        status: 'ready'
    })
    const { lease } = makeReconcile({
        passB: [
            { runtime, agentStatus: 'stopped', spriteStatus: 'warm' },
            { runtime, agentStatus: 'running', spriteStatus: 'warm' }
        ]
    })

    await lease.reconcileLeases()

    // WHY: one live agent is enough to honor the admitted keep-alive — and
    // the per-runtime grouping must collapse N agent rows into ONE wake.
    assert.deepEqual(lease.wakes, ['art_mixed'])
    assert.deepEqual(lease.leased, ['art_mixed'])
})

test('reconcileLeases Pass B leaves an already-awake runtime alone even with a stopped sibling row', async () => {
    const runtime = baseRuntime({
        id: 'art_awake',
        keepAliveEnabled: true,
        status: 'ready'
    })
    const { lease } = makeReconcile({
        passB: [
            { runtime, agentStatus: 'stopped', spriteStatus: 'warm' },
            { runtime, agentStatus: 'running', spriteStatus: 'running' }
        ]
    })

    await lease.reconcileLeases()

    // WHY: any spriteStatus 'running' row means the sandbox is awake — a
    // background wake would be a pointless exec against a live sprite.
    assert.deepEqual(lease.wakes, [])
    assert.deepEqual(lease.leased, [])
})

test('reconcileLeases Pass B skips all wakes and emits capacity telemetry at the org hard cap', async () => {
    const { lease, events } = makeReconcile({
        passB: [
            {
                runtime: baseRuntime({
                    id: 'art_on',
                    keepAliveEnabled: true,
                    status: 'ready'
                }),
                agentStatus: 'running',
                spriteStatus: 'warm'
            }
        ],
        headroom: { orgActive: 10, activeCap: 10 }
    })

    await lease.reconcileLeases()

    // WHY: background wakes must respect platform capacity loudly —
    // platform protection trumps user entitlement, and a silent skip would
    // hide enabled-but-dead sprites.
    assert.deepEqual(lease.wakes, [])
    assert.deepEqual(lease.leased, [])
    const skip = events.find(
        (e) => e.name === 'sprite_keepalive_ensure_capacity_skip'
    )
    assert.deepEqual(skip?.attrs, {
        orgActive: 10,
        activeCap: 10,
        candidates: 1
    })
})

test('reconcileLeases Pass B backs off a failed wake — the next tick does not re-attempt', async () => {
    const { lease, events } = makeReconcile({
        passB: [
            {
                runtime: baseRuntime({
                    id: 'art_down',
                    keepAliveEnabled: true,
                    status: 'ready'
                }),
                agentStatus: 'running',
                spriteStatus: 'warm'
            }
        ]
    })
    lease.wakeError = new Error('host down')

    await lease.reconcileLeases()
    await lease.reconcileLeases()

    // WHY: a down host must not be hammered every 60s.
    assert.deepEqual(lease.wakes, ['art_down'])
    assert.deepEqual(lease.leased, [])
    assert.equal(
        events.filter((e) => e.name === 'sprite_keepalive_ensure_failed')
            .length,
        1
    )
})

// ---------------------------------------------------------------------------
// hermes dashboard topology — wake/stop must treat gateway + dashboard +
// front proxy as one unit when the dashboard is enabled: the proxy holds the
// sprite's public http_port, so a gateway-only wake leaves chat unroutable.
// ---------------------------------------------------------------------------

test('ensureServiceRunning starts the full hermes topology when the dashboard is enabled', async () => {
    const { lease } = makeLease()
    const checked: string[] = []
    const started: string[] = []
    lease.spriteClient.getService = async (_s: string, name: string) => {
        checked.push(name)
        return { state: { status: 'stopped' } }
    }
    lease.spriteClient.startService = async (_s: string, name: string) => {
        started.push(name)
        return { state: { status: 'running' } }
    }
    const runtime = baseRuntime({
        dashboardEnabled: true,
        capabilitiesJson: { keepAlive: keepAlive() }
    })

    const res = await lease.ensureServiceRunning(runtime as never)

    assert.deepEqual(res, { started: true })
    // dependency order: gateway first, public-port holder (proxy) last
    assert.deepEqual(checked, ['hermes', 'hermes-dashboard', 'hermes-proxy'])
    assert.deepEqual(started, ['hermes', 'hermes-dashboard', 'hermes-proxy'])
})

test('ensureServiceRunning starts only the stopped members of the topology', async () => {
    const { lease } = makeLease()
    const started: string[] = []
    lease.spriteClient.getService = async (_s: string, name: string) => ({
        state: { status: name === 'hermes-proxy' ? 'stopped' : 'running' }
    })
    lease.spriteClient.startService = async (_s: string, name: string) => {
        started.push(name)
        return { state: { status: 'running' } }
    }
    const runtime = baseRuntime({
        dashboardEnabled: true,
        capabilitiesJson: { keepAlive: keepAlive() }
    })

    const res = await lease.ensureServiceRunning(runtime as never)

    assert.deepEqual(res, { started: true })
    assert.deepEqual(started, ['hermes-proxy'])
})

test('ensureServiceRunning stays single-service when the dashboard is disabled', async () => {
    const { lease } = makeLease()
    const checked: string[] = []
    lease.spriteClient.getService = async (_s: string, name: string) => {
        checked.push(name)
        return { state: { status: 'running' } }
    }
    const res = await lease.ensureServiceRunning(
        baseRuntime({ dashboardEnabled: false }) as never
    )
    assert.deepEqual(res, { started: false })
    assert.deepEqual(checked, ['hermes'])
})

test('stopAndRelease stops proxy → dashboard → gateway when the dashboard is enabled', async () => {
    const { lease } = makeLease()
    const stopped: string[] = []
    lease.spriteClient.stopService = async (_s: string, name: string) => {
        stopped.push(name)
        return { state: { status: 'stopped' } }
    }

    const res = await lease.stopAndRelease(
        baseRuntime({ dashboardEnabled: true }) as never,
        'user-stop'
    )

    assert.equal(res.state, 'verified')
    // reverse order: drop the public route before its upstreams
    assert.deepEqual(stopped, ['hermes-proxy', 'hermes-dashboard', 'hermes'])
})
