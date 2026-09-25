import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import {
    agentRuntimes,
    daemonTokens,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { podRunnerHostName } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { teardownCreatedPodHost } from '@/modules/agents/orchestration/k8s-strict-teardown'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { deletePodRunnerHostForPodHost } from '@/modules/agent-runtimes/sprite-runner-teardown'
import {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT,
    K8sCreateCleanupService
} from './k8s-create-cleanup.service'
import { PodHostServices } from './pod-host-services'
import { podServiceRecipe } from './pod-service-frameworks'
import { withdrawPodHostFramework } from './pod-host-network'

const HOST_TEARDOWN_TIMEOUT_MS = 180_000

// Deletes k8s runtimes and pod hosts (ADR-0035). A runtime is one framework on
// a pod host, so deleting it leaves the host and its home volume alone; the
// host is the machine and is deleted on its own, with everything on it.
@Injectable()
export class K8sProvisioner {
    private readonly log = new Logger(K8sProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService,
        private readonly runtimes: AgentRuntimesService,
        private readonly createCleanup: K8sCreateCleanupService,
        private readonly podServices: PodHostServices
    ) {}

    async teardownRuntime(runtime: AgentRuntimeRow): Promise<void> {
        if (runtime.kind !== 'k8s')
            throw new Error(
                `K8sProvisioner.teardownRuntime called for kind=${runtime.kind}`
            )
        if (
            runtime.currentPhase === K8S_CREATE_CLEANUP_PENDING ||
            runtime.currentPhase === K8S_CREATE_INITIAL_AGENT
        ) {
            await this.createCleanup.retry(runtime)
            return
        }
        await this.stopService(runtime)
        await this.runtimes.delete(runtime.id)
    }

    // A service framework leaving its host takes its process and its route
    // with it. Best effort: the row goes either way, and a host delete
    // removes whatever is left.
    private async stopService(runtime: AgentRuntimeRow): Promise<void> {
        const recipe = podServiceRecipe(runtime.framework)
        if (!recipe || !runtime.hostId || !runtime.namespace) return
        const host = { id: runtime.hostId, userId: runtime.userId }
        try {
            await this.podServices.remove(host, recipe.serviceName)
            const client = await this.k8s.getClient(runtime.clusterId)
            await withdrawPodHostFramework({
                apis: client.apis,
                host: {
                    hostId: runtime.hostId,
                    userId: runtime.userId,
                    namespace: runtime.namespace
                },
                framework: runtime.framework
            })
        } catch (err) {
            this.log.warn(
                `service cleanup failed runtimeId=${runtime.id} framework=${runtime.framework}: ${(err as Error).message}`
            )
        }
    }

    async teardownHost(host: RuntimeHostRow): Promise<void> {
        if (host.kind !== 'pod')
            throw new BadRequestException(`host ${host.id} is not a pod host`)
        try {
            await deletePodRunnerHostForPodHost(this.db, host.userId, host.id)
        } catch (err) {
            this.log.warn(
                `pod runner host cleanup failed hostId=${host.id}: ${(err as Error).message}`
            )
        }
        if (host.namespace) {
            const client = await this.k8s.getClient(host.clusterId)
            await teardownCreatedPodHost({
                apis: client.apis,
                namespace: host.namespace,
                hostId: host.id,
                signal: AbortSignal.timeout(HOST_TEARDOWN_TIMEOUT_MS)
            })
        }
        await this.db.transaction(async (tx) => {
            // A runtime added while the objects were going waits here, then
            // goes with the host.
            await tx
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, host.id))
                .for('update')
            await tx
                .delete(daemonTokens)
                .where(
                    and(
                        eq(daemonTokens.userId, host.userId),
                        eq(daemonTokens.name, podRunnerHostName(host.id)),
                        eq(daemonTokens.purpose, 'pod_runner')
                    )
                )
            await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id))
            await tx.delete(runtimeHosts).where(eq(runtimeHosts.id, host.id))
        })
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
