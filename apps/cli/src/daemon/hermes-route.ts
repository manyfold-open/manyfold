import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
    normalizeRouteBaseUrl,
    type InferenceProtocol
} from '@manyfold/shared'
import { readJsonState, writeProtectedJson } from '@/json-state'
import type { RouteResolution, ServedRoute } from './route-attestation'

// The provider route a per-turn `hermes acp` child is spawned on: the model
// section of the config.yaml it loads plus the provider key in the env it is
// given, after the `.env` beside that config, which hermes loads OVER the
// inherited env. Hermes has more ways to pick a credential than that (profiles,
// a managed scope, secret-manager sources, credential pools, key commands); a
// home that uses any of them is unresolved, never guessed. Only the providers
// Manyfold provisions are followed: an OpenAI-compatible `custom` endpoint
// with its key in the config, and OpenRouter keyed from the env.

export type HermesRoute = ServedRoute & { provider: 'custom' | 'openrouter' }

export type HermesRouteResolution =
    | { route: HermesRoute; home: string }
    | { unresolved: string }

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
// The env keys this resolution reads, so the ones a dotenv layer can move.
const ROUTE_ENV_KEYS = [
    'CUSTOM_BASE_URL',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_API_KEY'
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const usable = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length >= 4

const readText = (path: string): string | null => {
    try {
        return readFileSync(path, 'utf8')
    } catch {
        return null
    }
}

const isDirectory = (path: string): boolean => {
    try {
        return statSync(path).isDirectory()
    } catch {
        return false
    }
}

// The home `hermes acp` settles on at startup: a --profile flag, a HERMES_HOME
// that names a profile directory, or the root with its sticky active_profile.
// A profile other than the root one is unresolved.
const hermesHome = (
    cmd: readonly string[],
    env: NodeJS.ProcessEnv
): { home: string } | { unresolved: string } => {
    if (
        cmd.some(
            (arg) =>
                arg === '-p' ||
                arg === '--profile' ||
                arg.startsWith('--profile=')
        )
    )
        return { unresolved: 'hermes_profile' }
    const fromEnv = env.HERMES_HOME?.trim()
    if (fromEnv && basename(dirname(fromEnv)) === 'profiles')
        return { unresolved: 'hermes_profile' }
    const root = fromEnv || join(env.HOME?.trim() || homedir(), '.hermes')
    const active = readText(join(root, 'active_profile'))?.trim()
    if (active && active !== 'default') return { unresolved: 'hermes_profile' }
    return { home: root }
}

// python-dotenv's override load, for the keys this reads: the last
// assignment wins, quoted values are taken verbatim, and anything that
// would need its interpolation or multi-line rules is unresolved.
const dotenvAssignments = (
    text: string,
    keys: readonly string[]
): Map<string, string> | null => {
    const found = new Map<string, string>()
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\uFEFF/, '').trim()
        if (!line || line.startsWith('#')) continue
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(
            line
        )
        if (!match || !keys.includes(match[1]!)) continue
        const value = parseDotenvValue(match[2]!)
        if (value === null) return null
        found.set(match[1]!, value)
    }
    return found
}

const parseDotenvValue = (raw: string): string | null => {
    const value = raw.trim()
    const quote = value[0]
    if (quote === "'" || quote === '"') {
        const end = value.indexOf(quote, 1)
        if (end === -1) return null
        const inner = value.slice(1, end)
        const rest = value.slice(end + 1).trim()
        if (rest && !rest.startsWith('#')) return null
        if (quote === '"' && /[\\$]/.test(inner)) return null
        return inner
    }
    const unquoted = value.replace(/\s+#.*$/, '').trim()
    return unquoted.includes('$') ? null : unquoted
}

const API_MODE_PROTOCOL: Record<string, InferenceProtocol> = {
    chat_completions: 'openai_chat_completions',
    codex_responses: 'openai_responses',
    anthropic_messages: 'anthropic_messages'
}

const hostOf = (url: string): string | null => {
    try {
        return new URL(url).hostname.toLowerCase()
    } catch {
        return null
    }
}

// hermes's own choice for an endpoint whose config names no api_mode: the
// hosts that speak one wire protocol, and the `/anthropic` path convention.
const detectedProtocol = (baseUrl: string): InferenceProtocol => {
    const host = hostOf(baseUrl)
    const path = (() => {
        try {
            return new URL(baseUrl).pathname.replace(/\/+$/, '')
        } catch {
            return ''
        }
    })()
    if (host === 'api.anthropic.com') return 'anthropic_messages'
    if (host === 'api.openai.com' || host?.endsWith('.api.openai.com'))
        return 'openai_responses'
    if (path.endsWith('/anthropic') || path.endsWith('/anthropic/v1'))
        return 'anthropic_messages'
    return 'openai_chat_completions'
}

export const resolveHermesRoute = (input: {
    cmd: readonly string[]
    env: NodeJS.ProcessEnv
}): HermesRouteResolution => {
    if (process.platform === 'win32') return { unresolved: 'hermes_platform' }
    const located = hermesHome(input.cmd, input.env)
    if ('unresolved' in located) return located
    const { home } = located
    if (input.env.HERMES_MANAGED_DIR?.trim() || isDirectory('/etc/hermes'))
        return { unresolved: 'hermes_managed_scope' }

    const configText = readText(join(home, 'config.yaml'))
    if (configText === null) return { unresolved: 'config_unreadable' }
    let config: unknown
    try {
        config = parseYaml(configText)
    } catch {
        return { unresolved: 'config_unreadable' }
    }
    if (!isRecord(config)) return { unresolved: 'config_unreadable' }
    if (
        isRecord(config.secrets) &&
        Object.values(config.secrets).some(
            (source) => isRecord(source) && source.enabled === true
        )
    )
        return { unresolved: 'hermes_secret_sources' }
    const model = config.model
    if (!isRecord(model)) return { unresolved: 'provider_not_configured' }
    if ('key_env' in model || 'key_cmd' in model)
        return { unresolved: 'key_unresolved' }
    const provider =
        typeof model.provider === 'string'
            ? model.provider.trim().toLowerCase()
            : ''
    if (provider !== 'custom' && provider !== 'openrouter')
        return { unresolved: 'provider_unsupported' }

    const authText = readText(join(home, 'auth.json'))
    if (authText !== null) {
        let auth: unknown
        try {
            auth = JSON.parse(authText)
        } catch {
            return { unresolved: 'hermes_auth_store' }
        }
        const pools = isRecord(auth) ? auth.credential_pool : undefined
        const stored = isRecord(auth) ? auth.providers : undefined
        if (
            (isRecord(pools) &&
                Object.values(pools).some(
                    (entries) => Array.isArray(entries) && entries.length > 0
                )) ||
            (isRecord(stored) && provider in stored)
        )
            return { unresolved: 'hermes_credential_pool' }
    }

    const env: Record<string, string | undefined> = { ...input.env }
    const dotenv = readText(join(home, '.env'))
    if (dotenv !== null) {
        const assigned = dotenvAssignments(dotenv, ROUTE_ENV_KEYS)
        if (!assigned) return { unresolved: 'hermes_dotenv' }
        for (const [key, value] of assigned) env[key] = value
    }
    // hermes also loads a 1Password dotenv and the one in its own checkout,
    // with precedence that depends on which files exist; either one naming a
    // key read here is unresolved.
    for (const layer of [
        join(home, '.op.env'),
        join(home, 'hermes-agent', '.env')
    ]) {
        const text = readText(layer)
        if (text === null) continue
        const assigned = dotenvAssignments(text, ROUTE_ENV_KEYS)
        if (!assigned || assigned.size > 0)
            return { unresolved: 'hermes_dotenv' }
    }
    if (env.CUSTOM_BASE_URL?.trim())
        return { unresolved: 'hermes_env_base_url' }

    const apiMode =
        typeof model.api_mode === 'string'
            ? model.api_mode.trim().toLowerCase()
            : ''
    if (apiMode && !API_MODE_PROTOCOL[apiMode])
        return { unresolved: 'provider_api_unsupported' }
    const cfgBaseUrl =
        typeof model.base_url === 'string' ? model.base_url.trim() : ''

    if (provider === 'custom') {
        if (!cfgBaseUrl) return { unresolved: 'base_url_unresolved' }
        // hermes hands an OpenRouter host its OpenRouter key, not this one.
        if (hostOf(cfgBaseUrl) === 'openrouter.ai')
            return { unresolved: 'provider_unsupported' }
        const apiKey = [model.api_key, model.api].find(usable)
        if (!apiKey) return { unresolved: 'key_unresolved' }
        return {
            home,
            route: {
                provider,
                protocol: apiMode
                    ? API_MODE_PROTOCOL[apiMode]!
                    : detectedProtocol(cfgBaseUrl),
                baseUrl: cfgBaseUrl,
                apiKey: apiKey.trim()
            }
        }
    }
    const apiKey = env.OPENROUTER_API_KEY
    if (!usable(apiKey)) return { unresolved: 'key_unresolved' }
    return {
        home,
        route: {
            provider,
            protocol: apiMode
                ? API_MODE_PROTOCOL[apiMode]!
                : 'openai_chat_completions',
            baseUrl:
                cfgBaseUrl ||
                env.OPENROUTER_BASE_URL?.trim() ||
                OPENROUTER_DEFAULT_BASE_URL,
            apiKey: apiKey.trim()
        }
    }
}

// The route a session runs on is fixed when hermes creates it: a resumed
// session keeps the provider and endpoint it persisted then, whatever the
// config says now. So a resumed turn is attested only when this daemon saw
// the session created on the very route the config still names.
export interface HermesSessionRoute {
    provider: string
    protocol: InferenceProtocol
    baseUrl: string
}

const SESSION_ROUTE_LIMIT = 500

const sessionRouteOf = (route: HermesRoute): HermesSessionRoute => ({
    provider: route.provider,
    protocol: route.protocol,
    baseUrl: normalizeRouteBaseUrl(route.baseUrl) ?? route.baseUrl
})

const sameSessionRoute = (
    a: HermesSessionRoute,
    b: HermesSessionRoute
): boolean =>
    a.provider === b.provider &&
    a.protocol === b.protocol &&
    a.baseUrl === b.baseUrl

interface StoredSessionRoutes {
    sessions: Record<string, HermesSessionRoute & { at: string }>
}

export class HermesSessionRoutes {
    private chain: Promise<unknown> = Promise.resolve()

    constructor(private readonly path: string) {}

    private async load(): Promise<StoredSessionRoutes> {
        try {
            const stored = await readJsonState(this.path)
            if (isRecord(stored) && isRecord(stored.sessions))
                return stored as unknown as StoredSessionRoutes
        } catch {}
        return { sessions: {} }
    }

    private serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.chain.then(work, work)
        this.chain = next.catch(() => undefined)
        return next
    }

    async get(home: string, sessionId: string): Promise<HermesSessionRoute | null> {
        return this.serial(async () => {
            const entry = (await this.load()).sessions[`${home}|${sessionId}`]
            return entry
                ? {
                      provider: entry.provider,
                      protocol: entry.protocol,
                      baseUrl: entry.baseUrl
                  }
                : null
        })
    }

    async set(
        home: string,
        sessionId: string,
        route: HermesSessionRoute | null
    ): Promise<void> {
        await this.serial(async () => {
            const stored = await this.load()
            const key = `${home}|${sessionId}`
            if (route)
                stored.sessions[key] = { ...route, at: new Date().toISOString() }
            else delete stored.sessions[key]
            const kept = Object.entries(stored.sessions)
                .sort(([, a], [, b]) => b.at.localeCompare(a.at))
                .slice(0, SESSION_ROUTE_LIMIT)
            await writeProtectedJson(this.path, {
                sessions: Object.fromEntries(kept)
            })
        })
    }
}

// The route of one turn: the spawn-time route, for a session hermes created
// in this turn or one this daemon saw created on that same route. A slash
// command or a provider-qualified model switch can move the session itself,
// so those turns are unresolved and the session is forgotten.
export const hermesTurnRoute = async (input: {
    atSpawn: HermesRouteResolution
    sessionId: string
    resumed: boolean
    prompt: string
    modelOverride: string | null | undefined
    currentModelId: string | null | undefined
    sessions: HermesSessionRoutes | undefined
}): Promise<RouteResolution> => {
    const { atSpawn, sessionId, sessions } = input
    if ('unresolved' in atSpawn) return atSpawn
    const { route, home } = atSpawn
    const forget = () => sessions?.set(home, sessionId, null)
    if (input.prompt.trimStart().startsWith('/')) {
        await forget()
        return { unresolved: 'hermes_slash_command' }
    }
    const override = input.modelOverride?.trim()
    if (override?.includes(':') && !override.startsWith(`${route.provider}:`)) {
        await forget()
        return { unresolved: 'hermes_model_override_provider' }
    }
    const current = input.currentModelId?.trim()
    if (current?.includes(':') && !current.startsWith(`${route.provider}:`))
        return { unresolved: 'hermes_session_provider' }
    const created = sessionRouteOf(route)
    if (input.resumed) {
        const recorded = await sessions?.get(home, sessionId)
        if (!recorded || !sameSessionRoute(recorded, created))
            return { unresolved: 'hermes_session_route_unknown' }
    } else await sessions?.set(home, sessionId, created)
    return { route }
}
