import { realpath } from 'node:fs/promises'
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
    scope: Scope
): Promise<InitUnitInfo> => {
    if (!isPlatformSupported())
        return {
            scope,
            installed: false,
            enabled: false,
            active: false,
            unitPath: ''
        }
    const profile = resolveProfile()
    if (process.platform === 'darwin') return darwin.status(scope, profile)
    return linux.status(scope, profile)
}

export const isLikelyDevBinary = (): boolean => {
    const base = process.execPath.split('/').pop() ?? ''
    return base === 'node' || base === 'bun'
}
