import type {
    AgentFramework,
    SandboxUsageAgentRow,
    SandboxUsageBreakdown,
    SandboxUsageHost,
    SpriteStatus
} from '@manyfold/shared'
import type { SandboxStorageBreakdown } from '@manyfold/db'
import type { UsagePeriod } from '@/common/usage-period/usage-period'
import { workspaceReading } from '@/modules/agents/sprite-storage/workspace-reading'

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

export interface SandboxUsageRuntimeInput {
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
    secondsByHost: Map<string, number>,
    options: {
        scope?: 'account' | 'sandbox'
        asOf?: Date
        runtimes?: SandboxUsageRuntimeInput[]
    } = {}
): SandboxUsageBreakdown => {
    const asOf = options.asOf ?? new Date()
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
                    attributedBytes:
                        host.storageBreakdown?.workspaces.find(
                            (workspace) => workspace.agentId === agent.id
                        )?.attributedBytes ?? null,
                    ...workspaceReading({
                        storageMeasuredAt: host.storageMeasuredAt,
                        storageBreakdown:
                            workspaceBytes.has(agent.id) &&
                            host.storageBreakdown
                                ? {
                                      formatVersion:
                                          host.storageBreakdown.formatVersion,
                                      measuredVia:
                                          host.storageBreakdown.measuredVia,
                                      workspaceBytes: workspaceBytes.get(
                                          agent.id
                                      )!
                                  }
                                : null
                    })
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
            const asleep =
                host.spriteStatus === 'cold' || host.spriteStatus === 'warm'
            const measured =
                host.storageBreakdown !== null &&
                host.storageBreakdown.measuredVia !== 'stale' &&
                host.storageMeasuredAt !== null &&
                host.storageBytes !== null
            return {
                hostId: host.id,
                name: host.name,
                spriteStatus: host.spriteStatus,
                activeSecondsThisPeriod: secondsByHost.get(host.id) ?? 0,
                storageBytes: host.storageBytes,
                storageMeasuredAt:
                    host.storageMeasuredAt?.toISOString() ?? null,
                storageMeasured: host.storageBreakdown !== null,
                storageMeasuredVia:
                    host.storageBreakdown?.measuredVia === 'df' ||
                    host.storageBreakdown?.measuredVia === 'du'
                        ? host.storageBreakdown.measuredVia
                        : null,
                storageFreshness: !measured
                    ? ('unknown' as const)
                    : asleep ||
                        asOf.getTime() - host.storageMeasuredAt!.getTime() >=
                            5 * 60 * 1000
                      ? ('stale' as const)
                      : ('fresh' as const),
                asleep,
                attributionComplete:
                    host.storageBreakdown?.attributionComplete === true,
                homes: (host.storageBreakdown?.homes ?? []).map((h) => ({
                    framework: h.framework as AgentFramework,
                    path: h.path ?? null,
                    agentIds: h.agentIds ?? [],
                    measuredBytes:
                        h.bytes > 0 ||
                        host.storageBreakdown?.formatVersion === 1
                            ? h.bytes
                            : null,
                    bytes: h.attributedBytes ?? null
                })),
                agents,
                runtimes: (options.runtimes ?? [])
                    .filter((runtime) => runtime.hostId === host.id)
                    .map((runtime) => ({
                        runtimeId: runtime.id,
                        name: runtime.name,
                        framework: runtime.framework
                    }))
            }
        })
        .sort(
            (a, b) =>
                (b.storageBytes ?? -1) - (a.storageBytes ?? -1) ||
                a.name.localeCompare(b.name) ||
                a.hostId.localeCompare(b.hostId)
        )
    const liveHostIds = new Set(hosts.map((h) => h.id))
    const deletedHosts = [...secondsByHost.entries()]
        .filter(([hostId]) => !liveHostIds.has(hostId))
        .map(([hostId, activeSecondsThisPeriod]) => ({
            hostId,
            activeSecondsThisPeriod
        }))
        .sort((a, b) => b.activeSecondsThisPeriod - a.activeSecondsThisPeriod)
    const unmeasuredHosts = hostRows.filter(
        (host) => host.storageFreshness === 'unknown'
    ).length
    const staleHosts = hostRows.filter(
        (host) => host.storageFreshness === 'stale'
    ).length
    const measuredTimes = hostRows
        .flatMap((host) =>
            host.storageMeasuredAt && host.storageFreshness !== 'unknown'
                ? [host.storageMeasuredAt]
                : []
        )
        .sort()
    return {
        scope: options.scope ?? 'account',
        attributionScope: options.scope === 'sandbox' ? 'agent' : 'account',
        unit: 'bytes',
        attributionUnit: 'apparent-bytes',
        asOf: asOf.toISOString(),
        storageFreshness: {
            state: unmeasuredHosts
                ? unmeasuredHosts === hostRows.length
                    ? 'unknown'
                    : 'partial'
                : staleHosts
                  ? 'stale'
                  : 'fresh',
            oldestMeasuredAt: measuredTimes[0] ?? null,
            staleHosts,
            unmeasuredHosts
        },
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
