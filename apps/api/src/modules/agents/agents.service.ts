import {
    AgentSummary,
    DAEMON_MIN_CLI_VERSION,
    UpdateAgentBody,
    agentAvailability,
    agentBaseUrl,
    blockedVersionMessage,
    daemonOnline,
    findBlockedVersionRange,
    frameworkMcpSupport,
    frameworkUpgradeAvailable,
    isCliUpdateAvailable,
    isCliVersionTooOld,
    isModelConfigFramework,
    isKnownMcpScope,
    isVersionedFramework,
    normalizeAgentName,
    parseEnvText,
    placementOf,
    type RuntimeProviderKind
} from '@manyfold/shared'
import { ResourceChangesService } from '@/modules/resource-events/resource-changes.service'
import { workspaceReading } from './host-storage/workspace-reading'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    hostDaemons,
    jsonbMerge,
    jsonbMergeNested,
    runtimeHosts,
    runtimeProviders,
    users,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type HostDaemonRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { DaemonCliVersionService } from '@/modules/daemon/daemon-cli-version.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import { ConnectionsService } from '@/modules/connections/connections.service'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { McpConfigMaterializer } from '@/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { validateMcpText } from '@/modules/agent-runtimes/mcp/mcp-config'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'

// One agent with everything its summary derives from: the runtime it runs
// in, the machine that runtime sits on, the machine's daemon and the
// provider kind (ADR-0037). Read with one join, never copied onto the agent.
export interface AgentSummaryRow {
    agent: Agent
    runtime: AgentRuntimeRow
    host: RuntimeHostRow | null
    daemon: HostDaemonRow | null
    providerKind: RuntimeProviderKind | null
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

// The mf CLI lives on the host machine, not on the agent — but the chat runner
// and the manyfold-cli-usage skill both ride on it, so the agent's own settings
// have to be able to say which version is there.
export interface AgentCliVersionInfo {
    latest: string | null
    updateAvailable: boolean
}

export interface AgentSummaryOptions {
    frameworkVersionInfo?: AgentFrameworkVersionInfo
    cliVersionInfo?: AgentCliVersionInfo
    // The admin-configured CLI floor, checked beside DAEMON_MIN_CLI_VERSION.
    cliMinVersion?: string | null
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

const endpointUrlFor = (host: RuntimeHostRow | null): string | null => {
    const ref = host?.providerRef
    if (!ref || ref.kind !== 'k8s' || !ref.ingressHost) return null
    return agentBaseUrl(ref.ingressHost)
}

export const agentRowToSummary = (
    row: AgentSummaryRow,
    opts: AgentSummaryOptions = {}
): AgentSummary => {
    const { agent, runtime, host, daemon, providerKind } = row
    const online = daemonOnline(daemon)
    const versions = opts.frameworkVersionInfo
    return {
        id: agent.id,
        userId: agent.userId,
        runtimeId: agent.runtimeId,
        hostId: host?.id ?? null,
        hostName: host?.name ?? null,
        hostKind: host?.kind ?? null,
        providerKind,
        powerState: host?.powerState ?? null,
        daemonOnline: host ? online : null,
        daemonNeedsUpgrade:
            !!daemon &&
            (isCliVersionTooOld(daemon.cliVersion, DAEMON_MIN_CLI_VERSION) ||
                (!!opts.cliMinVersion &&
                    isCliVersionTooOld(daemon.cliVersion, opts.cliMinVersion))),
        keepAwake: host?.keepAwake ?? false,
        name: agent.name,
        framework: agent.framework,
        frameworkVersion: versions?.installed ?? null,
        frameworkLatestVersion: versions?.latest ?? null,
        frameworkUpgradeAvailable: versions?.upgradeAvailable ?? false,
        frameworkVersionBlockedReason: versions?.blockedReason ?? null,
        cliVersion: daemon?.cliVersion ?? null,
        cliLatestVersion: opts.cliVersionInfo?.latest ?? null,
        cliUpdateAvailable: opts.cliVersionInfo?.updateAvailable ?? false,
        runtime: placementOf(host ? { kind: host.kind, providerKind } : null),
        status: agent.status,
        availability: agentAvailability({
            agent,
            runtime,
            host,
            daemonOnline: online
        }),
        mountPath: agent.mountPath,
        endpointUrl: endpointUrlFor(host),
        controlUiEnabled: runtime.controlUiEnabled,
        dashboardEnabled: runtime.dashboardEnabled,
        dashboardState: runtime.dashboardState,
        currentPhase: agent.currentPhase,
        failureReason: agent.failureReason,
        internalId: agent.internalId,
        model: agent.model,
        extras: agent.extras,
        workspacePath: agent.workspacePath,
        ...workspaceReading(agent),
        startedAt: agent.startedAt?.toISOString() ?? null,
        lastActiveAt: lastActiveAtFor(agent)?.toISOString() ?? null,
        lastMessageAt: agent.lastMessageAt?.toISOString() ?? null,
        lastBootstrappedAt: agent.lastBootstrappedAt?.toISOString() ?? null,
        lastReconciledAt: agent.lastReconciledAt?.toISOString() ?? null,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString()
    }
}

export const summaryRowOf = (ctx: RuntimeContext & { agent: Agent }): AgentSummaryRow => ({
    agent: ctx.agent,
    runtime: ctx.runtime,
    host: ctx.host,
    daemon: ctx.daemon,
    providerKind: ctx.providerKind
})

const summaryColumns = {
    agent: agents,
    runtime: agentRuntimes,
    host: runtimeHosts,
    daemon: hostDaemons,
    providerKind: runtimeProviders.kind
}

@Injectable()
export class AgentsService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly reconcile: AgentReconcileService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly adapters: AgentAdapterRegistry,
        private readonly frameworkVersions: FrameworkVersionsService,
        private readonly connections: ConnectionsService,
        private readonly contextDoc: AgentContextDocManageService,
        private readonly mcp: McpConfigMaterializer,
        private readonly cliVersion: DaemonCliVersionService,
        @Optional() private readonly adminSettings?: AdminSettingsService,
        @Optional() private readonly changes?: ResourceChangesService
    ) {}

    private async cliMinVersion(): Promise<string | null> {
        if (!this.adminSettings) return null
        try {
            const { minVersion } =
                await this.adminSettings.getCachedCliMinimumVersion()
            return minVersion ?? null
        } catch {
            return null
        }
    }

    private async frameworkVersionInfoFor(
        row: AgentSummaryRow
    ): Promise<AgentFrameworkVersionInfo | undefined> {
        if (!isVersionedFramework(row.agent.framework)) return undefined
        const installed = row.runtime.frameworkVersion
        const [latest, blocked] = await Promise.all([
            this.frameworkVersions.latestFor(row.agent.framework),
            this.frameworkVersions.blockedRangesFor(row.agent.framework)
        ])
        const blockedBy = findBlockedVersionRange(installed, blocked)
        return {
            installed,
            latest,
            upgradeAvailable: frameworkUpgradeAvailable(installed, latest),
            blockedReason: blockedBy
                ? blockedVersionMessage(
                      row.agent.framework,
                      installed ?? '',
                      blockedBy
                  )
                : null
        }
    }

    // Detail-only: the cached release catalog beside the daemon's reported
    // CLI. isCliUpdateAvailable reads "nothing recorded" as "needs the CLI",
    // which is what the host list's install button wants; here it would claim
    // a pending upgrade for a version we never managed to read — so an
    // unknown version is no upgrade, matching frameworkUpgradeAvailable.
    private async cliVersionInfoFor(
        row: AgentSummaryRow
    ): Promise<AgentCliVersionInfo> {
        const installed = row.daemon?.cliVersion ?? null
        const { version: latest, channel } =
            await this.cliVersion.getCachedLatest()
        return {
            latest,
            updateAvailable:
                !!installed && isCliUpdateAvailable(channel, installed, latest)
        }
    }

    private async detailOptions(
        row: AgentSummaryRow
    ): Promise<AgentSummaryOptions> {
        const [frameworkVersionInfo, cliVersionInfo, cliMinVersion] =
            await Promise.all([
                this.frameworkVersionInfoFor(row),
                this.cliVersionInfoFor(row),
                this.cliMinVersion()
            ])
        return { frameworkVersionInfo, cliVersionInfo, cliMinVersion }
    }

    // Pure read: no reconcile, no writes. Freshness comes from lifecycle
    // mutations, runtime reports, chat-wake touches and the leader-gated
    // reconcile sweep — a list request must stay O(1) in DB queries no matter
    // how many runtimes the account has accumulated (#516).
    async listForUser(
        userId: string,
        opts: { boundAgentId?: string } = {}
    ): Promise<AgentSummaryRow[]> {
        const filters = [eq(agents.userId, userId)]
        if (opts.boundAgentId) filters.push(eq(agents.id, opts.boundAgentId))
        return this.db
            .select(summaryColumns)
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .leftJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
            .leftJoin(
                runtimeProviders,
                eq(runtimeProviders.id, runtimeHosts.providerId)
            )
            .where(filters.length === 1 ? filters[0] : and(...filters))
            .orderBy(desc(agents.createdAt), asc(agents.id))
    }

    async listAll(): Promise<AgentSummaryRow[]> {
        return this.db
            .select(summaryColumns)
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .leftJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
            .leftJoin(
                runtimeProviders,
                eq(runtimeProviders.id, runtimeHosts.providerId)
            )
            .orderBy(desc(agents.createdAt), asc(agents.id))
    }

    async summariesFor(rows: AgentSummaryRow[]): Promise<AgentSummary[]> {
        const cliMinVersion = await this.cliMinVersion()
        return rows.map((row) => agentRowToSummary(row, { cliMinVersion }))
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
        const runtime = await this.reconcile.loadRuntime(row.runtimeId)
        if (runtime) this.reconcile.touchRuntime(runtime)
        return row
    }

    // The agent with its machine resolved (ADR-0037); null when it does not
    // exist or the caller may not see it, so callers answer 404 either way.
    async contextForCaller(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<(RuntimeContext & { agent: Agent }) | null> {
        const ctx = await this.runtimeContext.forAgent(agentId)
        if (!ctx?.agent) return null
        if (ctx.agent.userId !== callerUserId && !isAdmin) return null
        return ctx as RuntimeContext & { agent: Agent }
    }

    async summaryFor(agentId: string): Promise<AgentSummary> {
        const ctx = await this.runtimeContext.forAgent(agentId)
        if (!ctx?.agent) throw new NotFoundException(`agent ${agentId} not found`)
        const row = summaryRowOf(ctx as RuntimeContext & { agent: Agent })
        return agentRowToSummary(row, await this.detailOptions(row))
    }

    async get(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const ctx = await this.contextForCaller(agentId, callerUserId, isAdmin)
        if (!ctx) throw new NotFoundException(`agent ${agentId} not found`)
        this.reconcile.touchRuntime(ctx.runtime)
        const row = summaryRowOf(ctx)
        return agentRowToSummary(row, await this.detailOptions(row))
    }

    async update(
        agentId: string,
        callerUserId: string,
        body: UpdateAgentBody,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const ctx = await this.contextForCaller(agentId, callerUserId, isAdmin)
        if (!ctx) throw new NotFoundException(`agent ${agentId} not found`)
        const existing = ctx.agent
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
                    throw new ConflictException({
                        message: `agent "${name}" already exists for this user`,
                        code: 'AGENT_NAME_TAKEN',
                        details: { agentId: duplicate.id }
                    })
            }
            patch.name = name
        }
        if (body.model !== undefined) {
            if (isModelConfigFramework(existing.framework))
                throw new BadRequestException({
                    message: `Use /agents/${agentId}/model-config to update ${existing.framework} models`,
                    code: 'AGENT_MODEL_IN_MODEL_CONFIG',
                    details: { agentId, framework: existing.framework }
                })
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
        // MCP files reach the machine through its daemon; until that delivery
        // lands the stored config is only saved, not live.
        if (
            ctx.placement !== 'external' &&
            ('mcp' in extrasPatch || 'composioConnectionId' in extrasPatch)
        ) {
            extrasPatch.mcpDelivery = Object.fromEntries(
                (frameworkMcpSupport(existing.framework)?.scopes ?? []).map(
                    (scope) => [scope.id, {
                        status: 'failed',
                        message: 'Configuration saved; delivery is pending.',
                        at: new Date().toISOString()
                    }]
                )
            )
            extrasPatch.mcpDeliveryRevision = null
        }
        if (Object.keys(extrasPatch).length > 0) {
            // `mcp` merges per scope: a scope the body leaves out keeps its
            // config, and '' clears one.
            const { mcp, ...rest } = extrasPatch
            extrasMerge =
                mcp === undefined
                    ? jsonbMerge(agents.extras, rest)
                    : jsonbMergeNested(
                          agents.extras,
                          rest,
                          'mcp',
                          mcp as Record<string, string>
                      )
        }
        if (Object.keys(patch).length === 0 && !extrasMerge) {
            const row = summaryRowOf(ctx)
            return agentRowToSummary(row, await this.detailOptions(row))
        }
        if (patch.name !== undefined) {
            const adapter = this.adapters.get(existing.framework)
            if (adapter.updateAgent)
                await adapter.updateAgent({
                    ...ctx,
                    agent: existing,
                    patch: { name: patch.name }
                })
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
        this.changes?.emit(updated.userId, {
            resource: 'agent', resourceId: updated.id, agentId: updated.id, reason: 'updated'
        })
        if (body.model !== undefined)
            this.changes?.emit(updated.userId, {
                resource: 'model-config', resourceId: updated.id, agentId: updated.id, reason: 'updated'
            })
        // Keep AGENTS.manyfold.md timely: a connection link/unlink changes what
        // the agent should know. Best-effort push to the live machine (never
        // blocks the response); the doc otherwise refreshes at next bootstrap.
        if (
            'githubConnectionId' in extrasPatch ||
            'cloudflareConnectionId' in extrasPatch ||
            'composioConnectionId' in extrasPatch
        )
            void this.contextDoc.refreshOnChange(updated)
        // MCP config is written into the machine's per-scope config files; push
        // it best-effort now, else it re-materializes at next bootstrap. Linking
        // or unlinking a Composio connection also changes the managed `composio`
        // server, so re-materialize on that too.
        if ('mcp' in extrasPatch || 'composioConnectionId' in extrasPatch)
            void this.mcp.refreshOnChange(updated)
        const row = summaryRowOf({ ...ctx, agent: updated })
        return agentRowToSummary(row, await this.detailOptions(row))
    }

    async isUserAdmin(userId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        return row?.role === 'admin'
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
