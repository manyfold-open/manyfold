import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { DAEMON_FEATURE_SERVICES, DAEMON_MIN_CLI_VERSION } from '@manyfold/shared'
import { PodHostCliService } from '../src/modules/chat/runner/pod-host-cli.service'
import { CLI_AT_FLOOR, CLI_BELOW_FLOOR } from './helpers/cli-floor'

// A cloud computer's mf CLI (ADR-0035 §5): how it is updated, and how a
// caller that needs more of it than the host has gets it updated first. The
// pod's daemon is the host's daemon (ADR-0037): host_daemons for the host.

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

class InstantPodHostCli extends PodHostCliService {
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
            return { ok: true }
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
    const cli = new InstantPodHostCli(
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
    const got = await rig.cli.ensure(host(), { feature: DAEMON_FEATURE_SERVICES })
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
    const got = await rig.cli.ensure(host(), { feature: DAEMON_FEATURE_SERVICES })
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
        rig.cli.ensure(host(), { feature: DAEMON_FEATURE_SERVICES }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.deepEqual(rig.upgrades, [])
})

test('an update that does not bring what is needed is refused', async () => {
    const rig = build({ registrations: [daemon(), daemon(), daemon({ cliVersion: '4.5.0' })] })
    await assert.rejects(
        rig.cli.ensure(host(), { feature: DAEMON_FEATURE_SERVICES }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.equal(rig.upgrades.length, 1)
})

test('a daemon that never comes back is given about three minutes', async () => {
    const rig = build({ registrations: [daemon()] })
    await assert.rejects(
        rig.cli.ensure(host(), { feature: DAEMON_FEATURE_SERVICES }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.equal(rig.cli.delays, 60)
})

test('callers that need the same host updated share one update', async () => {
    const back = daemon({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_SERVICES]
    })
    const rig = build({ registrations: [daemon(), daemon(), back] })
    const need = { feature: DAEMON_FEATURE_SERVICES }
    const [a, b] = await Promise.all([
        rig.cli.ensure(host(), need),
        rig.cli.ensure(host(), need)
    ])
    assert.equal(a, back)
    assert.equal(b, back)
    assert.equal(rig.upgrades.length, 1)
})
