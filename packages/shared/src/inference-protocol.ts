import type { AgentFramework } from './constants'
import type {
    HermesModelProvider,
    InferenceProtocol,
    OpenclawModelProvider,
    UserModelProvider,
    UserModelProviderSource
} from './dtos'

export const defaultProtocolForProvider = (
    provider: UserModelProvider
): InferenceProtocol => {
    if (provider === 'anthropic') return 'anthropic_messages'
    if (provider === 'antigravity_claude') return 'anthropic_messages'
    if (provider === 'openai') return 'openai_responses'
    if (provider === 'openrouter') return 'openai_chat_completions'
    return 'google_generate_content'
}

export const compatibleProtocolsForProvider = (
    provider: UserModelProvider
): readonly InferenceProtocol[] => {
    if (provider === 'anthropic') return ['anthropic_messages']
    if (provider === 'antigravity_claude') return ['anthropic_messages']
    if (provider === 'openai')
        return ['openai_responses', 'openai_chat_completions']
    if (provider === 'openrouter') return ['openai_chat_completions']
    return ['google_generate_content']
}

const PROTOCOL_TO_OPENCLAW_BRAND: Record<
    InferenceProtocol,
    OpenclawModelProvider | null
> = {
    anthropic_messages: 'anthropic',
    openai_chat_completions: 'openai',
    openai_responses: 'openai',
    mistral_chat_completions: 'openai',
    google_generate_content: null
}

export const protocolToOpenclawBrand = (
    protocol: InferenceProtocol
): OpenclawModelProvider | null => PROTOCOL_TO_OPENCLAW_BRAND[protocol]

const PROTOCOL_TO_HERMES_BRAND: Record<
    InferenceProtocol,
    HermesModelProvider | null
> = {
    anthropic_messages: 'anthropic',
    openai_chat_completions: 'openai',
    openai_responses: 'openai',
    mistral_chat_completions: 'openai',
    google_generate_content: null
}

export const protocolToHermesBrand = (
    protocol: InferenceProtocol
): HermesModelProvider | null => PROTOCOL_TO_HERMES_BRAND[protocol]

// Managed Anthropic routes through Claude.ai's "third-party app"
// billing path, which throttles tool-rich agent requests with the "extra usage"
// error after the shared account's per-window cap. OpenClaw and Hermes both
// inject large tool catalogs into every request, so they hit this cap aggressively.
// BYO Anthropic keys talk directly to api.anthropic.com and are unaffected.
export const isManagedProtocolAllowedForFramework = (
    framework: AgentFramework,
    source: UserModelProviderSource,
    protocol: InferenceProtocol
): boolean => {
    if (source !== 'managed') return true
    if (framework === 'openclaw' || framework === 'hermes') {
        return protocol !== 'anthropic_messages'
    }
    return true
}

// Which wire protocols each agent framework can actually talk. Mirrors the
// assertProtocol() narrowing inside CredentialsResolverService — keep both in
// sync. Frameworks not in the switch (narranexus / dify / langflow) don't go
// through the saved-provider picker, so they return true as a safe default.
export const frameworkSupportsProtocol = (
    framework: AgentFramework,
    protocol: InferenceProtocol
): boolean => {
    if (framework === 'claude-code') return protocol === 'anthropic_messages'
    if (framework === 'codex') return protocol === 'openai_responses'
    if (framework === 'gemini-cli')
        return protocol === 'google_generate_content'
    if (framework === 'openclaw' || framework === 'hermes') {
        return (
            protocol === 'anthropic_messages' ||
            protocol === 'openai_chat_completions' ||
            protocol === 'openai_responses' ||
            protocol === 'mistral_chat_completions'
        )
    }
    return true
}
