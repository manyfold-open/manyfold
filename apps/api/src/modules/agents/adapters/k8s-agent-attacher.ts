import { codingAgentWorkspacePath } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import type { Agent, AgentRuntimeRow } from '@manyfold/db'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { resolveAgentPod } from './k8s-pod-resolver'
import {
    assertWorkspaceUsableWithPodExec,
    isAgentWorkspaceManaged,
    resolveWorkspaceSelection
} from '@/modules/agents/workspace/workspace-preflight'

const EXEC_TIMEOUT_MS = 30_000

@Injectable()
export class K8sAgentAttacher {
    private readonly log = new Logger(K8sAgentAttacher.name)

    constructor(
        private readonly k8s: KubernetesService,
        private readonly podExecFactory: PodExecFactory
    ) {}

    async attach(args: {
        runtime: AgentRuntimeRow
        agentId: string
        primaryAgentId: string | null
        workspace?: string
    }): Promise<{ workspacePath: string; internalId: string }> {
        const pod = await resolveAgentPod(
            this.k8s,
            args.runtime,
            args.primaryAgentId
        )
        const exec = this.podExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const selection = resolveWorkspaceSelection(
            args.workspace,
            codingAgentWorkspacePath('k8s', args.agentId)
        )
        if (selection.managed) {
            const res = await exec.run({
                cmd: ['mkdir', '-p', selection.path],
                timeoutMs: EXEC_TIMEOUT_MS
            })
            if (res.exitCode !== 0)
                throw new Error(
                    `k8s mkdir failed (exit ${res.exitCode}) for runtime ${args.runtime.id} agent ${args.agentId}: ${res.stderr || res.stdout}`
                )
        } else {
            await assertWorkspaceUsableWithPodExec(exec, selection.path)
        }
        return { workspacePath: selection.path, internalId: args.agentId }
    }

    async detach(args: {
        runtime: AgentRuntimeRow
        agent: Agent
        primaryAgentId: string | null
    }): Promise<void> {
        if (!args.agent.workspacePath) return
        if (!isAgentWorkspaceManaged(args.agent)) return
        let pod
        try {
            pod = await resolveAgentPod(
                this.k8s,
                args.runtime,
                args.primaryAgentId
            )
        } catch (err) {
            this.log.warn(
                `k8s-agent-attacher detach: pod not found for runtime ${args.runtime.id} (agent ${args.agent.id}); skipping rm: ${(err as Error).message}`
            )
            return
        }
        const exec = this.podExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const res = await exec.run({
            cmd: ['rm', '-rf', '--', args.agent.workspacePath],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        if (res.exitCode !== 0) {
            this.log.warn(
                `k8s-agent-attacher detach: rm -rf exited ${res.exitCode} for agent ${args.agent.id} workspace ${args.agent.workspacePath} (best-effort; not re-thrown)`
            )
        }
    }
}
