import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import {
    DAEMON_FEATURE_EXEC_ROOTS,
    DAEMON_FEATURE_MANUAL_UPDATE,
    DAEMON_FEATURE_SERVICES,
    DAEMON_MIN_CLI_VERSION
} from '@manyfold/shared'
import {
    HostCliService,
    type HostCliRefusal
} from '../src/modules/hosts/bring-up/host-cli.service'
import { CLI_AT_FLOOR, CLI_BELOW_FLOOR } from './helpers/cli-floor'

// A hosted machine's mf CLI (ADR-0035 §5, ADR-0038): how it is updated, and
// how a caller that needs more of it than the host has gets it updated first.
// The machine's daemon is the host's daemon (ADR-0037): host_daemons for the
// host.

const host = () =>
    ({
        id: 'pdh_1',
        userId: 'usr_1',
        kind: 'hosted',
        providerId: 'rtp_k8s',
        providerRef: { kind: 'k8s', namespace: 'nca-user-1', ingressHost: null, podPhase: 'Running' },
        name: 'computer-001',
        status: 'ready',
        generation: 1
    }) as never

const daemon = (over: Record<string, unknown> = {}) =>
    ({
        hostId: 'pdh_1',
        userId: 'usr_1',
        cliVersion: '3.0.1',
        clientFeatures: [],
        startupMethod: 'container',
        lastSeenAt: new Date(),
        rpcInstanceId: 'api-1',
        rpcConnectedAt: new Date(),
        ...over
    }) as never

// Reachable is the rpc lease (ADR-0038): a daemon the API holds no socket to
// has none, however fresh its last heartbeat.
const offline = { rpcInstanceId: null, rpcConnectedAt: null }

class InstantHostCli extends HostCliService {
    delays = 0

    protected override delay(): Promise<void> {
        this.delays++
        return Promise.resolve()
    }
}

// The daemon's registration, as each re-read after the update finds it: the
// last one repeats.
const build = (
    over: {
        registrations?: unknown[]
        latest?: { version: string | null; channel: 'stable' | 'dev' }
        // what the daemon answers an update: `deferred` while it has work
        deferred?: boolean
    } = {}
) => {
    const upgrades: unknown[] = []
    const scripts: string[] = []
    const registrations = over.registrations ?? []
    let read = 0
    let generation = 1
    const hostDaemons = {
        findByHostId: async () =>
            registrations[Math.min(read++, registrations.length - 1)] ?? null
    }
    const daemonHosts = {
        upgrade: async (args: unknown) => {
            upgrades.push(args)
            return over.deferred
                ? { ok: true, deferred: true, activeSessions: 2 }
                : { ok: true }
        }
    }
    const cliVersion = {
        getCachedLatest: async () =>
            over.latest ?? { version: '4.6.0', channel: 'stable' }
    }
    const adapter = {
        bootstrap: async (req: { script: string; generation: number }) => {
            scripts.push(req.script)
            assert.equal(req.generation, generation, 'the install runs under the bumped generation')
            return { exitCode: 0, stdout: 'mf-upgraded=4.6.0\n', stderr: '' }
        }
    }
    const cli = new InstantHostCli(
        daemonHosts as never,
        hostDaemons as never,
        { bumpGeneration: async () => ++generation } as never,
        cliVersion as never,
        { isInstallableVersion: async () => true } as never,
        { providerForHost: async () => ({ id: 'rtp_k8s', kind: 'k8s' }) } as never,
        { for: () => adapter } as never
    )
    return { cli, upgrades, scripts }
}

test('a connected daemon its host restarts updates itself', async () => {
    const rig = build({ registrations: [daemon()] })
    await rig.cli.update({ host: host(), actorId: 'usr_1', targetVersion: '4.6.0' })
    assert.deepEqual(rig.upgrades, [
        { host: host(), actorId: 'usr_1', targetVersion: '4.6.0' }
    ])
    assert.deepEqual(rig.scripts, [])
})

test('a daemon from an older image is installed over, then left to the boot loop', async () => {
    const rig = build({ registrations: [daemon({ startupMethod: 'manual' })] })
    await rig.cli.update({ host: host(), actorId: 'usr_1', targetVersion: '4.6.0' })
    assert.deepEqual(rig.upgrades, [])
    assert.equal(rig.scripts.length, 1)
    assert.match(rig.scripts[0], /VERSION="4\.6\.0"/)
    assert.match(rig.scripts[0], /MF_INSTALL_DIR="\$HOME\/\.local\/bin"/)
    assert.match(rig.scripts[0], /pkill -TERM -x mf/)
})

test('a daemon that has what the caller needs is used as it is', async () => {
    const current = daemon({ clientFeatures: [DAEMON_FEATURE_SERVICES] })
    const rig = build({ registrations: [current] })
    const got = await rig.cli.ensure(host(), { features: [DAEMON_FEATURE_SERVICES] })
    assert.equal(got, current)
    assert.deepEqual(rig.upgrades, [])
    assert.equal(rig.cli.delays, 0)
})

test('a daemon without what the caller needs is updated, and used once it is back', async () => {
    const back = daemon({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_SERVICES]
    })
    // The first reads still find the old registration.
    const rig = build({ registrations: [daemon(), daemon(), daemon(), back] })
    const got = await rig.cli.ensure(host(), { features: [DAEMON_FEATURE_SERVICES] })
    assert.equal(got, back)
    assert.equal(rig.upgrades.length, 1)
    assert.equal(rig.cli.delays, 2)
})

test('a daemon below the floor is installed over, since it never comes online', async () => {
    const rig = build({
        registrations: [
            daemon({ cliVersion: CLI_BELOW_FLOOR, ...offline }),
            daemon({ cliVersion: CLI_BELOW_FLOOR, ...offline }),
            daemon({ cliVersion: CLI_AT_FLOOR })
        ],
        latest: { version: CLI_AT_FLOOR, channel: 'stable' }
    })
    const got = await rig.cli.ensure(host(), { minVersion: DAEMON_MIN_CLI_VERSION })
    assert.equal((got as { cliVersion: string }).cliVersion, CLI_AT_FLOOR)
    assert.deepEqual(rig.upgrades, [])
    assert.equal(rig.scripts.length, 1)
})

test('a daemon already on the latest CLI has nothing to update to', async () => {
    const rig = build({
        registrations: [daemon()],
        latest: { version: '3.0.1', channel: 'stable' }
    })
    await assert.rejects(
        rig.cli.ensure(host(), { features: [DAEMON_FEATURE_SERVICES] }),
        (err: { response?: { code?: string }; refusal: HostCliRefusal }) => {
            assert.equal(err.response?.code, 'POD_HOST_DAEMON_TOO_OLD')
            // Kept for a caller that reports it under its own code.
            assert.match(
                err.refusal.message,
                /already runs the latest Manyfold CLI \(3\.0\.1\)/
            )
            assert.equal(err.refusal.cliVersion, '3.0.1')
            assert.equal(err.refusal.latestCliVersion, '3.0.1')
            return true
        }
    )
    assert.deepEqual(rig.upgrades, [])
})

test('an update that does not bring what is needed is refused', async () => {
    const rig = build({ registrations: [daemon(), daemon(), daemon({ cliVersion: '4.5.0' })] })
    await assert.rejects(
        rig.cli.ensure(host(), { features: [DAEMON_FEATURE_SERVICES] }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.equal(rig.upgrades.length, 1)
})

test('a daemon that never comes back is given about three minutes', async () => {
    const rig = build({ registrations: [daemon()] })
    await assert.rejects(
        rig.cli.ensure(host(), { features: [DAEMON_FEATURE_SERVICES] }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.equal(rig.cli.delays, 60)
})

test('the successor of an update is its registration on another CLI over a live lease', async () => {
    const back = daemon({ cliVersion: '4.6.0' })
    const rig = build({
        registrations: [daemon(), daemon({ cliVersion: '4.6.0', ...offline }), back]
    })
    const got = await rig.cli.awaitSuccessor(host(), '3.0.1', 5)
    assert.equal(got, back)
    assert.equal(rig.cli.delays, 3)
})

test('a successor that does not report within its polls is not there', async () => {
    const rig = build({ registrations: [daemon()] })
    assert.equal(await rig.cli.awaitSuccessor(host(), '3.0.1', 4), null)
    assert.equal(rig.cli.delays, 4)
})

test('callers that need the same host updated share one update', async () => {
    const back = daemon({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_SERVICES]
    })
    const rig = build({ registrations: [daemon(), daemon(), back] })
    const need = { features: [DAEMON_FEATURE_SERVICES] }
    const [a, b] = await Promise.all([
        rig.cli.ensure(host(), need),
        rig.cli.ensure(host(), need)
    ])
    assert.equal(a, back)
    assert.equal(b, back)
    assert.equal(rig.upgrades.length, 1)
})

// A sprite has no boot loop: its daemon updates by handing off to its
// successor (daemon.update.manual), and nothing would restart one installed
// over, so there is no install-over to fall back to.
const spriteHost = () =>
    ({
        id: 'sbx_1',
        userId: 'usr_1',
        kind: 'hosted',
        providerId: 'rtp_sprites',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'spr_1' },
        name: 'sandbox-1',
        status: 'ready',
        generation: 1
    }) as never

const spriteDaemon = (over: Record<string, unknown> = {}) =>
    daemon({
        hostId: 'sbx_1',
        startupMethod: 'manual',
        clientFeatures: [DAEMON_FEATURE_MANUAL_UPDATE],
        ...over
    })

test('a connected sprite daemon updates itself by handing off', async () => {
    const rig = build({ registrations: [spriteDaemon()] })
    await rig.cli.update({ host: spriteHost(), actorId: 'usr_1' })
    assert.deepEqual(rig.upgrades, [{ host: spriteHost(), actorId: 'usr_1', targetVersion: undefined }])
    assert.deepEqual(rig.scripts, [])
})

test('a sprite daemon that cannot update itself is too old, and nothing is installed over it', async () => {
    const rig = build({ registrations: [spriteDaemon({ clientFeatures: [] })] })
    await assert.rejects(
        rig.cli.update({ host: spriteHost(), actorId: 'usr_1' }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'SANDBOX_DAEMON_TOO_OLD'
    )
    assert.deepEqual(rig.upgrades, [])
    assert.deepEqual(rig.scripts, [])
})

test('a sprite daemon without a feature is updated and used once its successor has it', async () => {
    const back = spriteDaemon({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_MANUAL_UPDATE, DAEMON_FEATURE_EXEC_ROOTS]
    })
    const rig = build({ registrations: [spriteDaemon(), spriteDaemon(), back] })
    const got = await rig.cli.ensure(spriteHost(), { features: [DAEMON_FEATURE_EXEC_ROOTS] })
    assert.equal(got, back)
    assert.equal(rig.upgrades.length, 1)
})

test('every feature a caller needs has to be there', async () => {
    const partial = spriteDaemon({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_MANUAL_UPDATE, DAEMON_FEATURE_EXEC_ROOTS]
    })
    const rig = build({ registrations: [spriteDaemon(), partial] })
    await assert.rejects(
        rig.cli.ensure(spriteHost(), {
            features: [DAEMON_FEATURE_EXEC_ROOTS, DAEMON_FEATURE_SERVICES]
        }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'SANDBOX_DAEMON_TOO_OLD'
    )
})

// A daemon with work in progress defers the update, takes no new work, and
// updates when that work ends or its own drain deadline passes. The caller is
// told to retry soon instead of waiting minutes for a successor, and the update
// is not asked for again while it drains: re-asking re-armed the deadline.
test('a daemon that defers the update for its current work is left to drain', async () => {
    const rig = build({ registrations: [spriteDaemon()], deferred: true })
    await assert.rejects(
        rig.cli.ensure(spriteHost(), { features: [DAEMON_FEATURE_EXEC_ROOTS] }),
        (err: { response?: { code?: string; message?: string } }) =>
            err.response?.code === 'SANDBOX_DAEMON_UPDATING' &&
            /once its current work finishes/.test(err.response?.message ?? '')
    )
    assert.equal(rig.upgrades.length, 1)
    assert.ok(rig.cli.delays < 10, 'the caller waits a moment, not minutes')
    await assert.rejects(
        rig.cli.ensure(spriteHost(), { features: [DAEMON_FEATURE_EXEC_ROOTS] }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'SANDBOX_DAEMON_UPDATING'
    )
    assert.equal(rig.upgrades.length, 1, 'no second request while it drains')
})

test('a drained daemon is used once its successor is back', async () => {
    const back = spriteDaemon({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_MANUAL_UPDATE, DAEMON_FEATURE_EXEC_ROOTS]
    })
    const rig = build({
        registrations: [spriteDaemon(), spriteDaemon(), back],
        deferred: true
    })
    const got = await rig.cli.ensure(spriteHost(), {
        features: [DAEMON_FEATURE_EXEC_ROOTS]
    })
    assert.equal(got, back)
})
