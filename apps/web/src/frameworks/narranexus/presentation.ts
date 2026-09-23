import {
    narraNexusBaseWorkingPath,
    narraNexusFrameworkDefinition
} from '@manyfold/shared'
import type { FrameworkPresentation } from '@/lib/frameworkPresentation'

// Everything but the logo, which index.ts adds: the node:test suites can load
// this file, and they cannot load an .svg.
export const narraNexusPresentation: Omit<FrameworkPresentation, 'icon'> = {
    definition: narraNexusFrameworkDefinition,
    labelKey: 'web.frameworks.narraNexus',
    descriptionKey: 'web.agentNew.frameworkDescriptions.narraNexus',
    identityKey: 'web.agentNewV4.identity.narranexus',
    capabilities: ['multiAgent', 'memory', 'channels'],
    // Its schedules run inside NarraNexus itself, so the launchpad never
    // offers one.
    launchpad: { actionIds: ['native', 'channel'], recommended: 'native' },
    defaultWorkspacePath: (hostKind) =>
        `${narraNexusBaseWorkingPath(hostKind)}/{agent-id}_<mf-user>`
}
