import apiPackage from '../package.json'

type Env = Record<string, string | undefined>

export interface OtelConfig {
    endpoint: string
    token: string
    dataset: string
    serviceName: string
    serviceVersion: string
    deploymentEnvironment: string
    enabled: boolean
    disabledReason: string | null
}

const nonEmpty = (value: string | undefined, fallback: string): string => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : fallback
}

export const resolveServiceVersion = (env: Env = process.env): string =>
    nonEmpty(env.MF_VERSION, nonEmpty(env.NCA_VERSION, apiPackage.version))

export const resolveDeploymentEnvironment = (env: Env = process.env): string =>
    nonEmpty(env.MF_DEPLOY_ENV, env.FLY_APP_NAME?.trim() || 'local')

export const resolveOtelConfig = (env: Env = process.env): OtelConfig => {
    const endpoint = nonEmpty(
        env.OTEL_EXPORTER_OTLP_ENDPOINT,
        'https://api.axiom.co'
    ).replace(/\/$/, '')
    const token = env.AXIOM_API_TOKEN?.trim() ?? ''
    const dataset = nonEmpty(env.AXIOM_DATASET, 'nca-otel')
    const serviceName = nonEmpty(env.OTEL_SERVICE_NAME, 'manyfold-api')
    const serviceVersion = resolveServiceVersion(env)
    const flyAppName = env.FLY_APP_NAME?.trim()
    const deploymentEnvironment = resolveDeploymentEnvironment(env)
    const isLocal = !flyAppName

    if (!token) {
        return {
            endpoint,
            token,
            dataset,
            serviceName,
            serviceVersion,
            deploymentEnvironment,
            enabled: false,
            disabledReason: 'AXIOM_API_TOKEN is empty'
        }
    }

    if (isLocal) {
        return {
            endpoint,
            token,
            dataset,
            serviceName,
            serviceVersion,
            deploymentEnvironment,
            enabled: false,
            disabledReason: 'local environment cannot export to Axiom'
        }
    }

    return {
        endpoint,
        token,
        dataset,
        serviceName,
        serviceVersion,
        deploymentEnvironment,
        enabled: true,
        disabledReason: null
    }
}
