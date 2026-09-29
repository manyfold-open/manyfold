import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent, HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import {
    daemonOnline,
    frameworkCapability,
    listFrameworks,
    type AgentFramework,
    type RuntimePlacement
} from '@manyfold/shared'
import { ExecDriverFactory } from '../src/modules/chat/adapters/exec-driver-factory'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import { TurnDaemonError } from '../src/modules/chat/turn-daemon'
import {
    HostAwakeService,
    NOOP_HOLD
} from '../src/modules/hosts/host-awake.service'
import { CLI_AT_FLOOR, CLI_BELOW_FLOOR } from './helpers/cli-floor'
import {
    contextOf,
    daemonRow,
    fakeRuntimeContext,
    hostRow,
    k8sHostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

const features = [
    'turn.hermes',
    'turn.openclaw',
    'turn.openclaw.acp',
    'auth-context.v1',
    'exec.roots.v1'
]
const hostFor = (runtime: RuntimePlacement): RuntimeHostRow =>
    runtime === 'daemon'
        ? hostRow({ id: 'dh_one', userId: 'usr_one' })
        : runtime === 'k8s'
          ? k8sHostRow({ id: 'dh_one', userId: 'usr_one' })
          : spritesHostRow({ id: 'dh_one', userId: 'usr_one' })

const rig = (
    runtime: RuntimePlacement,
    framework: AgentFramework,
    options: {
        missing?: boolean
        offline?: boolean
        version?: string
        features?: readonly string[]
        reason?: string
        // Every daemon RPC fails the way a dropped socket does.
        rpcFails?: boolean
        // The bring-up's holds go to a real awake service.
        awake?: HostAwakeService
    } = {}
) => {
    const calls: string[] = []
    const payloads: Record<string, unknown>[] = []
    const holdReasons: string[] = []
    const agent = {
        id: 'agt_one',
        userId: 'usr_one',
        framework,
        status: 'ready',
        runtimeId: 'art_one',
        workspacePath: '/workspace/agt_one',
        extras: { envText: 'EXTRA=value' }
    } as unknown as Agent
    const host = hostFor(runtime)
    const daemon = options.missing
        ? null
        : daemonRow({
              hostId: host.id,
              userId: host.userId,
              cliVersion: options.version ?? CLI_AT_FLOOR,
              clientFeatures: [...(options.features ?? features)],
              ...(options.offline
                  ? { lastSeenAt: new Date(Date.now() - 120_000) }
                  : {})
          })
    const context = contextOf({
        agent,
        runtime: runtimeRow({
            id: 'art_one',
            userId: 'usr_one',
            framework,
            hostId: host.id
        }),
        host,
        daemon
    })
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [] })
            })
        })
    }
    // The runner manager's answer, recorded: whether the daemon came up.
    const hostAccess = {
        ensure: async (args: { daemon: HostDaemonRow | null }) => {
            calls.push('resolve')
            if (options.reason)
                return {
                    daemon: null,
                    online: false,
                    fallbackReason: options.reason
                }
            const online = daemonOnline(args.daemon)
            return {
                daemon: args.daemon,
                online,
                fallbackReason: online
                    ? undefined
                    : args.daemon
                      ? 'runner_unavailable'
                      : 'runner_missing'
            }
        }
    }
    const factory = new ExecDriverFactory(
        db as never,
        fakeRuntimeContext(context) as never,
        {} as never,
        {
            streamRpc: (args: {
                method: string
                payload: Record<string, unknown>
            }) => {
                calls.push(args.method)
                payloads.push(args.payload)
                return {
                    refId: 'ref',
                    result: options.rpcFails
                        ? Promise.reject(
                              new Error('daemon dh_one is not connected')
                          )
                        : Promise.resolve({ exitCode: 0 }),
                    cancel() {}
                }
            }
        } as never,
        { reserveActiveSlot: async () => { calls.push('reserve') } } as never,
        { measureIfDue: () => {} } as never,
        { resolveAgentEnv: async () => ({ CONNECTION: 'value' }) } as never,
        { findByHostId: async () => daemon } as never,
        hostAccess as never,
        { get: () => 'https://api.example.test' } as never,
        undefined,
        undefined,
        {
            holdAwake: (held: RuntimeHostRow, reason: string) => {
                calls.push('hold')
                holdReasons.push(reason)
                const hold = options.awake?.hold(held, reason) ?? NOOP_HOLD
                return {
                    ...hold,
                    release: async () => {
                        calls.push('release')
                        await hold.release()
                    }
                }
            },
            awaitReconnect: async () => null
        } as never
    )
    return { factory, agent, host, calls, payloads, holdReasons }
}

for (const framework of listFrameworks()) {
    const capability = frameworkCapability(framework)
    if (capability.kind === 'external') continue
    for (const runtime of capability.runtimes) {
        test(`${framework} on ${runtime} requires its runner without rollout configuration`, async () => {
            const { factory, agent, calls } = rig(
                runtime,
                framework as AgentFramework
            )
            const resolved = await factory.resolveTurnDaemon(agent)
            assert.equal(resolved.hostId, 'dh_one')
            const driver = factory.daemonDriverFor(resolved.hostId)
            assert.ok(driver instanceof DaemonExecDriver)
            const handle = driver.stream({ cmd: ['true'], timeoutMs: 1000 })
            await handle.result
            assert.equal(calls.filter((c) => c === 'exec.start').length, 1)
        })
    }
}

for (const runtime of ['daemon', 'sprites', 'k8s'] as const) {
    for (const [reason, options, code] of [
        ['missing', { missing: true }, 'chat_runner_unavailable'],
        ['offline', { offline: true }, 'chat_runner_unavailable'],
        [
            'old CLI',
            { version: CLI_BELOW_FLOOR },
            'chat_runner_upgrade_required'
        ],
        ['missing ACP', { features: [] }, 'chat_runner_upgrade_required']
    ] as const) {
        test(`${runtime}: ${reason} refuses before any exec`, async () => {
            const { factory, agent, calls } = rig(runtime, 'hermes', options)
            await assert.rejects(
                factory.resolveTurnDaemon(agent),
                (err: unknown) => {
                    assert.ok(err instanceof TurnDaemonError)
                    assert.equal(err.chatError.code, code)
                    assert.equal(
                        err.chatError.retryable,
                        code === 'chat_runner_unavailable'
                    )
                    return true
                }
            )
            assert.equal(calls.includes('exec.start'), false)
        })
    }
}

for (const reason of ['runner_unavailable', 'runner_missing'] as const) {
    test(`Pod ${reason} never falls back to pod exec`, async () => {
        const { factory, agent, calls } = rig('k8s', 'codex', { reason })
        await assert.rejects(factory.resolveTurnDaemon(agent), TurnDaemonError)
        assert.deepEqual(calls, ['resolve'])
    })
}

test('a newly starting Pod without a registered runner is retryable', async () => {
    const { factory, agent } = rig('k8s', 'codex', { reason: 'runner_missing' })
    await assert.rejects(factory.resolveTurnDaemon(agent), (err: unknown) => {
        assert.ok(err instanceof TurnDaemonError)
        assert.equal(err.chatError.code, 'chat_runner_unavailable')
        assert.equal(err.chatError.retryable, true)
        return true
    })
})

for (const runtime of ['sprites', 'k8s'] as const) {
    test(`${runtime}: gateway frameworks leave workspace resolution to the gateway`, async () => {
        const { factory, agent } = rig(runtime, 'openclaw')
        agent.workspacePath = '/not-yet-created/workspace'
        const gateway = await factory.resolveTurnDaemon(agent)
        assert.equal(gateway.roots.includes(agent.workspacePath!), false)
        const coding = rig(runtime, 'codex')
        const resolved = await coding.factory.resolveTurnDaemon(coding.agent)
        assert.equal(resolved.roots[0], coding.agent.workspacePath)
    })
}

// ADR-0038: the roots ride on the exec instead of a workspace.ensure ahead
// of the turn. A daemon that cannot read them is refused with the upgrade
// path before any exec; a workspace under the host's managed tree needs no
// declaration and no feature.
test('a workspace outside the managed tree needs exec.roots.v1; under it the daemon needs no feature', async () => {
    const outside = rig('sprites', 'codex', {
        features: features.filter((f) => f !== 'exec.roots.v1')
    })
    await assert.rejects(outside.factory.resolveTurnDaemon(outside.agent), (err: unknown) => {
        assert.ok(err instanceof TurnDaemonError)
        assert.equal(err.chatError.code, 'chat_runner_upgrade_required')
        return true
    })
    const managed = rig('sprites', 'codex', {
        features: features.filter((f) => f !== 'exec.roots.v1')
    })
    managed.host.workspaceBaseDir = '/workspace'
    const resolved = await managed.factory.resolveTurnDaemon(managed.agent)
    assert.deepEqual(resolved.roots, [managed.agent.workspacePath])
})

test('the resolved roots reach the daemon on exec.start', async () => {
    const { factory, agent, payloads } = rig('sprites', 'codex')
    const resolved = await factory.resolveTurnDaemon(agent)
    const driver = factory.daemonDriverFor(resolved.hostId, undefined, null, {
        roots: resolved.roots
    })
    await driver.stream({ cmd: ['true'], dir: agent.workspacePath!, timeoutMs: 1000 }).result
    assert.deepEqual(payloads[0].roots, [agent.workspacePath])
})

test('Sprite recovery reserves a slot and builds no provider client, and holds nothing yet', async () => {
    const { factory, agent, calls } = rig('sprites', 'codex')
    await factory.recoveryFsForAgent(agent.id)
    assert.deepEqual(calls, ['reserve', 'resolve'])
})

// Seen on staging [2026-09-29]: a hold taken with the handle and left to the
// caller was never released by four callers, so a sandbox read by a gemini
// automation every 2 h stopped sleeping.
test('each Sprite recovery read holds the sandbox for its own run', async () => {
    const { factory, agent, calls, holdReasons } = rig('sprites', 'gemini-cli')
    const { fs } = await factory.recoveryFsForAgent(agent.id)
    await fs.locate('true')
    await fs.listFiles('true')
    await fs.exec('true')
    await fs.readFile('/workspace/agt_one/session.jsonl')
    await fs.readBinary('/workspace/agt_one/image.png')
    assert.deepEqual(calls.slice(2), [
        'hold', 'exec.start', 'release',
        'hold', 'exec.start', 'release',
        'hold', 'exec.start', 'release',
        'hold', 'fs.read', 'release',
        'hold', 'fs.read', 'release'
    ])
    assert.deepEqual(new Set(holdReasons), new Set(['recovery-agt_one']))
})

test('a Sprite recovery read that fails still lets the sandbox go', async () => {
    const { factory, agent, calls } = rig('sprites', 'codex', { rpcFails: true })
    const { fs } = await factory.recoveryFsForAgent(agent.id)
    await assert.rejects(fs.exec('true'), /not connected/)
    await assert.rejects(
        fs.readFile('/workspace/agt_one/session.jsonl'),
        /not connected/
    )
    assert.deepEqual(calls.slice(2), [
        'hold', 'exec.start', 'release',
        'hold', 'fs.read', 'release'
    ])
})

test('a machine that never sleeps is read without a hold', async () => {
    for (const runtime of ['k8s', 'daemon'] as const) {
        const { factory, agent, calls } = rig(runtime, 'codex')
        const { fs } = await factory.recoveryFsForAgent(agent.id)
        await fs.exec('true')
        assert.equal(calls.includes('hold'), false, runtime)
    }
})

test('recovery reads leave the Sprite lease released, not renewed', async () => {
    const provider: string[] = []
    class Awake extends HostAwakeService {
        protected override releaseGraceMs(): number {
            return 0
        }
    }
    const awake = new Awake(
        {
            has: () => true,
            for: () => ({
                holdAwake: async () => {
                    provider.push('hold')
                },
                releaseAwake: async () => {
                    provider.push('release')
                }
            })
        } as never,
        {
            providerForHost: async () => ({
                id: 'rtp_sprites',
                kind: 'sprites',
                name: 'org'
            })
        } as never
    )
    const { factory, agent, host } = rig('sprites', 'gemini-cli', { awake })
    const { fs } = await factory.recoveryFsForAgent(agent.id)
    await fs.locate('true')
    await fs.exec('true')
    await fs.readFile('/workspace/agt_one/session.jsonl')
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(awake.holders(host.id), 0)
    assert.deepEqual(provider, ['hold', 'release'])
})

test('a sandbox whose runner is too old for a turn points its owner at the update', () => {
    const error = new TurnDaemonError('sprites', 'missing feature', true)
    // A sandbox's CLI is its owner's to update, not an administrator's.
    assert.match(error.chatError.message, /Update the sandbox's Manyfold CLI from the Update Center \(or mf sandbox update\)/)
    assert.doesNotMatch(error.chatError.message, /Run mf update/)
})

test('OpenClaw history reuses the filesystem carrier and holds the Sprite only while a gateway call runs', async () => {
    const { factory, agent, calls } = rig('sprites', 'openclaw')
    const handle = await factory.recoveryFsForAgent(agent.id)
    const client = await factory.openclawRpcForAgent(agent.id, handle.hostId)
    assert.ok(client)
    assert.deepEqual(calls, ['reserve', 'resolve'])
    // The fake daemon prints nothing, so the query itself fails.
    await assert.rejects(client.call('sessions.list'), /invalid JSON/)
    assert.deepEqual(calls.slice(2), ['hold', 'exec.start', 'release'])
})
