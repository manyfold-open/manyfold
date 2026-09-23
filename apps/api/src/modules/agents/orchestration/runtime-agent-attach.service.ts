import type { AgentModelConfigSource } from '@manyfold/shared'
import {
    AgentFramework,
    AgentSummary,
    createObjectId,
    isExternal,
    isRegisteredFramework,
    normalizeAgentName
} from '@manyfold/shared'
import {
    Optional,
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type NewAgent
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { ResourceChangesService } from '@/modules/resource-events/resource-changes.service'
import {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT
} from '@/modules/agent-runtimes/provisioning/k8s-create-cleanup.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import {
    NotSupportedError,
    type AddAgentResult,
    type AgentAdapter
} from '@/modules/agents/adapters/agent-adapter'
import { agentRowToSummary } from '@/modules/agents/agents.service'
import {
    AgentReconcileService,
    serviceBuiltInProfile
} from '@/modules/agents/reconcile/agent-reconcile.service'
import { buildFileRoots } from '@/modules/agents/bootstrap/file-roots'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { SkillsService } from '@/modules/skills/skills.service'
import {
    normalizeWorkspacePathInput,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'

// Every framework that runs in a runtime of its own can take a live agent;
// the external-API frameworks cannot.
const supportsLiveAgents = (framework: AgentFramework): boolean =>
    isRegisteredFramework(framework) && !isExternal(framework)

const frameworkInternalIdForAgentId = (agentId: string): string =>
    agentId.replace(/_/g, '-')

// The built-in profile as its gateway lists it: the workspace and model are
// the service's own.
const builtInProfileAgent = async (
    adapter: AgentAdapter,
    runtime: AgentRuntimeRow,
    agentId: string,
    profile: string
): Promise<AddAgentResult> => {
    const live = await adapter.listAgents({ runtime, primaryAgentId: null })
    const found = live.find((agent) => agent.id === profile)
    if (!found)
        throw new ServiceUnavailableException(
            `${runtime.framework} on cloud computer ${runtime.hostId} lists no ${profile} profile`
        )
    return {
        internalId: agentId,
        workspace: found.workspace,
        model: found.model,
        extras: found.extras
    }
}

export interface AttachAgentInput {
    runtime: AgentRuntimeRow
    name: string
    workspace?: string
    model?: string
    cloneFrom?: string
    // The joining agent's auth choice (add-agent / create-with-sandboxId):
    // persisted after the insert so the wizard's pick survives the join,
    // which used to land every joiner on the runtime's inherited source.
    modelConfigSource?: AgentModelConfigSource
    runtimeAuthProfileId?: string | null
    // Server-only: the pending runtime belongs to this fresh create request.
    agentCreateId?: string
    assertAgentCreateActive?: () => Promise<void>
}

@Injectable()
export class RuntimeAgentAttachService {
    private readonly log = new Logger(RuntimeAgentAttachService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly reconcile: AgentReconcileService,
        private readonly credentialsResolver: CredentialsResolverService,
        private readonly skills: SkillsService,
        @Optional()
        private readonly modelConfig?: AgentModelConfigService,
        @Optional()
        private readonly contextDoc?: AgentContextDocManageService,
        @Optional() private readonly changes?: ResourceChangesService
    ) {}

    async attach(input: AttachAgentInput): Promise<AgentSummary> {
        let { runtime } = input
        if (runtime.kind === 'daemon' && runtime.daemonId) {
            const [host] = await this.db
                .select({ managed: runtimeHosts.managed })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.id, runtime.daemonId),
                        eq(runtimeHosts.userId, runtime.userId)
                    )
                )
                .limit(1)
            if (host?.managed)
                throw new ConflictException({
                    code: 'MANAGED_RUNNER_RUNTIME',
                    message:
                        'managed runner runtimes are transport-only; attach agents to their parent runtime'
                })
        }
        if (runtime.kind === 'k8s') {
            const [current] = await this.db
                .select()
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.id, runtime.id),
                        eq(agentRuntimes.userId, runtime.userId)
                    )
                )
                .limit(1)
            const ownedPending =
                current?.status === 'pending' &&
                current.currentPhase === K8S_CREATE_INITIAL_AGENT &&
                current.primaryAgentId === null &&
                !!input.agentCreateId
            if (
                !current ||
                (input.agentCreateId
                    ? !ownedPending
                    : current.currentPhase === K8S_CREATE_INITIAL_AGENT ||
                      current.currentPhase === K8S_CREATE_CLEANUP_PENDING)
            )
                throw new ConflictException({
                    code: 'CONTAINER_NOT_READY',
                    message: 'container is not ready for another agent'
                })
            runtime = current
        }
        if (!supportsLiveAgents(runtime.framework))
            throw new ConflictException(
                `framework ${runtime.framework} does not support add-agent`
            )
        const isCodingFramework =
            runtime.framework === 'claude-code' ||
            runtime.framework === 'codex' ||
            runtime.framework === 'gemini-cli' ||
            runtime.framework === 'pi'
        const isCodingAgentRuntime =
            runtime.kind === 'sprites' ||
            (runtime.kind === 'k8s' && isCodingFramework) ||
            (runtime.kind === 'daemon' && isCodingFramework)
        if (isCodingAgentRuntime && input.cloneFrom)
            throw new BadRequestException(
                'cloneFrom is not supported on coding-agent runtimes'
            )
        const workspace = normalizeWorkspacePathInput(input.workspace)
        if (runtime.framework === 'hermes' && workspace)
            throw new BadRequestException(
                'workspace is not supported for hermes runtimes'
            )
        const displayName = normalizeAgentName(input.name)
        const agentId = input.agentCreateId ?? createObjectId('agent')
        // A service framework's first agent on a cloud computer is its
        // gateway's built-in profile, the one the service is configured for
        // and every chat session binds to, as on a sandbox; not a profile
        // pushed beside it (ADR-0035).
        const builtInProfile =
            runtime.kind === 'k8s' && runtime.primaryAgentId === null
                ? serviceBuiltInProfile(runtime)
                : null
        if (builtInProfile && (workspace || input.cloneFrom))
            throw new BadRequestException(
                `the first ${runtime.framework} agent on a cloud computer is its gateway's own; a workspace or clone applies to the agents added after it`
            )
        const internalId =
            isCodingAgentRuntime || builtInProfile
                ? agentId
                : frameworkInternalIdForAgentId(agentId)
        const inheritedProviderId =
            runtime.primaryAgentId !== null
                ? ((
                      await this.db
                          .select({ id: agents.modelProviderId })
                          .from(agents)
                          .where(eq(agents.id, runtime.primaryAgentId))
                          .limit(1)
                  )[0]?.id ?? null)
                : null
        await this.credentialsResolver.assertManagedChannelBindable(
            runtime.userId,
            inheritedProviderId,
            null
        )
        const adapter = this.adapterRegistry.get(runtime.framework)
        try {
            await input.assertAgentCreateActive?.()
            const res = builtInProfile
                ? await builtInProfileAgent(
                      adapter,
                      runtime,
                      agentId,
                      builtInProfile
                  )
                : await adapter.addAgent({
                      runtime,
                      primaryAgentId: runtime.primaryAgentId ?? null,
                      agentId,
                      internalId,
                      name: displayName,
                      workspace: workspace ?? undefined,
                      model: input.model,
                      cloneFrom: input.cloneFrom
                  })
            const now = new Date()
            const workspacePath = res.workspace ?? runtime.mountPath
            const newAgent: NewAgent = {
                id: agentId,
                userId: runtime.userId,
                runtimeId: runtime.id,
                framework: runtime.framework,
                runtime: runtime.kind,
                name: displayName,
                internalId: res.internalId,
                status: input.agentCreateId ? 'pending' : 'running',
                model: res.model,
                modelProviderId: inheritedProviderId,
                extras: workspace
                    ? workspaceExtras(false, res.extras)
                    : res.extras,
                workspacePath,
                mountPath: isCodingAgentRuntime
                    ? workspacePath
                    : runtime.mountPath,
                fileRoots: buildFileRoots({
                    framework: runtime.framework,
                    runtime: runtime.kind,
                    mountPath: isCodingAgentRuntime
                        ? workspacePath
                        : runtime.mountPath,
                    homeDir: runtime.homeDir,
                    ...(runtime.kind === 'k8s' && workspace
                        ? { workspaceTransport: 'pod-exec' as const }
                        : {})
                }),
                namespace: runtime.namespace,
                ingressHost: runtime.ingressHost,
                spriteName: runtime.spriteName,
                spriteId: runtime.spriteId,
                clusterId: runtime.clusterId,
                daemonId: runtime.daemonId,
                hostId: runtime.hostId,
                accountId: runtime.accountId,
                startedAt: now,
                lastBootstrappedAt: now,
                lastReconciledAt: now
            }
            let inserted
            try {
                await input.assertAgentCreateActive?.()
                const [insertedRow] = await this.db
                    .insert(agents)
                    .values(newAgent)
                    .returning()
                inserted = insertedRow
            } catch (insertErr) {
                try {
                    await input.assertAgentCreateActive?.()
                    if (isCodingAgentRuntime) {
                        await adapter.removeAgent({
                            runtime,
                            agent: {
                                ...newAgent,
                                createdAt: now,
                                updatedAt: now
                            } as never,
                            primaryAgentId: runtime.primaryAgentId ?? null
                        })
                    }
                } catch (cleanupErr) {
                    this.log.warn(
                        `attach rollback failed runtimeId=${runtime.id} agentId=${agentId}: ${(cleanupErr as Error).message}`
                    )
                }
                throw insertErr
            }
            // Promote to primary if the runtime has no primary yet. Conditional
            // update keeps this race-safe under concurrent first-agent inserts.
            await input.assertAgentCreateActive?.()
            await this.db
                .update(agentRuntimes)
                .set({ primaryAgentId: agentId, updatedAt: new Date() })
                .where(
                    and(
                        eq(agentRuntimes.id, runtime.id),
                        isNull(agentRuntimes.primaryAgentId)
                    )
                )
            this.reconcile.touchAfterWrite(runtime.id)
            // The joiner's own auth choice. Failing here after the insert is
            // reported, not swallowed: an agent that silently kept the
            // inherited credentials is the bug this exists to close.
            if (
                this.modelConfig &&
                (input.modelConfigSource === 'runtime-local' ||
                    input.runtimeAuthProfileId)
            ) {
                await input.assertAgentCreateActive?.()
                let bound = await this.modelConfig.updateForAgent(
                    runtime.userId,
                    inserted.id,
                    { modelConfigSource: 'runtime-local' },
                    true
                )
                if (input.runtimeAuthProfileId) {
                    await input.assertAgentCreateActive?.()
                    bound = await this.modelConfig.applyRuntimeAuth(
                        runtime.userId,
                        inserted.id,
                        {
                            profileId: input.runtimeAuthProfileId,
                            expectedBindingVersion:
                                bound.runtimeAuth.bindingVersion,
                            modelConfigSource: 'runtime-local'
                        }
                    )
                }
                void bound
                inserted =
                    (
                        await this.db
                            .select()
                            .from(agents)
                            .where(eq(agents.id, inserted.id))
                            .limit(1)
                    )[0] ?? inserted
            }
            await input.assertAgentCreateActive?.()
            await this.skills.installDefaults({
                userId: inserted.userId,
                agentId: inserted.id,
                framework: inserted.framework,
                runtime: inserted.runtime
            })
            // A created agent's bootstrap writes its context doc; one added
            // to a sandbox that is already there runs none, so it is written
            // now. A daemon's arrives with its configuration delivery.
            if (inserted.runtime === 'sprites' && isCodingAgentRuntime)
                await this.contextDoc?.refreshOnChange(inserted)
            this.changes?.emit(inserted.userId, { resource: 'agent', resourceId: inserted.id, agentId: inserted.id, reason: 'created' })
            return agentRowToSummary(inserted, null, false, {
                controlUiEnabled: runtime.controlUiEnabled,
                dashboardEnabled: runtime.dashboardEnabled,
                dashboardState: runtime.dashboardState,
                keepAliveEnabled: runtime.keepAliveEnabled
            })
        } catch (err) {
            if (err instanceof NotSupportedError)
                throw new ConflictException(err.message)
            throw err
        }
    }
}
