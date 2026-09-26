import type { GeminiCliCredentialsInput } from '@manyfold/shared'

// agy's API-key mode takes Gemini CLI's key and endpoint, and a model of its
// own slugs (blank: agy's default).
export interface AntigravityCliFieldsValue {
    googleApiKey: string
    googleGeminiBaseUrl: string
    model: string
}

export const antigravityCliInitial: AntigravityCliFieldsValue = {
    googleApiKey: '',
    googleGeminiBaseUrl: '',
    model: ''
}

export const antigravityCliIsValid = (v: AntigravityCliFieldsValue): boolean =>
    v.googleApiKey.length >= 10

export const antigravityCliToPayload = (
    v: AntigravityCliFieldsValue
): GeminiCliCredentialsInput => ({
    googleApiKey: v.googleApiKey,
    ...(v.googleGeminiBaseUrl
        ? { googleGeminiBaseUrl: v.googleGeminiBaseUrl }
        : {}),
    ...(v.model ? { model: v.model } : {})
})
