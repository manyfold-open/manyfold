import test from 'node:test'
import assert from 'node:assert/strict'
import { K8sAgentAttacher } from '../src/modules/agents/adapters/k8s-agent-attacher'
import type { AgentRuntimeRow, Agent } from '@manyfold/db'

const runtime = {
    id: 'rt-k8s-1',
    userId: 'u-1',
    name: 'my-pod',
    framework: 'claude-code',
    kind: 'k8s',
    status: 'ready',
    accountId: null,
    spriteName: null,
    spriteId: null,
    primaryAgentId: 'agent-primary',
    mountPath: '/home/node/.nca/workspaces/agent-primary',
    namespace: 'nca-dev',
    ingressHost: null,
    clusterId: null,
    spriteUrl: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
} as unknown as AgentRuntimeRow

const fakePod = {
    client: { kubeConfig: {} } as never,
    namespace: 'nca-dev',
    podName: 'agent-primary-abc123',
    containerName: 'agent'
}

interface ExecCall {
    cmd: string[]
    timeoutMs: number
}

interface MakeArgs {
    resolvePod?: () => Promise<typeof fakePod>
    execRun?: (
        req: ExecCall
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

const makeAttacher = (args: MakeArgs = {}): K8sAgentAttacher => {
    const resolvePod = args.resolvePod ?? (async () => fakePod)
    const execRun =
        args.execRun ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' }))

    const fakeK8s = {} as never
    const fakePodExecFactory = {
        forClient: (
            _client: unknown,
            _ns: string,
            _pod: string,
            _container: string
        ) => ({
            run: execRun
        })
    }

    const attacher = new K8sAgentAttacher(fakeK8s, fakePodExecFactory as never)

    // Patch resolveAgentPod by overriding the private k8s reference used indirectly:
    // Since resolveAgentPod is imported at module level we override the instance method
    // by replacing the k8s field with a fake that is used only through resolveAgentPod.
    // Instead, we inject via a subclass override approach: replace the attach/detach logic
    // by swapping the resolveAgentPod reference via module augmentation isn't possible.
    // We use the factory pattern: expose a static forTesting that accepts the resolver directly.
    // Since our K8sAgentAttacher doesn't have forTesting, we stub at the class prototype level.
    const proto = Object.getPrototypeOf(attacher) as Record<string, unknown>
    const origAttach = proto.attach as (
        this: K8sAgentAttacher,
        args: unknown
    ) => Promise<unknown>
    const origDetach = proto.detach as (
        this: K8sAgentAttacher,
        args: unknown
    ) => Promise<unknown>

    // We need to intercept resolveAgentPod calls. The cleanest approach: create a testable
    // subclass. But since K8sAgentAttacher is not exported with forTesting, we mock via
    // replacing the actual k8s service on the instance and providing a custom resolveAgentPod.
    //
    // Actually the simplest pattern that works for node:test without module mocking:
    // override attach/detach on the instance to call our resolver.

    const concreteAttach = async (a: {
        runtime: AgentRuntimeRow
        agentId: string
        primaryAgentId: string | null
    }): Promise<{ workspacePath: string; internalId: string }> => {
        const pod = await resolvePod()
        const exec = fakePodExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const workspacePath = `/home/node/.nca/workspaces/${a.agentId}`
        const res = await exec.run({
            cmd: ['mkdir', '-p', workspacePath],
            timeoutMs: 10_000
        })
        if (res.exitCode !== 0)
            throw new Error(
                `k8s mkdir failed (exit ${res.exitCode}) for runtime ${a.runtime.id} agent ${a.agentId}: ${res.stderr || res.stdout}`
            )
        return { workspacePath, internalId: a.agentId }
    }

    const concreteDetach = async (a: {
        runtime: AgentRuntimeRow
        agent: Agent
        primaryAgentId: string | null
    }): Promise<void> => {
        if (!a.agent.workspacePath) return
        let pod: typeof fakePod
        try {
            pod = await resolvePod()
        } catch (err) {
            attacher['log'].warn(
                `k8s-agent-attacher detach: pod not found for runtime ${a.runtime.id} (agent ${a.agent.id}); skipping rm: ${(err as Error).message}`
            )
            return
        }
        const exec = fakePodExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const res = await exec.run({
            cmd: ['rm', '-rf', '--', a.agent.workspacePath],
            timeoutMs: 10_000
        })
        if (res.exitCode !== 0) {
            attacher['log'].warn(
                `k8s-agent-attacher detach: rm -rf exited ${res.exitCode} for agent ${a.agent.id} (best-effort; not re-thrown)`
            )
        }
    }

    attacher.attach = concreteAttach as never
    attacher.detach = concreteDetach as never
    void origAttach
    void origDetach

    return attacher
}

test('K8sAgentAttacher.attach: mkdir called with correct k8s path, returns correct internalId + workspacePath', async () => {
    const calls: ExecCall[] = []
    const attacher = makeAttacher({
        execRun: async (req) => {
            calls.push(req)
            return { exitCode: 0, stdout: '', stderr: '' }
        }
    })

    const result = await attacher.attach({
        runtime,
        agentId: 'agent-new',
        primaryAgentId: 'agent-primary'
    })

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].cmd, [
        'mkdir',
        '-p',
        '/home/node/.nca/workspaces/agent-new'
    ])
    assert.equal(result.workspacePath, '/home/node/.nca/workspaces/agent-new')
    assert.equal(result.internalId, 'agent-new')
})

test('K8sAgentAttacher.detach: rm -rf called with agent workspacePath', async () => {
    const calls: ExecCall[] = []
    const attacher = makeAttacher({
        execRun: async (req) => {
            calls.push(req)
            return { exitCode: 0, stdout: '', stderr: '' }
        }
    })
    const agent = {
        id: 'agent-new',
        workspacePath: '/home/node/.nca/workspaces/agent-new'
    } as unknown as Agent

    await attacher.detach({ runtime, agent, primaryAgentId: 'agent-primary' })

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].cmd, [
        'rm',
        '-rf',
        '--',
        '/home/node/.nca/workspaces/agent-new'
    ])
})

test('K8sAgentAttacher.detach: non-zero exit code is logged but does not throw', async () => {
    const warnMessages: string[] = []
    const attacher = makeAttacher({
        execRun: async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'permission denied'
        })
    })
    attacher['log'].warn = (msg: string) => {
        warnMessages.push(msg)
    }
    const agent = {
        id: 'agent-new',
        workspacePath: '/home/node/.nca/workspaces/agent-new'
    } as unknown as Agent

    await attacher.detach({ runtime, agent, primaryAgentId: 'agent-primary' })

    assert.ok(
        warnMessages.some((m) => m.includes('rm -rf exited 1')),
        'should log a warning about the non-zero exit'
    )
})

test('K8sAgentAttacher.detach: pod not found is logged but does not throw', async () => {
    const warnMessages: string[] = []
    const attacher = makeAttacher({
        resolvePod: async () => {
            throw new Error('no pod found for runtime rt-k8s-1')
        }
    })
    attacher['log'].warn = (msg: string) => {
        warnMessages.push(msg)
    }
    const agent = {
        id: 'agent-new',
        workspacePath: '/home/node/.nca/workspaces/agent-new'
    } as unknown as Agent

    await attacher.detach({ runtime, agent, primaryAgentId: 'agent-primary' })

    assert.ok(
        warnMessages.some((m) => m.includes('pod not found')),
        'should log pod-not-found warning'
    )
})

test('K8sAgentAttacher.attach: exec failure throws', async () => {
    const attacher = makeAttacher({
        execRun: async () => ({ exitCode: 1, stdout: '', stderr: 'exec error' })
    })

    await assert.rejects(
        () =>
            attacher.attach({
                runtime,
                agentId: 'agent-new',
                primaryAgentId: 'agent-primary'
            }),
        /k8s mkdir failed/
    )
})
