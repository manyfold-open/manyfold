import type { ClaudeCodeCredentialsInput } from '@manyfold/shared'

export interface ClaudeCodeFieldsValue {
    anthropicAuthToken: string
    anthropicBaseUrl: string
}

export const claudeCodeInitial: ClaudeCodeFieldsValue = {
    anthropicAuthToken: '',
    anthropicBaseUrl: ''
}

export const claudeCodeIsValid = (v: ClaudeCodeFieldsValue): boolean =>
    v.anthropicAuthToken.length >= 10

export const claudeCodeToPayload = (
    v: ClaudeCodeFieldsValue
): ClaudeCodeCredentialsInput => ({
    anthropicAuthToken: v.anthropicAuthToken,
    ...(v.anthropicBaseUrl ? { anthropicBaseUrl: v.anthropicBaseUrl } : {})
})
