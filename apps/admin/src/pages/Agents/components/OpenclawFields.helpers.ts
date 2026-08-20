import type {
    OpenclawCredentialsInput,
    OpenclawModelProvider
} from '@manyfold/shared'

export interface OpenclawFieldsValue {
    modelProvider: OpenclawModelProvider
    apiKey: string
    primaryModelName: string
    baseUrl: string
}

export const openclawInitial: OpenclawFieldsValue = {
    modelProvider: 'anthropic',
    apiKey: '',
    primaryModelName: '',
    baseUrl: ''
}

export const openclawIsValid = (v: OpenclawFieldsValue): boolean =>
    v.apiKey.length >= 10 && v.primaryModelName.trim().length > 0

export const openclawToPayload = (
    v: OpenclawFieldsValue
): OpenclawCredentialsInput => ({
    modelProvider: v.modelProvider,
    apiKey: v.apiKey,
    primaryModelName: v.primaryModelName.trim(),
    ...(v.baseUrl ? { baseUrl: v.baseUrl } : {})
})
