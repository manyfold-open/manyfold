import type { GeminiCliCredentialsInput } from '@manyfold/shared'

export interface GeminiCliFieldsValue {
    googleApiKey: string
    googleGeminiBaseUrl: string
}

export const geminiCliInitial: GeminiCliFieldsValue = {
    googleApiKey: '',
    googleGeminiBaseUrl: ''
}

export const geminiCliIsValid = (v: GeminiCliFieldsValue): boolean =>
    v.googleApiKey.length >= 10

export const geminiCliToPayload = (
    v: GeminiCliFieldsValue
): GeminiCliCredentialsInput => ({
    googleApiKey: v.googleApiKey,
    ...(v.googleGeminiBaseUrl
        ? { googleGeminiBaseUrl: v.googleGeminiBaseUrl }
        : {})
})
