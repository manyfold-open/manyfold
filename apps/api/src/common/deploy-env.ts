import type { MfCliChannel } from '@manyfold/shared'
import { CLI_CDN_BASE } from './brand'

const DEFAULT_MF_DEPLOY_ENV = 'local'

export const resolveMfDeployEnv = (
    value: string | null | undefined
): string => {
    const trimmed = value?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MF_DEPLOY_ENV
}

const STABLE_CLI_CDN_BASE = CLI_CDN_BASE
const STAGING_CLI_CDN_BASE = `${CLI_CDN_BASE}/staging`

export const cliChannelForDeployEnv = (deployEnv: string): MfCliChannel =>
    deployEnv === 'staging' ? 'staging' : 'stable'

export const cliCdnBaseForDeployEnv = (deployEnv: string): string =>
    cliChannelForDeployEnv(deployEnv) === 'staging'
        ? STAGING_CLI_CDN_BASE
        : STABLE_CLI_CDN_BASE

export const cliCdnBaseForChannel = (channel: MfCliChannel): string =>
    channel === 'staging' ? STAGING_CLI_CDN_BASE : STABLE_CLI_CDN_BASE

// Non-prod envs may surface staging CLI builds and allow cross-channel daemon
// upgrades; prod stays strictly on its own channel.
export const cliStagingAllowedForDeployEnv = (deployEnv: string): boolean =>
    deployEnv === 'local' || deployEnv === 'staging'
