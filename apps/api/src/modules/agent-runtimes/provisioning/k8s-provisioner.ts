import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger
} from '@nestjs/common'
import { and, count, eq } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    hostDaemons,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'
import {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT,
    K8sCreateCleanupService
} from './k8s-create-cleanup.service'
import { PodHostServices } from './pod-host-services'
import { podServiceRecipe } from './pod-service-frameworks'
import { withdrawPodHostFramework } from './pod-host-network'

// Deletes k8s runtimes and pod hosts (ADR-0035, ADR-0037). A runtime is one
// framework on a pod host, so deleting it leaves the host and its home volume
// alone; the host is the machine and is deleted on its own, with everything
// on it — never while an agent still lives there (R8).
@Injectable()
export class K8sProvisioner {
    private readonly log = new Logger(K8sProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly clients: HostProviderClients,
        private readonly providers: SandboxProviderRegistry,
        private readonly tokens: DaemonTokenService,
        private readonly runtimes: AgentRuntimesService,
        private readonly createCleanup: K8sCreateCleanupService,
        private readonly podServices: PodHostServices
    ) {}

    private async podHostOf(runtime: AgentRuntimeRow): Promise<RuntimeHostRow> {
        const host = runtime.hostId
            ? await this.hosts.findById(runtime.hostId)
            : null
        if (!host || host.providerRef?.kind !== 'k8s')
            throw new Error(
                `K8sProvisioner: runtime ${runtime.id} is not on a pod host`
            )
        return host
    }

    async teardownRuntime(runtime: AgentRuntimeRow): Promise<void> {
        const host = await this.podHostOf(runtime)
        if (
            runtime.currentPhase === K8S_CREATE_CLEANUP_PENDING ||
            runtime.currentPhase === K8S_CREATE_INITIAL_AGENT
        ) {
            await this.createCleanup.retry(runtime)
            return
        }
        const [ready] = await this.db
            .select({ value: count() })
            .from(agents)
            .where(
                and(eq(agents.runtimeId, runtime.id), eq(agents.status, 'ready'))
            )
        if (Number(ready?.value ?? 0) > 0)
            throw new ConflictException({
                message: 'runtime still has agents; delete them first',
                code: 'RUNTIME_NOT_EMPTY'
            })
        await this.stopService(runtime, host)
        await this.runtimes.delete(runtime.id)
    }

    // A service framework leaving its host takes its process and its route
    // with it. Best effort: the row goes either way, and a host delete
    // removes whatever is left.
    private async stopService(
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow
    ): Promise<void> {
        const recipe = podServiceRecipe(runtime.framework)
        const ref = host.providerRef
        if (!recipe || ref?.kind !== 'k8s') return
        const hostRef = { id: host.id, userId: host.userId }
        try {
            await this.podServices.remove(hostRef, recipe.serviceName)
            const client = await this.clients.k8sClientForHost(host)
            await withdrawPodHostFramework({
                apis: client.apis,
                host: {
                    hostId: host.id,
                    userId: host.userId,
                    namespace: ref.namespace
                },
                framework: runtime.framework
            })
        } catch (err) {
            this.log.warn(
                `service cleanup failed runtimeId=${runtime.id} framework=${runtime.framework}: ${(err as Error).message}`
            )
        }
    }

    // `deleting` → tokens revoked → adapter.destroy → runtimes, daemon and
    // host rows gone in one transaction. A destroy that fails leaves the
    // host `deleting` with the reason, for a retry.
    async teardownHost(host: RuntimeHostRow): Promise<void> {
        if (host.kind !== 'hosted' || host.providerRef?.kind !== 'k8s')
            throw new BadRequestException(`host ${host.id} is not a pod host`)
        const [attached] = await this.db
            .select({ value: count() })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .where(eq(agentRuntimes.hostId, host.id))
        const n = Number(attached?.value ?? 0)
        if (n > 0)
            throw new ConflictException({
                message: `cloud computer still has ${n} agent(s); delete them first`,
                code: 'HOST_NOT_EMPTY',
                count: n
            })
        const provider = await this.clients.providerForHost(host)
        const adapter = this.providers.for(provider.kind)
        await this.db.transaction(async (tx) => {
            await this.hosts.patch(host.id, { status: 'deleting' }, tx)
            await this.tokens.revokeForHost(host.id, tx)
        })
        const generation = await this.hosts.bumpGeneration(host.id)
        const current = (await this.hosts.findById(host.id)) ?? host
        try {
            await adapter.destroy({ host: current, provider, generation })
        } catch (err) {
            const reason = (err as Error).message.slice(0, 512)
            this.log.warn(`pod host destroy failed hostId=${host.id}: ${reason}`)
            await this.hosts.setStatus(host.id, 'deleting', reason)
            throw err
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
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id))
            await tx.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id))
            await tx.delete(runtimeHosts).where(eq(runtimeHosts.id, host.id))
        })
    }

    async finalizeReady(runtimeId: string, now: Date): Promise<void> {
        await this.runtimes.applyStatusPatch(runtimeId, {
            status: 'ready',
            lastBootstrappedAt: now,
            failureReason: null
        })
        await this.runtimes.setPhase(runtimeId, null)
    }
}
