import {
    AgentCreateStep,
    AgentFramework,
    AgentRuntime,
    EXPERIMENT_KEYS,
    FEATURE_TOGGLE_KEYS,
    FrameworkRuntimeDefaultsSettings,
    FrameworkVersionSelection,
    RotateRuntimeTokenResponse,
    SPRITE_HOME_BASE,
    UserFrameworkRuntimeOverridesSettings,
    agentRuntime,
    auditAction,
    blockedVersionMessage,
    blockedVersionRangesFor,
    codingAgentWorkspacePath,
    configurableFrameworkRuntimeDefaults,
    createObjectId,
    findBlockedVersionRange,
    frameworkPrereleaseAllowed,
    isExternal,
    isPrereleaseVersion,
    isVersionedFramework,
    normalizeAgentName,
    resolveFrameworkRepo,
    selectFrameworkInstallVersion,
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
    type Agent,
    type AgentRuntimeRow,
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    SpritesError
} from '@manyfold/sprites'
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
import { SKILL_FRAMEWORKS } from '@/modules/skills/skill-utils'
import { DRIZZLE } from '@/db/tokens'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import { UsersService } from '@/modules/users/users.service'
import { AgentsService } from '@/modules/agents/agents.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { RuntimeTokenService } from '@/modules/auth/runtime-token.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
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
import { K8sContainerProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { K8sAgentOrchestrator } from '@/modules/agents/orchestration/k8s-agent-orchestrator'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAgentAttachService } from '@/modules/agents/orchestration/runtime-agent-attach.service'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import {
    MANYFOLD_CONTEXT_VERSION,
    contextDocInstructionFile
} from '@/modules/agent-self/agent-context-doc.service'
import { narraNexusSeedWorkspacePath } from '@/modules/narranexus/narranexus-paths'
import { ExternalAgentProvisioner } from '@/modules/agent-runtimes/provisioning/external-provisioner'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import type { ResolvedAgentCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { BackupsService } from '@/modules/backups/backups.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import {
    resolveWorkspaceSelection,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'

interface OrchestratorContext {
    userId: string
    actorUserId: string
    dto: CreateAgentDto
    isAdmin: boolean
}

export interface AgentProgressEmitter {
    step(step: AgentCreateStep): void
}

const noopEmitter: AgentProgressEmitter = { step: () => {} }

const PLATFORM_RUNTIME_DEFAULTS: Partial<Record<AgentFramework, AgentRuntime>> =
    {
        'claude-code': agentRuntime.SPRITES,
        codex: agentRuntime.SPRITES,
        'gemini-cli': agentRuntime.SPRITES,
        narranexus: agentRuntime.SPRITES
    }

type ConfigurableRuntimeDefaultFramework =
    keyof FrameworkRuntimeDefaultsSettings['defaults']

const isConfigurableRuntimeDefaultFramework = (
    framework: AgentFramework
): framework is ConfigurableRuntimeDefaultFramework =>
    (configurableFrameworkRuntimeDefaults as readonly string[]).includes(
        framework
    )

export const resolveRuntime = (
    framework: AgentFramework,
    userChoice?: AgentRuntime,
    defaults?: FrameworkRuntimeDefaultsSettings,
    userOverrides?: UserFrameworkRuntimeOverridesSettings
): AgentRuntime => {
    if (isExternal(framework)) {
        if (userChoice && userChoice !== agentRuntime.EXTERNAL)
            throw new ConflictException(
                `framework ${framework} requires runtime=external`
            )
        return agentRuntime.EXTERNAL
    }
    if (userChoice === agentRuntime.DAEMON) {
        if (!supportsRuntime(framework, agentRuntime.DAEMON))
            throw new ConflictException(
                `framework ${framework} cannot run on a local daemon`
            )
        return agentRuntime.DAEMON
    }
    if (userChoice === agentRuntime.EXTERNAL)
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
    const platformDefault = PLATFORM_RUNTIME_DEFAULTS[framework]
    if (platformDefault) return platformDefault
    throw new ConflictException(
        `framework ${framework} requires an explicit runtime or configured admin default`
    )
}

const lastActiveAtFor = (row: Agent): string | null => {
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

const toExternalSummary = (row: Agent): AgentSummary => ({
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
    clusterId: null,
    clusterName: null,
    spriteName: null,
    spriteId: null,
    mountPath: row.mountPath,
    namespace: null,
    ingressHost: null,
    endpointUrl: null,
    controlUiEnabled: false,
    dashboardEnabled: false,
    dashboardState: null,
    keepAliveEnabled: false,
    currentPhase: null,
    failureReason: null,
    internalId: row.internalId,
    model: row.model,
    extras: row.extras,
    workspacePath: row.workspacePath,
    storageBytes: row.storageBytes ?? null,
    storageMeasuredAt: row.storageMeasuredAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    lastActiveAt: lastActiveAtFor(row),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastBootstrappedAt: row.lastBootstrappedAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const toSpritesSummary = (
    row: Agent,
    accountSlug: string | null,
    runtime: {
        controlUiEnabled: boolean
        dashboardEnabled: boolean
        dashboardState: string | null
        keepAliveEnabled: boolean
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
    accountSlug,
    clusterId: row.clusterId,
    clusterName: null,
    spriteName: row.spriteName,
    spriteId: row.spriteId,
    mountPath: row.mountPath,
    namespace: row.namespace,
    ingressHost: row.ingressHost,
    endpointUrl: null,
    controlUiEnabled: runtime?.controlUiEnabled ?? false,
    dashboardEnabled: runtime?.dashboardEnabled ?? false,
    dashboardState: runtime?.dashboardState ?? null,
    keepAliveEnabled: runtime?.keepAliveEnabled ?? false,
    currentPhase: row.currentPhase,
    failureReason: row.failureReason,
    internalId: row.internalId,
    model: row.model,
    extras: row.extras,
    workspacePath: row.workspacePath,
    storageBytes: row.storageBytes ?? null,
    storageMeasuredAt: row.storageMeasuredAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    lastActiveAt: lastActiveAtFor(row),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastBootstrappedAt: row.lastBootstrappedAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class AgentOrchestratorService {
    private readonly log = new Logger(AgentOrchestratorService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly agentsService: AgentsService,
        private readonly accounts: SpritesAccountsService,
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
        private readonly k8sProvisioner?: K8sContainerProvisioner
    ) {}

    // Version a new sprite agent installs: what the caller asked for, else the
    // admin pin, else the newest release upstream. The last tier is what keeps a
    // fresh agent off the sprite image's baked-in (and usually months-old) CLI.
    // A framework with no versioned CLI, or an unreachable catalog, resolves to
    // `none` and keeps that framework's built-in default.
    private async resolveFrameworkVersion(
        framework: AgentFramework,
        requested?: string | null
    ): Promise<{ selection: FrameworkVersionSelection; repo: string | null }> {
        const settings =
            await this.adminSettings.getCachedFrameworkDefaultVersions()
        // Resolved from the SAME settings read as the version below. A separate
        // read could see a source switch land in between and hand the bootstrap
        // a tag that only exists on the repository it is no longer cloning.
        const repo = resolveFrameworkRepo(framework, settings)
        const adminDefault = settings.defaults[framework]
        const blocked = blockedVersionRangesFor(framework, settings)
        const allowPrerelease = frameworkPrereleaseAllowed(framework, settings)
        // A blocked pin is skipped rather than installed, so the catalog tier
        // has to be reachable to take over — fetch it whenever no usable pin
        // survives, not just when none was configured. A prerelease pin with the
        // opt-in off is skipped the same way and for the same reason.
        const pinUsable =
            !!adminDefault &&
            !findBlockedVersionRange(adminDefault, blocked) &&
            (allowPrerelease || !isPrereleaseVersion(adminDefault))
        const catalogLatest =
            !requested && !pinUsable && isVersionedFramework(framework)
                ? await this.frameworkVersions.latestForFresh(framework)
                : null
        const selection = selectFrameworkInstallVersion({
            requested,
            adminDefault,
            catalogLatest,
            blocked,
            allowPrerelease
        })
        if (selection.source !== 'none' && selection.blockedBy)
            throw new BadRequestException(
                blockedVersionMessage(
                    framework,
                    selection.version,
                    selection.blockedBy
                )
            )
        if (selection.source !== 'none' && selection.prereleaseNotAllowed)
            throw new BadRequestException(
                `${framework} version ${selection.version} is a pre-release; enable pre-release versions for ${framework} first`
            )
        return { selection, repo }
    }

    // Rotate the agent's runtime identity and re-inject it live. Order-B,
    // brick-safe-by-recovery: installRuntimeIdentity mints (revoking the prior
    // active row + inserting the new active row atomically) THEN re-injects with
    // required:true. If injection throws, the new token is already valid and
    // re-injectable (retry rotate) while the old is intentionally dead — never a
    // silent half-rotate. NOT zero-downtime: the old in-shell token stops the
    // instant the mint commits, so this is an explicit, not-routine operation.
    // k8s rotation (Secret patch + pod restart/drain) is deferred — re-provision
    // to rotate a k8s identity. A daemon identity rotates mint-only, because it
    // is injected per turn rather than living in a shell profile (#781).
    async rotateRuntimeToken(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<RotateRuntimeTokenResponse> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || (agent.userId !== callerUserId && !isAdmin))
            throw new NotFoundException('agent not found')

        if (agent.runtime === 'daemon') {
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
                callerUserId
            )
            return {
                agentId: agent.id,
                runtimeKind: 'daemon',
                rotatedAt: new Date().toISOString()
            }
        }

        if (agent.runtime !== 'sprites') {
            if (agent.runtime === 'k8s')
                throw new ConflictException(
                    'k8s runtime-token rotation is not supported yet; re-provision the agent to rotate its identity'
                )
            throw new BadRequestException(
                `runtime-token rotation is not supported for ${agent.runtime} runtimes`
            )
        }
        if (!agent.accountId || !agent.spriteName)
            throw new BadRequestException(
                'sprite agent is missing its account or sprite name'
            )

        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new NotFoundException('sprites account not found for agent')
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })

        try {
            await this.spritesProvisioner.installRuntimeIdentity({
                userId: agent.userId,
                agentId: agent.id,
                client,
                spriteName: agent.spriteName
            })
        } catch (err) {
            await this.writeRotateAudit(
                auditAction.RUNTIME_TOKEN_ROTATE_FAILED,
                agent,
                callerUserId,
                (err as Error).message
            )
            throw new InternalServerErrorException(
                `runtime-token rotation failed mid-inject for ${agent.id}; the new token is valid but not yet injected — retry rotate (the previous token is revoked)`
            )
        }

        await this.writeRotateAudit(
            auditAction.RUNTIME_TOKEN_ROTATED,
            agent,
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
                    runtime: agent.runtime,
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
        // the container's actual kind instead of inferring from framework. This
        // lets the frontend always POST /agents with { framework, runtimeId }
        // without having to also set runtime='k8s'.
        const [defaults, userOverrides] = ctx.dto.runtimeId
            ? [undefined, undefined]
            : await Promise.all([
                  this.adminSettings.getCachedFrameworkRuntimeDefaults(),
                  this.users.getFrameworkRuntimeOverrides(ctx.userId)
              ])
        const runtime = ctx.dto.runtimeId
            ? agentRuntime.K8S
            : resolveRuntime(
                  ctx.dto.framework,
                  ctx.dto.runtime,
                  defaults,
                  userOverrides
              )
        let result: AgentSummary
        if (runtime === agentRuntime.K8S)
            result = await this.createK8sAgent(ctx, emitter)
        else if (runtime === agentRuntime.DAEMON)
            throw new ConflictException(
                'daemon runtimes are created by the daemon itself; attach via POST /agent-runtimes/:id/agents instead'
            )
        else if (runtime === agentRuntime.EXTERNAL)
            result = await this.createExternal(ctx, emitter)
        else result = await this.createSprites(ctx, emitter)
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
        if (dto.runtimeId) {
            const existing = await this.runtimes.findById(dto.runtimeId)
            if (!existing || (existing.userId !== userId && !isAdmin))
                throw new NotFoundException(
                    `agent runtime ${dto.runtimeId} not found`
                )
            if (existing.kind !== 'k8s')
                throw new ConflictException({
                    message: `runtime ${dto.runtimeId} is not a k8s container`,
                    code: 'RUNTIME_KIND_MISMATCH',
                    kind: existing.kind
                })
            if (existing.framework !== dto.framework)
                throw new ConflictException({
                    message: `container is for framework ${existing.framework}; cannot attach ${dto.framework} agent`,
                    code: 'FRAMEWORK_MISMATCH',
                    expected: existing.framework,
                    got: dto.framework
                })
            if (existing.status !== 'ready')
                throw new ConflictException({
                    message: `container ${dto.runtimeId} is not ready (status=${existing.status})`,
                    code: 'CONTAINER_NOT_READY',
                    status: existing.status
                })
            const attachDenial = await this.cloudComputer?.agentAttachDenial({
                runtimeId: existing.id,
                isAdmin
            })
            if (attachDenial)
                throw new ConflictException({
                    message: attachDenial.message,
                    code: attachDenial.code
                })
            runtimeRow = existing
        } else {
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
            const resolved = await this.credentialsResolver.resolve(
                userId,
                dto
            )
            emitter.step('creating_deployment')
            const provisioned = await this.k8sProvisioner.provision({
                userId,
                sku: {
                    id: null,
                    framework: dto.framework,
                    region: null,
                    cpuMillicores: spec.cpuMillicores,
                    memoryMb: spec.memoryMb,
                    diskGb: spec.diskGb
                },
                name: dto.name,
                credentials: resolved.value,
                clusterId: dto.clusterId ?? null
            })
            runtimeRow = provisioned.runtime
        }
        emitter.step('inserting_agent')
        return this.attach.attach({
            runtime: runtimeRow,
            name: dto.name,
            workspace: dto.workspace,
            model: undefined,
            cloneFrom: undefined
        })
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

        const runtime = row.runtimeId
            ? await this.runtimes.findById(row.runtimeId)
            : null
        const isPrimary = !!runtime && runtime.primaryAgentId === row.id

        if (row.runtime === 'k8s') {
            if (isPrimary)
                throw new ConflictException({
                    message: 'primary agent; delete the runtime instead',
                    code: 'PRIMARY_AGENT_DELETE_RUNTIME'
                })
            return this.k8sOrchestrator.deleteNonPrimary(row, callerUserId)
        }

        if (row.runtime === 'daemon') {
            if (!runtime)
                throw new InternalServerErrorException(
                    `daemon agent ${row.id} has no runtime`
                )
            return this.deleteDaemonAgent(row, runtime, callerUserId)
        }

        if (row.runtime === 'sprites') {
            if (!runtime)
                throw new InternalServerErrorException(
                    `sprites agent ${row.id} has no runtime`
                )
            if (!isPrimary)
                return this.deleteSpritesSecondary(row, runtime, callerUserId)
            return this.deleteSpritesPrimaryWithPromote(
                row,
                runtime,
                callerUserId
            )
        }

        if (row.runtime === 'external') {
            if (!runtime)
                throw new InternalServerErrorException(
                    `external agent ${row.id} has no runtime`
                )
            return this.deleteExternal(row, runtime, callerUserId)
        }

        throw new InternalServerErrorException(
            `unknown agent runtime kind: ${row.runtime}`
        )
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
            const [insertedAgent] = await this.db
                .insert(agents)
                .values({
                    id: agentId,
                    userId,
                    name: displayName,
                    framework: dto.framework,
                    runtime: 'external',
                    status: 'running',
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
                .returning()
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
            return toExternalSummary(insertedAgent)
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
        row: Agent,
        runtime: AgentRuntimeRow,
        actorUserId: string
    ): Promise<void> {
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
                runtime,
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
                    daemonId: runtime.daemonId,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            this.telemetry.event('agent.delete.detach_failed', {
                agentId: row.id,
                framework: row.framework,
                runtimeId: runtime.id,
                daemonId: runtime.daemonId,
                failureClass,
                reason
            })
            // The row is retained on purpose: daemon agents mirror state the
            // user's own machine holds (openclaw/hermes profiles, workspaces).
            // Deleting the row while the remote copy survives would strand it
            // with no cleanup owner. The host lifecycle (revoke + permanent
            // delete) remains the recovery path for a daemon that never
            // comes back.
            if (failureClass === 'daemon_unavailable')
                throw new ConflictException({
                    code: 'agent.daemon_unavailable',
                    message:
                        `daemon ${runtime.daemonId} did not confirm the detach; ` +
                        'start the daemon on its host and retry, or revoke and ' +
                        'permanently delete the daemon host to remove all of ' +
                        'its agents',
                    details: {
                        retryable: true,
                        agentId: row.id,
                        runtimeId: runtime.id,
                        daemonId: runtime.daemonId,
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
                    daemonId: runtime.daemonId,
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
        row: Agent,
        runtime: AgentRuntimeRow,
        actorUserId: string
    ): Promise<void> {
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
        row: Agent,
        runtime: AgentRuntimeRow,
        actorUserId: string
    ): Promise<void> {
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
            await this.spritesProvisioner.teardownRuntime(runtime)
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
        const refreshed = await this.runtimes.findById(runtime.id)
        if (!refreshed)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} disappeared during promote`
            )
        await this.deleteSpritesSecondary(row, refreshed, actorUserId)
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
            throw new ConflictException(
                `agent "${displayName}" already exists for this user`
            )
    }

    private async createSprites(
        ctx: OrchestratorContext,
        emitter: AgentProgressEmitter
    ): Promise<AgentSummary> {
        const { userId, actorUserId, dto, isAdmin } = ctx

        emitter.step('validating')

        if (dto.accountId && !isAdmin)
            throw new ForbiddenException(
                'Only admins may pin a sprites account via accountId'
            )

        const displayName = normalizeAgentName(dto.name)
        await this.assertAgentNameFree(userId, displayName)

        // A sandbox holds at most one instance per framework (the framework's
        // config home and its globally-installed CLI are VM-wide). So "create an
        // agent for a framework this sandbox already runs" means "add an agent to
        // that instance" — the agent inherits the instance's credentials, pinned
        // version and model provider, and any of those supplied here are ignored.
        // Runs BEFORE credential resolution on purpose: callers targeting an
        // existing instance send no credentials, and resolving first would reject
        // them for that.
        if (dto.sandboxId) {
            const instance = await this.runtimes.findSpriteRuntimeOnHost(
                dto.sandboxId,
                dto.framework
            )
            if (instance) {
                if (instance.status !== 'ready')
                    throw new ConflictException({
                        message: `sandbox ${dto.sandboxId} is still bringing up ${dto.framework} (status=${instance.status}); retry once it is ready`,
                        code: 'SANDBOX_FRAMEWORK_INSTANCE_NOT_READY',
                        status: instance.status
                    })
                emitter.step('inserting_agent')
                return this.attach.attach({
                    runtime: instance,
                    name: dto.name,
                    workspace: dto.workspace
                })
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
                accountId: dto.accountId ?? null,
                attachHostId: dto.sandboxId ?? null,
                isAdmin,
                credentials: creds,
                emitter,
                agentId,
                workspacePath: workspace.path,
                workspaceManaged: workspace.managed,
                modelConfig: dto.modelConfig ?? null,
                frameworkVersion: frameworkVersion.selection.version,
                frameworkVersionSource: frameworkVersion.selection.source,
                frameworkRepo: frameworkVersion.repo
            })
        } catch (err: unknown) {
            if (err instanceof HttpException) throw err
            const reason = sanitizeReason(err)
            const errorClass = errorClassOf(err)
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

        const { runtime, account } = provisioned
        await this.audit(
            actorUserId,
            auditAction.AGENT_CREATE_STARTED,
            agentId,
            {
                framework: dto.framework,
                accountSlug: account.slug,
                ownerUserId: userId,
                onBehalfOf: actorUserId !== userId
            }
        )

        const workspacePath = workspace.path

        const spriteIngressHost = extractHost(provisioned.endpointUrl ?? null)
        if (spriteIngressHost)
            await this.runtimes.applyProvisioningPatch(runtime.id, {
                ingressHost: spriteIngressHost
            })

        emitter.step('inserting_agent')
        try {
            const [insertedAgent] = await this.db
                .insert(agents)
                .values({
                    id: agentId,
                    userId,
                    name: displayName,
                    framework: dto.framework,
                    runtime: 'sprites',
                    status: 'pending',
                    accountId: account.id,
                    spriteName: runtime.spriteName,
                    spriteId: runtime.spriteId,
                    hostId: runtime.hostId,
                    ingressHost: spriteIngressHost,
                    mountPath: workspacePath,
                    extras: workspaceExtras(
                        workspace.managed,
                        // Bootstrap (above, in provisionRuntime) already wrote
                        // AGENTS.manyfold.md for coding frameworks, but the agents
                        // row didn't exist yet to record it — seed the version so
                        // the status card reads correctly without waking the VM.
                        contextDocInstructionFile(dto.framework)
                            ? {
                                  contextDoc: {
                                      version: MANYFOLD_CONTEXT_VERSION,
                                      generatedAt: new Date().toISOString()
                                  }
                              }
                            : {}
                    ),
                    currentPhase: null,
                    runtimeId: runtime.id,
                    workspacePath,
                    fileRoots: buildFileRoots({
                        framework: dto.framework,
                        runtime: 'sprites',
                        mountPath: workspacePath,
                        homeDir: provisioned.homeDir
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
            if (!runtime.spriteName)
                throw new InternalServerErrorException(
                    `runtime ${runtime.id} has no spriteName for identity injection`
                )
            await this.spritesProvisioner.installRuntimeIdentity({
                userId,
                agentId,
                client: provisioned.spritesClient,
                spriteName: runtime.spriteName
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

            if (dto.framework === 'narranexus') {
                // NarraNexus container starts with an empty agents table.
                // Push the primary agent now so reconcile's listAgents finds
                // it on the first pass (instead of marking it stopped). The
                // local `runtime` variable predates applyProvisioningPatch's
                // ingressHost write — refresh so the adapter has a host to
                // hit.
                const refreshedRuntime = await this.runtimes.findById(
                    runtime.id
                )
                if (!refreshedRuntime)
                    throw new InternalServerErrorException(
                        `narranexus runtime ${runtime.id} vanished after provision`
                    )
                const adapter = this.adapterRegistry.get('narranexus')
                await adapter.addAgent({
                    runtime: refreshedRuntime,
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
            const [updated] = await this.db
                .update(agents)
                .set({
                    status: 'running',
                    spriteStatus: 'running',
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
                auditAction.AGENT_CREATE_SUCCEEDED,
                agentId,
                {
                    framework: dto.framework,
                    accountSlug: account.slug,
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
            return toSpritesSummary(updated, account.slug, runtime)
        } catch (err: unknown) {
            const reason = sanitizeReason(err)
            const errorClass = errorClassOf(err)
            await this.audit(
                actorUserId,
                auditAction.AGENT_CREATE_FAILED,
                agentId,
                {
                    framework: dto.framework,
                    accountSlug: account.slug,
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

    // Best-effort: auto-install the platform's default first-party skill(s) on a
    // fresh agent. Gated by the `default_agent_skills` admin setting (empty until
    // the first-party skill is published), and never fails agent creation — the
    // baked bootstrap hint + `mf help --agent` remain the floor if this is a no-op.
    private async installDefaultSkills(input: {
        userId: string
        agentId: string
        framework: AgentFramework
    }): Promise<void> {
        if (!(SKILL_FRAMEWORKS as readonly string[]).includes(input.framework))
            return
        try {
            const { skillIds } =
                await this.adminSettings.getDefaultAgentSkills()
            if (skillIds.length === 0) return
            const skills = this.moduleRef.get(SkillsService, { strict: false })
            for (const skillId of skillIds) {
                try {
                    await skills.install({
                        userId: input.userId,
                        skillId,
                        agentId: input.agentId
                    })
                } catch (err) {
                    this.log.warn(
                        `default-skill install ${skillId} failed for ${input.agentId}: ${(err as Error).message}`
                    )
                }
            }
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
    // Service-kind frameworks (Hermes/OpenClaw/NarraNexus on sprite) own
    // their own home dir; the workspace should match what the bootstraps
    // actually use, not the coding-agent .manyfold/workspaces convention.
    if (framework === 'hermes') return `${SPRITE_HOME_BASE}/.hermes`
    if (framework === 'openclaw')
        return `${SPRITE_HOME_BASE}/.openclaw/workspace`
    if (framework === 'narranexus')
        // A seed only: the NarraNexus agent does not exist yet, so its gateway
        // cannot be asked where the workspace will be. The layout is theirs and
        // has changed before, so nothing may address a file through this —
        // FilesContextBuilder resolves and rewrites it. See narranexus-paths.ts.
        return narraNexusSeedWorkspacePath('sprites', agentId, userId)
    return codingAgentWorkspacePath('sprites', agentId)
}

const extractHost = (url: string | null): string | null => {
    if (!url) return null
    try {
        return new URL(url).host || null
    } catch {
        return null
    }
}

const extractSpritesCredentials = (
    resolved: ResolvedAgentCredentials
): unknown => {
    if (resolved.framework === 'claude-code') return resolved.value
    if (resolved.framework === 'codex') return resolved.value
    if (resolved.framework === 'gemini-cli') return resolved.value
    if (resolved.framework === 'hermes') return resolved.value
    if (resolved.framework === 'openclaw') return resolved.value
    if (resolved.framework === 'narranexus') return resolved.value
    throw new Error(`unsupported sprites framework: ${resolved.framework}`)
}

const errorClassOf = (err: unknown): string => {
    if (err instanceof BootstrapError) return `bootstrap:${err.step}`
    if (err instanceof SpritesError) return `sprites:${err.code}`
    return 'unknown'
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
    /rpc \S+ timed out/.test(message)
