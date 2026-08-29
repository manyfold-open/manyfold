import { protocolToHermesBrand } from '@manyfold/shared'
import { randomBytes } from 'node:crypto'
import type { ResolvedHermesCredentials } from '@/modules/agents/credentials/resolved-credentials'

export const HERMES_PORT = 8642
export const HERMES_DASHBOARD_PORT = 9119
// Sprite front proxy (mf-front-proxy.mjs) — owns the sprite's public
// http_port while the dashboard is enabled, splitting /v1 (gateway) from the
// dashboard web server.
export const HERMES_PROXY_PORT = 18642
export const HERMES_WEB_DIST = '/opt/hermes/hermes-agent/hermes_cli/web_dist'

export interface HermesEnvOptions {
    creds: ResolvedHermesCredentials
    apiServerKey: string
    dashboardEnabled: boolean
}

export const generateHermesApiServerKey = (
    existing?: string | null
): string => existing ?? randomBytes(32).toString('hex')

/**
 * Hermes calls "openai" via a "custom" provider in its config (any OpenAI-
 * compatible HTTP endpoint — real OpenAI, NetMind proxy, Azure, vLLM, etc.).
 * Other built-in providers (openrouter, anthropic, etc.) keep their own
 * provider key and read from provider-specific env vars (OPENROUTER_API_KEY,
 * ANTHROPIC_API_KEY, …).
 *
 * Mirrors `docker/hermes/entrypoint.sh` exactly.
 */
export const mapHermesProvider = (provider: string): string =>
    provider === 'openai' ? 'custom' : provider

const canonicalizeHermesBaseUrl = (raw: string): string => {
    const trimmed = raw.replace(/\/+$/, '')
    if (/\/v1$/.test(trimmed)) return trimmed
    return `${trimmed}/v1`
}

/**
 * Aliases the credentials' apiKey to the env var Hermes actually reads at
 * runtime per provider — see `website/docs/reference/environment-variables.md`
 * in the hermes-agent install. Without this, Hermes logs
 * "No inference provider configured" and emits empty SSE streams.
 */
export const hermesProviderAliasEnv = (
    provider: string,
    apiKey: string
): Record<string, string> => {
    if (!apiKey) return {}
    if (provider === 'openrouter') return { OPENROUTER_API_KEY: apiKey }
    if (provider === 'openai') return { OPENAI_API_KEY: apiKey }
    if (provider === 'anthropic') return { ANTHROPIC_API_KEY: apiKey }
    return {}
}

interface HermesConfigYamlOptions {
    profile: string
    provider: string
    modelName?: string
    baseUrl?: string
    apiKey?: string
}

/**
 * Generates `~/.hermes/config.yaml` content matching what
 * `docker/hermes/entrypoint.sh` lays down. The provider name is the
 * already-mapped value (use `mapHermesProvider` first).
 */
export const buildHermesConfigYaml = (opts: HermesConfigYamlOptions): string => {
    const lines: string[] = []
    lines.push(`profile: ${opts.profile}`)
    lines.push('model:')
    lines.push(`  provider: ${opts.provider}`)
    if (opts.modelName) lines.push(`  default: ${opts.modelName}`)
    if (opts.baseUrl)
        lines.push(`  base_url: ${canonicalizeHermesBaseUrl(opts.baseUrl)}`)
    if (opts.provider === 'custom' && opts.apiKey)
        lines.push(`  api_key: ${opts.apiKey}`)
    lines.push('platforms: {}')
    return lines.join('\n') + '\n'
}

export const buildHermesEnv = (
    opts: HermesEnvOptions
): Record<string, string> => {
    const { creds, apiServerKey, dashboardEnabled } = opts
    const env: Record<string, string> = {
        // `hermes gateway` force-sets HERMES_EXEC_ASK=1, so every exec blocks on
        // an approval the OpenAI-compat chat path can never deliver (no interactive
        // approver) and the agent deadlocks asking to be approved. YOLO bypasses the
        // approval gate; the sprite VM is the isolation boundary. Mirrors the daemon
        // ACP client (hermes-acp-client.ts).
        HERMES_YOLO_MODE: '1',
        API_SERVER_ENABLED: 'true',
        API_SERVER_HOST: '0.0.0.0',
        API_SERVER_PORT: String(HERMES_PORT),
        API_SERVER_KEY: apiServerKey,
        HERMES_PORT: String(HERMES_PORT),
        HERMES_PROFILE: creds.profile ?? 'default',
        HERMES_DASHBOARD_ENABLED: dashboardEnabled ? 'true' : 'false',
        HERMES_DASHBOARD_PORT: String(HERMES_DASHBOARD_PORT),
        HERMES_WEB_DIST: HERMES_WEB_DIST
    }
    const hermesBrand = creds.inferenceProtocol
        ? protocolToHermesBrand(creds.inferenceProtocol)
        : (creds.primaryModelProvider ?? null)
    if (hermesBrand) env.HERMES_PRIMARY_MODEL_PROVIDER = hermesBrand
    if (creds.primaryModelApiKey)
        env.HERMES_PRIMARY_MODEL_API_KEY = creds.primaryModelApiKey
    if (creds.primaryModelName)
        env.HERMES_PRIMARY_MODEL_NAME = creds.primaryModelName
    if (creds.primaryModelBaseUrl)
        env.HERMES_PRIMARY_MODEL_BASE_URL = creds.primaryModelBaseUrl
    if (creds.telegramBotToken)
        env.HERMES_TELEGRAM_BOT_TOKEN = creds.telegramBotToken
    if (creds.discordBotToken)
        env.HERMES_DISCORD_BOT_TOKEN = creds.discordBotToken
    if (creds.slackAppToken) env.HERMES_SLACK_APP_TOKEN = creds.slackAppToken
    if (creds.whatsappToken) env.HERMES_WHATSAPP_TOKEN = creds.whatsappToken
    if (creds.signalToken) env.HERMES_SIGNAL_TOKEN = creds.signalToken
    if (creds.matrixAccessToken)
        env.HERMES_MATRIX_ACCESS_TOKEN = creds.matrixAccessToken
    if (creds.matrixHomeserver)
        env.HERMES_MATRIX_HOMESERVER = creds.matrixHomeserver
    if (creds.homeAssistantToken)
        env.HERMES_HOMEASSISTANT_TOKEN = creds.homeAssistantToken
    if (creds.emailConfig) {
        env.HERMES_EMAIL_HOST = creds.emailConfig.host
        env.HERMES_EMAIL_PORT = String(creds.emailConfig.port)
        env.HERMES_EMAIL_USER = creds.emailConfig.user
        env.HERMES_EMAIL_PASSWORD = creds.emailConfig.password
    }
    return env
}
