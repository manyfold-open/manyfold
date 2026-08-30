import {
    frameworkCapability,
    isExternal,
    supportsRuntime
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime
} from '@manyfold/shared'
import type { CreateableFramework } from '@/lib/agentCreateDraft'
import type { TFn } from '@/lib/i18n'

export type FrameworkChoice = AgentFramework

export type RuntimeMode = 'sandbox' | 'persistent' | 'daemon' | 'existing'

export type RuntimeCategory = Exclude<RuntimeMode, 'existing'>

export const runtimeCategoryShortLabel = (
    category: RuntimeCategory,
    t: TFn
): string => {
    if (category === 'sandbox') return t('web.agentNew.statefulSandbox')
    if (category === 'persistent') return t('web.agentNew.persistent')
    return t('web.agentNew.localDaemon')
}

export const REUSE_FRAMEWORKS: ReadonlySet<AgentFramework> = new Set([
    'openclaw',
    'hermes',
    'claude-code',
    'codex',
    'gemini-cli',
    'narranexus'
])

export const reuseRuntimeKindsFor = (
    framework: AgentFramework
): ReadonlySet<AgentRuntime> =>
    new Set(
        frameworkCapability(framework).runtimes.filter(
            (kind) => kind !== 'external'
        )
    )

export const isExternalFramework = (framework: FrameworkChoice): boolean =>
    isExternal(framework)

export const isCreateableFramework = (
    _value: FrameworkChoice
): _value is CreateableFramework => true

export const isK8sOnlyFramework = (_framework: CreateableFramework): boolean =>
    false

export const usesConfigurableModelProvider = (
    framework: CreateableFramework
): boolean => framework === 'openclaw' || framework === 'hermes'

export const supportsSandbox = (framework: CreateableFramework): boolean =>
    supportsRuntime(framework, 'sprites')

export interface FrameworkOptionEntry {
    value: FrameworkChoice
    label: string
    descriptionKey: string
    disabled?: boolean
}

export const frameworkOptions: FrameworkOptionEntry[] = [
    {
        value: 'claude-code',
        label: 'Claude Code',
        descriptionKey: 'web.agentNew.frameworkDescriptions.claudeCode'
    },
    {
        value: 'codex',
        label: 'Codex',
        descriptionKey: 'web.agentNew.frameworkDescriptions.codex'
    },
    {
        value: 'gemini-cli',
        label: 'Gemini CLI',
        descriptionKey: 'web.agentNew.frameworkDescriptions.geminiCli'
    },
    {
        value: 'narranexus',
        label: 'NarraNexus',
        descriptionKey: 'web.agentNew.frameworkDescriptions.narraNexus'
    },
    {
        value: 'hermes',
        label: 'Hermes Agent',
        descriptionKey: 'web.agentNew.frameworkDescriptions.hermes'
    },
    {
        value: 'openclaw',
        label: 'OpenClaw',
        descriptionKey: 'web.agentNew.frameworkDescriptions.openclaw'
    },
    {
        value: 'dify',
        label: 'Dify',
        descriptionKey: 'web.agentNew.frameworkDescriptions.dify'
    },
    {
        value: 'langflow',
        label: 'Langflow',
        descriptionKey: 'web.agentNew.frameworkDescriptions.langflow'
    },
    {
        value: 'a2a',
        label: 'A2A',
        descriptionKey: 'web.agentNew.frameworkDescriptions.a2a'
    }
]

export const remoteIdLabelFor = (framework: FrameworkChoice, t: TFn): string =>
    framework === 'langflow'
        ? t('web.agentNew.remoteLangflowIdLabel')
        : t('web.agentNew.remoteDifyIdLabel')

export const remoteIdPlaceholderFor = (
    framework: FrameworkChoice,
    t: TFn
): string =>
    framework === 'langflow'
        ? t('web.agentNew.remoteLangflowPlaceholder')
        : 'app-xxxxxxxxxxxx'

export const remoteIdHintFor = (framework: FrameworkChoice, t: TFn): string =>
    framework === 'langflow'
        ? t('web.agentNew.remoteLangflowHint')
        : t('web.agentNew.remoteDifyHint')
