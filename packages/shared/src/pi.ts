import { OFFICIAL_PROVIDER_BASE_URL } from './constants'
import type { InferenceProtocol } from './dtos'

/* pi (pi.dev) is one CLI in front of many model providers. Manyfold binds a
   pi agent to ONE saved/managed provider, and that provider's wire protocol
   decides which of pi's built-in providers the turn selects, which env var
   carries the key, and which `--model <provider>/<id>` prefix is valid. Only
   the three vendor protocols pi speaks natively are offered; openai-compatible
   gateways would need a custom models.json provider entry and are out of
   scope until a use case asks for them. */
export const PI_PROVIDERS = ['anthropic', 'openai', 'google'] as const
export type PiProvider = (typeof PI_PROVIDERS)[number]

export const isPiProvider = (value: unknown): value is PiProvider =>
    typeof value === 'string' &&
    (PI_PROVIDERS as readonly string[]).includes(value)

const PROVIDER_BY_PROTOCOL: Partial<Record<InferenceProtocol, PiProvider>> = {
    anthropic_messages: 'anthropic',
    openai_responses: 'openai',
    google_generate_content: 'google'
}

export const piProviderForProtocol = (
    protocol: InferenceProtocol
): PiProvider | null => PROVIDER_BY_PROTOCOL[protocol] ?? null

export const isPiProtocol = (protocol: InferenceProtocol): boolean =>
    piProviderForProtocol(protocol) !== null

export const PI_PROTOCOL_BY_PROVIDER: Record<PiProvider, InferenceProtocol> = {
    anthropic: 'anthropic_messages',
    openai: 'openai_responses',
    google: 'google_generate_content'
}

// The env var pi's built-in provider reads its key from (pi-ai
// env-api-keys.ts). Measured on macOS dev [2026-09-10]: pi's anthropic provider
// prefers ANTHROPIC_AUTH_TOKEN (sent as a Bearer header) over ANTHROPIC_API_KEY
// when both are set, and an auth.json entry beats every env var — on a sprite
// or pod neither exists, so the injected key is the one that is used.
export const PI_API_KEY_ENV: Record<PiProvider, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY'
}

// pi hardcodes each built-in provider's base URL and reads no *_BASE_URL env;
// a gateway can only be reached by overriding `providers.<id>.baseUrl` in
// ~/.pi/agent/models.json. Official means "no override file needed".
export const PI_OFFICIAL_BASE_URL: Record<PiProvider, string> = {
    anthropic: OFFICIAL_PROVIDER_BASE_URL.anthropic,
    openai: OFFICIAL_PROVIDER_BASE_URL.openai,
    google: OFFICIAL_PROVIDER_BASE_URL.google
}

const normalizeBaseUrl = (url: string): string =>
    url.trim().replace(/\/+$/, '').toLowerCase()

export const isOfficialPiBaseUrl = (
    provider: PiProvider,
    baseUrl: string | null | undefined
): boolean => {
    const trimmed = baseUrl?.trim()
    if (!trimmed) return true
    return (
        normalizeBaseUrl(trimmed) ===
        normalizeBaseUrl(PI_OFFICIAL_BASE_URL[provider])
    )
}

// Built-in model ids as pi 0.85.1 names them (`pi --list-models`); the
// composer offers these when the agent's provider has no catalog of its own.
export const PI_DEFAULT_MODEL: Record<PiProvider, string> = {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-5.5',
    google: 'gemini-2.5-pro'
}

export const PI_MODEL_PRESETS: readonly string[] = [
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4-7',
    'openai/gpt-5.5',
    'openai/gpt-5.6-sol',
    'google/gemini-2.5-pro',
    'google/gemini-3.5-flash'
]

export interface PiQualifiedModel {
    // Always `<provider>/<id>`: pi's default provider depends on whatever
    // credentials the host happens to have, so a bare id must never reach it.
    model: string
    // The provider prefix the caller wrote when it names a different provider
    // than the agent's credentials — a turn that would authenticate against
    // the wrong vendor, refused before exec.
    providerMismatch: string | null
}

export const piQualifiedModel = (
    model: string | null | undefined,
    provider: PiProvider
): PiQualifiedModel => {
    const trimmed = model?.trim() ?? ''
    if (!trimmed)
        return {
            model: `${provider}/${PI_DEFAULT_MODEL[provider]}`,
            providerMismatch: null
        }
    const slash = trimmed.indexOf('/')
    if (slash === -1)
        return { model: `${provider}/${trimmed}`, providerMismatch: null }
    const prefix = trimmed.slice(0, slash)
    return {
        model: trimmed,
        providerMismatch: prefix === provider ? null : prefix
    }
}

// The model half of a qualified id, for pricing lookups keyed on bare ids.
export const piBareModelId = (model: string): string => {
    const slash = model.indexOf('/')
    return slash === -1 ? model : model.slice(slash + 1)
}
