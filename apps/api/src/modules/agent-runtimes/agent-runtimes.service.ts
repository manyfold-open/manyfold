import {
    DAEMON_ONLINE_THRESHOLD_MS as SHARED_DAEMON_ONLINE_THRESHOLD_MS,
    agentBaseUrl
} from '@manyfold/shared'
import type {
    AgentCreateStep,
    AgentRuntimeStatus,
    AgentRuntimeSummary,
    DetectedFramework,
    RuntimeServiceStatus
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import {
    and,
    count,
    desc,
    eq,
    inArray,
    isNull,
    like,
    ne,
    notExists,
    notInArray,
    or,
    sql
} from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    k8sClusters,
    spritesAccounts,
    type AgentRuntimeRow,
    type Database,
    type NewAgentRuntimeRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'

export interface RuntimeStatusPatch {
    status?: AgentRuntimeStatus
    failureReason?: string | null
    spriteId?: string | null
    startedAt?: Date | null
    lastBootstrappedAt?: Date | null
    controlUiEnabled?: boolean
    dashboardEnabled?: boolean
    dashboardState?: string | null
}

// Deliberately separate from RuntimeStatusPatch: report-driven paths write
// through this patch only, so they are structurally unable to touch
// provisioning status/failureReason.
export interface RuntimeServiceReportPatch {
    serviceStatus?: RuntimeServiceStatus
    serviceStatusAt?: Date
}

export interface RuntimeProvisioningPatch {
    accountId?: string | null
    spriteName?: string | null
    clusterId?: string | null
    namespace?: string | null
    ingressHost?: string | null
    mountPath?: string
    homeDir?: string | null
    currentPhase?: AgentCreateStep | null
    // Version the bootstrap actually installed. Recorded at provision time so a
    // fresh agent shows a version immediately instead of "pending" until the
    // first probe or sandbox detect.
    frameworkVersion?: string | null
    frameworkVersionCheckedAt?: Date | null
}

@Injectable()
export class AgentRuntimesService {
    private readonly log = new Logger(AgentRuntimesService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly telemetry: TelemetryService
    ) {}

    async create(row: NewAgentRuntimeRow): Promise<AgentRuntimeRow> {
        const [inserted] = await this.db
            .insert(agentRuntimes)
            .values(row)
            .returning()
        this.telemetry.event('agent.runtime.create', {
            runtimeId: inserted.id,
            userId: inserted.userId,
            framework: inserted.framework,
            kind: inserted.kind,
            name: inserted.name
        })
        return inserted
    }

    async findById(id: string): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, id))
            .limit(1)
        return row ?? null
    }

    async findByIngressHost(
        ingressHost: string
    ): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.ingressHost, ingressHost))
            .limit(1)
        return row ?? null
    }

    async getForUser(
        id: string,
        userId: string,
        isAdmin: boolean
    ): Promise<AgentRuntimeRow> {
        const row = await this.findById(id)
        if (!row || (!isAdmin && row.userId !== userId))
            throw new NotFoundException(`agent runtime ${id} not found`)
        return row
    }

    async listByUser(
        userId: string,
        opts: { boundAgentId?: string } = {}
    ): Promise<AgentRuntimeRow[]> {
        const rows = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.userId, userId),
                    // `mf daemon register` creates one runtime per framework it
                    // detects on the host. For a platform-managed host (a
                    // Phase 3 sprite runner) that is pure noise in the user's
                    // list — N phantom runtimes per sprite that look like
                    // somewhere they could put an agent.
                    notExists(
                        this.db
                            .select({ one: sql`1` })
                            .from(runtimeHosts)
                            .where(
                                and(
                                    eq(
                                        runtimeHosts.id,
                                        agentRuntimes.daemonId
                                    ),
                                    eq(runtimeHosts.managed, true)
                                )
                            )
                    )
                )
            )
        if (!opts.boundAgentId) return rows
        // Bound token: filter to runtimes hosting the bound agent.
        const [boundAgent] = await this.db
            .select({ runtimeId: agents.runtimeId })
            .from(agents)
            .where(
                and(
                    eq(agents.id, opts.boundAgentId),
                    eq(agents.userId, userId)
                )
            )
            .limit(1)
        if (!boundAgent?.runtimeId) return []
        return rows.filter((r) => r.id === boundAgent.runtimeId)
    }

    async setPhase(id: string, phase: AgentCreateStep | null): Promise<void> {
        try {
            await this.db
                .update(agentRuntimes)
                .set({ currentPhase: phase, updatedAt: new Date() })
                .where(eq(agentRuntimes.id, id))
        } catch (err) {
            this.log.warn(
                `setPhase failed runtimeId=${id}: ${(err as Error).message}`
            )
        }
    }

    async applyStatusPatch(
        id: string,
        patch: RuntimeStatusPatch
    ): Promise<void> {
        const next: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.status !== undefined) next.status = patch.status
        if (patch.failureReason !== undefined)
            next.failureReason = patch.failureReason
        if (patch.spriteId !== undefined) next.spriteId = patch.spriteId
        if (patch.startedAt !== undefined) next.startedAt = patch.startedAt
        if (patch.lastBootstrappedAt !== undefined)
            next.lastBootstrappedAt = patch.lastBootstrappedAt
        if (patch.controlUiEnabled !== undefined)
            next.controlUiEnabled = patch.controlUiEnabled
        if (patch.dashboardEnabled !== undefined)
            next.dashboardEnabled = patch.dashboardEnabled
        if (patch.dashboardState !== undefined)
            next.dashboardState = patch.dashboardState
        await this.db
            .update(agentRuntimes)
            .set(next)
            .where(eq(agentRuntimes.id, id))
    }

    // CAS-claim the per-runtime dashboard-toggle mutex: only a runtime in a
    // steady state (NULL) or a failed prior toggle ('error:*') can be claimed.
    // Serializes concurrent toggles without holding a DB session across the
    // minutes-long sprite orchestration.
    async claimDashboardState(id: string, next: string): Promise<boolean> {
        const rows = await this.db
            .update(agentRuntimes)
            .set({ dashboardState: next, updatedAt: new Date() })
            .where(
                and(
                    eq(agentRuntimes.id, id),
                    or(
                        isNull(agentRuntimes.dashboardState),
                        like(agentRuntimes.dashboardState, 'error:%')
                    )
                )
            )
            .returning({ id: agentRuntimes.id })
        return rows.length > 0
    }

    async applyServiceReportPatch(
        id: string,
        patch: RuntimeServiceReportPatch
    ): Promise<void> {
        const next: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.serviceStatus !== undefined)
            next.serviceStatus = patch.serviceStatus
        if (patch.serviceStatusAt !== undefined)
            next.serviceStatusAt = patch.serviceStatusAt
        await this.db
            .update(agentRuntimes)
            .set(next)
            .where(eq(agentRuntimes.id, id))
    }

    async applyProvisioningPatch(
        id: string,
        patch: RuntimeProvisioningPatch
    ): Promise<void> {
        const next: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.accountId !== undefined) next.accountId = patch.accountId
        if (patch.spriteName !== undefined) next.spriteName = patch.spriteName
        if (patch.clusterId !== undefined) next.clusterId = patch.clusterId
        if (patch.namespace !== undefined) next.namespace = patch.namespace
        if (patch.ingressHost !== undefined)
            next.ingressHost = patch.ingressHost
        if (patch.mountPath !== undefined) next.mountPath = patch.mountPath
        if (patch.homeDir !== undefined) next.homeDir = patch.homeDir
        if (patch.currentPhase !== undefined)
            next.currentPhase = patch.currentPhase
        if (patch.frameworkVersion !== undefined)
            next.frameworkVersion = patch.frameworkVersion
        if (patch.frameworkVersionCheckedAt !== undefined)
            next.frameworkVersionCheckedAt = patch.frameworkVersionCheckedAt
        await this.db
            .update(agentRuntimes)
            .set(next)
            .where(eq(agentRuntimes.id, id))
    }

    // Dedicated updater, NOT a RuntimeStatusPatch field — the flag is user
    // intent, not provisioning status.
    async setKeepAliveEnabled(id: string, enabled: boolean): Promise<void> {
        await this.db
            .update(agentRuntimes)
            .set({ keepAliveEnabled: enabled, updatedAt: new Date() })
            .where(eq(agentRuntimes.id, id))
    }

    async delete(id: string): Promise<void> {
        const existing = await this.findById(id)
        await this.db.delete(agentRuntimes).where(eq(agentRuntimes.id, id))
        if (existing) {
            this.telemetry.event('agent.runtime.delete', {
                runtimeId: id,
                userId: existing.userId,
                framework: existing.framework,
                kind: existing.kind,
                lifetimeMs: Date.now() - new Date(existing.createdAt).getTime()
            })
        }
    }

    async rename(
        userId: string,
        id: string,
        name: string
    ): Promise<AgentRuntimeRow> {
        const existing = await this.findById(id)
        if (!existing || existing.userId !== userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        if (existing.name === name) return existing
        const [updated] = await this.db
            .update(agentRuntimes)
            .set({ name, updatedAt: new Date() })
            .where(
                and(eq(agentRuntimes.id, id), eq(agentRuntimes.userId, userId))
            )
            .returning()
        return updated
    }

    async hostHasRuntimes(hostId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ value: count() })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.hostId, hostId))
        return Number(row?.value ?? 0) > 0
    }

    async listRuntimesByHost(hostId: string): Promise<AgentRuntimeRow[]> {
        return this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.hostId, hostId))
    }

    // The live instance of one framework on one sandbox host, if any. `live`
    // excludes failed/stopped to match the partial unique index that guarantees
    // there is at most one, so agent-create can route into it instead of
    // installing a second copy of the framework on the same VM.
    async findSpriteRuntimeOnHost(
        hostId: string,
        framework: AgentRuntimeRow['framework']
    ): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.hostId, hostId),
                    eq(agentRuntimes.kind, 'sprites'),
                    eq(agentRuntimes.framework, framework),
                    notInArray(agentRuntimes.status, ['failed', 'stopped'])
                )
            )
            .limit(1)
        return row ?? null
    }

    // agents.host_id is the denormalized machine FK the sandbox agentsCount
    // subqueries already rely on, so no join through agent_runtimes is needed.
    async listAgentsByHost(
        hostId: string
    ): Promise<Array<{ id: string; runtimeId: string }>> {
        return this.db
            .select({ id: agents.id, runtimeId: agents.runtimeId })
            .from(agents)
            .where(eq(agents.hostId, hostId))
    }

    // Drop a sandbox VM's machine row once its last runtime is gone. Guarded to
    // kind='sandbox' so a daemon host is never removed through this path.
    async deleteSandboxHost(hostId: string): Promise<void> {
        await this.db
            .delete(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
    }

    // Keep a failed sandbox host non-reusable while preserving the row as the
    // retry record for a later remote delete.
    async revokeSandboxHost(hostId: string): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({ status: 'revoked', updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
    }

    // Quarantine a sandbox host whose exec endpoint is failing: automatic
    // co-residence selection skips it until `until` passes. The row survives —
    // the VM may still be reachable for its existing runtimes, and the window
    // expires on its own so a recovered backend needs no operator action.
    async markSandboxHostExecCooldown(
        hostId: string,
        until: Date
    ): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({
                execCooldownUntil: sql<Date>`greatest(${runtimeHosts.execCooldownUntil}, ${until.toISOString()}::timestamptz)`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
    }

    // Record a sandbox host's VM id once createSprite confirms the VM exists.
    // reserveSpriteRuntime gates co-residence reuse on sprite_id IS NOT NULL, so
    // a freshly-reserved host stays unselectable until this runs.
    async setSandboxHostSprite(
        hostId: string,
        spriteId: string | null
    ): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({ spriteId, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
    }

    async findHostById(hostId: string): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        return row ?? null
    }

    async listSandboxesForUser(userId: string): Promise<
        Array<{
            host: RuntimeHostRow
            accountSlug: string | null
            agentsCount: number
        }>
    > {
        const rows = await this.db
            .select({
                host: runtimeHosts,
                accountSlug: spritesAccounts.slug,
                agentsCount: sql<number>`(select count(*) from agents a where a.host_id = ${runtimeHosts.id})::int`
            })
            .from(runtimeHosts)
            .leftJoin(
                spritesAccounts,
                eq(spritesAccounts.id, runtimeHosts.accountId)
            )
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    ne(runtimeHosts.status, 'revoked')
                )
            )
            .orderBy(desc(runtimeHosts.createdAt))
        return rows.map((r) => ({
            host: r.host,
            accountSlug: r.accountSlug ?? null,
            agentsCount: Number(r.agentsCount ?? 0)
        }))
    }

    async listAllSandboxes(): Promise<
        Array<{
            host: RuntimeHostRow
            accountSlug: string | null
            agentsCount: number
        }>
    > {
        const rows = await this.db
            .select({
                host: runtimeHosts,
                accountSlug: spritesAccounts.slug,
                agentsCount: sql<number>`(select count(*) from agents a where a.host_id = ${runtimeHosts.id})::int`
            })
            .from(runtimeHosts)
            .leftJoin(
                spritesAccounts,
                eq(spritesAccounts.id, runtimeHosts.accountId)
            )
            .where(
                and(
                    eq(runtimeHosts.kind, 'sandbox'),
                    ne(runtimeHosts.status, 'revoked')
                )
            )
            .orderBy(desc(runtimeHosts.createdAt))
        return rows.map((r) => ({
            host: r.host,
            accountSlug: r.accountSlug ?? null,
            agentsCount: Number(r.agentsCount ?? 0)
        }))
    }

    async getSandboxById(hostId: string): Promise<{
        host: RuntimeHostRow
        accountSlug: string | null
        agentsCount: number
    } | null> {
        const [r] = await this.db
            .select({
                host: runtimeHosts,
                accountSlug: spritesAccounts.slug,
                agentsCount: sql<number>`(select count(*) from agents a where a.host_id = ${runtimeHosts.id})::int`
            })
            .from(runtimeHosts)
            .leftJoin(
                spritesAccounts,
                eq(spritesAccounts.id, runtimeHosts.accountId)
            )
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    ne(runtimeHosts.status, 'revoked')
                )
            )
            .limit(1)
        if (!r) return null
        return {
            host: r.host,
            accountSlug: r.accountSlug ?? null,
            agentsCount: Number(r.agentsCount ?? 0)
        }
    }

    async getSandboxForUser(
        userId: string,
        hostId: string
    ): Promise<{
        host: RuntimeHostRow
        accountSlug: string | null
        agentsCount: number
    } | null> {
        const [r] = await this.db
            .select({
                host: runtimeHosts,
                accountSlug: spritesAccounts.slug,
                agentsCount: sql<number>`(select count(*) from agents a where a.host_id = ${runtimeHosts.id})::int`
            })
            .from(runtimeHosts)
            .leftJoin(
                spritesAccounts,
                eq(spritesAccounts.id, runtimeHosts.accountId)
            )
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    ne(runtimeHosts.status, 'revoked')
                )
            )
            .limit(1)
        if (!r) return null
        return {
            host: r.host,
            accountSlug: r.accountSlug ?? null,
            agentsCount: Number(r.agentsCount ?? 0)
        }
    }

    async setSandboxTerminalEnabled(
        userId: string,
        hostId: string,
        enabled: boolean
    ): Promise<boolean> {
        const updated = await this.db
            .update(runtimeHosts)
            .set({ terminalEnabled: enabled, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
            .returning({ id: runtimeHosts.id })
        return updated.length > 0
    }

    async setSandboxHostName(
        userId: string,
        hostId: string,
        name: string
    ): Promise<boolean> {
        const updated = await this.db
            .update(runtimeHosts)
            .set({ name, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
            .returning({ id: runtimeHosts.id })
        return updated.length > 0
    }

    async setHostDetectedFrameworks(
        userId: string,
        hostId: string,
        detected: DetectedFramework[]
    ): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({ detectedFrameworks: detected, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
    }

    async setSandboxCliVersion(
        userId: string,
        hostId: string,
        cliVersion: string
    ): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({ cliVersion, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
    }

    // Fold a sandbox detect into provisioned runtimes: the probed CLI version IS
    // the installed version for that framework on the sprite, so back-fill the
    // runtime rows too (fixes "version pending" without a per-agent refresh).
    async applyDetectedVersionsToHostRuntimes(
        hostId: string,
        detected: DetectedFramework[]
    ): Promise<void> {
        const now = new Date()
        for (const d of detected) {
            if (!d.version) continue
            await this.db
                .update(agentRuntimes)
                .set({
                    frameworkVersion: d.version,
                    frameworkVersionCheckedAt: now,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(agentRuntimes.hostId, hostId),
                        eq(agentRuntimes.framework, d.framework)
                    )
                )
        }
    }

    async toSummary(runtime: AgentRuntimeRow): Promise<AgentRuntimeSummary> {
        const [summary] = await this.toSummaries([runtime])
        return summary
    }

    // List serialization used to run toSummary per row, fanning out up to four
    // queries per runtime into the shared pool (#542). Everything a summary
    // needs is resolved here with a bounded number of bulk queries instead.
    async toSummaries(
        runtimes: AgentRuntimeRow[]
    ): Promise<AgentRuntimeSummary[]> {
        if (runtimes.length === 0) return []
        const collectIds = (values: Array<string | null>): string[] => [
            ...new Set(values.filter((v): v is string => v !== null))
        ]
        const accountIds = collectIds(runtimes.map((r) => r.accountId))
        const clusterIds = collectIds(runtimes.map((r) => r.clusterId))
        const daemonIds = collectIds(runtimes.map((r) => r.daemonId))
        const [accountRows, clusterRows, daemonRows, agentCountRows] =
            await Promise.all([
                accountIds.length
                    ? this.db
                          .select({
                              id: spritesAccounts.id,
                              slug: spritesAccounts.slug
                          })
                          .from(spritesAccounts)
                          .where(inArray(spritesAccounts.id, accountIds))
                    : [],
                clusterIds.length
                    ? this.db
                          .select({
                              id: k8sClusters.id,
                              name: k8sClusters.name
                          })
                          .from(k8sClusters)
                          .where(inArray(k8sClusters.id, clusterIds))
                    : [],
                daemonIds.length
                    ? this.db
                          .select({
                              id: runtimeHosts.id,
                              name: runtimeHosts.name,
                              status: runtimeHosts.status,
                              cliVersion: runtimeHosts.cliVersion,
                              rpcLastSeenAt: runtimeHosts.rpcLastSeenAt
                          })
                          .from(runtimeHosts)
                          .where(inArray(runtimeHosts.id, daemonIds))
                    : [],
                this.db
                    .select({ runtimeId: agents.runtimeId, value: count() })
                    .from(agents)
                    .where(
                        inArray(
                            agents.runtimeId,
                            runtimes.map((r) => r.id)
                        )
                    )
                    .groupBy(agents.runtimeId)
            ])
        const slugByAccountId = new Map(accountRows.map((a) => [a.id, a.slug]))
        const nameByClusterId = new Map(clusterRows.map((c) => [c.id, c.name]))
        const daemonById = new Map(daemonRows.map((d) => [d.id, d]))
        const agentsCountByRuntimeId = new Map(
            agentCountRows.map((c) => [c.runtimeId, Number(c.value)])
        )
        return runtimes.map((runtime) => {
            const accountSlug = runtime.accountId
                ? (slugByAccountId.get(runtime.accountId) ?? null)
                : null
            const clusterName = runtime.clusterId
                ? (nameByClusterId.get(runtime.clusterId) ?? null)
                : null
            const daemonHost = runtime.daemonId
                ? (daemonById.get(runtime.daemonId) ?? null)
                : null
            const agentsCount = agentsCountByRuntimeId.get(runtime.id) ?? 0
            const daemonOnline = daemonHost
                ? daemonHost.status === 'active' &&
                  !!daemonHost.rpcLastSeenAt &&
                  Date.now() - daemonHost.rpcLastSeenAt.getTime() <
                      DAEMON_ONLINE_THRESHOLD_MS
                : null
            return {
                id: runtime.id,
                userId: runtime.userId,
                name: runtime.name,
                framework: runtime.framework,
                frameworkVersion: runtime.frameworkVersion,
                kind: runtime.kind,
                status: runtime.status,
                accountSlug,
                clusterId: runtime.clusterId,
                clusterName,
                spriteName: runtime.spriteName,
                spriteId: runtime.spriteId,
                hostId: runtime.hostId,
                mountPath: runtime.mountPath,
                namespace: runtime.namespace,
                ingressHost: runtime.ingressHost,
                endpointUrl: runtime.ingressHost
                    ? agentBaseUrl(runtime.ingressHost)
                    : null,
                controlUiEnabled: runtime.controlUiEnabled,
                dashboardEnabled: runtime.dashboardEnabled,
                dashboardState: runtime.dashboardState,
                keepAliveEnabled: runtime.keepAliveEnabled,
                // Always null since the k8s dashboard host was removed; the
                // field stays because AgentRuntimeSummary is an exported
                // shared type (dropping a field is a contract-surface break).
                // Sprite dashboards are reached via the minted control-ui URL.
                dashboardUrl: null,
                currentPhase: runtime.currentPhase,
                failureReason: runtime.failureReason,
                primaryAgentId: runtime.primaryAgentId,
                startedAt: runtime.startedAt?.toISOString() ?? null,
                lastBootstrappedAt:
                    runtime.lastBootstrappedAt?.toISOString() ?? null,
                createdAt: runtime.createdAt.toISOString(),
                updatedAt: runtime.updatedAt.toISOString(),
                agentsCount,
                daemonId: runtime.daemonId,
                daemonName: daemonHost?.name ?? null,
                daemonOnline,
                daemonCliVersion: daemonHost?.cliVersion ?? null,
                homeDir: runtime.homeDir,
                workspaceBaseDir: runtime.workspaceBaseDir,
                lastSeenAt: runtime.lastSeenAt?.toISOString() ?? null,
                serviceStatus: runtime.serviceStatus,
                serviceStatusAt: runtime.serviceStatusAt?.toISOString() ?? null
            }
        })
    }
}

const DAEMON_ONLINE_THRESHOLD_MS = SHARED_DAEMON_ONLINE_THRESHOLD_MS
