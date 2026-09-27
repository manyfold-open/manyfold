import {
    FEATURE_TOGGLE_KEYS,
    daemonOnline,
    frameworkCapability,
    isCliUpdateAvailable,
    type AgentRuntimeSummary,
    type CreatePodHostBody,
    type PodHostSummary
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    runtimeProviders,
    type AgentRuntimeRow,
    type Database,
    type HostDaemonRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    CLOUD_COMPUTER_PORT,
    openCloudComputerPort,
    type CloudComputerPort
} from '@/common/ports/cloud-computer.ports'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { HostedHostLifecycleService } from '@/modules/agent-runtimes/hosted-host-lifecycle.service'
import { k8sRef } from '@/modules/agent-runtimes/host-ref'
import { K8sContainerProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { hostedOnProviderKind } from '@/modules/runtime-access/runtime-usage-counts'
import {
    DaemonCliVersionService,
    type LatestCliVersion
} from '@/modules/daemon/daemon-cli-version.service'
import { PodHostCliService } from '@/modules/chat/runner/pod-host-cli.service'

// Cloud computers (ADR-0035): what a user sees of a hosted k8s host, and the
// operations on the host itself. Agents land on a host through the agent
// create flow; this is the machine around them. Its daemon IS host_daemons
// for the host (ADR-0036).
@Injectable()
export class PodHostsService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly provisioner: K8sContainerProvisioner,
        private readonly lifecycle: HostedHostLifecycleService,
        private readonly adminSettings: AdminSettingsService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly cli: PodHostCliService,
        // Appended last + @Optional: absence means the open defaults.
        @Optional()
        @Inject(CLOUD_COMPUTER_PORT)
        private readonly cloudComputer?: CloudComputerPort
    ) {}

    private static podHosts = () =>
        and(eq(runtimeHosts.kind, 'hosted'), hostedOnProviderKind('k8s'))

    async list(userId: string): Promise<PodHostSummary[]> {
        const hosts = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(eq(runtimeHosts.userId, userId), PodHostsService.podHosts())
            )
            .orderBy(asc(runtimeHosts.createdAt))
        return this.summaries(hosts)
    }

    async get(userId: string, id: string): Promise<PodHostSummary> {
        const [summary] = await this.summaries([
            await this.requireHost(userId, id)
        ])
        return summary
    }

    async create(
        userId: string,
        body: CreatePodHostBody
    ): Promise<PodHostSummary> {
        if (
            !(await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.CLOUD_COMPUTER
            ))
        )
            throw new ForbiddenException({
                message: 'cloud computer is not currently available',
                code: 'CLOUD_COMPUTER_DISABLED',
                kind: 'k8s'
            })
        const spec = (
            this.cloudComputer ?? openCloudComputerPort
        ).selfServeContainerSpec()
        if (!spec)
            throw new ConflictException({
                message: 'cloud computers are purchased here, not created',
                code: 'CONTAINER_REQUIRED'
            })
        const host = await this.provisioner.createHost({
            userId,
            name: body.name ?? null,
            resources: spec,
            providerId: body.providerId ?? null
        })
        return this.get(userId, host.id)
    }

    async rename(
        userId: string,
        id: string,
        name: string
    ): Promise<PodHostSummary> {
        await this.requireHost(userId, id)
        await this.db
            .update(runtimeHosts)
            .set({ name, updatedAt: new Date() })
            .where(eq(runtimeHosts.id, id))
        return this.get(userId, id)
    }

    // R8: refused while agents exist; a host still being created is left to
    // its bring-up (a bring-up that never finishes is failed by the status
    // sync and can be deleted then).
    async delete(userId: string, id: string): Promise<void> {
        const host = await this.requireHost(userId, id)
        if (host.status === 'provisioning')
            throw new ConflictException({
                message: `cloud computer ${id} is still being created`,
                code: 'POD_HOST_PROVISIONING'
            })
        await this.lifecycle.deleteHost(host.id)
        await this.cloudComputer?.onPodHostTeardown(host.id)
    }

    async prepareRuntime(
        userId: string,
        id: string,
        framework: string
    ): Promise<AgentRuntimeSummary> {
        const host = await this.requireHost(userId, id)
        const denial = await this.cloudComputer?.agentAttachDenial({
            podHostId: host.id,
            isAdmin: false
        })
        if (denial)
            throw new ConflictException({
                message: denial.message,
                code: denial.code
            })
        const existing = await this.runtimes.findRuntimeOnHost(host.id, framework)
        if (existing && existing.status !== 'failed')
            return this.runtimes.toSummary(existing)
        // A service framework's gateway is configured with its provider, so it
        // is installed when its first agent is created.
        if (frameworkCapability(framework).kind === 'service')
            throw new BadRequestException({
                code: 'POD_HOST_SERVICE_AT_CREATE',
                message: `${framework} is installed on a cloud computer with its first agent`
            })
        // Bare, like a sandbox's prepared runtime: the key an agent's turns
        // use travels with each turn, so the install needs none.
        const runtime = await this.provisioner.addFrameworkRuntime({
            userId,
            host,
            framework,
            name: framework,
            credentials: null
        })
        return this.runtimes.toSummary(runtime)
    }

    async upgradeCli(
        userId: string,
        id: string,
        targetVersion?: string
    ): Promise<PodHostSummary> {
        const host = await this.requireHost(userId, id)
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (!daemon)
            throw new ConflictException({
                message: `cloud computer ${id} has no registered daemon yet`,
                code: 'POD_HOST_DAEMON_MISSING'
            })
        await this.cli.update({ host, actorId: userId, targetVersion })
        return this.get(userId, id)
    }

    private async requireHost(
        userId: string,
        id: string
    ): Promise<RuntimeHostRow> {
        const [host] = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, id),
                    eq(runtimeHosts.userId, userId),
                    PodHostsService.podHosts()
                )
            )
            .limit(1)
        if (!host) throw new NotFoundException(`cloud computer ${id} not found`)
        return host
    }

    private async summaries(hosts: RuntimeHostRow[]): Promise<PodHostSummary[]> {
        if (hosts.length === 0) return []
        const ids = hosts.map((h) => h.id)
        const providerIds = [
            ...new Set(
                hosts
                    .map((h) => h.providerId)
                    .filter((id): id is string => typeof id === 'string')
            )
        ]
        const [runtimeRows, agentCounts, daemons, providerRows, latest] =
            await Promise.all([
                this.db
                    .select()
                    .from(agentRuntimes)
                    .where(inArray(agentRuntimes.hostId, ids))
                    .orderBy(asc(agentRuntimes.createdAt)),
                this.db
                    .select({ hostId: agentRuntimes.hostId, value: count() })
                    .from(agents)
                    .innerJoin(
                        agentRuntimes,
                        eq(agentRuntimes.id, agents.runtimeId)
                    )
                    .where(inArray(agentRuntimes.hostId, ids))
                    .groupBy(agentRuntimes.hostId),
                this.hostDaemons.findByHostIds(ids),
                providerIds.length
                    ? this.db
                          .select({
                              id: runtimeProviders.id,
                              name: runtimeProviders.name
                          })
                          .from(runtimeProviders)
                          .where(inArray(runtimeProviders.id, providerIds))
                    : [],
                this.cliVersion.getCachedLatest()
            ])
        const runtimeSummaries = await this.runtimes.toSummaries(runtimeRows)
        const runtimesByHost = new Map<string, AgentRuntimeSummary[]>()
        runtimeRows.forEach((row: AgentRuntimeRow, i) => {
            const list = runtimesByHost.get(row.hostId!) ?? []
            list.push(runtimeSummaries[i])
            runtimesByHost.set(row.hostId!, list)
        })
        const agentsByHost = new Map(
            agentCounts.map((row) => [row.hostId, Number(row.value)])
        )
        const providerNames = new Map(providerRows.map((p) => [p.id, p.name]))
        return hosts.map((host) =>
            toPodHostSummary(host, {
                runtimes: runtimesByHost.get(host.id) ?? [],
                agentsCount: agentsByHost.get(host.id) ?? 0,
                daemon: daemons.get(host.id) ?? null,
                providerName: host.providerId
                    ? (providerNames.get(host.providerId) ?? null)
                    : null,
                latest
            })
        )
    }
}

const toPodHostSummary = (
    host: RuntimeHostRow,
    rest: {
        runtimes: AgentRuntimeSummary[]
        agentsCount: number
        daemon: HostDaemonRow | null
        providerName: string | null
        latest: LatestCliVersion
    }
): PodHostSummary => {
    const cliVersion = rest.daemon?.cliVersion ?? null
    return {
        id: host.id,
        userId: host.userId,
        name: host.name,
        status: host.status,
        phase: k8sRef(host)?.podPhase ?? null,
        failureReason: host.failureReason,
        providerId: host.providerId,
        providerName: rest.providerName,
        powerState: host.powerState,
        daemonOnline: daemonOnline(rest.daemon),
        region: host.region,
        cpuMillicores: host.cpuMillicores,
        memoryMb: host.memoryMb,
        diskGb: host.diskGb,
        cliVersion,
        latestCliVersion: rest.latest.version,
        // Nothing to update before the daemon has registered.
        cliUpdateAvailable:
            cliVersion !== null &&
            isCliUpdateAvailable(
                rest.latest.channel,
                cliVersion,
                rest.latest.version
            ),
        runtimes: rest.runtimes,
        agentsCount: rest.agentsCount,
        createdAt: host.createdAt.toISOString(),
        updatedAt: host.updatedAt.toISOString()
    }
}
