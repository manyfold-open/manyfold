import {
    frameworkCapability,
    isExternal,
    supportsRuntime
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime
} from '@manyfold/shared'
import type {
    CreateableFramework,
    PersistentModelProvider
} from '@/lib/agentCreateDraft'
import { modelProviderForFramework } from '@/lib/agentCreateDraft'
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
    'pi',
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

// Frameworks whose credential can belong to more than one vendor, so the
// create form asks for the API protocol before it filters saved providers or
// labels the pasted key. openclaw/hermes pick between Anthropic and OpenAI;
// pi also speaks Google's protocol.
export const usesConfigurableModelProvider = (
    framework: CreateableFramework
): boolean =>
    framework === 'openclaw' || framework === 'hermes' || framework === 'pi'

const SERVICE_PERSISTENT_PROVIDERS: readonly PersistentModelProvider[] = [
    'anthropic',
    'openai'
]
const PI_PERSISTENT_PROVIDERS: readonly PersistentModelProvider[] = [
    'anthropic',
    'openai',
    'google'
]

export const persistentModelProvidersFor = (
    framework: CreateableFramework
): readonly PersistentModelProvider[] =>
    framework === 'pi' ? PI_PERSISTENT_PROVIDERS : SERVICE_PERSISTENT_PROVIDERS

// The protocol a freshly selected framework starts on. Single-vendor
// frameworks are pinned to their vendor (the value is unused for them but
// keeps the state well-typed); hermes/openclaw default to OpenAI because the
// managed channel is OpenAI-only for them, pi to Anthropic like Claude Code.
export const defaultPersistentModelProvider = (
    framework: CreateableFramework
): PersistentModelProvider =>
    framework === 'pi'
        ? 'anthropic'
        : usesConfigurableModelProvider(framework)
          ? 'openai'
          : modelProviderForFramework(framework)

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
        value: 'pi',
        label: 'Pi',
        descriptionKey: 'web.agentNew.frameworkDescriptions.pi'
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
