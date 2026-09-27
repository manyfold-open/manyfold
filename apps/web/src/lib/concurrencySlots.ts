import type { SandboxSummary } from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'

export interface ActiveSandbox {
    key: string
    hostId: string
    name: string
    agents: SdkAgent[]
    releasing: boolean
    keepAwake: boolean
    activeSecondsThisPeriod: number | null
}

// Mirrors the API's activeSandboxUsageFor: one slot per running sandbox host —
// co-resident agents share one slot and a bare sandbox (terminal only, no
// agents) still occupies one. Agents carry SSE-fresh powerState, so they are
// authoritative for any host they sit on; the polled sandbox rows only
// contribute hosts no agent claims.
export const groupActiveSandboxes = (
    agents: SdkAgent[],
    sandboxes: SandboxSummary[],
    releasingIds: ReadonlySet<string>
): ActiveSandbox[] => {
    const byHost = new Map<string, SdkAgent[]>()
    for (const agent of agents) {
        if (
            agent.runtime !== 'sprites' ||
            agent.powerState !== 'running' ||
            !agent.hostId
        )
            continue
        const group = byHost.get(agent.hostId) ?? []
        group.push(agent)
        byHost.set(agent.hostId, group)
    }

    const rowByHostId = new Map<string, SandboxSummary>()
    for (const sandbox of sandboxes) rowByHostId.set(sandbox.id, sandbox)
    const agentHostIds = new Set<string>()
    for (const agent of agents)
        if (agent.hostId) agentHostIds.add(agent.hostId)

    const slots: ActiveSandbox[] = []
    for (const [hostId, group] of byHost) {
        const row = rowByHostId.get(hostId)
        slots.push({
            key: hostId,
            hostId,
            name: row?.name ?? group[0].hostName ?? group[0].name,
            agents: group,
            // A sandbox only counts as releasing once every agent holding it
            // is stopping — one still-running agent keeps the slot occupied.
            releasing: group.every((agent) => releasingIds.has(agent.id)),
            keepAwake: row?.keepAwake ?? group.some((agent) => agent.keepAwake),
            activeSecondsThisPeriod: row?.activeSecondsThisPeriod ?? null
        })
    }

    for (const sandbox of sandboxes) {
        if (sandbox.powerState !== 'running') continue
        // Any agent claiming this host makes the SSE agent state authoritative:
        // running agents were already grouped above, and a stale polled row
        // must not resurrect a host the stream has already seen stop.
        if (agentHostIds.has(sandbox.id)) continue
        slots.push({
            key: sandbox.id,
            hostId: sandbox.id,
            name: sandbox.name,
            agents: [],
            releasing: false,
            keepAwake: sandbox.keepAwake,
            activeSecondsThisPeriod: sandbox.activeSecondsThisPeriod
        })
    }
    return slots
}

const NO_RELEASING: ReadonlySet<string> = new Set()

export const countActiveSandboxes = (
    agents: SdkAgent[],
    sandboxes: SandboxSummary[]
): number => groupActiveSandboxes(agents, sandboxes, NO_RELEASING).length
