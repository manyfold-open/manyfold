import type { InferenceProtocol, UserModelProvider } from './dtos'
import { compatibleProtocolsForProvider } from './inference-protocol'
import type { ModelPriceSource } from './modelPrices'

export type ModelsListShape = 'openai' | 'google' | 'netmind'

export interface BuiltInProviderProtocol {
    protocol: InferenceProtocol
    baseUrl: string
}

export interface BuiltInProviderEntry {
    id: string
    label: string
    description?: string
    brand: UserModelProvider | null
    protocols: readonly BuiltInProviderProtocol[]
    modelsListUrl: string
    modelsListShape: ModelsListShape
    modelsListAuth: 'bearer' | 'anthropic' | 'google_query'
    // The table this channel is priced from, when it publishes its own rates. A
    // gateway resells other labs' models at its own price, so the public tables
    // describe the wrong number for it: set this and the automatic matcher uses
    // ONLY this table for this provider, and never offers it to another one.
    priceSource?: ModelPriceSource
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderEntry[] = [
    {
        id: 'netmind',
        label: 'NetMind API',
        description:
            'NetMind unified gateway exposing anthropic, openai-compatible and gemini endpoints.',
        brand: null,
        protocols: [
            {
                protocol: 'anthropic_messages',
                baseUrl: 'https://api.netmind.ai/inference-api/anthropic'
            },
            {
                protocol: 'openai_responses',
                baseUrl: 'https://api.netmind.ai/inference-api/openai/v1'
            },
            {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://api.netmind.ai/inference-api/openai/v1'
            },
            {
                protocol: 'google_generate_content',
                baseUrl: 'https://api.netmind.ai/inference-api/gemini'
            }
        ],
        modelsListUrl: 'https://api.netmind.ai/v1/model?page_size=500',
        modelsListShape: 'netmind',
        modelsListAuth: 'bearer',
        priceSource: 'netmind'
    },
    {
        id: 'anthropic-cloud',
        label: 'Anthropic',
        description: "Anthropic's official cloud API.",
        brand: 'anthropic',
        protocols: [
            {
                protocol: 'anthropic_messages',
                baseUrl: 'https://api.anthropic.com'
            }
        ],
        modelsListUrl: 'https://api.anthropic.com/v1/models',
        modelsListShape: 'openai',
        modelsListAuth: 'anthropic'
    },
    {
        id: 'openai-cloud',
        label: 'OpenAI',
        description: "OpenAI's official cloud API.",
        brand: 'openai',
        protocols: [
            {
                protocol: 'openai_responses',
                baseUrl: 'https://api.openai.com/v1'
            },
            {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://api.openai.com/v1'
            }
        ],
        modelsListUrl: 'https://api.openai.com/v1/models',
        modelsListShape: 'openai',
        modelsListAuth: 'bearer'
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        description: 'OpenRouter aggregated model gateway.',
        brand: 'openrouter',
        protocols: [
            {
                protocol: 'openai_chat_completions',
                baseUrl: 'https://openrouter.ai/api/v1'
            }
        ],
        modelsListUrl: 'https://openrouter.ai/api/v1/models',
        modelsListShape: 'openai',
        modelsListAuth: 'bearer'
    },
    {
        id: 'google-gemini',
        label: 'Google Gemini',
        description: "Google Gemini's official API.",
        brand: 'google',
        protocols: [
            {
                protocol: 'google_generate_content',
                baseUrl: 'https://generativelanguage.googleapis.com'
            }
        ],
        modelsListUrl:
            'https://generativelanguage.googleapis.com/v1beta/models',
        modelsListShape: 'google',
        modelsListAuth: 'google_query'
    }
] as const

export const lookupBuiltIn = (
    id: string | null | undefined
): BuiltInProviderEntry | null => {
    if (!id) return null
    return BUILT_IN_PROVIDERS.find((entry) => entry.id === id) ?? null
}

export const builtInBaseUrlForProtocol = (
    entry: BuiltInProviderEntry,
    protocol: InferenceProtocol
): string | null => {
    const match = entry.protocols.find((p) => p.protocol === protocol)
    return match?.baseUrl ?? null
}

export const builtInSupportsProtocol = (
    entry: BuiltInProviderEntry,
    protocols: InferenceProtocol | readonly InferenceProtocol[]
): InferenceProtocol | null => {
    const candidates = Array.isArray(protocols) ? protocols : [protocols]
    for (const candidate of candidates) {
        if (entry.protocols.some((p) => p.protocol === candidate))
            return candidate
    }
    return null
}

export const BUILT_IN_PROVIDER_IDS: readonly string[] = BUILT_IN_PROVIDERS.map(
    (e) => e.id
)

const MANAGED_PROTOCOL_TO_BRAND: Partial<
    Record<InferenceProtocol, UserModelProvider>
> = {
    anthropic_messages: 'anthropic',
    openai_responses: 'openai',
    google_generate_content: 'google'
}

export const brandFor = (row: {
    builtInId: string | null
    inferenceProtocol: InferenceProtocol | null
    source: 'byo' | 'managed'
    managedBrand?: UserModelProvider | null
}): UserModelProvider | null => {
    if (row.builtInId) return lookupBuiltIn(row.builtInId)?.brand ?? null
    if (row.source === 'managed') {
        if (row.managedBrand) return row.managedBrand
        if (row.inferenceProtocol)
            return MANAGED_PROTOCOL_TO_BRAND[row.inferenceProtocol] ?? null
    }
    return null
}

export const providerProtocolForTarget = (
    row: {
        builtInId: string | null
        inferenceProtocol: InferenceProtocol | null
    },
    provider: UserModelProvider
): InferenceProtocol | null => {
    const protocols = compatibleProtocolsForProvider(provider)
    if (row.builtInId) {
        const entry = lookupBuiltIn(row.builtInId)
        return entry ? builtInSupportsProtocol(entry, protocols) : null
    }
    if (!row.inferenceProtocol) return null
    return protocols.includes(row.inferenceProtocol)
        ? row.inferenceProtocol
        : null
}

export const providerSupportsTarget = (
    row: {
        builtInId: string | null
        inferenceProtocol: InferenceProtocol | null
    },
    provider: UserModelProvider
): boolean => providerProtocolForTarget(row, provider) !== null
