import type {
    AgentFramework,
    SandboxUsageAgentRow,
    SandboxUsageBreakdown,
    SandboxUsageHost,
    SpriteStatus
} from '@manyfold/shared'
import type { SandboxStorageBreakdown } from '@manyfold/db'
import type { UsagePeriod } from '@/common/usage-period/usage-period'

export interface SandboxUsageHostInput {
    id: string
    name: string
    spriteStatus: SpriteStatus | null
    storageBytes: number | null
    storageMeasuredAt: Date | null
    storageBreakdown: SandboxStorageBreakdown | null
}

export interface SandboxUsageAgentInput {
    id: string
    name: string
    framework: AgentFramework
    hostId: string | null
}

// Agent workspace bytes come from the HOST's breakdown, not from
// agents.storage_bytes: rows written before the host-grain migration still
// hold whole-VM df values there, which would read as absurd workspace sizes.
// A host measured only pre-migration has no breakdown yet — its agents show
// null ("not measured") until the next measurement self-heals it.
export const buildSandboxUsageBreakdown = (
    period: UsagePeriod,
    hosts: SandboxUsageHostInput[],
    hostAgents: SandboxUsageAgentInput[],
    secondsByHost: Map<string, number>
): SandboxUsageBreakdown => {
    const agentsByHost = new Map<string, SandboxUsageAgentInput[]>()
    for (const agent of hostAgents) {
        if (!agent.hostId) continue
        const list = agentsByHost.get(agent.hostId)
        if (list) list.push(agent)
        else agentsByHost.set(agent.hostId, [agent])
    }
    const hostRows: SandboxUsageHost[] = hosts
        .map((host) => {
            const workspaceBytes = new Map(
                (host.storageBreakdown?.workspaces ?? []).map((w) => [
                    w.agentId,
                    w.bytes
                ])
            )
            const agents: SandboxUsageAgentRow[] = (
                agentsByHost.get(host.id) ?? []
            )
                .map((agent) => ({
                    agentId: agent.id,
                    name: agent.name,
                    framework: agent.framework,
                    workspaceBytes: workspaceBytes.get(agent.id) ?? null
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
            return {
                hostId: host.id,
                name: host.name,
                spriteStatus: host.spriteStatus,
                activeSecondsThisPeriod: secondsByHost.get(host.id) ?? 0,
                storageBytes: host.storageBytes,
                storageMeasuredAt:
                    host.storageMeasuredAt?.toISOString() ?? null,
                storageMeasured: host.storageBreakdown !== null,
                homes: (host.storageBreakdown?.homes ?? []).map((h) => ({
                    framework: h.framework as AgentFramework,
                    bytes: h.bytes
                })),
                agents
            }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    const liveHostIds = new Set(hosts.map((h) => h.id))
    const deletedHosts = [...secondsByHost.entries()]
        .filter(([hostId]) => !liveHostIds.has(hostId))
        .map(([hostId, activeSecondsThisPeriod]) => ({
            hostId,
            activeSecondsThisPeriod
        }))
        .sort(
            (a, b) => b.activeSecondsThisPeriod - a.activeSecondsThisPeriod
        )
    return {
        usagePeriod: {
            start: period.start.toISOString(),
            end: period.end.toISOString(),
            source: period.source
        },
        storageBytesTotal: hosts.reduce(
            (acc, host) => acc + (host.storageBytes ?? 0),
            0
        ),
        activeSecondsTotal: [...secondsByHost.values()].reduce(
            (acc, seconds) => acc + seconds,
            0
        ),
        hosts: hostRows,
        deletedHosts
    }
}
