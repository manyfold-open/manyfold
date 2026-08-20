/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL?: string
    readonly VITE_AXIOM_TOKEN?: string
    readonly VITE_AXIOM_DATASET?: string
    readonly VITE_MF_ENV?: string
    readonly VITE_NCA_ENV?: string
    readonly VITE_SENTRY_DSN?: string
    // injected by vite.config.ts define, not by the environment
    readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
