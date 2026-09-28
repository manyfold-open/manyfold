import {
    DEFAULT_CLI_API_URL,
    apiPaths,
    isLoopbackHostname
} from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'

export interface AgentSetupTarget {
    guideUrl: string
    host: string
    local: boolean
    production: boolean
}

// The deployment a copied prompt connects an agent to. Production is the API a
// fresh mf defaults to, the same comparison daemonCommands makes; anything
// else gets a sentence that keeps the agent off the user's other mf logins.
export const agentSetupTarget = (apiBase: string): AgentSetupTarget => {
    const base = apiBase.replace(/\/+$/, '')
    const url = new URL(base)
    return {
        guideUrl: `${base}${apiPaths.AGENT_SETUP_GUIDE}`,
        host: url.host,
        local: isLoopbackHostname(url.hostname),
        production: base === DEFAULT_CLI_API_URL
    }
}

export const buildAgentSetupPrompt = (
    t: TFn,
    target: AgentSetupTarget
): string => {
    const sentences = [t('web.useInAgent.prompt', { url: target.guideUrl })]
    if (target.local)
        sentences.push(t('web.useInAgent.promptLocal', { host: target.host }))
    else if (!target.production)
        sentences.push(t('web.useInAgent.promptOther', { host: target.host }))
    return sentences.join(' ')
}
