const RETIRED_ENV_KEYS = [
    'NCA_WEB_URL',
    'WEB_BASE_URL',
    'NCA_ADMIN_URL',
    'NCA_DOCS_URL',
    'NCA_API_INSTANCE_ID',
    'NCA_FILES_DEBUG',
    'NCA_VERSION',
    'NCA_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS',
    'A2A_TURN_TIMEOUT_MS',
    'OPENCLAW_FETCH_TIMEOUT_MS'
]

export const validateApiEnv = (
    env: Record<string, unknown>
): Record<string, unknown> => {
    const retired = RETIRED_ENV_KEYS.filter(
        (key) => typeof env[key] === 'string' && env[key].trim().length > 0
    )
    if (retired.length)
        throw new Error(
            `Retired environment keys: ${retired.join(', ')}. Migrate to canonical configuration before upgrading.`
        )
    return env
}
