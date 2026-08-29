import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    InternalServerErrorException
} from '@nestjs/common'
import { RuntimeDashboardService } from '../src/modules/agent-runtimes/orchestration/runtime-dashboard.service'

const runtime = (patch: Record<string, unknown> = {}) => ({
    id: 'runtime-1',
    userId: 'user-1',
    name: 'Hermes',
    framework: 'hermes',
    kind: 'k8s',
    status: 'ready',
    namespace: 'nca-user-1',
    clusterId: null,
    primaryAgentId: 'agent-1',
    ingressHost: 'agent-1.example.test',
    mountPath: '/home/node/.hermes',
    controlUiEnabled: false,
    dashboardEnabled: false,
    dashboardState: null,
    createdAt: new Date('2026-04-28T12:00:00.000Z'),
    updatedAt: new Date('2026-04-28T12:00:00.000Z'),
    ...patch
})

// ---------------------------------------------------------------------------
// getControlUiUrl (migrated from k8s-runtime-sidecar tests — the mint moved
// into the facade wholesale)
// ---------------------------------------------------------------------------

test('getControlUiUrl rejects unsupported framework with a clear message', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([runtime({ framework: 'claude-code' as never })]),
        db: dbFor({ audits })
    })
    await assert.rejects(
        () => service.getControlUiUrl('runtime-1', 'user-1', false),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            assert.match(
                (err as Error).message,
                /control UI URL not supported for this framework/
            )
            return true
        }
    )
    // No audit entry should be written when validation fails before mint.
    assert.deepEqual(audits, [])
})

test('getControlUiUrl rejects hermes runtime when dashboard disabled', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({ framework: 'hermes', dashboardEnabled: false })
        ]),
        db: dbFor({ audits })
    })
    await assert.rejects(
        () => service.getControlUiUrl('runtime-1', 'user-1', false),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            assert.match(
                (err as Error).message,
                /dashboard is disabled for this runtime/
            )
            return true
        }
    )
    assert.deepEqual(audits, [])
})

test('getControlUiUrl refuses the removed k8s hermes dashboard host without auditing a mint', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: 'hermes',
                kind: 'k8s',
                dashboardEnabled: true
            })
        ]),
        db: dbFor({ audits })
    })
    await assert.rejects(
        () => service.getControlUiUrl('runtime-1', 'user-1', false),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            assert.match((err as Error).message, /sprite-only/)
            return true
        }
    )
    // A refusal must not record a mint, and the removed `-dashboard` host
    // URL must never be handed out again.
    assert.deepEqual(audits, [])
})

test('getControlUiUrl mints sprite hermes URL with the dashboard token', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: 'hermes',
                kind: 'sprites',
                dashboardEnabled: true,
                ingressHost: 'sprite-1.sprites.app'
            })
        ]),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(
            JSON.stringify({ dashboardToken: 'dash-secret' })
        )
    })
    const { url } = await service.getControlUiUrl('runtime-1', 'user-1', false)
    assert.equal(url, 'https://sprite-1.sprites.app/?token=dash-secret')
    assert.equal(audits.length, 1)
})

test('getControlUiUrl sprite hermes without stored token fails loud', async () => {
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: 'hermes',
                kind: 'sprites',
                dashboardEnabled: true,
                ingressHost: 'sprite-1.sprites.app'
            })
        ]),
        db: dbFor({ audits: [], credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({}))
    })
    await assert.rejects(
        () => service.getControlUiUrl('runtime-1', 'user-1', false),
        (err: unknown) => {
            assert.ok(err instanceof InternalServerErrorException)
            assert.match((err as Error).message, /missing dashboardToken/)
            return true
        }
    )
})

test('getControlUiUrl rejects openclaw when control UI disabled', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({ framework: 'openclaw', controlUiEnabled: false })
        ]),
        db: dbFor({ audits })
    })
    await assert.rejects(
        () => service.getControlUiUrl('runtime-1', 'user-1', false),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            assert.match(
                (err as Error).message,
                /control UI is disabled for this runtime/
            )
            return true
        }
    )
    assert.deepEqual(audits, [])
})

test('getControlUiUrl builds openclaw URL with #token fragment', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({ framework: 'openclaw', controlUiEnabled: true })
        ]),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw-secret' }))
    })
    const { url } = await service.getControlUiUrl('runtime-1', 'user-1', false)
    assert.equal(url, 'https://agent-1.example.test/#token=gw-secret')
    const details = audits[0].meta as Record<string, unknown>
    assert.equal(details.agentId, null)
})

test('getControlUiUrl narranexus falls back to primaryAgentId for the URL and audit log', async () => {
    // B3 regression: previously agentId in audit was the caller-supplied
    // value (null here) while the URL embedded primaryAgentId — diverged.
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: 'narranexus',
                primaryAgentId: 'agent-1',
                userId: 'mf_owner'
            })
        ]),
        db: dbFor({
            audits,
            credsCiphertext: 'ENC1',
            agentInternalIdByAgentId: { 'agent-1': 'agent-internal-1' }
        }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw-secret' }))
    })
    const { url } = await service.getControlUiUrl(
        'runtime-1',
        'mf_owner',
        false
    )
    assert.match(url, /^https:\/\/agent-1\.example\.test\/#v=1&/)
    assert.match(url, /token=gw-secret/)
    assert.match(url, /user=mf_owner/)
    assert.match(url, /agent=agent-internal-1/)
    const details = audits[0].meta as Record<string, unknown>
    assert.equal(details.agentId, 'agent-1')
})

test('getControlUiUrl narranexus honors explicit agentId over primaryAgentId', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: 'narranexus',
                primaryAgentId: 'agent-1',
                userId: 'mf_owner'
            })
        ]),
        db: dbFor({
            audits,
            credsCiphertext: 'ENC1',
            agentInternalIdByAgentId: {
                'agent-1': 'agent-internal-1',
                'agent-2': 'agent-internal-2'
            }
        }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw-secret' }))
    })
    const { url } = await service.getControlUiUrl(
        'runtime-1',
        'mf_owner',
        false,
        'agent-2'
    )
    assert.match(url, /agent=agent-internal-2/)
    const details = audits[0].meta as Record<string, unknown>
    assert.equal(details.agentId, 'agent-2')
})

// ---------------------------------------------------------------------------
// kind dispatch + toggles
// ---------------------------------------------------------------------------

test('setControlUi delegates k8s runtimes to the k8s sidecar unchanged', async () => {
    const delegated: unknown[] = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({ framework: 'openclaw', kind: 'k8s' })
        ]),
        k8sSidecar: {
            setControlUi: async (...args: unknown[]) => {
                delegated.push(args)
                return { id: 'runtime-1' }
            }
        }
    })
    const res = await service.setControlUi('user-1', 'runtime-1', true, false)
    assert.deepEqual(delegated, [['user-1', 'runtime-1', true, false]])
    assert.deepEqual(res, { id: 'runtime-1' })
})

test('setDashboard refuses k8s runtimes and never touches the sidecar', async () => {
    const delegated: unknown[] = []
    const service = serviceFor({
        runtimes: runtimesFor([runtime({ framework: 'hermes', kind: 'k8s' })]),
        k8sSidecar: {
            setDashboard: async (...args: unknown[]) => {
                delegated.push(args)
                return { id: 'runtime-1' }
            }
        }
    })
    await assert.rejects(
        () => service.setDashboard('user-1', 'runtime-1', true, false),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            assert.match(
                (err as Error).message,
                /only supported for sprites runtimes/
            )
            return true
        }
    )
    // The producer is closed, not delegated: the k8s dashboard host was
    // removed (legacy-inventory §4.8, zero enabled rows measured on prod and
    // staging [2026-08-28]).
    assert.deepEqual(delegated, [])
})

test('sprite openclaw toggle rewrites config, patches flag, releases state and audits', async () => {
    const audits: Array<Record<string, unknown>> = []
    const claims: string[] = []
    const statusPatches: Array<Record<string, unknown>> = []
    const bootstrapCalls: Array<{ enabled: boolean }> = []
    const current = runtime({
        framework: 'openclaw',
        kind: 'sprites',
        controlUiEnabled: true
    })
    const service = serviceFor({
        runtimes: runtimesFor([current, current], statusPatches, {
            claims,
            claimResult: true
        }),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw' })),
        openclawBootstrap: {
            setControlUi: async (
                _ctx: unknown,
                _creds: unknown,
                enabled: boolean
            ) => {
                bootstrapCalls.push({ enabled })
            }
        }
    })
    stubSpriteTarget(service)
    await service.setControlUi('user-1', 'runtime-1', false, false)
    assert.equal(claims.length, 1)
    assert.match(claims[0], /^disabling@/)
    assert.deepEqual(bootstrapCalls, [{ enabled: false }])
    assert.deepEqual(statusPatches, [
        { controlUiEnabled: false, dashboardState: null }
    ])
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'agent_runtime.control_ui.toggled')
})

test('sprite openclaw toggle failure records error state and audits failure', async () => {
    const audits: Array<Record<string, unknown>> = []
    const statusPatches: Array<Record<string, unknown>> = []
    const current = runtime({
        framework: 'openclaw',
        kind: 'sprites',
        controlUiEnabled: true
    })
    const service = serviceFor({
        runtimes: runtimesFor([current], statusPatches, {
            claims: [],
            claimResult: true
        }),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw' })),
        openclawBootstrap: {
            setControlUi: async () => {
                throw new Error('Bearer topsecret exploded')
            }
        }
    })
    stubSpriteTarget(service)
    await assert.rejects(
        () => service.setControlUi('user-1', 'runtime-1', false, false),
        (err: unknown) => err instanceof InternalServerErrorException
    )
    assert.equal(statusPatches.length, 1)
    const state = statusPatches[0].dashboardState as string
    assert.match(state, /^error:/)
    // secrets are redacted before the reason is persisted or surfaced
    assert.doesNotMatch(state, /topsecret/)
    assert.equal(audits[0].action, 'agent_runtime.control_ui.toggle_failed')
})

test('sprite openclaw toggle short-circuits when the flag already matches', async () => {
    const claims: string[] = []
    const service = serviceFor({
        runtimes: runtimesFor(
            [
                runtime({
                    framework: 'openclaw',
                    kind: 'sprites',
                    controlUiEnabled: true
                })
            ],
            [],
            { claims, claimResult: true }
        )
    })
    const res = await service.setControlUi('user-1', 'runtime-1', true, false)
    assert.equal((res as unknown as Record<string, unknown>).id, 'runtime-1')
    assert.deepEqual(claims, [])
})

test('concurrent toggle is rejected with 409 when the CAS claim fails', async () => {
    const service = serviceFor({
        runtimes: runtimesFor(
            [
                runtime({
                    framework: 'hermes',
                    kind: 'sprites',
                    dashboardEnabled: false
                })
            ],
            [],
            { claims: [], claimResult: false }
        )
    })
    await assert.rejects(
        () => service.setDashboard('user-1', 'runtime-1', true, false),
        (err: unknown) => err instanceof ConflictException
    )
})

test('sprite hermes enable returns immediately and flips the flag in the background', async () => {
    const statusPatches: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    const claims: string[] = []
    const enableCalls: unknown[] = []
    const claimed = runtime({
        framework: 'hermes',
        kind: 'sprites',
        dashboardEnabled: false,
        dashboardState: 'enabling@2026-07-03T00:00:00.000Z'
    })
    const service = serviceFor({
        runtimes: runtimesFor(
            [
                runtime({ framework: 'hermes', kind: 'sprites' }),
                claimed,
                claimed
            ],
            statusPatches,
            { claims, claimResult: true }
        ),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ dashboardToken: 'tok' })),
        hermesBootstrap: {
            enableDashboard: async (_ctx: unknown, creds: unknown) => {
                enableCalls.push(creds)
            }
        }
    })
    stubSpriteTarget(service, { dashboardToken: 'tok' })
    ;(service as never as Record<string, unknown>).ensureDashboardToken =
        async () => undefined

    const res = await service.setDashboard('user-1', 'runtime-1', true, false)
    // The synchronous response carries the pending claim, not the final flag.
    assert.equal(
        (res as unknown as Record<string, unknown>).dashboardState,
        'enabling@2026-07-03T00:00:00.000Z'
    )
    assert.match(claims[0], /^enabling@/)

    await waitFor(() => audits.length > 0)
    assert.deepEqual(statusPatches, [
        { dashboardEnabled: true, dashboardState: null }
    ])
    assert.equal(enableCalls.length, 1)
    assert.equal(audits.at(-1)?.action, 'agent_runtime.dashboard.toggled')
})

test('sprite hermes enable failure records error state and keeps the flag off', async () => {
    const statusPatches: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor(
            [runtime({ framework: 'hermes', kind: 'sprites' })],
            statusPatches,
            { claims: [], claimResult: true }
        ),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ dashboardToken: 'tok' })),
        hermesBootstrap: {
            enableDashboard: async () => {
                throw new Error('probe failed')
            }
        }
    })
    stubSpriteTarget(service, { dashboardToken: 'tok' })
    ;(service as never as Record<string, unknown>).ensureDashboardToken =
        async () => undefined

    await service.setDashboard('user-1', 'runtime-1', true, false)
    await waitFor(() => audits.length > 0)
    assert.equal(statusPatches.length, 1)
    assert.match(statusPatches[0].dashboardState as string, /^error:probe/)
    assert.equal(statusPatches[0].dashboardEnabled, undefined)
    assert.equal(audits.at(-1)?.action, 'agent_runtime.dashboard.toggle_failed')
})

test('sprite hermes disable on an already-disabled runtime is a no-op', async () => {
    const claims: string[] = []
    const service = serviceFor({
        runtimes: runtimesFor(
            [
                runtime({
                    framework: 'hermes',
                    kind: 'sprites',
                    dashboardEnabled: false,
                    dashboardState: null
                })
            ],
            [],
            { claims, claimResult: true }
        )
    })
    const res = await service.setDashboard('user-1', 'runtime-1', false, false)
    assert.equal((res as unknown as Record<string, unknown>).id, 'runtime-1')
    assert.deepEqual(claims, [])
})

test('sprite hermes enable with the flag already on re-runs as a repair', async () => {
    const statusPatches: Array<Record<string, unknown>> = []
    const enableCalls: unknown[] = []
    const service = serviceFor({
        runtimes: runtimesFor(
            [
                runtime({
                    framework: 'hermes',
                    kind: 'sprites',
                    dashboardEnabled: true
                })
            ],
            statusPatches,
            { claims: [], claimResult: true }
        ),
        db: dbFor({ audits: [], credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ dashboardToken: 'tok' })),
        hermesBootstrap: {
            enableDashboard: async () => {
                enableCalls.push(true)
            }
        }
    })
    stubSpriteTarget(service, { dashboardToken: 'tok' })
    ;(service as never as Record<string, unknown>).ensureDashboardToken =
        async () => undefined
    await service.setDashboard('user-1', 'runtime-1', true, false)
    await waitFor(() => enableCalls.length > 0)
    assert.equal(enableCalls.length, 1)
})

// ---------------------------------------------------------------------------
// stale sweep
// ---------------------------------------------------------------------------

test('sweep marks stale in-flight toggles as interrupted, leaves fresh ones', async () => {
    const statusPatches: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    const stale = `enabling@${new Date(Date.now() - 20 * 60_000).toISOString()}`
    const fresh = `disabling@${new Date().toISOString()}`
    const service = serviceFor({
        runtimes: runtimesFor([], statusPatches),
        db: {
            ...(dbFor({ audits }) as Record<string, unknown>),
            select: () => ({
                from: () => ({
                    where: async () => [
                        {
                            id: 'runtime-stale',
                            userId: 'user-1',
                            dashboardState: stale
                        },
                        {
                            id: 'runtime-fresh',
                            userId: 'user-1',
                            dashboardState: fresh
                        }
                    ]
                })
            })
        }
    })
    await (
        service as never as {
            sweepStaleToggles: () => Promise<void>
        }
    ).sweepStaleToggles()
    assert.deepEqual(statusPatches, [{ dashboardState: 'error:interrupted' }])
    assert.equal(audits.length, 1)
    assert.equal(audits[0].subject, 'runtime-stale')
})

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const serviceFor = (deps: {
    runtimes: unknown
    db?: unknown
    crypto?: unknown
    k8sSidecar?: unknown
    hermesBootstrap?: unknown
    openclawBootstrap?: unknown
}): RuntimeDashboardService =>
    new RuntimeDashboardService(
        (deps.db ?? auditDb()) as never,
        deps.runtimes as never,
        (deps.k8sSidecar ?? {}) as never,
        {} as never,
        (deps.crypto ?? defaultCrypto()) as never,
        (deps.hermesBootstrap ?? {}) as never,
        (deps.openclawBootstrap ?? {}) as never
    )

// Bypass the agent-row/account/client assembly (integration concern) so the
// toggle tests exercise claim → bootstrap → patch → audit.
const stubSpriteTarget = (
    service: RuntimeDashboardService,
    creds: Record<string, unknown> = {}
): void => {
    ;(service as never as Record<string, unknown>).buildSpriteTarget =
        async () => ({
            ctx: {
                agentId: 'agent-1',
                runtimeId: 'runtime-1',
                userId: 'user-1',
                spriteName: 'sprite-1',
                mountPath: '/workspace',
                client: {},
                logger: {
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: () => {}
                },
                envText: null
            },
            creds
        })
}

const waitFor = async (
    cond: () => boolean,
    timeoutMs = 2_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

const runtimesFor = (
    rows: Array<Record<string, unknown>>,
    statusPatches: Array<Record<string, unknown>> = [],
    claiming: { claims: string[]; claimResult: boolean } = {
        claims: [],
        claimResult: true
    }
): unknown => {
    const queue = [...rows]
    return {
        findById: async () => queue.shift() ?? rows[rows.length - 1] ?? null,
        toSummary: (row: Record<string, unknown>) => row,
        applyStatusPatch: async (
            _runtimeId: string,
            patch: Record<string, unknown>
        ) => {
            statusPatches.push(patch)
        },
        claimDashboardState: async (_runtimeId: string, next: string) => {
            claiming.claims.push(next)
            return claiming.claimResult
        }
    }
}

const auditDb = (): unknown => ({
    insert: () => ({
        values: async () => undefined
    })
})

const defaultCrypto = (): unknown => ({
    decrypt: () => {
        throw new Error('crypto.decrypt called but no plain was provisioned')
    }
})

// Mock db that satisfies the select() shapes the facade issues (`select()`
// for credentials, `select({internalId})` for agent lookup), plus
// `insert(auditLogs).values(...)` for audit log writes.
const dbFor = (opts: {
    audits: Array<Record<string, unknown>>
    credsCiphertext?: string
    agentInternalIdByAgentId?: Record<string, string>
}): unknown => {
    const credsRow = opts.credsCiphertext
        ? { payloadCiphertext: opts.credsCiphertext, keyVersion: 1 }
        : null
    return {
        insert: () => ({
            values: async (row: Record<string, unknown>) => {
                opts.audits.push(row)
            }
        }),
        select: (cols?: Record<string, unknown>) => {
            const isAgentLookup = cols !== undefined && 'internalId' in cols
            let capturedId: string | null = null
            return {
                from: () => ({
                    where: (cond: unknown) => {
                        const params = (
                            cond as { queryChunks?: unknown[] } | undefined
                        )?.queryChunks
                        if (params) {
                            for (const c of params) {
                                if (
                                    c &&
                                    typeof c === 'object' &&
                                    'value' in c
                                ) {
                                    const v = (c as { value: unknown }).value
                                    if (typeof v === 'string') capturedId = v
                                }
                            }
                        }
                        return {
                            limit: async () => {
                                if (isAgentLookup) {
                                    const map =
                                        opts.agentInternalIdByAgentId ?? {}
                                    const id = capturedId
                                    if (id && map[id])
                                        return [{ internalId: map[id] }]
                                    return []
                                }
                                return credsRow ? [credsRow] : []
                            }
                        }
                    }
                })
            }
        }
    }
}

// Crypto mock that returns a fixed plaintext on decrypt, used by the
// openclaw / narranexus / sprite-hermes mint paths.
const cryptoReturning = (plain: string): unknown => ({
    decrypt: () => plain
})
