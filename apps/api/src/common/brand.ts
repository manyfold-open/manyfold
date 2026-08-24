// The single home for the default brand constants (design §3.5): what the
// platform is called and where it lives when nothing else is configured.
// Every consumer prefers its configured source (admin settings, MF_WEB_URL,
// PUBLIC_API_BASE_URL, deploy-env) and only lands on these fallbacks — a
// white-label deployment audits brand identity here and in the capabilities
// branding payload instead of hunting literals across the tree.
export const BRAND_NAME = 'Manyfold'
export const DEFAULT_WEB_BASE_URL = 'https://manyfold.ai'
export const DEFAULT_API_BASE_URL = 'https://api.manyfold.ai/api'
export const SUPPORT_EMAIL = 'hi@manyfold.ai'
// The public CLI entry points. Kept as literals rather than derived from
// DEFAULT_WEB_BASE_URL: a white-label deployment retargets its own web URL but
// still installs the upstream mf binary from upstream's releases.
export const CLI_INSTALL_URL = 'https://manyfold.ai/cli/install.sh'
export const CLI_RELEASE_REPO = 'manyfold-open/manyfold'
export const CLI_RELEASE_DOWNLOAD_BASE = `https://github.com/${CLI_RELEASE_REPO}/releases/download`
export const CLI_CHANNEL_MANIFEST_TAG = 'cli-channels'
