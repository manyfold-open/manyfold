import { spawn } from 'node:child_process'
import type {
    ChildProcess,
    ChildProcessWithoutNullStreams
} from 'node:child_process'
import {
    createReadStream,
    constants as fsConstants,
    mkdirSync,
    readFileSync,
    realpathSync,
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
import {
    claudeCodeModelAliases,
    claudeLocalModelCatalog,
    codexIntelligenceLevels,
    codexModels,
    codexSpeeds,
    geminiAutoModelKey,
    geminiLocalModelCatalog,
    type ClaudeCredentialFacts,
    type CodexCredentialFacts,
    type CodexCustomProviderFact,
    type DaemonFrameworkModelCapability,
    type DaemonModelInspectResponse,
    type DaemonRpcMethod,
    type DaemonTurnStartPayload,
    type GeminiCredentialFacts
} from '@manyfold/shared'
import { permissionResponders, runAcpTurn } from './acp-turn'
import { runOpenclawTurn } from './openclaw-turn'
import type { RpcContext, RpcHandler } from './ws-client'
import { encodePtyChunk, resolvePtyBackend } from './pty-backend'
import { machineWorkspacesRoot } from '@manyfold/shared'
import { resolveConfigDir } from '@/config'
import { daemonPaths } from './config'
import {
    ExecStream,
    execStreams,
    readEventsFrom,
    readFinal,
    readMeta
} from './exec-buffer'
import { normalizeWireChannel } from '@/channel'
import { performSelfUpdate } from '@/commands/update'
import { detectStartupMethod } from './startup-method'
import {
    UPDATE_PENDING_ERROR,
    UpdateDrainCoordinator,
    type DaemonUpdateSpec,
    type IdleUpdateOutcome
} from './update-drain'
import { MF_CLI_VERSION } from '@/version'

interface TerminalSession {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
}

const ptySessions = new Map<string, TerminalSession>()

const expandHome = (p: string): string =>
    p.startsWith('~') ? p.replace(/^~/, homedir()) : p

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
    join(homedir(), '.openclaw'),
    join(homedir(), '.hermes'),
    join(homedir(), '.narranexus')
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
        const child = spawn(cmd, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
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

const readTextIfPresent = async (
    path: string
): Promise<{ ok: boolean; text: string | null; error: string | null }> => {
    try {
        return { ok: true, text: await readFile(path, 'utf8'), error: null }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { ok: false, text: null, error: null }
        return { ok: false, text: null, error: (err as Error).message }
    }
}

const readablePath = async (path: string): Promise<boolean> => {
    try {
        await access(path, fsConstants.R_OK)
        return true
    } catch {
        return false
    }
}

const tomlString = (text: string, key: string): string | null => {
    const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm')
    return pattern.exec(text)?.[1]?.trim() || null
}

const codexHomeDir = (): string => {
    const raw = process.env.CODEX_HOME?.trim()
    return raw ? resolve(expandHome(raw)) : join(homedir(), '.codex')
}

const parseJsonRecord = (text: string | null): Record<string, unknown> | null => {
    if (!text?.trim()) return null
    try {
        const parsed = JSON.parse(text) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

const nestedRecord = (
    record: Record<string, unknown> | null,
    key: string
): Record<string, unknown> | null => {
    const value = record?.[key]
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

const nonEmptyString = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().length > 0

// Reads the `exp` claim without verifying the signature: the daemon only needs
// to know when the CLI will consider the token stale, not to trust it.
const jwtExpiryMs = (value: unknown): number | null => {
    if (typeof value !== 'string') return null
    const payload = value.split('.')[1]
    if (!payload) return null
    try {
        const json = Buffer.from(
            payload.replace(/-/g, '+').replace(/_/g, '/'),
            'base64'
        ).toString('utf8')
        const exp = (JSON.parse(json) as Record<string, unknown>).exp
        return typeof exp === 'number' && Number.isFinite(exp)
            ? Math.round(exp * 1000)
            : null
    } catch {
        return null
    }
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
    configPresent: boolean
): Promise<ClaudeCredentialFacts> => {
    const credentials = parseJsonRecord(
        (await readTextIfPresent(join(homedir(), '.claude', '.credentials.json')))
            .text
    )
    // Older installs wrote the same block under `oauthAccount`. This is a
    // different file from the ~/.claude.json read below, which happens to use
    // that name for the profile record.
    const oauth =
        nestedRecord(credentials, 'claudeAiOauth') ??
        nestedRecord(credentials, 'oauthAccount')
    const claudeJson = parseJsonRecord(
        (await readTextIfPresent(join(homedir(), '.claude.json'))).text
    )
    return {
        framework: 'claude-code',
        envToken: Boolean(
            process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
            process.env.ANTHROPIC_API_KEY?.trim()
        ),
        credentialsFileParsed: credentials !== null,
        oauthExpiresAt:
            typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null,
        hasRefreshToken: nonEmptyString(oauth?.refreshToken),
        oauthAccount: nestedRecord(claudeJson, 'oauthAccount') !== null,
        configPresent
    }
}

const inspectClaudeModels =
    async (): Promise<DaemonFrameworkModelCapability> => {
        const now = new Date().toISOString()
        const cliVersion = await commandVersion('claude')
        const configReadable =
            (await readablePath(join(homedir(), '.claude'))) ||
            (await readablePath(join(homedir(), '.claude.json')))
        const credentialReady = Boolean(
            process.env.ANTHROPIC_AUTH_TOKEN ||
            process.env.ANTHROPIC_API_KEY ||
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
            credentialFacts: await claudeCredentialFacts(configReadable),
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
    async (): Promise<DaemonFrameworkModelCapability> => {
        const now = new Date().toISOString()
        const cliVersion = await commandVersion('codex')
        const codexHome = codexHomeDir()
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
        const envCredentialReady = Boolean(
            process.env.OPENAI_API_KEY && !requiresOpenAiAuth
        )
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
    async (): Promise<DaemonFrameworkModelCapability> => {
        const now = new Date().toISOString()
        const cliVersion = await commandVersion('gemini')
        const geminiHome = join(homedir(), '.gemini')
        const settings = await readTextIfPresent(
            join(geminiHome, 'settings.json')
        )
        const oauth = await readTextIfPresent(
            join(geminiHome, 'oauth_creds.json')
        )
        const settingsModel = geminiSettingsModel(settings.text)
        const settingsApiKey = geminiSettingsApiKey(settings.text)
        const envApiKey =
            process.env.GEMINI_API_KEY?.trim() ||
            process.env.GOOGLE_API_KEY?.trim() ||
            process.env.GOOGLE_GEMINI_API_KEY?.trim() ||
            ''
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
    payload: Record<string, unknown>
): Promise<DaemonModelInspectResponse> => {
    const requested =
        typeof payload.framework === 'string' ? payload.framework : null
    const all = await Promise.all([
        inspectClaudeModels(),
        inspectCodexModels(),
        inspectGeminiModels()
    ])
    return {
        frameworks: requested
            ? all.filter((item) => item.framework === requested)
            : all
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
}

const execChildren = new Map<string, ExecChildEntry>()
// turn.start turns without a child process (openclaw holds an SSE socket, not
// a spawn). Counted so daemon.update drains around them like any session.
const turnSessions = new Set<string>()

const updateCoordinator = new UpdateDrainCoordinator({
    activeSessions: () =>
        execChildren.size + ptySessions.size + turnSessions.size,
    applyUpdate: (spec) => performSelfUpdate(spec),
    // Exit non-zero so launchd (KeepAlive SuccessfulExit=false) / systemd
    // (Restart=on-failure) respawn the freshly-installed binary. Delay the
    // exit so any pending ack frame flushes to the API before the socket
    // closes.
    restart: () => setTimeout(() => process.exit(1), 2000),
    log: (msg) => console.error(msg)
})

const releaseExecChild = (refId: string): void => {
    if (execChildren.delete(refId)) updateCoordinator.onSessionEnd()
}

const releasePtySession = (refId: string): void => {
    if (ptySessions.delete(refId)) updateCoordinator.onSessionEnd()
}

export const daemonActivitySnapshot = (): {
    activeExecs: number
    activePtys: number
    updatePending: boolean
} => ({
    activeExecs: execChildren.size,
    activePtys: ptySessions.size,
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
    const cwd = payload.dir
        ? ensureUnderAllowedRoot(payload.dir)
        : process.cwd()
    // env stays out of meta.json: it can carry credentials (connection tokens
    // and MF_API_TOKEN since #781), and nothing ever reads it back out of the
    // buffer — a resume re-attaches to the live child. Same rationale as the
    // turn.start meta in acp-turn.
    const { env: _env, ...metaPayload } = payload
    const stream = new ExecStream({
        refId: ctx.refId,
        method: 'exec.start',
        payload: metaPayload as unknown as Record<string, unknown>
    })
    execStreams.set(ctx.refId, stream)
    const child = spawn(cmd[0], cmd.slice(1), {
        cwd,
        env: { ...process.env, ...(payload.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe']
    })
    const entry: ExecChildEntry = { child, stream, cancelled: false }
    execChildren.set(ctx.refId, entry)
    if (child.stdin) {
        child.stdin.on('error', () => {})
        if (typeof payload.stdin === 'string' && payload.stdin.length > 0)
            child.stdin.write(payload.stdin)
        if (!payload.keepStdinOpen) child.stdin.end()
    }
    ctx.onCancel(() => {
        entry.cancelled = true
        try {
            child.kill('SIGTERM')
        } catch {}
    })
    const safePublish = (kind: 'stdout' | 'stderr', chunk: string): void => {
        try {
            stream.publish(kind, chunk)
        } catch (err) {
            try {
                child.kill('SIGKILL')
            } catch {}
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
              try {
                  child.kill('SIGTERM')
              } catch {}
          }, payload.timeoutMs)
        : null

    return new Promise((resolveAck) => {
        const settle = (final: {
            ok: boolean
            error?: string
            payload?: Record<string, unknown>
        }): void => {
            releaseExecChild(ctx.refId)
            resolveAck({
                ok: final.ok,
                payload: final.payload,
                error: final.error
            })
        }

        subscribeCtxToStream(stream, ctx, 0, settle)

        child.on('error', (err) => {
            stream.publish('stderr', `[spawn error] ${err.message}\n`)
            stream.complete(
                { ok: false, payload: { exitCode: -1 }, error: err.message },
                'completed'
            )
        })
        child.on('close', (code) => {
            if (timer) clearTimeout(timer)
            const exitCode = code ?? 0
            if (entry.cancelled)
                stream.complete(
                    {
                        ok: false,
                        payload: { exitCode },
                        error: 'cancelled'
                    },
                    'aborted'
                )
            else
                stream.complete(
                    { ok: true, payload: { exitCode } },
                    'completed'
                )
        })
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
    const entry = execChildren.get(refId)
    if (!entry) {
        const meta = readMeta(refId)
        if (!meta) return { ok: false, error: `no buffer for refId ${refId}` }
        return { ok: true }
    }
    if (entry.cancelled) return { ok: true }
    entry.cancelled = true
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
    'model.inspect': async (payload) => ({
        ok: true,
        payload: inspectResultToRecord(await inspectModelCapability(payload))
    }),
    'daemon.update': async (payload) => {
        if (detectStartupMethod() === 'manual')
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
        if (updateCoordinator.blocksNewSessions())
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
    'fs.write': async (payload) => {
        const abs = ensureUnderAllowedRoot(String(payload.path ?? ''))
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
        if (updateCoordinator.blocksNewSessions())
            return { ok: false, error: UPDATE_PENDING_ERROR }
        const cwd = payload.cwd
            ? ensureUnderAllowedRoot(String(payload.cwd))
            : homedir()
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env))
            if (typeof v === 'string') env[k] = v
        for (const [k, v] of Object.entries(
            (payload.env ?? {}) as Record<string, string>
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
        if (!backend) return openPipeTerminal({ shell, cwd, env }, ctx)

        const term = backend.spawn({
            shell,
            args: ['-il'],
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
        ptySessions.set(ctx.refId, term)
        ctx.onCancel(() => {
            try {
                term.kill('SIGTERM')
            } catch {}
            releasePtySession(ctx.refId)
        })
        const exitCode = await term.exited
        releasePtySession(ctx.refId)
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
        const session = ptySessions.get(String(payload.refId ?? ''))
        if (!session) return { ok: true }
        try {
            session.kill('SIGTERM')
        } catch {}
        releasePtySession(String(payload.refId ?? ''))
        return { ok: true }
    }
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
