import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentAvailability,
    daemonOnline,
    placementOf,
    runtimeAvailability,
    type AgentRuntime,
    type RuntimeAvailability,
    type RuntimeProviderKind
} from '@manyfold/shared'
import {
    agents,
    agentRuntimes,
    hostDaemons,
    runtimeHosts,
    runtimeProviders,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type HostDaemonRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

// Everything a caller used to read off denormalised agent/runtime columns,
// resolved through the one relation that remains: agent → runtime → host →
// host daemon (ADR-0037). One query, and the derived facts computed once.
export interface RuntimeContext {
    agent: Agent | null
    runtime: AgentRuntimeRow
    // null for an external-API runtime
    host: RuntimeHostRow | null
    daemon: HostDaemonRow | null
    providerKind: RuntimeProviderKind | null
    placement: AgentRuntime
    daemonOnline: boolean
    availability: RuntimeAvailability
}

@Injectable()
export class RuntimeContextService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async forRuntime(runtimeId: string): Promise<RuntimeContext | null> {
        const [row] = await this.db
            .select({
                runtime: agentRuntimes,
                host: runtimeHosts,
                daemon: hostDaemons,
                providerKind: runtimeProviders.kind
            })
            .from(agentRuntimes)
            .leftJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
            .leftJoin(
                runtimeProviders,
                eq(runtimeProviders.id, runtimeHosts.providerId)
            )
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        if (!row) return null
        return this.build(null, row.runtime, row.host, row.daemon, row.providerKind)
    }

    async forAgent(agentId: string): Promise<RuntimeContext | null> {
        const [row] = await this.db
            .select({
                agent: agents,
                runtime: agentRuntimes,
                host: runtimeHosts,
                daemon: hostDaemons,
                providerKind: runtimeProviders.kind
            })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .leftJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
            .leftJoin(
                runtimeProviders,
                eq(runtimeProviders.id, runtimeHosts.providerId)
            )
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!row) return null
        return this.build(row.agent, row.runtime, row.host, row.daemon, row.providerKind)
    }

    build(
        agent: Agent | null,
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow | null,
        daemon: HostDaemonRow | null,
        providerKind: RuntimeProviderKind | null
    ): RuntimeContext {
        const online = daemonOnline(daemon)
        const availability = agent
            ? agentAvailability({ agent, runtime, host, daemonOnline: online })
            : runtimeAvailability({ runtime, host, daemonOnline: online })
        return {
            agent,
            runtime,
            host,
            daemon,
            providerKind,
            placement: placementOf(host ? { kind: host.kind, providerKind } : null),
            daemonOnline: online,
            availability
        }
    }
}
