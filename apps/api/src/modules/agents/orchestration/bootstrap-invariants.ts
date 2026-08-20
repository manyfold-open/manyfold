import {
    NETMIND_PROXY_BASE_URL,
    OFFICIAL_PROVIDER_BASE_URL
} from '@manyfold/shared'
import type { NetworkPolicy } from '@manyfold/sprites'

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

export const defaultNetworkPolicy = (): NetworkPolicy => {
    // sprites.dev treats an empty rule list as wide-open outbound access.
    return { rules: [] }
}
