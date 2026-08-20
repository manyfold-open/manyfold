import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { SpritesError, type SpritesClient } from '@manyfold/sprites'
import type { AgentRuntimeRow, SpritesAccount } from '@manyfold/db'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import type { SandboxExecProbeResult } from '../src/modules/agent-runtimes/provisioning/sandbox-exec-health'

// Placement is explicit: no sandbox named means a fresh VM, and only an attach
// lands on a VM that already exists. These tests own that boundary in the
// provisioner — a create never wanders onto someone's existing sandbox, and an
// attach to a VM whose exec endpoint is wedged (#439: handshakes 502ing after
// ~36s) fails before bootstrap instead of during it, leaving a cooldown marker
// and no orphaned runtime row.

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
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    updatedAt: new Date('2026-07-29T00:00:00.000Z')
} as SpritesAccount

const runtimeRow = (overrides: Partial<AgentRuntimeRow>): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'gemini-cli',
        kind: 'sprites',
        status: 'pending',
        currentPhase: 'creating_sprite',
        failureReason: null,
        accountId: account.id,
        spriteName: null,
        spriteId: null,
        hostId: null,
        mountPath: '/home/sprite/.nca/workspaces/agt_test',
        homeDir: null,
        keepAliveEnabled: false,
        createdAt: new Date('2026-07-29T00:00:00.000Z'),
        updatedAt: new Date('2026-07-29T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

class TestProvisioner extends SpritesProvisioner {
    readonly probed: string[] = []
    unhealthy = new Set<string>()
    probeErrors = new Map<string, Error>()

    protected async probeExec(
        _client: SpritesClient,
        spriteName: string
    ): Promise<SandboxExecProbeResult> {
        this.probed.push(spriteName)
        const probeError = this.probeErrors.get(spriteName)
        if (probeError) throw probeError
        return this.unhealthy.has(spriteName)
            ? {
                  ok: false,
                  attempts: 2,
                  detail: 'exec handshake HTTP 502'
              }
            : { ok: true, attempts: 1 }
    }
}

interface Candidate {
    id: string
    spriteName: string
}

interface Harness {
    provisioner: TestProvisioner
    probed: string[]
    reserveCalls: Array<{ id: string; hostId: string | null }>
    deletedRuntimeIds: string[]
    cooldowns: Array<{ hostId: string; until: Date }>
    revokedHostIds: string[]
    bootstrappedOn: string[]
    fetchCalls: Array<{ url: string; method: string }>
}

// `candidates` are the sandboxes that exist; only an explicit attachHostId can
// land on one of them.
const buildHarness = (opts: {
    candidates: Candidate[]
    unhealthy?: string[]
    probeErrors?: Record<string, Error>
    attachHostId?: string
    quotaExhausted?: boolean
    bootstrap?: () => Promise<{ homeDir: string }>
}): Harness => {
    const reserveCalls: Harness['reserveCalls'] = []
    const deletedRuntimeIds: string[] = []
    const cooldowns: Harness['cooldowns'] = []
    const revokedHostIds: string[] = []
    const bootstrappedOn: string[] = []
    const fetchCalls: Harness['fetchCalls'] = []
    const rows = new Map<string, AgentRuntimeRow>()
    const cooling = new Set<string>()
    let freshHosts = 0

    const runtimes = {
        applyStatusPatch: async (
            id: string,
            patch: Partial<AgentRuntimeRow>
        ) => {
            rows.set(id, runtimeRow({ ...rows.get(id), ...patch, id }))
        },
        applyProvisioningPatch: async (
            id: string,
            patch: Partial<AgentRuntimeRow>
        ) => {
            rows.set(id, runtimeRow({ ...rows.get(id), ...patch, id }))
        },
        setPhase: async () => {},
        findById: async (id: string) => rows.get(id) ?? null,
        delete: async (id: string) => {
            deletedRuntimeIds.push(id)
            rows.delete(id)
        },
        markSandboxHostExecCooldown: async (hostId: string, until: Date) => {
            cooldowns.push({ hostId, until })
            cooling.add(hostId)
        },
        revokeSandboxHost: async (id: string) => {
            revokedHostIds.push(id)
        },
        hostHasRuntimes: async () => false,
        deleteSandboxHost: async () => {},
        setSandboxHostSprite: async () => {},
        findHostById: async (hostId: string) => ({
            id: hostId,
            userId: 'user-1',
            kind: 'sandbox',
            status: 'active',
            accountId: account.id,
            spriteId: `sprite-${hostId}`
        })
    }

    // Mirrors the real reservation contract: a named sandbox is attached to, and
    // anything else builds a fresh VM. There is no implicit candidate search, so
    // the fake must not invent one — that is what makes "reuse only happens when
    // the caller asked for it" testable here.
    const runtimeAccess = {
        reserveSpriteRuntime: async (input: {
            id: string
            hostId?: string
        }) => {
            reserveCalls.push({ id: input.id, hostId: input.hostId ?? null })
            const attached = input.hostId
                ? opts.candidates.find((c) => c.id === input.hostId)
                : undefined
            if (attached) {
                const row = runtimeRow({
                    id: input.id,
                    hostId: attached.id,
                    spriteName: attached.spriteName,
                    spriteId: `sprite-${attached.id}`
                })
                rows.set(input.id, row)
                return { runtime: row, hostCreated: false }
            }
            if (opts.quotaExhausted)
                throw new ForbiddenException({
                    message: 'sandbox limit reached (1 for free plan)',
                    code: 'RUNTIME_LIMIT_REACHED'
                })
            freshHosts += 1
            const row = runtimeRow({
                id: input.id,
                hostId: `sbx_fresh${freshHosts}`,
                spriteName: `sbx-fresh${freshHosts}`
            })
            rows.set(input.id, row)
            return { runtime: row, hostCreated: true }
        }
    }

    const bootstrap = {
        run: async (ctx: { spriteName: string }) => {
            bootstrappedOn.push(ctx.spriteName)
            return opts.bootstrap
                ? await opts.bootstrap()
                : { homeDir: '/home/sprite' }
        }
    }

    const provisioner = new TestProvisioner(
        {} as never,
        {
            selectForCreate: async () => account,
            getById: async () => account,
            decryptToken: () => 'sprites-token'
        } as never,
        runtimes as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        bootstrap as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        runtimeAccess as never,
        { get: () => undefined } as never,
        {} as never,
        {} as never,
        { settleHostNotRunning: async () => {} } as never
    )
    for (const name of opts.unhealthy ?? []) provisioner.unhealthy.add(name)
    for (const [name, err] of Object.entries(opts.probeErrors ?? {}))
        provisioner.probeErrors.set(name, err)

    return {
        provisioner,
        probed: provisioner.probed,
        reserveCalls,
        deletedRuntimeIds,
        cooldowns,
        revokedHostIds,
        bootstrappedOn,
        fetchCalls
    }
}

const withStubbedSprites = async (
    harness: Harness,
    body: () => Promise<void>
): Promise<void> => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        harness.fetchCalls.push({ url, method })
        if (url.endsWith('/sprites') && method === 'POST')
            return new Response(
                JSON.stringify({ id: 'sprite-remote-1', status: 'warm' }),
                { status: 200 }
            )
        if (url.endsWith('/policy/network') && method === 'POST')
            return new Response('', { status: 200 })
        return new Response('unexpected request', { status: 500 })
    }) as typeof fetch
    try {
        await body()
    } finally {
        globalThis.fetch = originalFetch
    }
}

const provision = (harness: Harness, attachHostId?: string): Promise<unknown> =>
    harness.provisioner.provisionRuntime({
        userId: 'user-1',
        framework: 'gemini-cli',
        accountId: null,
        attachHostId: attachHostId ?? null,
        isAdmin: false,
        credentials: {},
        emitter: { step: () => {} },
        agentId: 'agt_test'
    })

// Placement is explicit, so a create with no named sandbox must build its own VM
// even when the user has perfectly good sandboxes sitting there. Landing on one of
// them would put the agent somewhere the user was never told about.
test('a create with no named sandbox never touches an existing one', async () => {
    const harness = buildHarness({
        candidates: [
            { id: 'sbx_old', spriteName: 'sbx-old' },
            { id: 'sbx_new', spriteName: 'sbx-new' }
        ]
    })

    await withStubbedSprites(harness, async () => {
        const result = (await provision(harness)) as {
            runtime: AgentRuntimeRow
        }
        assert.equal(result.runtime.hostId, 'sbx_fresh1')
    })

    assert.deepEqual(
        harness.reserveCalls.map((c) => c.hostId),
        [null],
        'one reservation, with no host named — no candidate search, no retry loop'
    )
    assert.deepEqual(
        harness.probed,
        [],
        'a freshly created VM must not pay for a probe: its first exec is the bootstrap'
    )
    assert.deepEqual(harness.bootstrappedOn, ['sbx-fresh1'])
})

test('an explicit attach to an unhealthy sandbox fails loudly instead of moving the agent', async () => {
    const harness = buildHarness({
        candidates: [
            { id: 'sbx_target', spriteName: 'sbx-target' },
            { id: 'sbx_other', spriteName: 'sbx-other' }
        ],
        unhealthy: ['sbx-target']
    })

    await withStubbedSprites(harness, async () => {
        await assert.rejects(
            provision(harness, 'sbx_target'),
            /is not accepting commands/
        )
    })

    assert.equal(
        harness.reserveCalls.length,
        1,
        'the caller named one sandbox; failing over would silently ignore that'
    )
    assert.deepEqual(harness.bootstrappedOn, [])
    assert.deepEqual(
        harness.deletedRuntimeIds,
        [harness.reserveCalls[0].id],
        'the abandoned reservation must not leak a pending runtime row'
    )
    assert.deepEqual(
        harness.cooldowns.map((c) => c.hostId),
        ['sbx_target'],
        'the wedged VM still gets its diagnostic marker'
    )
    assert.ok(
        harness.cooldowns[0].until.getTime() > Date.now(),
        'a cooldown already in the past would record nothing'
    )
    assert.equal(
        harness.fetchCalls.filter((c) => c.method === 'POST').length,
        0,
        'a failed attach must not fall back to creating a VM'
    )
})

test('a transient sprite failure while bootstrapping an attached host quarantines that host', async () => {
    const harness = buildHarness({
        candidates: [{ id: 'sbx_reused', spriteName: 'sbx-reused' }],
        bootstrap: async () => {
            throw new SpritesError(
                'transient',
                'execSpriteStream handshake failed: HTTP 502',
                502,
                undefined,
                { execPhase: 'pre_open' }
            )
        }
    })

    await withStubbedSprites(harness, async () => {
        await assert.rejects(
            provision(harness, 'sbx_reused'),
            /handshake failed: HTTP 502/
        )
    })

    assert.deepEqual(
        harness.cooldowns.map((c) => c.hostId),
        ['sbx_reused'],
        'rollback keeps an attached host alive, so the wedge needs recording somewhere'
    )
    assert.deepEqual(harness.deletedRuntimeIds, [harness.reserveCalls[0].id])
    assert.deepEqual(
        harness.revokedHostIds,
        [],
        'a host shared with other runtimes must not be revoked by one failed create'
    )
})

test('a post-open probe failure removes the reservation without quarantining the host', async () => {
    const failure = new SpritesError(
        'permanent',
        'sandbox exec probe exited 127',
        undefined,
        undefined,
        { execPhase: 'post_open' }
    )
    const harness = buildHarness({
        candidates: [{ id: 'sbx_reused', spriteName: 'sbx-reused' }],
        probeErrors: { 'sbx-reused': failure }
    })

    await withStubbedSprites(harness, async () => {
        await assert.rejects(provision(harness, 'sbx_reused'), failure)
    })

    assert.deepEqual(harness.cooldowns, [])
    assert.deepEqual(harness.deletedRuntimeIds, [harness.reserveCalls[0].id])
    assert.deepEqual(harness.bootstrappedOn, [])
})

test('a non-transient bootstrap failure on an attached host records no cooldown', async () => {
    const harness = buildHarness({
        candidates: [{ id: 'sbx_reused', spriteName: 'sbx-reused' }],
        bootstrap: async () => {
            throw new SpritesError('auth', 'sprites token rejected', 401)
        }
    })

    await withStubbedSprites(harness, async () => {
        await assert.rejects(provision(harness, 'sbx_reused'), /token rejected/)
    })

    assert.deepEqual(
        harness.cooldowns,
        [],
        'a bad account token says nothing about the VM; marking it would mislead the next operator'
    )
})
