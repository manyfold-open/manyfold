import { readdir, readFile, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { buildApiError } from '@manyfold/sdk'
import type { DaemonHostSummary } from '@manyfold/shared'
import { apiPaths, profilePaths } from '@manyfold/shared'
import { channelManifestUrl, DEFAULT_API_URL, normalizeApiUrl } from '@/channel'
import { listProfileNames } from '@/commands/profile'
import { resolveUpdateStatus } from '@/commands/update'
import type { CliConfig } from '@/config'
import { type DaemonConfig, daemonPathsFor } from '@/daemon/config'
import { BINARY_FOR_FRAMEWORK } from '@/daemon/detect'
import {
    initUnitFileName,
    parseInitUnitProgram,
    profileOfInitUnitFile,
    type Scope
} from '@/daemon/init-unit'
import { readLastLines } from '@/daemon/log-file'
import { runningDaemonPid } from '@/daemon/pid'
import {
    sessionHookInvocation,
    sessionHooksStatus
} from '@/daemon/session-hooks'
import { readJsonState } from '@/json-state'
import { normalizeCliError } from '@/output'
import { fetchReleaseManifest } from '@/release-manifest'
import { resolveSecretInput } from '@/secret-input'
import { resolveUpdateTarget } from '@/self-update'
import { createCliFetch } from '@/transport'
import { nonEmpty } from './describe'
import type {
    DoctorDeps,
    DoctorInput,
    HookFact,
    HttpFact,
    JsonFact,
    LogCause,
    MachineFacts,
    OverridesFact,
    PathEntry,
    PermissionIssue,
    ProfileFacts,
    UnitFact,
    UpdateFact
} from './types'

const SCOPES: Scope[] = ['user', 'system']

const LOG_TAIL_LINES = 400

const exists = async (path: string): Promise<boolean> => {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

const isDirectory = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

export const withTimeout = <T>(task: Promise<T>, ms: number): Promise<T> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`timed out after ${Math.ceil(ms / 1000)}s`)),
            ms
        )
        timer.unref?.()
        task.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (err: unknown) => {
                clearTimeout(timer)
                reject(err)
            }
        )
    })

const readJsonFact = async <T>(path: string): Promise<JsonFact<T>> => {
    let parsed: unknown
    try {
        parsed = await readJsonState(path)
    } catch (err) {
        return { state: 'invalid', message: (err as Error).message }
    }
    if (parsed === undefined) return { state: 'missing' }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return { state: 'invalid', message: `${path} is not a JSON object` }
    return { state: 'ok', value: parsed as T }
}

export const createHttpProbe = (deps: DoctorDeps) => {
    const fetchImpl = createCliFetch({
        fetchImpl: deps.fetch,
        timeoutMs: deps.timeoutMs
    })
    const memo = new Map<string, Promise<HttpFact>>()
    const probe = async (
        url: string,
        token: string | null
    ): Promise<HttpFact> => {
        try {
            // A redirect is itself the finding (an SSO page or proxy in front
            // of the API), and following it would carry the token along.
            const res = await fetchImpl(url, {
                headers: token ? { authorization: `Bearer ${token}` } : {},
                redirect: 'manual'
            })
            if (res.status >= 300 && res.status < 400) {
                await res.body?.cancel().catch(() => {})
                return {
                    kind: 'redirect',
                    status: res.status,
                    location: res.headers.get('location')
                }
            }
            if (!res.ok) {
                const err = await buildApiError(res)
                return {
                    kind: 'error',
                    status: res.status,
                    code: err.code,
                    serverMessage: err.serverMessage ?? null
                }
            }
            const text = await res.text()
            try {
                return {
                    kind: 'ok',
                    status: res.status,
                    body: JSON.parse(text) as unknown
                }
            } catch {
                return { kind: 'not-json', status: res.status }
            }
        } catch (err) {
            const { code } = normalizeCliError(err).error
            return {
                kind: 'network',
                code: code.startsWith('network_') ? code : 'network_error'
            }
        }
    }
    return (url: string, token: string | null): Promise<HttpFact> => {
        const key = `${url}\n${token ?? ''}`
        let pending = memo.get(key)
        if (!pending) {
            pending = probe(url, token)
            memo.set(key, pending)
        }
        return pending
    }
}

type HttpProbe = ReturnType<typeof createHttpProbe>

export const isManyfoldHealth = (
    fact: HttpFact | null
): fact is { kind: 'ok'; status: number; body: { db: string } } =>
    fact?.kind === 'ok' &&
    typeof fact.body === 'object' &&
    fact.body !== null &&
    (fact.body as { status?: unknown }).status === 'ok' &&
    typeof (fact.body as { db?: unknown }).db === 'string'

const pathDirs = (deps: DoctorDeps): string[] =>
    (deps.env.PATH ?? deps.env.Path ?? '').split(delimiter).filter(Boolean)

const executableNames = (name: string, deps: DoctorDeps): string[] =>
    deps.platform === 'win32'
        ? (deps.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
              .split(';')
              .filter(Boolean)
              .map((ext) => `${name}${ext.toLowerCase()}`)
        : [name]

const isExecutableFile = async (
    path: string,
    deps: DoctorDeps
): Promise<boolean> => {
    try {
        const info = await stat(path)
        return (
            info.isFile() &&
            (deps.platform === 'win32' || (info.mode & 0o111) !== 0)
        )
    } catch {
        return false
    }
}

// A lookup by stat only: doctor never runs a CLI it finds by bare name.
const findOnPath = async (
    name: string,
    deps: DoctorDeps,
    all: boolean
): Promise<string[]> => {
    const found: string[] = []
    for (const dir of pathDirs(deps))
        for (const candidate of executableNames(name, deps)) {
            const path = join(dir, candidate)
            if (!(await isExecutableFile(path, deps))) continue
            found.push(path)
            if (!all) return found
        }
    return found
}

const realpathOr = async (path: string, deps: DoctorDeps): Promise<string> =>
    deps.realpath(path).catch(() => path)

const mfOnPath = async (deps: DoctorDeps): Promise<PathEntry[]> => {
    const entries: PathEntry[] = []
    const seen = new Set<string>()
    for (const path of await findOnPath('mf', deps, true)) {
        const real = await realpathOr(path, deps)
        if (seen.has(real)) continue
        seen.add(real)
        entries.push({ path, realpath: real })
    }
    return entries
}

const unitFileProfiles = async (deps: DoctorDeps): Promise<string[]> => {
    if (!deps.unitDirs) return []
    const names = new Set<string>()
    for (const scope of SCOPES) {
        let files: string[] = []
        try {
            files = await readdir(deps.unitDirs[scope])
        } catch {
            files = []
        }
        for (const file of files) {
            const name = profileOfInitUnitFile(deps.platform, file)
            if (name) names.add(name)
        }
    }
    return [...names]
}

export const profilesToCheck = async (
    deps: DoctorDeps,
    input: DoctorInput
): Promise<string[]> => {
    if (input.profileSource === 'flag') return [input.currentProfile]
    const others = new Set([
        ...(await listProfileNames(deps.configDir)),
        ...(await unitFileProfiles(deps))
    ])
    others.delete(input.currentProfile)
    return [input.currentProfile, ...[...others].sort()]
}

const describeFetchError = (err: unknown): string => {
    const { code } = normalizeCliError(err).error
    if (code === 'network_timeout') return 'timed out'
    if (code.startsWith('network_')) return code.replace('network_', '')
    return (err as Error).message
}

const updateFact = async (deps: DoctorDeps): Promise<UpdateFact> => {
    if (deps.build.installMethod !== 'standalone')
        return {
            kind: 'skipped',
            reason: 'source build: update it with git and pnpm build'
        }
    try {
        resolveUpdateTarget(deps.platform)
    } catch (err) {
        return { kind: 'skipped', reason: (err as Error).message }
    }
    const channel = deps.build.effectiveChannel
    try {
        const manifest = await fetchReleaseManifest(
            channelManifestUrl(channel),
            { fetchImpl: deps.fetch, timeoutMs: deps.timeoutMs }
        )
        return {
            kind: 'checked',
            channel,
            current: deps.build.version,
            latest: manifest.version,
            status: resolveUpdateStatus({
                channel,
                currentVersion: deps.build.version,
                currentCommit: deps.build.commit,
                targetVersion: manifest.version,
                targetCommit: manifest.commit
            })
        }
    } catch (err) {
        return { kind: 'error', message: describeFetchError(err) }
    }
}

const overridesFact = async (
    deps: DoctorDeps,
    input: DoctorInput,
    http: HttpProbe
): Promise<OverridesFact> => {
    const tokenInput = input.token ?? null
    const empty: OverridesFact = {
        apiUrl: input.apiUrl ?? null,
        token: tokenInput
            ? {
                  source: tokenInput.source,
                  fromStdin: tokenInput.value.trim() === '-'
              }
            : null,
        stdinUnavailable: false,
        targetUrl: null,
        probe: null
    }
    if (!input.apiUrl && !tokenInput) return empty
    let token: string | null = null
    if (tokenInput && tokenInput.value.trim() === '-') {
        if (deps.stdinIsTty) return { ...empty, stdinUnavailable: true }
        try {
            token = resolveSecretInput('-', '--token', deps.readStdin) ?? null
        } catch {
            return { ...empty, stdinUnavailable: true }
        }
    } else if (tokenInput) token = tokenInput.value.trim()
    const stored = await readJsonFact<CliConfig>(
        profilePaths(deps.configDir, input.currentProfile).configPath
    )
    const targetUrl =
        input.apiUrl?.value ??
        (stored.state === 'ok' ? nonEmpty(stored.value.apiUrl) : null) ??
        DEFAULT_API_URL
    const base = normalizeApiUrl(targetUrl)
    // A URL-only override is probed without credentials: doctor never sends
    // a stored token anywhere but the apiUrl it was stored with.
    const probe = token
        ? await http(`${base}${apiPaths.AUTH_WHOAMI}`, token)
        : await http(`${base}${apiPaths.HEALTH}`, null)
    return { ...empty, targetUrl, probe }
}

const hooksFact = async (
    deps: DoctorDeps
): Promise<{ hooks: HookFact[] | null; hooksError: string | null }> => {
    if (deps.platform === 'win32') return { hooks: null, hooksError: null }
    try {
        const status = await sessionHooksStatus({
            home: deps.home,
            consent: null
        })
        const hooks: HookFact[] = []
        for (const framework of status.frameworks) {
            if (!framework.installed) continue
            const script = await readFile(framework.scriptPath, 'utf8').catch(
                () => null
            )
            const invocation = script ? sessionHookInvocation(script) : null
            let missingTarget: string | null = null
            for (const part of invocation ?? [])
                if (isAbsolute(part) && !(await exists(part))) {
                    missingTarget = part
                    break
                }
            hooks.push({
                framework: framework.framework,
                current: framework.current,
                missingTarget,
                note: /turned off/.test(framework.note ?? '')
                    ? framework.note
                    : null
            })
        }
        return { hooks, hooksError: null }
    } catch (err) {
        return { hooks: null, hooksError: (err as Error).message }
    }
}

export const gatherMachine = async (
    deps: DoctorDeps,
    input: DoctorInput,
    http: HttpProbe,
    self: string | null
): Promise<MachineFacts> => {
    const [update, onPath, overrides, terminal, frameworks, hooks] =
        await Promise.all([
            updateFact(deps),
            mfOnPath(deps),
            overridesFact(deps, input, http),
            deps.ptySupport(),
            Promise.all(
                Object.entries(BINARY_FOR_FRAMEWORK).map(
                    async ([framework, binary]) => ({
                        framework:
                            framework as keyof typeof BINARY_FOR_FRAMEWORK,
                        path: (await findOnPath(binary, deps, false))[0] ?? null
                    })
                )
            ),
            hooksFact(deps)
        ])
    return {
        build: deps.build,
        update,
        self,
        mfOnPath: onPath,
        overrides,
        terminal,
        frameworks: frameworks.flatMap((f) =>
            f.path ? [{ framework: f.framework, path: f.path }] : []
        ),
        ...hooks
    }
}

const permissionIssues = async (
    targets: Array<[string, number]>,
    deps: DoctorDeps
): Promise<PermissionIssue[]> => {
    if (deps.platform === 'win32') return []
    const issues: PermissionIssue[] = []
    for (const [path, expected] of targets) {
        let info
        try {
            info = await stat(path)
        } catch {
            continue
        }
        const mode = info.mode & 0o777
        if ((mode & 0o077) !== 0)
            issues.push({ path, kind: 'mode', mode, expected })
        if (deps.uid !== null && info.uid !== deps.uid)
            issues.push({ path, kind: 'owner', uid: info.uid })
    }
    return issues
}

// Everything before the `daemon` subcommand: the binary, or node plus the
// entry script for a source checkout.
const invocationOf = (programArgs: string[]): string[] => {
    const index = programArgs.indexOf('daemon')
    return index > 0 ? programArgs.slice(0, index) : programArgs.slice(0, 1)
}

const unitFact = async (
    scope: Scope,
    profile: string,
    dirs: Record<Scope, string>,
    deps: DoctorDeps
): Promise<UnitFact> => {
    const path = join(dirs[scope], initUnitFileName(deps.platform, profile))
    const text = await readFile(path, 'utf8').catch(
        (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : '')
    )
    if (text === null)
        return {
            scope,
            path,
            installed: false,
            loaded: false,
            active: false,
            invocation: null,
            programExists: null,
            programRealpath: null
        }
    const programArgs = parseInitUnitProgram(deps.platform, text)
    const invocation = programArgs?.length ? invocationOf(programArgs) : null
    const [status, programExists, programRealpath] = await Promise.all([
        deps.unitStatus(scope, profile),
        invocation
            ? Promise.all(
                  invocation
                      .filter((part) => isAbsolute(part))
                      .map((part) => exists(part))
              ).then((found) => found.every(Boolean))
            : Promise.resolve(null),
        invocation ? realpathOr(invocation[0], deps) : Promise.resolve(null)
    ])
    return {
        scope,
        path,
        installed: true,
        loaded: status.loaded,
        active: status.active,
        invocation,
        programExists,
        programRealpath
    }
}

// The cause of the latest disconnect since the last connect of the current
// run. A healthy daemon's log is full of transient closes (1006, 1012 on API
// deploys), so this only means something while the daemon is offline. Only
// the numeric code is kept: log lines are never echoed.
export const parseDaemonLogTail = (text: string): LogCause | null => {
    const lines = text.split('\n')
    let start = 0
    for (let i = lines.length - 1; i >= 0; i -= 1)
        if (lines[i].includes(' daemon starting version=')) {
            start = i
            break
        }
    let cause: LogCause | null = null
    for (const line of lines.slice(start)) {
        if (/ ws connected\s*$/.test(line)) {
            cause = null
            continue
        }
        const unexpected = /Unexpected server response: (\d{3})/.exec(line)
        if (unexpected) {
            cause = {
                kind: 'unexpected-response',
                status: Number(unexpected[1])
            }
            continue
        }
        const closed = / ws closed code=(\d+)(?: reason=(.*))?$/.exec(line)
        if (closed)
            cause = {
                kind: 'close',
                code: Number(closed[1]),
                connectFailed: closed[2]?.trim() === 'Failed to connect'
            }
    }
    return cause
}

// `/daemon/me` answers either bare or wrapped in `data`, as `mf daemon
// status` also accepts. Fields are read defensively: an older API may lack
// some of them.
export const hostSummaryOf = (
    fact: HttpFact | null
): Partial<DaemonHostSummary> | null => {
    if (fact?.kind !== 'ok' || typeof fact.body !== 'object' || !fact.body)
        return null
    const body = fact.body as { data?: unknown }
    const summary =
        typeof body.data === 'object' && body.data !== null ? body.data : body
    return summary as Partial<DaemonHostSummary>
}

export const createVersionProbe = (deps: DoctorDeps) => {
    const memo = new Map<string, Promise<string | null>>()
    return (invocation: string[], real: string): Promise<string | null> => {
        const key = [real, ...invocation.slice(1)].join('\n')
        let pending = memo.get(key)
        if (!pending) {
            pending = deps.binaryVersion(invocation)
            memo.set(key, pending)
        }
        return pending
    }
}

type VersionProbe = ReturnType<typeof createVersionProbe>

export const gatherProfile = async (
    name: string,
    input: DoctorInput,
    self: string | null,
    deps: DoctorDeps,
    http: HttpProbe,
    versions: VersionProbe
): Promise<ProfileFacts> => {
    const paths = profilePaths(deps.configDir, name)
    const daemon = daemonPathsFor(paths)
    const [dirExists, config, registration] = await Promise.all([
        isDirectory(paths.dir),
        readJsonFact<CliConfig>(paths.configPath),
        readJsonFact<DaemonConfig>(paths.daemonConfigPath)
    ])
    const cfg = config.state === 'ok' ? config.value : null
    const reg = registration.state === 'ok' ? registration.value : null
    const token = nonEmpty(cfg?.token)
    const loginUrl = nonEmpty(cfg?.apiUrl) ?? (token ? DEFAULT_API_URL : null)
    const regUrl = nonEmpty(reg?.apiUrl)
    const regToken = nonEmpty(reg?.token)
    const apiUrl = loginUrl ?? regUrl
    const units = deps.unitDirs
    const [issues, pid, health, unitFacts, api, auth, daemonMe] =
        await Promise.all([
            permissionIssues(
                [
                    [paths.dir, 0o700],
                    [paths.configPath, 0o600],
                    [paths.daemonDir, 0o700],
                    [paths.daemonConfigPath, 0o600]
                ],
                deps
            ),
            runningDaemonPid({ pidPath: daemon.pidPath }),
            dirExists
                ? deps.daemonHealth(daemon.controlSocketPath)
                : Promise.resolve(null),
            units
                ? Promise.all(
                      SCOPES.map((scope) => unitFact(scope, name, units, deps))
                  ).then(([user, system]) => ({ user, system }))
                : Promise.resolve(null),
            apiUrl
                ? http(`${normalizeApiUrl(apiUrl)}${apiPaths.HEALTH}`, null)
                : Promise.resolve(null),
            token && loginUrl
                ? http(
                      `${normalizeApiUrl(loginUrl)}${apiPaths.AUTH_WHOAMI}`,
                      token
                  )
                : Promise.resolve(null),
            regUrl && regToken
                ? http(
                      `${normalizeApiUrl(regUrl)}${apiPaths.DAEMON_ME}`,
                      regToken
                  )
                : Promise.resolve(null)
        ])

    let apiSuggestion: string | null = null
    if (apiUrl && api && !isManyfoldHealth(api)) {
        const base = normalizeApiUrl(apiUrl)
        if (
            !base.endsWith('/api') &&
            isManyfoldHealth(await http(`${base}/api${apiPaths.HEALTH}`, null))
        )
            apiSuggestion = `${base}/api`
    }

    const summary = hostSummaryOf(daemonMe)
    let logCause: LogCause | null = null
    if (health && (!health.wsConnected || summary?.online === false))
        logCause = await readLastLines(daemon.logPath, LOG_TAIL_LINES)
            .then((tail) => parseDaemonLogTail(tail.toString('utf8')))
            .catch(() => null)

    let onDisk: ProfileFacts['onDisk'] = null
    if (health) {
        const unit =
            health.startupMethod === 'launchd-user' ||
            health.startupMethod === 'systemd-user'
                ? unitFacts?.user
                : health.startupMethod === 'launchd-system' ||
                    health.startupMethod === 'systemd-system'
                  ? unitFacts?.system
                  : undefined
        if (unit?.invocation && unit.programRealpath)
            onDisk = {
                path: unit.invocation[0],
                version:
                    unit.programRealpath === self
                        ? deps.build.version
                        : unit.programExists
                          ? await versions(
                                unit.invocation,
                                unit.programRealpath
                            )
                          : null
            }
        else if (self) onDisk = { path: self, version: deps.build.version }
    }

    return {
        name,
        current: name === input.currentProfile,
        dirExists,
        paths: {
            dir: paths.dir,
            configPath: paths.configPath,
            daemonDir: paths.daemonDir,
            daemonConfigPath: paths.daemonConfigPath,
            errLogPath: daemon.errLogPath
        },
        config,
        registration,
        permissionIssues: dirExists ? issues : [],
        apiUrl,
        api,
        apiSuggestion,
        auth,
        pid,
        health,
        units: unitFacts,
        daemonMe,
        logCause,
        onDisk
    }
}
