import test from 'node:test'
import assert from 'node:assert/strict'
import { HostPowerSyncService } from '../src/modules/agents/sprite-status/host-power-sync.service'
import { AutomationsService } from '../src/modules/automations/automations.service'
import { UserExportService } from '../src/modules/user-export/user-export.service'
import { UserDeletionService } from '../src/modules/user-deletion/user-deletion.service'
import { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'
import { AppEventsService } from '../src/common/events/app-events.service'

// #843: background work nobody awaits must not let a database failure escape,
// because the API exits on an unhandled rejection. Seen on prod and staging
// [2026-09-22]: a shared PgBouncer drop rejected in-flight queries with
// CONNECTION_CLOSED and an unawaited path took a process down in each.

// The shape postgres.js gives every connection-level failure (Errors.connection:
// code === errno). postgres-connection-close.pg.test.ts checks a real one.
const connectionError = (): Error =>
    Object.assign(
        new Error('write CONNECTION_CLOSED pgbouncer.fixture.internal:5432'),
        {
            code: 'CONNECTION_CLOSED',
            errno: 'CONNECTION_CLOSED',
            address: 'pgbouncer.fixture.internal',
            port: 5432
        }
    )

// Every builder call returns the chain; awaiting any of it rejects.
const failingDb = (error: Error): never => {
    const chain: object = new Proxy(function () {}, {
        get: (_target, prop) =>
            prop === 'then'
                ? (_resolve: unknown, reject: (err: Error) => void) =>
                      reject(error)
                : chain,
        apply: () => chain
    })
    return chain as never
}

// Fails the test on any rejection that nothing handled while `run` settles.
const withoutUnhandledRejections = async (
    run: () => Promise<void> | void
): Promise<void> => {
    const leaked: unknown[] = []
    const listener = (reason: unknown): void => {
        leaked.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
        await run()
        await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
        process.off('unhandledRejection', listener)
    }
    assert.deepEqual(leaked, [])
}

test('the host power tick survives a dropped database connection', async () => {
    const svc = new HostPowerSyncService(
        failingDb(connectionError()),
        {} as never,
        {} as never,
        { adapters: () => [{ kind: 'sprites', observe: () => undefined }] } as never,
        {} as never,
        { event: () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    await withoutUnhandledRejections(async () => {
        await assert.doesNotReject(svc.tick())
        // The in-flight latch is released, so the next wakeup runs again.
        await assert.doesNotReject(svc.tick())
    })
})

test('the host power tick on an old machine survives a column a migration dropped', async () => {
    // Seen on staging [2026-09-30]: migration 0031 dropped
    // runtime_hosts.primary_agent_id while the old machine still ran; its
    // tick's full-column host select failed and the process exited.
    const dropped = Object.assign(
        new Error('column "primary_agent_id" does not exist'),
        { name: 'PostgresError', code: '42703' }
    )
    const svc = new HostPowerSyncService(
        failingDb(dropped),
        {} as never,
        {} as never,
        { adapters: () => [{ kind: 'sprites', observe: () => undefined }] } as never,
        {} as never,
        { event: () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    await withoutUnhandledRejections(async () => {
        await assert.doesNotReject(svc.tick())
    })
})

test('the automation scheduler tick survives a dropped database connection', async () => {
    const svc = new AutomationsService(
        failingDb(connectionError()),
        {} as never,
        { get: () => 'false' } as never,
        {} as never
    )
    const tick = (): Promise<void> =>
        (svc as unknown as { tick: () => Promise<void> }).tick()
    await withoutUnhandledRejections(async () => {
        await assert.doesNotReject(tick())
        await assert.doesNotReject(tick())
    })
})

test('background export and deletion sweeps keep a database failure to a log line', async () => {
    const db = failingDb(connectionError())
    const exports = new UserExportService(
        db,
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never
    )
    const deletions = new UserDeletionService(
        db,
        {} as never,
        {} as never,
        { get: () => undefined } as never,
        {} as never
    )
    await withoutUnhandledRejections(() => {
        exports.sweepInBackground()
        deletions.sweepInBackground()
    })
    // The awaited entry points still report the failure to their caller.
    await assert.rejects(exports.sweep(), /CONNECTION_CLOSED/)
})

test('a forced daemon disconnect keeps a lease-clear failure to a log line', async () => {
    const registry = new DaemonRegistryService(
        failingDb(connectionError()),
        { get: () => undefined } as never
    )
    // The socket is held locally before the identity write fails, so the
    // disconnect below has a lease to clear.
    await assert.rejects(
        registry.register({
            daemonId: 'dh_fixture',
            userId: 'usr_fixture',
            cliVersion: null,
            hostname: null,
            socket: { close: () => {} } as never
        }),
        /CONNECTION_CLOSED/
    )
    await withoutUnhandledRejections(() => {
        registry.disconnect('dh_fixture', 'fixture disconnect')
    })
})

test('a ready-service touch keeps a lookup failure to a log line', async () => {
    const events = new AppEventsService()
    new AgentReconcileService(
        failingDb(connectionError()),
        {} as never,
        {} as never,
        undefined,
        events
    )
    await withoutUnhandledRejections(() => {
        events.emit('runtime.service.ready', {
            runtimeId: 'art_fixture',
            framework: 'openclaw'
        })
    })
})
