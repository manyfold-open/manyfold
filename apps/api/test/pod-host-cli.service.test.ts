import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import {
    DAEMON_FEATURE_SERVICES,
    DAEMON_MIN_CLI_VERSION,
    podRunnerHostName
} from '@manyfold/shared'
import { PodHostCliService } from '../src/modules/chat/runner/pod-host-cli.service'
import { CLI_AT_FLOOR, CLI_BELOW_FLOOR } from './helpers/cli-floor'

// A cloud computer's mf CLI (ADR-0035 §5): how it is updated, and how a
// caller that needs more of it than the host has gets it updated first.

const host = () =>
    ({
        id: 'pdh_1',
        userId: 'usr_1',
        kind: 'pod',
        name: 'computer-001',
        clusterId: 'clus_1',
        namespace: 'nca-user-1'
    }) as never

const runner = (over: Record<string, unknown> = {}) =>
    ({
        id: 'dh_runner',
        userId: 'usr_1',
        kind: 'daemon',
        managed: true,
        name: podRunnerHostName('pdh_1'),
        cliVersion: '3.0.1',
        clientFeatures: [],
        startupMethod: 'container',
        online: true,
        ...over
    }) as never

class InstantPodHostCli extends PodHostCliService {
    delays = 0

    protected override delay(): Promise<void> {
        this.delays++
        return Promise.resolve()
    }
}

// The host's pod as resolvePodHostPod lists it through the cluster client.
const k8s = {
    getClient: async () => ({
        kubeConfig: {
            makeApiClient: () => ({
                listNamespacedPod: async () => ({
                    items: [
                        {
                            metadata: { name: 'host-pdh-1-0' },
                            status: { phase: 'Running' },
                            spec: { containers: [{ name: 'agent' }] }
                        }
                    ]
                })
            })
        }
    })
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
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => {
                        const row =
                            registrations[
                                Math.min(read++, registrations.length - 1)
                            ]
                        return row ? [row] : []
                    }
                })
            })
        })
    }
    const daemonHosts = {
        isOnline: (h: { online?: boolean }) => h.online !== false,
        upgrade: async (args: unknown) => {
            upgrades.push(args)
            return { ok: true }
        }
    }
    const cliVersion = {
        getCachedLatest: async () =>
            over.latest ?? { version: '4.6.0', channel: 'stable' }
    }
    const podExec = {
        forClient: () => ({
            run: async (req: { cmd: string[] }) => {
                scripts.push(req.cmd[2])
                return {
                    exitCode: 0,
                    stdout: 'mf-upgraded=4.6.0\n',
                    stderr: ''
                }
            }
        })
    }
    const cli = new InstantPodHostCli(
        db as never,
        daemonHosts as never,
        cliVersion as never,
        { isInstallableVersion: async () => true } as never,
        k8s as never,
        podExec as never
    )
    return { cli, upgrades, scripts }
}

test('a connected daemon its host restarts updates itself', async () => {
    const rig = build()
    const daemon = runner()
    await rig.cli.update({
        host: host(),
        runner: daemon,
        actorId: 'usr_1',
        targetVersion: '4.6.0'
    })
    assert.deepEqual(rig.upgrades, [
        { host: daemon, actorId: 'usr_1', targetVersion: '4.6.0' }
    ])
    assert.deepEqual(rig.scripts, [])
})

test('a daemon from an older image is installed over, then left to the boot loop', async () => {
    const rig = build()
    await rig.cli.update({
        host: host(),
        runner: runner({ startupMethod: 'manual' }),
        actorId: 'usr_1',
        targetVersion: '4.6.0'
    })
    assert.deepEqual(rig.upgrades, [])
    assert.equal(rig.scripts.length, 1)
    assert.match(rig.scripts[0], /VERSION="4\.6\.0"/)
    assert.match(rig.scripts[0], /MF_INSTALL_DIR="\$HOME\/\.local\/bin"/)
    assert.match(rig.scripts[0], /pkill -TERM -x mf/)
})

test('a daemon that has what the caller needs is used as it is', async () => {
    const rig = build()
    const daemon = runner({ clientFeatures: [DAEMON_FEATURE_SERVICES] })
    const got = await rig.cli.ensure(host(), daemon, {
        feature: DAEMON_FEATURE_SERVICES
    })
    assert.equal(got, daemon)
    assert.deepEqual(rig.upgrades, [])
    assert.equal(rig.cli.delays, 0)
})

test('a daemon without what the caller needs is updated, and used once it is back', async () => {
    const back = runner({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_SERVICES]
    })
    // The first re-read still finds the old registration.
    const rig = build({ registrations: [runner(), back] })
    const got = await rig.cli.ensure(host(), runner(), {
        feature: DAEMON_FEATURE_SERVICES
    })
    assert.equal(got, back)
    assert.equal(rig.upgrades.length, 1)
    assert.equal(rig.cli.delays, 2)
})

test('a daemon below the floor is installed over, since it never comes online', async () => {
    const rig = build({
        registrations: [runner({ cliVersion: CLI_AT_FLOOR })],
        latest: { version: CLI_AT_FLOOR, channel: 'stable' }
    })
    const got = await rig.cli.ensure(
        host(),
        runner({ cliVersion: CLI_BELOW_FLOOR, online: false }),
        { minVersion: DAEMON_MIN_CLI_VERSION }
    )
    assert.equal((got as { cliVersion: string }).cliVersion, CLI_AT_FLOOR)
    assert.deepEqual(rig.upgrades, [])
    assert.equal(rig.scripts.length, 1)
})

test('a daemon already on the latest CLI has nothing to update to', async () => {
    const rig = build({ latest: { version: '3.0.1', channel: 'stable' } })
    await assert.rejects(
        rig.cli.ensure(host(), runner(), { feature: DAEMON_FEATURE_SERVICES }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.deepEqual(rig.upgrades, [])
})

test('an update that does not bring what is needed is refused', async () => {
    const rig = build({ registrations: [runner({ cliVersion: '4.5.0' })] })
    await assert.rejects(
        rig.cli.ensure(host(), runner(), { feature: DAEMON_FEATURE_SERVICES }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.equal(rig.upgrades.length, 1)
})

test('a daemon that never comes back is given about three minutes', async () => {
    const rig = build({ registrations: [runner()] })
    await assert.rejects(
        rig.cli.ensure(host(), runner(), { feature: DAEMON_FEATURE_SERVICES }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.equal(rig.cli.delays, 60)
})

test('callers that need the same host updated share one update', async () => {
    const back = runner({
        cliVersion: '4.6.0',
        clientFeatures: [DAEMON_FEATURE_SERVICES]
    })
    const rig = build({ registrations: [back] })
    const need = { feature: DAEMON_FEATURE_SERVICES }
    const [a, b] = await Promise.all([
        rig.cli.ensure(host(), runner(), need),
        rig.cli.ensure(host(), runner(), need)
    ])
    assert.equal(a, back)
    assert.equal(b, back)
    assert.equal(rig.upgrades.length, 1)
})
