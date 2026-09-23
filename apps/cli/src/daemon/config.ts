import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProfilePaths } from '@manyfold/shared'
import { CLI_CHANNEL, type CliChannel } from '@/channel'
import { currentProfilePaths } from '@/config'
import { controlSocketPathFor } from './control'
import {
    readJsonState,
    writeProtectedFile,
    writeProtectedJson
} from '@/json-state'

// The daemon files of any one profile; `mf doctor` reads other profiles'.
export const daemonPathsFor = (profile: ProfilePaths) => {
    const dir = profile.daemonDir
    return {
        baseDir: dir,
        configPath: profile.daemonConfigPath,
        idPath: join(dir, 'daemon.id'),
        pidPath: join(dir, 'daemon.pid'),
        logPath: join(dir, 'daemon.log'),
        errLogPath: join(dir, 'daemon.err.log'),
        workspaceRootsPath: join(dir, 'workspace-roots.json'),
        execDir: join(dir, 'exec'),
        // ADR-0029 §5: a manual-install self-update that rolled back leaves
        // the target it refused to retry, and the report its successor sends
        // once.
        updateLatchPath: join(dir, 'update-latch.json'),
        updateRollbackPath: join(dir, 'update-rollback.json'),
        controlSocketPath: controlSocketPathFor(dir)
    }
}

// ADR-0014: every daemon path derives from the current profile at access
// time — nothing is captured at import, so `--profile` (parsed after module
// load) and tests that swap MF_PROFILE both see consistent paths.
const current = () => daemonPathsFor(currentProfilePaths())

export const daemonPaths = {
    get baseDir(): string {
        return current().baseDir
    },
    get configPath(): string {
        return current().configPath
    },
    get idPath(): string {
        return current().idPath
    },
    get pidPath(): string {
        return current().pidPath
    },
    get logPath(): string {
        return current().logPath
    },
    get errLogPath(): string {
        return current().errLogPath
    },
    get workspaceRootsPath(): string {
        return current().workspaceRootsPath
    },
    get execDir(): string {
        return current().execDir
    },
    get updateLatchPath(): string {
        return current().updateLatchPath
    },
    get updateRollbackPath(): string {
        return current().updateRollbackPath
    },
    get controlSocketPath(): string {
        return current().controlSocketPath
    }
}

export interface DaemonConfig {
    apiUrl: string
    token: string
    daemonId: string
    daemonUuid: string
    profile?: string
    channel?: CliChannel
    workspaceBaseDir?: string
    skillsDir?: string
    // Whether this machine's owner said yes to the CLI session hooks
    // (ADR-0029 §3); absent until asked. `mf daemon start` installs and
    // refreshes them only while this is 'enabled'.
    sessionHooks?: 'enabled' | 'disabled'
}

export interface DaemonConfigPaths {
    configPath: string
    idPath: string
}

export const loadDaemonConfig = async (
    paths: DaemonConfigPaths = daemonPaths
): Promise<DaemonConfig | null> => {
    let parsed: unknown | undefined
    try {
        parsed = await readJsonState(paths.configPath)
    } catch {
        throw new Error(
            `could not load daemon config at ${paths.configPath}; remove this file and re-register with \`mf daemon register\``
        )
    }
    if (parsed === undefined) return null
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error(
            `invalid daemon config at ${paths.configPath}; remove this file and re-register with \`mf daemon register\``
        )
    return parsed as DaemonConfig
}

// ADR-0014: the profile dir structurally guarantees a registration belongs to
// this profile, and registration.apiUrl is the environment truth. The
// binary's update channel is NOT a compatibility axis — a mismatch is only
// worth a warning (the auto-update gate already disables periodic
// self-updates for cross-channel combinations, so the shared binary cannot
// ping-pong between channels).
export const daemonChannelWarning = (config: DaemonConfig): string | null =>
    config.channel && config.channel !== CLI_CHANNEL
        ? `daemon was registered from a ${config.channel}-channel binary but this binary is on the ${CLI_CHANNEL} channel; the daemon still serves ${config.apiUrl}`
        : null

export const loadDaemonConfigForStart = async (
    paths: DaemonConfigPaths = daemonPaths
): Promise<DaemonConfig | null> => {
    const config = await loadDaemonConfig(paths)
    if (!config) return null
    if (!config.profile || !config.channel)
        throw new Error(
            `daemon registration at ${paths.configPath} predates the per-profile layout (ADR-0014); re-register with \`mf daemon register --token -\``
        )
    return config
}

export const saveDaemonConfig = async (
    cfg: DaemonConfig,
    paths: DaemonConfigPaths = daemonPaths
): Promise<void> => writeProtectedJson(paths.configPath, cfg)

export const loadOrCreateDaemonUuid = async (
    paths: DaemonConfigPaths = daemonPaths
): Promise<string> => {
    let raw: string
    try {
        raw = await readFile(paths.idPath, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(
                `could not read daemon identity at ${paths.idPath}; restore it or run \`mf daemon register\` to create a new identity (the previous identity will be lost)`
            )
        }
        const id = randomUUID()
        await writeProtectedFile(paths.idPath, id)
        return id
    }
    const id = raw.trim()
    if (!id)
        throw new Error(
            `daemon identity file at ${paths.idPath} is empty; restore it or run \`mf daemon register\` to create a new identity (the previous identity will be lost)`
        )
    return id
}
