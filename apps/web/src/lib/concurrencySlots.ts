import type { SandboxSummary } from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'

export interface ActiveSandbox {
    key: string
    name: string
    agents: SdkAgent[]
    releasing: boolean
    keepAliveRuntimeIds: string[]
    activeSecondsThisPeriod: number | null
}

// Mirrors the API's activeSandboxUsageFor: one slot per running sandbox VM —
// co-resident agents share one slot and a bare sandbox (terminal only, no
// agents) still occupies one. Agents carry SSE-fresh spriteStatus, so they
// are authoritative for any VM they sit on; the polled sandbox rows only
// contribute VMs no agent claims.
export const groupActiveSandboxes = (
    agents: SdkAgent[],
    sandboxes: SandboxSummary[],
    releasingIds: ReadonlySet<string>
): ActiveSandbox[] => {
    const byVm = new Map<string, SdkAgent[]>()
    for (const agent of agents) {
        if (agent.runtime !== 'sprites' || agent.spriteStatus !== 'running')
            continue
        const key = agent.spriteName ?? agent.runtimeId
        if (!key) continue
        const group = byVm.get(key) ?? []
        group.push(agent)
        byVm.set(key, group)
    }

    const rowBySpriteName = new Map<string, SandboxSummary>()
    for (const sandbox of sandboxes)
        if (sandbox.spriteName) rowBySpriteName.set(sandbox.spriteName, sandbox)
    const agentSpriteNames = new Set<string>()
    for (const agent of agents)
        if (agent.spriteName) agentSpriteNames.add(agent.spriteName)

    const slots: ActiveSandbox[] = []
    for (const [key, group] of byVm) {
        const spriteName = group[0].spriteName
        const row = spriteName ? rowBySpriteName.get(spriteName) : undefined
        const keepAliveRuntimeIds = Array.from(
            new Set(
                group
                    .filter(
                        (agent) => agent.keepAliveEnabled && agent.runtimeId
                    )
                    .map((agent) => agent.runtimeId as string)
            )
        )
        slots.push({
            key,
            name: row?.name ?? spriteName ?? group[0].name,
            agents: group,
            // A sandbox only counts as releasing once every agent holding it
            // is stopping — one still-running agent keeps the slot occupied.
            releasing: group.every((agent) => releasingIds.has(agent.id)),
            keepAliveRuntimeIds,
            activeSecondsThisPeriod: row?.activeSecondsThisPeriod ?? null
        })
    }

    for (const sandbox of sandboxes) {
        if (sandbox.spriteStatus !== 'running') continue
        // Any agent claiming this VM makes the SSE agent state authoritative:
        // running agents were already grouped above, and a stale polled row
        // must not resurrect a VM the stream has already seen stop.
        if (sandbox.spriteName) {
            if (agentSpriteNames.has(sandbox.spriteName)) continue
        } else if (sandbox.agentsCount > 0) continue
        slots.push({
            key: sandbox.id,
            name: sandbox.name,
            agents: [],
            releasing: false,
            keepAliveRuntimeIds: [],
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
