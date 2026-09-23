import { realpath } from 'node:fs/promises'
import type { DaemonStartupMethod } from '@manyfold/shared'
import { isValidProfileName } from '@manyfold/shared'
import { homedir, userInfo } from 'node:os'
import { daemonPaths } from '@/daemon/config'
import { resolveProfile } from '@/config'
import { isBunStandalone } from '@/standalone'
import * as darwin from './darwin'
import * as linux from './linux'

export type Scope = 'user' | 'system'

export interface InitUnitInfo {
    scope: Scope
    installed: boolean
    enabled: boolean
    active: boolean
    unitPath: string
}

export interface InstallContext {
    scope: Scope
    programArgs: string[]
    home: string
    user: string
    group: string
    errLogPath: string
    profile: string
}

export class UnsupportedPlatformError extends Error {
    constructor(reason: string) {
        super(reason)
        this.name = 'UnsupportedPlatformError'
    }
}

export const isPlatformSupported = (): boolean =>
    process.platform === 'darwin' || process.platform === 'linux'

// Root has no per-user systemd/launchd session on a fresh server: over SSH
// there is no D-Bus session bus / XDG_RUNTIME_DIR, so `systemctl --user` fails.
// A root daemon also belongs at boot scope, so default root to system scope
// (no sudo needed — it is already root) and everyone else to user scope.
export const defaultScope = (): Scope =>
    (process.getuid?.() ?? -1) === 0 ? 'system' : 'user'

export const resolveScope = (opts: {
    system?: boolean
    user?: boolean
}): Scope => {
    if (opts.system) return 'system'
    if (opts.user) return 'user'
    return defaultScope()
}

const buildInstallContext = async (scope: Scope): Promise<InstallContext> => {
    const exec = await realpath(process.execPath)
    const programArgs = isBunStandalone()
        ? [exec, 'daemon', 'start', '--foreground']
        : [exec, process.argv[1] ?? '', 'daemon', 'start', '--foreground']
    const info = userInfo()
    return {
        scope,
        programArgs,
        home: homedir(),
        user: info.username,
        group: info.username,
        errLogPath: daemonPaths.errLogPath,
        profile: resolveProfile()
    }
}

export const installInitUnit = async (opts: {
    scope: Scope
}): Promise<InitUnitInfo> => {
    if (!isPlatformSupported())
        throw new UnsupportedPlatformError(
            `mf daemon autostart is only supported on macOS and Linux (current: ${process.platform})`
        )
    const ctx = await buildInstallContext(opts.scope)
    if (process.platform === 'darwin') return darwin.install(ctx)
    return linux.install(ctx)
}

export const uninstallInitUnit = async (opts: {
    scope: Scope
    // `mf profile delete` tears down units for a profile other than the
    // resolved one; everything else omits this and gets the current profile.
    profile?: string
}): Promise<void> => {
    if (!isPlatformSupported())
        throw new UnsupportedPlatformError(
            `mf daemon autostart is only supported on macOS and Linux (current: ${process.platform})`
        )
    const profile = opts.profile ?? resolveProfile()
    if (process.platform === 'darwin')
        return darwin.uninstall({ scope: opts.scope, profile })
    return linux.uninstall({ scope: opts.scope, profile })
}

export const getInitUnitStatus = async (
    scope: Scope,
    // `mf doctor` reads every profile's unit; everything else omits this.
    profile: string = resolveProfile()
): Promise<InitUnitInfo> => {
    if (!isPlatformSupported())
        return {
            scope,
            installed: false,
            enabled: false,
            active: false,
            unitPath: ''
        }
    if (process.platform === 'darwin') return darwin.status(scope, profile)
    return linux.status(scope, profile)
}

// Unit files read back by `mf doctor`, which inspects every profile's unit
// and lists the directories to find units whose profile has no state dir.
export const initUnitDirs = (
    platform: NodeJS.Platform,
    home: string
): Record<Scope, string> | null => {
    if (platform === 'darwin')
        return {
            user: darwin.launchdDir('user', home),
            system: darwin.launchdDir('system', home)
        }
    if (platform === 'linux')
        return {
            user: linux.systemdDir('user', home),
            system: linux.systemdDir('system', home)
        }
    return null
}

export const initUnitFileName = (
    platform: NodeJS.Platform,
    profile: string
): string =>
    platform === 'darwin'
        ? `${darwin.launchdLabelFor(profile)}.plist`
        : linux.systemdUnitNameFor(profile)

export const profileOfInitUnitFile = (
    platform: NodeJS.Platform,
    file: string
): string | null => {
    const name = (
        platform === 'darwin'
            ? /^ai\.manyfold\.daemon\.(.+)\.plist$/
            : /^mf-daemon-(.+)\.service$/
    ).exec(file)?.[1]
    return name &&
        isValidProfileName(name) &&
        initUnitFileName(platform, name) === file
        ? name
        : null
}

export const parseInitUnitProgram = (
    platform: NodeJS.Platform,
    text: string
): string[] | null =>
    platform === 'darwin'
        ? darwin.parsePlistProgramArgs(text)
        : linux.parseExecStart(text)

export interface ExecSurvival {
    survive: boolean
    reason: string
}

// Whether a detached exec outlives a restart of THIS installation, decided
// at runtime from what actually manages the daemon (ADR-0029 §4): launchd
// signals only the job's own process group, so a detached exec is safe; a
// systemd unit is safe only with KillMode=process, which the user unit now
// carries but an operator's system unit may not; a manual start has no
// supervisor, so nothing but `mf daemon stop --keep-execs` keeps them.
export const survivalForKillMode = (
    startupMethod: DaemonStartupMethod,
    killMode: string | null
): ExecSurvival => {
    if (startupMethod === 'launchd-user' || startupMethod === 'launchd-system')
        return {
            survive: true,
            reason: 'launchd signals only its own process group'
        }
    if (startupMethod === 'systemd-user' || startupMethod === 'systemd-system')
        return killMode === 'process'
            ? { survive: true, reason: 'systemd KillMode=process' }
            : {
                  survive: false,
                  reason: `systemd KillMode=${killMode ?? 'unknown'}; reinstall the unit with mf daemon stop && mf daemon start`
              }
    return {
        survive: false,
        reason: 'no init unit; only mf daemon stop --keep-execs keeps them'
    }
}

export const execsSurviveRestart = async (
    startupMethod: DaemonStartupMethod
): Promise<ExecSurvival> => {
    if (startupMethod === 'systemd-user' || startupMethod === 'systemd-system')
        return survivalForKillMode(
            startupMethod,
            await linux.killModeOf(
                startupMethod === 'systemd-user' ? 'user' : 'system',
                resolveProfile()
            )
        )
    return survivalForKillMode(startupMethod, null)
}

export const isLikelyDevBinary = (): boolean => {
    const base = process.execPath.split('/').pop() ?? ''
    return base === 'node' || base === 'bun'
}
