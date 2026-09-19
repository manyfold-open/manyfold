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
    const resolution = async () => {
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
            getById: async () => ({ slug: 'account' }),
            decryptToken: () => 'fixture'
        } as never,
        {} as never,
        {} as never,
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
        { reserveActiveSlot: async () => {} } as never,
        { measureIfDue: () => {} } as never,
        {} as never,
        { resolveAgentEnv: async () => ({ CONNECTION: 'value' }) } as never,
        { get: () => 'https://api.example.test' } as never,
        undefined,
        undefined,
        { ensureRunner: resolution, resolvePodRunner: resolution } as never
    )
    return { factory, agent, calls }
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
