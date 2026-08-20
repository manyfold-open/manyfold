import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { Param, StringChunk } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    auditLogs,
    automationRuns,
    automations,
    channels,
    runtimeHosts,
    userApiUsageDays,
    users,
    type NewAgentRuntimeRow
} from '@manyfold/db'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'

const now = new Date('2026-04-29T12:00:00.000Z')
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

test('RuntimeAccessService reserves pending sprites runtime under the user limit', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    const service = makeService(db)

    const runtime = await service.reserveRuntime(
        runtimeRow({ id: 'runtime-1', kind: 'sprites', status: 'pending' })
    )

    assert.equal(runtime.id, 'runtime-1')
    assert.equal(db.lockCount, 1)
    assert.equal(db.runtimeRows.length, 1)
    assert.equal(db.runtimeRows[0].status, 'pending')
})

test('RuntimeAccessService counts pending runtimes and rejects the next create', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'runtime-1', kind: 'external', status: 'pending' })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({
                    id: 'runtime-2',
                    kind: 'external',
                    status: 'pending'
                })
            ),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'RUNTIME_LIMIT_REACHED'
    )
})

test('RuntimeAccessService excludes failed runtimes from usage', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ statefulSandboxLimit: 1 }))
    db.runtimeRows.push(
        runtimeRow({ id: 'runtime-1', kind: 'external', status: 'failed' })
    )
    const service = makeService(db)

    await service.reserveRuntime(
        runtimeRow({ id: 'runtime-2', kind: 'external', status: 'pending' })
    )

    assert.equal(db.runtimeRows.length, 2)
})

test('RuntimeAccessService rejects always-online runtime for default users', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ alwaysOnlineRuntimeBonus: 0 }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({ id: 'runtime-1', kind: 'k8s', status: 'pending' })
            ),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'ALWAYS_ONLINE_AGENT_LIMIT_REACHED' &&
            (err.getResponse() as { kind?: string }).kind === 'k8s'
    )
})

test('RuntimeAccessService allows invited 3/3 quota and rejects the fourth runtime', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(
        userRow({ statefulSandboxLimit: 3, alwaysOnlineRuntimeBonus: 3 })
    )
    for (let index = 1; index <= 3; index += 1) {
        db.runtimeRows.push(
            runtimeRow({
                id: `runtime-${index}`,
                kind: 'external',
                status: 'ready'
            })
        )
    }
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({
                    id: 'runtime-4',
                    kind: 'external',
                    status: 'pending'
                })
            ),
        ForbiddenException
    )
})

test('RuntimeAccessService honors a per-user stateful override above the plan limit', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 10 }))
    for (let index = 1; index <= 3; index += 1) {
        db.runtimeRows.push(
            runtimeRow({
                id: `runtime-${index}`,
                kind: 'external',
                status: 'ready'
            })
        )
    }
    const service = makeService(db)

    const runtime = await service.reserveRuntime(
        runtimeRow({ id: 'runtime-4', kind: 'external', status: 'pending' })
    )

    assert.equal(runtime.id, 'runtime-4')
    assert.equal(db.runtimeRows.length, 4)
})

test('RuntimeAccessService still bounds sprites at the per-user override', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 10 }))
    for (let index = 1; index <= 10; index += 1) {
        db.runtimeRows.push(
            runtimeRow({
                id: `runtime-${index}`,
                kind: 'external',
                status: 'ready'
            })
        )
    }
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({
                    id: 'runtime-11',
                    kind: 'external',
                    status: 'pending'
                })
            ),
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
    db.runtimeRows.push(
        runtimeRow({ id: 'runtime-1', kind: 'sprites', status: 'ready' })
    )
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
    db.runtimeRows.push(
        runtimeRow({ id: 'runtime-sprites', kind: 'sprites', status: 'ready' }),
        runtimeRow({ id: 'runtime-k8s', kind: 'k8s', status: 'ready' }),
        runtimeRow({ id: 'runtime-daemon', kind: 'daemon', status: 'ready' })
    )
    db.hostRows.push(hostRow({ id: 'host-sprites' }))
    const service = makeService(db)

    const summary = await service.summary('user-1')

    assert.equal(summary.statefulSandboxUsage, 1)
    assert.equal(summary.alwaysOnlineRuntimesUsed, 1)
    assert.equal(summary.alwaysOnlineAgentsUsed, 2)
    assert.equal(summary.statefulSandboxRemaining, 4)
    assert.equal(summary.alwaysOnlineRuntimesRemaining, 4)
    assert.equal(summary.alwaysOnlineAgentsRemaining, 3)
})

test('RuntimeAccessService blocks k8s reserve when cloud_computer toggle is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [
        planRow({
            id: 'free',
            maxAlwaysOnlineRuntimes: 5,
            maxAlwaysOnlineAgents: 5
        })
    ]
    db.users.push(
        userRow({
            planId: 'free',
            alwaysOnlineRuntimeBonus: 5
        })
    )
    const service = makeService(db, { cloudComputerEnabled: false })

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({
                    id: 'runtime-k8s',
                    kind: 'k8s',
                    status: 'pending'
                })
            ),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'CLOUD_COMPUTER_DISABLED'
    )
})

test('RuntimeAccessService allows k8s reserve without a per-user grant when toggle is on', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [
        planRow({
            id: 'free',
            maxAlwaysOnlineRuntimes: 5,
            maxAlwaysOnlineAgents: 5
        })
    ]
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, { cloudComputerEnabled: true })

    const runtime = await service.reserveRuntime(
        runtimeRow({ id: 'runtime-k8s', kind: 'k8s', status: 'pending' })
    )

    assert.equal(runtime.id, 'runtime-k8s')
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
    db.hostRows.push(hostRow({ id: 'sbx-empty' }))
    const service = makeService(db)

    const summary = await service.summary('user-1')

    assert.equal(summary.statefulSandboxUsage, 1)
    assert.equal(summary.statefulSandboxRemaining, 0)
})

test('RuntimeAccessService.reserveActiveSlot rejects when per-user limit reached', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    // free.maxConcurrentActive = 1; one running sandbox already occupies it
    db.hostRows.push(hostRow({ id: 'host-existing', spriteStatus: 'running' }))
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
    // permissive per-user plan so we exercise the org-wide check
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 1000 })]
    db.users.push(userRow({ planId: 'free' }))
    for (let i = 0; i < 5; i += 1)
        db.hostRows.push(
            hostRow({
                id: `host-${i}`,
                userId: `u-${i}`,
                spriteStatus: 'running'
            })
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
    // 4 running sprites, soft threshold = 80% of 10 = 8 → not yet
    // Use cap=4, softThresholdPct=50 → softCap=2. 4 >= 2 triggers soft warning,
    // but 4 < 4 is not triggered for hard cap (need >= 4). Actually 4 >= 4 IS hard.
    // Recompute: cap=10, soft=50% → softCap=5. Push 5 agents → 5 >= 5 soft fires;
    // 5 < 10 so hard ok.
    for (let i = 0; i < 5; i += 1)
        db.hostRows.push(
            hostRow({
                id: `host-${i}`,
                userId: `u-${i}`,
                spriteStatus: 'running'
            })
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
    db.hostRows.push(hostRow({ id: 'h-shared', spriteStatus: 'running' }))
    const service = makeService(db)

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'h-new'
    })

    assert.equal(result.activeCount, 1)
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
        hostRow({ id: 'h-other', spriteStatus: 'running' }),
        hostRow({
            id: 'h-mine',
            spriteStatus: 'running',
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
    db.hostRows.push(hostRow({ id: 'h-mine', spriteStatus: 'running' }))
    await assert.rejects(() =>
        service.reserveActiveSlot({ userId: 'user-1', hostId: 'h-mine' })
    )
})

test('RuntimeAccessService.enableKeepAlive counts enabled-but-cold runtimes as committed capacity', async () => {
    // WHY: enabling is committed capacity — counting only running sprites
    // (reserveActiveSlot reuse) would let two concurrent enables on two COLD
    // sprites both pass with one slot left, oversubscribing the plan.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    // free.maxConcurrentActive = 1; both sprites are COLD (no running agents)
    db.runtimeRows.push(
        runtimeRow({ id: 'rt-cold-1', kind: 'sprites', status: 'ready' }),
        runtimeRow({ id: 'rt-cold-2', kind: 'sprites', status: 'ready' })
    )
    const service = makeService(db)

    await service.enableKeepAlive({
        userId: 'user-1',
        runtimeId: 'rt-cold-1',
        hostId: 'rt-cold-1'
    })

    assert.equal(
        db.runtimeRows.find((row) => row.id === 'rt-cold-1')?.keepAliveEnabled,
        true,
        'first enable commits the column'
    )
    assert.deepEqual(
        db.lockNamespaces,
        ['2'],
        'enable must hold the SAME ns-2 advisory lock as reserveActiveSlot so enables serialize against chat/terminal admissions'
    )

    await assert.rejects(
        () =>
            service.enableKeepAlive({
                userId: 'user-1',
                runtimeId: 'rt-cold-2',
                hostId: 'rt-cold-2'
            }),
        (err) => {
            assert.ok(err instanceof ForbiddenException)
            const body = (err as ForbiddenException).getResponse() as {
                code?: string
                current?: number
                limit?: number
                planName?: string
            }
            assert.equal(body.code, 'CONCURRENT_ACTIVE_LIMIT_REACHED')
            assert.equal(
                body.current,
                1,
                'the cold enabled runtime occupies the slot'
            )
            assert.equal(body.limit, 1)
            assert.equal(body.planName, 'Free')
            return true
        }
    )
    assert.equal(
        db.runtimeRows.find((row) => row.id === 'rt-cold-2')?.keepAliveEnabled,
        false
    )
})

test('RuntimeAccessService.enableKeepAlive excludes the target runtime from both union branches', async () => {
    // WHY: enabling an in-use sprite must not double-charge its own slot —
    // the target is excluded from both the running-agents branch and the
    // enabled-column branch of the committed-capacity union.
    const db = new FakeRuntimeAccessDb()
    // free.maxConcurrentActive = 1; the target itself occupies that slot,
    // both as a running sandbox and as an already-enabled runtime
    db.users.push(userRow({ planId: 'free' }))
    db.runtimeRows.push(
        runtimeRow({
            id: 'rt-target',
            kind: 'sprites',
            status: 'ready',
            keepAliveEnabled: true
        })
    )
    db.agents.push(
        agentRow({ id: 'a1', runtimeId: 'rt-target', spriteStatus: 'running' })
    )
    const service = makeService(db)

    await service.enableKeepAlive({
        userId: 'user-1',
        runtimeId: 'rt-target',
        hostId: 'rt-target'
    })

    assert.equal(db.runtimeRows[0].keepAliveEnabled, true)
})

test('RuntimeAccessService.enableKeepAlive meters committed capacity per host, not per runtime', async () => {
    // WHY: co-residence puts several runtimes on one sandbox VM. Committed
    // capacity must count distinct hosts — two runtimes sharing a host are one
    // slot — otherwise a user is wrongly blocked at the concurrent cap.
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 2 })]
    db.users.push(userRow({ planId: 'free' }))
    // host h1 carries two runtimes: one running, one keep-alive-enabled
    db.runtimeRows.push(
        runtimeRow({
            id: 'rt-a',
            kind: 'sprites',
            status: 'ready',
            hostId: 'h1'
        }),
        runtimeRow({
            id: 'rt-b',
            kind: 'sprites',
            status: 'ready',
            keepAliveEnabled: true,
            hostId: 'h1'
        }),
        runtimeRow({
            id: 'rt-c',
            kind: 'sprites',
            status: 'ready',
            hostId: 'h2'
        })
    )
    db.hostRows.push(hostRow({ id: 'h1', spriteStatus: 'running' }))
    const service = makeService(db)

    // Enabling rt-c (target host h2) sees committed = {h1} = 1 < cap 2.
    // Per-runtime counting would see {rt-a, rt-b} = 2 and wrongly reject.
    await service.enableKeepAlive({
        userId: 'user-1',
        runtimeId: 'rt-c',
        hostId: 'h2'
    })

    assert.equal(
        db.runtimeRows.find((r) => r.id === 'rt-c')?.keepAliveEnabled,
        true
    )
})

test('RuntimeAccessService.enableKeepAlive leaves the column false when the cap check throws', async () => {
    // WHY: admission and commitment are atomic — a half-committed enable
    // would let the reconcile ensure pass wake an unadmitted sprite.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'rt-cold', kind: 'sprites', status: 'ready' })
    )
    // a DIFFERENT running sandbox occupies the only slot
    db.hostRows.push(hostRow({ id: 'host-running', spriteStatus: 'running' }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.enableKeepAlive({
                userId: 'user-1',
                runtimeId: 'rt-cold',
                hostId: 'rt-cold'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'CONCURRENT_ACTIVE_LIMIT_REACHED'
    )

    assert.equal(
        db.runtimeUpdates.length,
        0,
        'no UPDATE may be issued when admission fails'
    )
    assert.equal(db.runtimeRows[0].keepAliveEnabled, false)
})

test('RuntimeAccessService.enableKeepAlive 503s when the org-wide hard cap is reached', async () => {
    // WHY: an always-on sprite is exactly what the wholesale gate exists to
    // bound — platform protection applies even when the user has plan room.
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxConcurrentActive: 1000 })]
    db.users.push(userRow({ planId: 'free' }))
    db.runtimeRows.push(
        runtimeRow({ id: 'rt-cold', kind: 'sprites', status: 'ready' })
    )
    // other users' running sprites fill the platform cap
    for (let i = 0; i < 5; i += 1)
        db.hostRows.push(
            hostRow({
                id: `host-${i}`,
                userId: `u-${i}`,
                spriteStatus: 'running'
            })
        )
    const service = makeService(db, {
        wholesaleCap: { activeCap: 5, softThresholdPct: 80 }
    })

    await assert.rejects(
        () =>
            service.enableKeepAlive({
                userId: 'user-1',
                runtimeId: 'rt-cold',
                hostId: 'rt-cold'
            }),
        (err) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code ===
                'WHOLESALE_CAPACITY_REACHED'
    )
    assert.equal(
        db.runtimeRows[0].keepAliveEnabled,
        false,
        'hard-cap rejection must not commit the flag'
    )
})

test('RuntimeAccessService.reserveSpriteRuntime attaches to an existing sandbox and clears emptied_at', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({
            id: 'sbx-1',
            accountId: 'acct-1',
            spriteId: 'sprite-1',
            emptiedAt: now
        })
    )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'codex',
        accountId: 'acct-1',
        hostId: 'sbx-1',
        mountPath: '/home/sprite'
    })

    assert.equal(hostCreated, false)
    assert.equal(runtime.hostId, 'sbx-1')
    assert.equal(runtime.spriteName, 'sbx-1')
    assert.equal(runtime.spriteId, 'sprite-1')
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
    db.hostRows.push(
        hostRow({ id: 'sbx-1', accountId: 'acct-1', spriteId: 'sprite-1' })
    )
    db.runtimeRows.push(
        runtimeRow({
            id: 'art-a',
            kind: 'sprites',
            status: 'ready',
            hostId: 'sbx-1'
        })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSpriteRuntime({
                id: 'art-new',
                userId: 'user-1',
                framework: 'codex',
                accountId: 'acct-1',
                hostId: 'sbx-1',
                mountPath: '/home/sprite'
            }),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_FRAMEWORK_EXISTS'
    )
})

// No capacity ceiling: a sandbox holds one instance per framework, so the only
// bound is the framework count. Four co-resident runtimes used to be the limit.
test('RuntimeAccessService.reserveSpriteRuntime attaches past the old four-runtime capacity ceiling', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({ id: 'sbx-1', accountId: 'acct-1', spriteId: 'sprite-1' })
    )
    for (const framework of [
        'claude-code',
        'codex',
        'openclaw',
        'narranexus'
    ] as const)
        db.runtimeRows.push(
            runtimeRow({
                id: `art-${framework}`,
                kind: 'sprites',
                status: 'ready',
                hostId: 'sbx-1',
                framework
            })
        )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'gemini-cli',
        accountId: 'acct-1',
        hostId: 'sbx-1',
        mountPath: '/home/sprite'
    })

    assert.equal(hostCreated, false, 'attach must not spill onto a new VM')
    assert.equal(runtime.hostId, 'sbx-1')
})

test('RuntimeAccessService.reserveSpriteRuntime rejects attach to a missing or foreign sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({
            id: 'sbx-1',
            userId: 'other',
            accountId: 'acct-1',
            spriteId: 'sprite-1'
        })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSpriteRuntime({
                id: 'art-new',
                userId: 'user-1',
                framework: 'codex',
                accountId: 'acct-1',
                hostId: 'sbx-1',
                mountPath: '/home/sprite'
            }),
        (err) =>
            err instanceof NotFoundException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_NOT_FOUND'
    )
})

// A service framework needs the sprite's single public port, but coding
// frameworks don't use it at all — so a sandbox running only coding agents can
// still take one.
test('RuntimeAccessService.reserveSpriteRuntime attaches a service framework to a coding-only sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({ id: 'sbx-1', accountId: 'acct-1', spriteId: 'sprite-1' })
    )
    db.runtimeRows.push(
        runtimeRow({
            id: 'art-a',
            kind: 'sprites',
            status: 'ready',
            hostId: 'sbx-1',
            framework: 'claude-code'
        })
    )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'hermes',
        accountId: 'acct-1',
        hostId: 'sbx-1',
        mountPath: '/home/sprite'
    })

    assert.equal(hostCreated, false)
    assert.equal(runtime.hostId, 'sbx-1')
    assert.equal(runtime.framework, 'hermes')
})

// Two service frameworks on one sprite would both claim `http_port`, which the
// platform rejects outright — so the second one is refused up front, before any
// VM work, rather than failing deep inside bootstrap.
test('RuntimeAccessService.reserveSpriteRuntime refuses a second service framework on one sandbox', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({ id: 'sbx-1', accountId: 'acct-1', spriteId: 'sprite-1' })
    )
    db.runtimeRows.push(
        runtimeRow({
            id: 'art-a',
            kind: 'sprites',
            status: 'ready',
            hostId: 'sbx-1',
            framework: 'openclaw'
        })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSpriteRuntime({
                id: 'art-new',
                userId: 'user-1',
                framework: 'hermes',
                accountId: 'acct-1',
                hostId: 'sbx-1',
                mountPath: '/home/sprite'
            }),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string; existingFramework?: string })
                .code === 'SANDBOX_SERVICE_SLOT_TAKEN' &&
            (err.getResponse() as { existingFramework?: string })
                .existingFramework === 'openclaw'
    )
})

// Placement is explicit: without a hostId the reservation always builds a fresh
// VM. It must never quietly land on an existing sandbox — the user is told a new
// sandbox is being created, and it costs a provisioned slot.
test('RuntimeAccessService.reserveSpriteRuntime always creates a host when no sandbox is named', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow())
    db.hostRows.push(
        hostRow({
            id: 'sbx-1',
            name: 'sandbox-001',
            accountId: 'acct-1',
            spriteId: 'sprite-1'
        })
    )
    db.runtimeRows.push(
        runtimeRow({
            id: 'art-a',
            kind: 'sprites',
            status: 'ready',
            hostId: 'sbx-1',
            framework: 'claude-code'
        })
    )
    const service = makeService(db)

    const { runtime, hostCreated } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'codex',
        accountId: 'acct-1',
        mountPath: '/home/sprite'
    })

    assert.equal(hostCreated, true)
    assert.notEqual(
        runtime.hostId,
        'sbx-1',
        'an idle sandbox with room must not absorb the create'
    )
})

test('RuntimeAccessService.reserveStandaloneSandbox creates an empty sandbox under quota', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 1 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 1 }))
    const service = makeService(db)

    const host = await service.reserveStandaloneSandbox({
        userId: 'user-1',
        name: 'Research Sandbox',
        accountId: 'acct-1'
    })

    assert.match(host.id, /^sbx_[a-z2-7]{26}$/)
    assert.equal(host.userId, 'user-1')
    assert.equal(host.kind, 'sandbox')
    assert.equal(host.name, 'Research Sandbox')
    assert.equal(host.accountId, 'acct-1')
    assert.equal(host.status, 'active')
    assert.ok(host.emptiedAt instanceof Date)
    assert.deepEqual(
        db.lockNamespaces,
        ['0'],
        'standalone sandbox admission must serialize with agent runtime admission'
    )
})

test('RuntimeAccessService.reserveStandaloneSandbox rejects when active sandbox hosts fill quota', async () => {
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
                accountId: 'acct-1'
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
        () =>
            service.reserveSpriteRuntime({
                id: 'art-new',
                userId: 'user-1',
                framework: 'codex',
                accountId: 'acct-1',
                mountPath: '/home/sprite'
            }),
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

    const { runtime, hostCreated } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'codex',
        accountId: 'acct-1',
        mountPath: '/home/sprite'
    })

    assert.equal(hostCreated, true)
    assert.equal(runtime.name, 'sandbox-001-codex')
    const host = db.hostRows.find((h) => h.id === runtime.hostId)
    assert.equal(host?.name, 'sandbox-001')
})

test('RuntimeAccessService.reserveSpriteRuntime continues the sandbox sequence from the max existing', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 5 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 5 }))
    db.hostRows.push({ ...hostRow({ id: 'sbx-old' }), name: 'sandbox-007' })
    const service = makeService(db)

    const { runtime } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'codex',
        accountId: 'acct-1',
        mountPath: '/home/sprite'
    })

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
    db.hostRows.push({
        ...hostRow({ id: 'h1', accountId: 'acct-1', spriteId: 'sprite-1' }),
        name: 'dup'
    })
    db.hostRows.push({ ...hostRow({ id: 'h2' }), name: 'dup' })
    db.runtimeRows.push(
        runtimeRow({
            id: 'art-existing',
            kind: 'sprites',
            status: 'ready',
            hostId: 'h2'
        })
    )
    db.runtimeRows[0].name = 'dup-codex'
    const service = makeService(db)

    const { runtime } = await service.reserveSpriteRuntime({
        id: 'art-new',
        userId: 'user-1',
        framework: 'codex',
        accountId: 'acct-1',
        hostId: 'h1',
        mountPath: '/home/sprite'
    })

    assert.equal(runtime.name, 'dup-codex-2')
})

test('RuntimeAccessService.reserveStandaloneSandbox auto-names sandbox-NNN when no name is given', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 5 })]
    db.users.push(userRow({ planId: 'free', statefulSandboxLimit: 5 }))
    db.hostRows.push({ ...hostRow({ id: 'sbx-old' }), name: 'sandbox-003' })
    const service = makeService(db)

    const host = await service.reserveStandaloneSandbox({
        userId: 'user-1',
        accountId: 'acct-1'
    })

    assert.equal(host.name, 'sandbox-004')
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
    // free.maxConcurrentActive = 1 is also full — hours must win: stopping
    // another sandbox would not unblock an over-quota user.
    db.hostRows.push(hostRow({ id: 'host-existing', spriteStatus: 'running' }))
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

test('RuntimeAccessService.reserveActiveSlot fast path still skips the hours check on a running host', async () => {
    // Pins the documented trade-off: consecutive turns on an already-running
    // VM are not re-checked; the enforcement sweep force-sleeps the host and
    // the next cold admission re-checks everything.
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({
            id: 'host-running',
            spriteStatus: 'running',
            activeAccrualSince: now
        })
    )
    const service = makeService(db, { activeSeconds: 100 * 3600 })

    const result = await service.reserveActiveSlot({
        userId: 'user-1',
        hostId: 'host-running'
    })

    assert.equal(result.fastPath, true)
})

test('RuntimeAccessService.enableKeepAlive rejects when included active hours are exhausted', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.runtimeRows.push(
        runtimeRow({
            id: 'rt-1',
            kind: 'sprites',
            status: 'ready',
            hostId: 'h-1'
        })
    )
    const service = makeService(db, { activeSeconds: 5 * 3600 })

    await assert.rejects(
        () =>
            service.enableKeepAlive({
                userId: 'user-1',
                runtimeId: 'rt-1',
                hostId: 'h-1'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'ACTIVE_HOURS_QUOTA_REACHED'
    )
    assert.equal(
        db.runtimeRows[0].keepAliveEnabled,
        false,
        'flag stays off when the hours check throws'
    )
})

test('RuntimeAccessService.isActiveHoursExhausted mirrors the assert without throwing', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))

    assert.equal(
        await makeService(db, {
            activeSeconds: 5 * 3600
        }).isActiveHoursExhausted('user-1'),
        true
    )
    assert.equal(
        await makeService(db, { activeSeconds: 3600 }).isActiveHoursExhausted(
            'user-1'
        ),
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

test('RuntimeAccessService.evaluateQuotaThresholds warns active_hours at 80% and stamps the dedup map', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    const service = makeService(db, { activeSeconds: 4 * 3600 })

    const due = await service.evaluateQuotaThresholds('user-1')

    const hours = due.find((d) => d.code === 'active_hours')
    assert.ok(hours, 'active_hours should be due at 80% of 5h')
    assert.equal(hours?.usage, 4)
    assert.equal(hours?.limit, 5)
    assert.ok(
        (db.users[0].lastQuotaWarningsAt as Record<string, string>).active_hours
    )
})

test('RuntimeAccessService.evaluateQuotaThresholds dedups active_hours within 24h and re-emits after', async () => {
    const db = new FakeRuntimeAccessDb()
    // The production select aliases lastQuotaWarningsAt to `last`; the fake
    // returns raw rows, so seed the alias key directly.
    db.users.push(
        userRow({
            planId: 'free',
            last: {
                active_hours: new Date(
                    Date.now() - 60 * 60 * 1000
                ).toISOString()
            }
        })
    )
    const service = makeService(db, { activeSeconds: 4 * 3600 })

    const fresh = await service.evaluateQuotaThresholds('user-1')
    assert.equal(
        fresh.find((d) => d.code === 'active_hours'),
        undefined,
        'warned an hour ago — deduped'
    )

    db.users[0].last = {
        active_hours: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    }
    const stale = await service.evaluateQuotaThresholds('user-1')
    assert.ok(
        stale.find((d) => d.code === 'active_hours'),
        'a 25h-old stamp is past the 24h dedup window'
    )
})

// --- storage hard limit (STORAGE_LIMIT_REACHED) ---

test('RuntimeAccessService.reserveStandaloneSandbox rejects when storage is at the plan limit', async () => {
    const db = new FakeRuntimeAccessDb()
    // free.maxStorageGb = 3 (decimal GB); metered per sandbox host
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-full', storageBytes: 3_000_000_000 }))
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveStandaloneSandbox({
                userId: 'user-1',
                accountId: 'acct-1'
            }),
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

    const host = await service.reserveStandaloneSandbox({
        userId: 'user-1',
        accountId: 'acct-1'
    })

    assert.ok(host.id)
})

test('RuntimeAccessService.reserveStandaloneSandbox skips the storage check when the toggle is off', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(hostRow({ id: 'sbx-over', storageBytes: 9_000_000_000 }))
    const service = makeService(db, {
        featureEnabled: { storage_hard_limit: false }
    })

    const host = await service.reserveStandaloneSandbox({
        userId: 'user-1',
        accountId: 'acct-1'
    })

    assert.ok(host.id)
})

test('RuntimeAccessService.reserveSpriteRuntime rejects fresh provisioning when storage is exhausted', async () => {
    const db = new FakeRuntimeAccessDb()
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'sbx-exhausted', storageBytes: 4_000_000_000 })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSpriteRuntime({
                id: 'art-new',
                userId: 'user-1',
                framework: 'codex',
                accountId: 'acct-1',
                mountPath: '/home/sprite'
            }),
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
    db.hostRows.push(
        hostRow({
            id: 'sbx-1',
            accountId: 'acct-1',
            spriteId: 'sprite-1',
            storageBytes: 4_000_000_000
        })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveSpriteRuntime({
                id: 'art-new',
                userId: 'user-1',
                framework: 'codex',
                accountId: 'acct-1',
                hostId: 'sbx-1',
                mountPath: '/home/sprite'
            }),
        (err) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'STORAGE_LIMIT_REACHED'
    )
})

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

const agentRow = (
    overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => {
    const base = {
        id: 'agent-1',
        userId: 'user-1',
        runtimeId: 'runtime-1',
        runtime: 'sprites',
        spriteStatus: 'running',
        framework: 'codex',
        ...overrides
    }
    // hostId defaults to runtimeId (1 VM : 1 runtime) unless a test shares a host
    return {
        ...base,
        hostId:
            typeof overrides.hostId === 'string'
                ? overrides.hostId
                : base.runtimeId
    }
}

// A sandbox host row — the source of truth for running-concurrency counting.
const hostRow = (overrides: {
    id: string
    kind?: 'daemon' | 'sandbox'
    name?: string
    userId?: string
    accountId?: string | null
    spriteId?: string | null
    spriteStatus?: 'cold' | 'warm' | 'running' | null
    status?: 'active' | 'offline' | 'revoked'
    emptiedAt?: Date | null
    activeAccrualSince?: Date | null
    storageBytes?: number | null
}): Record<string, unknown> => ({
    id: overrides.id,
    userId: overrides.userId ?? 'user-1',
    kind: overrides.kind ?? 'sandbox',
    name: overrides.name ?? overrides.id,
    status: overrides.status ?? 'active',
    spriteStatus: overrides.spriteStatus ?? null,
    activeAccrualSince: overrides.activeAccrualSince ?? null,
    accountId: overrides.accountId ?? null,
    spriteId: overrides.spriteId ?? null,
    spriteName: overrides.id,
    emptiedAt: overrides.emptiedAt ?? null,
    storageBytes: overrides.storageBytes ?? null,
    createdAt: now,
    updatedAt: now
})

const runtimeRow = (overrides: {
    id: string
    kind: NewAgentRuntimeRow['kind']
    status: NewAgentRuntimeRow['status']
    framework?: NewAgentRuntimeRow['framework']
    keepAliveEnabled?: boolean
    hostId?: string
}): NewAgentRuntimeRow => ({
    userId: 'user-1',
    name: overrides.id,
    framework: overrides.framework ?? 'codex',
    accountId: null,
    clusterId: null,
    spriteName: null,
    spriteId: null,
    namespace: null,
    ingressHost: null,
    mountPath: '/workspace',
    currentPhase: null,
    failureReason: null,
    primaryAgentId: null,
    controlUiEnabled: true,
    dashboardEnabled: false,
    keepAliveEnabled: false,
    startedAt: null,
    lastBootstrappedAt: null,
    createdAt: now,
    updatedAt: now,
    hostId: overrides.hostId ?? overrides.id,
    ...overrides
})

// Raw sql`` templates keep interpolated scalars as primitive string chunks;
// eq() conditions wrap theirs in Param — collect both so the fake can apply
// the real query's userId/runtimeId arguments instead of canned filters.
const sqlTextOf = (query: unknown): string =>
    ((query as { queryChunks?: unknown[] })?.queryChunks ?? [])
        .map((chunk) =>
            chunk instanceof StringChunk ? chunk.value.join('') : ''
        )
        .join('')

const sqlParamsOf = (query: unknown): unknown[] => {
    const params: unknown[] = []
    const visit = (chunk: unknown): void => {
        if (chunk instanceof Param) params.push(chunk.value)
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

class FakeRuntimeAccessDb {
    users: Record<string, unknown>[] = []
    runtimeRows: NewAgentRuntimeRow[] = []
    auditRows: Record<string, unknown>[] = []
    plans: Record<string, unknown>[] = [planRow()]
    agents: Record<string, unknown>[] = []
    hostRows: Record<string, unknown>[] = []
    channelRows: Record<string, unknown>[] = []
    automationRows: Record<string, unknown>[] = []
    automationRunRows: Record<string, unknown>[] = []
    apiUsageDayRows: Record<string, unknown>[] = []
    runtimeUpdates: Record<string, unknown>[] = []
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
            // userId, accountId. The service-framework list is read back out of
            // the params rather than restated here, so if production stops
            // passing it the service-slot tests fail instead of the fake
            // silently supplying its own list.
            const params = sqlParamsOf(query) as string[]
            const framework = params[0]
            const serviceFrameworks = params.slice(2, -3)
            const [hostId, userId, accountId] = params.slice(-3)
            const host = this.hostRows.find(
                (h) =>
                    h.id === hostId &&
                    h.userId === userId &&
                    h.kind === 'sandbox' &&
                    h.status === 'active' &&
                    h.accountId === accountId &&
                    h.spriteId != null
            )
            if (!host) return []
            const live = this.runtimeRows.filter(
                (r) =>
                    r.hostId === hostId &&
                    r.status !== 'failed' &&
                    r.status !== 'stopped'
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
                    sprite_name: host.spriteName,
                    sprite_id: host.spriteId,
                    framework_present: frameworkPresent,
                    service_framework: serviceFramework
                }
            ]
        }
        if (text.includes('keep_alive_enabled')) {
            // committed-capacity union: running sandboxes UNION enabled
            // runtimes. The target exclusions are read from the real query
            // text so a dropped != predicate makes the exclusion tests fail
            // instead of being silently re-supplied by the fake.
            const [userId, hostId] = sqlParamsOf(query) as string[]
            // enableKeepAlive must always pass a hostId now — a missing one is a
            // test bug, not a no-op exclusion. Fail loud so it can't silently
            // weaken the host-grained admission contract.
            if (hostId === undefined)
                throw new Error(
                    'enableKeepAlive committed-capacity union called without hostId'
                )
            // Committed-capacity union dedupes + excludes the target host from
            // both arms (one sandbox VM = one host). Arm 1 (runtime_hosts) keys
            // on `id`, arm 2 (agent_runtimes) on `host_id`; detect each exclusion
            // independently so dropping either one trips the exclusion tests.
            const excludesRunning = / id != /.test(text)
            const excludesEnabled = /host_id != /.test(text)
            const running = this.hostRows
                .filter(
                    (row) =>
                        row.userId === userId &&
                        row.kind === 'sandbox' &&
                        row.spriteStatus === 'running' &&
                        !(excludesRunning && row.id === hostId)
                )
                .map((row) => row.id)
            const enabled = this.runtimeRows
                .filter(
                    (row) =>
                        row.userId === userId &&
                        row.kind === 'sprites' &&
                        row.keepAliveEnabled === true &&
                        !(excludesEnabled && row.hostId === hostId)
                )
                .map((row) => row.hostId)
            return [{ value: new Set([...running, ...enabled]).size }]
        }
        if (text.includes("'^sandbox-(")) {
            // nextSandboxName: MAX numeric suffix among this user's sandbox hosts.
            const [maxUserId] = sqlParamsOf(query) as string[]
            let max = 0
            for (const h of this.hostRows) {
                if (h.userId !== maxUserId || h.kind !== 'sandbox') continue
                const m = /^sandbox-(\d+)$/.exec(String(h.name))
                if (m) max = Math.max(max, Number(m[1]))
            }
            return [{ max }]
        }
        // Every legitimate raw query against runtime_hosts is handled above and
        // is keyed to one host. An unrecognized one means a host *search* was
        // reintroduced — implicit placement, which the explicit-placement
        // contract forbids. Returning [] here would let such a query silently
        // read as "no candidate found" and the placement tests would still pass.
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

    rowsFor(
        table: unknown,
        grouped: boolean,
        joined: boolean,
        condition?: unknown,
        limited = false,
        fields?: Record<string, unknown>
    ): Record<string, unknown>[] {
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
        if (table === agents) {
            const params = sqlParamsOf(condition)
            if (params.includes('failed')) {
                // storage sum: SUM(storage_bytes) over non-failed sprites agents
                const total = this.agents
                    .filter(
                        (row) =>
                            row.runtime === 'sprites' && row.status !== 'failed'
                    )
                    .reduce(
                        (acc, row) => acc + Number(row.storageBytes ?? 0),
                        0
                    )
                return [{ value: total }]
            }
            const running = this.agents.filter(
                (row) =>
                    row.runtime === 'sprites' && row.spriteStatus === 'running'
            )
            // metered per sandbox VM (host), not per runtime: co-resident
            // frameworks on one VM count once
            const distinctHosts = new Set(running.map((row) => row.hostId))
            return [{ value: distinctHosts.size }]
        }
        if (table === runtimeHosts) {
            const params = sqlParamsOf(condition)
            let rows = this.hostRows
            if (params.includes('sandbox'))
                rows = rows.filter((row) => row.kind === 'sandbox')
            if (params.includes('daemon'))
                rows = rows.filter((row) => row.kind === 'daemon')
            if (params.includes('active'))
                rows = rows.filter((row) => row.status === 'active')
            if (params.includes('running'))
                rows = rows.filter((row) => row.spriteStatus === 'running')
            const userId = params.find(
                (value): value is string =>
                    typeof value === 'string' && value.startsWith('user-')
            )
            if (userId) rows = rows.filter((row) => row.userId === userId)
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
            if (limited) {
                // reserveActiveSlot's fast-path pre-read: single row by id.
                const idParam = params.find(
                    (value): value is string =>
                        typeof value === 'string' &&
                        this.hostRows.some((row) => row.id === value)
                )
                return rows.filter((row) => row.id === idParam).slice(0, 1)
            }
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
        if (grouped) return this.groupedRuntimeUsage()
        const kind = this.runtimeRows.find(
            (row) => row.status !== 'failed'
        )?.kind
        return [
            {
                value: this.runtimeRows.filter(
                    (row) => row.status !== 'failed' && row.kind === kind
                ).length
            }
        ]
    }

    insertRow(table: unknown, values: Record<string, unknown>): unknown[] {
        if (table === agentRuntimes) {
            const row = { ...values, createdAt: now, updatedAt: now }
            // FakeQuery receives Drizzle inserts through a generic record
            // boundary; this branch is selected only for agentRuntimes.
            this.runtimeRows.push(row as NewAgentRuntimeRow)
            return [row]
        }
        if (table === auditLogs) {
            this.auditRows.push(values)
        }
        if (table === runtimeHosts) {
            const row = {
                spriteId: null,
                spriteStatus: null,
                terminalEnabled: false,
                detectedFrameworks: null,
                createdAt: now,
                updatedAt: now,
                ...values
            }
            this.hostRows.push(row)
            return [row]
        }
        return []
    }

    updateRows(
        table: unknown,
        patch: Record<string, unknown>,
        condition?: unknown
    ): Record<string, unknown>[] {
        if (table === agentRuntimes) {
            this.runtimeUpdates.push(patch)
            const ids = sqlParamsOf(condition)
            const updated = this.runtimeRows.filter((row) =>
                ids.includes(row.id)
            )
            for (const row of updated) Object.assign(row, patch)
            return updated
        }
        if (table === runtimeHosts) {
            const ids = sqlParamsOf(condition)
            const updated = this.hostRows.filter((row) => ids.includes(row.id))
            for (const row of updated) Object.assign(row, patch)
            return updated
        }
        if (table !== users) return []
        const user = this.users[0]
        if (!user) return []
        Object.assign(user, patch)
        return [user]
    }

    private groupedRuntimeUsage(): Record<string, unknown>[] {
        const counts = new Map<string, number>()
        for (const row of this.runtimeRows) {
            if (row.status === 'failed') continue
            const key = `${row.userId}:${row.kind}`
            counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        return Array.from(counts, ([key, value]) => {
            const [userId, kind] = key.split(':')
            return { userId, kind, value }
        })
    }

    private groupedHostUsage(
        rows: Record<string, unknown>[]
    ): Record<string, unknown>[] {
        const counts = new Map<string, number>()
        for (const row of rows) {
            const userId = String(row.userId)
            counts.set(userId, (counts.get(userId) ?? 0) + 1)
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

    values(values: Record<string, unknown>): this {
        this.rowValues = values
        return this
    }

    set(patch: Record<string, unknown>): this {
        this.rowValues = patch
        return this
    }

    returning(): Promise<unknown[]> {
        if (this.kind === 'insert')
            return Promise.resolve(
                this.db.insertRow(this.table, this.rowValues)
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
            return this.db.insertRow(this.table, this.rowValues)
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
    assert.ok(
        1 / 2 < 0.9,
        'guard: a ratio-only trigger would not have fired here'
    )
})

test('RuntimeAccessService.evaluateQuotaThresholds stays quiet on channels with room left', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'pro', maxChannels: 100 })]
    db.users.push(userRow({ planId: 'pro' }))
    for (let i = 0; i < 50; i += 1) db.channelRows.push({ id: `chn-${i}` })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(
        due.find((d) => d.code === 'channels'),
        undefined
    )
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

    assert.equal(
        due.find((d) => d.code === 'automations'),
        undefined,
        'deleted automations must not consume plan slots'
    )
})

test('RuntimeAccessService.evaluateQuotaThresholds warns on automation runs at 80%', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAutomationRunsMonthly: 30 })]
    db.users.push(userRow({ planId: 'free' }))
    for (let i = 0; i < 24; i += 1)
        db.automationRunRows.push({ id: `run-${i}` })
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
        planRow({
            id: 'pro',
            maxAutomationRunsMonthly: null,
            monthlyApiRequestLimit: null
        })
    ]
    db.users.push(userRow({ planId: 'pro' }))
    for (let i = 0; i < 9999; i += 1)
        db.automationRunRows.push({ id: `run-${i}` })
    db.apiUsageDayRows.push({ requestCount: 1_000_000 })
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(
        due.find((d) => d.code === 'automation_runs'),
        undefined
    )
    assert.equal(
        due.find((d) => d.code === 'api_requests'),
        undefined
    )
})

// Pins the deliberate inconsistency documented in evaluateQuotaThresholds:
// `provisioned` keeps its ratio-only trigger so this change did not move an
// existing banner's timing. If someone unifies the two triggers later, this
// test failing is the intended signal, not a surprise.
test('RuntimeAccessService.evaluateQuotaThresholds leaves provisioned on a ratio-only trigger', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'host-1', kind: 'sandbox', status: 'active' }),
        hostRow({ id: 'host-2', kind: 'sandbox', status: 'active' })
    )
    const service = makeService(db)

    const due = await service.evaluateQuotaThresholds('user-1')

    assert.equal(
        due.find((d) => d.code === 'provisioned'),
        undefined,
        '2 of 3 is 67% — below the 0.9 ratio, and headroom is not applied here'
    )
})

// --- external runtimes share the provisioned cap ---

// External runtimes had no branch in reserveRuntime at all, so they were
// unbounded on every plan. They now share plans.maxAgentsProvisioned with
// sandbox VMs, which is what that field is documented to mean.
test('RuntimeAccessService counts sandbox hosts against the external runtime cap', async () => {
    const db = new FakeRuntimeAccessDb()
    db.plans = [planRow({ id: 'free', maxAgentsProvisioned: 3 })]
    db.users.push(userRow({ planId: 'free' }))
    db.hostRows.push(
        hostRow({ id: 'host-1', kind: 'sandbox', status: 'active' }),
        hostRow({ id: 'host-2', kind: 'sandbox', status: 'active' })
    )
    db.runtimeRows.push(
        runtimeRow({ id: 'runtime-1', kind: 'external', status: 'ready' })
    )
    const service = makeService(db)

    await assert.rejects(
        () =>
            service.reserveRuntime(
                runtimeRow({
                    id: 'runtime-2',
                    kind: 'external',
                    status: 'pending'
                })
            ),
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
    db.hostRows.push(
        hostRow({ id: 'host-1', kind: 'sandbox', status: 'active' })
    )
    const service = makeService(db)

    const runtime = await service.reserveRuntime(
        runtimeRow({ id: 'runtime-1', kind: 'external', status: 'pending' })
    )

    assert.equal(runtime.id, 'runtime-1')
})
