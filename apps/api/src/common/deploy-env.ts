import type { MfCliChannel } from '@manyfold/shared'
import { CLI_CHANNEL_MANIFEST_TAG, CLI_RELEASE_DOWNLOAD_BASE } from './brand'

const DEFAULT_MF_DEPLOY_ENV = 'local'

export const resolveMfDeployEnv = (
    value: string | null | undefined
): string => {
    const trimmed = value?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MF_DEPLOY_ENV
}

export const cliChannelForDeployEnv = (deployEnv: string): MfCliChannel =>
    deployEnv === 'staging' ? 'dev' : 'stable'

// One manifest per channel, at a URL that never moves. The manifest carries the
// version and the absolute artifact URLs, so nothing here composes a download
// path — see apps/cli/src/release-manifest.ts for the reader.
export const cliChannelManifestUrl = (channel: MfCliChannel): string =>
    `${CLI_RELEASE_DOWNLOAD_BASE}/${CLI_CHANNEL_MANIFEST_TAG}/${channel}.json`

export const cliChannelManifestUrlForDeployEnv = (deployEnv: string): string =>
    cliChannelManifestUrl(cliChannelForDeployEnv(deployEnv))

// Non-prod envs may surface dev CLI builds and allow cross-channel daemon
// upgrades; prod stays strictly on its own channel.
export const cliDevAllowedForDeployEnv = (deployEnv: string): boolean =>
    deployEnv === 'local' || deployEnv === 'staging'
