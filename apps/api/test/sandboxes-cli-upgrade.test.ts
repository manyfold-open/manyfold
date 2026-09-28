import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException
} from '@nestjs/common'
import { DAEMON_FEATURE_MANUAL_UPDATE } from '@manyfold/shared'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'

// The mf CLI on a sandbox is updated by the machine's own daemon (ADR-0029 §5,
// ADR-0037 R6): `daemon.update` over the host's RPC, nothing installed over
// it from outside and nothing restarted. The version it lands on reaches
// host_daemons through the daemon's next heartbeat, so the API records
// nothing itself.

const OLD = '0.31.2-dev.202609091242.909c84a'
const NEW = '0.33.1-dev.202609100748.ab03120'

// The sandbox held awake with its daemon reachable (ADR-0038): the session's
// rpc routes by the host id; a daemon the API holds no socket to is refused.
// `hold.held` is true for as long as the work runs.
const hostAccessFor = (opts: { online?: boolean }, host: { id: string }, daemon: unknown, rpc: (args: Record<string, unknown>) => Promise<unknown>, hold: { held: boolean }) => ({
    withHost: async (
        args: { host: { id: string } },
        work: (session: Record<string, unknown>) => Promise<unknown>
    ) => {
        if (opts.online === false)
            throw new HostDaemonOfflineError(host as never, 'runner_unavailable')
        hold.held = true
        try {
            return await work({
                host: args.host,
                daemon,
                daemonId: args.host.id,
                rpc: (call: Record<string, unknown>) => rpc({ daemonId: args.host.id, ...call })
            })
        } finally {
            hold.held = false
        }
    }
})

const buildHarness = (opts: {
    online?: boolean
    features?: string[]
    upgradeInProgress?: boolean
    rpcError?: Error
    installable?: boolean
    ack?: Record<string, unknown>
    successorBack?: boolean
}) => {
    const host = {
        id: 'sbx_1',
        userId: 'user_1',
        kind: 'hosted',
        providerId: 'rtp_1',
        providerRef: { kind: 'sprites', spriteName: 'art-1', spriteId: 'sprite-1' },
        name: 'sandbox-1',
        status: 'ready',
        powerState: 'suspended',
        keepAwake: false,
        terminalEnabled: false,
        terminalModelCredentials: false,
        emptiedAt: null,
        createdAt: new Date('2026-06-19T14:31:53Z'),
        updatedAt: new Date('2026-09-10T09:11:27Z')
    }
    const daemon = {
        hostId: 'sbx_1',
        cliVersion: OLD,
        herdrVersion: null,
        clientFeatures: opts.features ?? [DAEMON_FEATURE_MANUAL_UPDATE],
        detectedFrameworks: [],
        lastSeenAt: new Date()
    }
    const view = { host, provider: { id: 'rtp_1', kind: 'sprites', name: 'acct' }, daemon, agentsCount: 0 }
    const rpcs: Array<Record<string, unknown>> = []
    const rpc = async (args: Record<string, unknown>) => {
        rpcs.push(args)
        if (opts.rpcError) throw opts.rpcError
        return opts.ack ?? { toVersion: NEW, deferred: false }
    }
    const hold = { held: false }
    const waits: Array<{ before: unknown; polls: unknown; held: boolean }> = []
    const hostCli = {
        awaitSuccessor: async (_host: unknown, before: unknown, polls: unknown) => {
            waits.push({ before, polls, held: hold.held })
            return opts.successorBack === false ? null : { ...daemon, cliVersion: NEW }
        }
    }
    const svc = new SandboxesService(
        { getSandboxForUser: async () => view, getSandboxById: async () => view } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            getCachedLatest: async () => ({ channel: 'dev', version: NEW })
        } as never,
        { isInstallableVersion: async () => opts.installable !== false } as never,
        {} as never,
        { activeSecondsInPeriodByHost: async () => new Map() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            transaction: async (work: (tx: unknown) => Promise<unknown>) =>
                work({ execute: async () => [{ acquired: !opts.upgradeInProgress }] })
        } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        hostAccessFor(opts, host, daemon, rpc, hold) as never,
        hostCli as never
    )
    return { svc, rpcs, waits }
}

test('the daemon is asked to update itself, on the deploy channel when no target is named', async () => {
    const h = buildHarness({})
    const summary = await h.svc.upgradeCli('user_1', 'sbx_1')

    assert.equal(h.rpcs.length, 1)
    assert.equal(h.rpcs[0].daemonId, 'sbx_1', 'the routing key is the host id')
    assert.equal(h.rpcs[0].method, 'daemon.update')
    assert.deepEqual(h.rpcs[0].payload, { channel: 'dev' })
    assert.equal(summary.cliVersion, OLD, 'the row learns the new version from the heartbeat, not from here')
})

// The handoff to the successor is no platform activity: the machine stays
// held until the successor reports, or it freezes before dialing in.
test('a daemon that restarts on the new CLI keeps the machine held until its successor reports', async () => {
    const h = buildHarness({ ack: { toVersion: NEW, restarting: true } })
    await h.svc.upgradeCli('user_1', 'sbx_1')
    assert.deepEqual(h.waits, [{ before: OLD, polls: 30, held: true }])
})

test('an update the daemon deferred for its live sessions is not waited for', async () => {
    const h = buildHarness({
        ack: { toVersion: null, restarting: false, deferred: true, activeSessions: 1 }
    })
    await h.svc.upgradeCli('user_1', 'sbx_1')
    assert.deepEqual(h.waits, [])
})

test('a successor that does not report while held still answers the upgrade', async () => {
    const h = buildHarness({ ack: { toVersion: NEW, restarting: true }, successorBack: false })
    const summary = await h.svc.upgradeCli('user_1', 'sbx_1')
    assert.equal(summary.id, 'sbx_1')
    assert.equal(h.waits.length, 1)
})

test('a pinned target must be installable and picks its channel from the version string', async () => {
    const h = buildHarness({})
    await h.svc.upgradeCli('user_1', 'sbx_1', '0.33.0')
    assert.deepEqual(h.rpcs[0].payload, { channel: 'stable', targetVersion: '0.33.0' })

    const unknown = buildHarness({ installable: false })
    await assert.rejects(
        unknown.svc.upgradeCli('user_1', 'sbx_1', '9.9.9'),
        BadRequestException
    )
    assert.equal(unknown.rpcs.length, 0)
})

test('a competing CLI upgrade returns 409 before touching the daemon', async () => {
    const h = buildHarness({ upgradeInProgress: true })
    await assert.rejects(
        h.svc.upgradeCli('user_1', 'sbx_1'),
        (err: unknown) => err instanceof ConflictException && err.getStatus() === 409
    )
    assert.equal(h.rpcs.length, 0)
})

test('a sandbox whose daemon is offline cannot be upgraded until it is back', async () => {
    const h = buildHarness({ online: false })
    await assert.rejects(
        h.svc.upgradeCli('user_1', 'sbx_1'),
        (err: unknown) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code === 'SANDBOX_DAEMON_OFFLINE'
    )
    assert.equal(h.rpcs.length, 0)
})

test('a daemon below the self-update floor is refused rather than installed over', async () => {
    const h = buildHarness({ features: [] })
    await assert.rejects(
        h.svc.upgradeCli('user_1', 'sbx_1'),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code === 'SANDBOX_DAEMON_TOO_OLD'
    )
})

test('a failed daemon.update surfaces as 503', async () => {
    const h = buildHarness({ rpcError: new Error('daemon is applying an update') })
    await assert.rejects(
        h.svc.upgradeCli('user_1', 'sbx_1'),
        (err: unknown) =>
            err instanceof ServiceUnavailableException &&
            /daemon is applying an update/.test((err as Error).message)
    )
})
