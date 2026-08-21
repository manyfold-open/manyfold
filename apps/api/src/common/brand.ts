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
export const CLI_CDN_BASE = 'https://cdn1.manyfold.ai/cli'
