import { spawn } from 'node:child_process'
import type {
    ChildProcess,
    ChildProcessByStdio,
    ChildProcessWithoutNullStreams
} from 'node:child_process'
import {
    createReadStream,
    constants as fsConstants,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import {
    access,
    chmod,
    mkdir,
    rm,
    readFile,
    writeFile,
    readdir,
    rename,
    stat
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep, join, dirname, basename } from 'node:path'
import type { Readable } from 'node:stream'
import {
    claudeCodeModelAliases,
    claudeLocalModelCatalog,
    codexIntelligenceLevels,
    codexModels,
    codexSpeeds,
    geminiAutoModelKey,
    geminiLocalModelCatalog,
    isModelConfigFramework,
    type ClaudeCredentialFacts,
    type CodexCredentialFacts,
    type CodexCustomProviderFact,
    type DaemonFrameworkModelCapability,
    type DaemonModelInspectResponse,
    type DaemonRpcMethod,
    type DaemonServiceSpec,
    type DaemonTurnStartPayload,
    type GeminiCredentialFacts
} from '@manyfold/shared'
import { permissionResponders, runAcpTurn } from './acp-turn'
import { runOpenclawTurn } from './openclaw-turn'
import { runOpenclawAcpTurn } from './openclaw-acp-turn'
import type { RpcContext, RpcHandler } from './ws-client'
import { encodePtyChunk, resolvePtyBackend } from './pty-backend'
import {
    assertOwnedTerminalCapacity,
    attachOwnedTerminal,
    attachedTerminalCount,
    closeOwnedTerminal,
    detachOwnedTerminal,
    isOwnedTerminalId,
    ownedTerminal,
    ownedTerminalCount,
    registerOwnedTerminal,
    resizeOwnedTerminal,
    type OwnedTerminalAttachment
} from './owned-terminals'
import {
    closeHerdrTerminal,
    currentHerdr,
    focusHerdrTerminal,
    HERDR_BINARY,
    herdrErrorString,
    herdrTerminal,
    herdrTerminalCount,
    isHerdrFramework,
    openInHerdr,
    updateHerdr
} from './herdr'
import { machineWorkspacesRoot, RUNNER_PROFILE } from '@manyfold/shared'
import { resolveConfigDir, resolveProfile } from '@/config'
import { daemonPaths, loadDaemonConfig } from './config'
import type { ModelConfigFramework } from '@manyfold/shared'
import {
    RuntimeAuthManager,
    cliBinaryFor,
    stripAmbientAuthEnv
} from './runtime-auth/manager'
import { assertOperationId, assertProfileId, authRoot } from './runtime-auth/paths'
import { ProfileBusyError } from './runtime-auth/lock'
import {
    bufferDir,
    ExecStream,
    type ExecBufferFinal,
    execStreams,
    readEventsFrom,
    readFinal,
    readMeta
} from './exec-buffer'
import {
    fileExecEnabled,
    fileExecRegistry,
    startFileExec
} from './exec-files'
import { normalizeWireChannel } from '@/channel'
import { performSelfUpdate, type SelfUpdateResult } from '@/commands/update'
import { detectStartupMethod } from './startup-method'
import { precheckBinary, readUpdateLatch } from './manual-update'
import {
    UPDATE_PENDING_ERROR,
    UpdateDrainCoordinator,
    type DaemonUpdateSpec,
    type IdleUpdateOutcome
} from './update-drain'
import { MF_CLI_VERSION } from '@/version'
import {
    expandHome,
    jwtExpiryMs,
    nestedRecord,
    nonEmptyString,
    parseJsonRecord,
    readTextIfPresent,
    nativeConfigDirs,
    type FrameworkConfigDirs
} from './inspect-fs'
import { inspectRuntimeAccount } from './account-inspect'
import { inspectPiModels } from './pi-inspect'
import { createExecResources, EXEC_TEMP_DIRECTORY_ENV } from './exec-resources'
import { commitConfigFile } from './config-commit'
import type { ServiceSupervisor } from './services'

interface TerminalSession {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
}

const shellQuoteArg = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

const ptySessions = new Map<string, TerminalSession>()

// ADR-0014: the managed workspace root is whatever this daemon's
// registration declared (workspaceBaseDir); the machine-scoped shared root is
// only the fallback until `daemon start` injects the declared value.
let declaredWorkspaceRoot: string | null = null

export const setDeclaredWorkspaceRoot = (
    root: string | null | undefined
): void => {
    declaredWorkspaceRoot = root ? resolve(expandHome(root)) : null
}

const managedWorkspaceRoot = (): string =>
    declaredWorkspaceRoot ?? resolve(machineWorkspacesRoot(resolveConfigDir()))

const isInsideManagedRoot = (path: string): boolean =>
    isInsideRoot(path, managedWorkspaceRoot())
const FRAMEWORK_HOME_ROOTS = [
    join(homedir(), '.claude'),
    join(homedir(), '.codex'),
    join(homedir(), '.gemini'),
    join(homedir(), '.pi'),
    join(homedir(), '.openclaw'),
    join(homedir(), '.hermes')
]
// Exact files the containment admits (DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG):
// Claude Code's user-level config is a SIBLING of the ~/.claude root, so the
// root scan can never reach it. Admitted by exact match only, and never
// through a symlink — ADR-0013's threat model is a planted link, and a
// managed config file that is secretly an alias for somewhere else is the
// same attack.
export const FRAMEWORK_HOME_FILES = [join(homedir(), '.claude.json')]
const registeredWorkspaceRoots = new Set<string>()
let registeredRootsLoaded = false

// Lazy: reading at import time would capture the profile before --profile is
// parsed (ADR-0014 forbids import-time path resolution).
const ensureRegisteredRootsLoaded = (): void => {
    if (registeredRootsLoaded) return
    registeredRootsLoaded = true
    try {
        const raw = readFileSync(daemonPaths.workspaceRootsPath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return
        for (const item of parsed) {
            if (typeof item !== 'string') continue
            registeredWorkspaceRoots.add(resolve(expandHome(item)))
        }
    } catch {}
}

const saveRegisteredWorkspaceRoots = (): void => {
    mkdirSync(daemonPaths.baseDir, { recursive: true, mode: 0o700 })
    writeFileSync(
        daemonPaths.workspaceRootsPath,
        JSON.stringify([...registeredWorkspaceRoots].sort(), null, 2),
        'utf8'
    )
}

export const isInsideRoot = (path: string, root: string): boolean => {
    const abs = resolve(expandHome(path))
    const absRoot = resolve(expandHome(root))
    return abs === absRoot || abs.startsWith(`${absRoot}${sep}`)
}

const ensureUnderWorkspaces = (path: string): string => {
    const abs = resolve(expandHome(path))
    if (!isInsideManagedRoot(abs))
        throw new Error(
            `path ${abs} is not under ${managedWorkspaceRoot()}; refusing`
        )
    return abs
}

export type WorkspaceEnsureMode = 'create-managed' | 'register-existing'

export const workspaceEnsureMode = (
    path: string,
    createRequested: boolean
): WorkspaceEnsureMode => {
    const abs = resolve(expandHome(path))
    return createRequested && isInsideManagedRoot(abs)
        ? 'create-managed'
        : 'register-existing'
}

const allowedRoots = (): string[] => {
    ensureRegisteredRootsLoaded()
    return [
        managedWorkspaceRoot(),
        ...FRAMEWORK_HOME_ROOTS,
        authRoot(),
        ...registeredWorkspaceRoots
    ]
}

// ADR-0013: the lexical check below stops `..` and absolute-path escapes, but
// every fs call here follows symlinks, so a symlink planted inside a root used to
// reach outside it. Resolve the target (or its parent, for a path being created)
// and require the result to stay inside an allowed root. Roots are resolved too:
// a root behind a symlink (/var on macOS) would otherwise reject its own children.
export const assertRealPathContained = (abs: string, roots: string[]): void => {
    const resolvedRoots = roots.map((root) => {
        try {
            return realpathSync(expandHome(root))
        } catch {
            return resolve(expandHome(root))
        }
    })
    let real: string
    try {
        real = realpathSync(abs)
    } catch {
        try {
            real = join(realpathSync(dirname(abs)), basename(abs))
        } catch {
            // neither the path nor its parent exists yet: nothing to resolve, so
            // the lexical check is all there is
            return
        }
    }
    if (resolvedRoots.some((root) => isInsideRoot(real, root))) return
    throw new Error(
        `path ${abs} resolves outside allowed roots (${real}); refusing`
    )
}

export const ensureUnderAllowedRoot = (path: string): string => {
    ensureRegisteredRootsLoaded()
    const abs = resolve(expandHome(path))
    if (FRAMEWORK_HOME_FILES.includes(abs)) {
        assertNotSymlinkItself(abs)
        return abs
    }
    const lexicallyAllowed =
        isInsideManagedRoot(abs) ||
        FRAMEWORK_HOME_ROOTS.some((root) => isInsideRoot(abs, root)) ||
        isInsideRoot(abs, authRoot()) ||
        [...registeredWorkspaceRoots].some((root) => isInsideRoot(abs, root))
    if (!lexicallyAllowed)
        throw new Error(
            `path ${abs} is outside allowed roots (workspace + framework configs); refusing`
        )
    assertRealPathContained(abs, allowedRoots())
    return abs
}

// The admitted exact file itself must be a plain file (or absent, for the
// create): ancestors may be links (/var on macOS), the final component may
// not.
export const assertNotSymlinkItself = (abs: string): void => {
    let parentReal: string
    try {
        parentReal = realpathSync(dirname(abs))
    } catch {
        return
    }
    let real: string
    try {
        real = realpathSync(abs)
    } catch {
        return
    }
    if (real !== join(parentReal, basename(abs)))
        throw new Error(
            `path ${abs} is a symlink (resolves to ${real}); refusing the managed config file through a link`
        )
}

const assertUsableWorkspace = async (path: string): Promise<string> => {
    const abs = resolve(expandHome(path))
    let s
    try {
        s = await stat(abs)
    } catch {
        throw new Error(`workspace directory does not exist: ${abs}`)
    }
    if (!s.isDirectory())
        throw new Error(`workspace path is not a directory: ${abs}`)
    try {
        await access(abs, fsConstants.R_OK)
    } catch {
        throw new Error(`workspace directory is not readable: ${abs}`)
    }
    try {
        await access(abs, fsConstants.W_OK)
    } catch {
        throw new Error(`workspace directory is not writable: ${abs}`)
    }
    try {
        await access(abs, fsConstants.X_OK)
    } catch {
        throw new Error(`workspace directory is not enterable: ${abs}`)
    }
    const probe = join(
        abs,
        `.mf-workspace-check-${Date.now()}-${Math.random().toString(16).slice(2)}`
    )
    try {
        await writeFile(probe, '', { mode: 0o600 })
        await rm(probe, { force: true })
    } catch {
        throw new Error(`workspace directory is not writable: ${abs}`)
    }
    return abs
}

interface ExecPayload {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    keepStdinOpen?: boolean
    dir?: string
    timeoutMs?: number
    authSelection?: unknown
    temporarySettings?: 'gemini-platform'
}

// A profile-bound execution (DAEMON_FEATURE_AUTH_CONTEXT): resolve the
// profile's context on the host. The caller's env is laid UNDER the
// profile env with every ambient vendor variable dropped from both sides, so
// neither the daemon's shell nor the agent's extras can outrank the selected
// sign-in. Returns null for an inherited selection (today's behaviour).
const AUTH_CONTEXT_WAIT_MS = 60_000

const resolveAuthContext = async (
    selection: unknown,
    callerEnv: Record<string, string>,
    label: string
): Promise<{
    env: Record<string, string>
    dirs: FrameworkConfigDirs
    lockDir: string
    release: () => Promise<void>
} | null> => {
    if (!selection || typeof selection !== 'object') return null
    const ref = selection as Record<string, unknown>
    if (ref.mode === 'inherited') return null
    const manager = await runtimeAuthManagerFor(ref.runtimeId)
    const context = await manager.executionContext(
        modelConfigFrameworkOf(ref),
        assertProfileId(ref.profileId),
        label,
        { waitMs: AUTH_CONTEXT_WAIT_MS }
    )
    return {
        ...context,
        env: {
            ...stripAmbientAuthEnv(callerEnv),
            ...context.env
        }
    }
}

const uniqueStrings = (
    items: readonly (string | null | undefined)[]
): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of items) {
        const value = item?.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        out.push(value)
    }
    return out
}

const commandVersion = (cmd: string): Promise<string | null> =>
    new Promise((resolveVersion) => {
        let child: ChildProcessByStdio<null, Readable, Readable>
        try {
            child = spawn(cmd, ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            })
        } catch {
            // A failed exec throws here instead of emitting 'error' (ENOEXEC
            // for a 0-byte file under Bun, which the shipped daemon is).
            resolveVersion(null)
            return
        }
        let output = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            output += chunk
        })
        child.stderr.on('data', (chunk: string) => {
            output += chunk
        })
        child.on('error', () => resolveVersion(null))
        child.on('close', () => resolveVersion(output.trim() || null))
    })

const readablePath = async (path: string): Promise<boolean> => {
    try {
        await access(path, fsConstants.R_OK)
        return true
    } catch {
        return false
    }
}

// A profile view never reads the daemon's env (envAuth is false there); its
// stored api key file is the equivalent evidence for the fact builders.
const viewKeyPresent = async (dirs: FrameworkConfigDirs): Promise<boolean> =>
    dirs.apiKeyFile ? readablePath(dirs.apiKeyFile) : false

const tomlString = (text: string, key: string): string | null => {
    const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm')
    return pattern.exec(text)?.[1]?.trim() || null
}

const tomlScalar = (raw: string): string => {
    const withoutComment = raw.replace(/\s+#.*$/, '').trim()
    const quoted = /^["']([^"']*)["']$/.exec(withoutComment)
    return (quoted ? quoted[1] : withoutComment).trim()
}

interface CodexConfigScan {
    activeProvider: string | null
    providers: CodexCustomProviderFact[]
    profileModels: string[]
}

// Section-aware scan so `[model_providers.x]` keys are attributed to their
// provider instead of leaking into the root table the way a bare regex would.
const scanCodexConfig = (text: string | null): CodexConfigScan => {
    const scan: CodexConfigScan = {
        activeProvider: null,
        providers: [],
        profileModels: []
    }
    if (!text) return scan
    const providers = new Map<string, Record<string, string>>()
    let section: string | null = null
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const header = /^\[+([^\]]+)\]+$/.exec(line)
        if (header) {
            section = header[1].trim()
            if (section.startsWith('model_providers.'))
                providers.set(
                    tomlScalar(section.slice('model_providers.'.length)),
                    {}
                )
            continue
        }
        const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
        if (!pair) continue
        const key = pair[1]
        const value = tomlScalar(pair[2])
        if (section === null) {
            if (key === 'model_provider') scan.activeProvider = value || null
            continue
        }
        if (section.startsWith('model_providers.')) {
            const id = tomlScalar(section.slice('model_providers.'.length))
            const entry = providers.get(id)
            if (entry) entry[key] = value
            continue
        }
        if (section.startsWith('profiles.') && key === 'model' && value)
            scan.profileModels.push(value)
    }
    for (const [id, entry] of providers) {
        const envKey = entry.env_key || null
        scan.providers.push({
            id,
            hasBaseUrl: Boolean(entry.base_url),
            envKey,
            envKeyPresent: Boolean(
                envKey && process.env[envKey]?.trim()
            ),
            requiresOpenaiAuth: entry.requires_openai_auth === 'true'
        })
    }
    return scan
}

const codexAuthSummary = (text: string | null): string | null => {
    const trimmed = text?.trim()
    if (!trimmed) return null
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const apiKey =
            typeof parsed.OPENAI_API_KEY === 'string'
                ? parsed.OPENAI_API_KEY.trim()
                : typeof parsed.openaiApiKey === 'string'
                  ? parsed.openaiApiKey.trim()
                  : ''
        if (apiKey) return 'auth.json API key'
        const tokens =
            parsed.tokens && typeof parsed.tokens === 'object'
                ? (parsed.tokens as Record<string, unknown>)
                : null
        const hasToken = Boolean(
            tokens &&
            ['id_token', 'access_token', 'refresh_token'].some(
                (key) =>
                    typeof tokens[key] === 'string' &&
                    tokens[key].trim().length > 0
            )
        )
        if (hasToken) return 'auth.json token auth'
        return 'auth.json readable'
    } catch {
        return 'auth.json readable'
    }
}

const claudeCredentialFacts = async (
    configPresent: boolean,
    dirs: FrameworkConfigDirs
): Promise<ClaudeCredentialFacts> => {
    const credentials = parseJsonRecord(
        (await readTextIfPresent(join(dirs.claudeDir, '.credentials.json'))).text
    )
    // Older installs wrote the same block under `oauthAccount`. This is a
    // different file from the ~/.claude.json read below, which happens to use
    // that name for the profile record.
    const oauth =
        nestedRecord(credentials, 'claudeAiOauth') ??
        nestedRecord(credentials, 'oauthAccount')
    const claudeJson = parseJsonRecord(
        (await readTextIfPresent(dirs.claudeJson)).text
    )
    return {
        framework: 'claude-code',
        envToken:
            (dirs.envAuth &&
                Boolean(
                    process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
                    process.env.ANTHROPIC_API_KEY?.trim()
                )) ||
            (await viewKeyPresent(dirs)),
        credentialsFileParsed: credentials !== null,
        oauthExpiresAt:
            typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null,
        hasRefreshToken: nonEmptyString(oauth?.refreshToken),
        oauthAccount: nestedRecord(claudeJson, 'oauthAccount') !== null,
        configPresent
    }
}

const inspectClaudeModels =
    async (
        dirs: FrameworkConfigDirs = nativeConfigDirs()
    ): Promise<DaemonFrameworkModelCapability> => {
        const now = new Date().toISOString()
        const cliVersion = await commandVersion('claude')
        const configReadable =
            (await readablePath(dirs.claudeDir)) ||
            (await readablePath(dirs.claudeJson))
        const credentialReady = Boolean(
            (dirs.envAuth &&
                (process.env.ANTHROPIC_AUTH_TOKEN ||
                    process.env.ANTHROPIC_API_KEY)) ||
            configReadable
        )
        const mapped = [
            process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
            process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
            process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
            process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        ]
        const current = uniqueStrings(mapped).join(' / ') || null
        const error = cliVersion
            ? credentialReady
                ? null
                : 'Claude Code local credentials were not detected'
            : 'claude CLI is not available on PATH'
        return {
            framework: 'claude-code',
            cliVersion,
            ready: Boolean(cliVersion && credentialReady),
            credentialReady,
            credentialFacts: await claudeCredentialFacts(configReadable, dirs),
            configReadable,
            current,
            models: uniqueStrings([...mapped, ...claudeLocalModelCatalog]),
            aliases: [...claudeCodeModelAliases],
            speeds: [],
            intelligence: [],
            lastCheckedAt: now,
            error
        }
    }

const codexCredentialFacts = (
    auth: { ok: boolean; text: string | null },
    scan: CodexConfigScan,
    envCredentialReady: boolean
): CodexCredentialFacts => {
    const parsed = parseJsonRecord(auth.text)
    const tokens = nestedRecord(parsed, 'tokens')
    return {
        framework: 'codex',
        authFilePresent: auth.ok,
        authFileParsed: parsed !== null,
        apiKeyPresent:
            nonEmptyString(parsed?.OPENAI_API_KEY) ||
            nonEmptyString(parsed?.openaiApiKey),
        envApiKey: envCredentialReady,
        hasAccessToken: nonEmptyString(tokens?.access_token),
        hasRefreshToken: nonEmptyString(tokens?.refresh_token),
        accessTokenExp: jwtExpiryMs(tokens?.access_token),
        lastRefresh:
            typeof parsed?.last_refresh === 'string'
                ? parsed.last_refresh
                : null,
        customProviders: scan.providers,
        activeProvider: scan.activeProvider
    }
}

const inspectCodexModels =
    async (
        dirs: FrameworkConfigDirs = nativeConfigDirs()
    ): Promise<DaemonFrameworkModelCapability> => {
        const now = new Date().toISOString()
        const cliVersion = await commandVersion('codex')
        const codexHome = dirs.codexHome
        const config = await readTextIfPresent(join(codexHome, 'config.toml'))
        const auth = await readTextIfPresent(join(codexHome, 'auth.json'))
        const model = config.text ? tomlString(config.text, 'model') : null
        const intelligence = config.text
            ? tomlString(config.text, 'model_reasoning_effort')
            : null
        const speed = config.text
            ? tomlString(config.text, 'service_tier')
            : null
        const requiresOpenAiAuth =
            config.text &&
            /^\s*requires_openai_auth\s*=\s*true\s*$/m.test(config.text)
        const authSummary = auth.ok ? codexAuthSummary(auth.text) : null
        const envCredentialReady =
            Boolean(
                dirs.envAuth &&
                    process.env.OPENAI_API_KEY &&
                    !requiresOpenAiAuth
            ) || (await viewKeyPresent(dirs))
        const credentialReady = Boolean(authSummary || envCredentialReady)
        const scan = scanCodexConfig(config.text)
        const current =
            uniqueStrings([
                model,
                speed === 'fast' ? 'fast' : null,
                intelligence,
                authSummary,
                envCredentialReady ? 'OPENAI_API_KEY env' : null
            ]).join(' · ') || null
        const error =
            config.error ??
            auth.error ??
            (cliVersion
                ? config.ok
                    ? credentialReady
                        ? null
                        : `Codex local credentials were not detected in ${join(
                              codexHome,
                              'auth.json'
                          )}`
                    : 'Codex local config was not detected'
                : 'codex CLI is not available on PATH')
        return {
            framework: 'codex',
            cliVersion,
            ready: Boolean(
                cliVersion && config.ok && credentialReady && !error
            ),
            credentialReady,
            credentialFacts: codexCredentialFacts(
                auth,
                scan,
                envCredentialReady
            ),
            configReadable: config.ok,
            current,
            models: uniqueStrings([
                model,
                ...scan.profileModels,
                ...codexModels
            ]),
            aliases: [],
            speeds: [...codexSpeeds],
            intelligence: [...codexIntelligenceLevels],
            lastCheckedAt: now,
            error
        }
    }

const geminiSettingsModel = (text: string | null): string | null => {
    if (!text) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const model = (parsed as Record<string, unknown>).model
    if (typeof model === 'string') return model.trim() || null
    if (model && typeof model === 'object') {
        const name = (model as Record<string, unknown>).name
        if (typeof name === 'string') return name.trim() || null
    }
    return null
}

const geminiSettingsApiKey = (text: string | null): string | null => {
    if (!text) return null
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        return typeof parsed.apiKey === 'string'
            ? parsed.apiKey.trim() || null
            : null
    } catch {
        return null
    }
}

const geminiCredentialFacts = (
    oauth: { ok: boolean; text: string | null },
    envApiKey: string,
    settingsApiKey: string | null
): GeminiCredentialFacts => {
    const parsed = parseJsonRecord(oauth.text)
    return {
        framework: 'gemini-cli',
        envApiKey: Boolean(envApiKey),
        settingsApiKey: Boolean(settingsApiKey),
        oauthFilePresent: oauth.ok,
        oauthFileParsed: parsed !== null,
        oauthExpiryDate:
            typeof parsed?.expiry_date === 'number'
                ? parsed.expiry_date
                : null,
        hasRefreshToken: nonEmptyString(parsed?.refresh_token)
    }
}

const inspectGeminiModels =
    async (
        dirs: FrameworkConfigDirs = nativeConfigDirs()
    ): Promise<DaemonFrameworkModelCapability> => {
        const now = new Date().toISOString()
        const cliVersion = await commandVersion('gemini')
        const geminiHome = dirs.geminiDir
        const settings = await readTextIfPresent(
            join(geminiHome, 'settings.json')
        )
        const oauth = await readTextIfPresent(
            join(geminiHome, 'oauth_creds.json')
        )
        const settingsModel = geminiSettingsModel(settings.text)
        const settingsApiKey = geminiSettingsApiKey(settings.text)
        const envApiKey = dirs.envAuth
            ? process.env.GEMINI_API_KEY?.trim() ||
              process.env.GOOGLE_API_KEY?.trim() ||
              process.env.GOOGLE_GEMINI_API_KEY?.trim() ||
              ''
            : (await viewKeyPresent(dirs))
              ? 'profile'
              : ''
        const envModel = process.env.GEMINI_MODEL?.trim() || null
        const envBaseUrl =
            process.env.GOOGLE_GEMINI_BASE_URL?.trim() ||
            process.env.GEMINI_BASE_URL?.trim() ||
            null
        const credentialReady = Boolean(envApiKey || settingsApiKey || oauth.ok)
        const configReadable = (await readablePath(geminiHome)) || settings.ok
        const credentialSummary = envApiKey
            ? 'GEMINI_API_KEY env'
            : settingsApiKey
              ? 'settings.json apiKey'
              : oauth.ok
                ? 'oauth_creds.json'
                : null
        const current =
            uniqueStrings([
                envModel,
                settingsModel,
                envBaseUrl,
                credentialSummary
            ]).join(' · ') || null
        const error =
            settings.error ??
            oauth.error ??
            (cliVersion
                ? credentialReady
                    ? null
                    : 'Gemini CLI local credentials were not detected (set GEMINI_API_KEY or run gemini auth)'
                : 'gemini CLI is not available on PATH')
        return {
            framework: 'gemini-cli',
            cliVersion,
            ready: Boolean(cliVersion && credentialReady && !error),
            credentialReady,
            credentialFacts: geminiCredentialFacts(
                oauth,
                envApiKey,
                settingsApiKey
            ),
            configReadable,
            current,
            models: uniqueStrings([
                envModel,
                settingsModel,
                ...geminiLocalModelCatalog
            ]),
            aliases: [geminiAutoModelKey],
            speeds: [],
            intelligence: [],
            lastCheckedAt: now,
            error
        }
    }

const inspectModelCapability = async (
    payload: Record<string, unknown>,
    dirs: FrameworkConfigDirs = nativeConfigDirs()
): Promise<DaemonModelInspectResponse> => {
    const requested =
        typeof payload.framework === 'string' ? payload.framework : null
    // A framework-scoped inspect (account / auth-profile probes) runs only
    // that CLI: each inspector spawns `<cli> --version`, and a profile probe
    // must not touch the other two vendors' binaries at all.
    const inspectors: Array<
        [ModelConfigFramework, () => Promise<DaemonFrameworkModelCapability>]
    > = [
        ['claude-code', () => inspectClaudeModels(dirs)],
        ['codex', () => inspectCodexModels(dirs)],
        ['gemini-cli', () => inspectGeminiModels(dirs)],
        [
            'pi',
            () =>
                inspectPiModels(dirs, {
                    commandVersion,
                    env: dirs.envAuth
                        ? process.env
                        : stripAmbientAuthEnv(process.env)
                })
        ]
    ]
    const selected = requested
        ? inspectors.filter(([framework]) => framework === requested)
        : inspectors
    return {
        frameworks: await Promise.all(selected.map(([, run]) => run()))
    }
}

const inspectResultToRecord = (
    result: DaemonModelInspectResponse
): Record<string, unknown> => ({
    frameworks: result.frameworks.map((item) => ({ ...item }))
})

interface ExecChildEntry {
    child: ChildProcess
    stream: ExecStream
    cancelled: boolean
    stop?: () => void
}

const execChildren = new Map<string, ExecChildEntry>()
// turn.start turns without a child process (openclaw holds an SSE socket, not
// a spawn). Counted so daemon.update drains around them like any session.
const turnSessions = new Set<string>()

// Whether this installation lets a detached exec outlive a daemon restart
// (decided once at start from launchd / systemd KillMode; ADR-0029 §4). Only
// then does the update drain leave file execs out of its count — the next
// daemon adopts them — and admit new ones while an update waits.
let fileExecsAdoptable = false

export const setFileExecsAdoptable = (adoptable: boolean): void => {
    fileExecsAdoptable = adoptable
}

// The sessions an update has to wait for: everything that dies with this
// process. A file exec on an installation that keeps it alive is not one.
export const drainSessionCount = (counts: {
    pipeExecs: number
    fileExecs: number
    ptys: number
    turns: number
    fileExecsAdoptable: boolean
}): number =>
    counts.pipeExecs +
    (counts.fileExecsAdoptable ? 0 : counts.fileExecs) +
    counts.ptys +
    counts.turns

// Installed by the daemon start when this daemon can update itself without
// a supervisor (ADR-0029 §5): it drives the handoff to a successor and never
// returns to serving. Absent, an update restarts through the init unit.
let manualUpdateHandoff: ((result: SelfUpdateResult) => Promise<void>) | null =
    null

export const setManualUpdateHandoff = (
    handoff: ((result: SelfUpdateResult) => Promise<void>) | null
): void => {
    manualUpdateHandoff = handoff
}

export const manualUpdateCapable = (): boolean => manualUpdateHandoff !== null

// Installed by the daemon start on a pod host (startup method 'container'),
// the one kind of daemon that runs services for the platform (ADR-0035 §6).
let serviceSupervisor: ServiceSupervisor | null = null

export const setServiceSupervisor = (
    supervisor: ServiceSupervisor | null
): void => {
    serviceSupervisor = supervisor
}

const withServices = async (
    work: (supervisor: ServiceSupervisor) => Promise<Record<string, unknown>>
): Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }> => {
    if (!serviceSupervisor)
        return { ok: false, error: 'services are not available on this daemon' }
    try {
        return { ok: true, payload: await work(serviceSupervisor) }
    } catch (err) {
        return { ok: false, error: (err as Error).message }
    }
}

const serviceName = (payload: Record<string, unknown>): string =>
    String(payload.name ?? '')

const updateCoordinator = new UpdateDrainCoordinator({
    activeSessions: () =>
        drainSessionCount({
            pipeExecs: execChildren.size,
            fileExecs: fileExecRegistry.size(),
            ptys: ptySessions.size,
            turns: turnSessions.size,
            fileExecsAdoptable
        }),
    applyUpdate: (spec) =>
        performSelfUpdate({
            ...spec,
            // The old binary stays reachable for the rollback only when this
            // process is the one that would perform it.
            keepPrevious: manualUpdateHandoff !== null,
            precheck: async (binary, targetVersion) => {
                // A target that already failed to come up here is not tried
                // again until something else is asked for.
                const latch = await readUpdateLatch(daemonPaths.updateLatchPath)
                if (latch?.version === targetVersion)
                    throw new Error(
                        `update to ${targetVersion} was rolled back at ${latch.at} (${latch.reason}); pick another version`
                    )
                await precheckBinary(binary, targetVersion)
            }
        }),
    // With a supervisor: exit non-zero so launchd (KeepAlive
    // SuccessfulExit=false) / systemd (Restart=on-failure) respawn the
    // freshly-installed binary, after a delay that lets any pending ack
    // frame flush. Without one: hand off to a successor this process starts.
    restart: (result) => {
        if (manualUpdateHandoff) {
            const handoff = manualUpdateHandoff
            setTimeout(() => {
                void handoff(result).catch((err: Error) =>
                    console.error(`manual update handoff failed: ${err.message}`)
                )
            }, 2000)
            return
        }
        setTimeout(() => process.exit(1), 2000)
    },
    log: (msg) => console.error(msg)
})

const releaseExecChild = (refId: string): void => {
    if (execChildren.delete(refId)) updateCoordinator.onSessionEnd()
}

const releasePtySession = (refId: string): void => {
    if (ptySessions.delete(refId)) updateCoordinator.onSessionEnd()
}

// End a pty the way its terminal closing would: a hangup, which an
// interactive shell honours (it ignores SIGTERM) and passes on to what it
// runs, then a kill for anything that stayed. Seen on macOS dev [2026-09-22]:
// `zsh -il` running herdr's TUI outlived SIGTERM on every viewer disconnect.
const hangUpPtySession = (session: TerminalSession): void => {
    try {
        session.kill('SIGHUP')
    } catch {}
    const late = setTimeout(() => {
        try {
            session.kill('SIGKILL')
        } catch {}
    }, PTY_HANGUP_GRACE_MS)
    late.unref?.()
}
const PTY_HANGUP_GRACE_MS = 2_000

export const daemonActivitySnapshot = (): {
    activeExecs: number
    adoptableExecs: number
    activePtys: number
    ownedTerminals: number
    attachedTerminals: number
    herdrTerminals: number
    updatePending: boolean
} => ({
    activeExecs: execChildren.size + fileExecRegistry.size(),
    adoptableExecs: fileExecsAdoptable ? fileExecRegistry.size() : 0,
    // Attachments count as ptys (they hold the update drain); a terminal
    // nobody is attached to does not.
    activePtys: ptySessions.size,
    ownedTerminals: ownedTerminalCount(),
    attachedTerminals: attachedTerminalCount(),
    herdrTerminals: herdrTerminalCount(),
    updatePending: updateCoordinator.blocksNewSessions()
})

export const requestDaemonUpdateIfIdle = (
    spec: DaemonUpdateSpec
): Promise<IdleUpdateOutcome> => updateCoordinator.requestIfIdle(spec)

const subscribeCtxToStream = (
    stream: ExecStream,
    ctx: RpcContext,
    fromSeq: number,
    onDone: (final: {
        ok: boolean
        error?: string
        payload?: Record<string, unknown>
    }) => void
): (() => void) => {
    let settled = false
    const unsubscribe = stream.subscribe((kind, data, seq) => {
        if (kind === '__done__') {
            if (settled) return
            settled = true
            try {
                onDone(
                    JSON.parse(data) as {
                        ok: boolean
                        error?: string
                        payload?: Record<string, unknown>
                    }
                )
            } catch {
                onDone({ ok: false, error: 'invalid final payload' })
            }
            return
        }
        ctx.sendEvent(kind, data, seq)
    }, fromSeq)
    return () => {
        if (settled) return
        settled = true
        unsubscribe()
    }
}

const execStart = async (
    payload: ExecPayload,
    ctx: RpcContext
): Promise<{
    ok: boolean
    payload?: Record<string, unknown>
    error?: string
}> => {
    const cmd = payload.cmd
    if (!Array.isArray(cmd) || cmd.length === 0)
        return { ok: false, payload: { exitCode: -1 }, error: 'cmd required' }
    if (payload.temporarySettings !== undefined && payload.temporarySettings !== 'gemini-platform')
        return { ok: false, payload: { exitCode: -1 }, error: 'unsupported temporary settings' }
    // Idempotent by refId (ADR-0029 §4): a dispatch repeated after a restart
    // attaches to the exec that is still running — or replays the one that
    // finished — instead of starting a second agent on the same turn. Only a
    // crashed leftover is replaced.
    const live = execStreams.get(ctx.refId)
    const priorMeta = readMeta(ctx.refId)
    if (
        live?.status === 'running' ||
        (priorMeta && priorMeta.status !== 'crashed' && readFinal(ctx.refId))
    )
        return execResume({ originalRefId: ctx.refId, fromSeq: 0 }, ctx)
    if (priorMeta) {
        execStreams.delete(ctx.refId)
        rmSync(bufferDir(ctx.refId), { recursive: true, force: true })
    }
    const cwd = payload.dir
        ? ensureUnderAllowedRoot(payload.dir)
        : process.cwd()
    // env stays out of meta.json: it can carry credentials (connection tokens
    // and MF_API_TOKEN since #781), and nothing ever reads it back out of the
    // buffer — a resume re-attaches to the live child. Same rationale as the
    // turn.start meta in acp-turn.
    const { env: _env, authSelection: _sel, ...metaPayload } = payload
    let authContext: Awaited<ReturnType<typeof resolveAuthContext>> = null
    try {
        authContext = await resolveAuthContext(
            payload.authSelection,
            payload.env ?? {},
            `exec:${ctx.refId}`
        )
    } catch (err) {
        return {
            ok: false,
            payload: { exitCode: -1 },
            error: authError(err).error
        }
    }
    // The file path (ADR-0029 §4): the exec runs detached with its IO in
    // files the daemon tails, so it survives this daemon. Its profile lease
    // and temporary settings go with it as paths in the meta. Only an exec
    // that keeps stdin open stays on the pipes.
    if (fileExecEnabled() && !payload.keepStdinOpen) {
        let resources: Awaited<ReturnType<typeof createExecResources>> | undefined
        if (payload.temporarySettings)
            try {
                resources = await createExecResources(cmd, cwd)
            } catch {
                const pending = authContext
                authContext = null
                await pending?.release().catch(() => {})
                return {
                    ok: false,
                    payload: { exitCode: -1 },
                    error: 'exec_resources_setup_failed'
                }
            }
        return execStartFiles(payload, ctx, cwd, metaPayload, {
            auth: authContext
                ? {
                      lockDir: authContext.lockDir,
                      label: `exec:${ctx.refId}`,
                      release: authContext.release
                  }
                : undefined,
            env: authContext
                ? { ...stripAmbientAuthEnv(process.env), ...authContext.env }
                : { ...process.env, ...(payload.env ?? {}) },
            resources
        })
    }
    type Completion = {
        final: ExecBufferFinal
        status: 'completed' | 'aborted' | 'crashed'
    }
    let stream: ExecStream | undefined
    let failure: Completion | null = null
    let outputFailed = false
    let settleCompletion: ((final: ExecBufferFinal) => void) | undefined
    let resources: Awaited<ReturnType<typeof createExecResources>> | undefined
    let resourcesCleanupFailed = false
    const finish = async ({
        final,
        status
    }: Completion): Promise<ExecBufferFinal> => {
        try {
            const outcome = await resources?.release(child)
            if (outcome?.setupFailed) {
                final = { ok: false, payload: { exitCode: -1 }, error: 'exec_spawn_setup_failed' }
                status = 'crashed'
            }
        } catch {
            resourcesCleanupFailed = true
            final = { ok: false, payload: final.payload, error: 'exec_resources_release_failed' }
            status = 'crashed'
        }
        // An unproven process tree still owns its profile lease and update-drain
        // registration. Never admit another profile execution over that tree.
        if (!resourcesCleanupFailed) {
            const pending = authContext
            authContext = null
            try {
                await pending?.release()
            } catch {
                final = { ok: false, payload: final.payload, error: 'auth_context_release_failed' }
                status = 'crashed'
            }
        }
        stream?.complete(final, status)
        settleCompletion?.(final)
        return final
    }
    let child: ChildProcessWithoutNullStreams
    let setupStage = 'buffer'
    try {
        stream = new ExecStream({
            refId: ctx.refId,
            method: 'exec.start',
            payload: metaPayload as unknown as Record<string, unknown>,
            onPublishFailure: (final) => {
                outputFailed = true
                failure ??= { final, status: 'crashed' }
            }
        })
        execStreams.set(ctx.refId, stream)
        setupStage = 'resources'
        if (payload.temporarySettings) resources = await createExecResources(cmd, cwd)
        setupStage = 'spawn'
        const childEnv = authContext
            ? { ...stripAmbientAuthEnv(process.env), ...authContext.env }
            : { ...process.env, ...(payload.env ?? {}) }
        delete childEnv[EXEC_TEMP_DIRECTORY_ENV]
        if (resources) childEnv[EXEC_TEMP_DIRECTORY_ENV] = resources.directory
        const command = resources?.command ?? cmd
        child = spawn(command[0], command.slice(1), {
            cwd,
            env: childEnv,
            detached: Boolean(resources) && process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe']
        })
    } catch {
        return finish({
            final: {
                ok: false,
                payload: { exitCode: -1 },
                error: `exec_${setupStage}_setup_failed`
            },
            status: 'crashed'
        })
    }
    const activeStream = stream
    const stop = (): void => {
        if (resources) resources.stop(child)
        else { try { child.kill('SIGTERM') } catch {} }
    }
    const entry: ExecChildEntry = { child, stream, cancelled: false, ...(resources ? { stop } : {}) }
    execChildren.set(ctx.refId, entry)
    if (child.stdin) {
        child.stdin.on('error', () => {})
        if (typeof payload.stdin === 'string' && payload.stdin.length > 0)
            child.stdin.write(payload.stdin)
        if (!payload.keepStdinOpen) child.stdin.end()
    }
    ctx.onCancel(() => {
        entry.cancelled = true
        stop()
    })
    const safePublish = (kind: 'stdout' | 'stderr', chunk: string): void => {
        if (outputFailed) return
        try {
            activeStream.publish(kind, chunk)
        } catch (err) {
            if (resources) resources.stop(child)
            else { try { child.kill('SIGKILL') } catch {} }
            console.error(
                `exec-buffer publish failed for ${ctx.refId}: ${(err as Error).message}`
            )
        }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => safePublish('stdout', chunk))
    child.stderr?.on('data', (chunk: string) => safePublish('stderr', chunk))

    const timer = payload.timeoutMs
        ? setTimeout(() => {
              stop()
          }, payload.timeoutMs)
        : null

    return new Promise((resolveAck) => {
        let acknowledged = false
        const settle = (final: ExecBufferFinal): void => {
            if (acknowledged) return
            acknowledged = true
            if (!resourcesCleanupFailed) releaseExecChild(ctx.refId)
            resolveAck({
                ok: final.ok,
                payload: final.payload,
                error: final.error
            })
        }
        // Transport subscribers can detach after a failed send. The exec owner
        // still settles its ACK and drain registration after auth cleanup.
        settleCompletion = settle

        subscribeCtxToStream(activeStream, ctx, 0, settle)

        child.on('error', (err) => {
            if (failure) return
            failure = {
                final: {
                    ok: false,
                    payload: { exitCode: -1 },
                    error: err.message
                },
                status: 'completed'
            }
            safePublish('stderr', `[spawn error] ${err.message}\n`)
            if (child.pid) {
                if (resources) resources.stop(child)
                else { try { child.kill('SIGKILL') } catch {} }
            }
        })
        child.once('close', (code) => {
            if (timer) clearTimeout(timer)
            const exitCode = code ?? 0
            const completion =
                failure ??
                (entry.cancelled
                    ? {
                          final: {
                              ok: false,
                              payload: { exitCode },
                              error: 'cancelled'
                          },
                          status: 'aborted' as const
                      }
                    : {
                          final: { ok: true, payload: { exitCode } },
                          status: 'completed' as const
                      })
            // close follows both normal exit and spawn error. Keep the exec
            // registered and resumable until its auth lease has been released.
            void finish(completion)
        })
    })
}

const execStartFiles = async (
    payload: ExecPayload,
    ctx: RpcContext,
    cwd: string,
    metaPayload: Record<string, unknown>,
    owned: {
        auth?: { lockDir: string; label: string; release: () => Promise<void> }
        env: Record<string, string | undefined>
        resources?: Awaited<ReturnType<typeof createExecResources>>
    }
): Promise<{
    ok: boolean
    payload?: Record<string, unknown>
    error?: string
}> => {
    let stream: ExecStream
    try {
        stream = new ExecStream({
            refId: ctx.refId,
            method: 'exec.start',
            payload: metaPayload
        })
        execStreams.set(ctx.refId, stream)
    } catch {
        await owned.resources?.release().catch(() => {})
        await owned.auth?.release().catch(() => {})
        return {
            ok: false,
            payload: { exitCode: -1 },
            error: 'exec_buffer_setup_failed'
        }
    }
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(owned.env))
        if (typeof value === 'string') childEnv[key] = value
    delete childEnv[EXEC_TEMP_DIRECTORY_ENV]
    if (owned.resources)
        childEnv[EXEC_TEMP_DIRECTORY_ENV] = owned.resources.directory
    const handle = startFileExec({
        refId: ctx.refId,
        cmd: owned.resources?.command ?? payload.cmd,
        cwd,
        env: childEnv,
        stdin: typeof payload.stdin === 'string' ? payload.stdin : '',
        timeoutMs: payload.timeoutMs,
        stream,
        log: (message) => console.error(message),
        auth: owned.auth,
        resources: owned.resources
            ? {
                  directory: owned.resources.directory,
                  release: (leader) => owned.resources!.release(leader)
              }
            : undefined
    })
    ctx.onCancel(() => handle.abort())
    return new Promise((resolveAck) => {
        let acknowledged = false
        const settle = (final: ExecBufferFinal): void => {
            if (acknowledged) return
            acknowledged = true
            updateCoordinator.onSessionEnd()
            resolveAck({
                ok: final.ok,
                payload: final.payload,
                error: final.error
            })
        }
        subscribeCtxToStream(stream, ctx, 0, settle)
        void handle.done.then(settle)
    })
}

const execResume = async (
    payload: Record<string, unknown>,
    ctx: RpcContext
): Promise<{
    ok: boolean
    payload?: Record<string, unknown>
    error?: string
}> => {
    const originalRefId = String(payload.originalRefId ?? '').trim()
    const fromSeq = Number(payload.fromSeq ?? 0)
    if (!originalRefId) return { ok: false, error: 'originalRefId required' }
    const stream = execStreams.get(originalRefId)
    if (stream && stream.status === 'running') {
        return new Promise((resolveAck) => {
            const unsubscribe = subscribeCtxToStream(
                stream,
                ctx,
                fromSeq,
                (final) => {
                    resolveAck({
                        ok: final.ok,
                        payload: final.payload,
                        error: final.error
                    })
                }
            )
            ctx.onCancel(() => {
                unsubscribe()
                void execAbort({ refId: originalRefId })
                resolveAck({
                    ok: false,
                    error: 'cancelled'
                })
            })
        })
    }
    for (const event of readEventsFrom(originalRefId, fromSeq))
        if (event.kind !== '__done__')
            ctx.sendEvent(event.kind, event.data, event.seq)
    const final = readFinal(originalRefId)
    if (final)
        return { ok: final.ok, payload: final.payload, error: final.error }
    const meta = readMeta(originalRefId)
    if (!meta)
        return {
            ok: false,
            error: `no buffer for refId ${originalRefId}`
        }
    return { ok: false, error: 'daemon process crashed' }
}

const execAbort = async (
    payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> => {
    const refId = String(payload.refId ?? '').trim()
    if (!refId) return { ok: false, error: 'refId required' }
    const fileExec = fileExecRegistry.get(refId)
    if (fileExec) {
        fileExec.abort()
        return { ok: true }
    }
    const entry = execChildren.get(refId)
    if (!entry) {
        const meta = readMeta(refId)
        if (!meta) return { ok: false, error: `no buffer for refId ${refId}` }
        return { ok: true }
    }
    if (entry.cancelled) return { ok: true }
    entry.cancelled = true
    if (entry.stop) {
        entry.stop()
        return { ok: true }
    }
    try {
        entry.child.kill('SIGTERM')
    } catch {}
    setTimeout(() => {
        try {
            entry.child.kill('SIGKILL')
        } catch {}
    }, 5_000).unref()
    return { ok: true }
}

const execInput = async (
    payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> => {
    const refId = String(payload.refId ?? '').trim()
    if (!refId) return { ok: false, error: 'refId required' }
    // A file exec's stdin was a file, closed at spawn.
    if (fileExecRegistry.get(refId)) return { ok: false, error: 'stdin closed' }
    const entry = execChildren.get(refId)
    if (!entry) return { ok: false, error: `no live child for refId ${refId}` }
    if (!entry.child.stdin || entry.child.stdin.writableEnded)
        return { ok: false, error: 'stdin closed' }
    const encoding =
        typeof payload.encoding === 'string' ? payload.encoding : 'utf8'
    const raw = String(payload.data ?? '')
    const buf =
        encoding === 'base64'
            ? Buffer.from(raw, 'base64')
            : Buffer.from(raw, 'utf8')
    try {
        entry.child.stdin.write(buf)
    } catch (err) {
        return { ok: false, error: (err as Error).message }
    }
    return { ok: true }
}

const execEof = async (
    payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> => {
    const refId = String(payload.refId ?? '').trim()
    if (!refId) return { ok: false, error: 'refId required' }
    if (fileExecRegistry.get(refId)) return { ok: true }
    const entry = execChildren.get(refId)
    if (!entry) return { ok: false, error: `no live child for refId ${refId}` }
    if (!entry.child.stdin || entry.child.stdin.writableEnded)
        return { ok: true }
    try {
        entry.child.stdin.end()
    } catch (err) {
        return { ok: false, error: (err as Error).message }
    }
    return { ok: true }
}

// One manager per call: the scope needs the registration id, which lives in
// the daemon config on disk and may be re-registered between calls.
const runtimeAuthManagerFor = async (
    runtimeId: unknown
): Promise<RuntimeAuthManager> => {
    const config = await loadDaemonConfig()
    if (!config?.daemonId) throw new Error('daemon is not registered')
    if (typeof runtimeId !== 'string') throw new Error('runtimeId required')
    return new RuntimeAuthManager(
        { daemonId: config.daemonId, runtimeId },
        {
            credentialFacts: async (framework, dirs) =>
                (await inspectModelCapability({ framework }, dirs)).frameworks[0]
                    ?.credentialFacts ?? null,
            cliVersion: (framework) => commandVersion(cliBinaryFor(framework)),
            fetch: globalThis.fetch,
            now: Date.now,
            platform: process.platform,
            env: process.env
        }
    )
}

const modelConfigFrameworkOf = (
    payload: Record<string, unknown>
): ModelConfigFramework => {
    const framework = String(payload.framework ?? '')
    if (!isModelConfigFramework(framework))
        throw new Error(`unsupported framework: ${framework}`)
    return framework
}

const authError = (err: unknown): { ok: false; error: string } => ({
    ok: false,
    error:
        err instanceof ProfileBusyError
            ? 'auth_profile_busy'
            : (err as Error).message
})

const handlers: Partial<
    Record<
        DaemonRpcMethod,
        (
            payload: Record<string, unknown>,
            ctx: RpcContext
        ) => Promise<{
            ok: boolean
            payload?: Record<string, unknown>
            error?: string
        }>
    >
> = {
    'model.inspect': async (payload) => {
        const selection =
            payload.authSelection && typeof payload.authSelection === 'object'
                ? (payload.authSelection as Record<string, unknown>)
                : null
        if (!selection || selection.mode !== 'profile')
            return {
                ok: true,
                payload: inspectResultToRecord(await inspectModelCapability(payload))
            }
        try {
            const manager = await runtimeAuthManagerFor(selection.runtimeId)
            const dirs = manager.dirsFor(
                modelConfigFrameworkOf(selection),
                assertProfileId(selection.profileId)
            )
            return {
                ok: true,
                payload: inspectResultToRecord(
                    await inspectModelCapability(payload, dirs)
                )
            }
        } catch (err) {
            return authError(err)
        }
    },
    'account.inspect': async (payload) => {
        const framework = String(payload.framework ?? '')
        if (!isModelConfigFramework(framework))
            return { ok: false, error: `unsupported framework: ${framework}` }
        // The credential facts ride along so the API judges "signed in" with
        // the same evaluator it already trusts for model.inspect.
        const capability = (
            await inspectModelCapability({ framework })
        ).frameworks.find((item) => item.framework === framework)
        const account = await inspectRuntimeAccount(framework, {
            cliVersion: capability?.cliVersion?.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
            // The API skips the vendor usage call while it holds a fresh answer.
            usage: payload.usage !== false
        })
        return {
            ok: true,
            payload: {
                ...account,
                credentialFacts: capability?.credentialFacts ?? null
            }
        }
    },
    'auth.list': async (payload) => {
        try {
            const manager = await runtimeAuthManagerFor(payload.runtimeId)
            const result = await manager.list(
                modelConfigFrameworkOf(payload),
                payload.probe !== false
            )
            return { ok: true, payload: { ...result } }
        } catch (err) {
            return authError(err)
        }
    },
    'auth.create': async (payload) => {
        try {
            const manager = await runtimeAuthManagerFor(payload.runtimeId)
            const apiKey =
                typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
            const result = await manager.create(
                modelConfigFrameworkOf(payload),
                assertProfileId(payload.profileId),
                payload.authMethod === 'api-key' ? 'api-key' : 'subscription',
                apiKey || undefined
            )
            return { ok: true, payload: { ...result } }
        } catch (err) {
            return authError(err)
        }
    },
    'auth.inspect': async (payload) => {
        try {
            const manager = await runtimeAuthManagerFor(payload.runtimeId)
            const result = await manager.inspect(
                modelConfigFrameworkOf(payload),
                assertProfileId(payload.profileId)
            )
            return { ok: true, payload: { ...result } }
        } catch (err) {
            return authError(err)
        }
    },
    'auth.logout': async (payload) => {
        try {
            const manager = await runtimeAuthManagerFor(payload.runtimeId)
            const result = await manager.logout(
                modelConfigFrameworkOf(payload),
                assertProfileId(payload.profileId),
                assertOperationId(payload.operationId),
                payload.mode === 'remove' ? 'remove' : 'sign-out'
            )
            return { ok: true, payload: { ...result } }
        } catch (err) {
            return authError(err)
        }
    },
    'auth.operation': async (payload) => {
        try {
            const manager = await runtimeAuthManagerFor(payload.runtimeId)
            const record = await manager.operation(
                assertOperationId(payload.operationId)
            )
            return record
                ? { ok: true, payload: { ...record } }
                : { ok: false, error: 'operation not found' }
        } catch (err) {
            return authError(err)
        }
    },
    'daemon.update': async (payload) => {
        if (detectStartupMethod() === 'manual' && !manualUpdateCapable())
            return {
                ok: false,
                error: 'daemon is not managed by an init unit (launchd/systemd); run `mf update` then restart it manually'
            }
        const targetVersion =
            typeof payload.targetVersion === 'string' &&
            payload.targetVersion.length > 0
                ? payload.targetVersion
                : undefined
        // An API deployed before the dev rename still sends 'staging' on the
        // wire; a rolling deploy must not brick the RPC.
        const channel = normalizeWireChannel(payload.channel)
        let outcome
        try {
            outcome = await updateCoordinator.request({
                targetVersion,
                channel
            })
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
        if (outcome.kind === 'deferred')
            return {
                ok: true,
                payload: {
                    fromVersion: MF_CLI_VERSION,
                    toVersion: targetVersion ?? null,
                    restarting: false,
                    deferred: true,
                    activeSessions: outcome.activeSessions
                }
            }
        return {
            ok: true,
            payload: {
                fromVersion: outcome.result.from,
                toVersion: outcome.result.to,
                // Which commit a dev daemon actually landed on: consecutive
                // dev builds share a version, so the server cannot tell from
                // toVersion alone.
                toCommit: outcome.result.commit,
                restarting: outcome.result.changed
            }
        }
    },
    'service.upsert': async (payload) =>
        withServices(async (services) => {
            await services.upsert(payload.spec as DaemonServiceSpec)
            return {}
        }),
    'service.start': async (payload) =>
        withServices(async (services) => ({
            service: await services.start(serviceName(payload))
        })),
    'service.stop': async (payload) =>
        withServices(async (services) => ({
            service: await services.stop(serviceName(payload))
        })),
    'service.delete': async (payload) =>
        withServices(async (services) => {
            await services.remove(serviceName(payload))
            return {}
        }),
    'service.list': async () =>
        withServices(async (services) => ({
            services: await services.list()
        })),
    'workspace.ensure': async (payload) => {
        const requestedPath = String(payload.path ?? '')
        const mode = workspaceEnsureMode(
            requestedPath,
            payload.create !== false
        )
        if (mode === 'create-managed') {
            const abs = ensureUnderWorkspaces(requestedPath)
            await mkdir(abs, { recursive: true, mode: 0o755 })
            return { ok: true, payload: { path: abs } }
        }
        const abs = await assertUsableWorkspace(requestedPath)
        ensureRegisteredRootsLoaded()
        registeredWorkspaceRoots.add(abs)
        saveRegisteredWorkspaceRoots()
        return { ok: true, payload: { path: abs } }
    },
    'workspace.delete': async (payload) => {
        const remove = payload.remove !== false
        const requestedPath = String(payload.path ?? '')
        const abs = resolve(expandHome(requestedPath))
        if (remove && isInsideManagedRoot(abs))
            await rm(ensureUnderWorkspaces(requestedPath), {
                recursive: true,
                force: true
            })
        ensureRegisteredRootsLoaded()
        registeredWorkspaceRoots.delete(abs)
        saveRegisteredWorkspaceRoots()
        return { ok: true }
    },
    'exec.start': async (payload, ctx) => {
        // A pending update refuses work that would die with this process; an
        // exec the next daemon adopts is not that, so it is admitted.
        const adoptable =
            fileExecEnabled() && fileExecsAdoptable && !payload.keepStdinOpen
        if (updateCoordinator.blocksNewSessions() && !adoptable)
            return { ok: false, error: UPDATE_PENDING_ERROR }
        return execStart(payload as unknown as ExecPayload, ctx)
    },
    'exec.resume': async (payload, ctx) => execResume(payload, ctx),
    'turn.start': async (payload, ctx) => {
        if (updateCoordinator.blocksNewSessions())
            return { ok: false, error: UPDATE_PENDING_ERROR }
        const p = payload as unknown as DaemonTurnStartPayload
        if (p.framework === 'hermes') {
            if (typeof p.prompt !== 'string' || p.prompt.length === 0)
                return { ok: false, error: 'prompt required' }
            const cwd = p.dir ? ensureUnderAllowedRoot(p.dir) : process.cwd()
            return runAcpTurn({
                payload: p,
                cwd,
                ctx,
                // Registered like an exec child so exec.abort reaches it and,
                // more importantly, daemon.update drains around it instead of
                // restarting mid-turn.
                registerChild: (child, stream) => {
                    execChildren.set(ctx.refId, {
                        child,
                        stream,
                        cancelled: false
                    })
                },
                releaseChild: () => releaseExecChild(ctx.refId)
            })
        }
        if (p.framework === 'openclaw') {
            // The ACP shape (ADR-0027): the daemon drives `openclaw acp`
            // against the host's own gateway as a real child, so it registers
            // like a hermes turn — exec.abort reaches it and daemon.update
            // drains around it. The gateway-http shape merely holds an SSE
            // socket and has no child.
            if (p.transport === 'acp') {
                if (typeof p.prompt !== 'string' || p.prompt.length === 0)
                    return { ok: false, error: 'prompt required' }
                if (typeof p.sessionKey !== 'string' || p.sessionKey.length === 0)
                    return { ok: false, error: 'sessionKey required' }
                const cwd = p.dir ? ensureUnderAllowedRoot(p.dir) : process.cwd()
                return runOpenclawAcpTurn({
                    payload: p,
                    cwd,
                    ctx,
                    registerChild: (child, stream) => {
                        execChildren.set(ctx.refId, {
                            child,
                            stream,
                            cancelled: false
                        })
                    },
                    releaseChild: () => releaseExecChild(ctx.refId)
                })
            }
            if (typeof p.url !== 'string' || p.url.length === 0)
                return { ok: false, error: 'url required' }
            if (!p.body || typeof p.body !== 'object')
                return { ok: false, error: 'body required' }
            return runOpenclawTurn({
                payload: p,
                ctx,
                registerChild: () => {
                    turnSessions.add(ctx.refId)
                },
                releaseChild: () => {
                    if (turnSessions.delete(ctx.refId))
                        updateCoordinator.onSessionEnd()
                }
            })
        }
        return {
            ok: false,
            error: `not_implemented: turn.start framework=${String(
                (payload as { framework?: unknown }).framework
            )}`
        }
    },
    'exec.abort': async (payload) => execAbort(payload),
    // Answer a pending interactive hermes ask. refId names the turn (it is
    // the turn.start refId == assistantMessageId); 'unknown_request' = never
    // seen, already answered, or expired — the API maps it to 409.
    'turn.permission': async (payload) => {
        const p = payload as {
            refId?: string
            requestId?: string
            optionId?: string
        }
        if (!p.refId || !p.requestId || !p.optionId)
            return { ok: false, error: 'refId, requestId and optionId required' }
        const responder = permissionResponders.get(p.refId)
        if (!responder) return { ok: false, error: 'unknown_request' }
        const outcome = responder(p.requestId, p.optionId)
        if (outcome !== 'delivered')
            return { ok: false, error: 'unknown_request' }
        return { ok: true }
    },
    'exec.input': async (payload) => execInput(payload),
    'exec.eof': async (payload) => execEof(payload),
    'fs.list': async (payload) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
        const entries = await readdir(abs, { withFileTypes: true })
        return {
            ok: true,
            payload: {
                entries: entries.map((e) => ({
                    name: e.name,
                    type: e.isDirectory() ? 'dir' : 'file'
                }))
            }
        }
    },
    'fs.stat': async (payload) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
        const s = await stat(abs)
        return {
            ok: true,
            payload: {
                size: s.size,
                isDir: s.isDirectory(),
                mtime: s.mtimeMs
            }
        }
    },
    'fs.read': async (payload, ctx) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
        const st = await stat(abs)
        if (st.isDirectory()) return { ok: false, error: 'path is a directory' }
        if (payload.chunked === false) {
            const content = await readFile(abs, 'utf8')
            return {
                ok: true,
                payload: { content, size: st.size, chunked: false }
            }
        }
        const stream = createReadStream(abs, { highWaterMark: 64 * 1024 })
        let cancelled = false
        ctx.onCancel(() => {
            cancelled = true
            stream.destroy()
        })
        try {
            for await (const chunk of stream) {
                if (cancelled) break
                const b = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk as string, 'utf8')
                ctx.sendEvent('fs.chunk', b.toString('base64'))
            }
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
        return {
            ok: true,
            payload: { size: st.size, chunked: true }
        }
    },
    'fs.write': async (payload, ctx) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
        if (payload.configCommit !== undefined) {
            if (payload.encoding !== undefined || payload.mode !== '600') return { ok: false, error: 'config_commit_invalid' }
            try {
                if (payload.content !== null && typeof payload.content !== 'string') return { ok: false, error: 'config_commit_invalid' }
                const status = await commitConfigFile({ path: abs, content: payload.content as string | null, commit: payload.configCommit, ctx, validatePath: () => ensureUnderAllowedRoot(abs) })
                return { ok: true, payload: { status } }
            } catch (error) {
                const message = (error as Error).message
                return { ok: false, error: /^config_commit_[a-z_]+$/.test(message) ? message : 'config_commit_io_failed' }
            }
        }
        await mkdir(join(abs, '..'), { recursive: true })
        const raw = String(payload.content ?? '')
        // base64 keeps binary attachments (images, PDFs) intact; the legacy
        // utf8 path is lossy for non-text bytes (DAEMON_FEATURE_FS_WRITE_BINARY).
        if (payload.encoding === 'base64')
            await writeFile(abs, Buffer.from(raw, 'base64'))
        else await writeFile(abs, raw, 'utf8')
        // DAEMON_FEATURE_FS_WRITE_MODE: an octal `mode` tightens config files
        // that carry secrets; chmod after the write so it also corrects a
        // pre-existing looser file.
        const mode =
            typeof payload.mode === 'string' &&
            /^0?[0-7]{3}$/.test(payload.mode)
                ? parseInt(payload.mode, 8)
                : null
        if (mode !== null) await chmod(abs, mode)
        return { ok: true }
    },
    'fs.mkdir': async (payload) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
        await mkdir(abs, { recursive: true, mode: 0o755 })
        return { ok: true }
    },
    'fs.mv': async (payload) => {
        const from = ensureUnderAllowedRoot(String(payload.from ?? ''))
        const to = ensureUnderAllowedRoot(String(payload.to ?? ''))
        await rename(from, to)
        return { ok: true }
    },
    'fs.rm': async (payload) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
        await rm(abs, { recursive: !!payload.recursive, force: true })
        return { ok: true }
    },
    'pty.open': async (payload, ctx) => {
        // A terminal id makes the pty the daemon's (ADR-0029 §6): this
        // stream is one attachment to it, and a second open with the same
        // id attaches to what is already running instead of spawning again.
        // Attaching is not a new session, so it is not gated by the drain.
        if (payload.terminalId !== undefined && !isOwnedTerminalId(payload.terminalId))
            return { ok: false, error: 'invalid terminalId' }
        const terminalId = isOwnedTerminalId(payload.terminalId)
            ? payload.terminalId
            : null
        if (terminalId && ownedTerminal(terminalId)) {
            try {
                ctx.sendEvent('pty.attach', JSON.stringify({ mode: 'attached' }))
            } catch {
                return { ok: false, error: 'ws not open' }
            }
            return attachStreamToOwnedTerminal(terminalId, payload, ctx)
        }
        if (updateCoordinator.blocksNewSessions())
            return { ok: false, error: UPDATE_PENDING_ERROR }
        // A sign-in for a runtime auth profile: the manager composes argv and
        // env from the profile id (holding the profile lock for the shell's
        // lifetime) and the caller's cwd/command/env are ignored, so nothing
        // the API sends can point the vendor CLI at another credential dir.
        const authLogin =
            payload.authLogin && typeof payload.authLogin === 'object'
                ? (payload.authLogin as Record<string, unknown>)
                : null
        if (authLogin && terminalId)
            return {
                ok: false,
                error: 'terminalId is not supported for a sign-in terminal'
            }
        if (terminalId) {
            try {
                assertOwnedTerminalCapacity()
            } catch (err) {
                return { ok: false, error: (err as Error).message }
            }
        }
        let login: Awaited<
            ReturnType<RuntimeAuthManager['prepareLogin']>
        > | null = null
        if (authLogin) {
            try {
                const manager = await runtimeAuthManagerFor(authLogin.runtimeId)
                login = await manager.prepareLogin(
                    modelConfigFrameworkOf(authLogin),
                    assertProfileId(authLogin.profileId),
                    assertOperationId(authLogin.operationId)
                )
            } catch (err) {
                return authError(err)
            }
        }
        // An agent terminal under a profile: same context as a turn, held
        // until the shell exits (an interactive shell keeps the lock).
        let authContext: Awaited<ReturnType<typeof resolveAuthContext>> = null
        if (!login) {
            try {
                authContext = await resolveAuthContext(
                    payload.authSelection,
                    (payload.env ?? {}) as Record<string, string>,
                    `pty:${ctx.refId}`
                )
            } catch (err) {
                return authError(err)
            }
        }
        const releaseAuth = (): void => {
            const pending = authContext
            authContext = null
            void pending?.release()
        }
        const cwd = login
            ? login.cwd
            : payload.cwd
              ? ensureUnderAllowedRoot(String(payload.cwd))
              : homedir()
        const env: Record<string, string> = {}
        const baseEnv = login
            ? login.env
            : authContext
              ? stripAmbientAuthEnv(process.env)
              : process.env
        for (const [k, v] of Object.entries(baseEnv))
            if (typeof v === 'string') env[k] = v
        for (const [k, v] of Object.entries(
            (login
                ? {}
                : authContext
                  ? authContext.env
                  : (payload.env ?? {})) as Record<string, string>
        ))
            env[k] = v
        const shell = process.env.SHELL || '/bin/bash'
        const cols = Math.max(20, Math.min(500, Number(payload.cols ?? 80)))
        const rows = Math.max(5, Math.min(200, Number(payload.rows ?? 24)))
        const backend = await resolvePtyBackend().catch((err) => {
            ctx.sendEvent(
                'pty.out',
                encodePtyOut(
                    `\r\n[mf] ${(err as Error).message}\r\n` +
                        '[mf] Falling back to a limited pipe terminal; resize and job control may not work.\r\n\r\n'
                )
            )
            return null
        })
        if (!backend) {
            if (login) await login.finish(null)
            releaseAuth()
            return openPipeTerminal({ shell, cwd, env }, ctx)
        }

        // A supplied command runs as the shell's argv rather than being typed
        // in: there is no prompt-ready signal to wait for, and the trailing
        // exec leaves the interactive shell the user would otherwise have had,
        // so quitting whatever it started is not a dead end.
        const command = login
            ? [...login.command]
            : Array.isArray(payload.command)
              ? (payload.command as unknown[]).filter(
                    (part): part is string => typeof part === 'string'
                )
              : []
        // herdr's TUI as the terminal (the ADR-0031 viewer) runs the binary
        // the daemon detected: a sandbox's login shell need not have
        // ~/.local/bin on PATH.
        if (command[0] === HERDR_BINARY) {
            const found = currentHerdr()
            if (found) command[0] = found.path
        }
        const args = command.length
            ? [
                  '-ilc',
                  `${command.map(shellQuoteArg).join(' ')}; exec ${shell} -il`
              ]
            : ['-il']

        if (terminalId)
            return spawnOwnedTerminal(
                {
                    terminalId,
                    backend,
                    shell,
                    args,
                    cwd,
                    env,
                    cols,
                    rows,
                    profileBound: authContext !== null,
                    releaseAuth
                },
                ctx
            )

        let term: ReturnType<typeof backend.spawn>
        try {
            term = backend.spawn({
            shell,
            args,
            cwd,
            env,
            cols,
            rows,
            onData: (chunk) => {
                try {
                    ctx.sendEvent('pty.out', encodePtyChunk(chunk))
                } catch {
                    // ws may be gone; a throw inside Bun's native data callback is uncatchable upstream
                }
            }
            })
        } catch (err) {
            releaseAuth()
            if (login) await login.finish(null)
            throw err
        }
        ptySessions.set(ctx.refId, term)
        ctx.onCancel(() => {
            hangUpPtySession(term)
            releasePtySession(ctx.refId)
        })
        const exitCode = await term.exited
        releasePtySession(ctx.refId)
        releaseAuth()
        if (login) {
            const record = await login.finish(exitCode)
            return { ok: true, payload: { exitCode, operation: { ...record } } }
        }
        return { ok: true, payload: { exitCode } }
    },
    'pty.input': async (payload) => {
        const session = ptySessions.get(String(payload.refId ?? ''))
        if (!session) return { ok: false, error: 'pty session not found' }
        const data = Buffer.from(String(payload.data ?? ''), 'base64')
        try {
            session.write(data.toString('utf8'))
            return { ok: true }
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
    },
    'pty.resize': async (payload) => {
        const session = ptySessions.get(String(payload.refId ?? ''))
        if (!session) return { ok: true }
        const cols = Math.max(20, Math.min(500, Number(payload.cols ?? 80)))
        const rows = Math.max(5, Math.min(200, Number(payload.rows ?? 24)))
        try {
            session.resize(cols, rows)
        } catch {}
        return { ok: true }
    },
    'pty.close': async (payload) => {
        // A terminal herdr hosts (ADR-0031) is closed through herdr: its
        // pane goes, the TUI with it, and the inventory drops the terminal.
        if (
            isOwnedTerminalId(payload.terminalId) &&
            herdrTerminal(payload.terminalId)
        ) {
            await closeHerdrTerminal(payload.terminalId)
            return { ok: true }
        }
        // By terminal id from any API instance (a release, a takeover, the
        // reaper): the process is killed, its attachment learns from the exit.
        if (isOwnedTerminalId(payload.terminalId)) {
            closeOwnedTerminal(payload.terminalId)
            return { ok: true }
        }
        const session = ptySessions.get(String(payload.refId ?? ''))
        if (!session) return { ok: true }
        hangUpPtySession(session)
        releasePtySession(String(payload.refId ?? ''))
        return { ok: true }
    },
    // Hand a chat session's TUI to herdr on this machine (ADR-0031). The
    // gates are pty.open's: a terminal id the API minted, no new session
    // while an update drains, a cwd under an allowed root, and a
    // profile-bound agent's context held for as long as the pane lives.
    'terminal.herdr.open': async (payload) => {
        if (!isOwnedTerminalId(payload.terminalId))
            return { ok: false, error: 'invalid terminalId' }
        if (updateCoordinator.blocksNewSessions())
            return { ok: false, error: UPDATE_PENDING_ERROR }
        if (!isHerdrFramework(payload.framework))
            return {
                ok: false,
                error: `herdr_launch_failed: no herdr agent kind for ${String(payload.framework)}`
            }
        const command = Array.isArray(payload.command)
            ? (payload.command as unknown[]).filter(
                  (part): part is string => typeof part === 'string'
              )
            : []
        if (command.length === 0)
            return { ok: false, error: 'herdr_launch_failed: command is required' }
        let cwd: string
        try {
            cwd = payload.cwd
                ? ensureUnderAllowedRoot(String(payload.cwd))
                : homedir()
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
        const callerEnv = (payload.env ?? {}) as Record<string, string>
        let authContext: Awaited<ReturnType<typeof resolveAuthContext>> = null
        try {
            authContext = await resolveAuthContext(
                payload.authSelection,
                callerEnv,
                `herdr:${payload.terminalId}`
            )
        } catch (err) {
            return authError(err)
        }
        // herdr composes the pane's base env itself, so the profile's
        // context rides on top of the caller's block: the TUI answers as
        // the agent's account, while the machine's ambient sign-in (which
        // a pty under a profile strips) stays whatever herdr's shell has.
        const env = { ...callerEnv, ...(authContext?.env ?? {}) }
        const release = authContext
        try {
            const result = await openInHerdr({
                terminalId: payload.terminalId,
                framework: payload.framework,
                command,
                cwd,
                env,
                title: typeof payload.title === 'string' ? payload.title : '',
                agentName:
                    typeof payload.agentName === 'string'
                        ? payload.agentName
                        : '',
                chatSessionId:
                    typeof payload.chatSessionId === 'string'
                        ? payload.chatSessionId
                        : null,
                release: release ? () => release.release() : null,
                // A platform runner owns its sandbox: herdr's server is started
                // on demand there. A self-owned computer's herdr is the user's
                // to start.
                autoStartServer: resolveProfile() === RUNNER_PROFILE
            })
            return { ok: true, payload: { ...result } }
        } catch (err) {
            if (release) await release.release().catch(() => {})
            return { ok: false, error: herdrErrorString(err) }
        }
    },
    'terminal.herdr.focus': async (payload) => {
        if (!isOwnedTerminalId(payload.terminalId))
            return { ok: false, error: 'invalid terminalId' }
        try {
            const result = await focusHerdrTerminal(payload.terminalId)
            return { ok: true, payload: { ...result } }
        } catch (err) {
            return { ok: false, error: herdrErrorString(err) }
        }
    },
    // The Update Center's herdr upgrade (ADR-0031): herdr's own updater, the
    // version it left behind reported back and on the next heartbeat.
    'herdr.update': async () => {
        const result = await updateHerdr()
        return result.ok
            ? { ok: true, payload: { ...result } }
            : {
                  ok: false,
                  error: `herdr_update_failed: ${result.error ?? 'unknown'}`
              }
    }
}

const ownedSession = (terminalId: string): TerminalSession => ({
    write: (data): void => {
        ownedTerminal(terminalId)?.term.write(data)
    },
    resize: (cols, rows): void => {
        resizeOwnedTerminal(terminalId, cols, rows)
    },
    kill: (): void => {
        closeOwnedTerminal(terminalId)
    }
})

const ptySize = (
    payload: Record<string, unknown>
): { cols: number; rows: number } => ({
    cols: Math.max(20, Math.min(500, Number(payload.cols ?? 80))),
    rows: Math.max(5, Math.min(200, Number(payload.rows ?? 24)))
})

// The stream becomes the terminal's attachment: it gets the screen so far and
// then the live tail, its cancel detaches (the terminal stays for the next
// attachment), and it ends when the pty exits or another attachment takes
// over. Input and resize keep addressing it by refId meanwhile.
const attachStreamToOwnedTerminal = async (
    terminalId: string,
    payload: Record<string, unknown>,
    ctx: RpcContext
): Promise<{ ok: boolean; error?: string; payload?: Record<string, unknown> }> => {
    let settle!: (result: { exitCode?: number; detached?: boolean }) => void
    const settled = new Promise<{ exitCode?: number; detached?: boolean }>(
        (resolveSettled) => {
            settle = resolveSettled
        }
    )
    const attachment: OwnedTerminalAttachment = {
        refId: ctx.refId,
        send: (base64) => ctx.sendEvent('pty.out', base64),
        settle: (result) => settle(result)
    }
    if (!attachOwnedTerminal(terminalId, attachment, ptySize(payload)))
        return { ok: false, error: 'terminal not found' }
    ptySessions.set(ctx.refId, ownedSession(terminalId))
    ctx.onCancel(() => {
        detachOwnedTerminal(terminalId, ctx.refId)
        releasePtySession(ctx.refId)
    })
    const result = await settled
    releasePtySession(ctx.refId)
    return {
        ok: true,
        payload: result.detached
            ? { detached: true }
            : { exitCode: result.exitCode ?? 0 }
    }
}

const spawnOwnedTerminal = async (
    args: {
        terminalId: string
        backend: Awaited<ReturnType<typeof resolvePtyBackend>>
        shell: string
        args: string[]
        cwd: string
        env: Record<string, string>
        cols: number
        rows: number
        profileBound: boolean
        releaseAuth: () => void
    },
    ctx: RpcContext
): Promise<{ ok: boolean; error?: string; payload?: Record<string, unknown> }> => {
    // Announced before the first byte, so the viewer resets before output.
    try {
        ctx.sendEvent('pty.attach', JSON.stringify({ mode: 'spawned' }))
    } catch {
        args.releaseAuth()
        return { ok: false, error: 'ws not open' }
    }
    // The data callback only enqueues (a throw inside Bun's native callback
    // is uncatchable upstream); whatever arrives before the registry has the
    // terminal is held back and fed once it does.
    const early: Array<Uint8Array | string> = []
    let feed: (chunk: Uint8Array | string) => void = (chunk) => {
        early.push(chunk)
    }
    let term: ReturnType<typeof args.backend.spawn>
    try {
        term = args.backend.spawn({
            shell: args.shell,
            args: args.args,
            cwd: args.cwd,
            env: args.env,
            cols: args.cols,
            rows: args.rows,
            onData: (chunk) => feed(chunk)
        })
    } catch (err) {
        args.releaseAuth()
        throw err
    }
    try {
        const registered = registerOwnedTerminal({
            terminalId: args.terminalId,
            term,
            cols: args.cols,
            rows: args.rows,
            profileBound: args.profileBound,
            onExit: () => args.releaseAuth(),
            log: (message) => console.error(message)
        })
        feed = registered.feed
        for (const chunk of early.splice(0)) feed(chunk)
    } catch (err) {
        try {
            term.kill('SIGTERM')
        } catch {}
        args.releaseAuth()
        return { ok: false, error: (err as Error).message }
    }
    return attachStreamToOwnedTerminal(
        args.terminalId,
        { cols: args.cols, rows: args.rows },
        ctx
    )
}

const encodePtyOut = (text: string): string =>
    Buffer.from(text, 'utf8').toString('base64')

const openPipeTerminal = async (
    args: {
        shell: string
        cwd: string
        env: Record<string, string>
    },
    ctx: RpcContext
): Promise<{ ok: boolean; payload: { exitCode: number } }> => {
    const child = spawn(args.shell, ['-il'], {
        cwd: args.cwd,
        env: args.env,
        stdio: 'pipe'
    })
    const session = pipeSession(child)
    ptySessions.set(ctx.refId, session)
    ctx.onCancel(() => {
        try {
            session.kill('SIGTERM')
        } catch {}
        releasePtySession(ctx.refId)
    })
    child.stdout.on('data', (chunk: Buffer) => {
        ctx.sendEvent('pty.out', chunk.toString('base64'))
    })
    child.stderr.on('data', (chunk: Buffer) => {
        ctx.sendEvent('pty.out', chunk.toString('base64'))
    })
    const exitCode: number = await new Promise((resolveCode) => {
        child.on('error', (err) => {
            ctx.sendEvent(
                'pty.out',
                encodePtyOut(`[spawn error] ${err.message}\r\n`)
            )
            resolveCode(-1)
        })
        child.on('close', (code) => resolveCode(code ?? 0))
    })
    releasePtySession(ctx.refId)
    return { ok: true, payload: { exitCode } }
}

const pipeSession = (
    child: ChildProcessWithoutNullStreams
): TerminalSession => ({
    write: (data): void => {
        child.stdin.write(data)
    },
    resize: (): void => {},
    kill: (signal): void => {
        child.kill(signal as NodeJS.Signals | undefined)
    }
})

export const rpcHandler: RpcHandler = async (method, payload, ctx) => {
    const handler = handlers[method]
    if (!handler) return { ok: false, error: `not_implemented: ${method}` }
    return handler(payload, ctx)
}
