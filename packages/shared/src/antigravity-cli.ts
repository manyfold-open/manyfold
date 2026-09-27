// Antigravity CLI (`agy`): the facts more than one surface reads about how the
// platform runs it. Measured on agy 1.2.11 (Linux arm64 container and macOS,
// 2026-09-26) unless a line says otherwise.

import type { AgentModelConfigOption } from './model-config'
import type { UserModelProviderSummary } from './dtos'
import { providerModelIdsForProtocol } from './model-config'

export const AGY_BIN = 'agy'

// App data under the user's home: settings.json, the per-conversation
// transcript (brain/<id>/.system_generated/logs/transcript.jsonl) and history.
export const AGY_APP_DIR = '.gemini/antigravity-cli'

// Every platform-driven run of agy on a host the platform installed it on
// carries this, so the version there stays the one the platform installed.
export const AGY_MANAGED_HOST_ENV: Readonly<Record<string, string>> = {
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true'
}

// agy accepts a key only in its API-key mode, which a settings file turns on,
// so an ambient key alone never outranks the machine's sign-in. These are the
// variables that could still steer a platform turn somewhere else: another
// Google credential, another endpoint or account path, another data dir.
export const AGY_PLATFORM_OUTRANKING_ENV = [
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    'GOOGLE_GENAI_USE_ENTERPRISE',
    'AGY_ADC_AUTH',
    'AGY_GATEWAY_URL',
    'AGY_GATEWAY_API_KEY',
    'AGY_GATEWAY_HEADERS',
    'AGY_GATEWAY_MODELS',
    'AGY_PROXY_URL',
    'JETSKI_APP_DATA_DIR'
] as const

// agy mints its conversation ids (a `--conversation` it does not know starts a
// new conversation under a fresh id), so a stored ref is always one of these.
const CONVERSATION_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isAntigravityConversationId = (value: unknown): value is string =>
    typeof value === 'string' && CONVERSATION_ID_RE.test(value)

// The models agy's API-key mode offers (`agy models`), each a model plus its
// reasoning effort, and the Gemini API id it calls for it. A gateway serving
// agy must serve those ids; agy also calls `AGY_TITLE_MODEL` once per new
// conversation, and a failure there does not fail the turn.
export interface AntigravityApiKeyModel {
    slug: string
    upstream: string
}

export const AGY_API_KEY_MODELS: readonly AntigravityApiKeyModel[] = [
    { slug: 'gemini-3.1-pro-low', upstream: 'gemini-3.1-pro-preview' },
    {
        slug: 'gemini-3.1-pro-high',
        upstream: 'gemini-3.1-pro-preview-customtools'
    },
    { slug: 'gemini-3.8-flash-high', upstream: 'gemini-3.8-flash' },
    { slug: 'gemini-3.8-flash-medium', upstream: 'gemini-3.8-flash' },
    { slug: 'gemini-3.8-flash-low', upstream: 'gemini-3.8-flash' },
    { slug: 'gemini-3.7-flash-high', upstream: 'gemini-3.7-flash' },
    { slug: 'gemini-3.7-flash-medium', upstream: 'gemini-3.7-flash' },
    { slug: 'gemini-3.7-flash-low', upstream: 'gemini-3.7-flash' },
    { slug: 'gemini-3.6-flash-high', upstream: 'gemini-3.6-flash' },
    { slug: 'gemini-3.6-flash-medium', upstream: 'gemini-3.6-flash' },
    { slug: 'gemini-3.6-flash-low', upstream: 'gemini-3.6-flash' }
]

export const AGY_DEFAULT_API_KEY_MODEL = 'gemini-3.1-pro-low'
export const AGY_TITLE_MODEL = 'gemini-3.1-flash-lite-preview'

export const antigravityProviderModelIds = (
    provider: Pick<UserModelProviderSummary, 'lastTestModels' | 'enabledModels'>
): string[] | null => {
    const models = provider.lastTestModels?.google_generate_content
    if (!models) return null
    return providerModelIdsForProtocol(
        { google_generate_content: models },
        provider.enabledModels,
        'google_generate_content'
    ) ?? []
}

// agy sends the upstream ID itself; a provider's namespaced ID is not an alias.
export const resolveAntigravityModelOptions = (
    providerModels: readonly string[] | null
): AgentModelConfigOption[] =>
    AGY_API_KEY_MODELS.map(({ slug, upstream }) => {
        const enabled = providerModels?.includes(upstream) === true
        return {
            value: slug,
            label: slug,
            providerModel: upstream,
            enabled,
            reason: enabled
                ? null
                : providerModels === null
                  ? 'Test provider to verify Antigravity CLI upstream models.'
                  : `Provider does not offer enabled upstream model "${upstream}" required by "${slug}". Refresh its models or choose a compatible provider.`
        }
    })

// The Gemini API id a platform turn is billed under: what the gateway saw.
export const antigravityUpstreamModel = (slug: string | null): string =>
    AGY_API_KEY_MODELS.find((m) => m.slug === slug)?.upstream ??
    AGY_API_KEY_MODELS.find((m) => m.slug === AGY_DEFAULT_API_KEY_MODEL)!
        .upstream

// `agy models` prints one `<slug>\t<label>` line per model on stdout (a
// progress line goes to stderr). Anything that is not such a line is dropped.
export const parseAntigravityModelList = (
    stdout: string
): Array<{ slug: string; label: string }> =>
    stdout
        .split('\n')
        .map((line) => line.split('\t'))
        .filter(
            (parts): parts is [string, string] =>
                parts.length === 2 &&
                /^[a-z0-9][a-z0-9.-]*$/.test(parts[0].trim()) &&
                parts[1].trim().length > 0
        )
        .map(([slug, label]) => ({ slug: slug.trim(), label: label.trim() }))
