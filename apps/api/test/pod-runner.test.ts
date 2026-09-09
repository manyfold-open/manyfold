import assert from 'node:assert/strict'
import test from 'node:test'
import {
    POD_RUNNER_PROFILE,
    buildPodRunnerEnv,
    codingAgentWorkspacePath,
    podRunnerHostName
} from '@manyfold/shared'
import { isManagedDaemonTokenPurpose } from '@manyfold/db'
import { PodRunnerProvisioner } from '../src/modules/agent-runtimes/provisioning/pod-runner-provisioner'
import { RunnerManagerService } from '../src/modules/chat/runner/runner-manager.service'

// A pod runner is the third managed runner, and it differs from the sprite one
// in exactly the two ways these tests pin: nothing brings it up (the image owns
// the binary, the entrypoint owns the process), and nothing keeps it awake (a
// pod does not suspend). Everything else — the host row, the transport swap,
// the teardown — is the sprite runner's machinery, reached by a different name.

// --- provisioning: what lands in the pod's Secret -----------------------------

const buildProvisioner = (opts: {
    apiBaseUrl?: string
}): {
    provisioner: PodRunnerProvisioner
    mints: Array<Record<string, unknown>>
    deleted: Array<{ tokenId: string; userId: string }>
} => {
    const mints: Array<Record<string, unknown>> = []
    const deleted: Array<{ tokenId: string; userId: string }> = []
    const tokens = {
        mint: async (args: Record<string, unknown>) => {
            mints.push(args)
            return {
                tokenId: 'ldt_pod_id',
                plaintext: 'ldt_pod_secret',
                name: String(args.name),
                expiresAt: null,
                createdAt: new Date()
            }
        },
        deleteUnbound: async (a: { tokenId: string; userId: string }) => {
            deleted.push(a)
            return true
        }
    }
    const config = {
        get: (key: string) =>
            key === 'PUBLIC_API_BASE_URL' ? opts.apiBaseUrl : undefined
    }
    return {
        provisioner: new PodRunnerProvisioner(tokens as never, config as never),
        mints,
        deleted
    }
}

test('a coding pod gets a pod_runner credential and the daemon env', async () => {
    const { provisioner, mints } = buildProvisioner({
        apiBaseUrl: 'https://api.test'
    })
    const provision = await provisioner.mint({
        userId: 'user_1',
        runtimeId: 'art_pod',
        framework: 'claude-code',
        homeRoot: '/home/node/.manyfold'
    })
    assert.ok(provision)
    // The purpose is the whole trust boundary: it is what makes the register
    // quota-exempt and the host platform-managed, and the user-facing mint can
    // never ask for it.
    assert.equal(mints[0].purpose, 'pod_runner')
    assert.equal(isManagedDaemonTokenPurpose('pod_runner'), true)
    assert.equal(mints[0].name, 'pod-runner:art_pod')
    // No TTL. The daemon presents this token on every reconnect and nothing
    // ever re-mints it into the Secret, so an expiry would not rotate the
    // credential — it would switch the runner off on the day it lapsed and
    // leave the daemon in a permanent 4401 reconnect loop.
    assert.equal(
        'expiresInDays' in mints[0],
        false,
        'pod runner tokens must not expire'
    )
    assert.equal(provision.hostName, podRunnerHostName('art_pod'))
    assert.deepEqual(provision.env, {
        MF_API_URL: 'https://api.test/api',
        MF_DAEMON_TOKEN: 'ldt_pod_secret',
        MF_DAEMON_HOST_NAME: 'pod-runner:art_pod',
        MF_PROFILE: POD_RUNNER_PROFILE,
        // Must be the PVC-backed home root, not the default $HOME/.manyfold:
        // off the PVC the daemon uuid is regenerated on every pod restart and
        // the token, bound to the first uuid, is refused for the new one.
        MF_CONFIG_DIR: '/home/node/.manyfold'
    })
})

test('the declared workspace root contains the agent workspaces on that pod', () => {
    // ADR-0014: registration DECLARES the host's roots, and the daemon refuses
    // any dispatch dir outside them. The API sends
    // codingAgentWorkspacePath('k8s', id); if MF_CONFIG_DIR does not make that
    // path fall under <root>/workspaces, every pod-runner turn is refused
    // `outside allowed roots` — the exact failure a custom sprite workspace hit.
    const env = buildPodRunnerEnv({
        apiBaseUrl: 'https://api.test/api',
        daemonToken: 'ldt_x',
        runtimeId: 'art_pod',
        homeRoot: '/home/node/.manyfold'
    })
    const declaredWorkspaceRoot = `${env.MF_CONFIG_DIR}/workspaces`
    // Derived, not typed: this is the path the API actually dispatches with,
    // so a change to the k8s home base or the workspace layout reddens here.
    const dispatched = codingAgentWorkspacePath('k8s', 'agt_1')
    assert.equal(
        dispatched.startsWith(`${declaredWorkspaceRoot}/`),
        true,
        `${dispatched} must live under the declared root ${declaredWorkspaceRoot}`
    )
})

test('a service pod gets no runner credential at all', async () => {
    // Its k8s runtime IS the resident gateway, so a daemon there would be a
    // second surface on the same instance. Declared here rather than left to
    // the dispatch gate so no credential is ever baked for one.
    const { provisioner, mints } = buildProvisioner({
        apiBaseUrl: 'https://api.test'
    })
    for (const framework of ['openclaw', 'hermes', 'narranexus'] as const) {
        assert.equal(provisioner.supports(framework), false)
        assert.equal(
            await provisioner.mint({
                userId: 'user_1',
                runtimeId: 'art_pod',
                framework,
                homeRoot: '/home/node/.openclaw'
            }),
            null
        )
    }
    assert.equal(mints.length, 0)
})

test('no API base url means no credential rather than an unusable one', async () => {
    const { provisioner, mints } = buildProvisioner({})
    assert.equal(
        await provisioner.mint({
            userId: 'user_1',
            runtimeId: 'art_pod',
            framework: 'codex',
            homeRoot: '/home/node/.manyfold'
        }),
        null
    )
    assert.equal(mints.length, 0)
})

test('rollback discards only an UNBOUND pod runner token', async () => {
    // If the pod did register, the credential belongs to a runner that is
    // already online and deleting it would cut off a live daemon.
    const { provisioner, deleted } = buildProvisioner({
        apiBaseUrl: 'https://api.test'
    })
    await provisioner.discardUnbound('user_1', 'ldt_pod_id')
    assert.deepEqual(deleted, [{ tokenId: 'ldt_pod_id', userId: 'user_1' }])
})

// --- resolution: finding the runner at dispatch time --------------------------

const buildResolver = (opts: {
    hostName?: string
    online?: boolean
    cliVersion?: string | null
    workspaceBaseDir?: string | null
    workspaceEnsureFails?: boolean
}): {
    service: RunnerManagerService
    rpcCalls: Array<{ method: string; payload: Record<string, unknown> }>
    hostReads: () => number
} => {
    const rpcCalls: Array<{
        method: string
        payload: Record<string, unknown>
    }> = []
    const row = opts.hostName
        ? {
              id: 'dh_pod',
              name: opts.hostName,
              status: 'active',
              managed: true,
              cliVersion:
                  opts.cliVersion === undefined ? '0.30.0' : opts.cliVersion,
              workspaceBaseDir:
                  opts.workspaceBaseDir === undefined
                      ? '/home/node/.manyfold/workspaces'
                      : opts.workspaceBaseDir,
              rpcInstanceId: 'api-1',
              rpcConnectedAt: new Date('2026-09-09T00:00:00Z')
          }
        : null
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => (row ? [row] : [])
                })
            })
        })
    }
    let hostReads = 0
    const hosts = {
        isOnline: () => opts.online !== false,
        findById: async () => {
            hostReads++
            return row
        }
    }
    const registry = {
        rpc: async (a: {
            daemonId: string
            method: string
            payload: Record<string, unknown>
        }) => {
            rpcCalls.push({ method: a.method, payload: a.payload })
            if (opts.workspaceEnsureFails)
                throw new Error('workspace directory does not exist')
            return {}
        }
    }
    // No sprite exec transport is wired at all: reaching for one would be the
    // bug this asserts against.
    const tokens = {
        mint: async () => {
            throw new Error('a pod runner must never mint at dispatch time')
        }
    }
    return {
        service: new RunnerManagerService(
            db as never,
            hosts as never,
            tokens as never,
            registry as never
        ),
        rpcCalls,
        hostReads: () => hostReads
    }
}

test('an online pod runner resolves without any bring-up', async () => {
    const { service, rpcCalls, hostReads } = buildResolver({
        hostName: podRunnerHostName('art_pod')
    })
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod',
        workspacePath: '/home/node/.manyfold/workspaces/agt_1'
    })
    assert.equal(resolution.handle?.daemonId, 'dh_pod')
    // Under the declared root, so it is registered by construction — no RPC.
    assert.equal(resolution.workspace.outcome, 'base')
    assert.deepEqual(rpcCalls, [])
    // `started` is always false: unlike a sprite runner, nothing here can
    // start one, so a true would be a lie the telemetry would carry.
    assert.equal(resolution.handle?.started, false)
    // The host row read by name is the one the preflight uses; it is not
    // fetched a second time by id.
    assert.equal(hostReads(), 0)
})

test('a pod runner below the CLI floor is not used', async () => {
    // Nothing per turn checks that the daemon supports the stdin the prompt
    // arrives on — the sprite runner is reinstalled below the floor instead,
    // and nothing reinstalls a pod's. Below the floor, the turn stays on
    // pod-exec until the image moves.
    const { service } = buildResolver({
        hostName: podRunnerHostName('art_pod'),
        cliVersion: '0.21.0'
    })
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod'
    })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.fallbackReason, 'runner_cli_too_old')
})

test('a pod runner that never reported a version is not used either', async () => {
    const { service } = buildResolver({
        hostName: podRunnerHostName('art_pod'),
        cliVersion: null
    })
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod'
    })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.fallbackReason, 'runner_cli_too_old')
})

test('an offline pod runner degrades to the pod-exec path', async () => {
    const { service } = buildResolver({
        hostName: podRunnerHostName('art_pod'),
        online: false
    })
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod'
    })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.fallbackReason, 'runner_unavailable')
})

test('a pod with no registered runner degrades to the pod-exec path', async () => {
    const { service } = buildResolver({})
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod'
    })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.fallbackReason, 'runner_unavailable')
})

test('a workspace outside the declared root is registered before dispatch', async () => {
    const { service, rpcCalls } = buildResolver({
        hostName: podRunnerHostName('art_pod'),
        workspaceBaseDir: '/home/node/.manyfold/workspaces'
    })
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod',
        workspacePath: '/srv/custom-workspace'
    })
    assert.equal(resolution.handle?.daemonId, 'dh_pod')
    assert.equal(resolution.workspace.outcome, 'ensured')
    assert.equal(rpcCalls[0]?.method, 'workspace.ensure')
    assert.equal(rpcCalls[0]?.payload.path, '/srv/custom-workspace')
})

test('a failed workspace register falls back instead of dispatching', async () => {
    // The daemon would refuse the cwd, so a turn dispatched anyway would fail
    // where the pod-exec path would have succeeded.
    const { service } = buildResolver({
        hostName: podRunnerHostName('art_pod'),
        workspaceEnsureFails: true
    })
    const resolution = await service.resolvePodRunner({
        userId: 'user_1',
        runtimeId: 'art_pod',
        workspacePath: '/srv/custom-workspace'
    })
    assert.equal(resolution.handle, null)
    assert.equal(resolution.workspace.outcome, 'failed')
})

// Name scoping — that one pod's runner is never mistaken for another's, and
// that one user's is never mistaken for another user's — is NOT tested here on
// purpose: this suite's db fake ignores the where clause, so such a test could
// only pass. It is proved against real SQL in sprite-runner-teardown.pg.test.ts,
// which seeds a same-user-different-runtime and a same-name-different-user
// runner as controls.
