import { isConfigurableFramework, normalizeAgentName, stepsFor } from '@manyfold/shared'
import type {
    AddRuntimeAgentBody,
    AgentCreateStep,
    AgentFramework,
    AgentModelConfig,
    ClaudeCodeCredentialsInput,
    CodexCredentialsInput,
    CreateAgentBody,
    UpdateAgentCredentialsBody,
    GeminiCliCredentialsInput,
    UserModelProvider
} from '@manyfold/shared'
import type { ProviderPickerValue } from '@/pages/AgentNew/components/ProviderPicker'
import { normalizeProviderBaseUrl } from '@/lib/providerEndpoints'

export type CreateableFramework = AgentFramework
export type AgentCreateRuntimeMode = 'sandbox' | 'persistent'
export type AgentCredentialModelProvider = Extract<
    UserModelProvider,
    'anthropic' | 'openai' | 'google'
>
export type PersistentModelProvider = 'anthropic' | 'openai'

export interface CreateAgentDraft {
    framework: CreateableFramework
    name: string
    picker: ProviderPickerValue
    runtimeMode: AgentCreateRuntimeMode
    persistentModelProvider?: PersistentModelProvider
    primaryModelName?: string
    modelConfig?: AgentModelConfig
    restoreBackupId?: string
    workspace?: string
    frameworkVersion?: string
}

export const WORKSPACE_ABSOLUTE_PATH_ERROR =
    'Workspace directory must be an absolute path.'

export const workspaceValidationMessage = (
    workspace: string | null | undefined
): string | null => {
    const trimmed = workspace?.trim() ?? ''
    if (!trimmed) return null
    return trimmed.startsWith('/') ? null : WORKSPACE_ABSOLUTE_PATH_ERROR
}

export const optionalWorkspace = (
    workspace: string | null | undefined
): string | undefined => {
    const trimmed = workspace?.trim() ?? ''
    return trimmed || undefined
}

export const buildCreateAgentBody = (
    draft: CreateAgentDraft
): CreateAgentBody => {
    const explicitBaseUrl = normalizeProviderBaseUrl(draft.picker.baseUrl)
    const base: CreateAgentBody = {
        name: normalizeAgentName(draft.name),
        framework: draft.framework,
        runtime: draft.runtimeMode === 'persistent' ? 'k8s' : 'sprites'
    }

    // The CLI inside the runtime owns the credentials (subscription
    // sign-in): no credential block, no saveCredentialAs, no platform
    // modelConfig — the API's DTO guard enforces the same XOR.
    const runtimeLocal =
        draft.picker.mode === 'runtime' && isConfigurableFramework(draft.framework)

    if (runtimeLocal) {
        base.modelConfigSource = 'runtime-local'
    } else if (draft.framework === 'claude-code') {
        base.claudeCodeCredentials = buildClaudePayload(draft.picker)
    } else if (draft.framework === 'codex') {
        base.codexCredentials = buildCodexPayload(draft.picker)
    } else if (draft.framework === 'gemini-cli') {
        base.geminiCliCredentials = buildGeminiPayload(draft.picker)
    } else if (draft.framework === 'openclaw') {
        const provider = draft.persistentModelProvider ?? 'anthropic'
        base.openclawCredentials =
            draft.picker.mode === 'saved'
                ? {
                      providerId: draft.picker.providerId,
                      primaryModelName: trimOptional(draft.primaryModelName)
                  }
                : {
                      modelProvider: provider,
                      apiKey: draft.picker.apiKey,
                      primaryModelName: trimOptional(draft.primaryModelName),
                      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {})
                  }
    } else if (draft.framework === 'narranexus') {
        // NarraNexus manages providers via its native UI (deep-link). No
        // Manyfold-side credentials field — the resolver accepts empty value
        // and the bootstrap mints the gateway token internally.
    } else {
        const provider = draft.persistentModelProvider ?? 'anthropic'
        base.hermesCredentials =
            draft.picker.mode === 'saved'
                ? {
                      primaryProviderId: draft.picker.providerId,
                      primaryModelName: trimOptional(draft.primaryModelName)
                  }
                : {
                      primaryModelProvider: provider,
                      primaryModelApiKey: draft.picker.apiKey,
                      primaryModelName: trimOptional(draft.primaryModelName),
                      ...(explicitBaseUrl
                          ? { primaryModelBaseUrl: explicitBaseUrl }
                          : {})
                  }
    }

    if (
        draft.picker.mode === 'inline' &&
        draft.picker.save &&
        draft.picker.saveLabel
    ) {
        base.saveCredentialAs = { providerName: draft.picker.saveLabel }
    }
    if (draft.restoreBackupId) base.restoreBackupId = draft.restoreBackupId
    if (draft.modelConfig && !runtimeLocal) base.modelConfig = draft.modelConfig
    const workspace = optionalWorkspace(draft.workspace)
    if (workspace) base.workspace = workspace
    const frameworkVersion = draft.frameworkVersion?.trim()
    if (frameworkVersion) base.frameworkVersion = frameworkVersion
    return base
}

// The same per-framework payloads the create body carries, addressed at an
// agent that already exists: PATCH /agents/:id/credentials takes them verbatim,
// resolves the provider, rewrites the runtime's stored credential and rebinds
// the agent. Narranexus and the external frameworks are rejected there, so
// callers must not offer this for them.
export const buildAgentCredentialsBody = (draft: {
    framework: CreateableFramework
    picker: ProviderPickerValue
    persistentModelProvider?: PersistentModelProvider
    primaryModelName?: string
}): UpdateAgentCredentialsBody => {
    const explicitBaseUrl = normalizeProviderBaseUrl(draft.picker.baseUrl)
    const body: UpdateAgentCredentialsBody = {}
    if (draft.framework === 'claude-code')
        body.claudeCodeCredentials = buildClaudePayload(draft.picker)
    else if (draft.framework === 'codex')
        body.codexCredentials = buildCodexPayload(draft.picker)
    else if (draft.framework === 'gemini-cli')
        body.geminiCliCredentials = buildGeminiPayload(draft.picker)
    else if (draft.framework === 'openclaw')
        body.openclawCredentials =
            draft.picker.mode === 'saved'
                ? {
                      providerId: draft.picker.providerId,
                      primaryModelName: trimOptional(draft.primaryModelName)
                  }
                : {
                      modelProvider:
                          draft.persistentModelProvider ?? 'anthropic',
                      apiKey: draft.picker.apiKey,
                      primaryModelName: trimOptional(draft.primaryModelName),
                      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {})
                  }
    else
        body.hermesCredentials =
            draft.picker.mode === 'saved'
                ? {
                      primaryProviderId: draft.picker.providerId,
                      primaryModelName: trimOptional(draft.primaryModelName)
                  }
                : {
                      primaryModelProvider:
                          draft.persistentModelProvider ?? 'anthropic',
                      primaryModelApiKey: draft.picker.apiKey,
                      primaryModelName: trimOptional(draft.primaryModelName),
                      ...(explicitBaseUrl
                          ? { primaryModelBaseUrl: explicitBaseUrl }
                          : {})
                  }
    if (
        draft.picker.mode === 'inline' &&
        draft.picker.save &&
        draft.picker.saveLabel
    )
        body.saveCredentialAs = { providerName: draft.picker.saveLabel }
    return body
}

export const buildAddRuntimeAgentBody = (draft: {
    name: string
    workspace?: string
    cloneFrom?: string
    model?: string
}): AddRuntimeAgentBody => {
    const body: AddRuntimeAgentBody = {
        name: normalizeAgentName(draft.name)
    }
    const workspace = optionalWorkspace(draft.workspace)
    if (workspace) body.workspace = workspace
    const cloneFrom = draft.cloneFrom?.trim()
    if (cloneFrom) body.cloneFrom = cloneFrom
    // Omitted rather than sent empty: the runtime's own default is what an
    // absent model means to the attach service.
    const model = draft.model?.trim()
    if (model) body.model = model
    return body
}

export const progressStepsForCreate = (
    framework: CreateableFramework,
    runtimeMode: AgentCreateRuntimeMode
): AgentCreateStep[] =>
    stepsFor(framework, runtimeMode === 'persistent' ? 'k8s' : 'sprites')

export const modelProviderForFramework = (
    framework: CreateableFramework
): AgentCredentialModelProvider =>
    framework === 'codex'
        ? 'openai'
        : framework === 'gemini-cli'
          ? 'google'
          : 'anthropic'

export const apiKeyLabelForProvider = (
    provider: AgentCredentialModelProvider
): string =>
    provider === 'anthropic'
        ? 'Anthropic auth token'
        : provider === 'google'
          ? 'Gemini API key'
          : 'OpenAI API key'

export const createAgentCreateRequestKey = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `agent-create-${Date.now()}-${Math.random().toString(16).slice(2)}`

export const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException
        ? err.name === 'AbortError'
        : (err as Error | undefined)?.name === 'AbortError'

const buildClaudePayload = (
    p: ProviderPickerValue
): ClaudeCodeCredentialsInput => {
    if (p.mode === 'saved') return { providerId: p.providerId }
    const baseUrl = normalizeProviderBaseUrl(p.baseUrl)
    return {
        anthropicAuthToken: p.apiKey,
        ...(baseUrl ? { anthropicBaseUrl: baseUrl } : {})
    }
}

const buildCodexPayload = (p: ProviderPickerValue): CodexCredentialsInput => {
    if (p.mode === 'saved') return { providerId: p.providerId }
    const baseUrl = normalizeProviderBaseUrl(p.baseUrl)
    return {
        openaiApiKey: p.apiKey,
        ...(baseUrl ? { openaiBaseUrl: baseUrl } : {})
    }
}

const buildGeminiPayload = (
    p: ProviderPickerValue
): GeminiCliCredentialsInput => {
    if (p.mode === 'saved') return { providerId: p.providerId }
    const baseUrl = normalizeProviderBaseUrl(p.baseUrl)
    return {
        googleApiKey: p.apiKey,
        ...(baseUrl ? { googleGeminiBaseUrl: baseUrl } : {})
    }
}

const trimOptional = (value: string | undefined): string => (value ?? '').trim()
