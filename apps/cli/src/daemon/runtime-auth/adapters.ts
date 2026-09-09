import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises'
import {
    runtimeAuthProfileEnv,
    type ConfigurableFramework,
    type RuntimeAuthMethod,
    type RuntimeAuthRevokeResult
} from '@manyfold/shared'
import { codexHomeDir } from '../inspect-fs'

// Per-framework projection of the "auth independent, config projected, state
// shared" contract, exactly as measured on 2026-09-09 (see the runtime auth
// profiles feature doc, P0). A view is the CLI's config dir (claude/codex) or
// HOME (gemini) for one profile: credential files are real files inside it,
// session/history/plugin/skill directories are symlinks back to the native
// dirs so transcripts and rollouts keep one authoritative store, and
// config files are symlinks so a native write goes through to the user's
// real config. Entries a CLI writes by rename (gemini projects.json) must
// stay per-view, or the rename would replace the link with a private copy.

export interface LogoutOutcome {
    signedOut: boolean
    revoke: RuntimeAuthRevokeResult
    error: string | null
}

export interface RuntimeAuthAdapter {
    readonly framework: ConfigurableFramework
    buildView(viewDir: string): Promise<void>
    env(viewDir: string, authMethod: RuntimeAuthMethod): Record<string, string>
    // The vendor sign-in as the login shell's argv (pty.open `command`).
    loginArgv(): string[]
    // Files whose presence means "a credential is stored in this view".
    credentialPaths(viewDir: string): string[]
    logout(viewDir: string, env: NodeJS.ProcessEnv): Promise<LogoutOutcome>
}

const SPAWN_TIMEOUT_MS = 20_000

const runCli = (
    argv: string[],
    env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), {
            env,
            stdio: ['ignore', 'ignore', 'pipe'],
            cwd: homedir()
        })
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < 4096) stderr += chunk.toString('utf8')
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS)
        child.on('error', (err) => {
            clearTimeout(timer)
            resolve({ code: null, stderr: err.message })
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolve({ code, stderr })
        })
    })

const exists = async (path: string): Promise<boolean> => {
    try {
        await lstat(path)
        return true
    } catch {
        return false
    }
}

// Symlink `<view>/<rel>` → `<native>/<rel>`. Directories are created on the
// native side first so the link is never dangling for a dir the CLI expects
// to list; files may dangle — a CLI creating through a dangling link creates
// the native file, which is the write-through we want.
const link = async (
    viewDir: string,
    nativeDir: string,
    rel: string,
    kind: 'dir' | 'file'
): Promise<void> => {
    const target = join(nativeDir, rel)
    const dst = join(viewDir, rel)
    if (kind === 'dir') await mkdir(target, { recursive: true })
    await mkdir(join(dst, '..'), { recursive: true, mode: 0o700 })
    if (await exists(dst)) return
    await symlink(target, dst)
}

const removeIfPresent = async (path: string): Promise<boolean> => {
    if (!(await exists(path))) return false
    await rm(path, { force: true })
    return true
}

const claudeAdapter: RuntimeAuthAdapter = {
    framework: 'claude-code',
    async buildView(viewDir) {
        const native = join(homedir(), '.claude')
        await mkdir(viewDir, { recursive: true, mode: 0o700 })
        await chmod(viewDir, 0o700).catch(() => {})
        for (const dir of [
            'projects',
            'sessions',
            'plugins',
            'skills',
            'commands',
            'file-history',
            'shell-snapshots',
            'todos',
            'statsig',
            'backups',
            'debug',
            'ide',
            'paste-cache',
            'plans',
            'tasks',
            'scheduled-tasks',
            'jobs',
            'session-env',
            'workspaces',
            'cache',
            'config'
        ])
            await link(viewDir, native, dir, 'dir')
        for (const file of ['settings.json', 'history.jsonl', 'CLAUDE.md'])
            await link(viewDir, native, file, 'file')
        // ~/.claude.json is a mixed file: the login record (oauthAccount) is
        // per profile, everything else is the user's. Seed the view copy from
        // the native file minus the identity so the sign-in lands here.
        const projection = join(viewDir, '.claude.json')
        if (!(await exists(projection))) {
            let base: Record<string, unknown> = {}
            try {
                const parsed: unknown = JSON.parse(
                    await readFile(join(homedir(), '.claude.json'), 'utf8')
                )
                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    !Array.isArray(parsed)
                )
                    base = parsed as Record<string, unknown>
            } catch {}
            const { oauthAccount: _drop, ...rest } = base
            await writeFile(projection, `${JSON.stringify(rest, null, 2)}\n`, {
                mode: 0o600
            })
        }
    },
    env(viewDir) {
        return runtimeAuthProfileEnv('claude-code', viewDir)
    },
    loginArgv() {
        // `cat |` keeps the paste prompt echoing (the CLI's readline echoes
        // nothing on a bare pty); same wrapper as the web sign-in terminal.
        return ['sh', '-c', 'cat | claude auth login --claudeai']
    },
    credentialPaths(viewDir) {
        return [join(viewDir, '.credentials.json')]
    },
    async logout(viewDir, env) {
        const result = await runCli(['claude', 'auth', 'logout'], env)
        const fileRemoved = await removeIfPresent(
            join(viewDir, '.credentials.json')
        )
        return {
            signedOut: result.code === 0 || fileRemoved,
            revoke: 'unknown',
            error:
                result.code === 0
                    ? null
                    : result.stderr.trim().slice(0, 300) ||
                      `claude auth logout exited ${result.code}`
        }
    }
}

const codexAdapter: RuntimeAuthAdapter = {
    framework: 'codex',
    async buildView(viewDir) {
        const native = codexHomeDir()
        await mkdir(viewDir, { recursive: true, mode: 0o700 })
        await chmod(viewDir, 0o700).catch(() => {})
        // thread-writer-locks / mcp-oauth-locks are shared on purpose: a
        // private copy would let two profiles write one session.
        for (const dir of [
            'sessions',
            'archived_sessions',
            'thread-writer-locks',
            'mcp-oauth-locks',
            'skills',
            'plugins',
            'rules',
            'plans',
            'shell_snapshots',
            'worktrees',
            'log'
        ])
            await link(viewDir, native, dir, 'dir')
        for (const file of [
            'config.toml',
            'AGENTS.md',
            'hooks.json',
            'history.jsonl',
            'session_index.jsonl',
            'installation_id',
            'version.json'
        ])
            await link(viewDir, native, file, 'file')
    },
    env(viewDir) {
        // Measured on codex 0.153.4 [2026-09-09]: CODEX_SQLITE_HOME is read as
        // the default for `sqlite_home`, so the six state databases stay in
        // the native home without touching argv or config.
        return {
            ...runtimeAuthProfileEnv('codex', viewDir),
            CODEX_SQLITE_HOME: codexHomeDir()
        }
    },
    loginArgv() {
        return ['codex', 'login', '--device-auth']
    },
    credentialPaths(viewDir) {
        return [join(viewDir, 'auth.json')]
    },
    async logout(viewDir, env) {
        const result = await runCli(['codex', 'logout'], env)
        const fileRemoved = await removeIfPresent(join(viewDir, 'auth.json'))
        return {
            signedOut: result.code === 0 || fileRemoved,
            revoke: 'unknown',
            error:
                result.code === 0
                    ? null
                    : result.stderr.trim().slice(0, 300) ||
                      `codex logout exited ${result.code}`
        }
    }
}

const geminiAdapter: RuntimeAuthAdapter = {
    framework: 'gemini-cli',
    async buildView(viewDir) {
        const native = join(homedir(), '.gemini')
        const geminiDir = join(viewDir, '.gemini')
        await mkdir(geminiDir, { recursive: true, mode: 0o700 })
        await chmod(viewDir, 0o700).catch(() => {})
        for (const dir of ['history', 'tmp', 'skills', 'config'])
            await link(geminiDir, native, dir, 'dir')
        // projects.json is rewritten by rename → per view. `.env` is an
        // ambient key source and deliberately not linked.
        for (const file of [
            'settings.json',
            'state.json',
            'GEMINI.md',
            'installation_id'
        ])
            await link(geminiDir, native, file, 'file')
    },
    env(viewDir, authMethod) {
        return {
            ...runtimeAuthProfileEnv('gemini-cli', viewDir, authMethod),
            GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(
                homedir(),
                '.gemini',
                'trustedFolders.json'
            ),
            NO_BROWSER: 'true'
        }
    },
    loginArgv() {
        // No auth subcommand: the TUI's /auth picker runs the Google flow.
        return ['gemini']
    },
    credentialPaths(viewDir) {
        return [
            join(viewDir, '.gemini', 'oauth_creds.json'),
            join(viewDir, '.gemini', 'gemini-credentials.json')
        ]
    },
    async logout(viewDir) {
        let removed = false
        for (const file of [
            'oauth_creds.json',
            'gemini-credentials.json',
            'google_accounts.json'
        ])
            removed =
                (await removeIfPresent(join(viewDir, '.gemini', file))) ||
                removed
        return { signedOut: true, revoke: 'local-only', error: null }
    }
}

export const runtimeAuthAdapter = (
    framework: ConfigurableFramework
): RuntimeAuthAdapter =>
    framework === 'claude-code'
        ? claudeAdapter
        : framework === 'codex'
          ? codexAdapter
          : geminiAdapter
