import type { PiCredentialsInput, PiProvider } from '@manyfold/shared'

export interface PiFieldsValue {
    provider: PiProvider
    apiKey: string
    baseUrl: string
    model: string
}

export const piInitial: PiFieldsValue = {
    provider: 'anthropic',
    apiKey: '',
    baseUrl: '',
    model: ''
}

export const piIsValid = (v: PiFieldsValue): boolean => v.apiKey.length >= 10

export const piToPayload = (v: PiFieldsValue): PiCredentialsInput => ({
    apiKey: v.apiKey,
    provider: v.provider,
    ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}),
    ...(v.model ? { model: v.model } : {})
})
