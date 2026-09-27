import assert from 'node:assert/strict'
import test from 'node:test'
import {
    POD_RUNNER_PROFILE,
    buildPodRunnerEnv,
    codingAgentWorkspacePath
} from '@manyfold/shared'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import { PodRunnerProvisioner } from '../src/modules/agent-runtimes/provisioning/pod-runner-provisioner'
import { POD_HOST_WORKSPACE_BASE } from '../src/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { RunnerManagerService } from '../src/modules/chat/runner/runner-manager.service'
import { CLI_AT_FLOOR } from './helpers/cli-floor'

// A pod host's daemon IS the host's daemon (ADR-0036): the pod's boot loop
// registers it with the token the platform minted BOUND to the host, and at
// dispatch time it is found through host_daemons like every other daemon —
// nothing by name. One daemon serves every framework runtime on its pod
// (ADR-0035).

// --- provisioning: what lands in the pod's Secret -----------------------------

const buildProvisioner = (opts: {
    apiBaseUrl?: string
}): {
    provisioner: PodRunnerProvisioner
    mints: Array<Record<string, unknown>>
} => {
    const mints: Array<Record<string, unknown>> = []
    const tokens = {
        mint: async (args: Record<string, unknown>) => {
            mints.push(args)
            return {
                tokenId: 'ldt_pod_id',
                plaintext: 'ldt_pod_secret',
                name: String(args.name),
                hostId: args.hostId ?? null,
                expiresAt: null,
                createdAt: new Date()
            }
        }
    }
    const config = {
        get: (key: string) =>
            key === 'PUBLIC_API_BASE_URL' ? opts.apiBaseUrl : undefined
    }
    return {
        provisioner: new PodRunnerProvisioner(tokens as never, config as never),
        mints
    }
}

test('a pod host gets a credential bound to it and the daemon env', async () => {
    const { provisioner, mints } = buildProvisioner({
        apiBaseUrl: 'https://api.test'
    })
    const provision = await provisioner.mint({
        userId: 'user_1',
        hostId: 'pdh_1'
    })
    // The binding is the whole trust boundary (R5): the pod's register can
    // only land on this host, and nothing the pod reports participates.
    assert.equal(mints[0].hostId, 'pdh_1')
    assert.equal(mints[0].name, 'daemon:pdh_1')
    // No TTL. The daemon presents this token on every reconnect and nothing
    // ever re-mints it into the Secret, so an expiry would not rotate the
    // credential — it would switch the daemon off on the day it lapsed.
    assert.equal(
        'expiresInDays' in mints[0],
        false,
        'pod daemon tokens must not expire'
    )
    assert.equal(provision.tokenId, 'ldt_pod_id')
    assert.deepEqual(provision.env, {
        MF_API_URL: 'https://api.test/api',
        MF_DAEMON_TOKEN: 'ldt_pod_secret',
        MF_PROFILE: POD_RUNNER_PROFILE,
        // Must be on the PVC, not a default outside it: off the PVC the daemon
        // uuid is regenerated on every pod restart.
        MF_CONFIG_DIR: '/home/node/.manyfold'
    })
})

test('the declared workspace root contains the agent workspaces on that pod', () => {
    // ADR-0014: registration DECLARES the host's roots (`<MF_CONFIG_DIR>/
    // workspaces`). The API dispatches codingAgentWorkspacePath('k8s', id); a
    // dir outside the declared root is registered with a `workspace.ensure`
    // RPC per generation, so the common path must never pay that RPC.
    const env = buildPodRunnerEnv({
        apiBaseUrl: 'https://api.test/api',
        daemonToken: 'ldt_x',
        homeRoot: '/home/node/.manyfold'
    })
    const declaredWorkspaceRoot = `${env.MF_CONFIG_DIR}/workspaces`
    assert.equal(POD_HOST_WORKSPACE_BASE, declaredWorkspaceRoot)
    const dispatched = codingAgentWorkspacePath('k8s', 'agt_1')
    assert.equal(
        dispatched.startsWith(`${declaredWorkspaceRoot}/`),
        true,
        `${dispatched} must live under the declared root ${declaredWorkspaceRoot}`
    )
})

test('a pod host without a reachable API URL is rejected before minting a token', async () => {
    const { provisioner, mints } = buildProvisioner({})
    await assert.rejects(
        provisioner.mint({ userId: 'user_1', hostId: 'pdh_1' }),
        /PUBLIC_API_BASE_URL/
    )
    assert.equal(mints.length, 0)
})

// --- resolution: finding the daemon at dispatch time --------------------------

const podHost = (): RuntimeHostRow =>
    ({
        id: 'pdh_1',
        userId: 'user_1',
        kind: 'hosted',
        providerId: 'rtp_k8s',
        providerRef: { kind: 'k8s', namespace: 'nca-user-1', ingressHost: null, podPhase: 'Running' },
        name: 'computer-001',
        status: 'ready',
        generation: 1,
        homeDir: '/home/node',
        workspaceBaseDir: '/home/node/.manyfold/workspaces'
    }) as unknown as RuntimeHostRow

const buildResolver = (opts: {
    daemon?: Partial<HostDaemonRow> | null
    workspaceEnsureFails?: boolean
}) => {
    const rpcCalls: Array<{ method: string; payload: Record<string, unknown> }> = []
    const daemon =
        opts.daemon === null
            ? null
            : ({
                  hostId: 'pdh_1',
                  userId: 'user_1',
                  cliVersion: CLI_AT_FLOOR,
                  clientFeatures: [],
                  lastSeenAt: new Date(),
                  rpcInstanceId: 'api-1',
                  rpcConnectedAt: new Date('2026-09-09T00:00:00Z'),
                  rpcLastSeenAt: new Date(),
                  ...opts.daemon
              } as HostDaemonRow)
    let adapterCalls = 0
    const service = new RunnerManagerService(
        { findById: async () => podHost(), patch: async () => null, bumpGeneration: async () => 2 } as never,
        { findByHostId: async () => daemon } as never,
        {
            for: () => ({
                power: async () => {
                    adapterCalls++
                    return 'running'
                },
                wake: async () => {
                    adapterCalls++
                },
                bootstrap: async () => {
                    adapterCalls++
                    return { exitCode: 1, stdout: '', stderr: '' }
                }
            })
        } as never,
        { providerForHost: async () => ({ id: 'rtp_k8s', kind: 'k8s' }) } as never,
        {
            mint: async () => {
                throw new Error('an online pod daemon must never mint at dispatch time')
            }
        } as never,
        {
            rpc: async (a: { method: string; payload: Record<string, unknown> }) => {
                rpcCalls.push({ method: a.method, payload: a.payload })
                if (opts.workspaceEnsureFails)
                    throw new Error('workspace directory does not exist')
                return {}
            }
        } as never
    )
    return { service, rpcCalls, adapterCalls: () => adapterCalls }
}

test('an online pod daemon resolves without any bring-up', async () => {
    const { service, rpcCalls, adapterCalls } = buildResolver({})
    const resolution = await service.ensureHostDaemon({
        host: podHost(),
        workspacePath: '/home/node/.manyfold/workspaces/agt_1'
    })
    assert.equal(resolution.handle?.daemonId, 'pdh_1')
    // Under the declared root, so it is registered by construction — no RPC.
    assert.equal(resolution.workspace.outcome, 'base')
    assert.deepEqual(rpcCalls, [])
    assert.equal(resolution.handle?.started, false)
    assert.equal(adapterCalls(), 0, 'no provider call for a daemon that is already online')
})

test('a workspace outside the declared root is registered before dispatch', async () => {
    const { service, rpcCalls } = buildResolver({})
    const resolution = await service.ensureHostDaemon({
        host: podHost(),
        workspacePath: '/srv/custom-workspace'
    })
    assert.equal(resolution.handle?.daemonId, 'pdh_1')
    assert.equal(resolution.workspace.outcome, 'ensured')
    assert.equal(rpcCalls[0]?.method, 'workspace.ensure')
    assert.equal(rpcCalls[0]?.payload.path, '/srv/custom-workspace')
})

test('a failed workspace register falls back instead of dispatching', async () => {
    const { service } = buildResolver({ workspaceEnsureFails: true })
    const resolution = await service.ensureHostDaemon({
        host: podHost(),
        workspacePath: '/srv/custom-workspace'
    })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.workspace.outcome, 'failed')
})

test('an offline pod daemon goes through the adapter, and its wake is a no-op', async () => {
    const { service, adapterCalls } = buildResolver({
        daemon: { lastSeenAt: new Date(Date.now() - 120_000), rpcLastSeenAt: new Date(Date.now() - 120_000) }
    })
    const resolution = await service.ensureHostDaemon({ host: podHost(), waitOnlineMs: 10 })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.fallbackReason, 'runner_unavailable')
    assert.ok(adapterCalls() >= 2, 'power was observed and the bootstrap inspect ran')
})
