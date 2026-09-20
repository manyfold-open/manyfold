import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agents,
    agentCredentials,
    runtimeHosts,
    type Agent
} from '@manyfold/db'
import {
    frameworkCapabilities,
    type AgentFramework,
    type AgentRuntime
} from '@manyfold/shared'
import { ExecDriverFactory } from '../src/modules/chat/adapters/exec-driver-factory'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import { ChatRunnerError } from '../src/modules/chat/runner/chat-runner'

const features = [
    'turn.hermes',
    'turn.openclaw',
    'turn.openclaw.acp',
    'auth-context.v1'
]
const rig = (
    runtime: AgentRuntime,
    framework: AgentFramework,
    options: {
        missing?: boolean
        offline?: boolean
        version?: string
        features?: readonly string[]
        reason?: string
    } = {}
) => {
    const calls: string[] = []
    const workspaces: unknown[] = []
    const agent = {
        id: 'agt_one',
        userId: 'usr_one',
        runtime,
        framework,
        runtimeId: 'art_one',
        daemonId: runtime === 'daemon' ? 'dh_one' : null,
        accountId: 'sac_one',
        hostId: 'rth_one',
        spriteName: 'sprite-one',
        workspacePath: '/workspace/agt_one',
        extras: { envText: 'EXTRA=value' }
    } as unknown as Agent
    const db = {
        select: () => ({
            from: (table: unknown) => ({
                where: () => ({
                    limit: async () => {
                        if (table === agents) return [agent]
                        if (table === agentCredentials) return []
                        if (table === runtimeHosts)
                            return options.missing
                                ? []
                                : [
                                      {
                                          id: 'dh_one',
                                          userId: agent.userId,
                                          kind: 'daemon',
                                          status: 'active',
                                          cliVersion:
                                              options.version ?? '4.1.0',
                                          rpcLastSeenAt: new Date(
                                              Date.now() -
                                                  (options.offline
                                                      ? 120_000
                                                      : 0)
                                          ),
                                          clientFeatures:
                                              options.features ?? features
                                      }
                                  ]
                        return []
                    }
                })
            })
        })
    }
    const resolution = async (args: { workspacePath?: string | null }) => {
        workspaces.push(args.workspacePath)
        calls.push('resolve')
        return options.reason
            ? {
                  handle: null,
                  fallbackReason: options.reason,
                  workspace: { outcome: 'failed' }
              }
            : { handle: { daemonId: 'dh_one' }, workspace: { outcome: 'base' } }
    }
    const factory = new ExecDriverFactory(
        db as never,
        {
            getById: async () => { calls.push('account'); return { slug: 'account' } },
            decryptToken: () => 'fixture'
        } as never,
        {} as never,
        {
            streamRpc: () => {
                calls.push('exec.start')
                return {
                    refId: 'ref',
                    result: Promise.resolve({ exitCode: 0 }),
                    cancel() {}
                }
            }
        } as never,
        { reserveActiveSlot: async () => { calls.push('reserve') } } as never,
        { measureIfDue: () => {} } as never,
        { resolveAgentEnv: async () => ({ CONNECTION: 'value' }) } as never,
        { get: () => 'https://api.example.test' } as never,
        undefined,
        undefined,
        { ensureRunner: resolution, resolvePodRunner: resolution } as never
    )
    return { factory, agent, calls, workspaces }
}

for (const [framework, capability] of Object.entries(frameworkCapabilities)) {
    if (capability.kind === 'external') continue
    for (const runtime of capability.runtimes) {
        test(`${framework} on ${runtime} requires its runner without rollout configuration`, async () => {
            const { factory, agent, calls } = rig(
                runtime,
                framework as AgentFramework
            )
            const resolved = await factory.resolveRunner(agent)
            assert.equal(resolved.daemonId, 'dh_one')
            const driver = factory.daemonDriverFor(resolved.daemonId)
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
        ['old CLI', { version: '0.1.0' }, 'chat_runner_upgrade_required'],
        ['missing ACP', { features: [] }, 'chat_runner_upgrade_required']
    ] as const) {
        test(`${runtime}: ${reason} refuses before any exec`, async () => {
            const { factory, agent, calls } = rig(runtime, 'hermes', options)
            await assert.rejects(
                factory.resolveRunner(agent),
                (err: unknown) => {
                    assert.ok(err instanceof ChatRunnerError)
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

for (const reason of [
    'workspace_timeout',
    'workspace_error',
    'runner_missing'
] as const) {
    test(`Pod ${reason} never falls back to pod exec`, async () => {
        const { factory, agent, calls } = rig('k8s', 'codex', { reason })
        await assert.rejects(factory.resolveRunner(agent), ChatRunnerError)
        assert.deepEqual(calls, ['resolve'])
    })
}

test('a newly starting Pod without a registered runner is retryable', async () => {
    const { factory, agent } = rig('k8s', 'codex', { reason: 'runner_missing' })
    await assert.rejects(factory.resolveRunner(agent), (err: unknown) => {
        assert.ok(err instanceof ChatRunnerError)
        assert.equal(err.chatError.code, 'chat_runner_unavailable')
        assert.equal(err.chatError.retryable, true)
        return true
    })
})

for (const runtime of ['sprites', 'k8s'] as const) {
    test(`${runtime}: gateway frameworks leave workspace resolution to the gateway`, async () => {
        for (const framework of ['openclaw', 'narranexus'] as const) {
            const { factory, agent, workspaces } = rig(runtime, framework)
            agent.workspacePath = '/not-yet-created/workspace'
            await factory.resolveRunner(agent)
            assert.deepEqual(workspaces, [null])
        }
        const coding = rig(runtime, 'codex')
        await coding.factory.resolveRunner(coding.agent)
        assert.deepEqual(coding.workspaces, [coding.agent.workspacePath])
    })
}

test('Sprite recovery reserves a slot and reads its account only once', async () => {
    const { factory, agent, calls } = rig('sprites', 'codex')
    const handle = await factory.recoveryFsForAgent(agent.id)
    assert.ok(handle.spritesClient)
    assert.deepEqual(calls, ['reserve', 'account', 'resolve'])
})

test('managed Sprite upgrade errors direct operators to the managed runner', () => {
    const error = new ChatRunnerError('sprites', 'missing feature', true)
    assert.match(error.chatError.message, /administrator.*managed Sprite runner/)
    assert.doesNotMatch(error.chatError.message, /Run mf update/)
})

test('OpenClaw history reuses the filesystem carrier without a second Sprite wake', async () => {
    const { factory, agent, calls } = rig('sprites', 'openclaw')
    const handle = await factory.recoveryFsForAgent(agent.id)
    assert.ok(await factory.openclawRpcForAgent(agent.id, handle.daemonId))
    assert.deepEqual(calls, ['reserve', 'account', 'resolve'])
})
