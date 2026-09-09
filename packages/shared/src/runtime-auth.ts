import type { AgentFramework, AgentRuntime } from './constants'
import type { ConfigurableFramework } from './framework-catalog'
import { isObjectId } from './object-id'
import {
    runtimeAccountSupport,
    type RuntimeAccountIdentity,
    type RuntimeAccountProbe,
    type RuntimeAccountView
} from './runtime-account'

// Runtime auth profiles: several vendor sign-ins held on one host, each in
// its own credential context, selectable per agent. The API persists only
// safe metadata (identity fields, lifecycle, a generation counter); the host
// holds the credentials and is the authority for their state. Nothing in
// this contract carries a token, an API key or a host path.

export const RUNTIME_AUTH_METHODS = ['subscription', 'api-key'] as const
export type RuntimeAuthMethod = (typeof RUNTIME_AUTH_METHODS)[number]

export const RUNTIME_AUTH_LIFECYCLES = [
    'pending',
    'ready',
    'signed-out',
    'deleting',
    'deleted',
    'error'
] as const
export type RuntimeAuthLifecycle = (typeof RUNTIME_AUTH_LIFECYCLES)[number]

export const RUNTIME_AUTH_CREDENTIAL_STATUSES = [
    'unknown',
    'valid',
    'refresh-required',
    'reauth-required',
    'missing'
] as const
export type RuntimeAuthCredentialStatus =
    (typeof RUNTIME_AUTH_CREDENTIAL_STATUSES)[number]

export const RUNTIME_AUTH_OPERATION_KINDS = [
    'login',
    'logout',
    'remove'
] as const
export type RuntimeAuthOperationKind =
    (typeof RUNTIME_AUTH_OPERATION_KINDS)[number]

export const RUNTIME_AUTH_OPERATION_STATUSES = [
    'pending',
    'running',
    'succeeded',
    'failed',
    'cancelled'
] as const
export type RuntimeAuthOperationStatus =
    (typeof RUNTIME_AUTH_OPERATION_STATUSES)[number]

// Whether the vendor accepted a revocation. A local credential delete never
// claims the remote side revoked anything it did not confirm.
export type RuntimeAuthRevokeResult = 'revoked' | 'local-only' | 'unknown'

export const RUNTIME_AUTH_ERROR = {
    notFound: 'auth_profile_not_found',
    targetMismatch: 'auth_profile_target_mismatch',
    inUse: 'auth_profile_in_use',
    busy: 'auth_profile_busy',
    bindingConflict: 'auth_binding_conflict',
    missing: 'auth_profile_missing',
    reauthRequired: 'auth_reauth_required',
    contextUnsupported: 'auth_context_unsupported',
    daemonUpgradeRequired: 'daemon_upgrade_required',
    storeLocked: 'auth_store_locked',
    stateConflict: 'auth_state_conflict',
    operationTimeout: 'auth_operation_timeout',
    hostUnavailable: 'host_unavailable'
} as const
export type RuntimeAuthErrorCode =
    (typeof RUNTIME_AUTH_ERROR)[keyof typeof RUNTIME_AUTH_ERROR]

export const isRuntimeAuthProfileId = (value: unknown): value is string =>
    typeof value === 'string' && isObjectId(value, 'runtimeAuthProfile')

export const isRuntimeAuthOperationId = (value: unknown): value is string =>
    typeof value === 'string' && isObjectId(value, 'runtimeAuthOperation')

// Same support set as the ambient account probe: a coding CLI on a host we
// can reach without an agent (daemon machine or sandbox).
export const runtimeAuthSupported = (
    framework: string,
    kind: AgentRuntime
): boolean => runtimeAccountSupport(framework, kind) === 'ok'

export interface RuntimeAuthProfileView {
    id: string
    runtimeId: string
    framework: AgentFramework
    label: string
    authMethod: RuntimeAuthMethod
    lifecycle: RuntimeAuthLifecycle
    credentialStatus: RuntimeAuthCredentialStatus
    // Opaque monotonic counter the host bumps on login/logout/observed
    // refresh; cache keys and execution evidence, never a token hash.
    credentialGeneration: number
    identity: RuntimeAccountIdentity | null
    vendorUserId: string | null
    vendorAccountId: string | null
    checkedAt: string | null
    lastErrorCode: string | null
    agentCount: number
    isDefault: boolean
    createdAt: string
    updatedAt: string
}

export type RuntimeAuthAvailability =
    | 'ok'
    | 'daemon-offline'
    | 'daemon-upgrade-required'
    | 'sandbox-asleep'
    | 'host-unavailable'
    | 'unsupported'

export interface RuntimeAuthListView {
    runtimeId: string
    framework: AgentFramework
    kind: AgentRuntime
    availability: RuntimeAuthAvailability
    // `manage` = the host answers the auth.* RPCs; `execute` = it can run a
    // turn under a selected profile. Listing accounts never implies the
    // second.
    capabilities: { manage: boolean; execute: boolean }
    defaultProfileId: string | null
    // The host's native sign-in, read-only: not a managed profile.
    ambient: RuntimeAccountView | null
    profiles: RuntimeAuthProfileView[]
    error: string | null
}

export interface CreateRuntimeAuthProfileBody {
    label?: string
    authMethod: RuntimeAuthMethod
    requestId?: string
}

export interface RuntimeAuthOperationBody {
    requestId?: string
    wake?: boolean
}

export interface SetRuntimeDefaultAuthBody {
    profileId: string | null
}

export interface RuntimeAuthOperationView {
    id: string
    runtimeId: string
    profileId: string
    kind: RuntimeAuthOperationKind
    status: RuntimeAuthOperationStatus
    resultCode: string | null
    error: string | null
    revoke: RuntimeAuthRevokeResult | null
    deadlineAt: string | null
    createdAt: string
    updatedAt: string
}

// Ambient vendor auth variables an execution under a profile must not inherit:
// each of these outranks the CLI's own sign-in (Claude: env token > OAuth;
// Gemini: GEMINI_API_KEY > settings; Codex: env key when enabled), so leaving
// one in place would silently run another account. Only auth-related keys;
// unrelated connection secrets are untouched.
export const AMBIENT_VENDOR_AUTH_ENV = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_HOME',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_API_KEY',
    'GOOGLE_GEMINI_BASE_URL',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    'GEMINI_CLI_HOME'
] as const

// The non-secret environment that points a CLI at a profile's credential
// context (measured 2026-09-09 on claude 2.1.259 / codex 0.153.4 / gemini
// 0.58.0): CLAUDE_CONFIG_DIR also keys the macOS Keychain entry to the dir,
// CODEX_HOME holds auth.json, and Gemini needs the file backend forced because
// GEMINI_CLI_HOME alone leaves the OAuth Keychain entry shared. The view path
// stays stable per profile for exactly the Keychain reason.
export const runtimeAuthProfileEnv = (
    framework: ConfigurableFramework,
    viewDir: string,
    authMethod: RuntimeAuthMethod = 'subscription'
): Record<string, string> => {
    if (framework === 'claude-code') return { CLAUDE_CONFIG_DIR: viewDir }
    if (framework === 'codex') return { CODEX_HOME: viewDir }
    return {
        GEMINI_CLI_HOME: viewDir,
        GEMINI_FORCE_FILE_STORAGE: 'true',
        ...(authMethod === 'subscription'
            ? { GOOGLE_GENAI_USE_GCA: 'true' }
            : {})
    }
}

// ---- host (daemon) contract ------------------------------------------------
// Payloads name the profile by ids only; the host derives every path from its
// own config root and refuses ids that do not parse.

export interface DaemonAuthProfileRef {
    framework: ConfigurableFramework
    runtimeId: string
    profileId: string
}

export interface DaemonAuthListPayload {
    framework: ConfigurableFramework
    runtimeId: string
    // false = enumerate the store without reading credentials or calling the
    // vendor (cheap; used for existence checks).
    probe?: boolean
}

export interface DaemonAuthProfileReport {
    profileId: string
    present: boolean
    authMethod: RuntimeAuthMethod | null
    generation: number
    createdAt: string | null
    lastLoginAt: string | null
    probe: RuntimeAccountProbe | null
    error: string | null
}

export interface DaemonAuthListResponse {
    profiles: DaemonAuthProfileReport[]
    ambient: RuntimeAccountProbe | null
}

export interface DaemonAuthCreatePayload extends DaemonAuthProfileRef {
    authMethod: RuntimeAuthMethod
}

export interface DaemonAuthCreateResponse {
    profileId: string
    generation: number
    created: boolean
}

export interface DaemonAuthLogoutPayload extends DaemonAuthProfileRef {
    operationId: string
    // 'sign-out' keeps the profile store (metadata) and drops credentials;
    // 'remove' deletes the whole profile directory afterwards.
    mode: 'sign-out' | 'remove'
}

export interface DaemonAuthLogoutResponse {
    signedOut: boolean
    removed: boolean
    revoke: RuntimeAuthRevokeResult
    generation: number
    logoutError: string | null
}

export interface DaemonAuthOperationPayload {
    operationId: string
}

export interface DaemonAuthOperationRecord {
    operationId: string
    profileId: string
    kind: RuntimeAuthOperationKind
    status: RuntimeAuthOperationStatus
    resultCode: string | null
    error: string | null
    startedAt: string
    updatedAt: string
}

// `pty.open` runs the vendor sign-in as the shell's argv inside the profile's
// credential context when this field is present; the daemon composes both the
// argv and the environment, so no command or path crosses the wire.
export interface DaemonPtyAuthLogin extends DaemonAuthProfileRef {
    operationId: string
}
