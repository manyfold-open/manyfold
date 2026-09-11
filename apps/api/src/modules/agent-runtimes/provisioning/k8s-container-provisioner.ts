import type { ProvisionableContainerSku } from '@/common/ports/cloud-computer.ports'
import { createObjectId } from '@manyfold/shared'
import type { AgentModelConfigSource } from '@manyfold/shared'
import {
    GatewayTimeoutException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, desc, eq } from 'drizzle-orm'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    serviceLeases,
    k8sClusters,
    type AgentRuntimeRow,
    type Database,
    type K8sCluster
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { deletePodRunnerHostForRuntime } from '@/modules/agent-runtimes/sprite-runner-teardown'
import {
    PodRunnerProvisioner,
    type PodRunnerProvision
} from './pod-runner-provisioner'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    KubernetesService,
    isApiNotFound,
    type K8sApis
} from '@/modules/k8s/kubernetes.service'
import { OpenClawBootstrap } from '@/modules/agents/bootstrap/openclaw'
import { HermesBootstrap } from '@/modules/agents/bootstrap/hermes'
import { ClaudeCodeK8sBootstrap } from '@/modules/agents/bootstrap/claude-code-k8s'
import { CodexK8sBootstrap } from '@/modules/agents/bootstrap/codex-k8s'
import { GeminiCliK8sBootstrap } from '@/modules/agents/bootstrap/gemini-k8s'
import { PiK8sBootstrap } from '@/modules/agents/bootstrap/pi-k8s'
import { NarraNexusK8sBootstrap } from '@/modules/agents/bootstrap/narranexus-k8s'
import type {
    K8sBootstrapContext,
    K8sFramework,
    K8sFrameworkBootstrap
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import {
    buildDeployment,
    buildIngress,
    buildPvc,
    buildSecret,
    buildService,
    buildSidecarIngress,
    resourceName,
    type K8sResourceSpec
} from '@/modules/agents/orchestration/k8s-resource-builder'
import { teardownAgent } from '@/modules/agents/orchestration/k8s-teardown'
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
const POLL_INTERVAL_MS = 2_000
const DEFAULT_HOST_SUFFIX = '18.135.81.53.nip.io'
const DEFAULT_STORAGE_CLASS = 'standard'

export interface ProvisionContainerInput {
    userId: string
    sku: ProvisionableContainerSku
    name: string
    credentials: unknown
    // 'runtime-local' keeps provider keys out of the pod Secret and skips
    // key logins / paid verifies in the bootstrap (subscription sign-in).
    modelConfigSource?: AgentModelConfigSource | null
    // Self-serve (BYO) creates name their cluster; purchased SKUs pick by
    // region. Ignored when null/undefined.
    clusterId?: string | null
    // Internal capability: a self-serve create owns this fresh runtime until
    // its one preallocated agent and runtime-local config have committed.
    agentCreateId?: string
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

// Cluster choice for a container: an explicit cluster (BYO self-serve) must
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

@Injectable()
export class K8sContainerProvisioner {
    private readonly log = new Logger(K8sContainerProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService,
        private readonly config: ConfigService,
        private readonly crypto: CryptoService,
        private readonly openclaw: OpenClawBootstrap,
        private readonly hermes: HermesBootstrap,
        private readonly claudeCodeK8s: ClaudeCodeK8sBootstrap,
        private readonly codexK8s: CodexK8sBootstrap,
        private readonly geminiCliK8s: GeminiCliK8sBootstrap,
        private readonly piK8s: PiK8sBootstrap,
        private readonly narraNexusK8s: NarraNexusK8sBootstrap,
        private readonly podRunner: PodRunnerProvisioner,
        private readonly createCleanup: K8sCreateCleanupService
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
        const { userId, sku, name, credentials } = input
        const framework = sku.framework as K8sFramework

        // 1. Pick cluster (explicit for self-serve, by region for SKUs)
        const cluster = await pickProvisionCluster(this.db, {
            clusterId: input.clusterId ?? null,
            region: sku.region
        })
        if (input.agentCreateId)
            await this.createCleanup.assertClusterAvailable(userId, cluster.id)

        const runtimeId = createObjectId('agentRuntime')
        const client = await this.k8s.getClient(cluster.id)
        const apis = client.apis
        const namespace = await this.k8s.ensureUserNamespace(client, userId)
        const hostSuffix =
            cluster.hostSuffix ??
            this.config.get<string>('K8S_INGRESS_HOST_SUFFIX') ??
            DEFAULT_HOST_SUFFIX
        const host = `${resourceName(runtimeId)}.${hostSuffix}`
        const image = this.imageForFramework(framework)

        // The bootstrap plan is built before the row insert so mountPath can
        // record the pod's actual persistent mount. Seen on a kind BYO
        // cluster [2026-08-20]: the old hardcoded '/workspace' pointed
        // outside the PVC for service frameworks (openclaw mounts at
        // ~/.openclaw), so workspace derivation hit 'mkdir /workspace:
        // Permission denied' inside the pod.
        const bootstrap = this.pickBootstrap(framework)
        const bootstrapCtx: K8sBootstrapContext = {
            agentId: runtimeId,
            runtimeId,
            userId,
            namespace,
            host,
            image,
            controlUiEnabled: true,
            dashboardEnabled: false,
            modelConfigSource: input.modelConfigSource ?? null
        }
        const plan = bootstrap.plan(bootstrapCtx, credentials)

        // 2. Insert agentRuntimes row WITHOUT going through reserveRuntime
        // (subscription replaces plan-quota gating for purchased containers).
        const now = new Date()
        await this.db.transaction(async (tx) => {
            await tx.insert(agentRuntimes).values({
                id: runtimeId,
                userId,
                name,
                framework,
                kind: 'k8s',
                status: 'pending',
                currentPhase: input.agentCreateId
                    ? K8S_CREATE_INITIAL_AGENT
                    : 'preparing_namespace',
                clusterId: cluster.id,
                namespace,
                ingressHost: host,
                mountPath: plan.pvcMountPath,
                cpuMillicores: sku.cpuMillicores,
                memoryMb: sku.memoryMb,
                diskGb: sku.diskGb,
                region: sku.region,
                purchasedAt: now
            })
            if (input.agentCreateId)
                await insertK8sCreateLease(tx, runtimeId, input.agentCreateId)
        })

        const ownership = input.agentCreateId
            ? new K8sCreateOwnership(this.db, runtimeId, input.agentCreateId)
            : undefined
        const requestOptions = ownership?.requestOptions

        const envSecretName = `${resourceName(runtimeId)}-env`
        let spec!: K8sResourceSpec
        // Declared out here, assigned inside the try: the catch needs it to
        // discard a token the pod never bound, and the mint itself has to be
        // inside so a failure there rolls the runtime row back like any other.
        const provisionState: { podRunner: PodRunnerProvision | null } = {
            podRunner: null
        }

        try {
            await ownership?.start()
            const provision = async (): Promise<
                ProvisionContainerResult | ProvisionAgentContainerResult
            > => {
                // Credential for the daemon inside the image. It is Secret data, so
                // it is minted before the Secret is built and after the runtime row
                // exists — the window on either side is what the catch covers.
                const runnerInput = {
                    userId,
                    runtimeId,
                    framework,
                    homeRoot: plan.pvcMountPath
                }
                const podRunner = ownership
                    ? await ownership.mutate((tx) =>
                          this.podRunner.mint(runnerInput, tx)
                      )
                    : await this.podRunner.mint(runnerInput)
                provisionState.podRunner = podRunner
                const secretData = {
                    ...plan.envSecretData,
                    ...(podRunner?.env ?? {})
                }
                spec = {
                    agentId: runtimeId,
                    runtimeId,
                    userId,
                    namespace,
                    framework,
                    image,
                    port: plan.port,
                    host,
                    storageClass:
                        this.config.get<string>('K8S_STORAGE_CLASS') ??
                        DEFAULT_STORAGE_CLASS,
                    storageSize: `${sku.diskGb}Gi`,
                    pvcMountPath: plan.pvcMountPath,
                    envSecretName,
                    envSecretKeys: Object.keys(secretData),
                    readinessProbe: plan.readinessProbe,
                    resources: {
                        requests: {
                            cpu: `${sku.cpuMillicores}m`,
                            memory: `${sku.memoryMb}Mi`
                        },
                        limits: {
                            cpu: `${sku.cpuMillicores}m`,
                            memory: `${sku.memoryMb}Mi`
                        }
                    },
                    sidecars: plan.sidecars
                }

                await this.setPhase(runtimeId, 'creating_secret', ownership)
                await apis.core.createNamespacedSecret(
                    {
                        namespace,
                        body: buildSecret(spec, secretData)
                    },
                    requestOptions
                )
                await this.setPhase(runtimeId, 'creating_storage', ownership)
                await apis.core.createNamespacedPersistentVolumeClaim(
                    {
                        namespace,
                        body: buildPvc(spec)
                    },
                    requestOptions
                )
                await this.setPhase(runtimeId, 'creating_deployment', ownership)
                await apis.apps.createNamespacedDeployment(
                    {
                        namespace,
                        body: buildDeployment(spec)
                    },
                    requestOptions
                )
                await this.setPhase(runtimeId, 'creating_service', ownership)
                await apis.core.createNamespacedService(
                    {
                        namespace,
                        body: buildService(spec)
                    },
                    requestOptions
                )
                await this.setPhase(runtimeId, 'creating_ingress', ownership)
                await apis.networking.createNamespacedIngress(
                    {
                        namespace,
                        body: buildIngress(spec)
                    },
                    requestOptions
                )
                for (const sidecar of plan.sidecars ?? []) {
                    if (!sidecar.ingressPath) continue
                    await apis.networking.createNamespacedIngress(
                        {
                            namespace,
                            body: buildSidecarIngress(spec, sidecar)
                        },
                        requestOptions
                    )
                }

                await this.setPhase(runtimeId, 'waiting_for_ready', ownership)
                const timeoutMs =
                    Number(
                        this.config.get<string>(
                            'K8S_CONTAINER_PROVISION_TIMEOUT_MS'
                        )
                    ) || DEFAULT_READINESS_TIMEOUT_MS
                await this.waitForReadiness({
                    ownership,
                    apis,
                    namespace,
                    resourceId: runtimeId,
                    host,
                    httpReadinessPath: plan.httpReadinessPath,
                    deadline: Date.now() + timeoutMs
                })

                // Persist the container's credential record: the RESOLVED
                // credentials merged with whatever secrets the bootstrap minted.
                // The chat adapters load this by runtimeId and need both halves —
                // openclaw reads primaryModelName/provider from the resolved part
                // and its generated gatewayToken; storing the generated half
                // alone broke first chat with 'credentials missing
                // primaryModelName'. Seen on a kind BYO cluster [2026-08-20].
                if (plan.generatedCredentials || credentials) {
                    const payload = {
                        ...((credentials as Record<string, unknown> | null) ??
                            {}),
                        ...(plan.generatedCredentials ?? {})
                    }
                    if (ownership)
                        await ownership.mutate((tx) =>
                            this.persistRuntimeCredentials(
                                runtimeId,
                                framework,
                                payload,
                                tx
                            )
                        )
                    else
                        await this.persistRuntimeCredentials(
                            runtimeId,
                            framework,
                            payload
                        )
                }

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
                                apis,
                                clusterId: cluster.id,
                                namespace
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
                `container provision failed runtimeId=${runtimeId} framework=${framework}: ${reason}`
            )
            if (input.agentCreateId) {
                await this.createCleanup.rollback({
                    requestsSettled: await ownership!.stop(),
                    runtimeId,
                    userId,
                    agentId: input.agentCreateId,
                    error: err,
                    apis,
                    clusterId: cluster.id,
                    namespace
                })
                if (err instanceof GatewayTimeoutException) throw err
                throw new InternalServerErrorException({
                    message: 'container provisioning failed',
                    reason
                })
            }
            await this.rollback({
                apis,
                namespace,
                resourceId: runtimeId,
                envSecretName
            })
            // The pod may have registered its runner before whatever failed
            // here, so both halves are cleaned: the host row (which the runtime
            // delete cannot reach — a runner hangs off daemon_id, not host_id)
            // and the token, only if it was never bound. Best-effort like the
            // k8s rollback above it: a failure here must not skip the runtime
            // delete or replace the provisioning error the caller gets.
            try {
                await deletePodRunnerHostForRuntime(this.db, userId, runtimeId)
                const podRunner = provisionState.podRunner
                if (podRunner)
                    await this.podRunner.discardUnbound(
                        userId,
                        podRunner.tokenId
                    )
            } catch (cleanupErr) {
                this.log.warn(
                    `pod runner cleanup failed runtimeId=${runtimeId}: ${(cleanupErr as Error).message}`
                )
            }
            await this.db
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.id, runtimeId))
            if (err instanceof GatewayTimeoutException) throw err
            throw new InternalServerErrorException({
                message: 'container provisioning failed',
                reason
            })
        }
    }

    async teardown(runtime: AgentRuntimeRow): Promise<void> {
        // Before the runtime row goes: a pod runner registers as its own
        // managed daemon host keyed by name, so deleting the runtime — or
        // deleting the whole namespace — leaves it behind as an online host
        // with no pod. Runs on both the namespace-less DB-only path and the
        // normal one, because the stranding is a DB fact either way. Best
        // effort: the runtime delete below is the operation the caller asked
        // for and must not be skipped because this one failed.
        try {
            await deletePodRunnerHostForRuntime(
                this.db,
                runtime.userId,
                runtime.id
            )
        } catch (err) {
            this.log.warn(
                `pod runner host cleanup failed runtimeId=${runtime.id}: ${(err as Error).message}`
            )
        }
        if (!runtime.namespace) {
            await this.db
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.id, runtime.id))
            return
        }
        try {
            const client = await this.k8s.getClient(runtime.clusterId)
            await teardownAgent({
                apis: client.apis,
                namespace: runtime.namespace,
                agentId: runtime.id,
                envSecretName: `${resourceName(runtime.id)}-env`,
                ignoreNotFound: true,
                logger: this.log
            })
        } catch (err) {
            this.log.warn(
                `container teardown best-effort failed runtimeId=${runtime.id}: ${(err as Error).message}`
            )
        }
        await this.db
            .delete(agentRuntimes)
            .where(eq(agentRuntimes.id, runtime.id))
    }

    private pickBootstrap(framework: K8sFramework): K8sFrameworkBootstrap {
        switch (framework) {
            case 'openclaw':
                return this.openclaw
            case 'hermes':
                return this.hermes
            case 'claude-code':
                return this.claudeCodeK8s
            case 'codex':
                return this.codexK8s
            case 'gemini-cli':
                return this.geminiCliK8s
            case 'pi':
                return this.piK8s
            case 'narranexus':
                return this.narraNexusK8s
        }
    }

    private imageForFramework(framework: K8sFramework): string {
        const key =
            framework === 'openclaw'
                ? 'K8S_IMAGE_OPENCLAW'
                : framework === 'hermes'
                  ? 'K8S_IMAGE_HERMES'
                  : framework === 'claude-code'
                    ? 'K8S_IMAGE_CLAUDE_CODE'
                    : framework === 'codex'
                      ? 'K8S_IMAGE_CODEX'
                      : framework === 'gemini-cli'
                        ? 'K8S_IMAGE_GEMINI_CLI'
                        : framework === 'pi'
                          ? 'K8S_IMAGE_PI'
                          : 'K8S_IMAGE_NARRANEXUS'
        const image = this.config.get<string>(key)
        if (!image) throw new InternalServerErrorException(`${key} not set`)
        return image
    }

    private async persistRuntimeCredentials(
        runtimeId: string,
        framework: K8sFramework,
        payload: Record<string, unknown>,
        db: Pick<Database, 'insert'> = this.db
    ): Promise<void> {
        const enc = this.crypto.encrypt(JSON.stringify(payload))
        await db.insert(agentCredentials).values({
            id: createObjectId('agentCredential'),
            runtimeId,
            framework,
            payloadCiphertext: enc.ciphertext,
            keyVersion: enc.keyVersion
        })
    }

    private async setPhase(
        runtimeId: string,
        phase: string,
        ownership?: K8sCreateOwnership
    ): Promise<void> {
        if (ownership) {
            const rows = await ownership.mutate(async (tx) =>
                tx
                    .update(agentRuntimes)
                    .set({ updatedAt: new Date() })
                    .where(
                        and(
                            eq(agentRuntimes.id, runtimeId),
                            eq(agentRuntimes.status, 'pending'),
                            eq(
                                agentRuntimes.currentPhase,
                                K8S_CREATE_INITIAL_AGENT
                            )
                        )
                    )
                    .returning({ id: agentRuntimes.id })
            )
            if (rows.length !== 1)
                throw new Error(
                    'fresh container provisioning ownership changed'
                )
            this.log.debug(
                `container provision phase runtimeId=${runtimeId} phase=${phase}`
            )
            return
        }
        try {
            await this.db
                .update(agentRuntimes)
                .set({ currentPhase: phase, updatedAt: new Date() })
                .where(eq(agentRuntimes.id, runtimeId))
        } catch (err) {
            this.log.warn(
                `setPhase failed runtimeId=${runtimeId}: ${(err as Error).message}`
            )
        }
    }

    private async waitForReadiness(args: {
        ownership?: K8sCreateOwnership
        apis: K8sApis
        namespace: string
        resourceId: string
        host: string
        httpReadinessPath: string | null
        deadline: number
    }): Promise<void> {
        const name = resourceName(args.resourceId)
        while (Date.now() < args.deadline) {
            await args.ownership?.assertActive()
            try {
                const dep = await args.apis.apps.readNamespacedDeployment(
                    {
                        name,
                        namespace: args.namespace
                    },
                    args.ownership?.requestOptions
                )
                const avail = dep.status?.availableReplicas ?? 0
                const ing = await args.apis.networking.readNamespacedIngress(
                    {
                        name,
                        namespace: args.namespace
                    },
                    args.ownership?.requestOptions
                )
                const addresses = ing.status?.loadBalancer?.ingress ?? []
                const ingressAdmitted = addresses.length > 0
                if (avail >= 1 && ingressAdmitted) {
                    if (!args.httpReadinessPath) return
                    const ok = await probeHttp(
                        `http://${args.host}${args.httpReadinessPath}`
                    )
                    if (ok) return
                }
            } catch (err) {
                if (!isApiNotFound(err))
                    this.log.debug?.(
                        `readiness poll error: ${(err as Error).message}`
                    )
            }
            await sleep(POLL_INTERVAL_MS)
        }
        throw new GatewayTimeoutException('container readiness timeout')
    }

    private async rollback(args: {
        apis: K8sApis
        namespace: string
        resourceId: string
        envSecretName: string
    }): Promise<void> {
        try {
            await teardownAgent({
                apis: args.apis,
                namespace: args.namespace,
                agentId: args.resourceId,
                envSecretName: args.envSecretName,
                ignoreNotFound: true,
                logger: this.log
            })
        } catch (err) {
            this.log.warn(
                `container rollback failed: ${(err as Error).message}`
            )
        }
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const probeHttp = async (url: string): Promise<boolean> => {
    try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 3_000)
        const res = await fetch(url, { signal: ctrl.signal })
        clearTimeout(timer)
        return res.ok
    } catch {
        return false
    }
}

const sanitizeReason = (err: unknown): string => {
    const message = (err as Error)?.message ?? 'unknown error'
    return message
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
}
