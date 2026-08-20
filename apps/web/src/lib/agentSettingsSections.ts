import {
    frameworkCapability,
    frameworkMcpSupport,
    isSkillFramework
} from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'

export type AgentSettingsSectionId =
    | 'overview'
    | 'model'
    | 'skills'
    | 'mcp'
    | 'context'
    | 'permissions'
    | 'connections'
    | 'environment'
    | 'storage'
    | 'channels'
    | 'a2a'

export interface AgentSettingsSection {
    id: AgentSettingsSectionId
    labelKey: string
}

// One flat list, in the order the rail renders it. Eleven destinations do not
// need headings above them — and the headings we tried ("Access" over
// Connections, which is account wiring rather than access control) asked the
// reader to accept a categorisation before they could use the list. Related
// sections still sit next to each other; that adjacency is the whole benefit
// the groups were carrying.
const SECTIONS: AgentSettingsSection[] = [
    { id: 'overview', labelKey: 'web.agentSettings.sections.overview' },
    { id: 'model', labelKey: 'web.agentSettings.sections.model' },
    { id: 'skills', labelKey: 'web.agentSettings.sections.skills' },
    { id: 'mcp', labelKey: 'web.agentSettings.sections.mcp' },
    { id: 'context', labelKey: 'web.agentSettings.sections.context' },
    { id: 'permissions', labelKey: 'web.agentSettings.sections.permissions' },
    { id: 'connections', labelKey: 'web.agentSettings.sections.connections' },
    { id: 'environment', labelKey: 'web.agentSettings.sections.environment' },
    { id: 'storage', labelKey: 'web.agentSettings.sections.storage' },
    { id: 'channels', labelKey: 'web.agentSettings.sections.channels' },
    { id: 'a2a', labelKey: 'web.agentSettings.sections.a2a' }
]

// Whether an agent of this shape has the section at all. The gate states
// delivery truth, not policy: a section exists exactly where the platform can
// deliver what it edits. Sprites take everything; a self-owned computer takes
// what rides the daemon RPC — env text and connection env per turn, context
// docs over exec, MCP config over its fs RPCs (#781) — with hermes carried by
// its turn payload and openclaw excluded because its turn payload has no env
// channel (#783). An external agent has no workspace at all, which leaves
// only "who may call it" and "how it is reached".
export const supportsSection = (
    agent: SdkAgent,
    id: AgentSettingsSectionId
): boolean => {
    const sprite = agent.runtime === 'sprites'
    const deliverable = sprite || agent.runtime === 'daemon'
    const coding = frameworkCapability(agent.framework).kind === 'coding'
    switch (id) {
        case 'overview':
        case 'permissions':
        case 'channels':
        case 'a2a':
            return true
        case 'model':
            return agent.runtime !== 'external'
        case 'storage':
            return agent.runtime !== 'external'
        case 'environment':
            return (
                deliverable &&
                !(agent.runtime === 'daemon' && agent.framework === 'openclaw')
            )
        case 'connections':
            return deliverable && coding
        case 'context':
            return deliverable && coding
        case 'mcp':
            return deliverable && !!frameworkMcpSupport(agent.framework)
        case 'skills':
            return isSkillFramework(agent.framework) && !!agent.runtimeId
    }
}

export const sectionsFor = (agent: SdkAgent): AgentSettingsSection[] =>
    SECTIONS.filter((section) => supportsSection(agent, section.id))

export const isAgentSettingsSection = (
    value: string | undefined
): value is AgentSettingsSectionId =>
    !!value && SECTIONS.some((section) => section.id === value)

// Reads the full list, not this agent's list: a deep link can land on a section
// the agent cannot have, and the header still has to name the section on screen
// rather than the one the rail fell back to highlighting.
export const sectionLabelKey = (id: AgentSettingsSectionId): string =>
    SECTIONS.find((section) => section.id === id)!.labelKey

// Old links carried the section in a `?tab=` query, including names that were
// folded away before this area existed. They stay valid forever: bookmarks,
// notification emails and channel messages still point at them.
const LEGACY_TAB_ALIASES: Record<string, AgentSettingsSectionId> = {
    backups: 'storage',
    configuration: 'overview',
    runtime: 'overview',
    'model-provider': 'model'
}

export const sectionFromLegacyTab = (
    tab: string | null
): AgentSettingsSectionId => {
    if (!tab) return 'overview'
    if (isAgentSettingsSection(tab)) return tab
    return LEGACY_TAB_ALIASES[tab] ?? 'overview'
}

// Why a supported-looking section is unavailable for this particular agent,
// shown when a deep link lands on one instead of 404ing. Picks the framework
// key when the framework is the blocker on an otherwise-capable runtime, and
// the runtime key otherwise.
export const sectionPreconditionKey = (
    agent: SdkAgent,
    id: AgentSettingsSectionId
): string | null => {
    if (supportsSection(agent, id)) return null
    const coding = frameworkCapability(agent.framework).kind === 'coding'
    switch (id) {
        case 'environment':
            return agent.runtime === 'daemon' && agent.framework === 'openclaw'
                ? 'web.agents.detail.environment.unavailableOpenclaw'
                : 'web.agents.detail.environment.unavailableRuntime'
        case 'connections':
            return coding
                ? 'web.agents.detail.connections.unavailableRuntime'
                : 'web.agents.detail.connections.unavailableFramework'
        case 'context':
            return coding
                ? 'web.agents.detail.contextDoc.unavailableRuntime'
                : 'web.agents.detail.contextDoc.unavailableFramework'
        case 'mcp':
            return agent.runtime === 'sprites' || agent.runtime === 'daemon'
                ? 'web.agents.detail.mcp.unsupported'
                : 'web.agents.detail.mcp.sandboxOnly'
        case 'skills':
            return isSkillFramework(agent.framework)
                ? 'web.agents.detail.skills.needsRuntime'
                : 'web.agents.detail.skills.unsupported'
        // Both are external-only gaps, and both used to fall through to null —
        // which rendered the live section (a Create backup button on an agent
        // with no workspace) under a rail that hides it.
        case 'model':
            return 'web.agents.detail.modelProvider.unavailableExternal'
        case 'storage':
            return 'web.agents.detail.storage.unavailableExternal'
        default:
            return null
    }
}
