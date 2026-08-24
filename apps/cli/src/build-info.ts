import { CLI_CHANNEL, type CliChannel } from '@/channel'
import { loadUpdateChannelPref } from '@/channel-pref'
import { resolveConfigDir, resolveProfile, resolveProfileSource } from '@/config'
import { type UpdateTargetKey, targetKey } from '@/release-manifest'
import { resolveUpdateTarget } from '@/self-update'
import { isBunStandalone } from '@/standalone'
import { MF_CLI_BUILD_TIME, MF_CLI_COMMIT, MF_CLI_VERSION } from '@/version'

// Package-manager awareness (homebrew, npm, apt) is deliberately absent: there
// is no tap and @manyfold/cli is not published, so 'standalone' vs 'source' is
// the whole truth today. Add a value here when a managed channel actually
// exists, together with the refusal that tells the user to upgrade through it.
export type InstallMethod = 'standalone' | 'source'

export interface BuildInfo {
    version: string
    bakedChannel: CliChannel
    savedChannel: CliChannel | null
    effectiveChannel: CliChannel
    commit: string | null
    buildTime: string | null
    target: UpdateTargetKey | null
    installMethod: InstallMethod
    execPath: string
    configDir: string
    profile: string
    profileSource: string
}

export const collectBuildInfo = async (): Promise<BuildInfo> => {
    const savedChannel = await loadUpdateChannelPref()
    let target: UpdateTargetKey | null = null
    try {
        target = targetKey(resolveUpdateTarget())
    } catch {
        // An unsupported platform still gets a usable `mf version`.
        target = null
    }
    return {
        version: MF_CLI_VERSION,
        bakedChannel: CLI_CHANNEL,
        savedChannel,
        effectiveChannel: savedChannel ?? CLI_CHANNEL,
        commit: MF_CLI_COMMIT || null,
        buildTime: MF_CLI_BUILD_TIME || null,
        target,
        installMethod: isBunStandalone() ? 'standalone' : 'source',
        execPath: process.execPath,
        configDir: resolveConfigDir(),
        profile: resolveProfile(),
        profileSource: resolveProfileSource()
    }
}
