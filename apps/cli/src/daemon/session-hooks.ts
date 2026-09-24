import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile
} from 'node:fs/promises'
import type {
    DetectedFramework,
    TerminalHookFramework,
    TerminalHookSource,
    TerminalSessionHookRequest,
    TerminalSessionHookResponse
} from '@manyfold/shared'
import {
    apiPaths,
    RUNNER_PROFILE,
    TERMINAL_HOOK_FRAMEWORKS,
    TERMINAL_HOOK_SOURCES
} from '@manyfold/shared'
import { resolveProfile } from '@/config'
import {
    loadDaemonConfig,
    saveDaemonConfig,
    type DaemonConfig
} from '@/daemon/config'
import { isBunStandalone } from '@/standalone'
import { createCliFetch } from '@/transport'

// The CLI session hooks (ADR-0029 §3): a script each coding CLI runs on
// SessionStart / SessionEnd that tells Manyfold which framework session a
// Manyfold-opened terminal is on. One channel, the API, and one switch,
// MF_TERMINAL_ID — the user's own shells never carry it, so the hook exits
// before doing anything there. Everything written here is marked with the
// version below; a reinstall overwrites only what carries the marker and an
// uninstall removes only that.
export const MF_SESSION_HOOK_VERSION = 1

const SCRIPT_NAME = 'mf-session.sh'
const PI_EXTENSION_NAME = 'mf-session.ts'
const SCRIPT_VERSION_LINE = /^(?:#|\/\/) mf-session-hook version=(\d+)/m
export const SESSION_HOOK_EVENTS = ['SessionStart', 'SessionEnd'] as const

export type SessionHooksConsent = 'enabled' | 'disabled'

export interface SessionHookTarget {
    framework: TerminalHookFramework
    // `settings`: a script the CLI's settings file names per event (claude,
    // codex). `extension`: a file the CLI loads on its own from a directory
    // (pi's agent-dir extensions), so there is no settings file to merge and
    // `settingsPath` is the file itself.
    kind: 'settings' | 'extension'
    scriptPath: string
    settingsPath: string
    // Seconds the CLI gives the hook. Codex caps SessionEnd at three, and
    // the script backgrounds the report anyway.
    timeoutSeconds: number
    configTomlPath?: string
}

// pi loads every file in <agent-dir>/extensions, and the agent dir is the one
// PI_CODING_AGENT_DIR names when set.
const piExtensionsDir = (home: string): string => {
    const raw = process.env.PI_CODING_AGENT_DIR?.trim()
    const agentDir =
        raw && home === homedir()
            ? raw === '~'
                ? home
                : raw.startsWith('~/')
                  ? join(home, raw.slice(2))
                  : raw
            : join(home, '.pi', 'agent')
    return join(agentDir, 'extensions')
}

export const sessionHookTargets = (
    home: string = homedir()
): SessionHookTarget[] => [
    {
        framework: 'claude-code',
        kind: 'settings',
        scriptPath: join(home, '.claude', 'hooks', SCRIPT_NAME),
        settingsPath: join(home, '.claude', 'settings.json'),
        timeoutSeconds: 5
    },
    {
        framework: 'codex',
        kind: 'settings',
        scriptPath: join(home, '.codex', 'hooks', SCRIPT_NAME),
        settingsPath: join(home, '.codex', 'hooks.json'),
        timeoutSeconds: 3,
        configTomlPath: join(home, '.codex', 'config.toml')
    },
    {
        framework: 'pi',
        kind: 'extension',
        scriptPath: join(piExtensionsDir(home), PI_EXTENSION_NAME),
        settingsPath: join(piExtensionsDir(home), PI_EXTENSION_NAME),
        timeoutSeconds: 0
    }
]

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// How the hook script calls back into this very CLI: the standalone binary
// by its own path (auto-update replaces it in place, so the path stays
// good), a source checkout through the interpreter that is running it.
export const resolveMfInvocation = (probe?: {
    standalone?: boolean
    execPath?: string
    entry?: string | undefined
}): string[] => {
    const standalone = probe?.standalone ?? isBunStandalone()
    const execPath = probe?.execPath ?? process.execPath
    if (standalone) return [execPath]
    const entry = probe && 'entry' in probe ? probe.entry : process.argv[1]
    if (!entry) return ['mf']
    return entry.endsWith('.ts')
        ? [execPath, '--import', 'tsx', entry]
        : [execPath, entry]
}

export const buildSessionHookScript = (invocation: string[]): string =>
    [
        '#!/bin/sh',
        `# mf-session-hook version=${MF_SESSION_HOOK_VERSION}`,
        '# Installed by `mf daemon hooks install`; `mf daemon hooks uninstall` removes it.',
        '# Reports the CLI session running in this terminal to Manyfold. It acts only',
        '# inside a terminal Manyfold opened (MF_TERMINAL_ID is set) and never prints,',
        '# so your own shells and the model context are untouched.',
        '[ -n "${MF_TERMINAL_ID:-}" ] || exit 0',
        'payload=$(cat 2>/dev/null) || exit 0',
        '[ -n "$payload" ] || exit 0',
        // Backgrounded inside a subshell so neither CLI waits on the report:
        // SessionEnd gives hooks about a second.
        `( printf '%s' "$payload" | ${invocation.map(shellQuote).join(' ')} daemon hooks report "$1" >/dev/null 2>&1 & ) >/dev/null 2>&1`,
        'exit 0',
        ''
    ].join('\n')

// pi's version of the hook: an extension pi loads from its agent dir in every
// mode, TUI included (headless chat turns pass --no-extensions, so only a
// terminal reports). It maps pi's session events onto the SessionStart /
// SessionEnd input the claude and codex hooks hand the same `report` command:
// pi resumes a session under its own id, so a resume reports the ref the
// terminal was opened on, and `/new`, `/fork` and `/resume` end one ref and
// start another. `reload` swaps the extension runtime inside one session and
// reports nothing. The session id comes from pi's session manager — the events
// themselves carry none.
export const buildPiSessionHookExtension = (invocation: string[]): string =>
    [
        `// mf-session-hook version=${MF_SESSION_HOOK_VERSION}`,
        '// Installed by `mf daemon hooks install`; `mf daemon hooks uninstall` removes it.',
        '// Reports the pi session running in this terminal to Manyfold. It acts only',
        '// inside a terminal Manyfold opened (MF_TERMINAL_ID is set), never prints and',
        '// never waits on the report, so your own pi sessions are untouched.',
        "import { spawn } from 'node:child_process'",
        '',
        `const MF_INVOCATION: string[] = ${JSON.stringify(invocation)}`,
        '',
        'const START_SOURCE: Record<string, string> = {',
        "    startup: 'startup',",
        "    resume: 'resume',",
        "    new: 'clear',",
        "    fork: 'fork'",
        '}',
        "const END_REASON: Record<string, string> = { new: 'clear', fork: 'fork' }",
        '',
        '// pi says startup for `--continue` and `--session <id>` too: a session that',
        '// already holds messages when it starts was resumed, not begun.',
        'const startSource = (reason: string, ctx: any): string | undefined => {',
        "    if (reason !== 'startup') return START_SOURCE[reason]",
        '    const entries = ctx?.sessionManager?.getEntries?.() ?? []',
        "    return entries.some((entry: any) => entry?.type === 'message')",
        "        ? 'resume'",
        "        : 'startup'",
        '}',
        '',
        'const report = (',
        "    hookEventName: 'SessionStart' | 'SessionEnd',",
        "    field: 'source' | 'reason',",
        '    value: string,',
        '    ctx: any',
        '): void => {',
        '    try {',
        '        const sessionId = ctx?.sessionManager?.getSessionId?.()',
        '        if (!sessionId) return',
        '        const child = spawn(',
        '            MF_INVOCATION[0],',
        "            [...MF_INVOCATION.slice(1), 'daemon', 'hooks', 'report', 'pi'],",
        "            { detached: true, stdio: ['pipe', 'ignore', 'ignore'] }",
        '        )',
        "        child.on('error', () => {})",
        "        child.stdin?.on('error', () => {})",
        '        child.stdin?.end(',
        '            JSON.stringify({',
        '                session_id: sessionId,',
        '                hook_event_name: hookEventName,',
        '                [field]: value,',
        '                cwd: ctx?.sessionManager?.getCwd?.() ?? ctx?.cwd',
        '            })',
        '        )',
        '        child.unref()',
        '    } catch {}',
        '}',
        '',
        'export default function (pi: any): void {',
        '    if (!process.env.MF_TERMINAL_ID) return',
        "    pi.on('session_start', (event: any, ctx: any) => {",
        '        const source = startSource(event?.reason, ctx)',
        "        if (source) report('SessionStart', 'source', source, ctx)",
        '    })',
        "    pi.on('session_shutdown', (event: any, ctx: any) => {",
        "        if (event?.reason === 'reload') return",
        "        report('SessionEnd', 'reason', END_REASON[event?.reason] ?? 'other', ctx)",
        '    })',
        '}',
        ''
    ].join('\n')

// The inverse of buildSessionHookScript's call line (or the pi extension's
// invocation constant), so `mf doctor` can tell when an installed hook calls
// back into a binary that is no longer there.
export const sessionHookInvocation = (script: string): string[] | null => {
    const embedded = /^const MF_INVOCATION: string\[\] = (\[.*\])$/m.exec(
        script
    )?.[1]
    if (embedded) {
        try {
            const parsed: unknown = JSON.parse(embedded)
            return Array.isArray(parsed) &&
                parsed.length > 0 &&
                parsed.every((part) => typeof part === 'string')
                ? parsed
                : null
        } catch {
            return null
        }
    }
    const line = /\| (.+?) daemon hooks report "\$1"/.exec(script)?.[1]
    if (!line) return null
    const args: string[] = []
    let i = 0
    while (i < line.length) {
        if (line[i] === ' ') {
            i += 1
            continue
        }
        if (line[i] !== "'") return null
        let arg = ''
        for (;;) {
            const end = line.indexOf("'", i + 1)
            if (end < 0) return null
            arg += line.slice(i + 1, end)
            i = end + 1
            if (!line.startsWith("\\''", i)) break
            arg += "'"
            i += 2
        }
        args.push(arg)
    }
    return args.length > 0 ? args : null
}

export const scriptVersion = (text: string): number | null => {
    const match = SCRIPT_VERSION_LINE.exec(text)
    return match ? Number(match[1]) : null
}

type HookGroup = { matcher?: unknown; hooks?: unknown }

const managedCommand = (target: SessionHookTarget): string =>
    `${shellQuote(target.scriptPath)} ${target.framework}`

// Ours are the groups whose every handler runs the managed script; a user's
// own hooks, even in the same event, are never touched.
const isManagedGroup = (group: unknown, scriptPath: string): boolean => {
    if (!group || typeof group !== 'object') return false
    const hooks = (group as HookGroup).hooks
    if (!Array.isArray(hooks) || hooks.length === 0) return false
    return hooks.every(
        (hook) =>
            hook &&
            typeof hook === 'object' &&
            typeof (hook as { command?: unknown }).command === 'string' &&
            (hook as { command: string }).command.includes(scriptPath)
    )
}

const managedGroup = (target: SessionHookTarget): HookGroup => ({
    hooks: [
        {
            type: 'command',
            command: managedCommand(target),
            timeout: target.timeoutSeconds
        }
    ]
})

export interface SessionHookSettingsMerge {
    next: string | null
    changed: boolean
    error?: string
}

// Both CLIs read the same shape: `{ hooks: { <Event>: [ { matcher?, hooks:
// [...] } ] } }` — claude in ~/.claude/settings.json (where the rest of the
// user's settings live), codex in ~/.codex/hooks.json. The merge keeps
// everything else in the file and replaces only the managed groups; an
// unparseable file is left alone and reported, never clobbered.
export const mergeSessionHookSettings = (
    text: string | null,
    target: SessionHookTarget,
    mode: 'install' | 'uninstall'
): SessionHookSettingsMerge => {
    let root: Record<string, unknown> = {}
    if (text && text.trim()) {
        try {
            const parsed: unknown = JSON.parse(text)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return {
                    next: null,
                    changed: false,
                    error: 'not a JSON object'
                }
            root = parsed as Record<string, unknown>
        } catch {
            return { next: null, changed: false, error: 'not valid JSON' }
        }
    }
    const before = JSON.stringify(root)
    const hooksIn = root.hooks
    const hooks: Record<string, unknown> =
        hooksIn && typeof hooksIn === 'object' && !Array.isArray(hooksIn)
            ? { ...(hooksIn as Record<string, unknown>) }
            : {}
    for (const event of SESSION_HOOK_EVENTS) {
        const groups = Array.isArray(hooks[event])
            ? (hooks[event] as unknown[])
            : []
        const kept = groups.filter(
            (group) => !isManagedGroup(group, target.scriptPath)
        )
        if (mode === 'install') kept.push(managedGroup(target))
        if (kept.length > 0) hooks[event] = kept
        else delete hooks[event]
    }
    if (Object.keys(hooks).length > 0) root.hooks = hooks
    else delete root.hooks
    const changed = JSON.stringify(root) !== before
    return { next: `${JSON.stringify(root, null, 2)}\n`, changed }
}

export const settingsHaveSessionHooks = (
    text: string | null,
    target: SessionHookTarget
): boolean => {
    if (!text) return false
    try {
        const parsed: unknown = JSON.parse(text)
        const hooks = (parsed as { hooks?: Record<string, unknown> } | null)
            ?.hooks
        if (!hooks || typeof hooks !== 'object') return false
        return SESSION_HOOK_EVENTS.every((event) => {
            const groups = hooks[event]
            return (
                Array.isArray(groups) &&
                groups.some((group) => isManagedGroup(group, target.scriptPath))
            )
        })
    } catch {
        return false
    }
}

// Codex ships hooks on; a user who turned them off in [features] keeps them
// off. `codex_hooks` is the older spelling of the same key.
export const codexHooksDisabledInConfig = (toml: string): boolean => {
    let inFeatures = false
    for (const line of toml.split('\n')) {
        const trimmed = line.trim()
        if (/^\[.*\]$/.test(trimmed)) {
            inFeatures = trimmed === '[features]'
            continue
        }
        if (inFeatures && /^(hooks|codex_hooks)\s*=\s*false\b/.test(trimmed))
            return true
    }
    return false
}

export interface SessionHookFrameworkStatus {
    framework: TerminalHookFramework
    scriptPath: string
    settingsPath: string
    scriptVersion: number | null
    settingsInstalled: boolean
    installed: boolean
    current: boolean
    // Something the user has to do or know: codex trusts a new hook only
    // after `/hooks` in its TUI; a `[features] hooks = false` keeps it off.
    note: string | null
}

export interface SessionHooksStatus {
    supported: boolean
    consent: SessionHooksConsent | null
    frameworks: SessionHookFrameworkStatus[]
}

const readText = async (path: string): Promise<string | null> => {
    try {
        return await readFile(path, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
    }
}

export const sessionHooksSupported = (
    platform: NodeJS.Platform = process.platform
): boolean => platform !== 'win32'

export const sessionHooksStatus = async (opts?: {
    home?: string
    consent?: SessionHooksConsent | null
}): Promise<SessionHooksStatus> => {
    const consent =
        opts?.consent !== undefined
            ? opts.consent
            : await readSessionHooksConsent()
    const frameworks: SessionHookFrameworkStatus[] = []
    for (const target of sessionHookTargets(opts?.home)) {
        const script = await readText(target.scriptPath)
        const version = script ? scriptVersion(script) : null
        const settingsInstalled =
            target.kind === 'extension'
                ? version !== null
                : settingsHaveSessionHooks(
                      await readText(target.settingsPath),
                      target
                  )
        const installed = version !== null && settingsInstalled
        let note: string | null = null
        if (installed && target.configTomlPath) {
            const toml = await readText(target.configTomlPath)
            if (toml && codexHooksDisabledInConfig(toml))
                note = 'hooks are turned off in [features] of config.toml'
            else
                note =
                    'codex runs a new hook only after you approve it once with /hooks in its TUI'
        }
        frameworks.push({
            framework: target.framework,
            scriptPath: target.scriptPath,
            settingsPath: target.settingsPath,
            scriptVersion: version,
            settingsInstalled,
            installed,
            current: installed && version === MF_SESSION_HOOK_VERSION,
            note
        })
    }
    return { supported: sessionHooksSupported(), consent, frameworks }
}

export interface SessionHookChange {
    framework: TerminalHookFramework
    action: 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent'
    error?: string
}

// Same-directory temp file and rename, keeping the file's own mode: these
// are the user's CLI settings, not daemon state, so no 0600/0700 tightening.
const writeInPlace = async (
    path: string,
    text: string,
    fallbackMode: number
): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    let mode = fallbackMode
    try {
        mode = (await stat(path)).mode & 0o777
    } catch {}
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, text, { mode })
    await chmod(tmp, mode).catch(() => {})
    await rename(tmp, path)
}

const frameworksToTouch = (
    detected: readonly DetectedFramework[] | 'all'
): Set<TerminalHookFramework> =>
    new Set(
        detected === 'all'
            ? TERMINAL_HOOK_FRAMEWORKS
            : detected
                  .map((f) => f.framework)
                  .filter((f): f is TerminalHookFramework =>
                      (TERMINAL_HOOK_FRAMEWORKS as readonly string[]).includes(
                          f
                      )
                  )
    )

export const installSessionHooks = async (opts: {
    detected: readonly DetectedFramework[] | 'all'
    home?: string
    invocation?: string[]
}): Promise<SessionHookChange[]> => {
    if (!sessionHooksSupported()) return []
    const wanted = frameworksToTouch(opts.detected)
    const invocation = opts.invocation ?? resolveMfInvocation()
    const script = buildSessionHookScript(invocation)
    const extension = buildPiSessionHookExtension(invocation)
    const changes: SessionHookChange[] = []
    for (const target of sessionHookTargets(opts.home)) {
        if (!wanted.has(target.framework)) continue
        const existingScript = await readText(target.scriptPath)
        if (target.kind === 'extension') {
            // A file of the same name that is not ours stays the user's.
            if (
                existingScript !== null &&
                scriptVersion(existingScript) === null
            ) {
                changes.push({
                    framework: target.framework,
                    action: 'unchanged',
                    error: `${target.scriptPath} exists and is not a Manyfold hook; move it aside and run mf daemon hooks install again`
                })
                continue
            }
            const changed = existingScript !== extension
            if (changed) await writeInPlace(target.scriptPath, extension, 0o644)
            changes.push({
                framework: target.framework,
                action: !changed
                    ? 'unchanged'
                    : existingScript === null
                      ? 'installed'
                      : 'updated'
            })
            continue
        }
        const existingSettings = await readText(target.settingsPath)
        const merge = mergeSessionHookSettings(
            existingSettings,
            target,
            'install'
        )
        if (merge.error || merge.next === null) {
            changes.push({
                framework: target.framework,
                action: 'unchanged',
                error: `${target.settingsPath}: ${merge.error ?? 'unreadable'}; fix the file and run mf daemon hooks install again`
            })
            continue
        }
        const scriptChanged = existingScript !== script
        if (scriptChanged) await writeInPlace(target.scriptPath, script, 0o755)
        if (merge.changed)
            await writeInPlace(target.settingsPath, merge.next, 0o644)
        changes.push({
            framework: target.framework,
            action:
                !scriptChanged && !merge.changed
                    ? 'unchanged'
                    : existingScript === null
                      ? 'installed'
                      : 'updated'
        })
    }
    return changes
}

export const uninstallSessionHooks = async (opts?: {
    home?: string
}): Promise<SessionHookChange[]> => {
    const changes: SessionHookChange[] = []
    for (const target of sessionHookTargets(opts?.home)) {
        const existingScript = await readText(target.scriptPath)
        if (target.kind === 'extension') {
            const ownExtension =
                existingScript !== null &&
                scriptVersion(existingScript) !== null
            if (ownExtension) await rm(target.scriptPath, { force: true })
            changes.push({
                framework: target.framework,
                action: ownExtension ? 'removed' : 'absent'
            })
            continue
        }
        const existingSettings = await readText(target.settingsPath)
        const merge = mergeSessionHookSettings(
            existingSettings,
            target,
            'uninstall'
        )
        if (merge.error) {
            changes.push({
                framework: target.framework,
                action: 'unchanged',
                error: `${target.settingsPath}: ${merge.error}; remove the mf-session groups by hand`
            })
            continue
        }
        if (merge.changed && merge.next !== null)
            await writeInPlace(target.settingsPath, merge.next, 0o644)
        // Only a script carrying the marker is ours to delete.
        const ownScript =
            existingScript !== null && scriptVersion(existingScript) !== null
        if (ownScript) await rm(target.scriptPath, { force: true })
        changes.push({
            framework: target.framework,
            action: ownScript || merge.changed ? 'removed' : 'absent'
        })
    }
    return changes
}

// The choice lives with the daemon registration, so `mf daemon start`
// keeps the hooks current on every start once the user said yes.
export const readSessionHooksConsent =
    async (): Promise<SessionHooksConsent | null> => {
        const config = await loadDaemonConfig().catch(() => null)
        return config?.sessionHooks ?? null
    }

export const writeSessionHooksConsent = async (
    value: SessionHooksConsent
): Promise<boolean> => {
    const config = await loadDaemonConfig()
    if (!config) return false
    await saveDaemonConfig({ ...config, sessionHooks: value })
    return true
}

// A sprite runner is the platform's own process on the platform's own VM:
// it installs the hooks without asking. A self-owned machine needs the
// user's explicit yes (register asks, or `mf daemon hooks install`).
export const sessionHooksWantedByDefault = (
    profile: string = resolveProfile()
): boolean => profile === RUNNER_PROFILE

export const reconcileSessionHooksOnStart = async (
    config: DaemonConfig,
    detected: readonly DetectedFramework[],
    log: (message: string) => Promise<void> | void
): Promise<void> => {
    if (!sessionHooksSupported()) return
    const consent =
        config.sessionHooks ??
        (sessionHooksWantedByDefault() ? 'enabled' : null)
    if (consent !== 'enabled') return
    try {
        const changes = await installSessionHooks({ detected })
        for (const change of changes) {
            if (change.error) await log(`session hooks: ${change.error}`)
            else if (change.action !== 'unchanged')
                await log(`session hooks: ${change.framework} ${change.action}`)
        }
    } catch (err) {
        await log(`session hooks: install failed: ${(err as Error).message}`)
    }
}

// What the CLI put on the hook's stdin, mapped to the report the API takes.
// Null when it is not a session event at all.
export const hookReportFromInput = (
    framework: TerminalHookFramework,
    input: unknown
): TerminalSessionHookRequest | null => {
    if (!input || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    const sessionRef =
        typeof record.session_id === 'string' ? record.session_id.trim() : ''
    if (!sessionRef) return null
    const eventName = record.hook_event_name
    const event =
        eventName === 'SessionStart'
            ? 'start'
            : eventName === 'SessionEnd'
              ? 'end'
              : null
    if (!event) return null
    const rawSource = event === 'start' ? record.source : record.reason
    const source: TerminalHookSource =
        typeof rawSource === 'string' &&
        (TERMINAL_HOOK_SOURCES as readonly string[]).includes(rawSource)
            ? (rawSource as TerminalHookSource)
            : 'other'
    const cwd = typeof record.cwd === 'string' ? record.cwd : undefined
    return { framework, event, source, sessionRef, ...(cwd ? { cwd } : {}) }
}

export interface SessionHookReportResult {
    sent: boolean
    status: number | null
    outcome: TerminalSessionHookResponse['outcome'] | null
    error: string | null
}

export const sendSessionHookReport = async (args: {
    apiUrl: string
    token: string
    body: TerminalSessionHookRequest
    fetchImpl?: typeof fetch
}): Promise<SessionHookReportResult> => {
    try {
        const res = await createCliFetch({
            fetchImpl: args.fetchImpl,
            timeoutMs: 10_000
        })(`${args.apiUrl}${apiPaths.TERMINAL_SESSION_HOOKS}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${args.token}`
            },
            body: JSON.stringify(args.body)
        })
        if (!res.ok)
            return {
                sent: false,
                status: res.status,
                outcome: null,
                error: (await res.text().catch(() => '')) || res.statusText
            }
        const parsed = (await res.json().catch(() => null)) as Record<
            string,
            unknown
        > | null
        const payload = (parsed && 'data' in parsed ? parsed.data : parsed) as
            | Partial<TerminalSessionHookResponse>
            | null
            | undefined
        return {
            sent: true,
            status: res.status,
            outcome: payload?.outcome ?? null,
            error: null
        }
    } catch (err) {
        return {
            sent: false,
            status: null,
            outcome: null,
            error: (err as Error).message
        }
    }
}
