import {
    agentFramework,
    runtimeKindLabel
} from '@manyfold/shared'
import type { AgentFramework } from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'

export type AgentSortKey = 'created' | 'recency'
export type AgentGroupKey = 'none' | 'host' | 'framework' | 'date'
export type LastActivityWindow = 'all' | '1d' | '3d' | '7d' | '30d'
export type DateBucketKey = 'today' | 'yesterday' | 'week' | 'month' | 'older'

export interface AgentsViewConfig {
    hosts: string[]
    frameworks: AgentFramework[]
    activity: LastActivityWindow
    groupBy: AgentGroupKey
    sortBy: AgentSortKey
}

export const defaultAgentsViewConfig: AgentsViewConfig = {
    hosts: [],
    frameworks: [],
    activity: 'all',
    groupBy: 'none',
    sortBy: 'created'
}

export const lastActivityWindows: LastActivityWindow[] = [
    '1d',
    '3d',
    '7d',
    '30d',
    'all'
]
export const agentGroupKeys: AgentGroupKey[] = [
    'none',
    'host',
    'framework',
    'date'
]
export const agentSortKeys: AgentSortKey[] = ['created', 'recency']
export const dateBucketOrder: DateBucketKey[] = [
    'today',
    'yesterday',
    'week',
    'month',
    'older'
]

const DAY_MS = 86_400_000
const WINDOW_MS: Record<Exclude<LastActivityWindow, 'all'>, number> = {
    '1d': DAY_MS,
    '3d': 3 * DAY_MS,
    '7d': 7 * DAY_MS,
    '30d': 30 * DAY_MS
}

const agentSidebarViewStorageKey = 'nca.web.agents.viewConfig'

const timeValue = (value: string | null): number => {
    if (!value) return 0
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? 0 : ms
}

// Deliberately NOT lastActiveAt: that is a reconcile heartbeat re-stamped on
// every liveness observation (~15s while the app is open), so it made recency
// sort reshuffle on a timer and made every reachable agent match "last 1 day".
// lastMessageAt only moves when a prompt is actually sent. An agent that has
// never been prompted counts as active from the moment it was created —
// otherwise a brand-new agent would vanish under a "last 1 day" window the
// instant it lands.
const activityTime = (agent: SdkAgent): number =>
    timeValue(agent.lastMessageAt) || timeValue(agent.createdAt)

export interface RuntimeHostRef {
    key: string
    label: string
}

// "Exact host" identity: the physical VM / machine / cluster an agent runs on,
// so agents sharing a host collapse into one group. The `hostNames` map resolves
// a host identifier to its friendly display name: daemons key on daemonId
// (DaemonHostSummary.id), sprites key on spriteName (the sandbox VM name) so the
// label reads the renameable sandbox name ("sandbox-002") instead of the raw VM id.
export const runtimeHostRef = (
    agent: SdkAgent,
    hostNames: ReadonlyMap<string, string>
): RuntimeHostRef => {
    switch (agent.runtime) {
        case 'daemon': {
            const id = agent.daemonId
            if (id)
                return {
                    key: `daemon:${id}`,
                    label: hostNames.get(id) ?? runtimeKindLabel('daemon')
                }
            return { key: 'daemon', label: runtimeKindLabel('daemon') }
        }
        case 'sprites': {
            const id = agent.spriteId ?? agent.runtimeId
            if (id)
                return {
                    key: `sprite:${id}`,
                    label:
                        (agent.spriteName
                            ? hostNames.get(agent.spriteName)
                            : undefined) ??
                        agent.spriteName ??
                        runtimeKindLabel('sprites')
                }
            return { key: 'sprites', label: runtimeKindLabel('sprites') }
        }
        case 'k8s': {
            const id = agent.clusterId
            if (id)
                return {
                    key: `k8s:${id}`,
                    label: agent.clusterName ?? runtimeKindLabel('k8s')
                }
            return { key: 'k8s', label: runtimeKindLabel('k8s') }
        }
        default:
            return { key: 'external', label: runtimeKindLabel('external') }
    }
}

const dateBucket = (agent: SdkAgent, now: number): DateBucketKey => {
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const t0 = startOfToday.getTime()
    const created = timeValue(agent.createdAt)
    if (created >= t0) return 'today'
    if (created >= t0 - DAY_MS) return 'yesterday'
    if (created >= t0 - 7 * DAY_MS) return 'week'
    if (created >= t0 - 30 * DAY_MS) return 'month'
    return 'older'
}

const matchesActivity = (
    agent: SdkAgent,
    window: LastActivityWindow,
    now: number
): boolean => {
    if (window === 'all') return true
    return activityTime(agent) >= now - WINDOW_MS[window]
}

export interface AgentGroup {
    kind: AgentGroupKey
    key: string
    hostLabel: string | null
    agents: SdkAgent[]
}

export interface AgentsViewResult {
    groups: AgentGroup[]
    totalCount: number
    visibleCount: number
    hiddenCount: number
    activeFilterCount: number
}

export interface AgentsViewContext {
    now: number
    hostNames: ReadonlyMap<string, string>
}

export const activeFilterCount = (config: AgentsViewConfig): number =>
    (config.hosts.length > 0 ? 1 : 0) +
    (config.frameworks.length > 0 ? 1 : 0) +
    (config.activity !== 'all' ? 1 : 0)

export const applyAgentsView = (
    agents: SdkAgent[],
    config: AgentsViewConfig,
    ctx: AgentsViewContext
): AgentsViewResult => {
    const hostByAgent = new Map<string, RuntimeHostRef>()
    for (const agent of agents)
        hostByAgent.set(agent.id, runtimeHostRef(agent, ctx.hostNames))

    const hostFilter = new Set(config.hosts)
    const frameworkFilter = new Set(config.frameworks)

    const filtered = agents.filter((agent) => {
        if (hostFilter.size > 0) {
            const ref = hostByAgent.get(agent.id)
            if (!ref || !hostFilter.has(ref.key)) return false
        }
        if (frameworkFilter.size > 0 && !frameworkFilter.has(agent.framework))
            return false
        return matchesActivity(agent, config.activity, ctx.now)
    })

    const sorted = [...filtered].sort((a, b) => {
        const av =
            config.sortBy === 'recency'
                ? activityTime(a)
                : timeValue(a.createdAt)
        const bv =
            config.sortBy === 'recency'
                ? activityTime(b)
                : timeValue(b.createdAt)
        if (bv !== av) return bv - av
        if (a.id < b.id) return -1
        if (a.id > b.id) return 1
        return 0
    })

    return {
        groups: groupAgents(sorted, config.groupBy, hostByAgent, ctx.now),
        totalCount: agents.length,
        visibleCount: sorted.length,
        hiddenCount: agents.length - sorted.length,
        activeFilterCount: activeFilterCount(config)
    }
}

const groupAgents = (
    sorted: SdkAgent[],
    groupBy: AgentGroupKey,
    hostByAgent: Map<string, RuntimeHostRef>,
    now: number
): AgentGroup[] => {
    if (groupBy === 'none')
        return sorted.length === 0
            ? []
            : [{ kind: 'none', key: 'all', hostLabel: null, agents: sorted }]

    if (groupBy === 'date') {
        const byBucket = new Map<DateBucketKey, SdkAgent[]>()
        for (const agent of sorted) {
            const bucket = dateBucket(agent, now)
            const list = byBucket.get(bucket) ?? []
            list.push(agent)
            byBucket.set(bucket, list)
        }
        return dateBucketOrder
            .filter((bucket) => byBucket.has(bucket))
            .map((bucket) => ({
                kind: 'date' as const,
                key: bucket,
                hostLabel: null,
                agents: byBucket.get(bucket) ?? []
            }))
    }

    // host / framework: groups follow first-appearance, so they inherit the
    // sort order already applied above.
    const order: string[] = []
    const byKey = new Map<string, AgentGroup>()
    for (const agent of sorted) {
        const ref =
            groupBy === 'host' ? hostByAgent.get(agent.id) : undefined
        const key = groupBy === 'host' ? (ref?.key ?? '') : agent.framework
        let group = byKey.get(key)
        if (!group) {
            group = {
                kind: groupBy,
                key,
                hostLabel: groupBy === 'host' ? (ref?.label ?? key) : null,
                agents: []
            }
            byKey.set(key, group)
            order.push(key)
        }
        group.agents.push(agent)
    }
    return order.map((key) => byKey.get(key) as AgentGroup)
}

export interface HostFilterOption {
    key: string
    label: string
    count: number
}

export const availableHostOptions = (
    agents: SdkAgent[],
    hostNames: ReadonlyMap<string, string>
): HostFilterOption[] => {
    const byKey = new Map<string, HostFilterOption>()
    for (const agent of agents) {
        const ref = runtimeHostRef(agent, hostNames)
        const existing = byKey.get(ref.key)
        if (existing) existing.count += 1
        else byKey.set(ref.key, { key: ref.key, label: ref.label, count: 1 })
    }
    return [...byKey.values()].sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    )
}

export interface FrameworkFilterOption {
    framework: AgentFramework
    count: number
}

export const availableFrameworkOptions = (
    agents: SdkAgent[]
): FrameworkFilterOption[] => {
    const byFramework = new Map<AgentFramework, number>()
    for (const agent of agents)
        byFramework.set(
            agent.framework,
            (byFramework.get(agent.framework) ?? 0) + 1
        )
    return [...byFramework.entries()]
        .map(([framework, count]) => ({ framework, count }))
        .sort((a, b) => b.count - a.count)
}

const isWindow = (value: unknown): value is LastActivityWindow =>
    typeof value === 'string' &&
    (lastActivityWindows as string[]).includes(value)

const isGroupKey = (value: unknown): value is AgentGroupKey =>
    typeof value === 'string' && (agentGroupKeys as string[]).includes(value)

const isSortKey = (value: unknown): value is AgentSortKey =>
    typeof value === 'string' && (agentSortKeys as string[]).includes(value)

const validFrameworks = new Set<string>(Object.values(agentFramework))

export const normalizeAgentsViewConfig = (
    raw: unknown
): AgentsViewConfig => {
    if (!raw || typeof raw !== 'object') return { ...defaultAgentsViewConfig }
    const value = raw as Record<string, unknown>
    const hosts = Array.isArray(value.hosts)
        ? value.hosts.filter((h): h is string => typeof h === 'string')
        : []
    const frameworks = Array.isArray(value.frameworks)
        ? value.frameworks.filter(
              (f): f is AgentFramework =>
                  typeof f === 'string' && validFrameworks.has(f)
          )
        : []
    return {
        hosts,
        frameworks,
        activity: isWindow(value.activity) ? value.activity : 'all',
        groupBy: isGroupKey(value.groupBy) ? value.groupBy : 'none',
        sortBy: isSortKey(value.sortBy) ? value.sortBy : 'created'
    }
}

export const readAgentsViewConfig = (): AgentsViewConfig => {
    if (typeof window === 'undefined') return { ...defaultAgentsViewConfig }
    try {
        const raw = window.localStorage.getItem(agentSidebarViewStorageKey)
        if (!raw) return { ...defaultAgentsViewConfig }
        return normalizeAgentsViewConfig(JSON.parse(raw))
    } catch {
        return { ...defaultAgentsViewConfig }
    }
}

export const writeAgentsViewConfig = (config: AgentsViewConfig): void => {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(
            agentSidebarViewStorageKey,
            JSON.stringify(config)
        )
    } catch {
        // ignore quota / disabled storage
    }
}

const collapsedAgentGroupsStorageKey = 'nca.web.agents.collapsedGroups'

export const readCollapsedAgentGroups = (): Set<string> => {
    if (typeof window === 'undefined') return new Set()
    try {
        const raw = window.localStorage.getItem(collapsedAgentGroupsStorageKey)
        if (!raw) return new Set()
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((k): k is string => typeof k === 'string'))
    } catch {
        return new Set()
    }
}

export const writeCollapsedAgentGroups = (keys: Set<string>): void => {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(
            collapsedAgentGroupsStorageKey,
            JSON.stringify([...keys])
        )
    } catch {
        // ignore quota / disabled storage
    }
}
