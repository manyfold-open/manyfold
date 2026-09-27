import type {
    AgentHostStatusUpdate,
    ChatSessionSummary,
    HostPowerStatusUpdate
} from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'
import { docsHref } from '@/lib/docsLinks'

const timeValue = (value: string): number => {
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? 0 : ms
}

export const sortSidebarAgents = (agents: SdkAgent[]): SdkAgent[] =>
    [...agents].sort((a, b) => {
        const diff = timeValue(b.createdAt) - timeValue(a.createdAt)
        if (diff !== 0) return diff
        if (a.id < b.id) return -1
        if (a.id > b.id) return 1
        return 0
    })

const snapshotValuesEqual = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false
        return (
            left.length === right.length &&
            left.every((value, index) =>
                snapshotValuesEqual(value, right[index])
            )
        )
    }
    if (
        typeof left !== 'object' ||
        left === null ||
        typeof right !== 'object' ||
        right === null
    )
        return false
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord)
    const rightKeys = Object.keys(rightRecord)
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(rightRecord, key) &&
                snapshotValuesEqual(leftRecord[key], rightRecord[key])
        )
    )
}

export const reconcileSidebarAgents = (
    current: SdkAgent[],
    incoming: SdkAgent[]
): SdkAgent[] => {
    const currentById = new Map(current.map((agent) => [agent.id, agent]))
    const reconciled = incoming.map((agent) => {
        const previous = currentById.get(agent.id)
        return previous && snapshotValuesEqual(previous, agent)
            ? previous
            : agent
    })
    return reconciled.length === current.length &&
        reconciled.every((agent, index) => agent === current[index])
        ? current
        : reconciled
}

// What the host-status stream says about one agent: its host's power state
// and the availability the API derived from it (ADR-0037).
export type AgentStatusSnapshot = Pick<
    AgentHostStatusUpdate,
    'agentId' | 'powerState' | 'availability'
>

export const applyAgentStatusSnapshots = (
    agents: SdkAgent[],
    updates: readonly AgentStatusSnapshot[]
): SdkAgent[] => {
    const updatesById = new Map(
        updates.map((update) => [update.agentId, update])
    )
    let changed = false
    const next = agents.map((agent) => {
        const update = updatesById.get(agent.id)
        if (
            !update ||
            (agent.powerState === update.powerState &&
                agent.availability === update.availability)
        )
            return agent
        changed = true
        return {
            ...agent,
            powerState: update.powerState,
            availability: update.availability
        }
    })
    return changed ? next : agents
}

// A host-level power event reaches every agent on that host. Availability is
// left alone: the API sends it per agent in its own update frame.
export const applyHostPowerUpdate = (
    agents: SdkAgent[],
    update: Pick<HostPowerStatusUpdate, 'hostId' | 'powerState' | 'daemonOnline'>
): SdkAgent[] => {
    let changed = false
    const next = agents.map((agent) => {
        if (
            agent.hostId !== update.hostId ||
            (agent.powerState === update.powerState &&
                agent.daemonOnline === update.daemonOnline)
        )
            return agent
        changed = true
        return {
            ...agent,
            powerState: update.powerState,
            daemonOnline: update.daemonOnline
        }
    })
    return changed ? next : agents
}

export const sortSessionsByActivity = (
    sessions: ChatSessionSummary[]
): ChatSessionSummary[] =>
    [...sessions].sort((a, b) => {
        const diff = timeValue(b.updatedAt) - timeValue(a.updatedAt)
        return diff !== 0
            ? diff
            : timeValue(b.createdAt) - timeValue(a.createdAt)
    })

export type AgentChatAvailabilityCode =
    | 'ready'
    | 'no-agent'
    | 'status'
    | 'cli-upgrade'

export interface AgentChatAvailability {
    ready: boolean
    reason: string | null
    code: AgentChatAvailabilityCode
}

export const CLI_UPGRADE_LEARN_HOW_URL = docsHref('/docs/local-daemons')

export const cliUpgradeChatReason = (): string =>
    "This agent's self-owned computer is running an outdated mf CLI. Run `mf update`, then `mf daemon stop && mf daemon start`. See " +
    CLI_UPGRADE_LEARN_HOW_URL +
    '.'

export const getAgentChatAvailability = (
    agent: SdkAgent | null
): AgentChatAvailability => {
    if (!agent)
        return {
            ready: false,
            reason: 'Select an agent to chat.',
            code: 'no-agent'
        }
    if (agent.status !== 'ready')
        return {
            ready: false,
            reason: `This agent is ${agent.status} and can't receive messages right now.`,
            code: 'status'
        }
    // A wakeable host (asleep sandbox) wakes on send; an offline self-owned
    // computer and a runtime that is not installed cannot.
    if (agent.availability === 'offline')
        return {
            ready: false,
            reason: "This agent's self-owned computer is offline. Start its daemon and try again.",
            code: 'status'
        }
    if (agent.availability === 'unavailable')
        return {
            ready: false,
            reason: "This agent's runtime is not available right now.",
            code: 'status'
        }
    if (agent.daemonNeedsUpgrade) {
        return {
            ready: false,
            reason: cliUpgradeChatReason(),
            code: 'cli-upgrade'
        }
    }
    return { ready: true, reason: null, code: 'ready' }
}
