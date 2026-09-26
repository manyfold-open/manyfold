import { spawn } from 'node:child_process'
import { access, constants as fsConstants } from 'node:fs/promises'
import { join } from 'node:path'
import {
    parseAntigravityModelList,
    type AntigravityCliCredentialFacts,
    type DaemonFrameworkModelCapability
} from '@manyfold/shared'
import {
    nestedRecord,
    nonEmptyString,
    parseJsonRecord,
    readTextIfPresent,
    type FrameworkConfigDirs
} from './inspect-fs'

// agy keeps its Google sign-in in the OS keyring, which the daemon never
// reads, or — on a Linux host without a D-Bus session bus — in a token file
// under ~/.gemini. Neither says whose account it is without reading the
// token itself, so the facts name only which is there; `agy models` then
// says whether any of it works.
// Measured on agy 1.2.11 [2026-09-26] (Linux, no D-Bus): a Google sign-in
// lands in antigravity-cli/antigravity-oauth-token, mode 0600, and a new
// process reads it; the binary also names jetski-standalone-oauth-token.
export const AGY_TOKEN_FILES = [
    'antigravity-cli/antigravity-oauth-token',
    'jetski-standalone-oauth-token'
]

// What `agy models` prints on stderr without a sign-in (1.2.11).
const SIGNED_OUT_RE = /please sign in|not logged in|authentication required/i

const LIST_TIMEOUT_MS = 12_000

export interface AntigravityInspectDeps {
    commandVersion: (cmd: string) => Promise<string | null>
    env: Record<string, string | undefined>
}

interface TokenFileFacts {
    name: string | null
    parsed: boolean
    expiresAt: number | null
    hasRefreshToken: boolean
}

// An oauth2 token as Go writes it, which agy 1.2.11 saves under `token` beside
// the sign-in method and an id token: `expiry` is RFC 3339, and the zero time
// (year 1) means the token never expires.
const tokenFileFacts = async (geminiDir: string): Promise<TokenFileFacts> => {
    for (const name of AGY_TOKEN_FILES) {
        const file = await readTextIfPresent(join(geminiDir, name))
        if (!file.ok || !file.text?.trim()) continue
        const saved = parseJsonRecord(file.text)
        const token = nestedRecord(saved, 'token') ?? saved
        const expiry =
            typeof token?.expiry === 'string' ? Date.parse(token.expiry) : NaN
        return {
            name,
            parsed: token !== null,
            expiresAt: Number.isFinite(expiry) && expiry > 0 ? expiry : null,
            hasRefreshToken: nonEmptyString(token?.refresh_token)
        }
    }
    return {
        name: null,
        parsed: false,
        expiresAt: null,
        hasRefreshToken: false
    }
}

interface ModelList {
    models: string[]
    signedOut: boolean
    error: string | null
}

// agy's own verdict. Offline in API-key mode, where it lists the Gemini
// models it can call; a network call for a Google sign-in. The self-updater
// stays off: a probe must never replace the CLI it is probing.
const listAgyModels = (
    env: Record<string, string | undefined>
): Promise<ModelList> =>
    new Promise((resolveList) => {
        const child = spawn('agy', ['models'], {
            env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            if (stdout.length < 512_000) stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
            if (stderr.length < 4096) stderr += chunk
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), LIST_TIMEOUT_MS)
        child.on('error', (err) => {
            clearTimeout(timer)
            resolveList({ models: [], signedOut: false, error: err.message })
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            const models = parseAntigravityModelList(stdout).map(
                (model) => model.slug
            )
            const detail = stderr
                .split('\n')
                .filter((line) => !/^Fetching available models/.test(line))
                .join('\n')
                .trim()
            resolveList({
                models,
                signedOut: code !== 0 && SIGNED_OUT_RE.test(stderr),
                error:
                    code === 0 && models.length > 0
                        ? null
                        : `agy models exited ${code ?? 'on a signal'}: ${detail.slice(0, 300)}`
            })
        })
    })

const accessible = async (path: string): Promise<boolean> => {
    try {
        await access(path, fsConstants.R_OK)
        return true
    } catch {
        return false
    }
}

export const inspectAntigravityModels = async (
    dirs: FrameworkConfigDirs,
    deps: AntigravityInspectDeps
): Promise<DaemonFrameworkModelCapability> => {
    const now = new Date().toISOString()
    const appDir = join(dirs.geminiDir, 'antigravity-cli')
    const cliVersion = await deps.commandVersion('agy')
    const token = await tokenFileFacts(dirs.geminiDir)
    const settings = parseJsonRecord(
        (await readTextIfPresent(join(appDir, 'settings.json'))).text
    )
    const settingsApiKeyMode = settings?.modelProvider === 'gemini'
    const envApiKey =
        dirs.envAuth &&
        (nonEmptyString(deps.env.GEMINI_API_KEY) ||
            nonEmptyString(deps.env.GOOGLE_API_KEY))
    const listed = cliVersion ? await listAgyModels(deps.env) : null
    const facts: AntigravityCliCredentialFacts = {
        framework: 'antigravity-cli',
        tokenFilePresent: token.name !== null,
        tokenFileParsed: token.parsed,
        tokenExpiresAt: token.expiresAt,
        hasRefreshToken: token.hasRefreshToken,
        settingsApiKeyMode,
        envApiKey,
        cliSignedIn:
            !listed || settingsApiKeyMode
                ? null
                : listed.error === null
                  ? true
                  : listed.signedOut
                    ? false
                    : null
    }
    const models = listed?.models ?? []
    const current =
        [
            settingsApiKeyMode ? 'settings.json modelProvider: gemini' : '',
            envApiKey ? 'GEMINI_API_KEY env' : '',
            token.name ?? '',
            facts.cliSignedIn && !token.name ? 'keyring sign-in' : ''
        ]
            .filter(Boolean)
            .join(' · ') || null
    const error = !cliVersion
        ? 'agy CLI is not available on PATH'
        : settingsApiKeyMode && !envApiKey
          ? "agy is in API-key mode (settings.json names the gemini provider) but this daemon's environment has no GEMINI_API_KEY"
          : listed?.signedOut
            ? 'agy has no sign-in here: run agy and sign in with Google'
            : (listed?.error ?? null)
    return {
        framework: 'antigravity-cli',
        cliVersion,
        ready: Boolean(cliVersion && models.length > 0 && !error),
        credentialReady: models.length > 0,
        credentialFacts: facts,
        configReadable: await accessible(appDir),
        current,
        models,
        aliases: [],
        speeds: [],
        intelligence: [],
        lastCheckedAt: now,
        error
    }
}
