import type { LucideIcon } from '@/components/icons'
import {
    ChannelIcon,
    CodeIcon,
    FeatherIcon,
    ImagesIcon,
    MailIcon,
    MemoryIcon,
    MessageCircleIcon,
    NetworkIcon,
    PlugIcon,
    SearchIcon,
    SparklesIcon,
    TerminalIcon,
    UserIcon,
    WorkflowIcon,
    ZapIcon
} from '@/components/icons'
import { isCoreFramework } from '@manyfold/shared'
import type { AgentFramework, CoreFramework } from '@manyfold/shared'
import { frameworkPresentation } from '@/lib/frameworkPresentation'

export type CapabilityId =
    | 'general'
    | 'code'
    | 'terminal'
    | 'fastIteration'
    | 'multimodal'
    | 'assistant'
    | 'research'
    | 'lightweight'
    | 'personalAssistant'
    | 'channels'
    | 'calendarEmail'
    | 'multiAgent'
    | 'memory'
    | 'visualBuilder'
    | 'connectApp'
    | 'protocol'

export const CAPABILITY_ICON: Record<CapabilityId, LucideIcon> = {
    general: SparklesIcon,
    code: CodeIcon,
    terminal: TerminalIcon,
    fastIteration: ZapIcon,
    multimodal: ImagesIcon,
    assistant: MessageCircleIcon,
    research: SearchIcon,
    lightweight: FeatherIcon,
    personalAssistant: UserIcon,
    channels: ChannelIcon,
    calendarEmail: MailIcon,
    multiAgent: NetworkIcon,
    memory: MemoryIcon,
    visualBuilder: WorkflowIcon,
    connectApp: PlugIcon,
    protocol: NetworkIcon
}

const FRAMEWORK_CAPABILITIES: Record<CoreFramework, CapabilityId[]> = {
    'claude-code': ['general', 'code', 'terminal'],
    codex: ['code', 'fastIteration'],
    'gemini-cli': ['code', 'multimodal'],
    pi: ['code', 'terminal', 'lightweight'],
    hermes: ['assistant', 'research', 'lightweight'],
    openclaw: ['personalAssistant', 'channels', 'calendarEmail'],
    dify: ['visualBuilder', 'connectApp'],
    langflow: ['visualBuilder', 'connectApp'],
    a2a: ['protocol', 'connectApp']
}

export const capabilitiesFor = (
    framework: AgentFramework
): readonly CapabilityId[] =>
    isCoreFramework(framework)
        ? FRAMEWORK_CAPABILITIES[framework]
        : (frameworkPresentation(framework)?.capabilities ?? [])
