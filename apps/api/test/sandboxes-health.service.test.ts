import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpException } from '@nestjs/common'
import { auditAction } from '@manyfold/shared'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import type { SandboxHealthResult } from '../src/modules/sandboxes/health/sandbox-health.service'

// An admin's two levers on the maintenance stage: ask the provider now, and
// take a sandbox out by hand. Each answers with the sandbox as it now stands,
// or with a code the admin page can show, and each leaves an audit row naming
// the admin and the owner they acted for.

const host = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_1',
    userId: 'owner-1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: null },
    name: 'sandbox-001',
    status: 'ready',
    failureReason: null,
    powerState: 'stopped',
    keepAwake: false,
    terminalEnabled: false,
    terminalModelCredentials: false,
    emptiedAt: null,
    maintenanceSince: null,
    healthStatus: null,
    healthReason: null,
    healthCheckedAt: null,
    healthCheckNextAt: null,
    healthFailureCount: 0,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over
})

const build = (opts: {
    host?: Record<string, unknown>
    checkNow?: () => Promise<SandboxHealthResult>
    endMaintenance?: () => Promise<unknown>
}) => {
    let current = host(opts.host)
    const auditRows: Array<Record<string, unknown>> = []
    const view = () => ({
        host: current,
        provider: { id: 'rtp_1', name: 'org' },
        daemon: null,
        agentsCount: 1
    })
    const health = {
        checkNow: async () => {
            const result = await (opts.checkNow ??
                (async (): Promise<SandboxHealthResult> => ({
                    outcome: 'entered',
                    verdict: 'unhealthy',
                    reason: 'failed to start machine'
                })))()
            if (result.outcome === 'entered')
                current = host({
                    status: 'maintenance',
                    failureReason: 'Health check: unhealthy — failed to start machine',
                    maintenanceSince: new Date(),
                    healthStatus: 'unhealthy',
                    healthReason: 'failed to start machine',
                    healthCheckedAt: new Date(),
                    healthCheckNextAt: new Date(Date.now() + 120_000),
                    healthFailureCount: 1
                })
            return result
        },
        endMaintenance: async () => {
            const ended = await (opts.endMaintenance ??
                (async () => ({ id: 'sbx_1' })))()
            if (ended) current = host()
            return ended
        }
    }
    const svc = new SandboxesService(
        {
            getSandboxById: async () => view(),
            getSandboxForUser: async () => view()
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            getCachedLatest: async () => ({ channel: 'stable', version: null })
        } as never,
        {} as never,
        {} as never,
        { activeSecondsInPeriodByHost: async () => new Map() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            insert: () => ({
                values: (row: Record<string, unknown>) => {
                    auditRows.push(row)
                    return Promise.resolve()
                }
            })
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        health as never
    )
    return { svc, auditRows }
}

const codeOf = (err: unknown): string | undefined =>
    err instanceof HttpException
        ? (err.getResponse() as { code?: string }).code
        : undefined

test("an admin's check returns the sandbox as the verdict left it, and is audited", async () => {
    const h = build({})

    const summary = await h.svc.checkHealth('admin-1', 'sbx_1', true)

    assert.equal(summary.status, 'maintenance')
    assert.equal(summary.health?.status, 'unhealthy')
    assert.equal(summary.health?.failureCount, 1)
    assert.ok(summary.health?.nextCheckAt, 'a sandbox in maintenance says when it is next checked')
    assert.ok(summary.maintenanceSince)
    assert.equal(h.auditRows.length, 1)
    assert.equal(h.auditRows[0].action, auditAction.SANDBOX_HEALTH_CHECK)
    assert.equal(h.auditRows[0].actorId, 'admin-1')
    assert.deepEqual(h.auditRows[0].meta, {
        outcome: 'entered',
        verdict: 'unhealthy',
        previousStatus: 'ready',
        onBehalfOf: 'owner-1'
    })
})

test('a check that cannot run says why, with a code the page can show', async () => {
    for (const [outcome, status, code] of [
        ['in_progress', 409, 'SANDBOX_HEALTH_CHECK_IN_PROGRESS'],
        ['not_applicable', 409, 'SANDBOX_HEALTH_CHECK_NOT_APPLICABLE'],
        ['unsupported', 409, 'SANDBOX_HEALTH_CHECK_UNSUPPORTED'],
        ['gone', 409, 'SANDBOX_MACHINE_GONE'],
        ['error', 503, 'SANDBOX_HEALTH_CHECK_FAILED']
    ] as const) {
        const h = build({
            checkNow: async () => ({ outcome, error: 'bad gateway' })
        })
        await assert.rejects(
            h.svc.checkHealth('admin-1', 'sbx_1', true),
            (err: unknown) =>
                err instanceof HttpException &&
                err.getStatus() === status &&
                codeOf(err) === code
        )
        // Even a refused check is on the record.
        assert.equal(h.auditRows.length, 1, outcome)
    }
})

test('ending maintenance returns the sandbox ready and is audited; a sandbox not in maintenance is refused', async () => {
    const inMaintenance = build({
        host: {
            status: 'maintenance',
            failureReason: 'Health check: unhealthy — failed to start machine',
            maintenanceSince: new Date('2026-10-08T10:00:00Z')
        }
    })
    const summary = await inMaintenance.svc.endMaintenance('admin-1', 'sbx_1', true)
    assert.equal(summary.status, 'ready')
    assert.equal(summary.maintenanceSince, null)
    assert.equal(inMaintenance.auditRows[0].action, auditAction.SANDBOX_MAINTENANCE_END)
    assert.deepEqual(inMaintenance.auditRows[0].meta, {
        reason: 'Health check: unhealthy — failed to start machine',
        since: '2026-10-08T10:00:00.000Z',
        onBehalfOf: 'owner-1'
    })

    const ready = build({ endMaintenance: async () => null })
    await assert.rejects(
        ready.svc.endMaintenance('admin-1', 'sbx_1', true),
        (err: unknown) => codeOf(err) === 'SANDBOX_NOT_IN_MAINTENANCE'
    )
    assert.equal(ready.auditRows.length, 0)
})
