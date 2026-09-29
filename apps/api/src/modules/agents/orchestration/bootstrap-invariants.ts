import {
    NETMIND_PROXY_BASE_URL,
    OFFICIAL_PROVIDER_BASE_URL
} from '@manyfold/shared'

export interface AnthropicBaseUrlInput {
    source: 'platform' | 'byo'
    byoBaseUrl?: string
}

export const resolveAnthropicBaseUrl = (
    input: AnthropicBaseUrlInput
): string => {
    if (input.source === 'platform') return NETMIND_PROXY_BASE_URL
    return input.byoBaseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.anthropic
}
