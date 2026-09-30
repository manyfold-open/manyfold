import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    InternalServerErrorException
} from '@nestjs/common'
import { RuntimeDashboardService } from '../src/modules/agent-runtimes/orchestration/runtime-dashboard.service'
import { FIXTURE, fixtureControlUi } from './helpers/fixture-framework'
import {
    contextOf,
    k8sHostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'
import { extensionsWith } from './helpers/framework-extensions-stub'

const runtime = (patch: Record<string, unknown> = {}) => ({
    id: 'runtime-1',
    userId: 'user-1',
    name: 'Hermes',
    framework: 'hermes',
    kind: 'k8s',
    status: 'ready',
    namespace: 'nca-user-1',
    clusterId: null,
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

// A link opened for no agent in particular names none; the audit says the
// same as the URL.
test('getControlUiUrl mints a link naming no agent when the caller names none', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: FIXTURE,
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
    assert.equal(url, 'https://agent-1.example.test/ui?agent=')
    const details = audits[0].meta as Record<string, unknown>
    assert.equal(details.agentId, null)
})

test('getControlUiUrl names the agent the caller opened it for', async () => {
    const audits: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([
            runtime({
                framework: FIXTURE,
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

// A gateway is a service of its host's daemon (ADR-0035), on a cloud
// computer and a sandbox alike: the toggle rewrites the service's config and
// restarts it with the runtime's other settings unchanged.
test('cloud computer openclaw toggle reconfigures its service, patches flag and audits', async () => {
    const audits: Array<Record<string, unknown>> = []
    const statusPatches: Array<Record<string, unknown>> = []
    const services = hostServicesFake()
    const current = runtime({ framework: 'openclaw', kind: 'k8s', hostId: 'pdh_1' })
    const service = serviceFor({
        runtimes: runtimesFor([current, current], statusPatches),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw' })),
        hostServices: services
    })
    await service.setControlUi('user-1', 'runtime-1', true, false)
    assert.deepEqual(services.settings, [
        {
            credentials: { gatewayToken: 'gw' },
            envText: null,
            controlUiEnabled: true,
            dashboardEnabled: false
        }
    ])
    assert.deepEqual(statusPatches, [
        { controlUiEnabled: true, dashboardState: null }
    ])
    assert.equal(audits[0].action, 'agent_runtime.control_ui.toggled')
})

// An operator's repair, and how a cutover moves a sandbox's runtime onto its
// daemon's services: the config rewritten with the runtime's own settings.
test('an admin service restart reconfigures with the runtime\'s settings and audits', async () => {
    const audits: Array<Record<string, unknown>> = []
    const services = hostServicesFake()
    const current = runtime({
        framework: 'openclaw',
        kind: 'sprites',
        controlUiEnabled: true
    })
    const service = serviceFor({
        runtimes: runtimesFor([current, current]),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ gatewayToken: 'gw' })),
        hostServices: services
    })
    await service.restartService('admin-1', 'runtime-1', true)
    assert.deepEqual(services.settings, [
        {
            credentials: { gatewayToken: 'gw' },
            envText: null,
            controlUiEnabled: true,
            dashboardEnabled: false
        }
    ])
    assert.equal(audits[0].action, 'agent_runtime.service.restarted')
    assert.equal((audits[0].meta as Record<string, unknown>).onBehalfOf, true)

    const coding = serviceFor({
        runtimes: runtimesFor([runtime({ framework: 'claude-code' as never, kind: 'sprites' })])
    })
    await assert.rejects(
        () => coding.restartService('admin-1', 'runtime-1', true),
        /runs no service to restart/
    )
})

test('setDashboard refuses k8s runtimes', async () => {
    const service = serviceFor({
        runtimes: runtimesFor([runtime({ framework: 'hermes', kind: 'k8s' })])
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
})

test('sprite openclaw toggle rewrites config, patches flag, releases state and audits', async () => {
    const audits: Array<Record<string, unknown>> = []
    const claims: string[] = []
    const statusPatches: Array<Record<string, unknown>> = []
    const services = hostServicesFake()
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
        hostServices: services
    })
    await service.setControlUi('user-1', 'runtime-1', false, false)
    assert.equal(claims.length, 1)
    assert.match(claims[0], /^disabling@/)
    assert.deepEqual(
        services.settings.map((x) => (x as { controlUiEnabled: boolean }).controlUiEnabled),
        [false]
    )
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
        hostServices: hostServicesFake(new Error('Bearer topsecret exploded'))
    })
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
    const services = hostServicesFake()
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
        hostServices: services
    })
    const probes = stubProbes(service)
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
    assert.deepEqual(
        services.settings.map((x) => (x as { dashboardEnabled: boolean }).dashboardEnabled),
        [true]
    )
    // Proved through the sandbox's public URL: /v1 through the proxy, the
    // HTML refused without the token, the UI's socket passed.
    assert.deepEqual(probes, [
        'https://agent-1.example.test/v1/health',
        'https://agent-1.example.test/',
        'wss://agent-1.example.test/api/ws?token=tok'
    ])
    assert.equal(audits.at(-1)?.action, 'agent_runtime.dashboard.toggled')
})

// Chat must never be left unroutable: a dashboard that does not prove itself
// is switched back off before the failure is recorded.
test('sprite hermes enable failure rolls the services back, records error state and keeps the flag off', async () => {
    const statusPatches: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    const services = hostServicesFake()
    const service = serviceFor({
        runtimes: runtimesFor(
            [runtime({ framework: 'hermes', kind: 'sprites' })],
            statusPatches,
            { claims: [], claimResult: true }
        ),
        db: dbFor({ audits, credsCiphertext: 'ENC1' }),
        crypto: cryptoReturning(JSON.stringify({ dashboardToken: 'tok' })),
        hostServices: services
    })
    stubProbes(service, new Error('probe failed'))
    ;(service as never as Record<string, unknown>).ensureDashboardToken =
        async () => undefined

    await service.setDashboard('user-1', 'runtime-1', true, false)
    await waitFor(() => audits.length > 0)
    assert.deepEqual(
        services.settings.map((x) => (x as { dashboardEnabled: boolean }).dashboardEnabled),
        [true, false]
    )
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
    const services = hostServicesFake()
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
        hostServices: services
    })
    stubProbes(service)
    ;(service as never as Record<string, unknown>).ensureDashboardToken =
        async () => undefined
    await service.setDashboard('user-1', 'runtime-1', true, false)
    await waitFor(() => services.settings.length > 0)
    assert.equal(services.settings.length, 1)
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
    context?: unknown
    hostClients?: unknown
    providers?: unknown
    crypto?: unknown
    hostServices?: unknown
}): RuntimeDashboardService =>
    new RuntimeDashboardService(
        (deps.db ?? auditDb()) as never,
        deps.runtimes as never,
        (deps.context ?? deps.runtimes) as never,
        (deps.hostClients ?? {
            providerForHost: async () => ({ id: 'rtp_1', name: 'p' })
        }) as never,
        // The provider's public URL for the framework port: the host row's
        // name carries the ingress host a test chose.
        (deps.providers ?? {
            for: () => ({
                publicUrl: ({ host }: { host: { name: string } }) =>
                    host.name ? `https://${host.name}` : null
            })
        }) as never,
        (deps.crypto ?? defaultCrypto()) as never,
        (deps.hostServices ?? hostServicesFake()) as never,
        extensionsWith({ framework: FIXTURE, controlUi: fixtureControlUi })
    )

// The host's daemon rewriting a framework's config and restarting its
// services: the settings each reconfigure asked for, or the failure it hits.
const hostServicesFake = (error?: Error) => {
    const settings: unknown[] = []
    return {
        settings,
        reconfigure: async (_runtime: unknown, _host: unknown, next: unknown) => {
            settings.push(next)
            if (error) throw error
        }
    }
}

// The dashboard's proofs through the sandbox's public URL, recorded instead
// of fetched; `error` fails the first.
const stubProbes = (service: RuntimeDashboardService, error?: Error): string[] => {
    const urls: string[] = []
    const record = async (url: string) => {
        urls.push(url)
        if (error) throw error
    }
    Object.assign(service as never as Record<string, unknown>, {
        probe: record,
        probeWs: record
    })
    return urls
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
    // One queue for the context read and the refreshed read, in the order
    // the facade makes them.
    const queue = [...rows]
    // The runtime with its machine, as the facade reads it: a cloud
    // computer or a sandbox by the row's kind, its ingress host on the host.
    const hostFor = (row: Record<string, unknown>) => {
        const name = (row.ingressHost as string | null) ?? ''
        return row.kind === 'k8s'
            ? k8sHostRow({ id: 'rth_dash', userId: 'user-1', name })
            : spritesHostRow({ id: 'rth_dash', userId: 'user-1', name })
    }
    return {
        findById: async () => queue.shift() ?? rows[rows.length - 1] ?? null,
        forRuntime: async () => {
            const row = queue.shift() ?? rows[rows.length - 1] ?? null
            return row
                ? contextOf({
                      runtime: runtimeRow({
                          ...(row as never as Record<string, never>),
                          hostId: 'rth_dash'
                      }),
                      host: hostFor(row)
                  })
                : null
        },
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
// openclaw / edition framework / sprite-hermes mint paths.
const cryptoReturning = (plain: string): unknown => ({
    decrypt: () => plain
})
