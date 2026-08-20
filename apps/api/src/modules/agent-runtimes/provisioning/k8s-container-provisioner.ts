import type { ProvisionableContainerSku } from '@/common/ports/cloud-computer.ports'
import { createObjectId } from '@manyfold/shared'
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
    k8sClusters,
    type AgentRuntimeRow,
    type Database,
    type K8sCluster
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
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

const DEFAULT_READINESS_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000
const DEFAULT_HOST_SUFFIX = '18.135.81.53.nip.io'
const DEFAULT_STORAGE_CLASS = 'standard'

export interface ProvisionContainerInput {
    userId: string
    sku: ProvisionableContainerSku
    name: string
    credentials: unknown
    // Self-serve (BYO) creates name their cluster; purchased SKUs pick by
    // region. Ignored when null/undefined.
    clusterId?: string | null
}

export interface ProvisionContainerResult {
    runtime: AgentRuntimeRow
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
        private readonly narraNexusK8s: NarraNexusK8sBootstrap
    ) {}

    async provision(
        input: ProvisionContainerInput
    ): Promise<ProvisionContainerResult> {
        const { userId, sku, name, credentials } = input
        const framework = sku.framework as K8sFramework

        // 1. Pick cluster (explicit for self-serve, by region for SKUs)
        const cluster = await pickProvisionCluster(this.db, {
            clusterId: input.clusterId ?? null,
            region: sku.region
        })

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
            dashboardEnabled: false
        }
        const plan = bootstrap.plan(bootstrapCtx, credentials)

        // 2. Insert agentRuntimes row WITHOUT going through reserveRuntime
        // (subscription replaces plan-quota gating for purchased containers).
        const now = new Date()
        await this.db
            .insert(agentRuntimes)
            .values({
                id: runtimeId,
                userId,
                name,
                framework,
                kind: 'k8s',
                status: 'pending',
                currentPhase: 'preparing_namespace',
                clusterId: cluster.id,
                namespace,
                ingressHost: host,
                mountPath: plan.pvcMountPath,
                skuId: sku.id,
                cpuMillicores: sku.cpuMillicores,
                memoryMb: sku.memoryMb,
                diskGb: sku.diskGb,
                region: sku.region,
                purchasedAt: now
            })

        const envSecretName = `${resourceName(runtimeId)}-env`
        let spec!: K8sResourceSpec

        try {
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
                envSecretKeys: Object.keys(plan.envSecretData),
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

            await this.setPhase(runtimeId, 'creating_secret')
            await apis.core.createNamespacedSecret({
                namespace,
                body: buildSecret(spec, plan.envSecretData)
            })
            await this.setPhase(runtimeId, 'creating_storage')
            await apis.core.createNamespacedPersistentVolumeClaim({
                namespace,
                body: buildPvc(spec)
            })
            await this.setPhase(runtimeId, 'creating_deployment')
            await apis.apps.createNamespacedDeployment({
                namespace,
                body: buildDeployment(spec)
            })
            await this.setPhase(runtimeId, 'creating_service')
            await apis.core.createNamespacedService({
                namespace,
                body: buildService(spec)
            })
            await this.setPhase(runtimeId, 'creating_ingress')
            await apis.networking.createNamespacedIngress({
                namespace,
                body: buildIngress(spec)
            })
            for (const sidecar of plan.sidecars ?? []) {
                if (!sidecar.ingressPath) continue
                await apis.networking.createNamespacedIngress({
                    namespace,
                    body: buildSidecarIngress(spec, sidecar)
                })
            }

            await this.setPhase(runtimeId, 'waiting_for_ready')
            const timeoutMs =
                Number(
                    this.config.get<string>('K8S_CONTAINER_PROVISION_TIMEOUT_MS')
                ) || DEFAULT_READINESS_TIMEOUT_MS
            await this.waitForReadiness({
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
                await this.persistRuntimeCredentials(runtimeId, framework, {
                    ...((credentials as Record<string, unknown> | null) ?? {}),
                    ...(plan.generatedCredentials ?? {})
                })
            }

            const readyAt = new Date()
            const [updated] = await this.db
                .update(agentRuntimes)
                .set({
                    status: 'ready',
                    currentPhase: null,
                    failureReason: null,
                    startedAt: readyAt,
                    lastBootstrappedAt: readyAt,
                    updatedAt: readyAt
                })
                .where(eq(agentRuntimes.id, runtimeId))
                .returning()
            return { runtime: updated }
        } catch (err) {
            const reason = sanitizeReason(err)
            this.log.warn(
                `container provision failed runtimeId=${runtimeId} framework=${framework}: ${reason}`
            )
            await this.rollback({
                apis,
                namespace,
                resourceId: runtimeId,
                envSecretName
            })
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
                        : 'K8S_IMAGE_NARRANEXUS'
        const image = this.config.get<string>(key)
        if (!image) throw new InternalServerErrorException(`${key} not set`)
        return image
    }

    private async persistRuntimeCredentials(
        runtimeId: string,
        framework: K8sFramework,
        payload: Record<string, unknown>
    ): Promise<void> {
        const enc = this.crypto.encrypt(JSON.stringify(payload))
        await this.db.insert(agentCredentials).values({
            id: createObjectId('agentCredential'),
            runtimeId,
            framework,
            payloadCiphertext: enc.ciphertext,
            keyVersion: enc.keyVersion
        })
    }

    private async setPhase(runtimeId: string, phase: string): Promise<void> {
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
        apis: K8sApis
        namespace: string
        resourceId: string
        host: string
        httpReadinessPath: string | null
        deadline: number
    }): Promise<void> {
        const name = resourceName(args.resourceId)
        while (Date.now() < args.deadline) {
            try {
                const dep = await args.apis.apps.readNamespacedDeployment({
                    name,
                    namespace: args.namespace
                })
                const avail = dep.status?.availableReplicas ?? 0
                const ing = await args.apis.networking.readNamespacedIngress({
                    name,
                    namespace: args.namespace
                })
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
