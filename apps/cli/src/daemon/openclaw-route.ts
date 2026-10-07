import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InferenceProtocol } from '@manyfold/shared'
import { sameRoute, type RouteResolution } from './route-attestation'

// The provider route a resident OpenClaw gateway served a turn on, resolved
// the way the gateway resolves it: the transcript names the provider entry
// that answered every call, and that entry in the gateway's openclaw.json
// holds the wire api, the endpoint and the key. Anything this cannot know for
// certain — an env reference into a process environment the daemon did not
// start, a dotenv layer it does not parse, a secret from a file or a command,
// a config the gateway does not reload — is unresolved rather than guessed.

// The gateway process's environment when the daemon started it (a pod host's
// supervised service); null when someone else did (a sprite service, a BYOD
// gateway), and then only literal values resolve.
export interface OpenclawRouteSource {
    configPath: string
    stateDir: string
    gatewayEnv: Record<string, string> | null
}

export const openclawRouteSource = (
    gatewayEnv: Record<string, string> | null
): OpenclawRouteSource => {
    const env = gatewayEnv ?? process.env
    const home = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homedir()
    return {
        configPath:
            env.OPENCLAW_CONFIG_PATH?.trim() ||
            join(home, '.openclaw', 'openclaw.json'),
        stateDir: env.OPENCLAW_STATE_DIR?.trim() || join(home, '.openclaw'),
        gatewayEnv
    }
}

// The config as the gateway would load it; a string reason when it cannot be
// read as strict JSON (JSON5 included: a parser that guesses is no receipt).
export const readOpenclawConfig = async (
    source: OpenclawRouteSource
): Promise<Record<string, unknown> | string> => {
    let raw: string
    try {
        raw = await readFile(source.configPath, 'utf8')
    } catch {
        return 'config_unreadable'
    }
    try {
        const parsed = JSON.parse(raw) as unknown
        return isRecord(parsed) ? parsed : 'config_unreadable'
    } catch {
        return 'config_unreadable'
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const API_PROTOCOL: Record<string, InferenceProtocol> = {
    'openai-completions': 'openai_chat_completions',
    'openai-responses': 'openai_responses',
    'anthropic-messages': 'anthropic_messages',
    'google-generative-ai': 'google_generate_content'
}

// `${VAR}` names only uppercase variables, `$${VAR}` is a literal, and a
// missing or empty variable fails the gateway's config load.
const ENV_REFERENCE = /\$?\$\{([A-Z_][A-Z0-9_]*)\}/g

export const resolveOpenclawRoute = (input: {
    config: Record<string, unknown>
    provider: string
    source: OpenclawRouteSource
}): RouteResolution => {
    const { config, provider, source } = input
    const gateway = isRecord(config.gateway) ? config.gateway : null
    const reload = gateway && isRecord(gateway.reload) ? gateway.reload : null
    // The gateway applies a models edit by watching the file; with the watch
    // off, the file can say one thing while the gateway serves another.
    if (reload?.mode === 'off') return { unresolved: 'config_reload_off' }
    const models = config.models
    if (!isRecord(models)) return { unresolved: 'provider_not_configured' }
    const providers = models.providers
    if (
        '$include' in config ||
        '$include' in models ||
        (isRecord(providers) && '$include' in providers)
    )
        return { unresolved: 'config_include' }
    const entry = isRecord(providers) ? providers[provider] : undefined
    if (!isRecord(entry)) return { unresolved: 'provider_not_configured' }
    if ('$include' in entry) return { unresolved: 'config_include' }
    const protocol =
        typeof entry.api === 'string' ? API_PROTOCOL[entry.api] : undefined
    if (!protocol) return { unresolved: 'provider_api_unsupported' }
    const lookup = envLookup(config, source)
    const baseUrl = resolveValue(entry.baseUrl, lookup)
    if (!baseUrl) return { unresolved: 'base_url_unresolved' }
    const apiKey = resolveValue(entry.apiKey, lookup)
    if (!apiKey) return { unresolved: 'key_unresolved' }
    return { route: { protocol, baseUrl, apiKey } }
}

// The gateway's own precedence: its process env, then a global dotenv, then
// the config's env block. Only a process env the daemon gave the gateway is
// known; past it, a dotenv this does not parse would decide.
const envLookup =
    (config: Record<string, unknown>, source: OpenclawRouteSource) =>
    (name: string): string | null => {
        if (!source.gatewayEnv) return null
        const fromProcess = source.gatewayEnv[name]
        if (fromProcess) return fromProcess
        const dotenvs = [
            join(source.stateDir, '.env'),
            join(
                source.gatewayEnv.HOME?.trim() || homedir(),
                '.config',
                'openclaw',
                'gateway.env'
            )
        ]
        if (dotenvs.some((path) => existsSync(path))) return null
        const block = isRecord(config.env) ? config.env : null
        const vars = block && isRecord(block.vars) ? block.vars : null
        const fromBlock = block?.[name] ?? vars?.[name]
        return typeof fromBlock === 'string' && fromBlock ? fromBlock : null
    }

const resolveValue = (
    value: unknown,
    lookup: (name: string) => string | null
): string | null => {
    if (typeof value === 'string') return substitute(value, lookup)
    // A SecretRef the gateway resolves from its env; file and exec sources
    // are not readable here.
    if (
        isRecord(value) &&
        value.source === 'env' &&
        value.provider === 'default' &&
        typeof value.id === 'string'
    )
        return lookup(value.id)
    return null
}

const substitute = (
    value: string,
    lookup: (name: string) => string | null
): string | null => {
    let missing = false
    const resolved = value.replace(ENV_REFERENCE, (match, name: string) => {
        if (match.startsWith('$$')) return match.slice(1)
        const found = lookup(name)
        if (!found) missing = true
        return found ?? ''
    })
    return missing || !resolved ? null : resolved
}

// The route of one turn: the single provider its transcript names, resolved
// from the config the gateway had when the turn started and still has now.
// An entry that moved in between cannot say which side served the calls.
export const openclawTurnRoute = async (input: {
    providers: readonly string[] | undefined
    configAtStart: Record<string, unknown> | string
    source: OpenclawRouteSource
}): Promise<RouteResolution> => {
    const { providers, configAtStart, source } = input
    if (!providers?.length) return { unresolved: 'provider_unrecorded' }
    if (providers.length > 1) return { unresolved: 'providers_mixed' }
    if (typeof configAtStart === 'string') return { unresolved: configAtStart }
    const configAtEnd = await readOpenclawConfig(source)
    if (typeof configAtEnd === 'string') return { unresolved: configAtEnd }
    const provider = providers[0]!
    const atStart = resolveOpenclawRoute({ config: configAtStart, provider, source })
    if ('unresolved' in atStart) return atStart
    const atEnd = resolveOpenclawRoute({ config: configAtEnd, provider, source })
    if ('unresolved' in atEnd) return atEnd
    return sameRoute(atStart.route, atEnd.route)
        ? atStart
        : { unresolved: 'config_changed' }
}
