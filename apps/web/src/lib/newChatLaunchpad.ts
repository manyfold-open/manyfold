import type { AgentFramework } from '@manyfold/shared'

export type NewChatPromptKey =
    | 'web.chat.launchpad.prompts.claudeCode.architecture'
    | 'web.chat.launchpad.prompts.claudeCode.checks'
    | 'web.chat.launchpad.prompts.claudeCode.improvement'
    | 'web.chat.launchpad.prompts.codex.developmentPath'
    | 'web.chat.launchpad.prompts.codex.reviewChanges'
    | 'web.chat.launchpad.prompts.codex.smallImprovement'
    | 'web.chat.launchpad.prompts.gemini.architecture'
    | 'web.chat.launchpad.prompts.gemini.screenshot'
    | 'web.chat.launchpad.prompts.gemini.tests'
    | 'web.chat.launchpad.prompts.hermes.plan'
    | 'web.chat.launchpad.prompts.hermes.research'
    | 'web.chat.launchpad.prompts.hermes.brief'
    | 'web.chat.launchpad.prompts.openclaw.briefing'
    | 'web.chat.launchpad.prompts.openclaw.tasks'
    | 'web.chat.launchpad.prompts.openclaw.automation'
    | 'web.chat.launchpad.prompts.narranexus.plan'
    | 'web.chat.launchpad.prompts.narranexus.review'
    | 'web.chat.launchpad.prompts.narranexus.context'
    | 'web.chat.launchpad.prompts.dify.capabilities'
    | 'web.chat.launchpad.prompts.dify.test'
    | 'web.chat.launchpad.prompts.dify.missingInput'
    | 'web.chat.launchpad.prompts.langflow.contract'
    | 'web.chat.launchpad.prompts.langflow.test'
    | 'web.chat.launchpad.prompts.langflow.missingInput'
    | 'web.chat.launchpad.prompts.a2a.card'
    | 'web.chat.launchpad.prompts.a2a.task'
    | 'web.chat.launchpad.prompts.a2a.delegate'

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
    promptKeys: readonly NewChatPromptKey[]
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
        promptKeys: [
            'web.chat.launchpad.prompts.claudeCode.architecture',
            'web.chat.launchpad.prompts.claudeCode.checks',
            'web.chat.launchpad.prompts.claudeCode.improvement'
        ],
        actionIds: ['github', 'skills', 'channel'],
        recommended: 'github'
    },
    codex: {
        promptKeys: [
            'web.chat.launchpad.prompts.codex.developmentPath',
            'web.chat.launchpad.prompts.codex.reviewChanges',
            'web.chat.launchpad.prompts.codex.smallImprovement'
        ],
        actionIds: ['github', 'mcp', 'channel'],
        recommended: 'github'
    },
    'gemini-cli': {
        promptKeys: [
            'web.chat.launchpad.prompts.gemini.architecture',
            'web.chat.launchpad.prompts.gemini.screenshot',
            'web.chat.launchpad.prompts.gemini.tests'
        ],
        actionIds: ['github', 'mcp', 'channel'],
        recommended: 'github'
    },
    hermes: {
        promptKeys: [
            'web.chat.launchpad.prompts.hermes.plan',
            'web.chat.launchpad.prompts.hermes.research',
            'web.chat.launchpad.prompts.hermes.brief'
        ],
        actionIds: ['skills', 'channel', 'automation'],
        recommended: 'skills'
    },
    openclaw: {
        promptKeys: [
            'web.chat.launchpad.prompts.openclaw.briefing',
            'web.chat.launchpad.prompts.openclaw.tasks',
            'web.chat.launchpad.prompts.openclaw.automation'
        ],
        actionIds: ['channel', 'native', 'automation'],
        recommended: 'channel'
    },
    narranexus: {
        promptKeys: [
            'web.chat.launchpad.prompts.narranexus.plan',
            'web.chat.launchpad.prompts.narranexus.review',
            'web.chat.launchpad.prompts.narranexus.context'
        ],
        actionIds: ['native', 'channel'],
        recommended: 'native'
    },
    dify: {
        promptKeys: [
            'web.chat.launchpad.prompts.dify.capabilities',
            'web.chat.launchpad.prompts.dify.test',
            'web.chat.launchpad.prompts.dify.missingInput'
        ],
        actionIds: ['provider', 'channel', 'automation'],
        recommended: 'provider'
    },
    langflow: {
        promptKeys: [
            'web.chat.launchpad.prompts.langflow.contract',
            'web.chat.launchpad.prompts.langflow.test',
            'web.chat.launchpad.prompts.langflow.missingInput'
        ],
        actionIds: ['provider', 'channel', 'automation'],
        recommended: 'provider'
    },
    a2a: {
        promptKeys: [
            'web.chat.launchpad.prompts.a2a.card',
            'web.chat.launchpad.prompts.a2a.task',
            'web.chat.launchpad.prompts.a2a.delegate'
        ],
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
