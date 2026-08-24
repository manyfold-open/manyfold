import {
    DAEMON_FEATURE_DAEMON_UPDATE,
    DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL,
    isCliUpdateAvailable
} from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BadRequestException, ConflictException } from '@nestjs/common'
import type { Database, RuntimeHostRow } from '@manyfold/db'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'u1',
        daemonUuid: 'uuid-1',
        name: 'laptop',
        hostname: 'laptop.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: '0.0.1',
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.manyfold/workspaces',
        detectedFrameworks: [],
        clientFeatures: ['daemon.update'],
        startupMethod: 'launchd-user',
        rpcLastSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastIp: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

const auditDb = { insert: () => ({ values: async () => undefined }) }

const DEV_TARGET = '1.3.0-dev.202608240920.a72f4de'

const makeService = (opts: {
    rpc?: (args: unknown) => Promise<Record<string, unknown> | undefined>
    latest?: string | null
    consume?: () => void
}): DaemonHostService =>
    new DaemonHostService(
        auditDb as unknown as Database,
        {} as never,
        {
            getCachedCliMinimumVersion: async () => ({ minVersion: null })
        } as never,
        {
            rpc:
                opts.rpc ??
                (async () => ({ toVersion: '1.2.0', restarting: true }))
        } as never,
        { consume: opts.consume ?? ((): void => {}) } as never,
        {
            getCachedLatest: async () => ({
                version: opts.latest ?? '1.2.0',
                channel: 'stable'
            })
        } as never,
        {
            isInstallableVersion: async () => true
        } as never,
        { get: () => 'local' } as never
    )

test('isCliUpdateAvailable: stable compares by semver, dev by exact build', () => {
    assert.equal(isCliUpdateAvailable('stable', '0.0.1', '0.1.0'), true)
    assert.equal(isCliUpdateAvailable('stable', '0.1.0', '0.1.0'), false)
    assert.equal(isCliUpdateAvailable('stable', '0.2.0', '0.1.0'), false)
    assert.equal(isCliUpdateAvailable('stable', '0.1.0', null), false)
    assert.equal(isCliUpdateAvailable('stable', null, '0.1.0'), true)
    assert.equal(
        isCliUpdateAvailable(
            'dev',
            '0.1.0-staging.1.abc',
            '0.1.0-staging.2.def'
        ),
        true
    )
    assert.equal(
        isCliUpdateAvailable(
            'dev',
            '0.1.0-staging.2.def',
            '0.1.0-staging.2.def'
        ),
        false
    )
})

test('toSummary surfaces latest version, updateAvailable and canRemoteUpgrade', async () => {
    const service = makeService({ latest: '1.2.0' })
    const summary = await service.toSummary(host({ cliVersion: '0.0.1' }), [], 0)
    assert.equal(summary.latestCliVersion, '1.2.0')
    assert.equal(summary.updateAvailable, true)
    assert.equal(summary.canRemoteUpgrade, true)
})

test('canRemoteUpgrade is false when the daemon does not advertise daemon.update', async () => {
    const service = makeService({ latest: '1.2.0' })
    const summary = await service.toSummary(
        host({ cliVersion: '0.0.1', clientFeatures: [] }),
        [],
        0
    )
    assert.equal(summary.updateAvailable, true)
    assert.equal(summary.canRemoteUpgrade, false)
})

test('upgrade refuses a manual daemon (cannot self-restart)', async () => {
    const service = makeService({})
    await assert.rejects(
        () =>
            service.upgrade({
                host: host({ startupMethod: 'manual' }),
                actorId: 'u1'
            }),
        BadRequestException
    )
})

test('upgrade refuses an offline daemon', async () => {
    const service = makeService({})
    await assert.rejects(
        () =>
            service.upgrade({
                host: host({ rpcLastSeenAt: new Date(Date.now() - 120_000) }),
                actorId: 'u1'
            }),
        BadRequestException
    )
})

test('upgrade dispatches daemon.update and returns versions for an eligible daemon', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const service = makeService({
        rpc: async (args) => {
            const a = args as { method: string; payload: unknown }
            calls.push({ method: a.method, payload: a.payload })
            return { toVersion: '1.2.0', restarting: true }
        }
    })

    const res = await service.upgrade({ host: host(), actorId: 'u1' })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'daemon.update')
    assert.deepEqual(calls[0].payload, { targetVersion: '1.2.0' })
    assert.equal(res.ok, true)
    assert.equal(res.fromVersion, '0.0.1')
    assert.equal(res.toVersion, '1.2.0')
    assert.equal(res.restarting, true)
})

// A cross-channel upgrade names the channel on the wire. Daemons built before
// the dev rename only accept `staging`/`stable` and would silently drop `dev`,
// then fetch the pinned version from their own CDN and 404 — so the wire value
// stays `staging` while the API speaks `dev` internally.
test('upgrade sends the pre-rename staging wire value for a dev target', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const service = makeService({
        rpc: async (args) => {
            const a = args as { method: string; payload: unknown }
            calls.push({ method: a.method, payload: a.payload })
            return { toVersion: DEV_TARGET, restarting: true }
        }
    })

    await service.upgrade({
        host: host({
            clientFeatures: [
                DAEMON_FEATURE_DAEMON_UPDATE,
                DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL
            ]
        }),
        actorId: 'u1',
        targetVersion: DEV_TARGET
    })

    assert.deepEqual(calls[0].payload, {
        targetVersion: DEV_TARGET,
        channel: 'staging'
    })
})

test('upgrade passes a drain deferral through so the admin sees it is not restarting yet', async () => {
    const service = makeService({
        rpc: async () => ({
            toVersion: '1.2.0',
            restarting: false,
            deferred: true,
            activeSessions: 3
        })
    })

    const res = await service.upgrade({ host: host(), actorId: 'u1' })

    assert.equal(res.ok, true)
    assert.equal(res.restarting, false)
    assert.equal(res.deferred, true)
    assert.equal(res.activeSessions, 3)
})

test('upgrade surfaces an actionable error when the daemon CLI predates daemon.update', async () => {
    const service = makeService({
        rpc: async () => {
            throw new Error('not_implemented: daemon.update')
        }
    })
    await assert.rejects(
        () => service.upgrade({ host: host(), actorId: 'u1' }),
        (err: Error) =>
            err instanceof ConflictException &&
            /too old to upgrade remotely/.test(err.message)
    )
})
