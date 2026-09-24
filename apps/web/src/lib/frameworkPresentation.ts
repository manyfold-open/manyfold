import { frameworkCapability, registerFramework } from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime,
    FrameworkDefinition
} from '@manyfold/shared'
import type { NewChatLaunchpadConfig } from '@/lib/newChatLaunchpad'
import type { CapabilityId } from '@/pages/AgentNew/v3/capabilities'

// How a framework an edition registers (ADR-0034) shows up in this app: the
// counterpart of the core rows in frameworkMeta, the create catalogs and the
// new-chat launchpad, which only ever name core frameworks. Free of asset
// imports, because the node:test suites load it.
export interface FrameworkPresentation {
    definition: FrameworkDefinition
    labelKey: string
    icon: { light: string; dark?: string }
    // The v1–v3 picker line, and the v4 catalog's "what this is" line.
    descriptionKey: string
    identityKey: string
    // v3's capability chips.
    capabilities: readonly CapabilityId[]
    launchpad: NewChatLaunchpadConfig
    // What a create flow shows for an empty workspace field, `{agent-id}`
    // standing in for the id that does not exist yet. Absent: the platform's
    // own workspace path.
    defaultWorkspacePath?: (hostKind: AgentRuntime) => string
}

const presentations = new Map<AgentFramework, FrameworkPresentation>()

export const registerFrameworkPresentation = (
    presentation: FrameworkPresentation
): void => {
    registerFramework(presentation.definition)
    presentations.set(presentation.definition.id, presentation)
}

export const frameworkPresentation = (
    framework: AgentFramework
): FrameworkPresentation | undefined => presentations.get(framework)

export const listFrameworkPresentations = (): FrameworkPresentation[] => [
    ...presentations.values()
]

export const presentedWorkspacePath = (
    framework: AgentFramework,
    hostKind: AgentRuntime
): string | null =>
    frameworkPresentation(framework)?.defaultWorkspacePath?.(hostKind) ?? null

// An edition's frameworks join a list of core entries right after the coding
// CLIs, ahead of the core service frameworks.
export const spliceAfterCodingClis = <T>(
    core: readonly T[],
    frameworkOf: (entry: T) => AgentFramework,
    extra: readonly T[]
): T[] => {
    let at = 0
    core.forEach((entry, index) => {
        if (frameworkCapability(frameworkOf(entry)).kind === 'coding')
            at = index + 1
    })
    return [...core.slice(0, at), ...extra, ...core.slice(at)]
}
