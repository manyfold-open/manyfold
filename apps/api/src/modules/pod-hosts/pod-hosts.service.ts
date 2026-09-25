import {
    cliChannelOfVersion,
    FEATURE_TOGGLE_KEYS,
    isCliUpdateAvailable,
    parseProbedSemver,
    podRunnerHostName,
    type MfCliChannel,
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
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, asc, count, eq, inArray, notInArray } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
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
import { K8sContainerProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { K8sProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-provisioner'
import {
    DaemonCliVersionService,
    type LatestCliVersion
} from '@/modules/daemon/daemon-cli-version.service'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { CliVersionCatalogService } from '@/modules/daemon/cli-version-catalog.service'
import { buildCliInstallScript } from '@/modules/agent-self/sprite-shell-env.service'
import { resolvePodHostPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'

const CLI_INSTALL_TIMEOUT_MS = 180_000

// Cloud computers (ADR-0035): what a user sees of a pod host, and the
// operations on the host itself. Agents land on a host through the agent
// create flow; this is the machine around them.
@Injectable()
export class PodHostsService {
    private readonly log = new Logger(PodHostsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly provisioner: K8sContainerProvisioner,
        private readonly k8sProvisioner: K8sProvisioner,
        private readonly adminSettings: AdminSettingsService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly daemonHosts: DaemonHostService,
        private readonly k8s: KubernetesService,
        private readonly podExec: PodExecFactory,
        // Appended last + @Optional: absence means the open defaults.
        @Optional()
        @Inject(CLOUD_COMPUTER_PORT)
        private readonly cloudComputer?: CloudComputerPort
    ) {}

    async list(userId: string): Promise<PodHostSummary[]> {
        const hosts = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(eq(runtimeHosts.userId, userId), eq(runtimeHosts.kind, 'pod'))
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
            clusterId: body.clusterId ?? null
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

    async delete(userId: string, id: string): Promise<void> {
        const host = await this.requireHost(userId, id)
        // Its bring-up is still creating objects; a teardown now could miss
        // the ones created after it. A bring-up that never finishes is marked
        // failed by the status sync, and can be deleted then.
        if (host.podStatus === 'provisioning')
            throw new ConflictException({
                message: `cloud computer ${id} is still being created`,
                code: 'POD_HOST_PROVISIONING'
            })
        await this.k8sProvisioner.teardownHost(host)
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
        const [existing] = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.hostId, host.id),
                    eq(agentRuntimes.kind, 'k8s'),
                    eq(agentRuntimes.framework, framework),
                    notInArray(agentRuntimes.status, ['failed', 'stopped'])
                )
            )
            .limit(1)
        if (existing) return this.runtimes.toSummary(existing)
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
        const [runner] = await this.runnerHosts(userId, [host.id])
        if (!runner)
            throw new ConflictException({
                message: `cloud computer ${id} has no registered daemon yet`,
                code: 'POD_HOST_DAEMON_MISSING'
            })
        // A daemon that knows its host restarts it (startup method
        // 'container') updates itself and exits, and the host's boot loop
        // starts the new binary from the home volume (ADR-0035). One baked
        // into an image from before that is installed over instead, and
        // stopped so the boot loop starts the binary just installed.
        if (runner.startupMethod === 'container')
            await this.daemonHosts.upgrade({
                host: runner,
                actorId: userId,
                targetVersion
            })
        else await this.installCliOver(host, targetVersion)
        return this.get(userId, id)
    }

    private async installCliOver(
        host: RuntimeHostRow,
        targetVersion?: string
    ): Promise<void> {
        let channel: MfCliChannel
        if (targetVersion) {
            if (!(await this.cliCatalog.isInstallableVersion(targetVersion)))
                throw new BadRequestException(
                    `unknown mf CLI version ${targetVersion}`
                )
            channel = cliChannelOfVersion(targetVersion)
        } else channel = (await this.cliVersion.getCachedLatest()).channel
        const pod = await resolvePodHostPod(this.k8s, {
            hostId: host.id,
            clusterId: host.clusterId,
            namespace: host.namespace
        })
        const exec = this.podExec.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const result = await exec
            .run({
                cmd: [
                    'bash',
                    '-lc',
                    [
                        buildCliInstallScript(channel, targetVersion),
                        'echo "mf-upgraded=$("$HOME/.local/bin/mf" --version 2>/dev/null | head -1)"',
                        'pkill -TERM -x mf || true'
                    ].join('\n')
                ],
                timeoutMs: CLI_INSTALL_TIMEOUT_MS
            })
            .catch((err: Error) => {
                throw new ServiceUnavailableException(
                    `mf CLI upgrade failed: ${err.message}`
                )
            })
        const line = `${result.stdout}\n${result.stderr}`
            .split('\n')
            .find((l) => l.startsWith('mf-upgraded='))
        const installed = parseProbedSemver(
            line ? line.slice('mf-upgraded='.length) : ''
        )
        if (result.exitCode !== 0 || !installed)
            throw new ServiceUnavailableException(
                `mf CLI upgrade did not complete on ${host.name}`
            )
        this.log.log(
            `pod host cli installed host=${host.id} version=${installed}`
        )
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
                    eq(runtimeHosts.kind, 'pod')
                )
            )
            .limit(1)
        if (!host) throw new NotFoundException(`cloud computer ${id} not found`)
        return host
    }

    // The managed daemon host each pod host's runner registered as.
    private async runnerHosts(
        userId: string,
        podHostIds: string[]
    ): Promise<RuntimeHostRow[]> {
        if (podHostIds.length === 0) return []
        return this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'daemon'),
                    eq(runtimeHosts.managed, true),
                    inArray(runtimeHosts.name, podHostIds.map(podRunnerHostName))
                )
            )
    }

    private async summaries(hosts: RuntimeHostRow[]): Promise<PodHostSummary[]> {
        if (hosts.length === 0) return []
        const ids = hosts.map((h) => h.id)
        const userId = hosts[0].userId
        const [runtimeRows, agentCounts, runners, latest] = await Promise.all([
            this.db
                .select()
                .from(agentRuntimes)
                .where(inArray(agentRuntimes.hostId, ids))
                .orderBy(asc(agentRuntimes.createdAt)),
            this.db
                .select({ hostId: agents.hostId, value: count() })
                .from(agents)
                .where(inArray(agents.hostId, ids))
                .groupBy(agents.hostId),
            this.runnerHosts(userId, ids),
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
        const runnerByName = new Map(runners.map((r) => [r.name, r]))
        return hosts.map((host) =>
            toPodHostSummary(host, {
                runtimes: runtimesByHost.get(host.id) ?? [],
                agentsCount: agentsByHost.get(host.id) ?? 0,
                runner: runnerByName.get(podRunnerHostName(host.id)) ?? null,
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
        runner: RuntimeHostRow | null
        latest: LatestCliVersion
    }
): PodHostSummary => {
    const cliVersion = rest.runner?.cliVersion ?? null
    return {
        id: host.id,
        userId: host.userId,
        name: host.name,
        status: host.podStatus ?? 'provisioning',
        phase: host.podPhase,
        failureReason: host.podFailureReason,
        clusterId: host.clusterId,
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
