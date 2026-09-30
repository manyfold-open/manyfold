import {
    AgentCreateStep,
    AgentFramework,
    RuntimePlacement,
    EXPERIMENT_KEYS,
    FEATURE_TOGGLE_KEYS,
    FrameworkRuntimeDefaultsSettings,
    RotateRuntimeTokenResponse,
    SPRITE_HOME_BASE,
    UserFrameworkRuntimeOverridesSettings,
    runtimePlacements,
    auditAction,
    codingAgentWorkspacePath,
    configurableFrameworkRuntimeDefaults,
    createObjectId,
    frameworkDefinition,
    isExternal,
    normalizeAgentName,
    supportsRuntime
} from '@manyfold/shared'
import type { AgentSummary } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { and, asc, eq, ne } from 'drizzle-orm'
import {
    agents,
    agentCredentials,
    agentRuntimes,
    auditLogs,
    jsonbMerge,
    runtimeHosts,
    runtimeProviders,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import {
    EXPERIMENT_ASSIGNMENT_PORT,
    type ExperimentAssignmentPort
} from '@/common/ports/experiment-assignment.ports'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    isDaemonNotDispatchedError,
    isDaemonOfflineTransportError
} from '@/modules/chat/chat-adapter'
import { SkillsService } from '@/modules/skills/skills.service'
import { DRIZZLE } from '@/db/tokens'
import { ResourceChangesService } from '@/modules/resource-events/resource-changes.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import {
    resolveFrameworkInstallVersion,
    type ResolvedInstallVersion
} from '@/modules/framework-versions/resolve-install-version'
import { UsersService } from '@/modules/users/users.service'
import {
    AgentsService,
    agentRowToSummary,
    summaryRowOf
} from '@/modules/agents/agents.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { RuntimeTokenService } from '@/modules/auth/runtime-token.service'
import { BootstrapError } from '@/modules/agents/bootstrap/framework-bootstrap'
import { buildFileRoots } from '@/modules/agents/bootstrap/file-roots'
import {
    ACQUISITION_PORT,
    type AcquisitionPort
} from '@/common/ports/acquisition.ports'
import {
    CLOUD_COMPUTER_PORT,
    openCloudComputerPort,
    type CloudComputerPort
} from '@/common/ports/cloud-computer.ports'
import {
    assertPodHostFramework,
    K8sContainerProvisioner,
    type ProvisionAgentContainerResult
} from '@/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { K8sAgentOrchestrator } from '@/modules/agents/orchestration/k8s-agent-orchestrator'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAgentAttachService } from '@/modules/agents/orchestration/runtime-agent-attach.service'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { contextDocInstructionFile } from '@/modules/agent-self/agent-context-doc.service'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { ExternalAgentProvisioner } from '@/modules/agent-runtimes/provisioning/external-provisioner'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import type { ResolvedAgentCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { BackupsService } from '@/modules/backups/backups.service'
import { serviceFrameworkRecipe } from '@/modules/agents/bootstrap/service-frameworks'
import { isBuiltInProfileAgent } from '@/modules/agents/reconcile/agent-reconcile.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import {
    resolveWorkspaceSelection,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'

interface OrchestratorContext {
    userId: string
    actorUserId: string
    dto: CreateAgentDto
    isAdmin: boolean
}

export interface AgentProgressEmitter {
    step(step: AgentCreateStep): void
    // Where a sandbox create landed, as soon as the host and runtime rows
    // exist: what an interrupted create leaves behind.
    placed?(where: {
        hostId: string
        runtimeId: string
        hostCreated: boolean
    }): void
}

const noopEmitter: AgentProgressEmitter = { step: () => {} }

type AgentContext = RuntimeContext & { agent: Agent }

type ConfigurableRuntimeDefaultFramework =
    keyof FrameworkRuntimeDefaultsSettings['defaults']

const isConfigurableRuntimeDefaultFramework = (
    framework: AgentFramework
): framework is ConfigurableRuntimeDefaultFramework =>
    (configurableFrameworkRuntimeDefaults as readonly string[]).includes(
        framework
    )

// Whether a create request names credentials of its own, in any framework's
// shape.
const carriesCredentials = (dto: CreateAgentDto): boolean =>
    Boolean(
        dto.claudeCodeCredentials ||
        dto.codexCredentials ||
        dto.geminiCliCredentials ||
        dto.piCredentials ||
        dto.antigravityCliCredentials ||
        dto.openclawCredentials ||
        dto.hermesCredentials ||
        dto.saveCredentialAs
    )

export const resolveRuntime = (
    framework: AgentFramework,
    userChoice?: RuntimePlacement,
    defaults?: FrameworkRuntimeDefaultsSettings,
    userOverrides?: UserFrameworkRuntimeOverridesSettings
): RuntimePlacement => {
    if (isExternal(framework)) {
        if (userChoice && userChoice !== runtimePlacements.EXTERNAL)
            throw new ConflictException(
                `framework ${framework} requires runtime=external`
            )
        return runtimePlacements.EXTERNAL
    }
    if (userChoice === runtimePlacements.DAEMON) {
        if (!supportsRuntime(framework, runtimePlacements.DAEMON))
            throw new ConflictException(
                `framework ${framework} cannot run on a local daemon`
            )
        return runtimePlacements.DAEMON
    }
    if (userChoice === runtimePlacements.EXTERNAL)
        throw new ConflictException(
            `framework ${framework} cannot run on an external runtime`
        )
    if (userChoice) return userChoice
    if (isConfigurableRuntimeDefaultFramework(framework)) {
        const userOverride = userOverrides?.overrides[framework]
        if (userOverride) return userOverride
        const adminOverride = defaults?.defaults[framework]
        if (adminOverride) return adminOverride
    }
    const platformDefault = frameworkDefinition(framework)?.defaultRuntime
    if (platformDefault) return platformDefault
    throw new ConflictException(
        `framework ${framework} requires an explicit runtime or configured admin default`
    )
}

@Injectable()
export class AgentOrchestratorService {
    private readonly log = new Logger(AgentOrchestratorService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly agentsService: AgentsService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly crypto: CryptoService,
        private readonly runtimes: AgentRuntimesService,
        private readonly spritesProvisioner: SpritesProvisioner,
        private readonly externalProvisioner: ExternalAgentProvisioner,
        private readonly k8sOrchestrator: K8sAgentOrchestrator,
        private readonly attach: RuntimeAgentAttachService,
        private readonly credentialsResolver: CredentialsResolverService,
        private readonly backups: BackupsService,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly modelConfig: AgentModelConfigService,
        private readonly adminSettings: AdminSettingsService,
        private readonly frameworkVersions: FrameworkVersionsService,
        private readonly users: UsersService,
        private readonly moduleRef: ModuleRef,
        @Inject(ACQUISITION_PORT)
        private readonly attribution: AcquisitionPort,
        private readonly telemetry: TelemetryService,
        // Appended LAST and @Optional so positional test construction keeps
        // working; only the daemon rotate path needs it (#781).
        @Optional()
        private readonly runtimeTokens?: RuntimeTokenService,
        // Same appended-last convention as runtimeTokens: only stampCreatedVia
        // reads it, and it degrades to "no experiment" when absent.
        @Optional()
        @Inject(EXPERIMENT_ASSIGNMENT_PORT)
        private readonly experimentAssignments?: ExperimentAssignmentPort,
        // Appended last + @Optional: cloud-computer commerce gates are
        // cloud-only; absence means the open default (attach allowed).
        @Optional()
        @Inject(CLOUD_COMPUTER_PORT)
        private readonly cloudComputer?: CloudComputerPort,
        // Appended last + @Optional: only the self-serve (BYO k8s) create
        // branch needs it; when absent that branch answers CONTAINER_REQUIRED
        // exactly like the purchased-container edition.
        @Optional()
        private readonly k8sProvisioner?: K8sContainerProvisioner,
        // Appended last + @Optional: frameworks a module registers
        // (ADR-0034); absent means only the core frameworks.
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry(),
        @Optional() private readonly changes?: ResourceChangesService,
        @Optional() private readonly contextDoc?: AgentContextDocManageService,
        // Appended last + @Optional: names a provider's error in the create
        // failure audit; absent, it reads as unknown.
        @Optional() private readonly providers?: SandboxProviderRegistry
    ) {}

    // Version a new sprite agent installs: what the caller asked for, else the
    // admin pin, else the newest release upstream. The last tier is what keeps a
    // fresh agent off the sprite image's baked-in (and usually months-old) CLI.
    private async resolveFrameworkVersion(
        framework: AgentFramework,
        requested?: string | null
    ): Promise<ResolvedInstallVersion> {
        return resolveFrameworkInstallVersion(
            {
                settings:
                    await this.adminSettings.getCachedFrameworkDefaultVersions(),
                latestForFresh: (fw) => this.frameworkVersions.latestForFresh(fw),
                catalogForFresh: (fw) =>
                    this.frameworkVersions.catalogForFresh(fw),
                releaseArtifacts: (fw, version) =>
                    this.frameworkVersions.releaseArtifacts(fw, version)
            },
            framework,
            requested
        )
    }

    private async agentContext(agentId: string): Promise<AgentContext | null> {
        const ctx = await this.runtimeContext.forAgent(agentId)
        return ctx?.agent ? (ctx as AgentContext) : null
    }

    private async summaryFor(agentId: string): Promise<AgentSummary> {
        const ctx = await this.agentContext(agentId)
        if (!ctx)
            throw new InternalServerErrorException(
                `agent ${agentId} vanished after create`
            )
        return agentRowToSummary(summaryRowOf(ctx))
    }

    // Rotate the agent's runtime identity. Mint-only: the mint revokes the
    // prior active row and inserts the new one atomically, and the identity is
    // injected per exec or turn from the encrypted copy rather than living in a
    // shell profile (#781), so there is no live re-inject step. NOT
    // zero-downtime: the old token stops the instant the mint commits, so this
    // is an explicit, not-routine operation. k8s rotation (Secret patch + pod
    // restart/drain) is deferred — re-provision to rotate a k8s identity.
    async rotateRuntimeToken(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<RotateRuntimeTokenResponse> {
        const ctx = await this.agentContext(agentId)
        if (!ctx || (ctx.agent.userId !== callerUserId && !isAdmin))
            throw new NotFoundException('agent not found')
        const { agent, placement } = ctx

        if (placement === 'daemon') {
            // Mint-only (#781): daemon identity is injected per turn, so
            // rotation has no live re-inject step — the old token dies the
            // instant the mint commits and the next turn carries the new one.
            if (!this.runtimeTokens)
                throw new InternalServerErrorException(
                    'runtime token service unavailable'
                )
            await this.runtimeTokens.mintRuntimeIdentity({
                userId: agent.userId,
                agentId: agent.id,
                runtimeKind: 'daemon'
            })
            await this.writeRotateAudit(
                auditAction.RUNTIME_TOKEN_ROTATED,
                agent,
                placement,
                callerUserId
            )
            return {
                agentId: agent.id,
                runtimeKind: 'daemon',
                rotatedAt: new Date().toISOString()
            }
        }

        if (placement !== 'sprites' || !ctx.host) {
            if (placement === 'k8s')
                throw new ConflictException(
                    'k8s runtime-token rotation is not supported yet; re-provision the agent to rotate its identity'
                )
            throw new BadRequestException(
                `runtime-token rotation is not supported for ${placement} runtimes`
            )
        }
        try {
            await this.spritesProvisioner.installRuntimeIdentity({
                userId: agent.userId,
                agentId: agent.id
            })
        } catch (err) {
            await this.writeRotateAudit(
                auditAction.RUNTIME_TOKEN_ROTATE_FAILED,
                agent,
                placement,
                callerUserId,
                (err as Error).message
            )
            throw new InternalServerErrorException(
                `runtime-token rotation failed for ${agent.id}; the previous token is still active — retry rotate`
            )
        }

        await this.writeRotateAudit(
            auditAction.RUNTIME_TOKEN_ROTATED,
            agent,
            placement,
            callerUserId
        )
        return {
            agentId: agent.id,
            runtimeKind: 'sprites',
            rotatedAt: new Date().toISOString()
        }
    }

    private async writeRotateAudit(
        action: string,
        agent: Agent,
        placement: RuntimePlacement,
        actorUserId: string,
        error?: string
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: `user:${actorUserId}`,
                action,
                subject: agent.id,
                meta: {
                    userId: agent.userId,
                    runtime: placement,
                    ...(error ? { error } : {})
                }
            })
        } catch (auditErr) {
            this.log.warn(
                `failed to write ${action} audit for ${agent.id}: ${(auditErr as Error).message}`
            )
        }
    }

    private async stampCreatedVia(
        agentId: string,
        userId: string
    ): Promise<void> {
        try {
            if (!this.experimentAssignments) return
            const assignment = await this.experimentAssignments.assignFor(
                userId,
                EXPERIMENT_KEYS.AGENT_CREATE_UX
            )
            if (!assignment) return
            const [row] = await this.db
                .select({ extras: agents.extras })
                .from(agents)
                .where(eq(agents.id, agentId))
                .limit(1)
            if (!row) return
            const nextExtras = {
                createdVia: {
                    experiment: EXPERIMENT_KEYS.AGENT_CREATE_UX,
                    variant: assignment.variant,
                    reason: assignment.reason
                }
            }
            await this.db
                .update(agents)
                .set({ extras: jsonbMerge(agents.extras, nextExtras) })
                .where(eq(agents.id, agentId))
        } catch (err) {
            this.log.warn(
                `stampCreatedVia failed agent=${agentId}: ${(err as Error).message}`
            )
        }
    }

    async isUserAdmin(userId: string): Promise<boolean> {
        return this.agentsService.isUserAdmin(userId)
    }

    async create(
        ctx: OrchestratorContext,
        emitter: AgentProgressEmitter = noopEmitter
    ): Promise<AgentSummary> {
        // When the caller supplies runtimeId (purchased container), route by
        // the container's actual placement instead of inferring from framework.
        // This lets the frontend always POST /agents with { framework,
        // runtimeId } without having to also set runtime='k8s'.
        const [defaults, userOverrides] = ctx.dto.runtimeId
            ? [undefined, undefined]
            : await Promise.all([
                  this.adminSettings.getCachedFrameworkRuntimeDefaults(),
                  this.users.getFrameworkRuntimeOverrides(ctx.userId)
              ])
        const runtime = ctx.dto.runtimeId
            ? runtimePlacements.K8S
            : resolveRuntime(
                  ctx.dto.framework,
                  ctx.dto.runtime,
                  defaults,
                  userOverrides
              )
        let result: AgentSummary
        if (runtime === runtimePlacements.K8S)
            result = await this.createK8sAgent(ctx, emitter)
        else if (runtime === runtimePlacements.DAEMON)
            throw new ConflictException(
                'daemon runtimes are created by the daemon itself; attach via POST /agent-runtimes/:id/agents instead'
            )
        else if (runtime === runtimePlacements.EXTERNAL)
            result = await this.createExternal(ctx, emitter)
        else result = await this.createSprites(ctx, emitter)
        this.changes?.emit(ctx.userId, { resource: 'agent', resourceId: result.id, agentId: result.id, reason: 'created' })
        await this.stampCreatedVia(result.id, ctx.userId)
        // Activation conversion for the owner's very first agent (fail-soft,
        // once-per-user via the conversions unique index). Admin on-behalf
        // creations are not the user's own activation and don't count. The
        // direct POST /agent-runtimes/:id/agents route hooks in its
        // controller; reconcile-adopted agents are deliberately not counted;
        // if K8sAgentOrchestrator.create ever becomes reachable again it
        // needs its own hook.
        if (ctx.actorUserId === ctx.userId)
            await this.attribution.recordFirstAgentCreated({
                userId: ctx.userId
            })
        return result
    }

    private async createK8sAgent(
        ctx: OrchestratorContext,
        emitter: AgentProgressEmitter
    ): Promise<AgentSummary> {
        const { userId, dto, isAdmin } = ctx
        emitter.step('validating')
        let runtimeRow: AgentRuntimeRow
        let fresh: ProvisionAgentContainerResult | undefined
        let agentCreateId: string | undefined
        if (dto.runtimeId) {
            const existing = await this.runtimeContext.forRuntime(dto.runtimeId)
            if (
                !existing ||
                (existing.runtime.userId !== userId && !isAdmin)
            )
                throw new NotFoundException(
                    `agent runtime ${dto.runtimeId} not found`
                )
            if (existing.placement !== 'k8s' || !existing.host)
                throw new ConflictException({
                    message: `runtime ${dto.runtimeId} is not a k8s container`,
                    code: 'RUNTIME_KIND_MISMATCH',
                    kind: existing.placement
                })
            if (existing.runtime.framework !== dto.framework)
                throw new ConflictException({
                    message: `container is for framework ${existing.runtime.framework}; cannot attach ${dto.framework} agent`,
                    code: 'FRAMEWORK_MISMATCH',
                    expected: existing.runtime.framework,
                    got: dto.framework
                })
            if (
                existing.runtime.status !== 'ready' ||
                existing.host.status !== 'ready'
            )
                throw new ConflictException({
                    message: `container ${dto.runtimeId} is not ready (status=${existing.runtime.status})`,
                    code: 'CONTAINER_NOT_READY',
                    status: existing.runtime.status
                })
            await this.assertPodHostAttachable(existing.host.id, isAdmin)
            runtimeRow = existing.runtime
        } else if (dto.podHostId) {
            assertPodHostFramework(dto.framework)
            runtimeRow = await this.placeOnPodHost(ctx, dto.podHostId, emitter)
        } else {
            assertPodHostFramework(dto.framework)
            // No purchased container named. The port decides whether creates
            // may provision one on the fly (self-hosted BYO k8s) or whether
            // containers are strictly a purchased product (cloud) — #971.
            const spec = this.cloudComputer
                ? this.cloudComputer.selfServeContainerSpec()
                : openCloudComputerPort.selfServeContainerSpec()
            if (!spec || !this.k8sProvisioner)
                throw new ConflictException({
                    message:
                        'k8s agents must be attached to a purchased container. Provide runtimeId or visit /containers to purchase one.',
                    code: 'CONTAINER_REQUIRED'
                })
            emitter.step('checking_quota')
            // The master switch governs new k8s provisioning on every
            // edition (§6.3: BYO k8s = open the toggle) — same gate
            // reserveRuntime applies to purchased containers.
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
            const resolved = await this.credentialsResolver.resolve(userId, dto)
            const version = await this.resolveFrameworkVersion(
                dto.framework,
                dto.frameworkVersion
            )
            emitter.step('creating_deployment')
            agentCreateId = createObjectId('agent')
            fresh = await this.k8sProvisioner.provision({
                frameworkVersion: version.selection,
                frameworkRepo: version.repo,
                frameworkArtifacts: version.artifacts,
                userId,
                agentCreateId,
                framework: dto.framework,
                sku: {
                    id: null,
                    region: null,
                    cpuMillicores: spec.cpuMillicores,
                    memoryMb: spec.memoryMb,
                    diskGb: spec.diskGb
                },
                name: dto.name,
                credentials: resolved.value,
                modelConfigSource: dto.modelConfigSource ?? null,
                providerId: dto.providerId ?? null
            })
            runtimeRow = fresh.runtime
        }
        try {
            const attachAndConfigure = async () => {
                emitter.step('inserting_agent')
                const summary = await this.attach.attach({
                    runtime: runtimeRow,
                    expectedOwnerUserId: userId,
                    name: dto.name,
                    workspace: dto.workspace,
                    model: undefined,
                    cloneFrom: undefined,
                    agentCreateId,
                    assertAgentCreateActive: fresh
                        ? () => fresh.assertAgentCreateActive()
                        : undefined
                })
                // The existing platform-config contract is unchanged; the fresh
                // runtime's ownership includes the runtime-local write below.
                if (dto.modelConfigSource === 'runtime-local') {
                    await fresh?.assertAgentCreateActive()
                    await this.modelConfig.updateForAgent(
                        userId,
                        summary.id,
                        {
                            modelConfigSource: dto.modelConfigSource,
                            modelConfig: dto.modelConfig
                        },
                        true
                    )
                }
                return summary
            }
            const summary = fresh
                ? await fresh.runAgentCreate(attachAndConfigure)
                : await attachAndConfigure()
            if (!fresh) return summary
            // The fresh create's agent stayed `pending` until its runtime-local
            // config committed; the completed row is what the caller sees.
            await fresh.completeAgentCreate()
            return this.summaryFor(summary.id)
        } catch (error) {
            await fresh?.rollbackAgentCreate(error)
            throw error
        }
    }

    // A k8s agent placed on an existing pod host (ADR-0035): it joins the
    // host's runtime for its framework, or that framework is installed on the
    // host first. A failed install keeps its (host, framework) slot and is
    // retried through the same install path.
    private async placeOnPodHost(
        ctx: OrchestratorContext,
        podHostId: string,
        emitter: AgentProgressEmitter
    ): Promise<AgentRuntimeRow> {
        const { userId, dto, isAdmin } = ctx
        const [found] = await this.db
            .select({ host: runtimeHosts, providerKind: runtimeProviders.kind })
            .from(runtimeHosts)
            .leftJoin(
                runtimeProviders,
                eq(runtimeProviders.id, runtimeHosts.providerId)
            )
            .where(
                and(
                    eq(runtimeHosts.id, podHostId),
                    eq(runtimeHosts.kind, 'hosted')
                )
            )
            .limit(1)
        const host: RuntimeHostRow | undefined =
            found?.providerKind === 'k8s' ? found.host : undefined
        if (!host || (host.userId !== userId && !isAdmin))
            throw new NotFoundException(`cloud computer ${podHostId} not found`)
        if (host.status !== 'ready')
            throw new ConflictException({
                message: `cloud computer ${podHostId} is not ready (status=${host.status})`,
                code: 'CONTAINER_NOT_READY',
                status: host.status
            })
        await this.assertPodHostAttachable(host.id, isAdmin)
        const [existing] = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.hostId, host.id),
                    eq(agentRuntimes.framework, dto.framework)
                )
            )
            .limit(1)
        if (existing && existing.status !== 'failed') {
            if (existing.status !== 'ready')
                throw new ConflictException({
                    message: `${dto.framework} on cloud computer ${podHostId} is not ready (status=${existing.status})`,
                    code: 'CONTAINER_NOT_READY',
                    status: existing.status
                })
            return existing
        }
        if (!this.k8sProvisioner)
            throw new ConflictException({
                message: 'cloud computers are not available',
                code: 'CONTAINER_REQUIRED'
            })
        const resolved = await this.credentialsResolver.resolve(userId, dto)
        const version = await this.resolveFrameworkVersion(
            dto.framework,
            dto.frameworkVersion
        )
        emitter.step('installing_framework')
        return this.k8sProvisioner.addFrameworkRuntime({
            userId: host.userId,
            host,
            framework: dto.framework,
            name: dto.name,
            credentials: resolved.value,
            modelConfigSource: dto.modelConfigSource ?? null,
            frameworkVersion: version.selection,
            frameworkRepo: version.repo,
            frameworkArtifacts: version.artifacts
        })
    }

    private async assertPodHostAttachable(
        podHostId: string,
        isAdmin: boolean
    ): Promise<void> {
        const denial = await this.cloudComputer?.agentAttachDenial({
            podHostId,
            isAdmin
        })
        if (denial)
            throw new ConflictException({
                message: denial.message,
                code: denial.code
            })
    }

    // Best-effort: the sign-in card's "Open terminal" should not detour
    // through the enable-confirm dialog for the mode whose whole point is a
    // terminal sign-in. PATCH /sandboxes/:id/terminal stays the user-facing
    // toggle, and the web enable-on-confirm flow covers a lost write.
    private async enableSandboxTerminalForSignIn(
        userId: string,
        hostId: string | null
    ): Promise<void> {
        if (!hostId) return
        try {
            await this.runtimes.setSandboxTerminalEnabled(userId, hostId, true)
        } catch (err) {
            this.log.warn(
                `enabling terminal for runtime-local sign-in on host ${hostId} failed: ${
                    (err as Error).message
                }`
            )
        }
    }

    async delete(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<void> {
        const ctx = await this.agentContext(agentId)
        if (!ctx) throw new NotFoundException(`agent ${agentId} not found`)
        const row = ctx.agent
        if (row.userId !== callerUserId && !isAdmin)
            throw new NotFoundException(`agent ${agentId} not found`)

        const { runtime } = ctx
        const isPrimary = runtime.primaryAgentId === row.id

        if (ctx.placement === 'k8s') {
            if (isPrimary)
                throw new ConflictException({
                    message: 'primary agent; delete the runtime instead',
                    code: 'PRIMARY_AGENT_DELETE_RUNTIME'
                })
            await this.k8sOrchestrator.deleteNonPrimary(ctx, callerUserId)
        } else if (ctx.placement === 'daemon') {
            await this.deleteDaemonAgent(ctx, callerUserId)
        } else if (ctx.placement === 'sprites') {
            if (!isPrimary) await this.deleteSpritesSecondary(ctx, callerUserId)
            else await this.deleteSpritesPrimaryWithPromote(ctx, callerUserId)
        } else await this.deleteExternal(row, runtime, callerUserId)
        this.changes?.emit(row.userId, { resource: 'agent', resourceId: row.id, agentId: row.id, reason: 'deleted' })
        this.changes?.emit(row.userId, { resource: 'channel', reason: 'updated' })
        this.changes?.emit(row.userId, { resource: 'skill-library', reason: 'updated' })
    }

    private async deleteExternal(
        row: Agent,
        runtime: AgentRuntimeRow,
        actorUserId: string
    ): Promise<void> {
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_STARTED,
            row.id,
            {
                framework: row.framework,
                runtime: 'external',
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
        try {
            await this.db.delete(agents).where(eq(agents.id, row.id))
            await this.externalProvisioner.teardownRuntime(runtime)
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                actorUserId,
                auditAction.AGENT_DELETE_FAILED,
                row.id,
                {
                    framework: row.framework,
                    runtime: 'external',
                    reason,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'external agent delete failed',
                reason
            })
        }
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_SUCCEEDED,
            row.id,
            {
                framework: row.framework,
                runtime: 'external',
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
    }

    private async createExternal(
        ctx: OrchestratorContext,
        emitter: AgentProgressEmitter
    ): Promise<AgentSummary> {
        const { userId, actorUserId, dto } = ctx
        emitter.step('validating')
        const displayName = normalizeAgentName(dto.name)
        const binding =
            dto.framework === 'dify'
                ? dto.difyBinding
                : dto.framework === 'langflow'
                  ? dto.langflowBinding
                  : dto.framework === 'a2a'
                    ? dto.a2aBinding
                    : undefined
        if (!binding)
            throw new ConflictException(
                `framework ${dto.framework} requires a binding`
            )
        const remoteRef: Record<string, unknown> = { ...binding }
        delete (remoteRef as { providerId?: unknown }).providerId
        await this.assertAgentNameFree(userId, displayName)
        const agentId = createObjectId('agent')
        await this.audit(
            actorUserId,
            auditAction.AGENT_CREATE_EXTERNAL_STARTED,
            agentId,
            {
                framework: dto.framework,
                ownerUserId: userId,
                onBehalfOf: actorUserId !== userId
            }
        )
        let provisioned: Awaited<
            ReturnType<ExternalAgentProvisioner['provisionRuntime']>
        > | null = null
        try {
            emitter.step('inserting_agent')
            provisioned = await this.externalProvisioner.provisionRuntime({
                userId,
                framework: dto.framework,
                runtimeName: displayName,
                binding: { providerId: binding.providerId, remoteRef }
            })
            const { runtime } = provisioned
            await this.db
                .insert(agents)
                .values({
                    id: agentId,
                    userId,
                    name: displayName,
                    framework: dto.framework,
                    status: 'ready',
                    runtimeId: runtime.id,
                    workspacePath: null,
                    mountPath: '/workspace',
                    extras: {
                        externalBinding: {
                            providerId: binding.providerId,
                            framework: dto.framework,
                            remoteRef
                        }
                    },
                    fileRoots: [],
                    internalId: agentId,
                    startedAt: new Date(),
                    lastBootstrappedAt: new Date()
                })
            await this.db
                .update(agentRuntimes)
                .set({ primaryAgentId: agentId })
                .where(eq(agentRuntimes.id, runtime.id))
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_EXTERNAL_SUCCEEDED,
                agentId,
                {
                    framework: dto.framework,
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            return await this.summaryFor(agentId)
        } catch (err: unknown) {
            if (err instanceof HttpException) {
                if (provisioned)
                    await this.externalProvisioner
                        .teardownRuntime(provisioned.runtime)
                        .catch(() => undefined)
                throw err
            }
            const reason = sanitizeReason(err)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_EXTERNAL_FAILED,
                agentId,
                {
                    framework: dto.framework,
                    reason,
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            if (provisioned)
                await this.externalProvisioner
                    .teardownRuntime(provisioned.runtime)
                    .catch(() => undefined)
            throw new InternalServerErrorException({ message: reason })
        }
    }

    private async deleteDaemonAgent(
        ctx: AgentContext,
        actorUserId: string
    ): Promise<void> {
        const { agent: row, runtime } = ctx
        const hostId = ctx.host?.id ?? null
        const adapter = this.adapterRegistry.get(row.framework)
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_STARTED,
            row.id,
            {
                framework: row.framework,
                runtime: 'daemon',
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
        try {
            await adapter.removeAgent({
                ...ctx,
                agent: row,
                primaryAgentId: runtime.primaryAgentId ?? null
            })
        } catch (err) {
            const reason = sanitizeReason(err)
            const failureClass = isDaemonUnavailableDetachError(reason)
                ? 'daemon_unavailable'
                : 'detach_failed'
            await this.audit(
                actorUserId,
                auditAction.AGENT_DELETE_FAILED,
                row.id,
                {
                    framework: row.framework,
                    runtime: 'daemon',
                    reason,
                    failureClass,
                    runtimeId: runtime.id,
                    hostId,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            this.telemetry.event('agent.delete.detach_failed', {
                agentId: row.id,
                framework: row.framework,
                runtimeId: runtime.id,
                hostId,
                failureClass,
                reason
            })
            // The row is retained on purpose: daemon agents mirror state the
            // user's own machine holds (openclaw/hermes profiles, workspaces).
            // Deleting the row while the remote copy survives would strand it
            // with no cleanup owner. The host lifecycle (retire + permanent
            // delete) remains the recovery path for a daemon that never
            // comes back.
            if (failureClass === 'daemon_unavailable')
                throw new ConflictException({
                    code: 'agent.daemon_unavailable',
                    message:
                        `the daemon on ${ctx.host?.name ?? hostId} did not confirm the detach; ` +
                        'start the daemon on its host and retry, or retire and ' +
                        'permanently delete the host to remove all of ' +
                        'its agents',
                    details: {
                        retryable: true,
                        agentId: row.id,
                        runtimeId: runtime.id,
                        hostId,
                        reason
                    }
                })
            throw new InternalServerErrorException({
                code: 'agent.daemon_detach_failed',
                message: 'daemon detach failed',
                details: {
                    retryable: false,
                    agentId: row.id,
                    runtimeId: runtime.id,
                    hostId,
                    reason
                }
            })
        }
        const isPrimary = runtime.primaryAgentId === row.id
        if (isPrimary) {
            const candidates = await this.db
                .select()
                .from(agents)
                .where(
                    and(eq(agents.runtimeId, runtime.id), ne(agents.id, row.id))
                )
                .orderBy(asc(agents.createdAt))
                .limit(1)
            const successor = candidates[0]
            await this.db
                .update(agentRuntimes)
                .set({ primaryAgentId: successor?.id ?? null })
                .where(eq(agentRuntimes.id, runtime.id))
        }
        await this.db.delete(agents).where(eq(agents.id, row.id))
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_SUCCEEDED,
            row.id,
            {
                framework: row.framework,
                runtime: 'daemon',
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
    }

    private async deleteSpritesSecondary(
        ctx: AgentContext,
        actorUserId: string
    ): Promise<void> {
        const { agent: row, runtime } = ctx
        const adapter = this.adapterRegistry.get(row.framework)
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_STARTED,
            row.id,
            {
                framework: row.framework,
                runtime: 'sprites',
                nonPrimary: true,
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
        try {
            if (!isBuiltInProfileAgent(ctx, row))
                await adapter.removeAgent({
                    ...ctx,
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
                    runtime: 'sprites',
                    reason,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'sprites secondary detach failed',
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
                runtime: 'sprites',
                nonPrimary: true,
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
    }

    private async deleteSpritesPrimaryWithPromote(
        ctx: AgentContext,
        actorUserId: string
    ): Promise<void> {
        const { agent: row, runtime } = ctx
        const candidates = await this.db
            .select()
            .from(agents)
            .where(and(eq(agents.runtimeId, runtime.id), ne(agents.id, row.id)))
            .orderBy(asc(agents.createdAt))
            .limit(1)
        const successor = candidates[0]
        if (!successor) {
            // Last agent on this runtime: tear the runtime down (deletes this
            // agent + the runtime). The now-empty sandbox host is preserved (the
            // reaper deletes it after the idle window) so the VM + workspace can
            // be reused; DELETE /sandboxes removes it immediately.
            await this.spritesProvisioner.teardownRuntime(runtime, {
                leavingAgentId: row.id
            })
            await this.audit(
                actorUserId,
                auditAction.AGENT_DELETE_SUCCEEDED,
                row.id,
                {
                    framework: row.framework,
                    runtime: 'sprites',
                    lastOnRuntime: true,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            return
        }
        await this.db
            .update(agentRuntimes)
            .set({ primaryAgentId: successor.id })
            .where(eq(agentRuntimes.id, runtime.id))
        const refreshed = await this.agentContext(row.id)
        if (!refreshed)
            throw new InternalServerErrorException(
                `agent ${row.id} disappeared during promote`
            )
        await this.deleteSpritesSecondary(refreshed, actorUserId)
    }

    private async assertAgentNameFree(
        userId: string,
        displayName: string
    ): Promise<void> {
        const existing = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.userId, userId), eq(agents.name, displayName)))
            .limit(1)
        if (existing[0])
            throw new ConflictException({
                message: `agent "${displayName}" already exists for this user`,
                code: 'AGENT_NAME_TAKEN',
                details: { agentId: existing[0].id }
            })
    }

    private async createSprites(
        ctx: OrchestratorContext,
        emitter: AgentProgressEmitter
    ): Promise<AgentSummary> {
        const { userId, actorUserId, dto, isAdmin } = ctx

        emitter.step('validating')

        if (dto.providerId && !isAdmin)
            throw new ForbiddenException(
                'Only admins may pin a runtime provider via providerId'
            )

        const displayName = normalizeAgentName(dto.name)
        await this.assertAgentNameFree(userId, displayName)

        // A sandbox holds at most one instance per framework (the framework's
        // config home and its globally-installed CLI are VM-wide). So "create an
        // agent for a framework this sandbox already runs" means "add an agent to
        // that instance" — the agent inherits the instance's credentials, pinned
        // version and model provider. Credentials sent anyway are refused rather
        // than dropped: they belong to the instance, so honouring them would
        // switch every agent on it.
        // Runs BEFORE credential resolution on purpose: callers targeting an
        // existing instance send no credentials, and resolving first would reject
        // them for that. A failed install keeps its slot and is retried below.
        if (dto.sandboxId) {
            await this.spritesProvisioner.assertSandboxAttachable(
                userId,
                dto.sandboxId
            )
            const instance = await this.runtimes.findRuntimeOnHost(
                dto.sandboxId,
                dto.framework,
                userId
            )
            if (instance && instance.status !== 'failed') {
                if (instance.status !== 'ready')
                    throw new ConflictException({
                        message: `sandbox ${dto.sandboxId} is still bringing up ${dto.framework} (status=${instance.status}); retry once it is ready`,
                        code: 'SANDBOX_FRAMEWORK_INSTANCE_NOT_READY',
                        status: instance.status
                    })
                if (carriesCredentials(dto))
                    throw new BadRequestException({
                        message: `sandbox ${dto.sandboxId} already runs ${dto.framework}; an agent added there uses that instance's credentials. Send none, or change them for every agent on it with PATCH /agents/:id/credentials`,
                        code: 'JOIN_INHERITS_CREDENTIALS'
                    })
                emitter.step('inserting_agent')
                const joined = await this.attach.attach({
                    runtime: instance,
                    expectedOwnerUserId: userId,
                    name: dto.name,
                    workspace: dto.workspace,
                    modelConfigSource: dto.modelConfigSource,
                    runtimeAuthProfileId: dto.runtimeAuthProfileId
                })
                // The inherited instance credentials stay untouched; a
                // runtime-local agent doesn't read them at turn time. But the
                // source choice itself must stick, or the join path silently
                // lands the agent on 'platform'.
                if (dto.modelConfigSource === 'runtime-local') {
                    await this.modelConfig.updateForAgent(
                        userId,
                        joined.id,
                        {
                            modelConfigSource: dto.modelConfigSource,
                            modelConfig: dto.modelConfig
                        },
                        true
                    )
                    await this.enableSandboxTerminalForSignIn(
                        userId,
                        instance.hostId
                    )
                }
                return joined
            }
        }

        const resolved = await this.credentialsResolver.resolve(userId, dto)
        const creds = extractSpritesCredentials(resolved)

        const agentId = createObjectId('agent')
        const workspace = resolveWorkspaceSelection(
            dto.workspace,
            defaultSpriteWorkspaceFor(dto.framework, agentId, userId)
        )

        const frameworkVersion = await this.resolveFrameworkVersion(
            dto.framework,
            dto.frameworkVersion
        )

        let provisioned: Awaited<
            ReturnType<SpritesProvisioner['provisionRuntime']>
        > | null = null
        try {
            provisioned = await this.spritesProvisioner.provisionRuntime({
                userId,
                framework: dto.framework,
                providerId: dto.providerId ?? null,
                attachHostId: dto.sandboxId ?? null,
                isAdmin,
                credentials: creds,
                emitter,
                agentId,
                workspacePath: workspace.path,
                workspaceManaged: workspace.managed,
                modelConfig: dto.modelConfig ?? null,
                modelConfigSource: dto.modelConfigSource ?? null,
                frameworkVersion: frameworkVersion.selection.version,
                frameworkVersionSource: frameworkVersion.selection.source,
                frameworkRepo: frameworkVersion.repo,
                frameworkArtifacts: frameworkVersion.artifacts
            })
        } catch (err: unknown) {
            if (err instanceof HttpException) throw err
            const reason = sanitizeReason(err)
            const errorClass = errorClassOf(err, this.providers)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_FAILED,
                agentId,
                {
                    framework: dto.framework,
                    errorClass,
                    reason,
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            throw new InternalServerErrorException({
                message: reason,
                errorClass
            })
        }

        const { runtime, host, provider } = provisioned
        await this.audit(
            actorUserId,
            auditAction.AGENT_CREATE_STARTED,
            agentId,
            {
                framework: dto.framework,
                hostId: host.id,
                providerId: provider.id,
                ownerUserId: userId,
                onBehalfOf: actorUserId !== userId
            }
        )

        const workspacePath = workspace.path

        emitter.step('inserting_agent')
        try {
            const [insertedAgent] = await this.db
                .insert(agents)
                .values({
                    id: agentId,
                    userId,
                    name: displayName,
                    framework: dto.framework,
                    status: 'pending',
                    mountPath: workspacePath,
                    extras: workspaceExtras(workspace.managed),
                    currentPhase: null,
                    runtimeId: runtime.id,
                    workspacePath,
                    fileRoots: buildFileRoots({
                        framework: dto.framework,
                        runtime: 'sprites',
                        mountPath: workspacePath,
                        homeDir: provisioned.homeDir ?? host.homeDir
                    }),
                    internalId: agentId,
                    modelProviderId: resolved.providerId
                })
                .returning()
            await this.db
                .update(agentRuntimes)
                .set({ primaryAgentId: agentId })
                .where(eq(agentRuntimes.id, runtime.id))

            // Mint + inject the runtime identity token only now that the agents
            // row exists — the agent_runtime_tokens FK references agents.id, so
            // doing this during provisioning would violate the FK. Fail-loud: a
            // mint/inject failure throws and the catch below tears the runtime
            // down (no half-provisioned, tokenless agent).
            await this.spritesProvisioner.installRuntimeIdentity({
                userId,
                agentId
            })

            emitter.step('storing_credentials')
            const credentialsToStore = provisioned.generatedCredentials
                ? {
                      ...(creds as Record<string, unknown>),
                      ...provisioned.generatedCredentials
                  }
                : creds
            const credEnc = this.crypto.encrypt(
                JSON.stringify(credentialsToStore)
            )
            await this.db.insert(agentCredentials).values({
                id: createObjectId('agentCredential'),
                runtimeId: runtime.id,
                framework: dto.framework,
                payloadCiphertext: credEnc.ciphertext,
                keyVersion: credEnc.keyVersion
            })

            if (this.extensions.get(dto.framework)?.pushPrimaryAgent) {
                // The framework's own agent list starts empty. Push the
                // primary agent now so reconcile's listAgents finds it on the
                // first pass (instead of marking it missing).
                const target = await this.runtimeContext.forRuntime(runtime.id)
                if (!target)
                    throw new InternalServerErrorException(
                        `${dto.framework} runtime ${runtime.id} vanished after provision`
                    )
                const adapter = this.adapterRegistry.get(dto.framework)
                await adapter.addAgent({
                    ...target,
                    primaryAgentId: null,
                    agentId,
                    internalId: agentId,
                    name: displayName
                })
            }

            if (
                dto.framework === 'claude-code' ||
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

            if (dto.modelConfigSource === 'runtime-local')
                await this.enableSandboxTerminalForSignIn(userId, host.id)

            if (dto.restoreBackupId) {
                emitter.step('restoring_backup')
                await this.backups.restoreBackupToAgentForCreate({
                    actorUserId,
                    isAdmin,
                    backupId: dto.restoreBackupId,
                    agent: insertedAgent
                })
            }

            emitter.step('finalizing')
            const now = new Date()
            await this.spritesProvisioner.finalizeReady(runtime.id, now)
            await this.db
                .update(agents)
                .set({
                    status: 'ready',
                    startedAt: now,
                    lastBootstrappedAt: now,
                    failureReason: null,
                    currentPhase: null,
                    updatedAt: now
                })
                .where(eq(agents.id, agentId))
            // Delivered through the machine's daemon now that the agent row
            // exists to record it, as for an agent added later (ADR-0037 R6).
            // Best effort: the status card offers the refresh.
            if (contextDocInstructionFile(dto.framework))
                await this.contextDoc?.refreshOnChange(insertedAgent)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_SUCCEEDED,
                agentId,
                {
                    framework: dto.framework,
                    hostId: host.id,
                    providerId: provider.id,
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
            await this.installDefaultSkills({
                userId,
                agentId,
                framework: dto.framework
            })
            return await this.summaryFor(agentId)
        } catch (err: unknown) {
            const reason = sanitizeReason(err)
            const errorClass = errorClassOf(err, this.providers)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_FAILED,
                agentId,
                {
                    framework: dto.framework,
                    hostId: host.id,
                    providerId: provider.id,
                    errorClass,
                    reason,
                    ownerUserId: userId,
                    onBehalfOf: actorUserId !== userId
                }
            )
            try {
                await this.spritesProvisioner.teardownRuntime(runtime, {
                    reapImmediatelyIfEmpty: true
                })
            } catch (cleanupErr: unknown) {
                this.log.warn(
                    `runtime cleanup failed for ${runtime.id}: ${(cleanupErr as Error).message}`
                )
            }
            throw new InternalServerErrorException({
                message: reason,
                errorClass
            })
        }
    }

    private async installDefaultSkills(input: {
        userId: string
        agentId: string
        framework: AgentFramework
    }): Promise<void> {
        try {
            const skills = this.moduleRef.get(SkillsService, { strict: false })
            await skills.installDefaults({ ...input, runtime: 'sprites' })
        } catch (err) {
            this.log.warn(
                `default-skill install skipped for ${input.agentId}: ${(err as Error).message}`
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
                `audit write failed: ${(err as Error).message} action=${action}`
            )
        }
    }
}

const defaultSpriteWorkspaceFor = (
    framework: AgentFramework,
    agentId: string,
    userId: string
): string => {
    // Service-kind frameworks own their own home dir; the workspace should
    // match what their recipes set up, not the coding-agent
    // .manyfold/workspaces convention.
    return (
        serviceFrameworkRecipe(framework)?.sandbox.workspaceSeed(
            SPRITE_HOME_BASE,
            agentId,
            userId
        ) ?? codingAgentWorkspacePath('sprites', agentId)
    )
}

const extractSpritesCredentials = (
    resolved: ResolvedAgentCredentials
): unknown => {
    if (!supportsRuntime(resolved.framework, 'sprites'))
        throw new Error(`unsupported sprites framework: ${resolved.framework}`)
    return resolved.value
}

const errorClassOf = (
    err: unknown,
    providers: SandboxProviderRegistry | undefined
): string => {
    if (err instanceof BootstrapError) return `bootstrap:${err.step}`
    return providers?.describeError(err)?.errorClass ?? 'unknown'
}

const sanitizeReason = (err: unknown): string => {
    const message = (err as Error)?.message ?? 'unknown error'
    return message.slice(0, 512).replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
}

// Detach never reached a verdict from the daemon: the rpc found no socket,
// the transport dropped mid-flight, or the call timed out. Unlike chat turns
// (where these strings split into suspend-vs-retry, see chat-adapter.ts),
// every one of these is safely retryable for a delete — the framework CLIs
// treat an already-absent agent as success, so re-running the detach after
// the daemon returns cannot double-delete. Anything OUTSIDE this set means
// the daemon DID answer and refused (CLI exited non-zero, host row missing),
// which no retry will fix — that class stays a 500.
const isDaemonUnavailableDetachError = (message: string): boolean =>
    isDaemonOfflineTransportError(message) ||
    isDaemonNotDispatchedError(message) ||
    /rpc \S+ timed out/.test(message) ||
    /is offline; start its daemon/.test(message) ||
    /has no running daemon/.test(message)
