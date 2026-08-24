import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    PROFILE_NAME_RE,
    profilePaths,
    type ProfilePaths
} from '@manyfold/shared'
import { CLI_CHANNEL } from '@/channel'
import { readJsonState, writeProtectedJson } from '@/json-state'

// ADR-0014: the profile name feeds config paths, the daemon state dir, init
// unit names and the control socket, so it is validated here and resolved on
// every call (never captured at import time — `--profile` is parsed after
// module load, and tests swap MF_PROFILE mid-process).
// Precedence: --profile flag > MF_PROFILE > the binary channel's default.
let flagProfile: string | undefined

export const setProfileFlag = (value: string | undefined): void => {
    flagProfile = value
}

// The dev channel's profile is still named `staging`: renaming it would orphan
// the credentials and daemon registration already on disk under that name.
const channelDefaultProfile = (): string =>
    CLI_CHANNEL === 'dev' ? 'staging' : 'default'

export type ProfileSource = 'flag' | 'env' | 'channel-default'

export const resolveProfileSource = (): ProfileSource => {
    if (flagProfile?.trim()) return 'flag'
    if (process.env.MF_PROFILE?.trim()) return 'env'
    return 'channel-default'
}

export const resolveProfile = (): string => {
    const raw = (flagProfile ?? process.env.MF_PROFILE)?.trim()
    if (!raw) return channelDefaultProfile()
    if (!PROFILE_NAME_RE.test(raw))
        throw new Error(
            `invalid profile name '${raw}': use 1-32 characters of a-z, 0-9, '_' or '-', starting with a letter or digit`
        )
    return raw
}

export const resolveConfigDir = (): string =>
    process.env.MF_CONFIG_DIR ?? join(homedir(), '.manyfold')

export const currentProfilePaths = (): ProfilePaths =>
    profilePaths(resolveConfigDir(), resolveProfile())

export const resolveConfigPath = (): string => currentProfilePaths().configPath

export interface CliConfig {
    apiUrl?: string
    token?: string
}

const readCliConfig = async (
    filePath: string
): Promise<CliConfig | undefined> => {
    let parsed: unknown | undefined
    try {
        parsed = await readJsonState(filePath)
    } catch {
        throw new Error(
            `could not load CLI config at ${filePath}; fix or delete this file, then re-run \`mf login\``
        )
    }
    if (parsed === undefined) return undefined
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error(
            `invalid CLI config at ${filePath}; fix or delete this file, then re-run \`mf login\``
        )
    return parsed as CliConfig
}

export const loadConfig = async (): Promise<CliConfig> =>
    (await readCliConfig(resolveConfigPath())) ?? {}

export const saveConfig = async (cfg: CliConfig): Promise<void> =>
    writeProtectedJson(resolveConfigPath(), cfg)

// A poll-mode login that dies before the user approves (e.g. the hosting
// chat turn ends) must stay resumable: the deviceCode below is the only
// way to redeem the approved session, so it is persisted next to the
// config and redeemed by the next CLI invocation.
export interface PendingLogin {
    requestId: string
    deviceCode: string
    authUrl: string
    userCode: string
    scopes: string[]
    forAgent: string
    apiUrl: string
    expiresAt: string
}

export const resolvePendingLoginPath = (): string =>
    currentProfilePaths().pendingLoginPath

export const loadPendingLogin = async (): Promise<PendingLogin | null> => {
    try {
        const raw = await readFile(resolvePendingLoginPath(), 'utf8')
        const parsed = JSON.parse(raw) as PendingLogin
        if (!parsed.deviceCode || !parsed.apiUrl || !parsed.expiresAt)
            return null
        return parsed
    } catch {
        return null
    }
}

export const savePendingLogin = async (pending: PendingLogin): Promise<void> =>
    writeProtectedJson(resolvePendingLoginPath(), pending)

export const clearPendingLogin = async (): Promise<void> => {
    await rm(resolvePendingLoginPath(), { force: true }).catch(() => {})
}
