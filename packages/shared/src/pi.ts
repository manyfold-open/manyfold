import { OFFICIAL_PROVIDER_BASE_URL } from './constants'
import type { InferenceProtocol } from './dtos'

/* pi (pi.dev) is one CLI in front of many model providers. Manyfold binds a
   pi agent to ONE saved/managed provider, and that provider's wire protocol
   decides which of pi's built-in providers the turn selects, which env var
   carries the key, and which `--model <provider>/<id>` prefix is valid. Only
   the three vendor protocols pi speaks natively are offered; a gateway
   speaking one of them is the built-in provider with its base URL
   overridden. */
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
// env-api-keys.ts). An auth.json entry beats every env var; on a sprite or pod
// there is none, so the injected key is the one that is used.
export const PI_API_KEY_ENV: Record<PiProvider, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY'
}

// Env vars pi reads BEFORE the one above (pi-ai providers/anthropic.ts: a
// bearer token, then an OAuth token, then the key). A daemon hands a turn the
// machine's own environment, so a turn that injects a key sets these empty —
// pi skips an empty value — or a token exported for another tool would answer
// in its place. Seen on macOS dev [2026-09-23]: a daemon started from a shell
// exporting ANTHROPIC_AUTH_TOKEN sent that token as the bearer.
export const PI_OUTRANKING_KEY_ENV: Record<PiProvider, readonly string[]> = {
    anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
    openai: [],
    google: []
}

// pi hardcodes each built-in provider's base URL and reads no *_BASE_URL env;
// a gateway can only be reached by overriding `providers.<id>.baseUrl` in the
// agent directory's models.json. Official means "no override file needed".
export const PI_OFFICIAL_BASE_URL: Record<PiProvider, string> = {
    anthropic: OFFICIAL_PROVIDER_BASE_URL.anthropic,
    openai: OFFICIAL_PROVIDER_BASE_URL.openai,
    google: OFFICIAL_PROVIDER_BASE_URL.google
}

const normalizeBaseUrl = (url: string): string =>
    url.trim().replace(/\/+$/, '').toLowerCase()

const GOOGLE_API_VERSION = /\/v1(?:alpha|beta)?$/i

// The base URL pi's built-in provider must be pointed at for a stored
// endpoint. Manyfold keeps Gemini endpoints the way gemini-cli takes them —
// the root, with the client adding `/v1beta` — but pi's google provider uses
// an override verbatim and appends no version, so it is added here. Anthropic
// and OpenAI endpoints mean the same thing to both.
export const piProviderBaseUrl = (
    provider: PiProvider,
    baseUrl: string
): string => {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    if (provider !== 'google' || GOOGLE_API_VERSION.test(trimmed))
        return trimmed
    return `${trimmed}/v1beta`
}

export const isOfficialPiBaseUrl = (
    provider: PiProvider,
    baseUrl: string | null | undefined
): boolean => {
    const trimmed = baseUrl?.trim()
    if (!trimmed) return true
    return (
        normalizeBaseUrl(piProviderBaseUrl(provider, trimmed)) ===
        normalizeBaseUrl(
            piProviderBaseUrl(provider, PI_OFFICIAL_BASE_URL[provider])
        )
    )
}

// Built-in model ids as pi names them (`pi --list-models`, 0.87.1); the one a
// turn runs on when neither the agent nor the composer picked a model.
export const PI_DEFAULT_MODEL: Record<PiProvider, string> = {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-5.5',
    google: 'gemini-2.5-pro'
}

export interface PiQualifiedModel {
    // Always `<provider>/<id>`: pi's default provider depends on whatever
    // credentials the host happens to have, so a bare id must never reach it.
    model: string
    // The provider prefix the caller wrote when it names a different provider
    // than the agent's credentials — a turn that would authenticate against
    // the wrong vendor, refused before exec.
    providerMismatch: string | null
}

// What counts as the id depends on the endpoint. A vendor's own API names its
// models without slashes, so a `<vendor>/` prefix there is a qualification,
// and one naming another vendor is refused. A gateway's ids routinely carry
// slashes (`deepseek-ai/DeepSeek-V3`, `openai/gpt-oss-120b`), so there the
// whole string is the id — pi takes an id it does not know as a custom one.
export const piQualifiedModel = (
    model: string | null | undefined,
    provider: PiProvider,
    baseUrl?: string | null
): PiQualifiedModel => {
    const trimmed = model?.trim() ?? ''
    if (!trimmed)
        return {
            model: `${provider}/${PI_DEFAULT_MODEL[provider]}`,
            providerMismatch: null
        }
    if (!isOfficialPiBaseUrl(provider, baseUrl))
        return { model: `${provider}/${trimmed}`, providerMismatch: null }
    const slash = trimmed.indexOf('/')
    const prefix = slash === -1 ? null : trimmed.slice(0, slash)
    if (prefix === provider) return { model: trimmed, providerMismatch: null }
    if (isPiProvider(prefix))
        return { model: trimmed, providerMismatch: prefix }
    return { model: `${provider}/${trimmed}`, providerMismatch: null }
}

// The id half of a qualified model — what the provider bills it under.
export const piModelId = (qualified: string): string =>
    qualified.slice(qualified.indexOf('/') + 1)

// The env vars pi reads a key from for the providers it ships (pi docs
// providers.md, 0.87.1), named in credential facts when set — the value never
// is. A cloud credential chain (AWS, Vertex) is not listed: pi's own model
// list is what finally says whether a provider is usable.
export const PI_PROVIDER_KEY_ENV = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'MISTRAL_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'XAI_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_GATEWAY_API_KEY',
    'COPILOT_GITHUB_TOKEN',
    'NVIDIA_API_KEY',
    'ZAI_API_KEY',
    'OPENCODE_API_KEY',
    'HF_TOKEN',
    'FIREWORKS_API_KEY',
    'TOGETHER_API_KEY',
    'KIMI_API_KEY',
    'MOONSHOT_API_KEY',
    'MINIMAX_API_KEY',
    'QWEN_TOKEN_PLAN_API_KEY'
] as const

// `pi --list-models` prints one row per model it holds a credential for —
// `provider  model  context  max-out  thinking  images` under a header, or a
// "No models available" line when it holds none — so its output is pi's own
// answer to "what can run here". Measured on macOS dev [2026-09-24] with pi
// 0.87.1. Returns the qualified ids, in pi's order.
export const parsePiListModels = (stdout: string): string[] => {
    const out: string[] = []
    let header = false
    for (const line of stdout.split(/\r?\n/)) {
        const cells = line.trim().split(/\s+/)
        if (cells.length < 2 || !cells[0]) continue
        if (!header) {
            header = cells[0] === 'provider' && cells[1] === 'model'
            continue
        }
        const qualified = `${cells[0]}/${cells[1]}`
        if (!out.includes(qualified)) out.push(qualified)
    }
    return out
}
