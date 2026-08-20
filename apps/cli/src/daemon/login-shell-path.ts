import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename } from 'node:path'

// Daemon processes (launchd / systemd) do NOT inherit the user's interactive
// PATH. `claude --version` working in a terminal is no guarantee that the bare
// daemon can find `claude`: nvm/fnm/volta prefix dirs and the Anthropic native
// installer (~/.claude/local) live on paths only ~/.zshrc / ~/.bashrc add. This
// asks the user's login+interactive shell to resolve agent binaries the daemon's
// own PATH missed. Mirrors multica's resolveAgentsViaLoginShell.

// Only POSIX-compatible shells: the resolver script below is plain sh. fish uses
// different syntax for command substitution, so we skip it (those users' CLIs
// are usually on the standard PATH anyway).
const SUPPORTED_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh'])
const RESOLVE_TIMEOUT_MS = 3000

// $SHELL is the source of truth, but launchd often leaves it unset; fall back to
// the passwd shell (os.userInfo). Returns null when there is no usable POSIX
// shell, so the caller skips the resolution entirely.
export const pickLoginShell = (): string | null => {
    const sh = (process.env.SHELL || userInfo().shell || '').trim()
    if (!sh) return null
    return SUPPORTED_SHELLS.has(basename(sh)) ? sh : null
}

// Pure parser for the resolver script's `name<TAB>/abs/path` lines. Drops stray
// rc-file stdout (no tab, unknown name, non-absolute path) and keeps the first
// hit per name. Exported for testing.
export const parseResolverOutput = (
    output: string,
    allowed: readonly string[]
): Record<string, string> => {
    const set = new Set(allowed)
    const result: Record<string, string> = {}
    for (const line of output.split('\n')) {
        const tab = line.indexOf('\t')
        if (tab <= 0) continue
        const name = line.slice(0, tab)
        const path = line.slice(tab + 1)
        if (!set.has(name) || !path.startsWith('/')) continue
        if (!(name in result)) result[name] = path
    }
    return result
}

const buildScript = (names: readonly string[]): string =>
    'for c in ' +
    names.join(' ') +
    '; do ' +
    'p=$(command -v "$c" 2>/dev/null) || continue; ' +
    // keep only absolute paths — aliases/functions print their definition, not a
    // path, and `command -v` on a builtin prints the bare name
    'case "$p" in /*) ;; *) continue ;; esac; ' +
    // canonicalise the dir while the shell is alive: fnm/nvm "multishell" dirs
    // vanish on shell exit, so capture the real path now
    'd=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || continue; ' +
    "printf '%s\\t%s/%s\\n' \"$c\" \"$d\" \"$(basename \"$p\")\"; " +
    'done'

const runLoginShell = (shell: string, script: string): Promise<string> =>
    new Promise((resolve) => {
        // -i (interactive) + -l (login) so we pick up PATH from BOTH ~/.zshrc /
        // ~/.bashrc and ~/.zprofile / ~/.bash_profile — real users use both.
        const child = spawn(shell, ['-ilc', script], {
            stdio: ['ignore', 'pipe', 'ignore']
        })
        const chunks: Buffer[] = []
        let settled = false
        const finish = (val: string): void => {
            if (settled) return
            settled = true
            try {
                child.kill('SIGKILL')
            } catch {}
            resolve(val)
        }
        const timer = setTimeout(() => finish(''), RESOLVE_TIMEOUT_MS)
        child.stdout.on('data', (b: Buffer) => chunks.push(b))
        child.on('close', () => {
            clearTimeout(timer)
            finish(Buffer.concat(chunks).toString('utf8'))
        })
        child.on('error', () => {
            clearTimeout(timer)
            finish('')
        })
    })

let cache: Record<string, string> | null = null

// Resolve the given bare command names to canonical absolute paths via the
// user's login shell. Cached for the process lifetime (one shell spawn at most),
// matching multica — a daemon restart picks up CLIs installed afterwards. Names
// are restricted to a safe charset since they are inlined into the shell script.
export const resolveBinariesViaLoginShell = async (
    names: readonly string[]
): Promise<Record<string, string>> => {
    if (cache) return cache
    cache = await (async () => {
        const shell = pickLoginShell()
        const safe = names.filter((n) => /^[A-Za-z0-9._-]+$/.test(n))
        if (!shell || safe.length === 0) return {}
        let output: string
        try {
            output = await runLoginShell(shell, buildScript(safe))
        } catch {
            return {}
        }
        const parsed = parseResolverOutput(output, safe)
        // Only trust paths that still exist from the daemon's vantage point.
        const verified: Record<string, string> = {}
        for (const [name, path] of Object.entries(parsed)) {
            try {
                await access(path)
                verified[name] = path
            } catch {}
        }
        return verified
    })()
    return cache
}
