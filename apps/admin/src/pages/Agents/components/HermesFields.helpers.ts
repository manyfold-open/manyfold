import type {
    HermesCredentialsInput,
    HermesEmailConfig,
    HermesModelProvider
} from '@manyfold/shared'

export interface HermesTokenPlatformState {
    enabled: boolean
    token: string
}

export interface HermesEmailPlatformState {
    enabled: boolean
    host: string
    port: string
    user: string
    password: string
}

export interface HermesMatrixPlatformState {
    enabled: boolean
    homeserver: string
    accessToken: string
}

export interface HermesFieldsValue {
    primaryProvider: HermesModelProvider
    primaryApiKey: string
    primaryModelName: string
    primaryBaseUrl: string
    telegram: HermesTokenPlatformState
    discord: HermesTokenPlatformState
    slack: HermesTokenPlatformState
    whatsapp: HermesTokenPlatformState
    signal: HermesTokenPlatformState
    matrix: HermesMatrixPlatformState
    homeAssistant: HermesTokenPlatformState
    email: HermesEmailPlatformState
    profile: string
}

const emptyToken: HermesTokenPlatformState = { enabled: false, token: '' }

const emptyEmail: HermesEmailPlatformState = {
    enabled: false,
    host: '',
    port: '',
    user: '',
    password: ''
}

const emptyMatrix: HermesMatrixPlatformState = {
    enabled: false,
    homeserver: '',
    accessToken: ''
}

export const hermesInitial: HermesFieldsValue = {
    primaryProvider: 'openrouter',
    primaryApiKey: '',
    primaryModelName: '',
    primaryBaseUrl: '',
    telegram: emptyToken,
    discord: emptyToken,
    slack: emptyToken,
    whatsapp: emptyToken,
    signal: emptyToken,
    matrix: emptyMatrix,
    homeAssistant: emptyToken,
    email: emptyEmail,
    profile: ''
}

const parsePort = (raw: string): number | null => {
    if (!/^\d+$/.test(raw)) return null
    const n = Number(raw)
    return n >= 1 && n <= 65535 ? n : null
}

const tokenValid = (s: HermesTokenPlatformState): boolean =>
    s.token.length >= 10 && s.token.length <= 1024

const emailValid = (s: HermesEmailPlatformState): boolean =>
    s.host.length >= 1 &&
    s.host.length <= 255 &&
    parsePort(s.port) !== null &&
    s.user.length >= 1 &&
    s.user.length <= 255 &&
    s.password.length >= 1 &&
    s.password.length <= 1024

const matrixValid = (s: HermesMatrixPlatformState): boolean =>
    s.homeserver.length >= 1 &&
    s.homeserver.length <= 512 &&
    s.accessToken.length >= 10 &&
    s.accessToken.length <= 1024

export const hermesIsValid = (v: HermesFieldsValue): boolean => {
    if (v.primaryApiKey.length < 10) return false
    const tokens: Array<HermesTokenPlatformState> = [
        v.telegram,
        v.discord,
        v.slack,
        v.whatsapp,
        v.signal,
        v.homeAssistant
    ]
    const enabledTokens = tokens.filter((s) => s.enabled)
    const emailEnabled = v.email.enabled
    const matrixEnabled = v.matrix.enabled
    if (enabledTokens.length === 0 && !emailEnabled && !matrixEnabled)
        return false
    if (enabledTokens.some((s) => !tokenValid(s))) return false
    if (emailEnabled && !emailValid(v.email)) return false
    if (matrixEnabled && !matrixValid(v.matrix)) return false
    return true
}

export const hermesToPayload = (
    v: HermesFieldsValue
): HermesCredentialsInput => {
    const out: HermesCredentialsInput = {
        primaryModelApiKey: v.primaryApiKey,
        primaryModelProvider: v.primaryProvider
    }
    if (v.primaryModelName) out.primaryModelName = v.primaryModelName
    if (v.primaryBaseUrl) out.primaryModelBaseUrl = v.primaryBaseUrl
    if (v.telegram.enabled) out.telegramBotToken = v.telegram.token
    if (v.discord.enabled) out.discordBotToken = v.discord.token
    if (v.slack.enabled) out.slackAppToken = v.slack.token
    if (v.whatsapp.enabled) out.whatsappToken = v.whatsapp.token
    if (v.signal.enabled) out.signalToken = v.signal.token
    if (v.matrix.enabled) {
        out.matrixHomeserver = v.matrix.homeserver
        out.matrixAccessToken = v.matrix.accessToken
    }
    if (v.homeAssistant.enabled) out.homeAssistantToken = v.homeAssistant.token
    if (v.email.enabled) {
        const port = parsePort(v.email.port)
        if (port !== null) {
            const emailConfig: HermesEmailConfig = {
                host: v.email.host,
                port,
                user: v.email.user,
                password: v.email.password
            }
            out.emailConfig = emailConfig
        }
    }
    if (v.profile) out.profile = v.profile
    return out
}
