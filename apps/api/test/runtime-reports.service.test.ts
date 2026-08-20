import test from 'node:test'
import assert from 'node:assert/strict'
import {
    ConflictException,
    HttpException,
    UnauthorizedException
} from '@nestjs/common'
import { RuntimeReportsService } from '../src/modules/runtime-reports/runtime-reports.service'
import { DaemonRateLimitService } from '../src/modules/daemon/daemon-rate-limit.service'
import type { CreateRuntimeReportDto } from '../src/modules/runtime-reports/dto/create-runtime-report.dto'

const TOKEN = 'a'.repeat(64)
const GENERATION = 'abcdef123456'
const IP = '203.0.113.7'

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    kind: 'sprites',
    framework: 'hermes',
    status: 'ready',
    serviceStatus: 'unknown',
    capabilitiesJson: { serviceReport: { generation: GENERATION } },
    ...over
})

const reportDto = (over: Record<string, unknown> = {}) =>
    ({
        runtimeId: 'rt-1',
        generation: GENERATION,
        event: 'ready',
        ...over
    }) as CreateRuntimeReportDto

const makeHarness = (
    opts: {
        runtime?: Record<string, unknown> | null
        credentialsRow?: boolean
    } = {}
) => {
    const runtime = opts.runtime === undefined ? fakeRuntime() : opts.runtime
    const hasCredentialsRow = opts.credentialsRow ?? true
    const dbWrites: string[] = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        hasCredentialsRow
                            ? [{ payloadCiphertext: 'ct', keyVersion: 1 }]
                            : []
                })
            })
        }),
        update: () => {
            dbWrites.push('update')
            return { set: () => ({ where: async () => undefined }) }
        },
        insert: () => {
            dbWrites.push('insert')
            return { values: async () => undefined }
        }
    }
    const crypto = {
        decrypt: () =>
            JSON.stringify({ gatewayToken: 'gw', runtimeReportToken: TOKEN })
    }
    const telemetryEvents: Array<{
        name: string
        data: Record<string, unknown>
    }> = []
    const telemetry = {
        event: (name: string, data: Record<string, unknown>) => {
            telemetryEvents.push({ name, data })
        }
    }
    const reportPatches: Array<{
        id: string
        patch: Record<string, unknown>
    }> = []
    const statusPatches: Array<{
        id: string
        patch: Record<string, unknown>
    }> = []
    const runtimes = {
        findById: async (id: string) =>
            runtime && (runtime as { id: string }).id === id ? runtime : null,
        applyServiceReportPatch: async (
            id: string,
            patch: Record<string, unknown>
        ) => {
            reportPatches.push({ id, patch })
        },
        applyStatusPatch: async (
            id: string,
            patch: Record<string, unknown>
        ) => {
            statusPatches.push({ id, patch })
        }
    }
    const touches: Array<{ runtime: unknown; opts: unknown }> = []
    const reconcile = {
        touchRuntime: (rt: unknown, o: unknown) => {
            touches.push({ runtime: rt, opts: o })
        }
    }
    const svc = new RuntimeReportsService(
        db as never,
        crypto as never,
        telemetry as never,
        runtimes as never,
        reconcile as never,
        new DaemonRateLimitService()
    )
    return {
        svc,
        runtime,
        telemetryEvents,
        reportPatches,
        statusPatches,
        touches,
        dbWrites
    }
}

// Encodes the hint-only threat model: a rejected report leaves the system
// byte-identical — no service patch, no provisioning-status patch, no direct
// table write, no reconcile touch.
const assertInert = (h: ReturnType<typeof makeHarness>, label: string) => {
    assert.equal(
        h.reportPatches.length,
        0,
        `${label}: rejected report must not write service status`
    )
    assert.equal(
        h.statusPatches.length,
        0,
        `${label}: applyStatusPatch must NEVER be reachable from a report — provisioning status is column-disjoint by construction`
    )
    assert.equal(
        h.touches.length,
        0,
        `${label}: rejected report must not touch reconcile`
    )
    assert.equal(
        h.dbWrites.length,
        0,
        `${label}: rejected report must not write any table directly (agents rows included)`
    )
}

// WHY: a late/replayed report from a previous boot must never mark a new
// boot ready — the fence is exact-match against the platform-written
// capabilitiesJson.serviceReport.generation, no grace window.
test('fence: generation mismatch 409s stale_generation with zero writes and runtime_report_stale telemetry', async () => {
    const h = makeHarness()
    await assert.rejects(
        () => h.svc.ingest(IP, TOKEN, reportDto({ generation: '0123456789ab' })),
        (err: unknown) => {
            assert.ok(
                err instanceof ConflictException,
                'stale generation must surface as 409, not 401: the token was valid, the boot was just superseded'
            )
            assert.equal((err as Error).message, 'stale_generation')
            return true
        }
    )
    assertInert(h, 'generation mismatch')
    assert.deepEqual(
        h.telemetryEvents.map((e) => e.name),
        ['runtime_report_stale'],
        'stale fence must emit runtime_report_stale and never runtime_report_accepted'
    )
})

// WHY: unfenced legacy runtimes are unverifiable by definition — a Phase 2
// runtime with keepAlive metadata but no serviceReport fence must reject even
// a generation that matches what is on its disk.
test('fence: missing serviceReport fence 409s even when the presented generation matches on-disk state', async () => {
    const legacy = makeHarness({
        runtime: fakeRuntime({
            capabilitiesJson: { keepAlive: { generation: GENERATION } }
        })
    })
    await assert.rejects(
        () => legacy.svc.ingest(IP, TOKEN, reportDto()),
        (err: unknown) => {
            assert.ok(err instanceof ConflictException)
            assert.equal((err as Error).message, 'stale_generation')
            return true
        }
    )
    assertInert(legacy, 'missing serviceReport fence')
    assert.deepEqual(
        legacy.telemetryEvents.map((e) => e.name),
        ['runtime_report_stale']
    )

    const nullCaps = makeHarness({
        runtime: fakeRuntime({ capabilitiesJson: null })
    })
    await assert.rejects(
        () => nullCaps.svc.ingest(IP, TOKEN, reportDto()),
        (err: unknown) => {
            assert.ok(err instanceof ConflictException)
            assert.equal((err as Error).message, 'stale_generation')
            return true
        }
    )
    assertInert(nullCaps, 'null capabilitiesJson')
})

// WHY: the disk-readable token is the only gate, so failures must be inert
// and leak no existence oracle; the scope guard keeps exec-kind/k8s/daemon
// runtimes untouched per the issue scope.
test('auth/scope: missing bearer, wrong token, missing credentials row, exec-kind, k8s/daemon kind, unknown runtime all 401 uniformly with zero writes', async () => {
    const cases: Array<{
        name: string
        h: ReturnType<typeof makeHarness>
        bearer: string | null
    }> = [
        { name: 'missing bearer', h: makeHarness(), bearer: null },
        { name: 'wrong token', h: makeHarness(), bearer: 'b'.repeat(64) },
        {
            name: 'missing credentials row',
            h: makeHarness({ credentialsRow: false }),
            bearer: TOKEN
        },
        {
            name: 'exec-kind framework (claude-code)',
            h: makeHarness({
                runtime: fakeRuntime({ framework: 'claude-code' })
            }),
            bearer: TOKEN
        },
        {
            name: 'k8s kind',
            h: makeHarness({ runtime: fakeRuntime({ kind: 'k8s' }) }),
            bearer: TOKEN
        },
        {
            name: 'daemon kind',
            h: makeHarness({ runtime: fakeRuntime({ kind: 'daemon' }) }),
            bearer: TOKEN
        },
        {
            name: 'unknown runtimeId',
            h: makeHarness({ runtime: null }),
            bearer: TOKEN
        }
    ]
    const messages = new Set<string>()
    for (const c of cases) {
        await assert.rejects(
            () => c.h.svc.ingest(IP, c.bearer, reportDto()),
            (err: unknown) => {
                assert.ok(
                    err instanceof UnauthorizedException,
                    `${c.name} must reject with 401`
                )
                messages.add((err as Error).message)
                return true
            }
        )
        assertInert(c.h, c.name)
        assert.equal(
            c.h.telemetryEvents.length,
            0,
            `${c.name}: auth failures emit no accept/stale telemetry`
        )
    }
    assert.equal(
        messages.size,
        1,
        'all 401 variants must carry one uniform message — distinct messages would hand user code an existence/scope oracle'
    )
})

// WHY: a curl-loop flood from user code on its own sprite must be bounded —
// 60/min fixed window keyed on the forwarded client IP the controller
// derives. This is only the pre-auth circuit breaker (the key is spoofable
// for rotation); per-runtime isolation is pinned by the post-auth test below.
test('rate limit: 61st request in a minute from one IP 429s; a different IP still gets through', async () => {
    const h = makeHarness()
    for (let i = 0; i < 60; i++) {
        await assert.rejects(
            () => h.svc.ingest(IP, null, reportDto()),
            (err: unknown) => err instanceof UnauthorizedException
        )
    }
    await assert.rejects(
        () => h.svc.ingest(IP, null, reportDto()),
        (err: unknown) => {
            assert.ok(err instanceof HttpException)
            assert.equal(
                (err as HttpException).getStatus(),
                429,
                'the 61st request within the window must be rate limited, not re-evaluated'
            )
            return true
        }
    )
    await assert.rejects(
        () => h.svc.ingest('198.51.100.9', null, reportDto()),
        (err: unknown) => {
            assert.ok(
                err instanceof UnauthorizedException,
                'another IP must reach the auth checks — the window is keyed per IP'
            )
            return true
        }
    )
    assertInert(h, 'rate limited flood')
})

// WHY: behind fly-proxy/shared sprite egress many reporters can collapse
// onto one derived client IP, so the per-IP window alone would let a single
// flooder starve every other runtime's boot reports; the per-runtime window
// restores isolation, and it is consumed only AFTER token verification so
// unauthenticated traffic cannot burn a victim runtime's budget.
test('per-runtime limit: 31st authenticated report for one runtime 429s; failed-auth floods never consume the runtime bucket', async () => {
    const h = makeHarness()
    for (let i = 0; i < 20; i++) {
        await assert.rejects(
            () =>
                h.svc.ingest(`203.0.113.${i}`, 'wrong-token', reportDto()),
            (err: unknown) => err instanceof UnauthorizedException
        )
    }
    for (let i = 0; i < 30; i++) {
        await h.svc.ingest(
            `198.51.100.${i}`,
            TOKEN,
            reportDto({ event: 'starting' })
        )
    }
    assert.equal(
        h.reportPatches.length,
        30,
        '30 authenticated reports must all land — if the 20 failed-auth requests above had consumed the runtime bucket, the cap would have tripped at the 11th'
    )
    await assert.rejects(
        () =>
            h.svc.ingest(
                '198.51.100.99',
                TOKEN,
                reportDto({ event: 'starting' })
            ),
        (err: unknown) => {
            assert.ok(err instanceof HttpException)
            assert.equal(
                (err as HttpException).getStatus(),
                429,
                'the 31st authenticated report in the window must hit the per-runtime cap even from a fresh IP'
            )
            return true
        }
    )
    assert.equal(
        h.reportPatches.length,
        30,
        'a rate-limited report must not write'
    )
    assert.equal(h.touches.length, 0, 'starting reports never touch reconcile')
})

// WHY: reconcileRuntime on a stopped runtime marks its agents stopped, so a
// report reaching the touch would violate "no report-driven path ever marks
// an agent or runtime stopped" — the guard must fire BEFORE any write or
// touch, even with a valid token and a valid fence.
test('stopped guard: runtime.status=stopped 409s runtime_stopped before any write or touch', async () => {
    const h = makeHarness({ runtime: fakeRuntime({ status: 'stopped' }) })
    await assert.rejects(
        () => h.svc.ingest(IP, TOKEN, reportDto({ event: 'ready' })),
        (err: unknown) => {
            assert.ok(err instanceof ConflictException)
            assert.equal(
                (err as Error).message,
                'runtime_stopped',
                'a stopped runtime must be named as such, not mistaken for a stale fence'
            )
            return true
        }
    )
    assertInert(h, 'runtime.status=stopped')
})

// WHY: serviceStatus='stopped' is the platform's downward assertion from
// runStopAndRelease; a straggler report from the dying boot must not
// resurrect it or touch reconcile.
test('stopped guard: serviceStatus=stopped 409s runtime_stopped before any write or touch', async () => {
    const h = makeHarness({
        runtime: fakeRuntime({ serviceStatus: 'stopped' })
    })
    await assert.rejects(
        () => h.svc.ingest(IP, TOKEN, reportDto({ event: 'ready' })),
        (err: unknown) => {
            assert.ok(err instanceof ConflictException)
            assert.equal((err as Error).message, 'runtime_stopped')
            return true
        }
    )
    assertInert(h, 'serviceStatus=stopped')
})

// WHY: a starting report proves nothing about the service being up, so it
// must not accelerate reconcile — only the two disjoint service columns move.
test('accepted starting: writes serviceStatus=starting with serviceStatusAt and does not touch reconcile', async () => {
    const h = makeHarness()
    await h.svc.ingest(IP, TOKEN, reportDto({ event: 'starting' }))
    assert.equal(h.reportPatches.length, 1)
    assert.equal(h.reportPatches[0].id, 'rt-1')
    assert.equal(h.reportPatches[0].patch.serviceStatus, 'starting')
    assert.ok(
        h.reportPatches[0].patch.serviceStatusAt instanceof Date,
        'every accepted report stamps the status-assertion timestamp'
    )
    assert.equal(
        h.touches.length,
        0,
        'starting must not trigger reconcile — only a health-probe-backed ready report may'
    )
    assert.deepEqual(
        h.telemetryEvents.map((e) => e.name),
        ['runtime_report_accepted']
    )
    assert.equal(
        h.statusPatches.length,
        0,
        'accepted reports write the service columns only — provisioning status stays report-unreachable'
    )
    assert.equal(
        h.dbWrites.length,
        0,
        'accepted reports go through applyServiceReportPatch, never direct table writes'
    )
})

// WHY: a fence-valid ready report proves the service is up post-boot, voiding
// the wake-billing and fresh-boot-race reasons for the sleeping-sprite skip —
// the touch carries verifiedByReport so reconcile bypasses ONLY that skip.
test('accepted ready: writes serviceStatus=ready and touches reconcile exactly once with verifiedByReport', async () => {
    const h = makeHarness()
    await h.svc.ingest(IP, TOKEN, reportDto({ event: 'ready' }))
    assert.equal(h.reportPatches.length, 1)
    assert.equal(h.reportPatches[0].patch.serviceStatus, 'ready')
    assert.ok(h.reportPatches[0].patch.serviceStatusAt instanceof Date)
    assert.equal(
        h.touches.length,
        1,
        'ready must touch reconcile exactly once — the heal accelerator'
    )
    assert.equal(
        h.touches[0].runtime,
        h.runtime,
        'reconcile must receive the loaded runtime row'
    )
    assert.deepEqual(
        h.touches[0].opts,
        { verifiedByReport: true },
        'the flag bypasses only the sleeping-sprite list-skip; the 15s min-wait/failure backoff still bound report floods'
    )
    assert.deepEqual(
        h.telemetryEvents.map((e) => e.name),
        ['runtime_report_accepted']
    )
    assert.equal(h.statusPatches.length, 0)
    assert.equal(h.dbWrites.length, 0)
})

// WHY: a warm/cold thaw re-execs start.sh — a real boot the platform cannot
// observe; keeping 'ready' through it would make the live probe surface
// 'stale' with misleading copy, so ready -> starting is accepted. The closed
// event map still cannot produce 'stopped' or 'unknown' from any input.
test('thaw restart: ready -> starting is accepted; the closed map cannot produce stopped', async () => {
    const h = makeHarness({ runtime: fakeRuntime({ serviceStatus: 'ready' }) })
    await h.svc.ingest(IP, TOKEN, reportDto({ event: 'starting' }))
    assert.equal(h.reportPatches.length, 1)
    assert.equal(
        h.reportPatches[0].patch.serviceStatus,
        'starting',
        'a thaw re-exec is a real boot: downgrading ready to starting surfaces waking instead of a misleading stale'
    )
    assert.equal(
        h.touches.length,
        0,
        'the downgrade itself must not trigger reconcile'
    )
    for (const p of h.reportPatches) {
        assert.ok(
            p.patch.serviceStatus === 'starting' ||
                p.patch.serviceStatus === 'ready',
            'the report event map is closed over starting/ready — stopped/unknown are structurally unreachable'
        )
    }
    assert.equal(h.statusPatches.length, 0)
    assert.equal(h.dbWrites.length, 0)
})
