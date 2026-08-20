import {
    AgentStopResponse,
    AgentSummary,
    UpdateAgentBody,
    agentBaseUrl,
    auditAction,
    blockedVersionMessage,
    findBlockedVersionRange,
    frameworkMcpSupport,
    frameworkUpgradeAvailable,
    isCliUpdateAvailable,
    isConfigurableFramework,
    isKnownMcpScope,
    isVersionedFramework,
    normalizeAgentName,
    parseEnvText
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    auditLogs,
    jsonbMerge,
    k8sClusters,
    runtimeHosts,
    users,
    type Agent,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { SpritesSessionRegistry } from '@/modules/agents/sprite-sessions/sprite-sessions.registry'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { DaemonCliVersionService } from '@/modules/daemon/daemon-cli-version.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import { ConnectionsService } from '@/modules/connections/connections.service'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { McpConfigMaterializer } from '@/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { validateMcpText } from '@/modules/agent-runtimes/mcp/mcp-config'

export const SPRITES_AUTO_SLEEP_SEC = 35

export interface AgentDashboardFlags {
    controlUiEnabled: boolean
    dashboardEnabled: boolean
    dashboardState: string | null
    keepAliveEnabled: boolean
}

const DEFAULT_DASHBOARD_FLAGS: AgentDashboardFlags = {
    controlUiEnabled: false,
    dashboardEnabled: false,
    dashboardState: null,
    keepAliveEnabled: false
}

export interface AgentFrameworkVersionInfo {
    installed: string | null
    latest: string | null
    upgradeAvailable: boolean
    // why the installed CLI is refused, null when it is fine. Distinct from
    // upgradeAvailable: a blocked runtime may be NEWER than the safe latest
    // (#594 pushed users to 0.53.1 while the newest good release was 0.52.0),
    // so "upgrade available" is false there and nothing would flag it.
    blockedReason: string | null
}

const DEFAULT_FRAMEWORK_VERSION_INFO: AgentFrameworkVersionInfo = {
    installed: null,
    latest: null,
    upgradeAvailable: false,
    blockedReason: null
}

// The mf CLI lives on the host machine, not on the agent — but the chat runner
// and the manyfold-cli-usage skill both ride on it, so the agent's own settings
// have to be able to say which version is there.
export interface AgentCliVersionInfo {
    installed: string | null
    latest: string | null
    updateAvailable: boolean
}

const DEFAULT_CLI_VERSION_INFO: AgentCliVersionInfo = {
    installed: null,
    latest: null,
    updateAvailable: false
}

export interface AgentWithCluster {
    agent: Agent
    clusterName: string | null
    dashboardFlags: AgentDashboardFlags
}

const lastActiveAtFor = (row: Agent): Date | null => {
    const candidates = [
        row.startedAt,
        row.lastBootstrappedAt,
        row.lastReconciledAt
    ].filter((d): d is Date => d !== null && d !== undefined)
    if (candidates.length === 0) return null
    return candidates.reduce((acc, d) => (d > acc ? d : acc), candidates[0])
}

export const agentRowToSummary = (
    row: Agent,
    clusterName: string | null = null,
    daemonNeedsUpgrade = false,
    dashboardFlags: AgentDashboardFlags = DEFAULT_DASHBOARD_FLAGS,
    frameworkVersionInfo: AgentFrameworkVersionInfo = DEFAULT_FRAMEWORK_VERSION_INFO,
    cliVersionInfo: AgentCliVersionInfo = DEFAULT_CLI_VERSION_INFO
): AgentSummary => ({
    id: row.id,
    userId: row.userId,
    runtimeId: row.runtimeId,
    daemonId: row.daemonId ?? null,
    daemonNeedsUpgrade,
    name: row.name,
    framework: row.framework,
    frameworkVersion: frameworkVersionInfo.installed,
    frameworkLatestVersion: frameworkVersionInfo.latest,
    frameworkUpgradeAvailable: frameworkVersionInfo.upgradeAvailable,
    frameworkVersionBlockedReason: frameworkVersionInfo.blockedReason,
    cliVersion: cliVersionInfo.installed,
    cliLatestVersion: cliVersionInfo.latest,
    cliUpdateAvailable: cliVersionInfo.updateAvailable,
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
    endpointUrl:
        row.runtime === 'k8s' && row.ingressHost
            ? agentBaseUrl(row.ingressHost)
            : null,
    controlUiEnabled: dashboardFlags.controlUiEnabled,
    dashboardEnabled: dashboardFlags.dashboardEnabled,
    dashboardState: dashboardFlags.dashboardState,
    keepAliveEnabled: dashboardFlags.keepAliveEnabled,
    currentPhase: row.currentPhase,
    failureReason: row.failureReason,
    internalId: row.internalId,
    model: row.model,
    extras: row.extras,
    workspacePath: row.workspacePath,
    storageBytes: row.storageBytes ?? null,
    storageMeasuredAt: row.storageMeasuredAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    lastActiveAt: lastActiveAtFor(row)?.toISOString() ?? null,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastBootstrappedAt: row.lastBootstrappedAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class AgentsService {
    private readonly log = new Logger(AgentsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly reconcile: AgentReconcileService,
        private readonly sessionRegistry: SpritesSessionRegistry,
        private readonly daemonHosts: DaemonHostService,
        private readonly keepAliveLease: SpriteKeepAliveLeaseService,
        private readonly runtimes: AgentRuntimesService,
        private readonly adapters: AgentAdapterRegistry,
        private readonly frameworkVersions: FrameworkVersionsService,
        private readonly connections: ConnectionsService,
        private readonly contextDoc: AgentContextDocManageService,
        private readonly mcp: McpConfigMaterializer,
        private readonly cliVersion: DaemonCliVersionService
    ) {}

    private async daemonNeedsUpgradeFor(row: Agent): Promise<boolean> {
        if (!row.daemonId) return false
        const map = await this.daemonHosts.resolveNeedsUpgradeMap([
            row.daemonId
        ])
        return map.get(row.daemonId) ?? false
    }

    private async frameworkVersionInfoFor(
        row: Agent
    ): Promise<AgentFrameworkVersionInfo> {
        if (!isVersionedFramework(row.framework) || !row.runtimeId)
            return DEFAULT_FRAMEWORK_VERSION_INFO
        const [installed, latest, blocked] = await Promise.all([
            this.loadRuntimeFrameworkVersion(row.runtimeId),
            this.frameworkVersions.latestFor(row.framework),
            this.frameworkVersions.blockedRangesFor(row.framework)
        ])
        const blockedBy = findBlockedVersionRange(installed, blocked)
        return {
            installed,
            latest,
            upgradeAvailable: frameworkUpgradeAvailable(installed, latest),
            blockedReason: blockedBy
                ? blockedVersionMessage(
                      row.framework,
                      installed ?? '',
                      blockedBy
                  )
                : null
        }
    }

    // Same detail-only budget as the framework version above: one join to the
    // machine this agent's runtime sits on (sandbox VM or daemon host, both
    // rows in runtime_hosts) plus the cached release catalog. A runtime with no
    // host row reads as "not detected" rather than dropping the lookup.
    private async cliVersionInfoFor(row: Agent): Promise<AgentCliVersionInfo> {
        if (!row.runtimeId) return DEFAULT_CLI_VERSION_INFO
        const [host] = await this.db
            .select({ cliVersion: runtimeHosts.cliVersion })
            .from(agentRuntimes)
            // A sandbox runtime carries hostId; a daemon runtime is created with
            // only daemonId (daemon-runtime-sync), and its hostId was a one-time
            // 0094 backfill — so anything registered since then would miss the
            // host entirely on hostId alone. Both columns point at runtime_hosts.
            .leftJoin(
                runtimeHosts,
                eq(
                    runtimeHosts.id,
                    sql`coalesce(${agentRuntimes.hostId}, ${agentRuntimes.daemonId})`
                )
            )
            .where(eq(agentRuntimes.id, row.runtimeId))
            .limit(1)
        const installed = host?.cliVersion ?? null
        const { version: latest, channel } =
            await this.cliVersion.getCachedLatest()
        return {
            installed,
            latest,
            // isCliUpdateAvailable reads "nothing recorded" as "needs the CLI",
            // which is what the host list's install button wants. Here it would
            // claim a pending upgrade for a version we never managed to read —
            // so an unknown version is no upgrade, matching
            // frameworkUpgradeAvailable.
            updateAvailable:
                !!installed && isCliUpdateAvailable(channel, installed, latest)
        }
    }

    private async loadRuntimeFrameworkVersion(
        runtimeId: string
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ frameworkVersion: agentRuntimes.frameworkVersion })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        return row?.frameworkVersion ?? null
    }

    // Pure read: no reconcile, no writes. Freshness comes from lifecycle
    // mutations, runtime reports, chat-wake touches and the leader-gated
    // reconcile sweep — a list request must stay O(1) in DB queries no matter
    // how many runtimes the account has accumulated (#516).
    async listForUser(
        userId: string,
        opts: { boundAgentId?: string } = {}
    ): Promise<AgentWithCluster[]> {
        const filters = [eq(agents.userId, userId)]
        if (opts.boundAgentId) filters.push(eq(agents.id, opts.boundAgentId))
        const rows = await this.db
            .select({
                agent: agents,
                clusterName: k8sClusters.name,
                controlUiEnabled: agentRuntimes.controlUiEnabled,
                dashboardEnabled: agentRuntimes.dashboardEnabled,
                dashboardState: agentRuntimes.dashboardState,
                keepAliveEnabled: agentRuntimes.keepAliveEnabled
            })
            .from(agents)
            .leftJoin(k8sClusters, eq(agents.clusterId, k8sClusters.id))
            .leftJoin(agentRuntimes, eq(agents.runtimeId, agentRuntimes.id))
            .where(filters.length === 1 ? filters[0] : and(...filters))
            .orderBy(desc(agents.createdAt), asc(agents.id))
        return rows.map((row) => ({
            agent: row.agent,
            clusterName: row.clusterName,
            dashboardFlags: {
                controlUiEnabled: row.controlUiEnabled ?? false,
                dashboardEnabled: row.dashboardEnabled ?? false,
                dashboardState: row.dashboardState ?? null,
                keepAliveEnabled: row.keepAliveEnabled ?? false
            }
        }))
    }

    async listAll(): Promise<AgentWithCluster[]> {
        const rows = await this.db
            .select({
                agent: agents,
                clusterName: k8sClusters.name,
                controlUiEnabled: agentRuntimes.controlUiEnabled,
                dashboardEnabled: agentRuntimes.dashboardEnabled,
                dashboardState: agentRuntimes.dashboardState,
                keepAliveEnabled: agentRuntimes.keepAliveEnabled
            })
            .from(agents)
            .leftJoin(k8sClusters, eq(agents.clusterId, k8sClusters.id))
            .leftJoin(agentRuntimes, eq(agents.runtimeId, agentRuntimes.id))
            .orderBy(desc(agents.createdAt), asc(agents.id))
        return rows.map((row) => ({
            agent: row.agent,
            clusterName: row.clusterName,
            dashboardFlags: {
                controlUiEnabled: row.controlUiEnabled ?? false,
                dashboardEnabled: row.dashboardEnabled ?? false,
                dashboardState: row.dashboardState ?? null,
                keepAliveEnabled: row.keepAliveEnabled ?? false
            }
        }))
    }

    async findForCaller(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<Agent | null> {
        const [row] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!row) return null
        if (row.userId !== callerUserId && !isAdmin) return null
        if (row.runtimeId) {
            const runtime = await this.reconcile.loadRuntime(row.runtimeId)
            if (runtime) this.reconcile.touchRuntime(runtime)
        }
        return row
    }

    async get(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const agent = await this.findForCaller(agentId, callerUserId, isAdmin)
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        const clusterName = await this.loadClusterName(agent.clusterId)
        const needsUpgrade = await this.daemonNeedsUpgradeFor(agent)
        const dashboardFlags = await this.loadDashboardFlags(agent.runtimeId)
        const versionInfo = await this.frameworkVersionInfoFor(agent)
        const cliInfo = await this.cliVersionInfoFor(agent)
        return agentRowToSummary(
            agent,
            clusterName,
            needsUpgrade,
            dashboardFlags,
            versionInfo,
            cliInfo
        )
    }

    async update(
        agentId: string,
        callerUserId: string,
        body: UpdateAgentBody,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const existing = await this.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!existing) throw new NotFoundException(`agent ${agentId} not found`)
        const patch: Partial<Agent> = {}
        let extrasMerge: ReturnType<typeof jsonbMerge> | undefined
        if (typeof body.name === 'string') {
            const name = normalizeAgentName(body.name)
            if (name !== existing.name) {
                const [duplicate] = await this.db
                    .select({ id: agents.id })
                    .from(agents)
                    .where(
                        and(
                            eq(agents.userId, existing.userId),
                            eq(agents.name, name),
                            ne(agents.id, agentId)
                        )
                    )
                    .limit(1)
                if (duplicate)
                    throw new ConflictException(
                        `agent "${name}" already exists for this user`
                    )
            }
            patch.name = name
        }
        if (body.model !== undefined) {
            if (isConfigurableFramework(existing.framework))
                throw new BadRequestException(
                    `Use /agents/${agentId}/model-config to update ${existing.framework} models`
                )
            const model =
                typeof body.model === 'string' ? body.model.trim() : ''
            patch.model = model.length > 0 ? model : null
        }
        const extrasPatch: Record<string, unknown> = {}
        if (body.envText !== undefined) {
            const { errors } = parseEnvText(body.envText)
            if (errors.length > 0) {
                const first = errors[0]
                throw new BadRequestException(
                    `invalid environment variables (line ${first.line}: ${first.reason})`
                )
            }
            extrasPatch.envText = body.envText
        }
        if (body.githubConnectionId !== undefined) {
            if (body.githubConnectionId)
                await this.connections.assertOwned(
                    existing.userId,
                    body.githubConnectionId,
                    'github'
                )
            extrasPatch.githubConnectionId = body.githubConnectionId
        }
        if (body.cloudflareConnectionId !== undefined) {
            if (body.cloudflareConnectionId)
                await this.connections.assertOwned(
                    existing.userId,
                    body.cloudflareConnectionId,
                    'cloudflare'
                )
            extrasPatch.cloudflareConnectionId = body.cloudflareConnectionId
        }
        if (body.composioConnectionId !== undefined) {
            if (body.composioConnectionId)
                await this.connections.assertOwned(
                    existing.userId,
                    body.composioConnectionId,
                    'composio'
                )
            extrasPatch.composioConnectionId = body.composioConnectionId
        }
        if (body.mcp !== undefined) {
            const support = frameworkMcpSupport(existing.framework)
            if (!support)
                throw new BadRequestException(
                    `${existing.framework} agents do not support MCP servers`
                )
            for (const [scopeId, text] of Object.entries(body.mcp)) {
                if (!isKnownMcpScope(existing.framework, scopeId))
                    throw new BadRequestException(
                        `unknown MCP scope "${scopeId}" for ${existing.framework}`
                    )
                if (typeof text !== 'string')
                    throw new BadRequestException(
                        `MCP config for scope "${scopeId}" must be a string`
                    )
                if (text.length > 65_536)
                    throw new BadRequestException(
                        `MCP config for scope "${scopeId}" is too large`
                    )
                const trimmed = text.trim()
                if (trimmed.length > 0) {
                    const reason = validateMcpText(support.format, trimmed)
                    if (reason)
                        throw new BadRequestException(
                            `invalid MCP config for scope "${scopeId}": ${reason}`
                        )
                }
            }
            extrasPatch.mcp = body.mcp
        }
        if (Object.keys(extrasPatch).length > 0)
            extrasMerge = jsonbMerge(agents.extras, extrasPatch)
        if (Object.keys(patch).length === 0 && !extrasMerge) {
            const clusterName = await this.loadClusterName(existing.clusterId)
            const needsUpgrade = await this.daemonNeedsUpgradeFor(existing)
            const dashboardFlags = await this.loadDashboardFlags(
                existing.runtimeId
            )
            const versionInfo = await this.frameworkVersionInfoFor(existing)
            const cliInfo = await this.cliVersionInfoFor(existing)
            return agentRowToSummary(
                existing,
                clusterName,
                needsUpgrade,
                dashboardFlags,
                versionInfo,
                cliInfo
            )
        }
        if (patch.name !== undefined && existing.runtimeId) {
            const adapter = this.adapters.get(existing.framework)
            if (adapter.updateAgent) {
                const [runtime] = await this.db
                    .select()
                    .from(agentRuntimes)
                    .where(eq(agentRuntimes.id, existing.runtimeId))
                    .limit(1)
                if (runtime)
                    await adapter.updateAgent({
                        runtime,
                        agent: existing,
                        patch: { name: patch.name }
                    })
            }
        }
        const [updated] = await this.db
            .update(agents)
            .set({
                ...patch,
                ...(extrasMerge ? { extras: extrasMerge } : {}),
                updatedAt: new Date()
            })
            .where(eq(agents.id, agentId))
            .returning()
        // Keep AGENTS.manyfold.md timely: a connection link/unlink changes what
        // the agent should know. Best-effort push to the live sprite (never
        // blocks the response); the doc otherwise refreshes at next bootstrap.
        if (
            'githubConnectionId' in extrasPatch ||
            'cloudflareConnectionId' in extrasPatch ||
            'composioConnectionId' in extrasPatch
        )
            void this.contextDoc.refreshOnChange(updated)
        // MCP config is written into the sprite's per-scope config files; push it
        // best-effort now, else it re-materializes at next bootstrap. Linking or
        // unlinking a Composio connection also changes the managed `composio`
        // server, so re-materialize on that too.
        if ('mcp' in extrasPatch || 'composioConnectionId' in extrasPatch)
            void this.mcp.refreshOnChange(updated)
        const clusterName = await this.loadClusterName(updated.clusterId)
        const needsUpgrade = await this.daemonNeedsUpgradeFor(updated)
        const dashboardFlags = await this.loadDashboardFlags(updated.runtimeId)
        const versionInfo = await this.frameworkVersionInfoFor(updated)
        const cliInfo = await this.cliVersionInfoFor(updated)
        return agentRowToSummary(
            updated,
            clusterName,
            needsUpgrade,
            dashboardFlags,
            versionInfo,
            cliInfo
        )
    }

    private async loadClusterName(
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

    private async loadDashboardFlags(
        runtimeId: string | null
    ): Promise<AgentDashboardFlags> {
        if (!runtimeId) return DEFAULT_DASHBOARD_FLAGS
        const [row] = await this.db
            .select({
                controlUiEnabled: agentRuntimes.controlUiEnabled,
                dashboardEnabled: agentRuntimes.dashboardEnabled,
                dashboardState: agentRuntimes.dashboardState,
                keepAliveEnabled: agentRuntimes.keepAliveEnabled
            })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        if (!row) return DEFAULT_DASHBOARD_FLAGS
        return {
            controlUiEnabled: row.controlUiEnabled,
            dashboardEnabled: row.dashboardEnabled,
            dashboardState: row.dashboardState,
            keepAliveEnabled: row.keepAliveEnabled
        }
    }

    async isUserAdmin(userId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        return row?.role === 'admin'
    }

    async stopSprite(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentStopResponse> {
        const agent = await this.findForCaller(agentId, callerUserId, isAdmin)
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        if (agent.runtime !== 'sprites')
            throw new BadRequestException(
                `agent ${agentId} is not a sandbox runtime`
            )

        if (agent.spriteStatus !== 'running') {
            return {
                status: 'noop',
                estimatedReadyInSec: 0,
                closedSessions: 0
            }
        }

        const closedSessions = this.sessionRegistry.closeForAgent(
            agent.id,
            'user-stop'
        )

        // Clear the keep-alive flag first — explicit stop beats the standing
        // preference, so the reconcile loop can never resurrect a user-stopped
        // sprite — then release. For service-kind frameworks stopAndRelease
        // stops the sprite Service so the keep-alive task releases and the
        // sprite can suspend; for exec-kind (claude/codex/gemini) it is a
        // lease-only release (no service to stop), and a no-op when no lease
        // was ever held.
        let keepAliveRelease: AgentStopResponse['keepAliveRelease'] | undefined
        if (agent.runtimeId) {
            const runtime = await this.runtimes.findById(agent.runtimeId)
            if (runtime) {
                if (runtime.keepAliveEnabled)
                    await this.runtimes.setKeepAliveEnabled(runtime.id, false)
                keepAliveRelease = await this.keepAliveLease.stopAndRelease(
                    runtime,
                    'user-stop'
                )
            }
        }

        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: callerUserId,
                action: auditAction.AGENT_SANDBOX_STOP,
                subject: agent.id,
                meta: {
                    closedSessions,
                    spriteName: agent.spriteName,
                    onBehalfOf:
                        isAdmin && agent.userId !== callerUserId
                            ? agent.userId
                            : null
                }
            })
        } catch (err) {
            this.log.warn(
                `audit write failed for agent.sandbox.stop agent=${agent.id}: ${(err as Error).message}`
            )
        }

        const estimatedReadyInSec =
            keepAliveRelease && keepAliveRelease.state !== 'not_applicable'
                ? keepAliveRelease.maxStaleSec
                : SPRITES_AUTO_SLEEP_SEC

        return {
            status: 'pending',
            estimatedReadyInSec,
            closedSessions,
            keepAliveRelease
        }
    }

    async userExists(userId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        return !!row
    }
}
