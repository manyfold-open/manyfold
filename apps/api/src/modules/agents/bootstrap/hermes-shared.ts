import {
    envTextToRecord,
    isSemverVersionTag,
    protocolToHermesBrand
} from '@manyfold/shared'
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
 * Generates the `~/.hermes/config.yaml` Hermes resolves its model and
 * provider from. The provider name is the already-mapped value (use
 * `mapHermesProvider` first).
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

// Where hermes lives under a host's hermes home: a sprite's or a pod host's
// (ADR-0035), laid out the same way.
export const hermesPaths = (home: string) => {
    const appDir = `${home}/hermes-agent`
    return {
        home,
        appDir,
        appBak: `${appDir}.bak`,
        bin: `${appDir}/venv/bin/hermes`,
        webDistDir: `${appDir}/hermes_cli/web_dist`
    }
}

// The CalVer tag is interpolated into the installer's `--branch` argument, so
// this is the gate that keeps a shell metacharacter out of it: a valid semver
// string cannot carry one, which is why admitting prereleases here does not
// widen the shell surface. Returns the trimmed value because the string that
// was validated is the string that must be interpolated.
const assertHermesVersion = (version: string): string => {
    if (!isSemverVersionTag(version))
        throw new Error(`invalid hermes version "${version}"`)
    return version.trim()
}

// NousResearch publishes the installer in the repository. `--skip-setup` skips
// the interactive onboarding wizard (we supply env vars). The git config
// rewrites switch SSH→HTTPS for pip dependencies hitting GitHub from a sprite
// where outbound SSH may be slow or blocked. A `ref` (CalVer tag) pins the
// CHECKOUT via the installer's `--branch`, which `git clone --depth 1 --branch`
// honours for tags, and the installer is read from that same tag; no ref keeps
// the historical `main` behaviour.
// Seen on a kind cloud computer [2026-09-25]: main's installer set up a `pm`
// package manager that the v2026.9.24 checkout does not have, so an install
// pinned to that tag failed with "No module named 'pm'".
export const buildHermesInstallScript = (ref?: string | null): string => {
    const installArgs = ['--skip-setup']
    const tag = ref ? assertHermesVersion(ref) : null
    if (tag) installArgs.push('--branch', tag)
    return [
        // pipefail: a failed download would hand bash an empty script, and
        // the pipeline would report the install done.
        'set -euo pipefail',
        'git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"',
        'git config --global url."https://github.com/".insteadOf "git@github.com:"',
        `curl --proto '=https' -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/${tag ?? 'main'}/scripts/install.sh | bash -s -- ${installArgs.join(' ')}`
    ].join(' && ')
}

// In-place version upgrade: re-run the installer pinned to a new tag. The old
// checkout is moved aside first so the installer does a clean clone (it would
// otherwise take its in-place "update" path, which can't fast-forward a detached
// tag); on any failure `set -e` aborts and the caller runs the restore shell to
// roll back. Config + sessions live in $HERMES_HOME OUTSIDE hermes-agent/ and are
// left untouched. Caller stops the service before and starts it after.
export const buildHermesRebuildShell = (
    version: string,
    home: string
): string => {
    const tag = assertHermesVersion(version)
    const { appDir, appBak, bin } = hermesPaths(home)
    return [
        'set -eu',
        `rm -rf "${appBak}"`,
        `if [ -d "${appDir}" ]; then mv "${appDir}" "${appBak}"; fi`,
        buildHermesInstallScript(tag),
        // The old checkout goes only once the new one runs; otherwise the
        // caller's restore shell puts it back.
        // Seen on a kind cloud computer [2026-09-25]: a rebuild exited 0
        // without a new checkout and removed the old one with it.
        `"${bin}" --version >/dev/null`,
        `rm -rf "${appBak}"`
    ].join('\n')
}

// Roll back to the pre-upgrade checkout after a failed rebuild.
export const buildHermesRestoreShell = (home: string): string => {
    const { appDir, appBak } = hermesPaths(home)
    return [
        'set -u',
        `if [ -d "${appBak}" ]; then rm -rf "${appDir}"; mv "${appBak}" "${appDir}"; fi`
    ].join('\n')
}

// The gateway service's env on any host. HERMES_DASHBOARD_ENABLED stays false
// for the gateway itself: a dashboard is a separate `hermes dashboard`
// service, never gateway-managed.
export const hermesServiceEnv = (opts: {
    creds: ResolvedHermesCredentials
    apiServerKey: string
    envText?: string | null
}): Record<string, string> => {
    const rawProvider =
        (opts.creds.primaryModelProvider as string | undefined) ?? 'openai'
    return {
        ...envTextToRecord(opts.envText),
        ...buildHermesEnv({
            creds: opts.creds,
            apiServerKey: opts.apiServerKey,
            dashboardEnabled: false
        }),
        // Hermes reads `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / etc. — not
        // `HERMES_PRIMARY_MODEL_API_KEY` — so the key is re-exported under
        // the name its provider reads.
        ...hermesProviderAliasEnv(
            rawProvider,
            opts.creds.primaryModelApiKey ?? ''
        )
    }
}

// config.yaml, which `hermes acp` and the gateway read for model/provider;
// service env alone never reaches an ACP child.
export const hermesConfigYamlFor = (creds: ResolvedHermesCredentials): string =>
    buildHermesConfigYaml({
        profile: creds.profile ?? 'default',
        provider: mapHermesProvider(
            (creds.primaryModelProvider as string | undefined) ?? 'openai'
        ),
        modelName: creds.primaryModelName ?? undefined,
        baseUrl: creds.primaryModelBaseUrl ?? undefined,
        apiKey: creds.primaryModelApiKey ?? undefined
    })
