import type {
    GeminiCliCredentialsInput,
    HermesCredentialsInput,
    HermesModelProvider,
    InferenceProtocol,
    OpenclawModelProvider
} from '@manyfold/shared'

export interface ResolvedClaudeCodeCredentials {
    anthropicAuthToken: string
    anthropicBaseUrl?: string
    inferenceProtocol?: InferenceProtocol
}

export interface ResolvedCodexCredentials {
    openaiApiKey: string
    openaiBaseUrl?: string
    inferenceProtocol?: InferenceProtocol
}

export type ResolvedGeminiCliCredentials = Required<
    Pick<GeminiCliCredentialsInput, 'googleApiKey'>
> &
    Pick<GeminiCliCredentialsInput, 'googleGeminiBaseUrl' | 'model'> & {
        inferenceProtocol?: InferenceProtocol
    }

export interface ResolvedOpenclawCredentials {
    modelProvider?: OpenclawModelProvider
    apiKey?: string
    primaryModelName: string
    baseUrl?: string
    gatewayToken?: string
    inferenceProtocol?: InferenceProtocol
}

export type ResolvedHermesCredentials = Omit<
    HermesCredentialsInput,
    'primaryModelApiKey' | 'primaryModelProvider' | 'primaryProviderId'
> & {
    primaryModelApiKey?: string
    primaryModelProvider?: HermesModelProvider
    inferenceProtocol?: InferenceProtocol
    // Generated when the sprite dashboard is first enabled; gates the
    // dashboard web server (HERMES_DASHBOARD_SESSION_TOKEN) and the front
    // proxy's HTML route. Typed here so credential edits (`...existing`
    // spreads) preserve it.
    dashboardToken?: string
}

export interface ResolvedExternalCredentials {
    providerId: string
}

// NarraNexus has no Manyfold-side BYO credentials. The container manages its
// own user_providers internally; users configure them via the native UI
// (fragment-auth deep link). Empty-object shape keeps the discriminated union
// exhaustive.
export type ResolvedNarraNexusCredentials = Record<string, never>

export type ResolvedAgentCredentials = {
    providerId: string | null
} & (
    | { framework: 'claude-code'; value: ResolvedClaudeCodeCredentials }
    | { framework: 'codex'; value: ResolvedCodexCredentials }
    | { framework: 'gemini-cli'; value: ResolvedGeminiCliCredentials }
    | { framework: 'openclaw'; value: ResolvedOpenclawCredentials }
    | { framework: 'hermes'; value: ResolvedHermesCredentials }
    | { framework: 'narranexus'; value: ResolvedNarraNexusCredentials }
    | { framework: 'dify'; value: ResolvedExternalCredentials }
    | { framework: 'langflow'; value: ResolvedExternalCredentials }
)
