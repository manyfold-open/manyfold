import type { CodexCredentialsInput } from '@manyfold/shared'

export interface CodexFieldsValue {
    openaiApiKey: string
    openaiBaseUrl: string
}

export const codexInitial: CodexFieldsValue = {
    openaiApiKey: '',
    openaiBaseUrl: ''
}

export const codexIsValid = (v: CodexFieldsValue): boolean =>
    v.openaiApiKey.length >= 10

export const codexToPayload = (v: CodexFieldsValue): CodexCredentialsInput => ({
    openaiApiKey: v.openaiApiKey,
    ...(v.openaiBaseUrl ? { openaiBaseUrl: v.openaiBaseUrl } : {})
})
