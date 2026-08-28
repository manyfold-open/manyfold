import { ConfigService } from '@nestjs/config'

export const configString = (
    config: ConfigService,
    keys: readonly string[]
): string | undefined => {
    for (const key of keys) {
        const value = config.get<string>(key)?.trim()
        if (value) return value
    }
    return undefined
}

export const envString = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
        const value = process.env[key]?.trim()
        if (value) return value
    }
    return undefined
}

// Legacy aliases the API still accepts for canonical config keys (resolution
// order is canonical first at every call site). LegacyEnvAuditService warns at
// startup for each alias still set — that self-report is the only possible
// usage signal for operator .env files, and its removal gate
// (docs/engineering/legacy-inventory.md §4.5).
//
// Deliberately NOT listed because they are not this process's operator env:
// - NCA_DEV_HOST / NCA_DEV_API_TARGET / VITE_NCA_ENV — vite dev/build process
//   variables; the API never sees them.
// - The on-sandbox surface (NCA_HOME probe output, NCA_API_URL / NCA_AGENT_ID
//   / NCA_TASK_NAME sprite exports, NCA_SHELL_ENV_START block markers,
//   __NCA_MISSING__ / __NCA_STORAGE_SEP__ sentinels) — sprite-fleet
//   compatibility contracts, tracked as legacy-inventory §9.
export const LEGACY_CONFIG_ALIASES: ReadonlyArray<{
    canonical: string
    aliases: readonly string[]
}> = [
    { canonical: 'MF_WEB_URL', aliases: ['NCA_WEB_URL', 'WEB_BASE_URL'] },
    { canonical: 'MF_ADMIN_URL', aliases: ['NCA_ADMIN_URL'] },
    { canonical: 'MF_AUTH_URL', aliases: ['NCA_AUTH_URL'] },
    {
        canonical: 'MF_DASHBOARD_COOKIE_DOMAIN',
        aliases: ['NCA_DASHBOARD_COOKIE_DOMAIN']
    },
    {
        canonical: 'MF_DASHBOARD_SIGNIN_URL',
        aliases: ['NCA_DASHBOARD_SIGNIN_URL']
    },
    { canonical: 'MF_API_INSTANCE_ID', aliases: ['NCA_API_INSTANCE_ID'] },
    { canonical: 'MF_FILES_DEBUG', aliases: ['NCA_FILES_DEBUG'] },
    { canonical: 'MF_VERSION', aliases: ['NCA_VERSION'] },
    {
        canonical: 'MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS',
        aliases: ['NCA_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS']
    }
]
