import type {
    AgentFramework,
    UserModelProvider
} from '@manyfold/shared'
import type { FC } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import {
    ClaudeCodeColor,
    CodexColor,
    DifyColor,
    GeminiCLIColor,
    HermesAgentMono,
    OpenClawColor,
    type IconType
} from '@/lib/brandIcons'
import nexusLightIcon from '@/assets/agent-logos/nexus-light.svg'
import nexusDarkIcon from '@/assets/agent-logos/nexus-dark.svg'
import a2aLightIcon from '@/assets/agent-logos/a2a-light.svg'
import a2aDarkIcon from '@/assets/agent-logos/a2a-dark.svg'
// Local copy of the Langflow GitHub avatar, sized for its largest rendered
// use (~22px @3x): no third-party request on the landing critical path.
import langflowIcon from '@/assets/agent-logos/langflow.png'

interface FrameworkMeta {
    labelKey: string
    Icon: IconType | null
    mono: boolean
    iconSrc: string | null
    iconSrcDark: string | null
    supportsModelOverride: boolean
    modelPresets: readonly string[]
    defaultProvider: UserModelProvider
}

const frameworkMeta = {
    'claude-code': {
        labelKey: 'web.frameworks.claudeCode',
        Icon: ClaudeCodeColor,
        mono: false,
        iconSrc: null,
        iconSrcDark: null,
        supportsModelOverride: true,
        modelPresets: ['sonnet', 'opus'],
        defaultProvider: 'anthropic'
    },
    codex: {
        labelKey: 'web.frameworks.codex',
        Icon: CodexColor,
        mono: false,
        iconSrc: null,
        iconSrcDark: null,
        supportsModelOverride: true,
        modelPresets: ['gpt-5.6-sol', 'gpt-5.5'],
        defaultProvider: 'openai'
    },
    'gemini-cli': {
        labelKey: 'web.frameworks.geminiCli',
        Icon: GeminiCLIColor,
        mono: false,
        iconSrc: null,
        iconSrcDark: null,
        supportsModelOverride: true,
        modelPresets: ['auto', 'gemini-3.5-flash', 'gemini-2.5-pro'],
        defaultProvider: 'google'
    },
    openclaw: {
        labelKey: 'web.frameworks.openclaw',
        Icon: OpenClawColor,
        mono: false,
        iconSrc: null,
        iconSrcDark: null,
        supportsModelOverride: false,
        modelPresets: [],
        defaultProvider: 'anthropic'
    },
    hermes: {
        labelKey: 'web.frameworks.hermes',
        Icon: HermesAgentMono,
        mono: true,
        iconSrc: null,
        iconSrcDark: null,
        // Options come from the agent's provider-models cache at runtime
        // (AgentChat feeds them in), so the static presets stay empty.
        supportsModelOverride: true,
        modelPresets: [],
        defaultProvider: 'openrouter'
    },
    narranexus: {
        labelKey: 'web.frameworks.narraNexus',
        Icon: null,
        mono: false,
        iconSrc: nexusLightIcon,
        iconSrcDark: nexusDarkIcon,
        supportsModelOverride: false,
        modelPresets: [],
        defaultProvider: 'anthropic'
    },
    dify: {
        labelKey: 'web.frameworks.dify',
        Icon: DifyColor,
        mono: false,
        iconSrc: null,
        iconSrcDark: null,
        supportsModelOverride: false,
        modelPresets: [],
        defaultProvider: 'anthropic'
    },
    langflow: {
        labelKey: 'web.frameworks.langflow',
        Icon: null,
        mono: false,
        iconSrc: langflowIcon,
        iconSrcDark: null,
        supportsModelOverride: false,
        modelPresets: [],
        defaultProvider: 'anthropic'
    },
    a2a: {
        labelKey: 'web.frameworks.a2a',
        Icon: null,
        mono: false,
        iconSrc: a2aLightIcon,
        iconSrcDark: a2aDarkIcon,
        supportsModelOverride: false,
        modelPresets: [],
        defaultProvider: 'anthropic'
    }
} satisfies Record<AgentFramework, FrameworkMeta>

export const frameworkLabel = (framework: AgentFramework): string =>
    t(frameworkMeta[framework].labelKey)

export const FrameworkLogo: FC<{
    framework: AgentFramework
    size?: number
    className?: string
}> = ({ framework, size = 28, className }) => {
    const meta = frameworkMeta[framework]
    if (meta.Icon) {
        const Icon = meta.Icon
        return (
            <span
                className={[
                    'inline-flex shrink-0',
                    meta.mono ? 'text-fg' : '',
                    className
                ]
                    .filter(Boolean)
                    .join(' ')}
                style={{ width: size, height: size }}
                aria-hidden='true'
            >
                <Icon size={size} />
            </span>
        )
    }
    if (meta.iconSrcDark)
        return (
            <>
                <img
                    src={meta.iconSrc ?? ''}
                    alt=''
                    aria-hidden='true'
                    loading='lazy'
                    style={{ width: size, height: size }}
                    className={[
                        'shrink-0 object-contain dark:hidden',
                        className
                    ]
                        .filter(Boolean)
                        .join(' ')}
                />
                <img
                    src={meta.iconSrcDark}
                    alt=''
                    aria-hidden='true'
                    loading='lazy'
                    style={{ width: size, height: size }}
                    className={[
                        'hidden shrink-0 object-contain dark:block',
                        className
                    ]
                        .filter(Boolean)
                        .join(' ')}
                />
            </>
        )
    return (
        <img
            src={meta.iconSrc ?? ''}
            alt=''
            aria-hidden='true'
            loading='lazy'
            style={{ width: size, height: size }}
            className={['shrink-0 object-contain', className]
                .filter(Boolean)
                .join(' ')}
        />
    )
}

export const supportsModelOverride = (
    frameworkOrAgent?: AgentFramework | SdkAgent | null
): boolean => {
    const framework =
        typeof frameworkOrAgent === 'string'
            ? frameworkOrAgent
            : frameworkOrAgent?.framework
    return framework ? frameworkMeta[framework].supportsModelOverride : false
}

export const modelOptionsForAgent = (
    agent: Pick<SdkAgent, 'framework' | 'model'> | null | undefined,
    extraModels: Array<string | null | undefined> = []
): string[] => {
    if (!agent || !supportsModelOverride(agent.framework)) return []
    return uniqueModels([
        ...(agent.model ? [agent.model] : []),
        ...frameworkMeta[agent.framework].modelPresets,
        ...extraModels
    ])
}

export const defaultProviderForFramework = (
    framework: AgentFramework
): UserModelProvider => frameworkMeta[framework].defaultProvider

const uniqueModels = (models: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const model of models) {
        const trimmed = model?.trim() ?? ''
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
    }
    return out
}
