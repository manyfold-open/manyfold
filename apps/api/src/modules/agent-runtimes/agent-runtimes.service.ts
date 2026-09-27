import { daemonOnline, placementOf, runtimeAvailability } from '@manyfold/shared'
import type {
    AgentCreateStep,
    AgentRuntimeStatus,
    AgentRuntimeSummary,
    RuntimeProviderKind,
    RuntimeServiceStatus
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional
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
    or,
    sql
} from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    hostDaemons,
    runtimeHosts,
    runtimeProviders,
    type AgentRuntimeRow,
    type Database,
    type HostDaemonRow,
    type NewAgentRuntimeRow,
    type RuntimeHostRow,
    type RuntimeProvider
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import { HERMES_PORT } from '@/modules/agents/bootstrap/hermes-shared'
import { OPENCLAW_PORT } from '@/modules/agents/bootstrap/openclaw-shared'
import { providerRefLabel } from './host-ref'

export interface RuntimeStatusPatch {
    status?: AgentRuntimeStatus
    failureReason?: string | null
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
    mountPath?: string
    currentPhase?: AgentCreateStep | null
    // Version the bootstrap actually installed. Recorded at provision time so a
    // fresh agent shows a version immediately instead of "pending" until the
    // first probe or sandbox detect.
    frameworkVersion?: string | null
    frameworkVersionCheckedAt?: Date | null
}

// A hosted sprites host as the sandbox surfaces read it: the row, its
// provider's name, whether its daemon has registered / is online, and how many
// agents live on it.
export interface SandboxHostView {
    host: RuntimeHostRow
    provider: Pick<RuntimeProvider, 'id' | 'kind' | 'name'> | null
    daemon: HostDaemonRow | null
    agentsCount: number
}

const servicePortFor = (framework: string): number | null => {
    if (framework === 'hermes') return HERMES_PORT
    if (framework === 'openclaw') return OPENCLAW_PORT
    return null
}

@Injectable()
export class AgentRuntimesService {
    private readonly log = new Logger(AgentRuntimesService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly telemetry: TelemetryService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, no runtime carries a public endpoint URL.
        @Optional() private readonly providers?: SandboxProviderRegistry
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
            hostId: inserted.hostId,
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
            .where(eq(agentRuntimes.userId, userId))
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

    async listAll(): Promise<AgentRuntimeRow[]> {
        return this.db.select().from(agentRuntimes)
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
        if (patch.mountPath !== undefined) next.mountPath = patch.mountPath
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

    async agentsCount(runtimeId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(agents)
            .where(eq(agents.runtimeId, runtimeId))
        return Number(row?.value ?? 0)
    }

    // Removes the row only. Callers refuse first while agents are bound
    // (agents.runtime_id cascades) — the controllers answer 409.
    async delete(id: string): Promise<void> {
        const existing = await this.findById(id)
        await this.db.delete(agentRuntimes).where(eq(agentRuntimes.id, id))
        if (existing) {
            this.telemetry.event('agent.runtime.delete', {
                runtimeId: id,
                userId: existing.userId,
                framework: existing.framework,
                hostId: existing.hostId,
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

    // The one runtime a framework has on a host: (host_id, framework) is
    // unique with no status predicate, so a failed install keeps its slot and
    // a retry reuses the row instead of installing a second copy.
    async findRuntimeOnHost(
        hostId: string,
        framework: AgentRuntimeRow['framework']
    ): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.hostId, hostId),
                    eq(agentRuntimes.framework, framework)
                )
            )
            .limit(1)
        return row ?? null
    }

    async listAgentsByHost(
        hostId: string
    ): Promise<Array<{ id: string; runtimeId: string }>> {
        return this.db
            .select({ id: agents.id, runtimeId: agents.runtimeId })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .where(eq(agentRuntimes.hostId, hostId))
    }

    async countAgentsOnHost(hostId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .where(eq(agentRuntimes.hostId, hostId))
        return Number(row?.value ?? 0)
    }

    // Quarantine a hosted host whose exec endpoint is failing: automatic
    // co-residence selection skips it until `until` passes. The row survives —
    // the machine may still be reachable for its existing runtimes, and the
    // window expires on its own so a recovered backend needs no operator action.
    async markHostExecCooldown(hostId: string, until: Date): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({
                execCooldownUntil: sql<Date>`greatest(${runtimeHosts.execCooldownUntil}, ${until.toISOString()}::timestamptz)`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'hosted')
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

    private sandboxQuery() {
        return this.db
            .select({
                host: runtimeHosts,
                provider: {
                    id: runtimeProviders.id,
                    kind: runtimeProviders.kind,
                    name: runtimeProviders.name
                },
                daemon: hostDaemons,
                agentsCount: sql<number>`(select count(*) from agents a join agent_runtimes r on r.id = a.runtime_id where r.host_id = ${runtimeHosts.id})::int`
            })
            .from(runtimeHosts)
            .innerJoin(
                runtimeProviders,
                eq(runtimeProviders.id, runtimeHosts.providerId)
            )
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
    }

    private static sandboxWhere = () =>
        and(
            eq(runtimeHosts.kind, 'hosted'),
            eq(runtimeProviders.kind, 'sprites'),
            ne(runtimeHosts.status, 'retired')
        )

    private static toSandboxView(r: {
        host: RuntimeHostRow
        provider: Pick<RuntimeProvider, 'id' | 'kind' | 'name'> | null
        daemon: HostDaemonRow | null
        agentsCount: number
    }): SandboxHostView {
        return {
            host: r.host,
            provider: r.provider ?? null,
            daemon: r.daemon ?? null,
            agentsCount: Number(r.agentsCount ?? 0)
        }
    }

    async listSandboxesForUser(userId: string): Promise<SandboxHostView[]> {
        const rows = await this.sandboxQuery()
            .where(
                and(
                    AgentRuntimesService.sandboxWhere(),
                    eq(runtimeHosts.userId, userId)
                )
            )
            .orderBy(desc(runtimeHosts.createdAt))
        return rows.map(AgentRuntimesService.toSandboxView)
    }

    async listAllSandboxes(): Promise<SandboxHostView[]> {
        const rows = await this.sandboxQuery()
            .where(AgentRuntimesService.sandboxWhere())
            .orderBy(desc(runtimeHosts.createdAt))
        return rows.map(AgentRuntimesService.toSandboxView)
    }

    async getSandboxById(hostId: string): Promise<SandboxHostView | null> {
        const [r] = await this.sandboxQuery()
            .where(
                and(
                    AgentRuntimesService.sandboxWhere(),
                    eq(runtimeHosts.id, hostId)
                )
            )
            .limit(1)
        return r ? AgentRuntimesService.toSandboxView(r) : null
    }

    async getSandboxForUser(
        userId: string,
        hostId: string
    ): Promise<SandboxHostView | null> {
        const [r] = await this.sandboxQuery()
            .where(
                and(
                    AgentRuntimesService.sandboxWhere(),
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId)
                )
            )
            .limit(1)
        return r ? AgentRuntimesService.toSandboxView(r) : null
    }

    private async patchHostedHost(
        userId: string,
        hostId: string,
        patch: Partial<RuntimeHostRow>
    ): Promise<boolean> {
        const updated = await this.db
            .update(runtimeHosts)
            .set({ ...patch, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'hosted')
                )
            )
            .returning({ id: runtimeHosts.id })
        return updated.length > 0
    }

    async setSandboxTerminalEnabled(
        userId: string,
        hostId: string,
        enabled: boolean
    ): Promise<boolean> {
        return this.patchHostedHost(userId, hostId, { terminalEnabled: enabled })
    }

    async setSandboxTerminalModelCredentials(
        userId: string,
        hostId: string,
        enabled: boolean
    ): Promise<boolean> {
        return this.patchHostedHost(userId, hostId, {
            terminalModelCredentials: enabled
        })
    }

    async setSandboxHostName(
        userId: string,
        hostId: string,
        name: string
    ): Promise<boolean> {
        return this.patchHostedHost(userId, hostId, { name })
    }

    async setHostKeepAwake(
        userId: string,
        hostId: string,
        keepAwake: boolean
    ): Promise<boolean> {
        return this.patchHostedHost(userId, hostId, { keepAwake })
    }

    // Fold a host daemon's inventory into the runtimes installed on it: the
    // probed CLI version IS the installed version for that framework on the
    // machine, so the runtime rows carry it too (no per-agent refresh needed).
    async applyDetectedVersionsToHostRuntimes(
        hostId: string,
        detected: Array<{ framework: string; version: string | null }>
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

    // One join for the whole list (runtime ⋈ host ⋈ host daemon ⋈ provider)
    // plus one grouped agent count, whatever the list size (#542).
    async toSummaries(
        runtimes: AgentRuntimeRow[]
    ): Promise<AgentRuntimeSummary[]> {
        if (runtimes.length === 0) return []
        const ids = runtimes.map((r) => r.id)
        const [contextRows, agentCountRows] = await Promise.all([
            this.db
                .select({
                    runtimeId: agentRuntimes.id,
                    host: runtimeHosts,
                    daemon: hostDaemons,
                    provider: {
                        id: runtimeProviders.id,
                        kind: runtimeProviders.kind,
                        name: runtimeProviders.name
                    }
                })
                .from(agentRuntimes)
                .leftJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
                .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
                .leftJoin(
                    runtimeProviders,
                    eq(runtimeProviders.id, runtimeHosts.providerId)
                )
                .where(inArray(agentRuntimes.id, ids)),
            this.db
                .select({ runtimeId: agents.runtimeId, value: count() })
                .from(agents)
                .where(inArray(agents.runtimeId, ids))
                .groupBy(agents.runtimeId)
        ])
        const contextByRuntimeId = new Map(
            contextRows.map((c) => [c.runtimeId, c])
        )
        const agentsCountByRuntimeId = new Map(
            agentCountRows.map((c) => [c.runtimeId, Number(c.value)])
        )
        const now = Date.now()
        return runtimes.map((runtime) => {
            const context = contextByRuntimeId.get(runtime.id)
            const host = context?.host ?? null
            const daemon = context?.daemon ?? null
            const provider = context?.provider ?? null
            const providerKind: RuntimeProviderKind | null =
                provider?.kind ?? null
            const online = host ? daemonOnline(daemon, now) : null
            return {
                id: runtime.id,
                userId: runtime.userId,
                name: runtime.name,
                framework: runtime.framework,
                frameworkVersion: runtime.frameworkVersion,
                kind: placementOf(host ? { kind: host.kind, providerKind } : null),
                status: runtime.status,
                availability: runtimeAvailability({
                    runtime,
                    host,
                    daemonOnline: online === true
                }),
                hostId: host?.id ?? null,
                hostName: host?.name ?? null,
                hostKind: host?.kind ?? null,
                hostStatus: host?.status ?? null,
                providerId: provider?.id ?? null,
                providerKind,
                providerName: provider?.name ?? null,
                providerRefLabel: providerRefLabel(host),
                powerState: host?.powerState ?? null,
                daemonOnline: online,
                daemonCliVersion: daemon?.cliVersion ?? null,
                mountPath: runtime.mountPath,
                endpointUrl: this.endpointUrlFor(runtime, host, provider),
                controlUiEnabled: runtime.controlUiEnabled,
                dashboardEnabled: runtime.dashboardEnabled,
                dashboardState: runtime.dashboardState,
                currentPhase: runtime.currentPhase,
                failureReason: runtime.failureReason,
                primaryAgentId: runtime.primaryAgentId,
                lastBootstrappedAt:
                    runtime.lastBootstrappedAt?.toISOString() ?? null,
                createdAt: runtime.createdAt.toISOString(),
                updatedAt: runtime.updatedAt.toISOString(),
                agentsCount: agentsCountByRuntimeId.get(runtime.id) ?? 0,
                serviceStatus: runtime.serviceStatus,
                serviceStatusAt: runtime.serviceStatusAt?.toISOString() ?? null
            }
        })
    }

    // A service framework's public entry, derived by the host's provider
    // adapter from the machine's provider ref; nothing on the runtime row.
    private endpointUrlFor(
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow | null,
        provider: Pick<RuntimeProvider, 'id' | 'kind' | 'name'> | null
    ): string | null {
        const port = servicePortFor(runtime.framework)
        if (!host || !provider || port === null || !this.providers) return null
        try {
            const adapter = this.providers.for(provider.kind)
            return (
                adapter.publicUrl?.({
                    host,
                    provider: provider as RuntimeProvider,
                    framework: runtime.framework,
                    port
                }) ?? null
            )
        } catch {
            return null
        }
    }
}
