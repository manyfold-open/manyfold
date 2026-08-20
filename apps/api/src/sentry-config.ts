import {
    resolveDeploymentEnvironment,
    resolveServiceVersion
} from './otel-config'

type Env = Record<string, string | undefined>

export interface SentryConfig {
    dsn: string
    environment: string
    release: string
    tracesSampleRate: number
    enabled: boolean
    disabledReason: string | null
}

const resolveTracesSampleRate = (
    raw: string | undefined,
    environment: string
): number => {
    const fallback = environment === 'production' ? 0.25 : 1
    const trimmed = raw?.trim()
    if (!trimmed) return fallback
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(1, Math.max(0, parsed))
}

export const resolveSentryConfig = (env: Env = process.env): SentryConfig => {
    const dsn = env.SENTRY_DSN?.trim() ?? ''
    const environment = resolveDeploymentEnvironment(env)
    const release = `api@${resolveServiceVersion(env)}`
    const tracesSampleRate = resolveTracesSampleRate(
        env.SENTRY_TRACES_SAMPLE_RATE,
        environment
    )

    // Unlike Axiom there is no FLY_APP_NAME gate: a DSN is never present by
    // accident, and local runs need it to verify the integration end to end.
    if (!dsn) {
        return {
            dsn,
            environment,
            release,
            tracesSampleRate,
            enabled: false,
            disabledReason: 'SENTRY_DSN is empty'
        }
    }

    return {
        dsn,
        environment,
        release,
        tracesSampleRate,
        enabled: true,
        disabledReason: null
    }
}