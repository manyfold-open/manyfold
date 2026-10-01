import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException
} from '@nestjs/common'
import {
    DAEMON_FEATURE_MANUAL_UPDATE,
    DAEMON_UPDATE_IN_PROGRESS_ERROR
} from '@manyfold/shared'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'

// The mf CLI on a sandbox is updated by the machine's own daemon (ADR-0029 §5,
// ADR-0037 R6): `daemon.update` over the host's RPC, nothing installed over
// it from outside and nothing restarted. The version it lands on reaches
// host_daemons through the daemon's next heartbeat, so the API records
// nothing itself.

const OLD = '0.31.2-dev.202609091242.909c84a'
const NEW = '0.33.1-dev.202609100748.ab03120'
// When a deferring daemon applies the update at the latest.
const DEADLINE = new Date('2026-09-30T15:28:58Z')

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
    startupMethod?: string
    upgradeInProgress?: boolean
    rpcError?: Error
    installable?: boolean
    ack?: Record<string, unknown>
    successorBack?: boolean
    latest?: string
    cliVersion?: string
    // a drain this instance already holds the sandbox for
    drain?: { before: string; activeSessions: number; deadline: Date }
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
        cliVersion: opts.cliVersion ?? OLD,
        herdrVersion: null,
        startupMethod: opts.startupMethod ?? 'manual',
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
    // Drains handed to the background hold, and whether the request still
    // held the machine when it handed them over.
    const drains: Array<{ before: unknown; activeSessions: unknown; held: boolean }> = []
    let drain = opts.drain ?? null
    const hostCli = {
        awaitSuccessor: async (_host: unknown, before: unknown, polls: unknown) => {
            waits.push({ before, polls, held: hold.held })
            return opts.successorBack === false ? null : { ...daemon, cliVersion: NEW }
        },
        holdThroughDrain: (_host: unknown, before: string, activeSessions: number) => {
            drains.push({ before, activeSessions, held: hold.held })
            drain = { before, activeSessions, deadline: DEADLINE }
            return Promise.resolve(null)
        },
        deferredUpdate: () => drain
    }
    const svc = new SandboxesService(
        { getSandboxForUser: async () => view, getSandboxById: async () => view } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            getCachedLatest: async () => ({ channel: 'dev', version: opts.latest ?? NEW })
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
    return { svc, rpcs, waits, drains }
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

// WHY the drain is held: a deferred update lands only while the machine is
// up; let go on the ack, the sandbox slept under the drain and the update
// waited for its next wake.
test('an update the daemon deferred is answered now and held through the drain', async () => {
    const h = buildHarness({
        ack: { toVersion: null, restarting: false, deferred: true, activeSessions: 1 }
    })
    const summary = await h.svc.upgradeCli('user_1', 'sbx_1')
    assert.deepEqual(h.waits, [], 'the request does not wait for the drain')
    assert.deepEqual(h.drains, [{ before: OLD, activeSessions: 1, held: true }])
    assert.equal(summary.cliVersion, OLD)
    assert.deepEqual(summary.cliUpdateDeferred, {
        activeSessions: 1,
        deadline: DEADLINE.toISOString()
    })
})

// WHY: answered with the old version alone, a deferred update read as done
// ("mf CLI upgraded to v<old>") and as finished in the Update Center.
test('a sandbox shows its deferred update until the daemon reports another CLI', async () => {
    const drain = { before: OLD, activeSessions: 2, deadline: DEADLINE }
    const draining = buildHarness({ drain })
    assert.deepEqual((await draining.svc.get('user_1', 'sbx_1')).cliUpdateDeferred, {
        activeSessions: 2,
        deadline: DEADLINE.toISOString()
    })
    const landed = buildHarness({ drain, cliVersion: NEW })
    const summary = await landed.svc.get('user_1', 'sbx_1')
    assert.equal('cliUpdateDeferred' in summary, false, 'the successor reported first')
    const idle = await buildHarness({}).svc.get('user_1', 'sbx_1')
    assert.equal('cliUpdateDeferred' in idle, false)
})

test('a deferred update that brings no other CLI is not held', async () => {
    const deferred = { toVersion: null, restarting: false, deferred: true, activeSessions: 1 }
    const pinned = buildHarness({ ack: deferred })
    await pinned.svc.upgradeCli('user_1', 'sbx_1', OLD)
    assert.deepEqual(pinned.drains, [], 'pinned to the version it runs')
    const latest = buildHarness({ ack: deferred, latest: OLD })
    await latest.svc.upgradeCli('user_1', 'sbx_1')
    assert.deepEqual(latest.drains, [], 'already on the channel latest')
})

// WHY: a daemon frozen mid-apply answers "already in progress" until it runs
// again. Seen on staging [2026-09-30]: a re-ask answered 503 while the
// update was one wake away from landing.
test('a re-ask while the daemon applies its update waits for the successor like a restart', async () => {
    const h = buildHarness({
        rpcError: new DaemonRpcResponseError(DAEMON_UPDATE_IN_PROGRESS_ERROR)
    })
    const summary = await h.svc.upgradeCli('user_1', 'sbx_1')
    assert.equal(summary.id, 'sbx_1')
    assert.deepEqual(h.waits, [{ before: OLD, polls: 30, held: true }])
    assert.deepEqual(h.drains, [])
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

// A daemon under its sprite's supervised loop updates by exiting and is
// started again by the loop, so it takes the update without the manual
// hand-off feature.
test('a supervised daemon is updated through daemon.update', async () => {
    const h = buildHarness({ features: [], startupMethod: 'container' })
    await h.svc.upgradeCli('user_1', 'sbx_1')
    assert.equal(h.rpcs.length, 1)
    assert.equal(h.rpcs[0].method, 'daemon.update')
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
