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
import type { FrameworkChoice } from '@/lib/agentCreate/frameworkOptions'

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

export const FRAMEWORK_CAPABILITIES: Record<FrameworkChoice, CapabilityId[]> = {
    'claude-code': ['general', 'code', 'terminal'],
    codex: ['code', 'fastIteration'],
    'gemini-cli': ['code', 'multimodal'],
    hermes: ['assistant', 'research', 'lightweight'],
    openclaw: ['personalAssistant', 'channels', 'calendarEmail'],
    narranexus: ['multiAgent', 'memory', 'channels'],
    dify: ['visualBuilder', 'connectApp'],
    langflow: ['visualBuilder', 'connectApp'],
    a2a: ['protocol', 'connectApp']
}
