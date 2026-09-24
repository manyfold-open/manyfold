import { spawn } from 'node:child_process'
import { access, constants as fsConstants } from 'node:fs/promises'
import { join } from 'node:path'
import {
    PI_PROVIDER_KEY_ENV,
    parsePiListModels,
    type DaemonFrameworkModelCapability,
    type PiAuthEntryFact,
    type PiCredentialFacts
} from '@manyfold/shared'
import {
    nestedRecord,
    nonEmptyString,
    parseJsonRecord,
    readTextIfPresent,
    type FrameworkConfigDirs
} from './inspect-fs'

// pi keeps every sign-in in its agent dir: auth.json (what `/login` writes,
// one entry per provider), a models.json provider `apiKey`, or a vendor env
// var — in that order of precedence. The facts name which providers and how,
// never a value; `pi --list-models` then says which models those make usable.

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const authEntries = (
    parsed: Record<string, unknown> | null
): PiAuthEntryFact[] =>
    parsed
        ? Object.entries(parsed).flatMap(([provider, value]) =>
              isRecord(value)
                  ? [
                        {
                            provider,
                            type:
                                value.type === 'oauth' ||
                                value.type === 'api_key'
                                    ? value.type
                                    : ('other' as const),
                            expiresAt:
                                typeof value.expires === 'number' &&
                                Number.isFinite(value.expires)
                                    ? value.expires
                                    : null,
                            hasRefreshToken: nonEmptyString(value.refresh)
                        }
                    ]
                  : []
          )
        : []

export const piCredentialFacts = async (
    dirs: FrameworkConfigDirs,
    env: NodeJS.ProcessEnv = process.env
): Promise<PiCredentialFacts> => {
    const auth = await readTextIfPresent(join(dirs.piDir, 'auth.json'))
    const parsed = parseJsonRecord(auth.text)
    const models = parseJsonRecord(
        (await readTextIfPresent(join(dirs.piDir, 'models.json'))).text
    )
    const providers = nestedRecord(models, 'providers')
    return {
        framework: 'pi',
        authFilePresent: auth.ok,
        authFileParsed: parsed !== null,
        authEntries: authEntries(parsed),
        modelsJsonKeyProviders: providers
            ? Object.entries(providers)
                  .filter(
                      ([, provider]) =>
                          isRecord(provider) && nonEmptyString(provider.apiKey)
                  )
                  .map(([id]) => id)
            : [],
        // A profile's executions strip the daemon's vendor variables, so only
        // the ambient probe counts them.
        envKeys: dirs.envAuth
            ? PI_PROVIDER_KEY_ENV.filter((name) => nonEmptyString(env[name]))
            : []
    }
}

// Whether a profile view holds a sign-in. The file alone proves nothing: pi
// creates auth.json as `{}` the first time it merely reads it (pi 0.87.1
// FileAuthStorageBackend.ensureFileExists), so a view that was only looked at
// would pass for a signed-in one.
export const piAuthStored = async (agentDir: string): Promise<boolean> => {
    const parsed = parseJsonRecord(
        (await readTextIfPresent(join(agentDir, 'auth.json'))).text
    )
    return parsed !== null && Object.values(parsed).some(isRecord)
}

const LIST_TIMEOUT_MS = 20_000

export interface PiInspectDeps {
    commandVersion: (cmd: string) => Promise<string | null>
    // The environment pi runs under: the daemon's own for the ambient probe,
    // a profile's (ambient vendor variables stripped) for a view.
    env: Record<string, string | undefined>
}

// pi's own verdict on what can run here: one row per model of a provider it
// holds a credential for. Offline, so the catalog is the one pi ships.
const listPiModels = (
    dirs: FrameworkConfigDirs,
    env: Record<string, string | undefined>
): Promise<{ models: string[]; error: string | null }> =>
    new Promise((resolveList) => {
        const child = spawn('pi', ['--list-models'], {
            env: {
                ...env,
                PI_CODING_AGENT_DIR: dirs.piDir,
                PI_OFFLINE: '1'
            },
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
            resolveList({ models: [], error: err.message })
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolveList({
                models: parsePiListModels(stdout),
                error:
                    code === 0
                        ? null
                        : `pi --list-models exited ${code}: ${stderr.trim().slice(0, 300)}`
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

export const inspectPiModels = async (
    dirs: FrameworkConfigDirs,
    deps: PiInspectDeps
): Promise<DaemonFrameworkModelCapability> => {
    const now = new Date().toISOString()
    const cliVersion = await deps.commandVersion('pi')
    const facts = await piCredentialFacts(dirs, deps.env)
    const listed = cliVersion
        ? await listPiModels(dirs, deps.env)
        : { models: [], error: null }
    const settings = parseJsonRecord(
        (await readTextIfPresent(join(dirs.piDir, 'settings.json'))).text
    )
    const defaultProvider =
        typeof settings?.defaultProvider === 'string'
            ? settings.defaultProvider.trim()
            : ''
    const defaultModel =
        typeof settings?.defaultModel === 'string'
            ? settings.defaultModel.trim()
            : ''
    const signedIn = facts.authEntries.map((entry) => entry.provider)
    const current =
        [
            defaultProvider && defaultModel
                ? `${defaultProvider}/${defaultModel}`
                : defaultModel,
            signedIn.length > 0 ? `auth.json: ${signedIn.join(', ')}` : '',
            facts.envKeys.length > 0 ? facts.envKeys.join(', ') : ''
        ]
            .filter(Boolean)
            .join(' · ') || null
    const credentialReady = listed.models.length > 0
    const error = cliVersion
        ? credentialReady
            ? null
            : (listed.error ??
              'pi has no sign-in here: run pi and use /login, or set a vendor API key')
        : 'pi CLI is not available on PATH'
    return {
        framework: 'pi',
        cliVersion,
        ready: Boolean(cliVersion && credentialReady),
        credentialReady,
        credentialFacts: facts,
        configReadable: await accessible(dirs.piDir),
        current,
        models: listed.models,
        aliases: [],
        speeds: [],
        intelligence: [],
        lastCheckedAt: now,
        error
    }
}
