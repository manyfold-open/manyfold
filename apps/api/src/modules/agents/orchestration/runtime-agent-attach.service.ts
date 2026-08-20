import {
    AgentFramework,
    AgentSummary,
    createObjectId,
    normalizeAgentName
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger
} from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    type AgentRuntimeRow,
    type Database,
    type NewAgent
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { NotSupportedError } from '@/modules/agents/adapters/agent-adapter'
import { agentRowToSummary } from '@/modules/agents/agents.service'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { buildFileRoots } from '@/modules/agents/bootstrap/file-roots'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import {
    normalizeWorkspacePathInput,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'

const SUPPORTED_FRAMEWORKS_FOR_LIVE_AGENTS: ReadonlySet<AgentFramework> =
    new Set<AgentFramework>([
        'claude-code',
        'codex',
        'gemini-cli',
        'openclaw',
        'hermes',
        'narranexus'
    ])

const frameworkInternalIdForAgentId = (agentId: string): string =>
    agentId.replace(/_/g, '-')

export interface AttachAgentInput {
    runtime: AgentRuntimeRow
    name: string
    workspace?: string
    model?: string
    cloneFrom?: string
}

@Injectable()
export class RuntimeAgentAttachService {
    private readonly log = new Logger(RuntimeAgentAttachService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly reconcile: AgentReconcileService,
        private readonly credentialsResolver: CredentialsResolverService
    ) {}

    async attach(input: AttachAgentInput): Promise<AgentSummary> {
        const { runtime } = input
        if (!SUPPORTED_FRAMEWORKS_FOR_LIVE_AGENTS.has(runtime.framework))
            throw new ConflictException(
                `framework ${runtime.framework} does not support add-agent`
            )
        const isCodingFramework =
            runtime.framework === 'claude-code' ||
            runtime.framework === 'codex' ||
            runtime.framework === 'gemini-cli'
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
        const agentId = createObjectId('agent')
        const internalId = isCodingAgentRuntime
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
            const res = await adapter.addAgent({
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
                status: 'running',
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
                const [insertedRow] = await this.db
                    .insert(agents)
                    .values(newAgent)
                    .returning()
                inserted = insertedRow
            } catch (insertErr) {
                try {
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
