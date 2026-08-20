import { cliChannelOfVersion } from '@manyfold/shared'

declare const __MF_CLI_CHANNEL__: string
// Baked by the release workflows that actually operate a dev/staging channel;
// a bare build carries no dev endpoints and therefore has no dev channel.
declare const __MF_CLI_STAGING_API_URL__: string
declare const __MF_CLI_STAGING_CDN_BASE__: string

export type CliChannel = 'stable' | 'staging'

const stagingBaked = (): { apiUrl: string; cdnBase: string } => ({
    apiUrl:
        typeof __MF_CLI_STAGING_API_URL__ !== 'undefined'
            ? __MF_CLI_STAGING_API_URL__
            : '',
    cdnBase:
        typeof __MF_CLI_STAGING_CDN_BASE__ !== 'undefined'
            ? __MF_CLI_STAGING_CDN_BASE__
            : ''
})

export const channelDefaults = (
    channel: CliChannel
): { apiUrl: string; cdnBase: string } =>
    channel === 'staging'
        ? stagingBaked()
        : {
              apiUrl: 'https://api.manyfold.ai/api',
              cdnBase: 'https://cdn1.manyfold.ai/cli'
          }

// The dev channel only exists in builds whose workflow baked its endpoints.
export const hasDevChannel = (): boolean => {
    const { apiUrl, cdnBase } = stagingBaked()
    return Boolean(apiUrl && cdnBase)
}

export const requireChannelCdn = (channel: CliChannel): string => {
    const { cdnBase } = channelDefaults(channel)
    if (!cdnBase)
        throw new Error(
            'this build was not produced with a dev channel; only stable is available'
        )
    return cdnBase
}

export const CLI_CHANNEL: CliChannel =
    typeof __MF_CLI_CHANNEL__ !== 'undefined' &&
    __MF_CLI_CHANNEL__ === 'staging'
        ? 'staging'
        : 'stable'

export const DEFAULT_API_URL = channelDefaults(CLI_CHANNEL).apiUrl
export const CDN_BASE = channelDefaults(CLI_CHANNEL).cdnBase

// `mf update --channel` speaks openclaw's dev/stable vocabulary; `dev` (and the
// internal `staging` alias) both resolve to the staging channel.
export const normalizeUpdateChannelFlag = (value: string): CliChannel => {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'dev' || normalized === 'staging') return 'staging'
    if (normalized === 'stable') return 'stable'
    throw new Error(`unknown channel '${value}' (expected dev or stable)`)
}

export const channelFlagLabel = (channel: CliChannel): 'dev' | 'stable' =>
    channel === 'staging' ? 'dev' : 'stable'

// A pinned `--to <version>` uniquely determines its CDN (staging builds only
// exist under cli/staging), so its inferred channel beats the saved preference;
// the caller rejects a `--channel` that disagrees with an explicit `--to`.
export const resolveEffectiveUpdateChannel = (input: {
    flagChannel?: CliChannel | null
    savedPref?: CliChannel | null
    toVersion?: string | null
    baked: CliChannel
}): CliChannel => {
    if (input.toVersion)
        return input.flagChannel ?? cliChannelOfVersion(input.toVersion)
    return input.flagChannel ?? input.savedPref ?? input.baked
}
