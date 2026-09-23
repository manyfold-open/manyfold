import type { DetectedFramework } from '@manyfold/shared'
import type { BuildInfo } from '@/build-info'
import type { CliChannel } from '@/channel'
import type { UpdateStatus } from '@/commands/update'
import type { CliConfig, ProfileSource } from '@/config'
import type { DaemonConfig } from '@/daemon/config'
import type { DaemonLocalHealth } from '@/daemon/control'
import type { Scope } from '@/daemon/init-unit'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

// The ids, scope, profile, status and data keys are the --json contract;
// titles, details and fixes are prose and may change.
export type CheckId =
    | 'cli.update'
    | 'cli.path'
    | 'config.overrides'
    | 'local.terminal'
    | 'local.frameworks'
    | 'local.hooks'
    | 'profile.config'
    | 'profile.permissions'
    | 'profile.api'
    | 'profile.auth'
    | 'daemon.registration'
    | 'daemon.process'
    | 'daemon.version'
    | 'daemon.connection'
    | 'daemon.autostart'
    | 'daemon.frameworks'

export interface DoctorCheck {
    id: CheckId
    scope: 'machine' | 'profile'
    profile?: string
    status: CheckStatus
    title: string
    detail: string
    fix?: string
    data?: Record<string, unknown>
}

export interface DoctorProfileSummary {
    name: string
    current: boolean
    exists: boolean
    loggedIn: boolean
    daemonRegistered: boolean
    inUse: boolean
}

export interface DoctorReport {
    schemaVersion: 1
    ok: boolean
    summary: Record<CheckStatus, number>
    cli: BuildInfo
    currentProfile: { name: string; source: ProfileSource; exists: boolean }
    profiles: DoctorProfileSummary[]
    checks: DoctorCheck[]
}

// One HTTP probe's outcome. An error keeps only the envelope's code and
// message: never a token, never an unparsed body.
export type HttpFact =
    | { kind: 'ok'; status: number; body: unknown }
    | { kind: 'not-json'; status: number }
    | { kind: 'redirect'; status: number; location: string | null }
    | {
          kind: 'error'
          status: number
          code: string
          serverMessage: string | null
      }
    | { kind: 'network'; code: string }

export type JsonFact<T> =
    | { state: 'missing' }
    | { state: 'invalid'; message: string }
    | { state: 'ok'; value: T }

export interface UnitFact {
    scope: Scope
    path: string
    installed: boolean
    loaded: boolean
    active: boolean
    // What the unit file runs, up to the `daemon` subcommand; null when the
    // file cannot be read back.
    invocation: string[] | null
    programExists: boolean | null
    programRealpath: string | null
}

export type LogCause =
    | { kind: 'close'; code: number; connectFailed: boolean }
    | { kind: 'unexpected-response'; status: number }

export interface PermissionIssue {
    path: string
    kind: 'mode' | 'owner'
    mode?: number
    expected?: number
    uid?: number
}

export interface ProfileFacts {
    name: string
    current: boolean
    dirExists: boolean
    paths: {
        dir: string
        configPath: string
        daemonDir: string
        daemonConfigPath: string
        errLogPath: string
    }
    config: JsonFact<CliConfig>
    registration: JsonFact<DaemonConfig>
    permissionIssues: PermissionIssue[]
    // The login apiUrl, or the registration's for a daemon-only profile.
    apiUrl: string | null
    api: HttpFact | null
    // `<apiUrl>/api` when the configured URL is not an API but that one is.
    apiSuggestion: string | null
    auth: HttpFact | null
    pid: number | null
    health: DaemonLocalHealth | null
    units: { user: UnitFact; system: UnitFact } | null
    daemonMe: HttpFact | null
    logCause: LogCause | null
    // The version of the binary the running daemon would restart into.
    onDisk: { version: string | null; path: string } | null
}

export type UpdateFact =
    | { kind: 'skipped'; reason: string }
    | { kind: 'error'; message: string }
    | {
          kind: 'checked'
          channel: CliChannel
          current: string
          latest: string
          status: UpdateStatus
      }

export interface PathEntry {
    path: string
    realpath: string
}

export interface HookFact {
    framework: string
    current: boolean
    missingTarget: string | null
    note: string | null
}

export type TokenSource = 'flag' | 'MF_TOKEN' | 'MF_API_TOKEN'
export type ApiUrlSource = 'flag' | 'MF_API_URL'

export interface OverridesFact {
    apiUrl: { value: string; source: ApiUrlSource } | null
    token: { source: TokenSource; fromStdin: boolean } | null
    // `--token -` with nothing to read: a terminal on stdin, or empty input.
    stdinUnavailable: boolean
    targetUrl: string | null
    // whoami with the override token, or /health for a URL-only override.
    probe: HttpFact | null
}

export interface MachineFacts {
    build: BuildInfo
    update: UpdateFact
    // This binary's real path; null for a source build run through node.
    self: string | null
    mfOnPath: PathEntry[]
    overrides: OverridesFact
    terminal: { backend: string } | { problem: string }
    frameworks: Array<{
        framework: DetectedFramework['framework']
        path: string
    }>
    // null where session hooks do not exist (Windows).
    hooks: HookFact[] | null
    hooksError: string | null
}

export interface DoctorContext {
    currentProfile: string
    profileSource: ProfileSource
    bakedChannel: CliChannel
    platform: NodeJS.Platform
    now: number
    anyRegistration: boolean
}

export interface DoctorInput {
    currentProfile: string
    profileSource: ProfileSource
    apiUrl?: { value: string; source: ApiUrlSource }
    token?: { value: string; source: TokenSource }
}

export interface DoctorDeps {
    platform: NodeJS.Platform
    env: NodeJS.ProcessEnv
    home: string
    configDir: string
    uid: number | null
    now: () => number
    fetch: typeof fetch
    timeoutMs: number
    build: BuildInfo
    stdinIsTty: boolean
    readStdin: () => string
    // Where each scope's init units live; null where there are none.
    unitDirs: Record<Scope, string> | null
    realpath: (path: string) => Promise<string>
    unitStatus: (
        scope: Scope,
        profile: string
    ) => Promise<{ loaded: boolean; active: boolean }>
    daemonHealth: (socketPath: string) => Promise<DaemonLocalHealth | null>
    ptySupport: () => Promise<{ backend: string } | { problem: string }>
    binaryVersion: (invocation: string[]) => Promise<string | null>
}
