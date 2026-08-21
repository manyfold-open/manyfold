/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL?: string
    readonly VITE_DASHBOARD_ORIGIN_SUFFIXES?: string
    readonly VITE_BRAND_NAME?: string
    readonly VITE_DOCS_URL?: string
    readonly VITE_AXIOM_TOKEN?: string
    readonly VITE_AXIOM_DATASET?: string
    readonly VITE_MF_ENV?: string
    readonly VITE_NCA_ENV?: string
    readonly VITE_DEV_BEARER_TOKEN?: string
    readonly VITE_SENTRY_DSN?: string
    readonly VITE_GA_MEASUREMENT_ID?: string
    // injected by vite.config.ts define, not by the environment
    readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
