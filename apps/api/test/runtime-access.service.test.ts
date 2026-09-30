import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { Param, StringChunk } from 'drizzle-orm'
import { createObjectId } from '@manyfold/shared'
import {
    agentRuntimes,
    agents,
    auditLogs,
    automationRuns,
    automations,
    channels,
    plans,
    runtimeHosts,
    userApiUsageDays,
    users,
    type NewAgentRuntimeRow
} from '@manyfold/db'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'

// The quota and reservation rules of ADR-0037: hosts are the unit (a sandbox
// VM, a cloud computer, a self-owned computer), a placement is derived from a
// host's kind and its provider's kind, and keep-awake is a host switch.

const now = new Date('2026-04-29T12:00:00.000Z')
const HOSTED_LIVE = ['provisioning', 'ready', 'deleting']

interface FakeWholesaleCap {
    activeCap: number
    softThresholdPct: number
}

interface FakeEffectiveCap extends FakeWholesaleCap {
    policyActiveCap: number
    vendorRunningLimit: number | null
    clamped: boolean
}

// Mirrors AdminSettingsService.getCachedSpritesEffectiveCap for a fixture that
// has no vendor observation: the enforced cap IS the policy cap.
const asEffective = (cap: FakeWholesaleCap): FakeEffectiveCap => ({
    ...cap,
    policyActiveCap: cap.activeCap,
    vendorRunningLimit: null,
    clamped: false
})

const makeService = (
    db: FakeRuntimeAccessDb,
    opts: {
        wholesaleCap?: FakeWholesaleCap
        telemetryEvents?: { name: string; attrs: Record<string, unknown> }[]
        cloudComputerEnabled?: boolean
        featureEnabled?: Record<string, boolean>
        activeSeconds?: number
    } = {}
): RuntimeAccessService => {
    const fakeAdminSettings = {
        getCachedSpritesEffectiveCap: async (): Promise<FakeEffectiveCap> =>
            asEffective(
                opts.wholesaleCap ?? {
                    activeCap: 1_000_000,
                    softThresholdPct: 99
                }
            ),
        isFeatureEnabled: async (key: string): Promise<boolean> => {
            if (opts.featureEnabled && key in opts.featureEnabled)
                return opts.featureEnabled[key]
            return opts.cloudComputerEnabled ?? true
        }
    }
    const fakeTelemetry = {
        event: (name: string, attrs: Record<string, unknown>): void => {
            opts.telemetryEvents?.push({ name, attrs })
        },
        error: (): void => {}
    }
    return new RuntimeAccessService(
        db as never,
        fakeAdminSettings as never,
        fakeTelemetry as never,
        {
            userActiveSecondsInPeriod: async () => opts.activeSeconds ?? 0
        } as never
    )
}

test('quota receipt contention exhausts after three attempts without confirming or hiding other errors', async () => {
    const db = new FakeRuntimeAccessDb()
    const service = makeService(db)
    let attempts = 0
    db.transaction = async () => {
        attempts++
        throw Object.assign(new Error('fixture serialization conflict'), { code: '40001' })
    }
    assert.equal(await service.acknowledgeQuotaWarning('user-1', createObjectId('quotaWarningReceipt')), false)
    assert.equal(attempts, 3)
    attempts = 0
    assert.deepEqual(await service.evaluateQuotaThresholds('user-1'), [])
    assert.equal(attempts, 3)
    const permanent = new Error('fixture permanent database error')
    db.transaction = async () => { throw permanent }
    await assert.rejects(() => service.acknowledgeQuotaWarning('user-1', createObjectId('quotaWarningReceipt')), (error) => error === permanent)
})

// --- reserveRuntime: placement derived from the host ---

test('RuntimeAccessService reserves an installing runtime on a sandbox host under the user limit', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1' }))
    const service = makeService(db)

    const runtime = await service.reserveRuntime(
        runtimeRow({ id: 'runtime-1', hostId: 'sbx-1', status: 'installing' })
    )

    assert.equal(runtime.id, 'runtime-1')
    assert.equal(db.lockCount, 1)
    assert.equal(db.runtimeRows.length, 1)
    assert.equal(db.runtimeRows[0].status, 'installing')
})

test('RuntimeAccessService refuses a runtime for a host that does not exist', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveRuntime(runtimeRow({ id: 'runtime-1', hostId: 'nope' })),
        (err) =>
            err instanceof NotFoundException &&
            (err.getResponse() as { code?: string }).code === 'HOST_NOT_FOUND'
    )
})

test('RuntimeAccessService counts external runtimes and rejects the next create', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free' }))
    db.runtimeRows.push(runtimeRow({ id: 'runtime-1', status: 'ready' }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveRuntime(runtimeRow({ id: 'runtime-2' })),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'RUNTIME_LIMIT_REACHED'
    )
})

test('RuntimeAccessService excludes failed runtimes from usage', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ statefulSandboxLimit: 1 }))
    db.runtimeRows.push(runtimeRow({ id: 'runtime-1', status: 'failed' }))
    const service = makeService(db)

    await service.reserveRuntime(runtimeRow({ id: 'runtime-2' }))

    assert.equal(db.runtimeRows.length, 2)
})

test('RuntimeAccessService rejects an always-online runtime for default users', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ alwaysOnlineRuntimeBonus: 0 }))
    db.hostRows.push(hostRow({ id: 'pdh-1', providerKind: 'k8s' }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({ id: 'runtime-1', hostId: 'pdh-1' })
            ),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'ALWAYS_ONLINE_AGENT_LIMIT_REACHED' &&
            (err.getResponse() as { kind?: string }).kind === 'k8s'
    )
})

test('RuntimeAccessService allows invited 3/3 quota and rejects the fourth external runtime', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(
        userRow({ statefulSandboxLimit: 3, alwaysOnlineRuntimeBonus: 3 })
    )
    for (let index = 1; index <= 3; index += 1)
        db.runtimeRows.push(runtimeRow({ id: `runtime-${index}`, status: 'ready' }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveRuntime(runtimeRow({ id: 'runtime-4' })),
        ForbiddenException
    )
})

test('RuntimeAccessService honors a per-user stateful override above the plan limit', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 10 }))
    for (let index = 1; index <= 3; index += 1)
        db.runtimeRows.push(runtimeRow({ id: `runtime-${index}`, status: 'ready' }))
    const service = makeService(db)

    const runtime = await service.reserveRuntime(runtimeRow({ id: 'runtime-4' }))

    assert.equal(runtime.id, 'runtime-4')
    assert.equal(db.runtimeRows.length, 4)
})

test('RuntimeAccessService still bounds external runtimes at the per-user override', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 10 }))
    for (let index = 1; index <= 10; index += 1)
        db.runtimeRows.push(runtimeRow({ id: `runtime-${index}`, status: 'ready' }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveRuntime(runtimeRow({ id: 'runtime-11' })),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string; limit?: number }).code ===
                'RUNTIME_LIMIT_REACHED' &&
            (err.getResponse() as { limit?: number }).limit === 10
    )
})

test('RuntimeAccessService summary reflects the per-user stateful override', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 10 }))
    db.hostRows.push(hostRow({ id: 'host-1' }))
    db.runtimeRows.push(runtimeRow({ id: 'runtime-1', hostId: 'host-1', status: 'ready' }))
    const service = makeService(db)

    const summary = await service.summary('user-1')

    assert.equal(summary.statefulSandboxLimit, 10)
    assert.equal(summary.statefulSandboxUsage, 1)
    assert.equal(summary.statefulSandboxRemaining, 9)
    // No live subscription rows in the fake -> the usage window falls back to
    // the UTC calendar month.
    assert.equal(summary.usagePeriod.source, 'calendar')
    assert.ok(summary.usagePeriod.start < summary.usagePeriod.end)
})

test('RuntimeAccessService summary counts always-online runtimes and agents separately', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [
        planRow({
            id: 'free',
            maxAgentsProvisioned: 5,
            maxAlwaysOnlineRuntimes: 5,
            maxAlwaysOnlineAgents: 5
        })
    ]
    db.users.push(userRow({ planId: 'free', alwaysOnlineRuntimeBonus: 0 }))
    db.hostRows.push(
        hostRow({ id: 'host-sprites' }),
        hostRow({ id: 'host-k8s', providerKind: 'k8s' }),
        hostRow({ id: 'host-local', kind: 'local' })
    )
    db.runtimeRows.push(
        runtimeRow({ id: 'runtime-sprites', hostId: 'host-sprites', status: 'ready' }),
        runtimeRow({ id: 'runtime-k8s', hostId: 'host-k8s', status: 'ready' }),
        runtimeRow({ id: 'runtime-daemon', hostId: 'host-local', status: 'ready' })
    )
    const service = makeService(db)

    const summary = await service.summary('user-1')

    assert.equal(summary.statefulSandboxUsage, 1)
    assert.equal(summary.alwaysOnlineRuntimesUsed, 2, 'the cloud computer and the local host')
    assert.equal(summary.alwaysOnlineAgentsUsed, 2, 'one framework on each of them')
    assert.equal(summary.persistentContainersUsed, 1)
    assert.equal(summary.localDaemonsUsed, 1)
    assert.equal(summary.statefulSandboxRemaining, 4)
    assert.equal(summary.alwaysOnlineRuntimesRemaining, 3)
    assert.equal(summary.alwaysOnlineAgentsRemaining, 3)
})

test('RuntimeAccessService summary ignores retired local hosts and failed sandboxes', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({ id: 'host-retired', kind: 'local', status: 'retired' }),
        hostRow({ id: 'host-failed', status: 'failed' })
    )
    const service = makeService(db)

    const summary = await service.summary('user-1')

    assert.equal(summary.localDaemonsUsed, 0)
    assert.equal(summary.statefulSandboxUsage, 0)
})

test('RuntimeAccessService blocks a cloud computer runtime when cloud_computer toggle is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [
        planRow({
            id: 'free',
            maxAlwaysOnlineRuntimes: 5,
            maxAlwaysOnlineAgents: 5
        })
    ]
    db.users.push(userRow({ planId: 'free', alwaysOnlineRuntimeBonus: 5 }))
    db.hostRows.push(hostRow({ id: 'pdh-1', providerKind: 'k8s' }))
    const service = makeService(db, { cloudComputerEnabled: false })

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({ id: 'runtime-k8s', hostId: 'pdh-1' })
            ),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'CLOUD_COMPUTER_DISABLED'
    )
})

test('RuntimeAccessService allows a cloud computer runtime without a per-user grant when toggle is on', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [
        planRow({
            id: 'free',
            maxAlwaysOnlineRuntimes: 5,
            maxAlwaysOnlineAgents: 5
        })
    ]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'pdh-1', providerKind: 'k8s' }))
    const service = makeService(db, { cloudComputerEnabled: true })

    const runtime = await service.reserveRuntime(
        runtimeRow({ id: 'runtime-k8s', hostId: 'pdh-1' })
    )

    assert.equal(runtime.id, 'runtime-k8s')
    assert.deepEqual(db.lockNamespaces, ['0', '3'])
})

test('RuntimeAccessService summary reports cloud computer disabled when toggle is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    const service = makeService(db, { cloudComputerEnabled: false })

    const summary = await service.summary('user-1')

    assert.equal(summary.cloudComputerEnabled, false)
})

test('RuntimeAccessService summary reports cloud computer enabled when toggle is on', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    const service = makeService(db, { cloudComputerEnabled: true })

    const summary = await service.summary('user-1')

    assert.equal(summary.cloudComputerEnabled, true)
})

test('RuntimeAccessService summary counts empty standalone sandbox hosts as provisioned usage', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    db.hostRows.push(hostRow({ id: 'sbx-empty', status: 'provisioning' }))
    const service = makeService(db)

    const summary = await service.summary('user-1')

    assert.equal(summary.statefulSandboxUsage, 1)
    assert.equal(summary.statefulSandboxRemaining, 0)
})

// --- reserveActiveSlot: per running sandbox VM ---

test('RuntimeAccessService.reserveActiveSlot rejects when per-user limit reached', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    // free.maxConcurrentActive = 1; one running sandbox already occupies it
    db.hostRows.push(hostRow({ id: 'host-existing', powerState: 'running' }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveActiveSlot({
                userId: 'user-1',
                hostId: 'host-new'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'CONCURRENT_ACTIVE_LIMIT_REACHED'
    )
    assert.equal(db.lockCount, 1)
})

test('RuntimeAccessService.reserveActiveSlot 503s when org-wide hard cap reached', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 1000 })]
    db.users.push(userRow({ planId: 'free' }))
    for (let i = 0; i < 5; i += 1)
        db.hostRows.push(
            hostRow({ id: `host-${i}`, userId: `u-${i}`, powerState: 'running' })
        )
    const service = makeService(db, {
        wholesaleCap: { activeCap: 5, softThresholdPct: 80 }
    })

    await assert.rejects(
        () =>
            service.reserveActiveSlot({
                userId: 'user-1',
                hostId: 'host-new'
            }),
        (err) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code ===
                'WHOLESALE_CAPACITY_REACHED'
    )
})

test('RuntimeAccessService.reserveActiveSlot emits soft-cap telemetry above threshold', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 1000 })]
    db.users.push(userRow({ planId: 'free' }))
    // cap=10, soft=50% → softCap=5. 5 running VMs → soft fires, hard does not.
    for (let i = 0; i < 5; i += 1)
        db.hostRows.push(
            hostRow({ id: `host-${i}`, userId: `u-${i}`, powerState: 'running' })
        )
    const telemetryEvents: { name: string; attrs: Record<string, unknown> }[] =
        []
    const service = makeService(db, {
        wholesaleCap: { activeCap: 10, softThresholdPct: 50 },
        telemetryEvents
    })

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-new'
    })

    assert.equal(result.wholesale?.current, 5)
    assert.equal(result.wholesale?.softCap, 5)
    assert.ok(
        telemetryEvents.some((e) => e.name === 'wholesale_capacity_soft_cap'),
        'expected wholesale_capacity_soft_cap telemetry event'
    )
})

test('RuntimeAccessService.reserveActiveSlot counts a shared sprite as one sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 2 })]
    db.users.push(userRow({ planId: 'free' }))
    // Co-resident agents share ONE sandbox VM (host). Counting is host-level, so
    // one running host is one slot no matter how many agents sit on it.
    db.hostRows.push(hostRow({ id: 'h-shared', powerState: 'running' }))
    const service = makeService(db)

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'h-new'
    })

    assert.equal(result.activeCount, 1)
})

test('RuntimeAccessService.reserveActiveSlot excludes the target host from its own count', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    // free.maxConcurrentActive = 1; the target is the one already running
    // (no open watermark, so the slow path) — it must not trip its own cap.
    db.hostRows.push(hostRow({ id: 'h-mine', powerState: 'running' }))
    const service = makeService(db)

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'h-mine'
    })

    assert.equal(result.activeCount, 0)
    assert.equal(db.hostRows[0].powerState, 'running')
    assert.ok(db.hostRows[0].activeAccrualSince, 'the watermark opens with the admission')
})

test('RuntimeAccessService.reserveActiveSlot fast-paths an already-running host with an open watermark', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 1 })]
    db.users.push(userRow({ planId: 'free' }))
    // The per-user limit (1) is already consumed by ANOTHER running host, so
    // the slow path would reject. The target host itself is running with an
    // open accrual watermark: this admission adds no VM and must fast-path
    // without touching the advisory-lock transaction or the counters.
    db.hostRows.push(
        hostRow({ id: 'h-other', powerState: 'running' }),
        hostRow({
            id: 'h-mine',
            powerState: 'running',
            activeAccrualSince: new Date()
        })
    )
    const service = makeService(db)

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'h-mine'
    })
    assert.equal(result.fastPath, true)

    // Without the open watermark the same call takes the slow path and hits
    // the per-user limit — proving the fast path is what admitted above.
    db.hostRows = db.hostRows.filter((row) => row.id !== 'h-mine')
    db.hostRows.push(hostRow({ id: 'h-mine', powerState: 'running' }))
    await assert.rejects(() =>
        service.reserveActiveSlot({ userId: 'user-1', hostId: 'h-mine' })
    )
})

// --- enableKeepAlive: the host's switch ---

test('RuntimeAccessService.enableKeepAlive counts kept-awake but sleeping hosts as committed capacity', async () => {
    // WHY: enabling is committed capacity — counting only running sprites
    // (reserveActiveSlot reuse) would let two concurrent enables on two COLD
    // sprites both pass with one slot left, oversubscribing the plan.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    // free.maxConcurrentActive = 1; both sandboxes are asleep
    db.hostRows.push(
        hostRow({ id: 'sbx-cold-1', powerState: 'stopped' }),
        hostRow({ id: 'sbx-cold-2', powerState: 'stopped' })
    )
    const service = makeService(db)

    await service.enableKeepAlive({ userId: 'user-1', hostId: 'sbx-cold-1' })

    assert.equal(
        db.hostRows.find((row) => row.id === 'sbx-cold-1')?.keepAwake,
        true,
        'first enable commits the switch'
    )
    assert.deepEqual(
        db.lockNamespaces,
        ['2'],
        'enable must hold the SAME ns-2 advisory lock as reserveActiveSlot so enables serialize against chat/terminal admissions'
    )

    await assert.rejects(
        () => service.enableKeepAlive({ userId: 'user-1', hostId: 'sbx-cold-2' }),
        (err) => {
            assert.ok(err instanceof ForbiddenException)
            const body = (err as ForbiddenException).getResponse() as {
                code?: string
                current?: number
                limit?: number
                planName?: string
            }
            assert.equal(body.code, 'CONCURRENT_ACTIVE_LIMIT_REACHED')
            assert.equal(body.current, 1, 'the kept-awake sleeping host occupies the slot')
            assert.equal(body.limit, 1)
            assert.equal(body.planName, 'Free')
            return true
        }
    )
    assert.equal(
        db.hostRows.find((row) => row.id === 'sbx-cold-2')?.keepAwake,
        false
    )
})

test('RuntimeAccessService.enableKeepAlive excludes the target host from both union branches', async () => {
    // WHY: enabling an in-use sandbox must not double-charge its own slot —
    // the target is excluded from both the running branch and the kept-awake
    // branch of the committed-capacity union.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'sbx-target', powerState: 'running', keepAwake: true })
    )
    const service = makeService(db)

    await service.enableKeepAlive({ userId: 'user-1', hostId: 'sbx-target' })

    assert.equal(db.hostRows[0].keepAwake, true)
})

test('RuntimeAccessService.enableKeepAlive leaves the switch off when the cap check throws', async () => {
    // WHY: admission and commitment are atomic — a half-committed enable
    // would let the lease sweep wake an unadmitted sandbox.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'sbx-cold', powerState: 'stopped' }),
        hostRow({ id: 'host-running', powerState: 'running' })
    )
    const service = makeService(db)

    await assert.rejects(
        () => service.enableKeepAlive({ userId: 'user-1', hostId: 'sbx-cold' }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'CONCURRENT_ACTIVE_LIMIT_REACHED'
    )

    assert.equal(db.hostUpdates.length, 0, 'no UPDATE may be issued when admission fails')
    assert.equal(db.hostRows[0].keepAwake, false)
})

test('RuntimeAccessService.enableKeepAlive 503s when the org-wide hard cap is reached', async () => {
    // WHY: an always-on sprite is exactly what the wholesale gate exists to
    // bound — platform protection applies even when the user has plan room.
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 1000 })]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-cold', powerState: 'stopped' }))
    for (let i = 0; i < 5; i += 1)
        db.hostRows.push(
            hostRow({ id: `host-${i}`, userId: `u-${i}`, powerState: 'running' })
        )
    const service = makeService(db, {
        wholesaleCap: { activeCap: 5, softThresholdPct: 80 }
    })

    await assert.rejects(
        () => service.enableKeepAlive({ userId: 'user-1', hostId: 'sbx-cold' }),
        (err) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code ===
                'WHOLESALE_CAPACITY_REACHED'
    )
    assert.equal(
        db.hostRows[0].keepAwake,
        false,
        'hard-cap rejection must not commit the switch'
    )
})

test('RuntimeAccessService.enableKeepAlive rejects when included active hours are exhausted', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-1' }))
    const service = makeService(db, { activeSeconds: 5 * 3600 })

    await assert.rejects(
        () => service.enableKeepAlive({ userId: 'user-1', hostId: 'sbx-1' }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'ACTIVE_HOURS_QUOTA_REACHED'
    )
    assert.equal(db.hostRows[0].keepAwake, false, 'switch stays off when the hours check throws')
})

// --- reserveSpriteRuntime: explicit placement, one runtime per (host, framework) ---

const spriteRuntime = (over: {
    id?: string
    framework?: NewAgentRuntimeRow['framework']
    hostId?: string
}) => ({
    id: over.id ?? 'art-new',
    userId: 'user-1',
    framework: over.framework ?? 'codex',
    providerId: 'rtp-1',
    hostId: over.hostId,
    mountPath: '/home/sprite'
})

test('RuntimeAccessService.reserveSpriteRuntime attaches to an existing sandbox and clears emptied_at', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1', emptiedAt: now }))
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime(
        spriteRuntime({ hostId: 'sbx-1' })
    )

    assert.equal(hostCreated, false)
    assert.equal(runtime.hostId, 'sbx-1')
    assert.equal(runtime.status, 'installing')
    assert.equal(
        runtime.name,
        'sbx-1-codex',
        'attached runtime name is <host-name>-<framework>'
    )
    assert.equal(
        db.hostRows.find((h) => h.id === 'sbx-1')?.emptiedAt,
        null,
        'attach clears the reaper clock'
    )
})

// Callers route a same-framework create into the existing instance (add-agent)
// before reserving, so reaching this rejection means two creates raced. It has to
// stay: the framework's config home and globally-installed CLI are VM-wide, so a
// second instance of one framework on one VM would fight the first.
test('RuntimeAccessService.reserveSpriteRuntime rejects a raced second instance of the same framework', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1' }))
    db.runtimeRows.push(runtimeRow({ id: 'art-a', status: 'ready', hostId: 'sbx-1' }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveSpriteRuntime(spriteRuntime({ hostId: 'sbx-1' })),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_FRAMEWORK_EXISTS'
    )
})

// A failed install keeps its (host, framework) slot; a retry reuses the row
// instead of installing a second copy.
test('RuntimeAccessService.reserveSpriteRuntime reuses a failed row for the retry', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'art-failed', status: 'failed', hostId: 'sbx-1' })
    )
    const service = makeService(db)

    const { runtime } = await service.reserveSpriteRuntime(
        spriteRuntime({ hostId: 'sbx-1' })
    )

    assert.equal(runtime.id, 'art-failed', 'the slot is the existing row')
    assert.equal(runtime.status, 'installing')
    assert.equal(db.runtimeRows.length, 1)
})

// No capacity ceiling: a sandbox holds one instance per framework, so the only
// bound is the framework count.
test('RuntimeAccessService.reserveSpriteRuntime attaches past the old four-runtime capacity ceiling', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1' }))
    for (const framework of ['claude-code', 'codex', 'openclaw', 'hermes'] as const)
        db.runtimeRows.push(
            runtimeRow({ id: `art-${framework}`, status: 'ready', hostId: 'sbx-1', framework })
        )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime(
        spriteRuntime({ hostId: 'sbx-1', framework: 'gemini-cli' })
    )

    assert.equal(hostCreated, false, 'attach must not spill onto a new VM')
    assert.equal(runtime.hostId, 'sbx-1')
})

test('RuntimeAccessService.reserveSpriteRuntime rejects attach to a missing, foreign or unready sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({ id: 'sbx-foreign', userId: 'other', spriteId: 'sprite-1' }),
        hostRow({ id: 'sbx-provisioning', status: 'provisioning' })
    )
    const service = makeService(db)

    for (const hostId of ['sbx-foreign', 'sbx-provisioning', 'sbx-missing'])
        await assert.rejects(
            () => service.reserveSpriteRuntime(spriteRuntime({ hostId })),
            (err) =>
                err instanceof NotFoundException &&
                (err.getResponse() as { code?: string }).code ===
                    'SANDBOX_NOT_FOUND',
            hostId
        )
})

// A service framework needs the sprite's single public port, but coding
// frameworks don't use it at all — so a sandbox running only coding agents can
// still take one.
test('RuntimeAccessService.reserveSpriteRuntime attaches a service framework to a coding-only sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'art-a', status: 'ready', hostId: 'sbx-1', framework: 'claude-code' })
    )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime(
        spriteRuntime({ hostId: 'sbx-1', framework: 'hermes' })
    )

    assert.equal(hostCreated, false)
    assert.equal(runtime.hostId, 'sbx-1')
    assert.equal(runtime.framework, 'hermes')
})

// Two service frameworks on one sprite would both claim `http_port`, which the
// platform rejects outright — so the second one is refused up front.
test('RuntimeAccessService.reserveSpriteRuntime refuses a second service framework on one sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'art-a', status: 'ready', hostId: 'sbx-1', framework: 'openclaw' })
    )
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveSpriteRuntime(spriteRuntime({ hostId: 'sbx-1', framework: 'hermes' })),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string; existingFramework?: string })
                .code === 'SANDBOX_SERVICE_SLOT_TAKEN' &&
            (err.getResponse() as { existingFramework?: string })
                .existingFramework === 'openclaw'
    )
})

// A failed service runtime releases the port, so its sandbox can take another.
test('RuntimeAccessService.reserveSpriteRuntime ignores a failed service framework for the slot', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'art-a', status: 'failed', hostId: 'sbx-1', framework: 'openclaw' })
    )
    const service = makeService(db)

    const { runtime } = await service.reserveSpriteRuntime(
        spriteRuntime({ hostId: 'sbx-1', framework: 'hermes' })
    )

    assert.equal(runtime.framework, 'hermes')
})

// Placement is explicit: without a hostId the reservation always builds a fresh
// VM. It must never quietly land on an existing sandbox.
test('RuntimeAccessService.reserveSpriteRuntime always creates a host when no sandbox is named', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-1', name: 'sandbox-001', spriteId: 'sprite-1' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'art-a', status: 'ready', hostId: 'sbx-1', framework: 'claude-code' })
    )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime(spriteRuntime({}))

    assert.equal(hostCreated, true)
    assert.notEqual(runtime.hostId, 'sbx-1', 'an idle sandbox with room must not absorb the create')
    const host = db.hostRows.find((h) => h.id === runtime.hostId)!
    assert.equal(host.kind, 'hosted')
    assert.equal(host.providerId, 'rtp-1')
    assert.equal(host.status, 'provisioning')
    assert.equal(host.generation, 1)
    // The adapter records the machine once it has made it.
    assert.equal(host.providerRef, null)
    assert.equal(host.emptiedAt, null)
})

test('RuntimeAccessService.reserveSpriteRuntime needs a provider for a fresh sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveSpriteRuntime({ ...spriteRuntime({}), providerId: null }),
        (err) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code ===
                'RUNTIME_PROVIDER_UNAVAILABLE'
    )
    assert.equal(db.hostRows.length, 0)
})

test('RuntimeAccessService.reserveStandaloneSandbox creates an empty provisioning sandbox under quota', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    const service = makeService(db)

    const host = await service.reserveStandaloneSandbox({
        userId: 'user-1',
        name: 'Research Sandbox',
        providerId: 'rtp-1'
    })

    assert.match(host.id, /^sbx_[a-z2-7]{26}$/)
    assert.equal(host.userId, 'user-1')
    assert.equal(host.kind, 'hosted')
    assert.equal(host.name, 'Research Sandbox')
    assert.equal(host.providerId, 'rtp-1')
    assert.equal(host.status, 'provisioning')
    assert.equal(host.providerRef, null)
    assert.ok(host.emptiedAt instanceof Date)
    assert.deepEqual(
        db.lockNamespaces,
        ['0'],
        'standalone sandbox admission must serialize with agent runtime admission'
    )
})

test('RuntimeAccessService.reserveStandaloneSandbox rejects when live sandbox hosts fill quota', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    db.hostRows.push(hostRow({ id: 'sbx-existing' }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveStandaloneSandbox({
                userId: 'user-1',
                name: 'Second Sandbox',
                providerId: 'rtp-1'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string; current?: number }).code ===
                'RUNTIME_LIMIT_REACHED' &&
            (err.getResponse() as { current?: number }).current === 1
    )
    assert.equal(db.hostRows.length, 1)
})

test('RuntimeAccessService.reserveSpriteRuntime counts empty sandbox hosts against provisioned quota', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    db.hostRows.push(hostRow({ id: 'sbx-empty' }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveSpriteRuntime(spriteRuntime({})),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string; current?: number }).code ===
                'RUNTIME_LIMIT_REACHED' &&
            (err.getResponse() as { current?: number }).current === 1
    )
    assert.equal(db.runtimeRows.length, 0)
})

test('RuntimeAccessService.reserveSpriteRuntime names a fresh sandbox sandbox-NNN and runtime <sandbox>-<framework>', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 5 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 5 }))
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime(spriteRuntime({}))

    assert.equal(hostCreated, true)
    assert.equal(runtime.name, 'sandbox-001-codex')
    const host = db.hostRows.find((h) => h.id === runtime.hostId)
    assert.equal(host?.name, 'sandbox-001')
})

test('RuntimeAccessService.reserveSpriteRuntime continues the sandbox sequence from the max existing', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 5 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 5 }))
    db.hostRows.push(hostRow({ id: 'sbx-old', name: 'sandbox-007' }))
    const service = makeService(db)

    const { runtime } = await service.reserveSpriteRuntime(spriteRuntime({}))

    assert.equal(runtime.name, 'sandbox-008-codex')
    assert.ok(
        db.hostRows.some((h) => h.name === 'sandbox-008'),
        'fresh host takes the next sandbox number'
    )
})

test('RuntimeAccessService.reserveSpriteRuntime de-dupes a runtime name when host names collide', async () => {
    // Host names are not db-unique; a user can rename two sandboxes alike, so
    // the derived <host>-<framework> label can already be taken. Duplicates are
    // legal now — the suffix only keeps auto-generated labels tellable apart.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'h1', name: 'dup', spriteId: 'sprite-1' }))
    db.hostRows.push(hostRow({ id: 'h2', name: 'dup' }))
    db.runtimeRows.push(runtimeRow({ id: 'art-existing', status: 'ready', hostId: 'h2' }))
    db.runtimeRows[0].name = 'dup-codex'
    const service = makeService(db)

    const { runtime } = await service.reserveSpriteRuntime(spriteRuntime({ hostId: 'h1' }))

    assert.equal(runtime.name, 'dup-codex-2')
})

test('RuntimeAccessService.reserveStandaloneSandbox auto-names sandbox-NNN when no name is given', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 5 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 5 }))
    db.hostRows.push(hostRow({ id: 'sbx-old', name: 'sandbox-003' }))
    const service = makeService(db)

    const host = await service.reserveStandaloneSandbox({
        userId: 'user-1',
        providerId: 'rtp-1'
    })

    assert.equal(host.name, 'sandbox-004')
})

test('RuntimeAccessService.reserveSandboxRetry takes a failed sandbox back to provisioning in its own row', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    // Built long ago: an old emptied_at would let the reaper take the
    // sandbox the moment it came up.
    const builtAt = new Date('2026-04-01T00:00:00.000Z')
    db.hostRows.push(
        hostRow({
            id: 'sbx-failed',
            name: 'sandbox-001',
            status: 'failed',
            failureReason: 'runner did not connect',
            emptiedAt: builtAt
        })
    )
    const service = makeService(db)

    // A failed row holds no slot, so the plan's only one is free for it.
    const host = await service.reserveSandboxRetry({
        userId: 'user-1',
        hostId: 'sbx-failed'
    })

    assert.equal(host.id, 'sbx-failed')
    assert.equal(host.name, 'sandbox-001')
    assert.equal(host.status, 'provisioning')
    assert.equal(host.failureReason, null)
    assert.ok(host.emptiedAt instanceof Date && host.emptiedAt > builtAt)
    assert.equal(db.hostRows.length, 1)
    assert.deepEqual(
        db.lockNamespaces,
        ['0'],
        'a retry must serialize with every other sandbox admission'
    )
})

test('RuntimeAccessService.reserveSandboxRetry refuses a sandbox that is not failed', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(hostRow({ id: 'sbx-ready', status: 'ready' }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSandboxRetry({
                userId: 'user-1',
                hostId: 'sbx-ready'
            }),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_NOT_FAILED'
    )
    assert.equal(db.hostRows[0].status, 'ready')
    assert.equal(db.hostUpdates.length, 0)
})

test('RuntimeAccessService.reserveSandboxRetry is refused when live sandboxes fill the quota', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    db.hostRows.push(hostRow({ id: 'sbx-failed', status: 'failed' }))
    db.hostRows.push(hostRow({ id: 'sbx-live', status: 'ready' }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSandboxRetry({
                userId: 'user-1',
                hostId: 'sbx-failed'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'RUNTIME_LIMIT_REACHED'
    )
    assert.equal(db.hostRows[0].status, 'failed')
})

test('RuntimeAccessService.reserveSandboxRetry answers not found for a sandbox that is gone', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSandboxRetry({
                userId: 'user-1',
                hostId: 'sbx-gone'
            }),
        NotFoundException
    )
})

// --- active-hours quota (ACTIVE_HOURS_QUOTA_REACHED) ---

test('RuntimeAccessService.reserveActiveSlot rejects when included active hours are exhausted', async () => {
    const db = new FakeRuntimeAccessDb()
    // free.monthlyActiveHoursIncluded = 5
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, { activeSeconds: 5 * 3600 })

    await assert.rejects(
        () =>
            service.reserveActiveSlot({
                userId: 'user-1',
                hostId: 'host-new'
            }),
        (err) => {
            const body = (err as ForbiddenException).getResponse() as {
                code?: string
                current?: number
                limit?: number
                planName?: string
            }
            return (
                err instanceof ForbiddenException &&
                body.code === 'ACTIVE_HOURS_QUOTA_REACHED' &&
                body.current === 5 &&
                body.limit === 5 &&
                body.planName === 'Free'
            )
        }
    )
})

test('RuntimeAccessService.reserveActiveSlot reports hours exhaustion over the concurrent cap', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'host-existing', powerState: 'running' }))
    const service = makeService(db, { activeSeconds: 6 * 3600 })

    await assert.rejects(
        () =>
            service.reserveActiveSlot({
                userId: 'user-1',
                hostId: 'host-new'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'ACTIVE_HOURS_QUOTA_REACHED'
    )
})

test('RuntimeAccessService.reserveActiveSlot admits just under the hours limit', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, { activeSeconds: 5 * 3600 - 1 })

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-new'
    })

    assert.equal(result.plan?.name, 'Free')
})

test('RuntimeAccessService.reserveActiveSlot ignores hours on unlimited plans', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', monthlyActiveHoursIncluded: null })]
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, { activeSeconds: 10_000 * 3600 })

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-new'
    })

    assert.ok(result.plan)
})

test('RuntimeAccessService.reserveActiveSlot skips the hours check when the toggle is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, {
        activeSeconds: 10_000 * 3600,
        featureEnabled: { active_hours_enforcement: false }
    })

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-new'
    })

    assert.ok(result.plan)
})

test('RuntimeAccessService.reserveActiveSlot lifts the limit by the per-user hours bonus', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free', activeHoursBonus: 5 }))
    const service = makeService(db, { activeSeconds: 6 * 3600 })

    const under = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-new'
    })
    assert.ok(under.plan, '6h used is under the 5+5h bonus limit')

    const exhausted = makeService(db, { activeSeconds: 10 * 3600 })
    await assert.rejects(
        () =>
            exhausted.reserveActiveSlot({
                userId: 'user-1',
                hostId: 'host-new'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { limit?: number }).limit === 10
    )
})

// Concurrency and the org cap stay skipped on the fast path — those are about
// a slot this host already holds — but hours are CONSUMED by it staying
// running, so they have to be re-read. Seen on prod [2026-09-03]: a leaked
// exec session pinned a free sandbox `running` and this path kept admitting
// turns at 52h against a 5h plan.
test('RuntimeAccessService.reserveActiveSlot rejects an exhausted user even on the fast path', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'host-running', powerState: 'running', activeAccrualSince: now })
    )
    const exhausted = makeService(db, { activeSeconds: 100 * 3600 })

    await assert.rejects(
        () =>
            exhausted.reserveActiveSlot({
                userId: 'user-1',
                hostId: 'host-running'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'ACTIVE_HOURS_QUOTA_REACHED'
    )

    const withinQuota = makeService(db, { activeSeconds: 60 })
    const result = await withinQuota.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-running'
    })
    assert.equal(result.fastPath, true)
    assert.equal(db.lockCount, 0)
})

test('RuntimeAccessService.reserveActiveSlot fast path skips the hours check when enforcement is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'host-running', powerState: 'running', activeAccrualSince: now })
    )
    const service = makeService(db, {
        activeSeconds: 100 * 3600,
        featureEnabled: { active_hours_enforcement: false }
    })

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-running'
    })

    assert.equal(result.fastPath, true)
})

test('RuntimeAccessService.isActiveHoursExhausted mirrors the assert without throwing', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))

    assert.equal(
        await makeService(db, { activeSeconds: 5 * 3600 }).isActiveHoursExhausted('user-1'),
        true
    )
    assert.equal(
        await makeService(db, { activeSeconds: 3600 }).isActiveHoursExhausted('user-1'),
        false
    )
    assert.equal(
        await makeService(db, {
            activeSeconds: 5 * 3600,
            featureEnabled: { active_hours_enforcement: false }
        }).isActiveHoursExhausted('user-1'),
        false
    )
    assert.equal(
        await makeService(db).isActiveHoursExhausted('user-unknown'),
        false,
        'missing user fails open'
    )
})

test('RuntimeAccessService.summary exposes activeHoursLimit including the per-user bonus', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free', activeHoursBonus: 2 }))
    const service = makeService(db, { activeSeconds: 3600 })

    const summary = await service.summary('user-1')

    assert.equal(summary.activeHoursThisPeriod, 1)
    assert.equal(summary.activeHoursLimit, 7)
    assert.equal(summary.activeHoursBonus, 2)
})

test('RuntimeAccessService warns active_hours at 80% and stamps only after ACK', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, { activeSeconds: 4 * 3600 })

    const due = await service.evaluateQuotaThresholds('user-1')

    const hours = due.find((d) => d.code === 'active_hours')
    assert.ok(hours, 'active_hours should be due at 80% of 5h')
    assert.equal(hours?.usage, 4)
    assert.equal(hours?.limit, 5)
    assert.deepEqual(db.users[0].lastQuotaWarningsAt, {})
    assert.equal(await service.acknowledgeQuotaWarning('user-1', hours.receiptId), true)
    assert.ok(
        (db.users[0].lastQuotaWarningsAt as Record<string, string>).active_hours
    )
})

test('RuntimeAccessService.evaluateQuotaThresholds dedups active_hours within 24h and re-emits after', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(
        userRow({
            planId: 'free',
            lastQuotaWarningsAt: {
                active_hours: new Date(Date.now() - 60 * 60 * 1000).toISOString()
            }
        })
    )
    const service = makeService(db, { activeSeconds: 4 * 3600 })

    const fresh = await service.evaluateQuotaThresholds('user-1')
    assert.equal(fresh.find((d) => d.code === 'active_hours'), undefined, 'warned an hour ago — deduped')

    db.users[0].lastQuotaWarningsAt = {
        active_hours: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    }
    const stale = await service.evaluateQuotaThresholds('user-1')
    assert.ok(stale.find((d) => d.code === 'active_hours'), 'a 25h-old stamp is past the 24h dedup window')
})

// --- storage hard limit (STORAGE_LIMIT_REACHED) ---

test('RuntimeAccessService.reserveStandaloneSandbox rejects when storage is at the plan limit', async () => {
    const db = new FakeRuntimeAccessDb()
    // free.maxStorageGb = 3 (decimal GB); metered per sandbox host
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-full', storageBytes: 3_000_000_000 }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveStandaloneSandbox({ userId: 'user-1', providerId: 'rtp-1' }),
        (err) => {
            const body = (err as ForbiddenException).getResponse() as {
                code?: string
                limit?: number
            }
            return (
                err instanceof ForbiddenException &&
                body.code === 'STORAGE_LIMIT_REACHED' &&
                body.limit === 3_000_000_000
            )
        }
    )
})

test('RuntimeAccessService.reserveStandaloneSandbox admits under the storage limit', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-under', storageBytes: 2_000_000_000 }))
    const service = makeService(db)

    const host = await service.reserveStandaloneSandbox({ userId: 'user-1', providerId: 'rtp-1' })

    assert.ok(host.id)
})

test('RuntimeAccessService.reserveStandaloneSandbox skips the storage check when the toggle is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-over', storageBytes: 9_000_000_000 }))
    const service = makeService(db, {
        featureEnabled: { storage_hard_limit: false }
    })

    const host = await service.reserveStandaloneSandbox({ userId: 'user-1', providerId: 'rtp-1' })

    assert.ok(host.id)
})

test('RuntimeAccessService.reserveSpriteRuntime rejects fresh provisioning when storage is exhausted', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-exhausted', storageBytes: 4_000_000_000 }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveSpriteRuntime(spriteRuntime({})),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'STORAGE_LIMIT_REACHED'
    )
})

test('RuntimeAccessService.reserveSpriteRuntime rejects attach when storage is exhausted', async () => {
    // The storage assert sits before the attach branch: attaching another
    // framework grows the same VM's disk, so it is blocked too.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-1', spriteId: 'sprite-1', storageBytes: 4_000_000_000 }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveSpriteRuntime(spriteRuntime({ hostId: 'sbx-1' })),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'STORAGE_LIMIT_REACHED'
    )
})

// --- fixtures ---

const userRow = (
    overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => ({
    id: 'user-1',
    email: 'user@example.com',
    role: 'user',
    statefulSandboxLimit: 1,
    alwaysOnlineRuntimeBonus: 0,
    activeHoursBonus: 0,
    planId: 'free',
    lastQuotaWarningsAt: {},
    pendingQuotaWarnings: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
})

const planRow = (
    overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => ({
    id: 'free',
    name: 'Free',
    maxAgentsProvisioned: 3,
    maxConcurrentActive: 1,
    maxStorageGb: 3,
    monthlyActiveHoursIncluded: 5,
    maxAlwaysOnlineRuntimes: 0,
    maxAlwaysOnlineAgents: 0,
    maxChannels: 0,
    maxAutomations: 0,
    maxAutomationRunsMonthly: null,
    messageHistoryRetentionDays: 30,
    monthlyApiRequestLimit: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
})

// A host row — the unit every count is taken over. `providerKind` stands in
// for the runtime_providers join the real predicates make.
interface FakeHostRow {
    id: string
    userId: string
    kind: 'local' | 'hosted'
    providerKind: 'sprites' | 'k8s' | null
    providerId: string | null
    providerRef: Record<string, unknown> | null
    name: string
    status: string
    powerState: string | null
    keepAwake: boolean
    generation: number
    activeAccrualSince: Date | null
    emptiedAt: Date | null
    storageBytes: number | null
    failureReason: string | null
    createdAt: Date
    updatedAt: Date
}

const hostRow = (overrides: {
    id: string
    kind?: 'local' | 'hosted'
    providerKind?: 'sprites' | 'k8s'
    name?: string
    userId?: string
    spriteId?: string | null
    powerState?: string | null
    status?: string
    keepAwake?: boolean
    emptiedAt?: Date | null
    activeAccrualSince?: Date | null
    storageBytes?: number | null
    failureReason?: string | null
}): FakeHostRow => {
    const kind = overrides.kind ?? 'hosted'
    const providerKind = kind === 'local' ? null : (overrides.providerKind ?? 'sprites')
    return {
        id: overrides.id,
        userId: overrides.userId ?? 'user-1',
        kind,
        providerKind,
        providerId: kind === 'local' ? null : 'rtp-1',
        providerRef:
            kind === 'local'
                ? null
                : providerKind === 'k8s'
                  ? { kind: 'k8s', namespace: 'ns', ingressHost: null, podPhase: null }
                  : { kind: 'sprites', spriteName: overrides.id, spriteId: overrides.spriteId ?? null },
        name: overrides.name ?? overrides.id,
        status: overrides.status ?? 'ready',
        powerState: overrides.powerState ?? null,
        keepAwake: overrides.keepAwake ?? false,
        generation: 1,
        activeAccrualSince: overrides.activeAccrualSince ?? null,
        emptiedAt: overrides.emptiedAt ?? null,
        storageBytes: overrides.storageBytes ?? null,
        failureReason: overrides.failureReason ?? null,
        createdAt: now,
        updatedAt: now
    }
}

const runtimeRow = (overrides: {
    id: string
    status?: NewAgentRuntimeRow['status']
    framework?: NewAgentRuntimeRow['framework']
    // absent = an external runtime (no host)
    hostId?: string
}): NewAgentRuntimeRow => ({
    id: overrides.id,
    userId: 'user-1',
    name: overrides.id,
    framework: overrides.framework ?? 'codex',
    hostId: overrides.hostId ?? null,
    status: overrides.status ?? 'installing',
    mountPath: '/workspace',
    currentPhase: null,
    failureReason: null,
    controlUiEnabled: true,
    dashboardEnabled: false,
    lastBootstrappedAt: null,
    createdAt: now,
    updatedAt: now
})

// Raw sql`` templates keep interpolated scalars as primitive string chunks;
// eq() conditions wrap theirs in Param — collect both so the fake can apply
// the real query's arguments instead of canned filters.
const sqlTextOf = (query: unknown): string =>
    ((query as { queryChunks?: unknown[] })?.queryChunks ?? [])
        .map((chunk) =>
            chunk instanceof StringChunk
                ? chunk.value.join('')
                : sqlTextOf(chunk)
        )
        .join('')

const sqlParamsOf = (query: unknown): unknown[] => {
    const params: unknown[] = []
    const visit = (chunk: unknown): void => {
        // inArray() nests its values as an array of Params inside one chunk.
        if (Array.isArray(chunk)) chunk.forEach(visit)
        else if (chunk instanceof Param)
            params.push(...(Array.isArray(chunk.value) ? chunk.value : [chunk.value]))
        else if (typeof chunk === 'string') params.push(chunk)
        else
            for (const nested of (chunk as { queryChunks?: unknown[] })
                ?.queryChunks ?? []) {
                visit(nested)
            }
    }
    for (const chunk of (query as { queryChunks?: unknown[] })?.queryChunks ??
        []) {
        visit(chunk)
    }
    return params
}

const isLiveLocal = (row: FakeHostRow): boolean =>
    row.kind === 'local' && row.status !== 'retired'
const isLiveHosted = (row: FakeHostRow, providerKind: string): boolean =>
    row.kind === 'hosted' &&
    row.providerKind === providerKind &&
    HOSTED_LIVE.includes(row.status)
const isAlwaysOnline = (row: FakeHostRow): boolean =>
    isLiveLocal(row) || isLiveHosted(row, 'k8s')

class FakeRuntimeAccessDb {
    users: Record<string, unknown>[] = []
    runtimeRows: NewAgentRuntimeRow[] = []
    auditRows: Record<string, unknown>[] = []
    plans: Record<string, unknown>[] = [planRow()]
    agents: Record<string, unknown>[] = []
    hostRows: FakeHostRow[] = []
    channelRows: Record<string, unknown>[] = []
    automationRows: Record<string, unknown>[] = []
    automationRunRows: Record<string, unknown>[] = []
    apiUsageDayRows: Record<string, unknown>[] = []
    hostUpdates: Record<string, unknown>[] = []
    lockNamespaces: string[] = []
    lockCount = 0

    select(fields?: Record<string, unknown>): FakeQuery {
        return new FakeQuery(this, 'select', undefined, fields)
    }

    insert(table: unknown): FakeQuery {
        return new FakeQuery(this, 'insert', table)
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }

    async execute(query?: unknown): Promise<unknown[]> {
        const text = sqlTextOf(query)
        if (text.includes('framework_present')) {
            // reserveSpriteRuntime explicit-attach probe. Params interpolate in
            // text order: framework, framework, ...serviceFrameworks, hostId,
            // userId. The service-framework list is read back out of the
            // params so a production change to it fails the slot tests.
            const params = sqlParamsOf(query) as string[]
            const framework = params[0]
            const serviceFrameworks = params.slice(2, -2)
            const [hostId, userId] = params.slice(-2)
            const host = this.hostRows.find(
                (h) =>
                    h.id === hostId &&
                    h.userId === userId &&
                    h.kind === 'hosted' &&
                    h.status === 'ready' &&
                    h.providerKind === 'sprites' &&
                    (h.providerRef as { spriteId?: string | null } | null)?.spriteId != null
            )
            if (!host) return []
            const live = this.runtimeRows.filter(
                (r) => r.hostId === hostId && r.status !== 'failed'
            )
            const frameworkPresent = live.some((r) => r.framework === framework)
            const serviceFramework =
                live.find(
                    (r) =>
                        r.framework !== framework &&
                        serviceFrameworks.includes(r.framework as string)
                )?.framework ?? null
            return [
                {
                    host_name: host.name,
                    framework_present: frameworkPresent,
                    service_framework: serviceFramework
                }
            ]
        }
        if (text.includes('keep_awake')) {
            // committed-capacity union: running sandboxes UNION kept-awake
            // ones, the target excluded from both arms (read from the query
            // text so a dropped != predicate fails the exclusion test).
            const [userId, hostId] = sqlParamsOf(query) as string[]
            if (hostId === undefined)
                throw new Error('enableKeepAlive committed-capacity union called without hostId')
            const excludes = (text.match(/h\.id != /g) ?? []).length
            const live = this.hostRows.filter(
                (row) => row.userId === userId && isLiveHosted(row, 'sprites')
            )
            const running = live
                .filter((row) => row.powerState === 'running' && !(excludes >= 1 && row.id === hostId))
                .map((row) => row.id)
            const awake = live
                .filter((row) => row.keepAwake && !(excludes >= 2 && row.id === hostId))
                .map((row) => row.id)
            return [{ value: new Set([...running, ...awake]).size }]
        }
        if (text.includes("'^sandbox-(")) {
            // nextSandboxName: MAX numeric suffix among this user's hosted hosts.
            const [maxUserId] = sqlParamsOf(query) as string[]
            let max = 0
            for (const h of this.hostRows) {
                if (h.userId !== maxUserId || h.kind !== 'hosted') continue
                const m = /^sandbox-(\d+)$/.exec(String(h.name))
                if (m) max = Math.max(max, Number(m[1]))
            }
            return [{ max }]
        }
        // Every legitimate raw query against runtime_hosts is handled above and
        // is keyed to one host. An unrecognized one means a host *search* was
        // reintroduced — implicit placement, which the explicit-placement
        // contract forbids.
        if (text.includes('runtime_hosts'))
            throw new Error(
                `unexpected runtime_hosts query in fake db (implicit host selection?): ${text}`
            )
        const namespace = /hashtextextended\([^)]*, (\d+)\)/.exec(text)?.[1]
        if (namespace) this.lockNamespaces.push(namespace)
        this.lockCount += 1
        return []
    }

    async transaction<T>(
        fn: (tx: FakeRuntimeAccessDb) => Promise<T>
    ): Promise<T> {
        return fn(this)
    }

    // The host rows a predicate selects, decoded from the parameters the real
    // query binds: the kind literals, the provider kind inside the exists()
    // subquery, the live statuses, 'running', the user and any excluded id.
    private hostsMatching(condition: unknown): FakeHostRow[] {
        const params = sqlParamsOf(condition)
        let rows = this.hostRows
        if (params.includes('hosted')) rows = rows.filter((row) => row.kind === 'hosted')
        if (params.includes('local')) rows = rows.filter((row) => row.kind === 'local')
        if (params.includes('sprites') || params.includes('k8s')) {
            const kinds = ['sprites', 'k8s'].filter((k) => params.includes(k))
            rows = rows.filter((row) => row.providerKind !== null && kinds.includes(row.providerKind))
        }
        if (params.includes('provisioning'))
            rows = rows.filter((row) => HOSTED_LIVE.includes(row.status))
        if (params.includes('retired'))
            rows = rows.filter((row) => row.status !== 'retired')
        if (params.includes('running'))
            rows = rows.filter((row) => row.powerState === 'running')
        const userId = params.find(
            (value): value is string =>
                typeof value === 'string' && /^(user|u)-/.test(value)
        )
        if (userId) rows = rows.filter((row) => row.userId === userId)
        const excluded = params.filter(
            (value): value is string =>
                typeof value === 'string' && this.hostRows.some((row) => row.id === value)
        )
        if (excluded.length) rows = rows.filter((row) => !excluded.includes(row.id))
        return rows
    }

    rowsFor(
        table: unknown,
        grouped: boolean,
        joined: boolean,
        condition?: unknown,
        limited = false,
        fields?: Record<string, unknown>
    ): unknown[] {
        if (table === plans) {
            const ids = sqlParamsOf(condition)
            return this.plans.filter((plan) => ids.includes(plan.id))
        }
        if (table === users) {
            if (joined) {
                return this.users.map((user) => {
                    const plan =
                        this.plans.find((row) => row.id === user.planId) ??
                        this.plans[0]
                    const p = plan as Record<string, unknown>
                    return {
                        ...user,
                        user,
                        plan,
                        userId: user.id,
                        planName: p.name,
                        maxAgentsProvisioned: p.maxAgentsProvisioned,
                        maxConcurrentActive: p.maxConcurrentActive,
                        maxStorageGb: p.maxStorageGb,
                        monthlyActiveHoursIncluded:
                            p.monthlyActiveHoursIncluded,
                        maxAlwaysOnlineRuntimes: p.maxAlwaysOnlineRuntimes,
                        maxAlwaysOnlineAgents: p.maxAlwaysOnlineAgents,
                        maxChannels: p.maxChannels,
                        maxAutomations: p.maxAutomations,
                        maxAutomationRunsMonthly: p.maxAutomationRunsMonthly,
                        messageHistoryRetentionDays:
                            p.messageHistoryRetentionDays,
                        monthlyApiRequestLimit: p.monthlyApiRequestLimit,
                        priceUsdMonthly: p.priceUsdMonthly
                    }
                })
            }
            return this.users
        }
        if (table === agents) return []
        if (table === runtimeHosts) {
            if (limited) {
                // A single host by id: the placement read (joined, with the
                // provider kind) or reserveActiveSlot's fast-path pre-read.
                const idParam = sqlParamsOf(condition).find(
                    (value): value is string =>
                        typeof value === 'string' &&
                        this.hostRows.some((row) => row.id === value)
                )
                const row = this.hostRows.find((h) => h.id === idParam)
                if (!row) return []
                return joined
                    ? [{ kind: row.kind, providerKind: row.providerKind }]
                    : [row]
            }
            const rows = this.hostsMatching(condition)
            if (fields?.value && sqlTextOf(fields.value).includes('sum('))
                return [
                    {
                        value: rows.reduce(
                            (acc, row) => acc + Number(row.storageBytes ?? 0),
                            0
                        )
                    }
                ]
            if (grouped) return this.groupedHostUsage(rows)
            return [{ value: rows.length }]
        }
        if (table === channels) return [{ value: this.channelRows.length }]
        if (table === automations)
            // The production query excludes tombstoned automations; mirror
            // that so a deletedAt row frees its plan slot in these tests.
            return [
                {
                    value: this.automationRows.filter(
                        (row) => row.deletedAt == null
                    ).length
                }
            ]
        if (table === automationRuns)
            return [{ value: this.automationRunRows.length }]
        if (table === userApiUsageDays)
            return [
                {
                    value: this.apiUsageDayRows.reduce(
                        (acc, row) => acc + Number(row.requestCount ?? 0),
                        0
                    )
                }
            ]
        if (table !== agentRuntimes) return []
        if (fields && Object.keys(fields).length === 1 && 'name' in fields) {
            // nextRuntimeName: every runtime name this user already holds.
            const [nameUserId] = sqlParamsOf(condition)
            return this.runtimeRows.filter((row) => row.userId === nameUserId)
        }
        const liveRuntimes = this.runtimeRows.filter((row) => row.status !== 'failed')
        if (joined) {
            // Always-online agent slots: live runtimes on a local host or a
            // cloud computer (usageCountsForUsers grouped, alwaysOnlineUsageInTx
            // for one user).
            const onAlwaysOnline = liveRuntimes.filter((row) => {
                const host = this.hostRows.find((h) => h.id === row.hostId)
                return host !== undefined && isAlwaysOnline(host)
            })
            if (grouped) {
                const counts = new Map<string, number>()
                for (const row of onAlwaysOnline)
                    counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1)
                return Array.from(counts, ([userId, value]) => ({ userId, value }))
            }
            const [userId] = sqlParamsOf(condition)
            return [{ value: onAlwaysOnline.filter((row) => row.userId === userId).length }]
        }
        // External runtimes (host_id is null), for the provisioned cap.
        const [userId] = sqlParamsOf(condition)
        return [
            {
                value: liveRuntimes.filter(
                    (row) => row.userId === userId && !row.hostId
                ).length
            }
        ]
    }

    insertRow(
        table: unknown,
        values: Record<string, unknown>,
        conflict?: { set: Record<string, unknown> }
    ): unknown[] {
        if (table === agentRuntimes) {
            const existing = values.hostId
                ? this.runtimeRows.find(
                      (row) =>
                          row.hostId === values.hostId &&
                          row.framework === values.framework
                  )
                : undefined
            if (existing && conflict) {
                Object.assign(existing, conflict.set)
                return [existing]
            }
            const row = { ...values, createdAt: now, updatedAt: now }
            this.runtimeRows.push(row as NewAgentRuntimeRow)
            return [row]
        }
        if (table === auditLogs) {
            this.auditRows.push(values)
        }
        if (table === runtimeHosts) {
            const row: FakeHostRow = {
                providerKind: values.providerId ? 'sprites' : null,
                powerState: null,
                keepAwake: false,
                generation: 0,
                activeAccrualSince: null,
                emptiedAt: null,
                storageBytes: null,
                createdAt: now,
                updatedAt: now,
                ...(values as Partial<FakeHostRow>)
            } as FakeHostRow
            this.hostRows.push(row)
            return [row]
        }
        return []
    }

    updateRows(
        table: unknown,
        patch: Record<string, unknown>,
        condition?: unknown
    ): unknown[] {
        if (table === runtimeHosts) {
            this.hostUpdates.push(patch)
            const ids = sqlParamsOf(condition)
            const updated = this.hostRows.filter((row) => ids.includes(row.id))
            for (const row of updated) {
                const next = { ...patch }
                // sql`` fragments stand in for the real coalesce/case writes.
                if ('activeAccrualSince' in next && typeof next.activeAccrualSince === 'object' && !(next.activeAccrualSince instanceof Date))
                    next.activeAccrualSince = row.activeAccrualSince ?? new Date()
                if ('powerChangedAt' in next && !(next.powerChangedAt instanceof Date))
                    delete next.powerChangedAt
                Object.assign(row, next)
            }
            return updated
        }
        if (table !== users) return []
        const user = this.users[0]
        if (!user) return []
        Object.assign(user, patch)
        return [user]
    }

    private groupedHostUsage(
        rows: FakeHostRow[]
    ): Record<string, unknown>[] {
        const counts = new Map<string, number>()
        for (const row of rows) {
            counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1)
        }
        return Array.from(counts, ([userId, value]) => ({ userId, value }))
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private grouped = false
    private joined = false
    private limited = false
    private rowValues: Record<string, unknown> = {}
    private condition: unknown
    private conflict?: { set: Record<string, unknown> }

    constructor(
        private readonly db: FakeRuntimeAccessDb,
        private readonly kind: 'select' | 'insert' | 'update',
        private table?: unknown,
        private readonly fields?: Record<string, unknown>
    ) {}

    from(table: unknown): this {
        this.table = table
        return this
    }

    where(condition?: unknown): this {
        this.condition = condition
        return this
    }

    leftJoin(): this {
        this.joined = true
        return this
    }

    innerJoin(): this {
        this.joined = true
        return this
    }

    orderBy(): this {
        return this
    }

    groupBy(): this {
        this.grouped = true
        return this
    }

    limit(): this {
        this.limited = true
        return this
    }

    for(): this {
        return this
    }

    values(values: Record<string, unknown>): this {
        this.rowValues = values
        return this
    }

    set(patch: Record<string, unknown>): this {
        this.rowValues = patch
        return this
    }

    onConflictDoUpdate(config: { set: Record<string, unknown> }): this {
        this.conflict = config
        return this
    }

    returning(): Promise<unknown[]> {
        if (this.kind === 'insert')
            return Promise.resolve(
                this.db.insertRow(this.table, this.rowValues, this.conflict)
            )
        if (this.kind === 'update')
            return Promise.resolve(
                this.db.updateRows(this.table, this.rowValues, this.condition)
            )
        return Promise.resolve([])
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): PromiseLike<TResult1 | TResult2> {
        const promise = Promise.resolve(this.resolveRows())
        return promise.then(onfulfilled, onrejected)
    }

    private resolveRows(): unknown[] {
        if (this.kind === 'select')
            return this.db.rowsFor(
                this.table,
                this.grouped,
                this.joined,
                this.condition,
                this.limited,
                this.fields
            )
        if (this.kind === 'insert')
            return this.db.insertRow(this.table, this.rowValues, this.conflict)
        if (this.kind === 'update')
            return this.db.updateRows(
                this.table,
                this.rowValues,
                this.condition
            )
        return []
    }
}

// --- soft warnings for the always-on hard limits (no feature toggle) ---

// WHY the countCap trigger exists: Free allows 2 channels, so a pure 0.9 ratio
// first fires at 2/2 — the moment the user is already blocked. A warning that
// arrives with the rejection is not a warning.
test('RuntimeAccessService.evaluateQuotaThresholds warns on channels with one slot left', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxChannels: 2 })]
    db.users.push(userRow({ planId: 'free' }))
    db.channelRows.push({ id: 'chn-1' })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    const channelsDue = due.find((d) => d.code === 'channels')
    assert.ok(channelsDue, '1 of 2 leaves one slot — must warn')
    assert.equal(channelsDue?.usage, 1)
    assert.equal(channelsDue?.limit, 2)
})

test('RuntimeAccessService.evaluateQuotaThresholds stays quiet on channels with room left', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'pro', maxChannels: 100 })]
    db.users.push(userRow({ planId: 'pro' }))
    for (let i = 0; i < 50; i += 1) db.channelRows.push({ id: `chn-${i}` })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(due.find((d) => d.code === 'channels'), undefined)
})

test('RuntimeAccessService.evaluateQuotaThresholds warns on automations with one slot left', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAutomations: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    for (let i = 0; i < 2; i += 1) db.automationRows.push({ id: `atm-${i}` })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.ok(due.find((d) => d.code === 'automations'))
})

test('RuntimeAccessService.evaluateQuotaThresholds ignores tombstoned automations (#588)', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAutomations: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    for (let i = 0; i < 2; i += 1)
        db.automationRows.push({ id: `atm-${i}`, deletedAt: new Date() })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(due.find((d) => d.code === 'automations'), undefined, 'deleted automations must not consume plan slots')
})

test('RuntimeAccessService.evaluateQuotaThresholds warns on automation runs at 80%', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAutomationRunsMonthly: 30 })]
    db.users.push(userRow({ planId: 'free' }))
    for (let i = 0; i < 24; i += 1) db.automationRunRows.push({ id: `run-${i}` })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    const runs = due.find((d) => d.code === 'automation_runs')
    assert.ok(runs, '24 of 30 is 80%')
    assert.equal(runs?.limit, 30)
})

test('RuntimeAccessService.evaluateQuotaThresholds warns on API requests at 80%', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', monthlyApiRequestLimit: 5000 })]
    db.users.push(userRow({ planId: 'free' }))
    db.apiUsageDayRows.push({ requestCount: 4000 })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    const api = due.find((d) => d.code === 'api_requests')
    assert.ok(api)
    assert.equal(api?.usage, 4000)
    assert.equal(api?.limit, 5000)
})

// A null limit is "unlimited on this plan" — Pro has no automation-run or API
// ceiling, so no volume of usage should produce a banner telling them to upgrade.
test('RuntimeAccessService.evaluateQuotaThresholds never warns on an unlimited quota', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [
        planRow({ id: 'pro', maxAutomationRunsMonthly: null, monthlyApiRequestLimit: null })
    ]
    db.users.push(userRow({ planId: 'pro' }))
    for (let i = 0; i < 9999; i += 1) db.automationRunRows.push({ id: `run-${i}` })
    db.apiUsageDayRows.push({ requestCount: 1_000_000 })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(due.find((d) => d.code === 'automation_runs'), undefined)
    assert.equal(due.find((d) => d.code === 'api_requests'), undefined)
})

// Pins the deliberate inconsistency documented in evaluateQuotaThresholds:
// `provisioned` keeps its ratio-only trigger.
test('RuntimeAccessService.evaluateQuotaThresholds leaves provisioned on a ratio-only trigger', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'host-1' }), hostRow({ id: 'host-2' }))
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(due.find((d) => d.code === 'provisioned'), undefined, '2 of 3 is 67% — below the 0.9 ratio, and headroom is not applied here')
})

// --- external runtimes share the provisioned cap ---

test('RuntimeAccessService counts sandbox hosts against the external runtime cap', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'host-1' }), hostRow({ id: 'host-2' }))
    db.runtimeRows.push(runtimeRow({ id: 'runtime-1', status: 'ready' }))
    const service = makeService(db)

    await assert.rejects(
        () => service.reserveRuntime(runtimeRow({ id: 'runtime-2' })),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'RUNTIME_LIMIT_REACHED' &&
            // 2 sandbox hosts + 1 external = 3, the whole Free cap
            (err.getResponse() as { current?: number }).current === 3 &&
            (err.getResponse() as { kind?: string }).kind === 'external'
    )
})

test('RuntimeAccessService admits an external runtime while the shared cap has room', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'host-1' }))
    const service = makeService(db)

    const runtime = await service.reserveRuntime(runtimeRow({ id: 'runtime-1' }))

    assert.equal(runtime.id, 'runtime-1')
})
