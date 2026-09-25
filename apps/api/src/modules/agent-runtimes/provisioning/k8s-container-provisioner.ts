import type { ProvisionableContainerSku } from '@/common/ports/cloud-computer.ports'
import {
    createObjectId,
    K8S_HOME_BASE,
    podRunnerHostName,
    type AgentFramework,
    type AgentModelConfigSource,
    type FrameworkVersionSelection
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    GatewayTimeoutException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    serviceLeases,
    k8sClusters,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type K8sCluster,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { deletePodRunnerHostForPodHost } from '@/modules/agent-runtimes/sprite-runner-teardown'
import {
    PodRunnerProvisioner,
    type PodRunnerProvision
} from './pod-runner-provisioner'
import { K8sProvisioner } from './k8s-provisioner'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    KubernetesService,
    type K8sApis,
    type K8sClient
} from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import { resolvePodHostPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import { teardownCreatedPodHost } from '@/modules/agents/orchestration/k8s-strict-teardown'
import {
    buildPodHostDeployment,
    buildPodHostPvc,
    buildPodHostSecret,
    podHostResourceName,
    type PodHostSpec
} from './pod-host-resources'
import {
    isPodHostFramework,
    podScriptRunner,
    setUpPodFramework,
    type PodHostFramework
} from './pod-framework-setup'
import {
    describeK8sCreateError,
    K8S_CREATE_INITIAL_AGENT,
    K8sCreateCleanupService
} from './k8s-create-cleanup.service'
import {
    insertK8sCreateLease,
    K8sCreateOwnership,
    k8sCreateLeaseName
} from './k8s-create-ownership'

const DEFAULT_READINESS_TIMEOUT_MS = 180_000
const HOST_TEARDOWN_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000
const DEFAULT_HOST_SUFFIX = '18.135.81.53.nip.io'
const DEFAULT_STORAGE_CLASS = 'standard'
// Parent of every agent workspace on a pod host, and the directory the host's
// daemon declared as its workspace root when it registered.
export const POD_HOST_WORKSPACE_BASE = `${K8S_HOME_BASE}/.manyfold/workspaces`
const INSTALLING_FRAMEWORK = 'installing_framework'

export interface PodHostResources {
    cpuMillicores: number
    memoryMb: number
    diskGb: number
}

export interface ProvisionContainerInput {
    userId: string
    sku: ProvisionableContainerSku
    // The host's first framework runtime.
    framework: AgentFramework
    // The framework runtime's name; the host gets `hostName`, else the next
    // computer-NNN.
    name: string
    hostName?: string | null
    credentials: unknown
    // 'runtime-local' keeps provider keys out of the platform's hands: no
    // config pinned to a platform provider and no key-based login.
    modelConfigSource?: AgentModelConfigSource | null
    // Self-serve (BYO) creates name their cluster; purchased SKUs pick by
    // region. Ignored when null/undefined.
    clusterId?: string | null
    // Internal capability: a self-serve create owns this fresh runtime until
    // its one preallocated agent and runtime-local config have committed.
    agentCreateId?: string
    // The version the framework installs, resolved by the caller from what the
    // user asked for; absent means the default (admin pin, else latest).
    frameworkVersion?: FrameworkVersionSelection | null
}

export interface ProvisionContainerResult {
    runtime: AgentRuntimeRow
}

export interface ProvisionAgentContainerResult extends ProvisionContainerResult {
    assertAgentCreateActive(): Promise<void>
    runAgentCreate<T>(work: () => Promise<T>): Promise<T>
    completeAgentCreate(): Promise<void>
    rollbackAgentCreate(error: unknown): Promise<void>
}

// Cluster choice for a pod host: an explicit cluster (BYO self-serve) must
// exist and have passed its last health check; otherwise the healthiest
// match wins — region-scoped for purchased SKUs, any region for self-serve
// (whose sku.region is null).
export const pickProvisionCluster = async (
    db: Database,
    args: { clusterId: string | null; region: string | null }
): Promise<K8sCluster> => {
    if (args.clusterId) {
        const [row] = await db
            .select()
            .from(k8sClusters)
            .where(
                and(
                    eq(k8sClusters.id, args.clusterId),
                    eq(k8sClusters.lastHealthStatus, 'ok')
                )
            )
            .limit(1)
        if (!row)
            throw new ServiceUnavailableException(
                `k8s cluster ${args.clusterId} is not available (unknown, or its last health check failed)`
            )
        return row
    }
    const [row] = await db
        .select()
        .from(k8sClusters)
        .where(
            args.region !== null
                ? and(
                      eq(k8sClusters.region, args.region),
                      eq(k8sClusters.lastHealthStatus, 'ok')
                  )
                : eq(k8sClusters.lastHealthStatus, 'ok')
        )
        .orderBy(desc(k8sClusters.priority))
        .limit(1)
    if (!row)
        throw new ServiceUnavailableException(
            args.region !== null
                ? `no healthy k8s cluster available in region ${args.region}`
                : 'no healthy k8s cluster available'
        )
    return row
}

export function assertPodHostFramework(
    framework: AgentFramework
): asserts framework is PodHostFramework {
    if (!isPodHostFramework(framework))
        throw new BadRequestException({
            code: 'FRAMEWORK_NOT_ON_POD_HOST',
            message: `${framework} cannot run on a cloud computer yet`,
            framework
        })
}

interface HostPlacement {
    hostId: string
    cluster: K8sCluster
    client: K8sClient
    namespace: string
    ingressHost: string
}

// A Kubernetes pod host (ADR-0035): one pod running the generic host image,
// whose PVC is the home directory every framework on it is installed into.
// provision() makes a host together with its first framework runtime (the
// self-serve agent create and a purchased container); createHost() makes a
// bare one; addFrameworkRuntime() installs another framework on a ready host.
@Injectable()
export class K8sContainerProvisioner {
    private readonly log = new Logger(K8sContainerProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService,
        private readonly config: ConfigService,
        private readonly crypto: CryptoService,
        private readonly podRunner: PodRunnerProvisioner,
        private readonly createCleanup: K8sCreateCleanupService,
        private readonly podExec: PodExecFactory,
        private readonly frameworkVersions: FrameworkVersionsService,
        private readonly k8sProvisioner: K8sProvisioner
    ) {}

    async provision(
        input: ProvisionContainerInput & { agentCreateId: string }
    ): Promise<ProvisionAgentContainerResult>
    async provision(
        input: ProvisionContainerInput
    ): Promise<ProvisionContainerResult>
    async provision(
        input: ProvisionContainerInput
    ): Promise<ProvisionContainerResult | ProvisionAgentContainerResult> {
        const { userId, sku, name, framework } = input
        assertPodHostFramework(framework)

        const cluster = await pickProvisionCluster(this.db, {
            clusterId: input.clusterId ?? null,
            region: sku.region
        })
        if (input.agentCreateId)
            await this.createCleanup.assertClusterAvailable(userId, cluster.id)
        const placement = await this.place(userId, cluster)
        const runtimeId = createObjectId('agentRuntime')
        const now = new Date()
        await this.db.transaction(async (tx) => {
            await tx
                .insert(runtimeHosts)
                .values(
                    await this.hostRow(
                        tx,
                        userId,
                        placement,
                        sku,
                        input.hostName ?? null
                    )
                )
            await tx.insert(agentRuntimes).values({
                ...this.runtimeRowPlacement(placement, sku),
                id: runtimeId,
                userId,
                name,
                framework,
                kind: 'k8s',
                status: 'pending',
                currentPhase: input.agentCreateId
                    ? K8S_CREATE_INITIAL_AGENT
                    : INSTALLING_FRAMEWORK,
                purchasedAt: now
            })
            if (input.agentCreateId)
                await insertK8sCreateLease(tx, runtimeId, input.agentCreateId)
        })

        const ownership = input.agentCreateId
            ? new K8sCreateOwnership(this.db, runtimeId, input.agentCreateId)
            : undefined
        const provisionState: { podRunner: PodRunnerProvision | null } = {
            podRunner: null
        }
        try {
            await ownership?.start()
            const provision = async (): Promise<
                ProvisionContainerResult | ProvisionAgentContainerResult
            > => {
                await this.bringUpHost({
                    userId,
                    placement,
                    sku,
                    ownership,
                    provisionState
                })
                const frameworkVersion = await this.installFramework({
                    userId,
                    host: placement,
                    framework,
                    credentials: input.credentials,
                    modelConfigSource: input.modelConfigSource ?? null,
                    requested: input.frameworkVersion ?? null
                })
                if (ownership)
                    await ownership.mutate((tx) =>
                        this.persistRuntimeCredentials(
                            runtimeId,
                            framework,
                            input.credentials,
                            tx
                        )
                    )
                else
                    await this.persistRuntimeCredentials(
                        runtimeId,
                        framework,
                        input.credentials
                    )

                await ownership?.assertActive()
                const readyAt = new Date()
                const updateReady = (db: Pick<Database, 'update'>) =>
                    db
                        .update(agentRuntimes)
                        .set({
                            status: input.agentCreateId ? 'pending' : 'ready',
                            currentPhase: input.agentCreateId
                                ? K8S_CREATE_INITIAL_AGENT
                                : null,
                            failureReason: null,
                            frameworkVersion,
                            frameworkVersionCheckedAt: readyAt,
                            startedAt: readyAt,
                            lastBootstrappedAt: readyAt,
                            updatedAt: readyAt
                        })
                        .where(
                            and(
                                eq(agentRuntimes.id, runtimeId),
                                input.agentCreateId
                                    ? eq(agentRuntimes.status, 'pending')
                                    : undefined,
                                input.agentCreateId
                                    ? eq(
                                          agentRuntimes.currentPhase,
                                          K8S_CREATE_INITIAL_AGENT
                                      )
                                    : undefined
                            )
                        )
                        .returning()
                const [updated] = ownership
                    ? await ownership.mutate(updateReady)
                    : await updateReady(this.db)
                if (!updated)
                    throw new Error('container provisioning ownership changed')
                const agentId = input.agentCreateId
                if (agentId)
                    return {
                        runtime: updated,
                        assertAgentCreateActive: () =>
                            ownership!.assertActive(),
                        runAgentCreate: (work) => ownership!.run(work),
                        completeAgentCreate: async () => {
                            await this.db.transaction(async (tx) => {
                                await ownership!.assertInTx(tx)
                                const rows = await tx
                                    .update(agentRuntimes)
                                    .set({
                                        status: 'ready',
                                        currentPhase: null,
                                        failureReason: null,
                                        updatedAt: new Date()
                                    })
                                    .where(
                                        and(
                                            eq(agentRuntimes.id, runtimeId),
                                            eq(agentRuntimes.userId, userId),
                                            eq(agentRuntimes.status, 'pending'),
                                            eq(
                                                agentRuntimes.currentPhase,
                                                K8S_CREATE_INITIAL_AGENT
                                            ),
                                            eq(
                                                agentRuntimes.primaryAgentId,
                                                agentId
                                            )
                                        )
                                    )
                                    .returning({ id: agentRuntimes.id })
                                if (rows.length !== 1)
                                    throw new Error(
                                        'fresh container creation ownership changed'
                                    )
                                const published = await tx
                                    .update(agents)
                                    .set({
                                        status: 'running',
                                        updatedAt: new Date()
                                    })
                                    .where(
                                        and(
                                            eq(agents.id, agentId),
                                            eq(agents.runtimeId, runtimeId),
                                            eq(agents.userId, userId),
                                            eq(agents.status, 'pending')
                                        )
                                    )
                                    .returning({ id: agents.id })
                                if (published.length !== 1)
                                    throw new Error(
                                        'fresh agent creation ownership changed'
                                    )
                                await tx
                                    .delete(serviceLeases)
                                    .where(
                                        eq(
                                            serviceLeases.name,
                                            k8sCreateLeaseName(runtimeId)
                                        )
                                    )
                            })
                            await ownership!.stop()
                        },
                        rollbackAgentCreate: async (error) =>
                            this.createCleanup.rollback({
                                requestsSettled: await ownership!.stop(),
                                runtimeId,
                                userId,
                                agentId,
                                error,
                                apis: placement.client.apis,
                                clusterId: cluster.id,
                                namespace: placement.namespace
                            })
                    }
                return { runtime: updated }
            }
            return ownership
                ? await ownership.run(provision)
                : await provision()
        } catch (err) {
            const reason = input.agentCreateId
                ? describeK8sCreateError(err)
                : sanitizeReason(err)
            this.log.warn(
                `pod host provision failed hostId=${placement.hostId} runtimeId=${runtimeId} framework=${framework}: ${reason}`
            )
            if (input.agentCreateId) {
                await this.createCleanup.rollback({
                    requestsSettled: await ownership!.stop(),
                    runtimeId,
                    userId,
                    agentId: input.agentCreateId,
                    error: err,
                    apis: placement.client.apis,
                    clusterId: cluster.id,
                    namespace: placement.namespace
                })
                if (err instanceof GatewayTimeoutException) throw err
                throw new InternalServerErrorException({
                    message: 'container provisioning failed',
                    reason
                })
            }
            await this.discardHost(
                placement,
                userId,
                provisionState.podRunner,
                reason
            )
            if (err instanceof GatewayTimeoutException) throw err
            throw new InternalServerErrorException({
                message: 'container provisioning failed',
                reason
            })
        }
    }

    // A bare host with no framework yet (ADR-0035 §2): frameworks are added to
    // it with addFrameworkRuntime. Returns once the host is recorded; the pod
    // comes up in the background, and the row says how that went — ready, or
    // failed with the reason, its objects removed.
    async createHost(input: {
        userId: string
        name?: string | null
        resources: PodHostResources
        region?: string | null
        clusterId?: string | null
    }): Promise<RuntimeHostRow> {
        const cluster = await pickProvisionCluster(this.db, {
            clusterId: input.clusterId ?? null,
            region: input.region ?? null
        })
        const placement = await this.place(input.userId, cluster)
        const sku = { ...input.resources, region: input.region ?? null }
        const [host] = await this.db.transaction(async (tx) =>
            tx
                .insert(runtimeHosts)
                .values(
                    await this.hostRow(
                        tx,
                        input.userId,
                        placement,
                        sku,
                        input.name ?? null
                    )
                )
                .returning()
        )
        void inBackgroundContext(() =>
            this.bringUpBareHost(input.userId, placement, sku)
        )()
        return host
    }

    private async bringUpBareHost(
        userId: string,
        placement: HostPlacement,
        sku: PodHostResources
    ): Promise<void> {
        const provisionState: { podRunner: PodRunnerProvision | null } = {
            podRunner: null
        }
        try {
            await this.bringUpHost({ userId, placement, sku, provisionState })
        } catch (err) {
            const reason = sanitizeReason(err)
            this.log.warn(
                `pod host create failed hostId=${placement.hostId}: ${reason}`
            )
            await this.discardHost(
                placement,
                userId,
                provisionState.podRunner,
                reason,
                { keepRow: true }
            ).catch((cleanupErr: Error) =>
                this.log.error(
                    `pod host cleanup crashed hostId=${placement.hostId}: ${cleanupErr.message}`
                )
            )
        }
    }

    // Install `framework` on a ready pod host as a new runtime. The host keeps
    // whatever else it runs; a failed install leaves no runtime behind.
    async addFrameworkRuntime(input: {
        userId: string
        host: RuntimeHostRow
        framework: AgentFramework
        name: string
        credentials: unknown
        modelConfigSource?: AgentModelConfigSource | null
        frameworkVersion?: FrameworkVersionSelection | null
    }): Promise<AgentRuntimeRow> {
        const { host, framework, userId } = input
        assertPodHostFramework(framework)
        if (host.kind !== 'pod' || host.userId !== userId)
            throw new NotFoundException(`cloud computer ${host.id} not found`)
        if (host.podStatus !== 'ready' || !host.namespace)
            throw new ConflictException({
                code: 'POD_HOST_NOT_READY',
                message: `cloud computer ${host.id} is not ready`,
                status: host.podStatus
            })
        const runtimeId = createObjectId('agentRuntime')
        try {
            await this.db.insert(agentRuntimes).values({
                id: runtimeId,
                userId,
                name: input.name,
                framework,
                kind: 'k8s',
                status: 'pending',
                currentPhase: INSTALLING_FRAMEWORK,
                hostId: host.id,
                clusterId: host.clusterId,
                namespace: host.namespace,
                ingressHost: host.ingressHost,
                mountPath: POD_HOST_WORKSPACE_BASE,
                cpuMillicores: host.cpuMillicores,
                memoryMb: host.memoryMb,
                diskGb: host.diskGb,
                region: host.region
            })
        } catch (err) {
            if (isUniqueViolation(err))
                throw new ConflictException({
                    code: 'POD_HOST_FRAMEWORK_EXISTS',
                    message: `cloud computer ${host.id} already runs ${framework}`,
                    framework
                })
            throw err
        }
        try {
            const client = await this.k8s.getClient(host.clusterId)
            const frameworkVersion = await this.installFramework({
                userId,
                host: {
                    hostId: host.id,
                    client,
                    namespace: host.namespace
                },
                framework,
                credentials: input.credentials,
                modelConfigSource: input.modelConfigSource ?? null,
                requested: input.frameworkVersion ?? null
            })
            await this.persistRuntimeCredentials(
                runtimeId,
                framework,
                input.credentials
            )
            const readyAt = new Date()
            const [updated] = await this.db
                .update(agentRuntimes)
                .set({
                    status: 'ready',
                    currentPhase: null,
                    failureReason: null,
                    frameworkVersion,
                    frameworkVersionCheckedAt: readyAt,
                    startedAt: readyAt,
                    lastBootstrappedAt: readyAt,
                    updatedAt: readyAt
                })
                .where(eq(agentRuntimes.id, runtimeId))
                .returning()
            return updated
        } catch (err) {
            this.log.warn(
                `framework install failed hostId=${host.id} framework=${framework}: ${sanitizeReason(err)}`
            )
            await this.db
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.id, runtimeId))
            throw new InternalServerErrorException({
                message: `installing ${framework} failed`,
                reason: sanitizeReason(err)
            })
        }
    }

    // Removes one framework runtime (its agents and credentials cascade); the
    // host stays. See K8sProvisioner for both deletes.
    async teardown(runtime: AgentRuntimeRow): Promise<void> {
        await this.k8sProvisioner.teardownRuntime(runtime)
    }

    async teardownHost(host: RuntimeHostRow): Promise<void> {
        await this.k8sProvisioner.teardownHost(host)
    }

    private async place(
        userId: string,
        cluster: K8sCluster
    ): Promise<HostPlacement> {
        const hostId = createObjectId('podHost')
        const client = await this.k8s.getClient(cluster.id)
        const namespace = await this.k8s.ensureUserNamespace(client, userId)
        const hostSuffix =
            cluster.hostSuffix ??
            this.config.get<string>('K8S_INGRESS_HOST_SUFFIX') ??
            DEFAULT_HOST_SUFFIX
        return {
            hostId,
            cluster,
            client,
            namespace,
            ingressHost: `${podHostResourceName(hostId)}.${hostSuffix}`
        }
    }

    private async hostRow(
        tx: Pick<Database, 'execute'>,
        userId: string,
        placement: HostPlacement,
        sku: PodHostResources & { region: string | null },
        name: string | null
    ) {
        return {
            id: placement.hostId,
            userId,
            kind: 'pod' as const,
            name: name?.trim() || (await this.nextHostName(tx, userId)),
            clusterId: placement.cluster.id,
            namespace: placement.namespace,
            ingressHost: placement.ingressHost,
            cpuMillicores: sku.cpuMillicores,
            memoryMb: sku.memoryMb,
            diskGb: sku.diskGb,
            region: sku.region,
            homeDir: K8S_HOME_BASE,
            workspaceBaseDir: POD_HOST_WORKSPACE_BASE,
            podStatus: 'provisioning' as const,
            podPhase: 'preparing_namespace'
        }
    }

    private runtimeRowPlacement(
        placement: HostPlacement,
        sku: PodHostResources & { region: string | null }
    ) {
        return {
            hostId: placement.hostId,
            clusterId: placement.cluster.id,
            namespace: placement.namespace,
            ingressHost: placement.ingressHost,
            mountPath: POD_HOST_WORKSPACE_BASE,
            cpuMillicores: sku.cpuMillicores,
            memoryMb: sku.memoryMb,
            diskGb: sku.diskGb,
            region: sku.region
        }
    }

    // computer-001, computer-002, … per user. Names are display labels, not
    // addresses, so a race that repeats one costs nothing.
    private async nextHostName(
        tx: Pick<Database, 'execute'>,
        userId: string
    ): Promise<string> {
        const rows = (await tx.execute(sql`
            select coalesce(
                max((regexp_match(name, '^computer-([0-9]+)$'))[1]::int),
                0
            ) as max
            from runtime_hosts
            where user_id = ${userId} and kind = 'pod'
        `)) as unknown as Array<{ max: number | string | null }>
        const next = Number(rows[0]?.max ?? 0) + 1
        return `computer-${String(next).padStart(3, '0')}`
    }

    // Creates the host's Secret, PVC and Deployment, then waits until the pod
    // runs and its daemon has registered: only then can anything be installed
    // on it or a turn reach it.
    private async bringUpHost(args: {
        userId: string
        placement: HostPlacement
        sku: PodHostResources
        ownership?: K8sCreateOwnership
        provisionState: { podRunner: PodRunnerProvision | null }
    }): Promise<void> {
        const { placement, ownership } = args
        const { hostId, namespace } = placement
        const apis = placement.client.apis
        const requestOptions = ownership?.requestOptions
        const mintInput = { userId: args.userId, podHostId: hostId }
        const podRunner = ownership
            ? await ownership.mutate((tx) =>
                  this.podRunner.mint(mintInput, tx)
              )
            : await this.podRunner.mint(mintInput)
        args.provisionState.podRunner = podRunner
        const spec: PodHostSpec = {
            hostId,
            userId: args.userId,
            namespace,
            image: this.hostImage(),
            storageClass:
                this.config.get<string>('K8S_STORAGE_CLASS') ??
                DEFAULT_STORAGE_CLASS,
            storageSize: `${args.sku.diskGb}Gi`,
            resources: {
                requests: {
                    cpu: `${args.sku.cpuMillicores}m`,
                    memory: `${args.sku.memoryMb}Mi`
                },
                limits: {
                    cpu: `${args.sku.cpuMillicores}m`,
                    memory: `${args.sku.memoryMb}Mi`
                }
            }
        }
        await this.setHostPhase(hostId, 'creating_secret')
        await apis.core.createNamespacedSecret(
            { namespace, body: buildPodHostSecret(spec, podRunner.env) },
            requestOptions
        )
        await this.setHostPhase(hostId, 'creating_storage')
        await apis.core.createNamespacedPersistentVolumeClaim(
            { namespace, body: buildPodHostPvc(spec) },
            requestOptions
        )
        await this.setHostPhase(hostId, 'creating_deployment')
        await apis.apps.createNamespacedDeployment(
            { namespace, body: buildPodHostDeployment(spec) },
            requestOptions
        )
        await this.setHostPhase(hostId, 'waiting_for_ready')
        const timeoutMs =
            Number(this.config.get<string>('K8S_CONTAINER_PROVISION_TIMEOUT_MS')) ||
            DEFAULT_READINESS_TIMEOUT_MS
        await this.waitForHost({
            ownership,
            apis,
            userId: args.userId,
            hostId,
            namespace,
            deadline: Date.now() + timeoutMs
        })
        await this.db
            .update(runtimeHosts)
            .set({
                podStatus: 'ready',
                podPhase: null,
                podFailureReason: null,
                updatedAt: new Date()
            })
            .where(eq(runtimeHosts.id, hostId))
    }

    private hostImage(): string {
        const image = this.config.get<string>('K8S_RUNTIME_IMAGE')
        if (!image)
            throw new InternalServerErrorException(
                'K8S_RUNTIME_IMAGE is not set'
            )
        return image
    }

    private async installFramework(args: {
        userId: string
        host: Pick<HostPlacement, 'hostId' | 'client' | 'namespace'>
        framework: AgentFramework
        credentials: unknown
        modelConfigSource: AgentModelConfigSource | null
        requested: FrameworkVersionSelection | null
    }): Promise<string | null> {
        assertPodHostFramework(args.framework)
        const selection =
            args.requested ??
            (await this.frameworkVersions.resolveInstallVersion(args.framework))
                .selection
        const pod = await resolvePodHostPod(this.k8s, {
            hostId: args.host.hostId,
            clusterId: null,
            namespace: args.host.namespace,
            client: args.host.client
        })
        const exec = this.podExec.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const { frameworkVersion } = await setUpPodFramework({
            runner: podScriptRunner(exec, (event, fields) =>
                this.log.warn(
                    `${event} ${JSON.stringify({ hostId: args.host.hostId, ...fields })}`
                )
            ),
            framework: args.framework,
            workspaceBase: POD_HOST_WORKSPACE_BASE,
            credentials: args.credentials,
            modelConfigSource: args.modelConfigSource,
            install: {
                frameworkVersion: selection.version,
                frameworkVersionSource: selection.source
            }
        })
        return frameworkVersion
    }

    private async persistRuntimeCredentials(
        runtimeId: string,
        framework: AgentFramework,
        credentials: unknown,
        db: Pick<Database, 'insert'> = this.db
    ): Promise<void> {
        if (!credentials) return
        const enc = this.crypto.encrypt(JSON.stringify(credentials))
        await db.insert(agentCredentials).values({
            id: createObjectId('agentCredential'),
            runtimeId,
            framework,
            payloadCiphertext: enc.ciphertext,
            keyVersion: enc.keyVersion
        })
    }

    private async setHostPhase(hostId: string, phase: string): Promise<void> {
        try {
            await this.db
                .update(runtimeHosts)
                .set({ podPhase: phase, updatedAt: new Date() })
                .where(eq(runtimeHosts.id, hostId))
        } catch (err) {
            this.log.warn(
                `setHostPhase failed hostId=${hostId}: ${(err as Error).message}`
            )
        }
    }

    private async waitForHost(args: {
        ownership?: K8sCreateOwnership
        apis: K8sApis
        userId: string
        hostId: string
        namespace: string
        deadline: number
    }): Promise<void> {
        const name = podHostResourceName(args.hostId)
        let available = false
        while (Date.now() < args.deadline) {
            await args.ownership?.assertActive()
            try {
                if (!available) {
                    const dep = await args.apis.apps.readNamespacedDeployment(
                        { name, namespace: args.namespace },
                        args.ownership?.requestOptions
                    )
                    available = (dep.status?.availableReplicas ?? 0) >= 1
                    if (available)
                        await this.setHostPhase(args.hostId, 'waiting_for_runner')
                }
                if (available && (await this.runnerRegistered(args)))
                    return
            } catch (err) {
                this.log.debug?.(
                    `pod host readiness poll error hostId=${args.hostId}: ${(err as Error).message}`
                )
            }
            await sleep(POLL_INTERVAL_MS)
        }
        throw new GatewayTimeoutException(
            available
                ? 'cloud computer daemon did not register in time'
                : 'cloud computer readiness timeout'
        )
    }

    private async runnerRegistered(args: {
        userId: string
        hostId: string
    }): Promise<boolean> {
        const [runner] = await this.db
            .select({ id: runtimeHosts.id })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, args.userId),
                    eq(runtimeHosts.kind, 'daemon'),
                    eq(runtimeHosts.managed, true),
                    eq(runtimeHosts.name, podRunnerHostName(args.hostId)),
                    eq(runtimeHosts.status, 'active'),
                    isNotNull(runtimeHosts.rpcConnectedAt)
                )
            )
            .limit(1)
        return !!runner
    }

    // Undo a host whose creation failed: its Kubernetes objects, the runner the
    // pod may already have registered, the credential if it never got bound,
    // and the rows. Best effort per step; a failure here must not replace the
    // provisioning error the caller gets. A host whose objects may outlive the
    // attempt keeps its row, failed, so deleting it retries the teardown; so
    // does one the user asked for on its own (keepRow), which shows the reason.
    private async discardHost(
        placement: HostPlacement,
        userId: string,
        podRunner: PodRunnerProvision | null,
        reason: string,
        options: { keepRow?: boolean } = {}
    ): Promise<void> {
        let objectsGone = true
        try {
            await teardownCreatedPodHost({
                apis: placement.client.apis,
                namespace: placement.namespace,
                hostId: placement.hostId,
                signal: AbortSignal.timeout(HOST_TEARDOWN_TIMEOUT_MS)
            })
        } catch (err) {
            objectsGone = false
            this.log.warn(
                `pod host rollback failed hostId=${placement.hostId}: ${(err as Error).message}`
            )
        }
        try {
            await deletePodRunnerHostForPodHost(this.db, userId, placement.hostId)
            if (podRunner)
                await this.podRunner.discardUnbound(userId, podRunner.tokenId)
        } catch (err) {
            this.log.warn(
                `pod runner cleanup failed hostId=${placement.hostId}: ${(err as Error).message}`
            )
        }
        await this.db
            .delete(agentRuntimes)
            .where(eq(agentRuntimes.hostId, placement.hostId))
        if (objectsGone && !options.keepRow)
            await this.db
                .delete(runtimeHosts)
                .where(eq(runtimeHosts.id, placement.hostId))
        else
            await this.db
                .update(runtimeHosts)
                .set({
                    podStatus: 'failed',
                    podPhase: null,
                    podFailureReason: reason,
                    updatedAt: new Date()
                })
                .where(eq(runtimeHosts.id, placement.hostId))
    }
}

const isUniqueViolation = (err: unknown): boolean =>
    (err as { code?: string })?.code === '23505' ||
    (err as { cause?: { code?: string } })?.cause?.code === '23505'

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const sanitizeReason = (err: unknown): string => {
    const message = (err as Error)?.message ?? 'unknown error'
    return message
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
}
