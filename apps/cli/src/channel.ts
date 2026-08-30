import {
    cliChannelOfVersion,
    DEFAULT_CLI_API_URL,
    isDevCliVersion
} from '@manyfold/shared'

declare const __MF_CLI_CHANNEL__: string

export type CliChannel = 'stable' | 'dev'

// Build identity: which channel this binary was produced for. It feeds the
// default profile (config.ts), the daemon registration record and
// `mf version`. It is NOT the update channel — that is the saved preference in
// channel-pref.ts, which survives a cross-channel swap.
export const CLI_CHANNEL: CliChannel =
    typeof __MF_CLI_CHANNEL__ !== 'undefined' &&
    (__MF_CLI_CHANNEL__ === 'dev' || __MF_CLI_CHANNEL__ === 'staging')
        ? 'dev'
        : 'stable'

// The dev channel is an update POLICY, not a deployment. Both channels talk to
// the production API: this repository is edition-neutral and cannot bake a
// deployment-private endpoint. Point a profile at a pre-production API
// explicitly instead (`mf --profile <name> login --api-url …`).
export const DEFAULT_API_URL = DEFAULT_CLI_API_URL

const CLI_RELEASE_REPO = 'manyfold-open/manyfold'
const DOWNLOAD_BASE = `https://github.com/${CLI_RELEASE_REPO}/releases/download`

// A fixed prerelease that is never GitHub's "latest", holding one manifest per
// channel. Clobbered in place, so these two URLs are stable forever; the
// manifests inside carry absolute artifact URLs, which is what lets the
// artifact storage move later without reissuing a single binary.
const CHANNEL_MANIFEST_TAG = 'cli-channels'
const DEV_RELEASE_TAG = 'cli-dev'

export const channelManifestUrl = (channel: CliChannel): string =>
    `${DOWNLOAD_BASE}/${CHANNEL_MANIFEST_TAG}/${channel}.json`

// Every release also ships its own manifest so an arbitrary past build stays
// resolvable (`mf update --to`, and the API's daemon.update targetVersion)
// without the binary re-deriving the asset naming convention.
export const versionManifestUrl = (version: string): string =>
    isDevCliVersion(version)
        ? `${DOWNLOAD_BASE}/${DEV_RELEASE_TAG}/manifest-${version}.json`
        : `${DOWNLOAD_BASE}/cli-v${version.replace(/^v/, '')}/manifest.json`

export const CLI_INSTALL_URL = 'https://manyfold.ai/cli/install.sh'

// `staging` is the pre-rename alias for the dev channel.
export const normalizeUpdateChannelFlag = (value: string): CliChannel => {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'dev' || normalized === 'staging') return 'dev'
    if (normalized === 'stable') return 'stable'
    throw new Error(`unknown channel '${value}' (expected dev or stable)`)
}

// The API's daemon.update payload carries a channel string. An API deployed
// before the rename still sends 'staging', so a rolling deploy must not brick
// the RPC.
export const normalizeWireChannel = (
    value: unknown
): CliChannel | undefined => {
    if (typeof value !== 'string') return undefined
    try {
        return normalizeUpdateChannelFlag(value)
    } catch {
        return undefined
    }
}

// A pinned `--to <version>` uniquely determines its manifest, so its inferred
// channel beats the saved preference; the caller rejects a `--channel` that
// disagrees with an explicit `--to`.
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
