import { protocolToOpenclawBrand } from '@manyfold/shared'
import { randomBytes } from 'node:crypto'
import type { ResolvedOpenclawCredentials } from '@/modules/agents/credentials/resolved-credentials'

export const OPENCLAW_PORT = 18789

export const openclawDefaultWorkspace = (
    mountPath: string,
    profile?: string | null
): string =>
    profile && profile !== 'default'
        ? `${mountPath}/workspace-${profile}`
        : `${mountPath}/workspace`

export interface OpenclawEnvOptions {
    creds: ResolvedOpenclawCredentials
    gatewayToken: string
    workspacePath: string
    controlUiEnabled: boolean
}

export const generateOpenclawGatewayToken = (
    existing?: string | null
): string => existing ?? randomBytes(32).toString('hex')

export type OpenclawWireApi = 'openai-completions' | 'anthropic-messages'

const DEFAULT_BASE_URL_FOR_PROVIDER: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    anthropic: 'https://api.anthropic.com/v1'
}

export const openclawWireApiFor = (
    provider: string | null | undefined
): OpenclawWireApi =>
    provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions'

export const canonicalizeOpenclawBaseUrl = (
    provider: string | null | undefined,
    explicit: string | null | undefined
): string => {
    const raw =
        explicit ?? (provider ? DEFAULT_BASE_URL_FOR_PROVIDER[provider] : null)
    if (!raw)
        throw new Error(
            `cannot resolve base_url for openclaw provider '${provider ?? ''}'`
        )
    const trimmed = raw.replace(/\/+$/, '')
    if (/\/v1$/.test(trimmed)) return trimmed
    return `${trimmed}/v1`
}

interface OpenclawConfigOptions {
    gatewayPort: number
    gatewayToken: string
    workspacePath: string
    controlUiEnabled: boolean
    bindHost: string
    providerBaseUrl: string
    providerApiKey: string
    wireApi: OpenclawWireApi
    modelName: string
}

/**
 * The full `~/.openclaw/openclaw.json` mirrors `docker/openclaw/entrypoint.sh`
 * in the K8s runtime — see `skills/nca-kb-openclaw/references/runtime-image.md`.
 *
 * The `gateway.http.endpoints.chatCompletions.enabled = true` flag is what
 * exposes the OpenAI-compatible HTTP `/v1/chat/completions` endpoint that the
 * chat adapter calls. Without it, `openclaw gateway` only serves the
 * WebSocket Gateway and the SPA Control UI, and the adapter sees 404.
 */
export const buildOpenclawConfigJson = (opts: OpenclawConfigOptions): string =>
    JSON.stringify(
        {
            gateway: {
                mode: 'local',
                port: opts.gatewayPort,
                bind: 'custom',
                customBindHost: opts.bindHost,
                auth: { mode: 'token', token: opts.gatewayToken },
                remote: { token: opts.gatewayToken },
                controlUi: {
                    enabled: opts.controlUiEnabled,
                    allowInsecureAuth: true,
                    allowedOrigins: ['*'],
                    dangerouslyDisableDeviceAuth: true
                },
                trustedProxies: ['127.0.0.1', '::1'],
                http: { endpoints: { chatCompletions: { enabled: true } } }
            },
            discovery: { mdns: { mode: 'off' } },
            tools: {
                profile: 'full',
                elevated: { enabled: true },
                exec: { host: 'gateway', security: 'full', ask: 'off' }
            },
            models: {
                mode: 'merge',
                providers: {
                    primary: {
                        baseUrl: opts.providerBaseUrl,
                        apiKey: opts.providerApiKey,
                        api: opts.wireApi,
                        models: [
                            { id: opts.modelName, name: opts.modelName }
                        ]
                    }
                }
            },
            agents: {
                defaults: {
                    sandbox: { mode: 'off' },
                    model: { primary: `primary/${opts.modelName}` },
                    workspace: opts.workspacePath,
                    timeoutSeconds: 180
                }
            }
        },
        null,
        2
    )

export const buildOpenclawEnv = (
    opts: OpenclawEnvOptions
): Record<string, string> => {
    const { creds, gatewayToken, workspacePath, controlUiEnabled } = opts
    const env: Record<string, string> = {
        OPENCLAW_GATEWAY_PORT: String(OPENCLAW_PORT),
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENCLAW_PRIMARY_MODEL_NAME: creds.primaryModelName,
        OPENCLAW_AGENT_WORKSPACE: workspacePath,
        OPENCLAW_CONTROL_UI_ENABLED: controlUiEnabled ? 'true' : 'false',
        NODE_OPTIONS: '--max-old-space-size=1536'
    }
    const brand = creds.inferenceProtocol
        ? protocolToOpenclawBrand(creds.inferenceProtocol)
        : (creds.modelProvider ?? null)
    if (brand) env.OPENCLAW_PRIMARY_MODEL_PROVIDER = brand
    if (creds.apiKey) env.OPENCLAW_PRIMARY_MODEL_API_KEY = creds.apiKey
    if (creds.baseUrl) env.OPENCLAW_PRIMARY_MODEL_BASE_URL = creds.baseUrl
    return env
}
