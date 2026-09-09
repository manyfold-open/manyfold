import { Inject, Injectable, Logger } from '@nestjs/common'
import type { AgentRuntimeRow, Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { deletePodRunnerHostForRuntime } from '@/modules/agent-runtimes/sprite-runner-teardown'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import type { K8sApis } from '@/modules/k8s/kubernetes.service'
import { teardownAgent } from '@/modules/agents/orchestration/k8s-teardown'
import { resourceName } from '@/modules/agents/orchestration/k8s-resource-builder'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'

@Injectable()
export class K8sProvisioner {
    private readonly log = new Logger(K8sProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService,
        private readonly runtimes: AgentRuntimesService
    ) {}

    async teardownRuntime(
        runtime: AgentRuntimeRow,
        resourceKey: string
    ): Promise<void> {
        if (runtime.kind !== 'k8s')
            throw new Error(
                `K8sProvisioner.teardownRuntime called for kind=${runtime.kind}`
            )
        if (!runtime.namespace)
            throw new Error('k8s runtime has no namespace recorded')

        let apis: K8sApis | null = null
        try {
            const client = await this.k8s.getClient(runtime.clusterId)
            apis = client.apis
        } catch (err) {
            this.log.warn(
                `cluster unreachable for runtime=${runtime.id}: ${(err as Error).message}; falling back to DB-only cleanup`
            )
        }
        if (apis) {
            await teardownAgent({
                apis,
                namespace: runtime.namespace,
                agentId: resourceKey,
                envSecretName: `${resourceName(resourceKey)}-env`,
                ignoreNotFound: true,
                logger: this.log
            })
        }
        // The pod's runner host is keyed by RUNTIME id and hangs off daemon_id,
        // so `runtimes.delete` cannot reach it: without this the host stays
        // behind as a managed daemon with no pod, and its runtimes with it.
        await deletePodRunnerHostForRuntime(this.db, runtime.userId, runtime.id)
        await this.runtimes.delete(runtime.id)
    }

    async finalizeReady(runtimeId: string, now: Date): Promise<void> {
        await this.runtimes.applyStatusPatch(runtimeId, {
            status: 'ready',
            startedAt: now,
            lastBootstrappedAt: now,
            failureReason: null
        })
        await this.runtimes.setPhase(runtimeId, null)
    }
}
