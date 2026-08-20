import type { AgentRuntimeSummary } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ForbiddenException,
    NotFoundException
} from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'
import { AgentRuntimesController } from '../src/modules/agent-runtimes/agent-runtimes.controller'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'

// PATCH /agent-runtimes/:id/keep-alive contracts: every sprite framework is
// eligible (coding agents run a lease-only keep-alive), non-sprite runtimes
// are rejected, quota-family reuse (the existing CONCURRENT_ACTIVE_LIMIT_REACHED
// envelope), and fail-soft enable are API contracts, not implementation
// details. The real SpritesProvisioner sits between the controller and the
// stubbed seams so the propagate-vs-swallow split is exercised through
// production code.

const user = { userId: 'user-1' } as AuthPrincipal

const runtimeRow = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'hermes',
        kind: 'sprites',
        status: 'ready',
        currentPhase: null,
        failureReason: null,
        accountId: 'spa_test',
        spriteName: 'art-test',
        spriteId: 'sprite-1',
        clusterId: null,
        daemonId: null,
        hostId: 'host-test',
        homeDir: '/home/sprite',
        workspaceBaseDir: null,
        capabilitiesJson: {},
        lastSeenAt: null,
        namespace: null,
        ingressHost: null,
        mountPath: '/home/sprite',
        primaryAgentId: null,
        controlUiEnabled: false,
        dashboardEnabled: false,
        keepAliveEnabled: false,
        startedAt: null,
        lastBootstrappedAt: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

const buildHarness = (opts: {
    row: AgentRuntimeRow | null
    enableKeepAlive?: () => Promise<void>
    ensureServiceRunning?: () => Promise<{ started: boolean }>
}) => {
    const calls: string[] = []
    let stored = opts.row
    const runtimes = {
        findById: async (id: string) =>
            stored && stored.id === id ? stored : null,
        setKeepAliveEnabled: async (id: string, enabled: boolean) => {
            calls.push(`setKeepAliveEnabled:${enabled}`)
            if (stored && stored.id === id)
                stored = { ...stored, keepAliveEnabled: enabled }
        },
        toSummary: async (row: AgentRuntimeRow) => {
            calls.push('toSummary')
            return {
                id: row.id,
                keepAliveEnabled: row.keepAliveEnabled
            } as AgentRuntimeSummary
        }
    }
    const runtimeAccess = {
        enableKeepAlive: async (input: { runtimeId: string }) => {
            calls.push('enableKeepAlive')
            if (opts.enableKeepAlive) await opts.enableKeepAlive()
            // mirrors the real in-tx UPDATE: admission and the column
            // commit are atomic, before any sprite-side op
            if (stored && stored.id === input.runtimeId)
                stored = { ...stored, keepAliveEnabled: true }
        }
    }
    const keepAliveLease = {
        ensureServiceRunning: async () => {
            calls.push('ensureServiceRunning')
            return opts.ensureServiceRunning
                ? opts.ensureServiceRunning()
                : { started: false }
        },
        ensureLease: async () => {
            calls.push('ensureLease')
        },
        releaseLease: async () => {
            calls.push('releaseLease')
        }
    }
    const provisioner = new SpritesProvisioner(
        {} as never,
        {} as never,
        runtimes as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        runtimeAccess as never,
        { get: () => undefined } as never,
        {} as never,
        keepAliveLease as never,
        { settleHostNotRunning: async () => {} } as never
    )
    const controller = new AgentRuntimesController(
        {} as never,
        runtimes as never,
        provisioner,
        {} as never,
        {} as never
    )
    return { controller, calls }
}

test('PATCH keep-alive enables an exec-kind sprite (claude-code) via the lease path', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ framework: 'claude-code' })
    })

    const summary = await controller.setKeepAlive(user, 'art_test', {
        enabled: true
    })

    // WHY: a coding sprite's keep-alive IS the renewing /v1/tasks lease — the
    // same quota-gated switch as a service sprite, minus a service to
    // supervise. ensureServiceRunning no-ops server-side for exec-kind, so the
    // lease alone holds the VM awake.
    assert.equal(summary.keepAliveEnabled, true)
    assert.deepEqual(calls, [
        'enableKeepAlive',
        'ensureServiceRunning',
        'ensureLease',
        'toSummary'
    ])
})

test('PATCH keep-alive 400s with KEEP_ALIVE_UNSUPPORTED for a k8s runtime', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ kind: 'k8s', framework: 'openclaw' })
    })

    await assert.rejects(
        controller.setKeepAlive(user, 'art_test', { enabled: true }),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            const res = err.getResponse() as { code?: string }
            assert.equal(
                res.code,
                'KEEP_ALIVE_UNSUPPORTED',
                'k8s runtimes are always-on by design — a service framework alone must not pass the sprites-only gate'
            )
            return true
        }
    )
    assert.deepEqual(
        calls,
        [],
        'the kind/framework guard must reject before any flag write or sprite op'
    )
})

test('enable propagates the 403 CONCURRENT_ACTIVE_LIMIT_REACHED envelope unchanged', async () => {
    const quotaError = new ForbiddenException({
        message: 'concurrent active sprite limit reached (1 for free plan)',
        code: 'CONCURRENT_ACTIVE_LIMIT_REACHED',
        current: 1,
        limit: 1,
        planName: 'free'
    })
    const { controller, calls } = buildHarness({
        row: runtimeRow(),
        enableKeepAlive: async () => {
            throw quotaError
        }
    })

    await assert.rejects(
        controller.setKeepAlive(user, 'art_test', { enabled: true }),
        (err: unknown) => {
            assert.equal(
                err,
                quotaError,
                'the quota rejection must surface as-is — the existing envelope is what the web error plumbing recognizes'
            )
            const res = (err as ForbiddenException).getResponse() as Record<
                string,
                unknown
            >
            assert.equal(res.code, 'CONCURRENT_ACTIVE_LIMIT_REACHED')
            assert.equal(res.current, 1)
            assert.equal(res.limit, 1)
            assert.equal(res.planName, 'free')
            return true
        }
    )
    assert.deepEqual(
        calls,
        ['enableKeepAlive'],
        'a refused enable must not wake the sprite or return a summary'
    )
})

test('enable returns keepAliveEnabled=true even when sprite-side ops throw (fail-soft)', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow(),
        ensureServiceRunning: async () => {
            throw new Error('sprite exec failed')
        }
    })

    const summary = await controller.setKeepAlive(user, 'art_test', {
        enabled: true
    })

    assert.equal(
        summary.keepAliveEnabled,
        true,
        'the committed column is the contract — reconcile Pass B converges a degraded enable within ~60s, so the API must not 500'
    )
    assert.deepEqual(
        calls,
        ['enableKeepAlive', 'ensureServiceRunning', 'toSummary'],
        'sprite ops stay best-effort after the atomic commit; the failed wake is swallowed, not retried inline'
    )
})

test('PATCH keep-alive 404s on ownership mismatch', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ userId: 'user-2' })
    })

    await assert.rejects(
        controller.setKeepAlive(user, 'art_test', { enabled: true }),
        (err: unknown) => err instanceof NotFoundException
    )
    assert.deepEqual(
        calls,
        [],
        "404 like get() so a foreign runtime's existence is not leaked, and nothing is toggled"
    )
})
