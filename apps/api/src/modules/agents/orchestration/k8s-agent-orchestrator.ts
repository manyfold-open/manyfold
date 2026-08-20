import {
    agentBaseUrl,
    auditAction,
    createObjectId,
    normalizeAgentName,
    supportsRuntime
} from '@manyfold/shared'
import type { AgentSummary } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    GatewayTimeoutException,
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq } from 'drizzle-orm'
import {
    agents,
    agentCredentials,
    agentRuntimes,
    auditLogs,
    k8sClusters,
    type Agent,
    type Database
} from '@manyfold/db'
import type { V1Pod } from '@kubernetes/client-node'
import type { AgentProgressEmitter } from './agent-orchestrator.service'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    KubernetesService,
    isApiNotFound
} from '@/modules/k8s/kubernetes.service'
import type { K8sApis } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import {
    OpenClawBootstrap,
    openclawDefaultWorkspace
} from '@/modules/agents/bootstrap/openclaw'
import { HermesBootstrap } from '@/modules/agents/bootstrap/hermes'
import { ClaudeCodeK8sBootstrap } from '@/modules/agents/bootstrap/claude-code-k8s'
import { CodexK8sBootstrap } from '@/modules/agents/bootstrap/codex-k8s'
import { GeminiCliK8sBootstrap } from '@/modules/agents/bootstrap/gemini-k8s'
import { NarraNexusK8sBootstrap } from '@/modules/agents/bootstrap/narranexus-k8s'
import { buildFileRoots } from '@/modules/agents/bootstrap/file-roots'
import type {
    K8sBootstrapContext,
    K8sFramework,
    K8sFrameworkBootstrap
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import {
    AGENT_CONTAINER_NAME,
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
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { K8sProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-provisioner'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { RuntimeTokenService } from '@/modules/auth/runtime-token.service'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import type { ResolvedAgentCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { BackupsService } from '@/modules/backups/backups.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import {
    assertWorkspaceUsableWithPodExec,
    normalizeWorkspacePathInput,
    shellQuote,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'

export interface K8sCreateContext {
    userId: string
    actorUserId: string
    dto: CreateAgentDto
    isAdmin: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 2_000
const DEFAULT_HOST_SUFFIX = '18.135.81.53.nip.io'
const DEFAULT_STORAGE_CLASS = 'standard'

const lastActiveAtIso = (row: Agent): string | null => {
    const candidates = [
        row.startedAt,
        row.lastBootstrappedAt,
        row.lastReconciledAt
    ].filter((d): d is Date => d !== null && d !== undefined)
    if (candidates.length === 0) return null
    return candidates
        .reduce((acc, d) => (d > acc ? d : acc), candidates[0])
        .toISOString()
}

const toSummary = (
    row: Agent,
    clusterName: string | null = null,
    runtime: {
        controlUiEnabled: boolean
        dashboardEnabled: boolean
    } | null = null
): AgentSummary => ({
    id: row.id,
    userId: row.userId,
    runtimeId: row.runtimeId,
    daemonId: row.daemonId ?? null,
    daemonNeedsUpgrade: false,
    name: row.name,
    framework: row.framework,
    frameworkVersion: null,
    frameworkLatestVersion: null,
    frameworkUpgradeAvailable: false,
    frameworkVersionBlockedReason: null,
    cliVersion: null,
    cliLatestVersion: null,
    cliUpdateAvailable: false,
    runtime: row.runtime,
    status: row.status,
    spriteStatus: row.spriteStatus,
    k8sPodPhase: row.k8sPodPhase,
    accountSlug: null,
    clusterId: row.clusterId,
    clusterName,
    spriteName: row.spriteName,
    spriteId: row.spriteId,
    mountPath: row.mountPath,
    namespace: row.namespace,
    ingressHost: row.ingressHost,
    endpointUrl: row.ingressHost ? agentBaseUrl(row.ingressHost) : null,
    controlUiEnabled: runtime?.controlUiEnabled ?? false,
    dashboardEnabled: runtime?.dashboardEnabled ?? false,
    // k8s toggles are synchronous; the async dashboard state machine is
    // sprite-only
    dashboardState: null,
    // keep-alive is a sprites-only switch; k8s runtimes never hold one
    keepAliveEnabled: false,
    currentPhase: row.currentPhase,
    failureReason: row.failureReason,
    internalId: row.internalId,
    model: row.model,
    extras: row.extras,
    workspacePath: row.workspacePath,
    storageBytes: row.storageBytes ?? null,
    storageMeasuredAt: row.storageMeasuredAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    lastActiveAt: lastActiveAtIso(row),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastBootstrappedAt: row.lastBootstrappedAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const noopEmitter: AgentProgressEmitter = { step: () => {} }

@Injectable()
export class K8sAgentOrchestrator {
    private readonly log = new Logger(K8sAgentOrchestrator.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly k8s: KubernetesService,
        private readonly config: ConfigService,
        private readonly openclaw: OpenClawBootstrap,
        private readonly hermes: HermesBootstrap,
        private readonly claudeCodeK8s: ClaudeCodeK8sBootstrap,
        private readonly codexK8s: CodexK8sBootstrap,
        private readonly geminiCliK8s: GeminiCliK8sBootstrap,
        private readonly narraNexusK8s: NarraNexusK8sBootstrap,
        private readonly podExecFactory: PodExecFactory,
        private readonly runtimes: AgentRuntimesService,
        private readonly k8sProvisioner: K8sProvisioner,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly credentialsResolver: CredentialsResolverService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly backups: BackupsService,
        private readonly modelConfig: AgentModelConfigService,
        @Optional() private readonly runtimeToken?: RuntimeTokenService
    ) {}

    async deleteNonPrimary(row: Agent, actorUserId: string): Promise<void> {
        if (!row.runtimeId)
            throw new InternalServerErrorException(
                `agent ${row.id} has no runtimeId`
            )
        const runtime = await this.runtimes.findById(row.runtimeId)
        if (!runtime)
            throw new NotFoundException(
                `runtime ${row.runtimeId} not found for agent ${row.id}`
            )
        const adapter = this.adapterRegistry.get(row.framework)
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_STARTED,
            row.id,
            {
                framework: row.framework,
                runtime: 'k8s',
                nonPrimary: true,
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
        try {
            await adapter.removeAgent({
                runtime,
                agent: row,
                primaryAgentId: runtime.primaryAgentId ?? null
            })
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                actorUserId,
                auditAction.AGENT_DELETE_FAILED,
                row.id,
                {
                    framework: row.framework,
                    runtime: 'k8s',
                    reason,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'framework removeAgent failed',
                reason
            })
        }
        await this.db.delete(agents).where(eq(agents.id, row.id))
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_SUCCEEDED,
            row.id,
            {
                framework: row.framework,
                runtime: 'k8s',
                nonPrimary: true,
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
    }

    async create(
        ctx: K8sCreateContext,
        emitter: AgentProgressEmitter = noopEmitter
    ): Promise<AgentSummary> {
        const { userId, actorUserId, dto, isAdmin } = ctx
        const framework = dto.framework
        const customWorkspace = normalizeWorkspacePathInput(dto.workspace)
        if (framework === 'hermes' && customWorkspace)
            throw new BadRequestException(
                'workspace is not supported for hermes runtimes'
            )
        if (!supportsRuntime(framework, 'k8s'))
            throw new InternalServerErrorException(
                `K8sAgentOrchestrator invoked for non-k8s framework: ${framework}`
            )
        const bootstrap = this.pickBootstrap(framework as K8sFramework)
        const displayName = normalizeAgentName(dto.name)
        const resolved = await this.credentialsResolver.resolve(userId, dto)
        const credentials = extractK8sCredentials(resolved)

        emitter.step('validating')
        await this.enforceNameUnique(userId, displayName)

        emitter.step('checking_quota')
        const agentId = createObjectId('agent')
        const runtimeId = createObjectId('agentRuntime')
        await this.runtimeAccess.reserveRuntime({
            id: runtimeId,
            userId,
            name: displayName,
            framework,
            kind: 'k8s',
            status: 'pending',
            mountPath: '/workspace',
            currentPhase: 'preparing_namespace'
        })

        let k8sClient!: Awaited<ReturnType<KubernetesService['getClient']>>
        let clusterId!: string | null
        let apis!: K8sApis
        let namespace!: string
        let host!: string
        let plan!: ReturnType<K8sFrameworkBootstrap['plan']>
        const envSecretName = `${resourceName(agentId)}-env`
        let agentMountPath!: string
        let spec!: K8sResourceSpec
        try {
            emitter.step('preparing_namespace')
            const requestedClusterId = dto.clusterId ?? null
            k8sClient = await this.k8s.getClient(requestedClusterId)
            clusterId = k8sClient.clusterId
            apis = k8sClient.apis
            namespace = await this.k8s.ensureUserNamespace(k8sClient, userId)
            // Insert a minimal pending agents row BEFORE minting the runtime
            // identity: the k8s mint writes an agent_runtime_tokens row whose
            // agent_id FK references agents.id, and (unlike sprites) the token
            // must land in the env Secret built at plan() time below — so the
            // agents row cannot wait until after provisioning. The full row is
            // finalized (UPDATE, same agentId) once the pod is ready; on any
            // failure the catch deletes the runtime, which FK-cascades both this
            // pending row and the runtime token.
            await this.db.insert(agents).values({
                id: agentId,
                userId,
                name: displayName,
                framework,
                runtime: 'k8s',
                status: 'pending',
                runtimeId,
                internalId: primaryInternalId(
                    framework as K8sFramework,
                    agentId,
                    displayName
                ),
                currentPhase: 'preparing_namespace'
            })
            const hostSuffix =
                k8sClient.hostSuffix ??
                this.config.get<string>('K8S_INGRESS_HOST_SUFFIX') ??
                DEFAULT_HOST_SUFFIX
            host = `${resourceName(agentId)}.${hostSuffix}`
            const image = this.imageForFramework(framework as K8sFramework)
            const apiBaseUrl = this.config.get<string>('PUBLIC_API_BASE_URL')
            const deployEnv = this.config.get<string>('MF_DEPLOY_ENV')
            // Mint the agent's k8s identity only with a reachable API URL to use
            // it against (§3.5 fail-loud gate); the bootstrap plan carries it
            // into the env Secret as MF_API_TOKEN. Rotates per (re)provision.
            // Fail-loud: when gated (apiBaseUrl set), a missing token service or
            // a mint failure aborts provisioning before the Secret is planned,
            // rather than leaving the agent tokenless.
            let apiToken: string | undefined
            if (apiBaseUrl) {
                if (!this.runtimeToken)
                    throw new Error(
                        `runtime identity required for k8s agent ${agentId} (PUBLIC_API_BASE_URL is set) but RuntimeTokenService is not wired`
                    )
                const minted = await this.runtimeToken.mintRuntimeIdentity({
                    userId,
                    agentId,
                    runtimeKind: 'k8s'
                })
                apiToken = minted.plaintext
            }
            const bootstrapCtx: K8sBootstrapContext = {
                agentId,
                runtimeId,
                userId,
                namespace,
                host,
                image,
                controlUiEnabled: true,
                dashboardEnabled: false,
                modelConfig: dto.modelConfig ?? null,
                ...(customWorkspace ? { workspacePath: customWorkspace } : {}),
                ...(apiBaseUrl
                    ? { apiBaseUrl: publicApiUrlWithApiPrefix(apiBaseUrl) }
                    : {}),
                ...(apiBaseUrl && apiToken ? { apiToken } : {}),
                ...(deployEnv ? { deployEnv } : {})
            }
            plan = bootstrap.plan(bootstrapCtx, credentials)
            agentMountPath = plan.workspacePath ?? plan.pvcMountPath
            spec = {
                agentId,
                userId,
                namespace,
                framework: framework as K8sFramework,
                image,
                port: plan.port,
                host,
                storageClass:
                    this.config.get<string>('K8S_STORAGE_CLASS') ??
                    DEFAULT_STORAGE_CLASS,
                pvcMountPath: plan.pvcMountPath,
                envSecretName,
                envSecretKeys: Object.keys(plan.envSecretData),
                readinessProbe: plan.readinessProbe,
                resources: plan.resources,
                sidecars: plan.sidecars
            }
            await this.runtimes.applyProvisioningPatch(runtimeId, {
                clusterId,
                namespace,
                ingressHost: host,
                mountPath: agentMountPath,
                currentPhase: 'creating_secret'
            })
        } catch (err) {
            // Deleting the runtime FK-cascades the pending agents row and any
            // runtime token already minted above, so there is no orphan left.
            await this.runtimes.delete(runtimeId)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_K8S_FAILED,
                agentId,
                {
                    framework,
                    namespace,
                    reason: sanitizeReason(err),
                    phase: 'preparing',
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            throw err
        }

        await this.audit(
            actorUserId,
            auditAction.AGENT_CREATE_K8S_STARTED,
            agentId,
            {
                framework,
                namespace,
                ownerUserId: userId,
                onBehalfOf: actorUserId !== userId
            }
        )

        const timeoutMs =
            Number(this.config.get<string>('K8S_CREATE_TIMEOUT_MS')) ||
            DEFAULT_TIMEOUT_MS
        const deadline = Date.now() + timeoutMs
        let timedOut = false

        try {
            emitter.step('creating_secret')
            await apis.core.createNamespacedSecret({
                namespace,
                body: buildSecret(spec, plan.envSecretData)
            })
            emitter.step('creating_storage')
            await apis.core.createNamespacedPersistentVolumeClaim({
                namespace,
                body: buildPvc(spec)
            })
            emitter.step('creating_deployment')
            await apis.apps.createNamespacedDeployment({
                namespace,
                body: buildDeployment(spec)
            })
            emitter.step('creating_service')
            await apis.core.createNamespacedService({
                namespace,
                body: buildService(spec)
            })
            emitter.step('creating_ingress')
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

            emitter.step('waiting_for_ready')
            await this.waitForReadiness({
                apis,
                namespace,
                agentId,
                host,
                httpReadinessPath: plan.httpReadinessPath,
                deadline,
                onTimeout: () => {
                    timedOut = true
                }
            })

            let postProvisionExec: ReturnType<
                PodExecFactory['forClient']
            > | null = null
            let postProvisionPodName = ''
            if (customWorkspace || bootstrap.postProvision) {
                const pod = await this.pickRunningPod(apis, namespace, agentId)
                if (!pod?.metadata?.name)
                    throw new Error(
                        `bootstrapping: no running pod for agent ${agentId}`
                    )
                postProvisionPodName = pod.metadata.name
                postProvisionExec = this.podExecFactory.forClient(
                    k8sClient,
                    namespace,
                    pod.metadata.name,
                    AGENT_CONTAINER_NAME
                )
            }
            if (customWorkspace && postProvisionExec)
                await assertWorkspaceUsableWithPodExec(
                    postProvisionExec,
                    customWorkspace
                )
            if (
                !customWorkspace &&
                postProvisionExec &&
                (framework === 'claude-code' ||
                    framework === 'codex' ||
                    framework === 'gemini-cli')
            ) {
                const mkdir = await postProvisionExec.run({
                    cmd: [
                        'bash',
                        '-lc',
                        `mkdir -p ${shellQuote(agentMountPath)}`
                    ],
                    timeoutMs: 30_000
                })
                if (mkdir.exitCode !== 0)
                    throw new Error(
                        `k8s workspace mkdir failed (exit ${mkdir.exitCode}): ${mkdir.stderr || mkdir.stdout}`
                    )
            }

            if (bootstrap.postProvision) {
                emitter.step('bootstrapping')
                await bootstrap.postProvision({
                    agentId,
                    runtimeId,
                    userId,
                    namespace,
                    podName: postProvisionPodName,
                    containerName: AGENT_CONTAINER_NAME,
                    exec: postProvisionExec!,
                    logger: this.log,
                    modelConfig: dto.modelConfig ?? null
                })
            }

            emitter.step('storing_credentials')
            const credentialsToStore = plan.generatedCredentials
                ? {
                      ...(credentials as Record<string, unknown>),
                      ...plan.generatedCredentials
                  }
                : credentials
            const credEnc = this.crypto.encrypt(
                JSON.stringify(credentialsToStore)
            )
            const now = new Date()

            // Finalize the pending row inserted before the mint (same agentId);
            // identity columns (id/userId/name/framework/runtime/runtimeId/
            // internalId) were set there and stay put.
            const [inserted] = await this.db
                .update(agents)
                .set({
                    clusterId,
                    namespace,
                    ingressHost: host,
                    mountPath: customWorkspace ?? agentMountPath,
                    currentPhase: null,
                    workspacePath:
                        customWorkspace ??
                        (framework === 'openclaw'
                            ? openclawDefaultWorkspace(plan.pvcMountPath)
                            : agentMountPath),
                    extras: workspaceExtras(!customWorkspace),
                    fileRoots: buildFileRoots({
                        framework,
                        runtime: 'k8s',
                        mountPath: customWorkspace ?? agentMountPath,
                        ...(customWorkspace
                            ? { workspaceTransport: 'pod-exec' as const }
                            : {})
                    }),
                    modelProviderId: resolved.providerId,
                    updatedAt: now
                })
                .where(eq(agents.id, agentId))
                .returning()
            await this.db
                .update(agentRuntimes)
                .set({ primaryAgentId: agentId })
                .where(eq(agentRuntimes.id, runtimeId))
            await this.db.insert(agentCredentials).values({
                id: createObjectId('agentCredential'),
                runtimeId,
                framework,
                payloadCiphertext: credEnc.ciphertext,
                keyVersion: credEnc.keyVersion
            })

            if (framework === 'narranexus') {
                const adapter = this.adapterRegistry.get('narranexus')
                const runtimeRow = await this.runtimes.findById(runtimeId)
                if (!runtimeRow)
                    throw new InternalServerErrorException(
                        `narranexus runtime ${runtimeId} vanished after provision`
                    )
                const internalId = primaryInternalId(
                    framework as K8sFramework,
                    agentId,
                    displayName
                )
                const addResult = await adapter.addAgent({
                    runtime: runtimeRow,
                    primaryAgentId: null,
                    agentId,
                    internalId,
                    name: displayName
                })
                // Bring the freshly-inserted agent row in line with NarraNexus's
                // own per-agent workspace convention (the legacy K8s create path
                // initially stored agentMountPath = pvcMountPath = '/data', the
                // PVC root, not the per-agent dir NarraNexus actually creates
                // at <BASE_WORKING_PATH>/<agent_id>_<mf_user>).
                if (addResult.workspace) {
                    await this.db
                        .update(agents)
                        .set({
                            workspacePath: addResult.workspace,
                            updatedAt: new Date()
                        })
                        .where(eq(agents.id, agentId))
                }
            }

            if (
                framework === 'claude-code' ||
                dto.modelConfig ||
                dto.modelConfigSource
            ) {
                await this.modelConfig.ensureProviderModelsReady(
                    userId,
                    agentId,
                    true,
                    dto.modelConfigSource
                )
                if (dto.modelConfig || dto.modelConfigSource)
                    await this.modelConfig.updateForAgent(
                        userId,
                        agentId,
                        {
                            modelConfigSource: dto.modelConfigSource,
                            modelConfig: dto.modelConfig
                        },
                        true
                    )
            }

            if (dto.restoreBackupId) {
                emitter.step('restoring_backup')
                await this.backups.restoreBackupToAgentForCreate({
                    actorUserId,
                    isAdmin,
                    backupId: dto.restoreBackupId,
                    agent: inserted
                })
            }

            emitter.step('finalizing')
            await this.k8sProvisioner.finalizeReady(runtimeId, now)
            const [updated] = await this.db
                .update(agents)
                .set({
                    status: 'running',
                    k8sPodPhase: 'Running',
                    startedAt: now,
                    lastBootstrappedAt: now,
                    failureReason: null,
                    currentPhase: null,
                    updatedAt: now
                })
                .where(eq(agents.id, agentId))
                .returning()

            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_K8S_SUCCEEDED,
                agentId,
                {
                    framework,
                    namespace,
                    ingressHost: host,
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            await this.credentialsResolver
                .maybePersistInline({
                    ownerUserId: userId,
                    dto,
                    resolved
                })
                .catch((err: unknown) => {
                    this.log.warn(
                        `saveCredentialAs failed for ${userId}: ${(err as Error).message}`
                    )
                })
            const clusterName = await this.lookupClusterName(clusterId)
            const runtimeRow = await this.runtimes.findById(runtimeId)
            return toSummary(updated, clusterName, runtimeRow)
        } catch (err) {
            const reason = sanitizeReason(err)
            this.log.warn(
                `k8s create failed agentId=${agentId} framework=${framework}: ${reason}`
            )
            await this.rollbackQuietly({
                apis,
                namespace,
                agentId,
                envSecretName
            })
            await this.runtimes.delete(runtimeId)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_K8S_FAILED,
                agentId,
                {
                    framework,
                    namespace,
                    reason,
                    timedOut,
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            if (timedOut)
                throw new GatewayTimeoutException({
                    message: `k8s agent did not become ready within ${timeoutMs}ms`,
                    reason
                })
            if (err instanceof HttpException) throw err
            throw new InternalServerErrorException({
                message: 'k8s agent provisioning failed',
                reason
            })
        }
    }

    async delete(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<void> {
        const [row] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!row) throw new NotFoundException(`agent ${agentId} not found`)
        if (row.userId !== callerUserId && !isAdmin)
            throw new NotFoundException(`agent ${agentId} not found`)
        if (row.runtime !== 'k8s')
            throw new InternalServerErrorException(
                `K8sAgentOrchestrator.delete called for runtime=${row.runtime}`
            )
        if (!row.namespace)
            throw new InternalServerErrorException(
                'k8s agent has no namespace recorded'
            )

        await this.audit(
            callerUserId,
            auditAction.AGENT_DELETE_STARTED,
            agentId,
            {
                framework: row.framework,
                runtime: 'k8s',
                ownerUserId: row.userId,
                onBehalfOf: callerUserId !== row.userId
            }
        )

        try {
            if (row.runtimeId) {
                const runtime = await this.runtimes.findById(row.runtimeId)
                if (runtime)
                    await this.k8sProvisioner.teardownRuntime(runtime, agentId)
            }
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                callerUserId,
                auditAction.AGENT_DELETE_FAILED,
                agentId,
                {
                    framework: row.framework,
                    runtime: 'k8s',
                    reason,
                    ownerUserId: row.userId,
                    onBehalfOf: callerUserId !== row.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'k8s agent teardown failed',
                reason
            })
        }

        await this.db.delete(agents).where(eq(agents.id, agentId))
        await this.audit(
            callerUserId,
            auditAction.AGENT_DELETE_SUCCEEDED,
            agentId,
            {
                framework: row.framework,
                runtime: 'k8s',
                ownerUserId: row.userId,
                onBehalfOf: callerUserId !== row.userId
            }
        )
    }

    private async lookupClusterName(
        clusterId: string | null
    ): Promise<string | null> {
        if (!clusterId) return null
        const [row] = await this.db
            .select({ name: k8sClusters.name })
            .from(k8sClusters)
            .where(eq(k8sClusters.id, clusterId))
            .limit(1)
        return row?.name ?? null
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

    private async enforceNameUnique(
        userId: string,
        name: string
    ): Promise<void> {
        const existing = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.userId, userId), eq(agents.name, name)))
            .limit(1)
        if (existing[0])
            throw new ConflictException(
                `agent "${name}" already exists for this user`
            )
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

    private async waitForReadiness(args: {
        apis: K8sApis
        namespace: string
        agentId: string
        host: string
        httpReadinessPath: string | null
        deadline: number
        onTimeout: () => void
    }): Promise<void> {
        const name = resourceName(args.agentId)
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
        args.onTimeout()
        throw new Error('readiness deadline exceeded')
    }

    private async pickRunningPod(
        apis: K8sApis,
        namespace: string,
        agentId: string
    ): Promise<V1Pod | undefined> {
        const res = await apis.core.listNamespacedPod({
            namespace,
            labelSelector: `nca.netmind.ai/agent-id=${agentId}`
        })
        const pods = res.items ?? []
        return (
            pods.find((p) => p.status?.phase === 'Running') ??
            pods.find((p) => p.status?.phase === 'Pending')
        )
    }

    private async rollbackQuietly(args: {
        apis: K8sApis
        namespace: string
        agentId: string
        envSecretName: string
    }): Promise<void> {
        try {
            await teardownAgent({
                apis: args.apis,
                namespace: args.namespace,
                agentId: args.agentId,
                envSecretName: args.envSecretName,
                ignoreNotFound: true,
                logger: this.log
            })
        } catch (cleanupErr) {
            this.log.warn(
                `rollback teardown failed: ${(cleanupErr as Error).message}`
            )
        }
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `audit write failed action=${action} err=${(err as Error).message}`
            )
        }
    }
}

const primaryInternalId = (
    framework: K8sFramework,
    agentId: string,
    _name: string
): string => {
    if (framework === 'openclaw') return 'main'
    if (framework === 'hermes') return 'default'
    if (framework === 'narranexus') return agentId.replace(/_/g, '-')
    // claude-code / codex / gemini-cli: internalId mirrors agents.id (UUID) so
    // reconcile's listAgents (which reads from the agents table and returns
    // row.id) can join cleanly. See migration 0030.
    return agentId
}

const extractK8sCredentials = (resolved: ResolvedAgentCredentials): unknown =>
    resolved.value

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
