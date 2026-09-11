import type { AgentFramework } from '@manyfold/shared'
import type { CreateProviderChoice } from '@/lib/newChannelOptions'

export type NewChatActionId =
    | 'github'
    | 'skills'
    | 'mcp'
    | 'channel'
    | 'automation'
    | 'native'
    | 'provider'
    | 'a2a'

export interface NewChatLaunchpadConfig {
    actionIds: readonly NewChatActionId[]
    // The one step worth taking first for this framework. It always leads
    // `actionIds` (a test holds that): the row order is what a reader actually
    // sees as the hierarchy, so a badge pointing anywhere else contradicts it.
    recommended: NewChatActionId
}

export const NEW_CHAT_LAUNCHPAD_CONFIG: Record<
    AgentFramework,
    NewChatLaunchpadConfig
> = {
    'claude-code': {
        actionIds: ['github', 'skills', 'channel'],
        recommended: 'github'
    },
    codex: {
        actionIds: ['github', 'mcp', 'channel'],
        recommended: 'github'
    },
    'gemini-cli': {
        actionIds: ['github', 'mcp', 'channel'],
        recommended: 'github'
    },
    hermes: {
        actionIds: ['skills', 'channel', 'automation'],
        recommended: 'skills'
    },
    openclaw: {
        actionIds: ['channel', 'native', 'automation'],
        recommended: 'channel'
    },
    narranexus: {
        actionIds: ['native', 'channel'],
        recommended: 'native'
    },
    dify: {
        actionIds: ['provider', 'channel', 'automation'],
        recommended: 'provider'
    },
    langflow: {
        actionIds: ['provider', 'channel', 'automation'],
        recommended: 'provider'
    },
    a2a: {
        actionIds: ['a2a'],
        recommended: 'a2a'
    }
}

// The API can name a framework this build has never heard of (server ships
// first). An unknown one costs the launchpad, not the whole chat page.
export const newChatLaunchpadConfigFor = (
    framework: AgentFramework
): NewChatLaunchpadConfig | null =>
    Object.hasOwn(NEW_CHAT_LAUNCHPAD_CONFIG, framework)
        ? NEW_CHAT_LAUNCHPAD_CONFIG[framework]
        : null

// Which chat someone lives in is a fact about their workplace, not about the
// agent's framework, and no framework signal predicts it. Rather than pick one
// and be wrong for everyone else, the row rotates through what that market
// actually uses — the reader sees a provider they can recognise, and no single
// one soaks up every impression.
const CHANNEL_POOLS = {
    zh: ['weixin', 'feishu'],
    default: ['slack', 'telegram', 'whatsapp']
} as const satisfies Record<string, readonly CreateProviderChoice[]>

export const channelPoolFor = (
    language: string
): readonly CreateProviderChoice[] =>
    language === 'zh' ? CHANNEL_POOLS.zh : CHANNEL_POOLS.default

export const pickChannelProvider = (language: string): CreateProviderChoice => {
    const pool = channelPoolFor(language)
    return pool[Math.floor(Math.random() * pool.length)] ?? pool[0]
}
