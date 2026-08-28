import type { AgentRuntimeSummary } from '@manyfold/shared'
import {
    BoxIcon,
    CloudComputerIcon,
    GlobeIcon,
    LocalDaemonIcon,
    type LucideIcon
} from '@/components/icons'

export interface NewRuntimeOption {
    kind: AgentRuntimeSummary['kind']
    to: string
    icon: LucideIcon
    labelKey: string
    descriptionKey: string
    createLabelKey: string
    requiresCloudComputer?: boolean
}

// Single source for "where does a new runtime of this kind get created" —
// consumed by both the New-runtime dialog and the dashboard's per-kind
// create buttons, so destinations and gating cannot drift apart.
export const NEW_RUNTIME_OPTIONS: NewRuntimeOption[] = [
    {
        kind: 'sprites',
        to: '/settings/runtimes/sandbox',
        icon: BoxIcon,
        labelKey: 'web.agentRuntimesList.newSandboxHost',
        descriptionKey: 'web.agentRuntimesList.newSandboxHostDescription',
        createLabelKey: 'web.runtimesDashboard.newSandbox'
    },
    {
        kind: 'k8s',
        to: '/settings/cloud-computers',
        icon: CloudComputerIcon,
        labelKey: 'web.agentRuntimesList.rentCloudComputer',
        descriptionKey: 'web.agentRuntimesList.rentCloudComputerDescription',
        createLabelKey: 'web.runtimesDashboard.rentComputer',
        requiresCloudComputer: true
    },
    {
        kind: 'daemon',
        to: '/settings/runtimes/local-daemons',
        icon: LocalDaemonIcon,
        labelKey: 'web.agentRuntimesList.connectComputer',
        descriptionKey: 'web.agentRuntimesList.connectComputerDescription',
        createLabelKey: 'web.runtimesDashboard.connectMachine'
    },
    {
        kind: 'external',
        to: '/settings/runtimes/external-agent-providers',
        icon: GlobeIcon,
        labelKey: 'web.agentRuntimesList.configureExternal',
        descriptionKey: 'web.agentRuntimesList.configureExternalDescription',
        createLabelKey: 'web.runtimesDashboard.addProvider'
    }
]
