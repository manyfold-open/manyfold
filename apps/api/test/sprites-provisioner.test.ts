import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRuntimeRow, SpritesAccount } from '@manyfold/db'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'

const account = {
    id: 'spa_test',
    slug: 'test-account',
    orgSlug: 'test-org',
    orgId: 'org-1',
    tokenId: 'token-1',
    tokenCiphertext: 'encrypted-token',
    tokenKeyVersion: 1,
    status: 'enabled',
    priority: 0,
    notes: null,
    createdAt: new Date('2026-05-06T00:00:00.000Z'),
    updatedAt: new Date('2026-05-06T00:00:00.000Z')
} as SpritesAccount

const runtimeRow = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'codex',
        kind: 'sprites',
        status: 'pending',
        currentPhase: 'creating_sprite',
        failureReason: null,
        accountId: account.id,
        spriteName: null,
        spriteId: null,
        clusterId: null,
        daemonId: null,
        homeDir: null,
        workspaceBaseDir: null,
        capabilitiesJson: {},
        lastSeenAt: null,
        namespace: null,
        ingressHost: null,
        mountPath: '/home/sprite/.nca/workspaces/agt_test',
        primaryAgentId: null,
        controlUiEnabled: true,
        dashboardEnabled: false,
        keepAliveEnabled: false,
        startedAt: null,
        lastBootstrappedAt: null,
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

test('SpritesProvisioner threads the sandbox host sprite name through createSprite, policy, bootstrap and the row', async () => {
    const originalFetch = globalThis.fetch
    const fetchCalls: Array<{
        url: string
        method: string
        body: unknown
    }> = []

    globalThis.fetch = (async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        const body =
            typeof init?.body === 'string' ? JSON.parse(init.body) : null
        fetchCalls.push({ url, method, body })

        if (url.endsWith('/sprites') && method === 'POST') {
            const name = (body as { name: string }).name
            return new Response(
                JSON.stringify({
                    id: 'sprite-remote-1',
                    name,
                    status: 'warm'
                }),
                { status: 200 }
            )
        }
        if (url.endsWith('/policy/network') && method === 'POST') {
            return new Response('', { status: 200 })
        }
        return new Response('unexpected request', { status: 500 })
    }) as typeof fetch

    try {
        let storedRuntime: AgentRuntimeRow | null = null
        let reserved: Partial<AgentRuntimeRow> | null = null
        let bootstrapSpriteName: string | null = null
        let shellDeployEnv: string | undefined
        let installedCliChannel: string | undefined

        const provisioner = new SpritesProvisioner(
            {} as never,
            {
                selectForCreate: async () => account,
                decryptToken: () => 'sprites-token'
            } as never,
            {
                applyStatusPatch: async (
                    id: string,
                    patch: Partial<AgentRuntimeRow>
                ) => {
                    assert.equal(id, reserved?.id)
                    storedRuntime = runtimeRow({
                        ...storedRuntime,
                        ...patch
                    } as Partial<AgentRuntimeRow>)
                },
                setPhase: async (id: string, phase: string | null) => {
                    assert.equal(id, reserved?.id)
                    storedRuntime = runtimeRow({
                        ...storedRuntime,
                        currentPhase: phase
                    } as Partial<AgentRuntimeRow>)
                },
                findById: async (id: string) => {
                    assert.equal(id, reserved?.id)
                    return storedRuntime
                },
                applyProvisioningPatch: async (
                    id: string,
                    patch: Partial<AgentRuntimeRow>
                ) => {
                    assert.equal(id, reserved?.id)
                    storedRuntime = runtimeRow({
                        ...storedRuntime,
                        ...patch
                    } as Partial<AgentRuntimeRow>)
                },
                setSandboxHostSprite: async () => {}
            } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            {
                run: async (ctx: { spriteName: string }) => {
                    bootstrapSpriteName = ctx.spriteName
                    return { homeDir: '/home/sprite' }
                }
            } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            {
                reserveSpriteRuntime: async (
                    input: Partial<AgentRuntimeRow>
                ) => {
                    reserved = input
                    storedRuntime = runtimeRow({
                        ...input,
                        kind: 'sprites',
                        hostId: 'sbx_testhost',
                        spriteName: 'sbx-test-host'
                    })
                    return { runtime: storedRuntime, hostCreated: true }
                },
                delete: async () => {}
            } as never,
            {
                get: (key: string) =>
                    key === 'PUBLIC_API_BASE_URL'
                        ? 'http://api.test'
                        : undefined
            } as never,
            {
                write: async (input: { deployEnv?: string }) => {
                    shellDeployEnv = input.deployEnv
                },
                installCli: async (input: { channel: string }) => {
                    installedCliChannel = input.channel
                }
            } as never,
            {} as never,
            { settleHostNotRunning: async () => {} } as never
        )

        const result = await provisioner.provisionRuntime({
            userId: 'user-1',
            framework: 'codex',
            accountId: null,
            isAdmin: false,
            credentials: {},
            emitter: { step: () => {} },
            agentId: 'agt_test'
        })

        const capturedReserved = reserved as { id: string } | null
        assert.ok(capturedReserved?.id)
        assert.match(capturedReserved.id, /^art_[a-z2-7]{26}$/)
        // sprite name now comes from the sandbox host (reserveSpriteRuntime), not
        // derived from the runtime id; the provisioner must thread that one name
        // through createSprite, the network policy, bootstrap and the row.
        const expectedSpriteName = 'sbx-test-host'
        assert.equal(fetchCalls[0].method, 'POST')
        assert.equal(
            (fetchCalls[0].body as { name: string }).name,
            expectedSpriteName
        )
        const policyCall = fetchCalls.find((call) =>
            call.url.endsWith('/policy/network')
        )
        assert.deepEqual(policyCall?.body, { rules: [] })
        assert.equal(bootstrapSpriteName, expectedSpriteName)
        assert.equal(shellDeployEnv, 'local')
        assert.equal(installedCliChannel, 'stable')
        assert.equal(result.runtime.spriteName, expectedSpriteName)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('SpritesProvisioner preserves a revoked sandbox host when runtime create-failure cleanup cannot delete the VM', async () => {
    const originalFetch = globalThis.fetch
    const fetchCalls: Array<{ url: string; method: string }> = []

    globalThis.fetch = (async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        fetchCalls.push({ url, method })

        if (url.endsWith('/sprites') && method === 'POST') {
            return new Response(
                JSON.stringify({
                    id: 'sprite-remote-1',
                    name: 'sbx-test-host',
                    status: 'warm'
                }),
                { status: 200 }
            )
        }
        if (url.endsWith('/policy/network') && method === 'POST') {
            return new Response('', { status: 200 })
        }
        if (url.includes('/sprites/sbx-test-host') && method === 'DELETE') {
            return new Response('delete down', {
                status: 500,
                statusText: 'Server Error'
            })
        }
        return new Response('unexpected request', { status: 500 })
    }) as typeof fetch

    try {
        let runtimeId: string | null = null
        const deletedRuntimeIds: string[] = []
        const revokedHostIds: string[] = []
        const deletedHostIds: string[] = []
        const hostHasRuntimesCalls: string[] = []

        const provisioner = new SpritesProvisioner(
            {} as never,
            {
                selectForCreate: async () => account,
                decryptToken: () => 'sprites-token'
            } as never,
            {
                applyStatusPatch: async () => {},
                setPhase: async () => {},
                delete: async (id: string) => {
                    deletedRuntimeIds.push(id)
                },
                revokeSandboxHost: async (id: string) => {
                    revokedHostIds.push(id)
                },
                hostHasRuntimes: async (id: string) => {
                    hostHasRuntimesCalls.push(id)
                    return false
                },
                deleteSandboxHost: async (id: string) => {
                    deletedHostIds.push(id)
                }
            } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            {
                run: async () => {
                    throw new Error('bootstrap failed')
                }
            } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            { run: async () => ({ homeDir: undefined }) } as never,
            {
                reserveSpriteRuntime: async (
                    input: Partial<AgentRuntimeRow> & { id: string }
                ) => {
                    runtimeId = input.id
                    return {
                        runtime: runtimeRow({
                            ...input,
                            kind: 'sprites',
                            hostId: 'sbx_testhost',
                            spriteName: 'sbx-test-host'
                        }),
                        hostCreated: true
                    }
                }
            } as never,
            {
                get: (key: string) =>
                    key === 'PUBLIC_API_BASE_URL'
                        ? 'http://api.test'
                        : undefined
            } as never,
            {} as never,
            {} as never,
            { settleHostNotRunning: async () => {} } as never
        )

        await assert.rejects(
            () =>
                provisioner.provisionRuntime({
                    userId: 'user-1',
                    framework: 'codex',
                    accountId: null,
                    isAdmin: false,
                    credentials: {},
                    emitter: { step: () => {} },
                    agentId: 'agt_test'
                }),
            /bootstrap failed/
        )

        assert.ok(runtimeId)
        assert.deepEqual(deletedRuntimeIds, [runtimeId])
        assert.deepEqual(
            revokedHostIds,
            ['sbx_testhost'],
            'failed remote cleanup keeps a non-reusable host retry record'
        )
        assert.deepEqual(deletedHostIds, [])
        assert.deepEqual(hostHasRuntimesCalls, [])
        assert.equal(
            fetchCalls.filter((call) => call.method === 'DELETE').length,
            1
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

const wakeProvisioner = (lease: {
    ensureServiceRunning: (
        runtime: AgentRuntimeRow
    ) => Promise<{ started: boolean }>
    ensureLease: (runtime: AgentRuntimeRow) => Promise<void>
}): SpritesProvisioner =>
    new SpritesProvisioner(
        {} as never,
        {
            getById: async () => account,
            decryptToken: () => 'sprites-token'
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never,
        {} as never,
        {} as never,
        lease as never,
        { settleHostNotRunning: async () => {} } as never
    )

test('SpritesProvisioner delegates wakes to the keep-alive lease', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner({
        ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
            calls.push(runtime.id)
            return { started: true }
        },
        ensureLease: async () => {}
    })

    await provisioner.wakeSpriteRuntime(
        runtimeRow({
            framework: 'hermes',
            status: 'ready',
            spriteName: 'art-test',
            accountId: account.id
        })
    )

    assert.deepEqual(calls, ['art_test'])
})

// wakeSpriteRuntime is the seam every traffic entry funnels through (chat,
// channels, automations via markRuntimeActive). Getting it wrong either
// re-fuses wake+lease (a billing task per chat message — the coupling Phase 2
// exists to break) or drops the lease on cold wakes (the pre-start cleanup
// deleted the task, so a paid-for slot silently vanishes).

test('wakeSpriteRuntime never leases for a disabled runtime even on cold start', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner({
        ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
            calls.push(`ensureServiceRunning:${runtime.id}`)
            return { started: true }
        },
        ensureLease: async (runtime: AgentRuntimeRow) => {
            calls.push(`ensureLease:${runtime.id}`)
        }
    })

    await provisioner.wakeSpriteRuntime(
        runtimeRow({
            framework: 'hermes',
            status: 'ready',
            spriteName: 'art-test',
            accountId: account.id,
            keepAliveEnabled: false
        })
    )

    assert.deepEqual(
        calls,
        ['ensureServiceRunning:art_test'],
        'a disabled runtime must wake lease-free or every chat message re-registers a billing task'
    )
})

test('wakeSpriteRuntime re-establishes the lease when an enabled runtime cold-starts', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner({
        ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
            calls.push(`ensureServiceRunning:${runtime.id}`)
            return { started: true }
        },
        ensureLease: async (runtime: AgentRuntimeRow) => {
            calls.push(`ensureLease:${runtime.id}`)
        }
    })

    await provisioner.wakeSpriteRuntime(
        runtimeRow({
            framework: 'hermes',
            status: 'ready',
            spriteName: 'art-test',
            accountId: account.id,
            keepAliveEnabled: true
        })
    )

    assert.deepEqual(
        calls,
        ['ensureServiceRunning:art_test', 'ensureLease:art_test'],
        'cold start cleared the tasks pre-start, so an enabled runtime must re-lease in the same call'
    )
})

test('wakeSpriteRuntime skips the lease when the enabled service was already running', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner({
        ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
            calls.push(`ensureServiceRunning:${runtime.id}`)
            return { started: false }
        },
        ensureLease: async (runtime: AgentRuntimeRow) => {
            calls.push(`ensureLease:${runtime.id}`)
        }
    })

    await provisioner.wakeSpriteRuntime(
        runtimeRow({
            framework: 'hermes',
            status: 'ready',
            spriteName: 'art-test',
            accountId: account.id,
            keepAliveEnabled: true
        })
    )

    assert.deepEqual(
        calls,
        ['ensureServiceRunning:art_test'],
        'a warm wake must not pay an exec + tasks verify + metadata write per message; started=false means the lease loop is already converged or Pass B will handle it'
    )
})
