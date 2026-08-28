import type {
    AgentFramework,
    AgentRuntime,
    AgentRuntimeStatus,
    AgentStatus,
    SpritesAccountStatus,
    UserRole
} from './constants'
import type { TokenCreatedVia } from './api-tokens'
import type { AgentModelConfig, AgentModelConfigSource } from './model-config'
import type { DetectedFramework } from './daemon'

export interface SdkUserSummary {
    id: string
    email: string
    role: UserRole
    planId: PlanId
    planName: string
    statefulSandboxLimit: number
    alwaysOnlineRuntimeBonus: number
    activeHoursBonus: number
    alwaysOnlineRuntimesUsed: number
    alwaysOnlineAgentsUsed: number
    statefulSandboxUsage: number
    monthlyModelSpendUsd: number | null
    monthlyApiRequests: number
    monthlyApiRequestLimit: number | null
    lastMessageToAgentAt: string | null
    createdAt: string
    updatedAt: string
}

export interface CliLoginStartBody {
    redirectUri?: string
    /**
     * @deprecated The device-code grant flow is retired: the API answers 410
     * with upgrade guidance whenever either field is present. Kept so
     * pre-removal CLI binaries parse cleanly; Phase 8 removes both.
     */
    requestedScopes?: string[]
    /** @deprecated See requestedScopes. */
    requestedAgentId?: string
}

export interface CliLoginStartResponse {
    requestId: string
    userCode: string
    authUrl: string
    expiresAt: string
    /**
     * @deprecated Only the retired grant flow ever set it; the API no longer
     * does. Phase 8 removes it.
     */
    deviceCode?: string
}

export interface CliLoginApproveBody {
    requestId: string
    userCode?: string
    approvedScopes?: string[]
}

export type CliLoginMode = 'browser' | 'grant'

export interface CliLoginApproveResponse {
    authCode: string | null
    redirectUrl: string | null
    expiresAt: string
    mode: CliLoginMode
}

export interface CliLoginExchangeBody {
    authCode: string
}

export interface CliLoginExchangeResponse {
    token: string
    expiresAt: string | null
}

/**
 * @deprecated The device-code grant flow is retired: /auth/cli/poll is a
 * tombstone that always answers 410 with upgrade guidance. Both types stay
 * only for that tombstone's signature; Phase 8 removes route and types.
 */
export interface CliLoginPollBody {
    deviceCode: string
}

/** @deprecated See CliLoginPollBody. */
export type CliLoginPollResponse =
    | { status: 'pending' }
    | {
          status: 'approved'
          token: string
          scopes: string[]
          userEmail: string | null
      }
    | { status: 'expired' }

export type CliLoginSessionStatus =
    | 'pending'
    | 'approved'
    | 'exchanged'
    | 'expired'

export interface CliLoginSessionResponse {
    requestId: string
    status: CliLoginSessionStatus
    expiresAt: string
    isGrantMode: boolean
    requestedScopes: string[] | null
    requestedAgent: { id: string; name: string } | null
    hasRedirect: boolean
}

export interface ConnectA2aStartBody {
    clientName: string
    clientUrl?: string
}

export interface ConnectA2aStartResponse {
    requestId: string
    userCode: string
    authUrl: string
    deviceCode: string
    expiresAt: string
}

export type ConnectA2aSessionStatus =
    | 'pending'
    | 'approved'
    | 'exchanged'
    | 'expired'
    | 'denied'

export interface ConnectA2aSessionResponse {
    clientName: string
    clientUrl: string | null
    status: ConnectA2aSessionStatus
    expiresAt: string
}

export interface ConnectA2aApproveBody {
    requestId: string
    userCode: string
    agentIds: string[]
    enableExposure?: boolean
    expiresInDays?: number
}

export interface ConnectA2aApproveResponse {
    status: 'approved'
    agentCount: number
}

export interface ConnectA2aPollBody {
    deviceCode: string
}

export interface ConnectA2aPollAgent {
    agentId: string
    name: string
    rpcUrl: string
    cardUrl: string
    token: string
    expiresAt: string | null
}

export type ConnectA2aPollResponse =
    | { status: 'pending' }
    | { status: 'denied' }
    | { status: 'expired' }
    | {
          status: 'approved'
          userEmail: string | null
          agents: ConnectA2aPollAgent[]
      }

export interface ConnectA2aDenyBody {
    requestId: string
    userCode: string
}

export interface ConnectA2aDenyResponse {
    status: 'denied'
}

export type AuthWhoamiResponse =
    | {
          kind: 'human-session' | 'human-api-token'
          userId: string
          email: string
          role: UserRole
      }
    | {
          kind: 'agent-runtime'
          userId: string
          agentId: string
      }
    | {
          kind: 'legacy-runtime'
          userId: string
          email: string
          role: UserRole
          agentId: string
          tokenId: string
          enforceAgentBinding: boolean
          createdVia: TokenCreatedVia | null
      }

// Plan ids are data, not a closed enum: the cloud edition seeds
// free/hobby/plus/pro, the self-hosted seed adds self_hosted, and operators
// may add their own rows.
export type PlanId = string

export interface Plan {
    id: PlanId
    name: string
    maxAgentsProvisioned: number
    maxConcurrentActive: number
    maxStorageGb: number
    monthlyActiveHoursIncluded: number | null
    maxAlwaysOnlineRuntimes: number
    maxAlwaysOnlineAgents: number
    maxChannels: number
    maxAutomations: number
    maxAutomationRunsMonthly: number | null
    messageHistoryRetentionDays: number | null
    monthlyApiRequestLimit: number | null
    // Absent on the open-source edition: pricing lives in the cloud-owned
    // cloud billing table (§4.2-b) and is layered in by the cloud modules.
    priceUsdMonthly?: string
}

// The window every usage meter in RuntimeAccessSummary is scoped to: the
// user's subscription billing period, or the UTC calendar month for free
// users. start/end are ISO instants; end is always set (start <= now < end).
export interface UsagePeriodSummary {
    start: string
    end: string
    source: 'subscription' | 'calendar'
}

export interface RuntimeAccessSummary {
    userId: string
    plan: Plan
    statefulSandboxLimit: number
    alwaysOnlineRuntimeBonus: number
    alwaysOnlineRuntimeLimit: number
    alwaysOnlineRuntimesUsed: number
    alwaysOnlineRuntimesRemaining: number
    alwaysOnlineAgentsLimit: number
    alwaysOnlineAgentsUsed: number
    alwaysOnlineAgentsRemaining: number
    persistentContainersUsed: number
    localDaemonsUsed: number
    cloudComputerEnabled: boolean
    statefulSandboxUsage: number
    statefulSandboxRemaining: number
    activeSandboxUsage: number
    activeSandboxRemaining: number
    storageBytesTotal: number
    usagePeriod: UsagePeriodSummary
    activeHoursThisPeriod: number | null
    // Effective included hours this period: plan hours + per-user bonus.
    // null = unlimited plan.
    activeHoursLimit: number | null
    activeHoursBonus: number
    channelsUsed: number
    automationsUsed: number
    automationRunsThisPeriod: number
    apiRequestsThisPeriod: number
    activeContainerSubscriptions: number
}

export interface UpdateUserRuntimeAccessBody {
    statefulSandboxLimit?: number
    alwaysOnlineRuntimeBonus?: number
    activeHoursBonus?: number
}

// Admin plan assignment. Self-hosted only: on the cloud edition a user's plan
// is owned by their subscription, so the route refuses rather than letting an
// admin desync the two.
export interface UpdateUserPlanBody {
    planId: PlanId
}

// Wire view of the api's UserDeletionStatus (ADR-0023): the same shape the
// service returns, with timestamps as the ISO strings JSON delivers.
export interface UserDeletionStatusView {
    id: string
    status:
        | 'awaiting_confirmation'
        | 'pending'
        | 'restored'
        | 'executed'
        | 'expired'
    requestedAt: string
    scheduledAt: string
    executedAt: string | null
    restoredAt: string | null
    reason: string | null
    lastError: { step: string; message: string; at: string } | null
}

export interface RequestUserDeletionBody {
    reason?: string
}

// Self-serve deletion (ADR-0023 §9.1). GET /me/deletion answers only while a
// confirmation is awaited — after T0 the user has no session, and terminal
// states read as "no active deletion" to the settings UI.
export interface MeDeletionAwaitingView {
    id: string
    status: 'awaiting_confirmation'
    requestedAt: string
    // When the emailed confirmation link stops working (request time + 24h).
    expiresAt: string
}

export interface ConfirmMeDeletionBody {
    token: string
}

export interface RestoreMeDeletionBody {
    token: string
}

export interface SandboxUsageAgentRow {
    agentId: string
    name: string
    framework: AgentFramework
    // du of this agent's own workspace dir; null until first measured.
    workspaceBytes: number | null
}

// A framework's config/home dir (~/.claude …) on the VM — shared by every
// agent of that framework on the host, so listed per host, not per agent.
export interface SandboxUsageHomeRow {
    framework: AgentFramework
    bytes: number
}

export interface SandboxUsageHost {
    hostId: string
    name: string
    spriteStatus: SpriteStatus | null
    activeSecondsThisPeriod: number
    // The whole-VM reading that feeds the storage meter (host sum); null until
    // first measured. workspace/home rows are the drill-down and generally sum
    // to less — the remainder is OS + tooling.
    storageBytes: number | null
    storageMeasuredAt: string | null
    // Whether storageBytes came from a real measurement of this host. False for
    // a host whose value was backfilled from its agents before the host-grain
    // migration, which has no drill-down to render. Not derivable from the rows
    // below: a bare sandbox is fully measured and still has none.
    storageMeasured: boolean
    homes: SandboxUsageHomeRow[]
    agents: SandboxUsageAgentRow[]
}

// Ledger rows whose host row is gone: their seconds still count toward the
// active-hours meter this period, so the breakdown must show them.
export interface SandboxUsageDeletedHost {
    hostId: string
    activeSecondsThisPeriod: number
}

export interface SandboxUsageBreakdown {
    usagePeriod: UsagePeriodSummary
    // == RuntimeAccessSummary.storageBytesTotal (same host filter + sum).
    storageBytesTotal: number
    // Raw seconds behind RuntimeAccessSummary.activeHoursThisPeriod.
    activeSecondsTotal: number
    hosts: SandboxUsageHost[]
    deletedHosts: SandboxUsageDeletedHost[]
}

export interface SpritesWholesaleCapSettings {
    activeCap: number
    softThresholdPct: number
}

export interface UpdateSpritesWholesaleCapSettingsBody {
    activeCap: number
    softThresholdPct: number
}

// What sprites.dev itself reports for one account, observed by the status-sync
// loop from the GET /sprites envelope. Limits are the vendor's hard ceilings;
// running/warm/cold are counted over the FULL paginated listing (the envelope's
// own running/warm/cold are page-scoped and must not be trusted).
export interface SpritesVendorAccountCapacity {
    accountId: string
    slug: string
    runningLimit: number | null
    warmLimit: number | null
    running: number
    warm: number
    cold: number
    observedAt: string
    stale: boolean
}

export interface SpritesVendorCapacityView {
    accounts: SpritesVendorAccountCapacity[]
    // Totals cover fresh observations only; null when no account reported a
    // limit, which is also when clamping disengages.
    runningLimitTotal: number | null
    warmLimitTotal: number | null
    runningTotal: number
    warmTotal: number
    coldTotal: number
    policyActiveCap: number
    effectiveActiveCap: number
    clamped: boolean
}

// Unauthenticated deployment feature discovery (GET /config/capabilities):
// which optional surfaces exist on this deployment, presence/availability
// only — never pricing, plans or entitlement. `edition` is informational,
// derived from what the running composition root wired.
export interface CapabilitiesResponse {
    edition: 'cloud' | 'self-hosted'
    features: Record<string, boolean>
    branding: {
        name: string
        webBaseUrl: string
    }
}

export type EmailProviderKind = 'console' | 'resend' | 'smtp'

export interface EmailProviderSettings {
    provider: EmailProviderKind
    resend: {
        from: string
        replyTo: string | null
        apiKeyMasked: string
    } | null
    smtp: {
        host: string
        port: number
        secure: boolean
        username: string | null
        from: string
        replyTo: string | null
        passwordMasked: string | null
    } | null
}

export interface UpdateEmailProviderSettingsBody {
    provider: EmailProviderKind
    resendApiKey?: string
    resendFrom?: string
    resendReplyTo?: string | null
    smtpHost?: string
    smtpPort?: number
    smtpSecure?: boolean
    smtpUsername?: string | null
    smtpPassword?: string
    smtpFrom?: string
    smtpReplyTo?: string | null
}

export interface SendTestEmailBody {
    to: string
}

export interface SendTestEmailResult {
    ok: boolean
    provider: EmailProviderKind
}

export interface BuiltinSkillRepoEntry {
    owner: string
    name: string
    branch: string
    enabled: boolean
}

export interface BuiltinSkillRepoInput {
    owner: string
    name: string
    branch?: string
    enabled?: boolean
}

export interface BuiltinSkillReposSettings {
    repos: BuiltinSkillRepoEntry[]
}

export interface UpdateBuiltinSkillReposSettingsBody {
    repos: BuiltinSkillRepoInput[]
}

export type LoginAuthProvider = 'native'

export type AuthIdentityProvider = 'oidc' | 'google' | 'email' | 'netmind'

export interface AuthIdentitySummary {
    provider: AuthIdentityProvider
    subject: string
    email: string
    createdAt: string
    // Present on 'email' identities only: whether a password is actually set.
    // An email identity can exist without one (auto-linked by OAuth sign-in).
    hasPassword?: boolean
}

export interface BindNetmindIdentityBody {
    loginToken: string
}

export interface ConnectNetmindModelProviderBody {
    loginToken: string
}

// --- NetMind account balance + recharge (finance domain) -------------------
// These proxy NetMind's billing host on behalf of a login-connected NetMind
// provider row. The loginToken travels in the NETMIND_TOKEN_HEADER, never in
// these bodies. Every field NetMind returns is optional, so the summary is
// null-safe end to end.



export interface SetAccountPasswordBody {
    password: string
    // Required when the account already has a password.
    currentPassword?: string
    // Required for the first password: the setup code mailed to the account's
    // sign-in address by /me/password/setup/start. A live session alone must
    // not be able to mint a sign-in credential.
    code?: string
}

export interface SetAccountPasswordStartResponse {
    ok: true
}

// Change-email is a verified atomic swap: the sign-in email is never left
// unbound. start re-authenticates and mails a code to the NEW address;
// verify consumes the code and swaps identity + primary email in one
// transaction.
export interface ChangeAccountEmailStartBody {
    newEmail: string
    // Re-auth for password holders. Only counts when the password predates
    // the current session (a password set mid-session proves nothing).
    currentPassword?: string
    // Re-auth minted by a Google link-mode round-trip (?reauth=... on the
    // Account page). Single-use, short-lived.
    reauthToken?: string
}

export interface ChangeAccountEmailVerifyBody {
    newEmail: string
    code: string
    // Required when the account has no password yet: the swap must not leave
    // a password-less account whose only OAuth email now differs from the
    // sign-in email.
    newPassword?: string
}

export interface ChangeAccountEmailStartResponse {
    ok: true
}

export interface UpdateAccountProfileBody {
    // null (or blank after trimming) clears the name back to the email.
    displayName: string | null
}

export interface AccountProfileSummary {
    displayName: string | null
    // Cache-buster for the avatar fetch; null = no custom avatar.
    avatarUpdatedAt: string | null
}

export interface NetmindLoginBody {
    loginToken: string
    firstTouchToken?: string
    lastTouchToken?: string
}

export type OidcTokenSource = 'access_token' | 'id_token'

// NetMind's login flow is browser-driven (the web talks to NetMind directly),
// so unlike Google/OIDC its endpoint values are exposed to the browser here.
// There is no secret — the user's NetMind loginToken is the credential.
export interface PublicNetmindConfig {
    authApi: string
    accountsUrl: string
    sysCode: string
    registerUrl: string
    keyProvision: boolean
}

export interface PublicNativeAuthConfig {
    provider: 'native'
    methods: {
        password: boolean
        google: boolean
        oidc: boolean
        netmind: boolean
    }
    emailVerificationRequired: boolean
    oidcButtonLabel: string | null
    netmind: PublicNetmindConfig | null
}

export type PublicAuthConfig =
    | {
          configured: false
      }
    | ({
          configured: true
      } & PublicNativeAuthConfig)

export interface LoginProviderSettings {
    configured: boolean
    provider: LoginAuthProvider | null
    password: {
        enabled: boolean
    }
    google: {
        enabled: boolean
        clientId: string
        hasClientSecret: boolean
    }
    oidc: {
        enabled: boolean
        authority: string
        clientId: string
        hasClientSecret: boolean
        audience: string | null
        scope: string
        tokenSource: OidcTokenSource
        jwksUrl: string | null
        userIdClaim: string
        emailClaim: string
        buttonLabel: string | null
    } | null
    netmind: {
        enabled: boolean
        authApi: string
        accountsUrl: string
        sysCode: string
        registerUrl: string
    } | null
    emailVerificationRequired: boolean
    initialAdminEmails: string[]
}

export interface UpdateLoginProviderSettingsBody {
    passwordEnabled: boolean
    emailVerificationRequired: boolean
    googleEnabled: boolean
    googleClientId?: string
    googleClientSecret?: string
    oidcEnabled: boolean
    oidcAuthority?: string
    oidcClientId?: string
    oidcClientSecret?: string
    oidcAudience?: string | null
    oidcScope?: string
    oidcTokenSource?: OidcTokenSource
    oidcJwksUrl?: string | null
    oidcUserIdClaim?: string
    oidcEmailClaim?: string
    oidcButtonLabel?: string | null
    netmindEnabled?: boolean
    netmindAuthApi?: string
    netmindAccountsUrl?: string
    netmindSysCode?: string
    netmindRegisterUrl?: string
    initialAdminEmails?: string[]
}

export interface AuthSetupBody extends UpdateLoginProviderSettingsBody {
    setupToken: string
    initialAdminEmails: string[]
    adminEmail: string
    adminPassword: string
}

export interface AuthRegisterBody {
    email: string
    password: string
    firstTouchToken?: string
    lastTouchToken?: string
}

export interface AuthLoginBody {
    email: string
    password: string
    firstTouchToken?: string
    lastTouchToken?: string
}

export interface AuthVerifyEmailBody {
    email: string
    code: string
    firstTouchToken?: string
    lastTouchToken?: string
}

export interface AuthResendCodeBody {
    email: string
}

export interface AuthForgotPasswordBody {
    email: string
}

export interface AuthResetPasswordBody {
    email: string
    code: string
    password: string
}

export interface AuthSessionUser {
    id: string
    email: string
    role: UserRole
}

export interface AuthSessionResponse {
    token: string
    user: AuthSessionUser
}

export interface AuthPendingVerificationResponse {
    pendingVerification: true
    email: string
}

export type AuthRegisterResponse =
    | AuthSessionResponse
    | AuthPendingVerificationResponse

export interface AuthOkResponse {
    ok: true
}

export type ExperimentAssignments = Record<string, string>

export interface SdkSpritesAccountSummary {
    id: string
    slug: string
    orgSlug: string
    status: SpritesAccountStatus
    priority: number
    notes: string | null
    activeSprites: number
    createdAt: string
    updatedAt: string
}


export type UserModelProvider =
    | 'anthropic'
    | 'openai'
    | 'openrouter'
    | 'google'
    | 'antigravity'
    | 'antigravity_claude'
export type ManagedUserModelProvider = Extract<
    UserModelProvider,
    'anthropic' | 'openai' | 'google' | 'antigravity' | 'antigravity_claude'
>
export type UserModelProviderSource = 'byo' | 'managed'
export const INFERENCE_PROTOCOLS = [
    'openai_chat_completions',
    'openai_responses',
    'anthropic_messages',
    'google_generate_content',
    'mistral_chat_completions'
] as const
export type InferenceProtocol = (typeof INFERENCE_PROTOCOLS)[number]

export type ProviderTestStatus = 'ok' | 'error'

export interface ProviderTestModel {
    id: string
    ownedBy?: string | null
}

export interface ProviderTestResult {
    ok: boolean
    status: ProviderTestStatus
    message?: string
    latencyMs: number
    models: ProviderTestModel[]
}

export interface ProviderTestInlineBody {
    inferenceProtocol: InferenceProtocol
    apiKey: string
    baseUrl: string
    modelsListUrl?: string | null
}

export type ProtocolModelMap = Record<string, string[]>

export interface UserModelProviderSummary {
    id: string
    inferenceProtocol: InferenceProtocol | null
    builtInId: string | null
    // NetMind userSystemCode for a login-connected NetMind provider (set at
    // provision time); null for manually-pasted keys. Gates the balance/recharge
    // UI — only login-connected rows can resolve a NetMind account's balance.
    externalAccountId: string | null
    providerName: string
    apiKeyMasked: string
    baseUrl: string | null
    modelsListUrl: string | null
    source: UserModelProviderSource
    // Opaque managed-supply tag; the cloud edition narrows it (§3.5).
    managedService: string | null
    managedKeyId: string | null
    managedBrand: ManagedUserModelProvider | null
    lastTestedAt: string | null
    lastTestStatus: ProviderTestStatus | null
    lastTestMessage: string | null
    lastTestModels: ProtocolModelMap | null
    enabledModels: ProtocolModelMap | null
    // Derived at read time (never stored): true for a managed row whose channel
    // an admin has switched off. The key still works — pickers hide it so users
    // stop binding new agents to a dead upstream.
    channelDisabled?: boolean
    createdAt: string
    updatedAt: string
}

export interface AdminUserModelProviderUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    eventCount: number
    lastUsedAt: string | null
}

export interface AdminUserModelProviderSummary extends UserModelProviderSummary {
    userId: string
    userEmail: string | null
    boundAgentCount: number
    usage: AdminUserModelProviderUsage
}

export interface CreateUserModelProviderBody {
    inferenceProtocol: InferenceProtocol
    providerName: string
    apiKey: string
    baseUrl: string
    modelsListUrl?: string
}

export interface UpdateUserModelProviderBody {
    providerName?: string
    inferenceProtocol?: InferenceProtocol
    apiKey?: string
    baseUrl?: string | null
    modelsListUrl?: string | null
    enabledModels?: ProtocolModelMap | null
}

export interface CreateBuiltInUserModelProviderBody {
    builtInId: string
    providerName?: string
    apiKey: string
}


export interface RevealUserModelProviderResponse {
    apiKey: string
}

// The decrypted secret behind a user connection (currently the Composio consumer
// key), returned only to the owning human/account on explicit reveal.
export interface RevealConnectionSecretResponse {
    apiKey: string
}

export type ExternalAgentProviderKind = 'dify' | 'langflow' | 'a2a'

export interface UserExternalAgentProviderSummary {
    id: string
    provider: ExternalAgentProviderKind
    label: string
    apiKeyMasked: string
    endpointUrl: string
    metadata: Record<string, unknown>
    lastTestedAt: string | null
    lastTestStatus: ProviderTestStatus | null
    lastTestMessage: string | null
    createdAt: string
    updatedAt: string
}

export interface RevealUserExternalAgentProviderResponse {
    apiKey: string
}

export interface ExternalProviderTestResult {
    ok: boolean
    status: ProviderTestStatus
    message: string
    models?: string[]
}

export interface ClaudeCodeCredentialsInput {
    anthropicAuthToken?: string
    anthropicBaseUrl?: string
    providerId?: string
}

export interface CodexCredentialsInput {
    openaiApiKey?: string
    openaiBaseUrl?: string
    providerId?: string
}

export interface GeminiCliCredentialsInput {
    googleApiKey?: string
    googleGeminiBaseUrl?: string
    model?: string | null
    providerId?: string
}

export type OpenclawModelProvider = 'anthropic' | 'openai' | 'openrouter'

export interface OpenclawCredentialsInput {
    modelProvider?: OpenclawModelProvider
    apiKey?: string
    primaryModelName: string
    baseUrl?: string
    gatewayToken?: string
    providerId?: string
}

export type HermesModelProvider = 'openrouter' | 'anthropic' | 'openai'

export interface HermesEmailConfig {
    host: string
    port: number
    user: string
    password: string
}

export interface HermesCredentialsInput {
    primaryModelApiKey?: string
    primaryModelProvider?: HermesModelProvider
    primaryProviderId?: string
    primaryModelName?: string | null
    primaryModelBaseUrl?: string
    telegramBotToken?: string
    discordBotToken?: string
    slackAppToken?: string
    whatsappToken?: string
    signalToken?: string
    matrixAccessToken?: string
    matrixHomeserver?: string
    emailConfig?: HermesEmailConfig
    homeAssistantToken?: string
    profile?: string
    apiServerKey?: string
}

export interface SaveCredentialAs {
    providerName: string
}

export interface AgentCredentialsExtras {
    model?: string | null
    primaryModelName?: string | null
    apiServerKey?: string | null
    gatewayToken?: string | null
    profile?: string | null
}

export interface AgentCredentialsSavedProviderRef {
    id: string
    providerName: string
}

export interface AgentCredentialsView {
    framework: AgentFramework
    provider: UserModelProvider | null
    apiKeyMasked: string | null
    baseUrl: string | null
    /**
     * Set when the agent's stored apiKey matches one of the user's saved model
     * providers (matched by full apiKey at view time). Lets the UI show "Using
     * saved provider X" instead of just an inline masked key.
     */
    savedProvider: AgentCredentialsSavedProviderRef | null
    extras: AgentCredentialsExtras
    unsupported?: boolean
    /**
     * True for daemon-runtime agents: runtime-local source still uses the
     * connected machine's CLI credentials. A daemon agent may also store an
     * optional platform provider here for Manyfold config source.
     */
    localManaged?: boolean
    updatedAt: string
}

export interface UpdateOpenclawCredentialsInput {
    modelProvider?: OpenclawModelProvider
    apiKey?: string
    primaryModelName?: string | null
    baseUrl?: string
    gatewayToken?: string
    providerId?: string
}

export interface UpdateAgentCredentialsBody {
    claudeCodeCredentials?: ClaudeCodeCredentialsInput
    codexCredentials?: CodexCredentialsInput
    geminiCliCredentials?: GeminiCliCredentialsInput
    openclawCredentials?: UpdateOpenclawCredentialsInput
    hermesCredentials?: HermesCredentialsInput
    saveCredentialAs?: SaveCredentialAs
}

export interface UpdateAgentBody {
    name?: string
    model?: string | null
    // Raw `.env`-format text of user-configured environment variables. Comments
    // and ordering are preserved; parsed for injection at runtime.
    envText?: string
    // Account-level GitHub / Cloudflare / Composio connections injected as
    // credentials at runtime. Pass null to clear the association; omit to leave
    // unchanged.
    githubConnectionId?: string | null
    cloudflareConnectionId?: string | null
    composioConnectionId?: string | null
    // Per-scope MCP server config, keyed by the framework's scope id
    // (user/project/global). Each value is the raw MCP-servers text in the
    // framework's native syntax; an empty string clears that scope. Only the
    // agent framework's supported scope ids are accepted.
    mcp?: Record<string, string>
}

export type ConnectionProvider = 'github' | 'cloudflare' | 'composio'

export type ConnectionKind =
    | 'github_app_installation'
    | 'cloudflare_api_token'
    | 'composio_consumer_key'

export interface UserConnectionSummary {
    id: string
    provider: ConnectionProvider
    kind: ConnectionKind
    displayName: string
    externalId: string | null
    // Provider page to view/edit this connection's authorization scope
    // (GitHub installation repos / Cloudflare token permissions).
    manageUrl: string | null
    createdAt: string
    updatedAt: string
}

export interface CloudflareAccountOption {
    id: string
    name: string
}

export interface CreateCloudflareConnectionBody {
    token: string
    name?: string
    // Required when the token can see more than one account.
    accountId?: string
}

export type CreateCloudflareConnectionResult =
    | { status: 'created'; connection: UserConnectionSummary }
    | { status: 'needs_account_selection'; accounts: CloudflareAccountOption[] }

export interface GithubConnectionStartResponse {
    installUrl: string
}

export interface CreateComposioConnectionBody {
    apiKey: string
    name?: string
}

export interface RenameConnectionBody {
    name: string
}

export interface GithubConnectionRepo {
    name: string
    fullName: string
    private: boolean
    htmlUrl: string
    defaultBranch: string
    pushedAt: string | null
}

export interface GithubConnectionReposResponse {
    // 'all' | 'selected' — whether the installation covers every repo or a
    // hand-picked set (mirrors GitHub's repository_selection).
    repositorySelection: string
    totalCount: number
    repos: GithubConnectionRepo[]
}

export interface CloudflareWorkerSummary {
    name: string
    modifiedOn: string | null
}

export interface CloudflarePagesProjectSummary {
    name: string
    domains: string[]
    latestDeployedAt: string | null
    productionBranch: string | null
}

// Workers/Pages listings degrade per-section: a token without the matching
// read permission yields 'forbidden' for that section instead of failing the
// whole response.
export type CloudflareResourceSection<T> =
    | { status: 'ok'; items: T[] }
    | { status: 'forbidden' }
    | { status: 'error' }

export interface CloudflareConnectionResourcesResponse {
    tokenStatus: 'active' | 'invalid'
    accountId: string
    accountName: string | null
    workers: CloudflareResourceSection<CloudflareWorkerSummary>
    pages: CloudflareResourceSection<CloudflarePagesProjectSummary>
}

export interface ComposioToolSummary {
    name: string
    description: string | null
}

export interface ComposioConnectionToolsResponse {
    tools: ComposioToolSummary[]
}

// A connection linked to a specific agent, rendered for the agent itself:
// which account and how to use it. `account` is the org/login (github) or
// account id (cloudflare); null for composio.
export interface AgentConnectionInfo {
    provider: ConnectionProvider
    displayName: string
    account: string | null
    usage: string
}

export interface AgentSelfConnectionsResponse {
    connections: AgentConnectionInfo[]
}

// State of the platform-managed AGENTS.manyfold.md in an agent's sprite
// workspace, for the agent-detail install/update card. Read from the DB record
// (written on install) so it works even when the sprite is asleep.
export interface AgentContextDocStatus {
    // False for non-sprite / non-coding frameworks (no doc is written for them).
    supported: boolean
    installed: boolean
    version: number | null
    generatedAt: string | null
    currentVersion: number
    upToDate: boolean
    // Install/Update writes into the workspace, which needs a live agent; false
    // ⇒ the button is disabled until the agent is started.
    agentRunning: boolean
}

export interface RevealAgentCredentialsResponse {
    apiKey: string
}

export interface DifyBindingInput {
    providerId: string
    appId?: string
    userIdentifier?: string
}

export interface LangflowBindingInput {
    providerId: string
    flowId: string
    tweaks?: Record<string, Record<string, unknown>>
}

export interface A2aBindingInput {
    providerId: string
    selectedSkillId?: string
}

export interface CreateAgentBody {
    name: string
    framework: AgentFramework
    runtime?: AgentRuntime
    accountId?: string
    sandboxId?: string
    frameworkVersion?: string
    clusterId?: string
    targetUserId?: string
    restoreBackupId?: string
    workspace?: string
    claudeCodeCredentials?: ClaudeCodeCredentialsInput
    codexCredentials?: CodexCredentialsInput
    geminiCliCredentials?: GeminiCliCredentialsInput
    openclawCredentials?: OpenclawCredentialsInput
    hermesCredentials?: HermesCredentialsInput
    difyBinding?: DifyBindingInput
    langflowBinding?: LangflowBindingInput
    a2aBinding?: A2aBindingInput
    modelConfigSource?: AgentModelConfigSource
    modelConfig?: AgentModelConfig
    saveCredentialAs?: SaveCredentialAs
}

export type K8sClusterHealthStatus = 'unknown' | 'ok' | 'failed'

export interface K8sClusterSummary {
    id: string
    name: string
    description: string | null
    hostSuffix: string | null
    region: string | null
    lastHealthStatus: K8sClusterHealthStatus
    lastHealthMessage: string | null
    lastHealthCheckedAt: string | null
    priority: number
    createdAt: string
    updatedAt: string
}

export interface UpsertK8sClusterBody {
    name: string
    description?: string
    hostSuffix?: string
    region?: string
    kubeconfig?: string
    priority?: number
}

export interface UpdateSpritesAccountBody {
    notes?: string | null
    priority?: number
}

export interface K8sClusterProbeResult {
    ok: boolean
    message: string
    checkedAt: string
}

export type AgentBackupStatus = 'running' | 'succeeded' | 'failed' | 'deleted'

export type AgentBackupRestoreStatus = 'running' | 'succeeded' | 'failed'
export type AgentBackupRestoreMode = 'replace'

export interface AgentBackupSummary {
    id: string
    userId: string
    sourceAgentId: string | null
    sourceAgentName: string
    framework: AgentFramework
    runtimeKind: AgentRuntime
    status: AgentBackupStatus
    objectKey: string
    archiveBytes: number
    workspaceBytes: number
    fileCount: number
    sha256: string | null
    errorMessage: string | null
    startedAt: string
    completedAt: string | null
    deletedAt: string | null
    createdAt: string
    updatedAt: string
}

export interface AgentBackupRestoreSummary {
    id: string
    userId: string
    backupId: string
    targetAgentId: string | null
    status: AgentBackupRestoreStatus
    mode: AgentBackupRestoreMode
    errorMessage: string | null
    startedAt: string
    completedAt: string | null
    createdAt: string
    updatedAt: string
}

export interface CreateAgentBackupResponse {
    backup: AgentBackupSummary
}

export interface RestoreAgentBackupBody {
    backupId: string
}

export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other'

export interface FsEntrySdk {
    name: string
    type: FsEntryType
    size: number
    mtime: number
    mode: string
}

export interface FsListResponse {
    entries: FsEntrySdk[]
}

export interface FsStatResponse extends FsEntrySdk {
    contentType: string
}

export interface FsOkResponse {
    ok: true
}

export const SKILL_FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli',
    'hermes'
] as const
export type SkillFramework = (typeof SKILL_FRAMEWORKS)[number]
export const isSkillFramework = (value: string): value is SkillFramework =>
    (SKILL_FRAMEWORKS as readonly string[]).includes(value)
export type InstalledSkillSource = 'nca' | 'library' | 'runtime'

export interface SkillRepoSummary {
    id: string
    owner: string
    name: string
    branch: string
    enabled: boolean
    readonly: boolean
    createdAt: string | null
    updatedAt: string | null
}

export interface DiscoverableSkillSummary {
    skillId: string
    name: string
    description: string | null
    repoOwner: string
    repoName: string
    repoBranch: string
    sourcePath: string
    latestRevision: string | null
    version: string | null
    readmeUrl: string | null
    installDir: string
    installed: boolean
    enabled: boolean
    userSkillId: string | null
    repoId: string
    repoReadonly: boolean
    category: CatalogCategoryRef | null
    tags: string[]
    featured: boolean
    updatedAt: string
    installCount: number
}

export interface DiscoverableSkillsPage {
    items: DiscoverableSkillSummary[]
    nextCursor: string | null
}

export interface SkillSecretRequirement {
    envVar: string | null
    prompt: string | null
    providerUrl: string | null
}

export interface SkillReadmeMeta {
    author: string | null
    license: string | null
    version: string | null
    platforms: string[]
    secrets: SkillSecretRequirement[]
}

// A skill can ship both its own SKILL.md (the canonical definition) and a
// README.md; the detail view lets the reader switch between whichever are
// present so they always know which file they are looking at.
export type SkillReadmeSource = 'skill' | 'readme'

export interface SkillReadmeDocument {
    source: SkillReadmeSource
    path: string
    content: string
    body: string
}

export interface SkillReadmeResponse {
    skillId: string
    revision: string | null
    // Primary document (SKILL.md when present, else README.md), kept flat for
    // callers that only render one document; `documents` carries every file
    // that was found, ordered SKILL.md first.
    path: string
    content: string
    body: string
    meta: SkillReadmeMeta
    documents: SkillReadmeDocument[]
}

export type SkillMaterializeStatus = 'installing' | 'installed' | 'failed'

export interface InstalledSkillSummary {
    id: string
    skillId: string
    agentId: string
    runtimeId: string
    source: InstalledSkillSource
    readonly: boolean
    name: string
    description: string | null
    framework: SkillFramework
    enabled: boolean
    // Runtime materialization state, distinct from `enabled` (the stored
    // intent): `installing` while the workspace copy is still being created,
    // `failed` with `materializeError` when it could not be, `installed` once
    // the skill is verified loadable in the workspace.
    materializeStatus: SkillMaterializeStatus
    materializeError: string | null
    installDir: string
    installedRevision: string | null
    installedVersion: string | null
    latestRevision: string | null
    repoOwner: string
    repoName: string
    repoBranch: string
    sourcePath: string
    readmeUrl: string | null
    createdAt: string
    updatedAt: string
}

export interface InstallSkillBody {
    skillId: string
    agentId: string
}

export interface InstallSkillBatchBody {
    skillId: string
    agentIds: string[]
}

export interface InstallSkillBatchResultItem {
    agentId: string
    status: 'installed' | 'failed'
    error?: string
    skill?: InstalledSkillSummary
}

export interface InstallSkillBatchResult {
    results: InstallSkillBatchResultItem[]
}

export interface PushLibrarySkillBody {
    agentIds?: string[]
}

export interface PushLibrarySkillResultItem {
    agentId: string
    status: 'pushed' | 'failed'
    error?: string
}

export interface PushLibrarySkillResult {
    results: PushLibrarySkillResultItem[]
}

export interface SkillTargetAgentSummary {
    id: string
    name: string
    framework: SkillFramework
    status: AgentStatus
    runtime: AgentRuntime
    runtimeId: string
    runtimeName: string
    runtimeKind: AgentRuntime
    runtimeStatus: AgentRuntimeStatus
}

export interface AgentSkillsGroup {
    agent: SkillTargetAgentSummary
    skills: InstalledSkillSummary[]
    inventoryError?: string
}

export interface UpdateUserSkillBody {
    enabled: boolean
}

export interface CreateSkillRepoBody {
    owner: string
    name: string
    branch?: string
}

export interface UpdateSkillRepoBody {
    branch?: string
    enabled?: boolean
}

export type LibrarySkillOriginType =
    | 'manual'
    | 'github'
    | 'archive'
    | 'catalog'
    | 'share'

export interface LibrarySkillOriginRef {
    type: LibrarySkillOriginType
    url?: string
    catalogSkillId?: string
    filename?: string
    shareId?: string
}

export interface LibrarySkillSummary {
    id: string
    name: string
    description: string | null
    origin: LibrarySkillOriginRef | null
    contentHash: string
    fileCount: number
    installedAgentCount: number
    createdAt: string
    updatedAt: string
}

export interface LibrarySkillFileDetail {
    id: string
    path: string
    content: string
}

export interface LibrarySkillDetail extends LibrarySkillSummary {
    content: string
    files: LibrarySkillFileDetail[]
}

export interface CreateLibrarySkillBody {
    name: string
    description?: string
    content?: string
}

export interface UpdateLibrarySkillBody {
    name?: string
    description?: string
    content?: string
}

export interface UpsertLibrarySkillFileBody {
    path: string
    content: string
}

export type LibrarySkillImportConflict = 'fail' | 'overwrite' | 'rename'

export interface ImportLibrarySkillBody {
    url?: string
    catalogSkillId?: string
    shareId?: string
    onConflict?: LibrarySkillImportConflict
}

export interface ImportLibrarySkillResult {
    status: 'created' | 'updated'
    skill: LibrarySkillDetail
}

export interface ShareLibrarySkillResult {
    id: string
    librarySkillId: string
    url: string
    importCount: number
    createdAt: string
}

export interface GetLibrarySkillShareResult {
    share: ShareLibrarySkillResult | null
}

export interface SharedSkillPreview {
    skill: {
        name: string
        description: string | null
        content: string
        files: { path: string }[]
        updatedAt: string
    }
    sharedBy: string | null
}

export type McpCatalogTransport = 'http' | 'stdio'
export type CatalogDomain = 'skill' | 'mcp'
export type CatalogSort = 'featured' | 'latest'

export interface CatalogCategoryRef {
    id: string
    name: string
}

export interface CatalogCategorySummary {
    id: string
    domain: CatalogDomain
    name: string
    sortOrder: number
    createdAt: string
    updatedAt: string
}

export interface CreateCatalogCategoryBody {
    domain: CatalogDomain
    name: string
    sortOrder?: number
}

export interface UpdateCatalogCategoryBody {
    name?: string
    sortOrder?: number
}

export interface McpCatalogEntry {
    // id is the entry slug (e.g. "context7"); it doubles as the MCP server
    // key merged into agent config, so it must stay stable per entry.
    id: string
    name: string
    description: string
    longDescription: string | null
    iconUrl: string | null
    homepageUrl: string
    transport: McpCatalogTransport
    url?: string
    // Header/env values may contain ${PLACEHOLDER} markers the user must fill.
    headers?: Record<string, string>
    command?: string
    args?: string[]
    env?: Record<string, string>
    tags: string[]
    category: CatalogCategoryRef | null
    featured: boolean
}

export interface McpCatalogPage {
    items: McpCatalogEntry[]
    nextCursor: string | null
}

export interface UserMcpServer {
    id: string
    serverKey: string
    name: string
    description: string | null
    transport: McpCatalogTransport
    url?: string
    headers?: Record<string, string>
    command?: string
    args?: string[]
    env?: Record<string, string>
    createdAt: string
    updatedAt: string
}

export interface CreateUserMcpServerBody {
    serverKey: string
    name: string
    description?: string
    transport: McpCatalogTransport
    url?: string
    headers?: Record<string, string>
    command?: string
    args?: string[]
    env?: Record<string, string>
}

export interface UpdateUserMcpServerBody {
    serverKey?: string
    name?: string
    description?: string | null
    transport?: McpCatalogTransport
    url?: string | null
    headers?: Record<string, string> | null
    command?: string | null
    args?: string[] | null
    env?: Record<string, string> | null
}

export interface AdminMcpCatalogEntry {
    id: string
    slug: string
    name: string
    description: string
    longDescription: string | null
    iconUrl: string | null
    homepageUrl: string
    transport: McpCatalogTransport
    url: string | null
    headers: Record<string, string> | null
    command: string | null
    args: string[] | null
    env: Record<string, string> | null
    tags: string[]
    categoryId: string | null
    featured: boolean
    sortOrder: number
    isActive: boolean
    createdAt: string
    updatedAt: string
}

export interface AdminMcpCatalogPage {
    items: AdminMcpCatalogEntry[]
    nextCursor: string | null
}

export interface CreateMcpCatalogEntryBody {
    slug: string
    name: string
    description: string
    homepageUrl: string
    transport: McpCatalogTransport
    url?: string
    headers?: Record<string, string>
    command?: string
    args?: string[]
    env?: Record<string, string>
    longDescription?: string
    iconUrl?: string
    tags?: string[]
    categoryId?: string | null
    featured?: boolean
    sortOrder?: number
    isActive?: boolean
}

export interface UpdateMcpCatalogEntryBody {
    slug?: string
    name?: string
    description?: string
    homepageUrl?: string
    transport?: McpCatalogTransport
    url?: string | null
    headers?: Record<string, string> | null
    command?: string | null
    args?: string[] | null
    env?: Record<string, string> | null
    longDescription?: string | null
    iconUrl?: string | null
    tags?: string[]
    categoryId?: string | null
    featured?: boolean
    sortOrder?: number
    isActive?: boolean
}

export interface AdminSkillCatalogItem {
    skillId: string
    name: string
    description: string | null
    repoOwner: string
    repoName: string
    repoBranch: string
    sourcePath: string
    latestRevision: string | null
    readmeUrl: string | null
    categoryId: string | null
    category: CatalogCategoryRef | null
    tags: string[]
    featured: boolean
    hidden: boolean
    createdAt: string
    updatedAt: string
}

export interface AdminSkillsCatalogPage {
    items: AdminSkillCatalogItem[]
    nextCursor: string | null
}

export interface UpdateSkillCurationBody {
    categoryId?: string | null
    tags?: string[]
    featured?: boolean
    hidden?: boolean
}

export type AutomationStatus = 'active' | 'paused'
export type AutomationSchedulePreset =
    | 'hourly'
    | 'daily'
    | 'weekdays'
    | 'weekly'
    | 'custom'
export type AutomationRunTrigger = 'manual' | 'scheduled'
export type AutomationRunStatus = 'running' | 'succeeded' | 'failed'

export interface AutomationAgentSummary {
    id: string
    name: string
    framework: AgentFramework
    status: AgentStatus
    model: string | null
}

export type AutomationDeliveryStatus =
    | 'sent'
    | 'queued'
    | 'failed'
    | 'suppressed'

// 'chat'/'user' address an explicit provider id (sendDirect-capable
// providers only); 'scope' addresses an existing channel conversation by
// its session scopeKey and works on every provider via sendText.
export type AutomationDeliveryTarget =
    | { kind: 'chat' | 'user'; id: string }
    | { kind: 'scope'; scopeKey: string }

export interface AutomationRunSummary {
    id: string
    automationId: string
    trigger: AutomationRunTrigger
    status: AutomationRunStatus
    chatSessionId: string | null
    assistantMessageId: string | null
    errorMessage: string | null
    // null = the automation has no channel delivery configured.
    deliveryStatus: AutomationDeliveryStatus | null
    // First line of the run's answer, snapshotted when the run finished. null
    // for runs that failed, are still running, or predate the snapshot.
    resultPreview: string | null
    startedAt: string
    finishedAt: string | null
    createdAt: string
}

export interface AutomationSummary {
    id: string
    userId: string
    agentId: string
    agent: AutomationAgentSummary
    title: string
    status: AutomationStatus
    schedulePreset: AutomationSchedulePreset
    rrule: string
    timezone: string
    dtstart: string
    model: string | null
    deliveryChannelId: string | null
    deliveryTarget: AutomationDeliveryTarget | null
    // True when the row mirrors an external framework object (a NarraNexus
    // job) and is read-only in Manyfold surfaces.
    managed: boolean
    nextRunAt: string | null
    lastRunAt: string | null
    // Status of the most recent run, so a list surface can show a failure
    // without loading run history. null = never ran.
    lastRunStatus: AutomationRunStatus | null
    createdAt: string
    updatedAt: string
}

export interface AutomationDetail extends AutomationSummary {
    prompt: string
    runs: AutomationRunSummary[]
}

export interface CreateAutomationBody {
    agentId: string
    title: string
    prompt: string
    schedulePreset: AutomationSchedulePreset
    rrule: string
    timezone: string
    dtstart?: string
    model?: string | null
    deliveryChannelId?: string | null
    deliveryTarget?: AutomationDeliveryTarget | null
}

export interface UpdateAutomationBody {
    agentId?: string
    title?: string
    prompt?: string
    status?: AutomationStatus
    schedulePreset?: AutomationSchedulePreset
    rrule?: string
    timezone?: string
    dtstart?: string
    model?: string | null
    deliveryChannelId?: string | null
    deliveryTarget?: AutomationDeliveryTarget | null
}

export type FileRootTransportSdk = 'dufs' | 'pod-exec'

// Absolute ceiling on any single upload, whatever the transport allows. Keeps a
// transport with no cap of its own from accepting unbounded request bodies.
export const FILES_UPLOAD_MAX_BYTES = 200 * 1024 * 1024

// What a client may assume about transferring bytes through this root. Sizes are
// absent when the transport has no byte cap of its own (it is still bounded by
// timeouts). `binarySafe` is per-host, not per-runtime: a daemon whose CLI
// predates binary writes reports false.
export interface FileRootCapabilitiesSdk {
    maxUploadBytes?: number
    maxDownloadBytes?: number
    streamRead: boolean
    streamWrite: boolean
    binarySafe: boolean
    atomicWrite: boolean
}

export interface FileRootSdk {
    id: string
    label: string
    path: string
    writable: boolean
    transport?: FileRootTransportSdk
    // always present on server responses; absent only on roots a client
    // synthesizes for itself, where "unknown" is the honest answer
    capabilities?: FileRootCapabilitiesSdk
}

export interface FsRootsResponse {
    roots: FileRootSdk[]
}

export type SpriteStatus = 'cold' | 'warm' | 'running'

export interface SpriteStatusUpdate {
    agentId: string
    spriteName: string | null
    spriteStatus: SpriteStatus | null
    k8sPodPhase: string | null
    at: string
}

// Host-level (sandbox VM) sprite lifecycle change. Agent-level updates only
// cover agent-bearing sprites; the sandbox detail panel keys on the host row,
// so it needs its own event to drop status polling.
export interface SpriteHostStatusUpdate {
    hostId: string
    spriteStatus: SpriteStatus | null
    at: string
}

export type QuotaWarningCode =
    | 'storage'
    | 'provisioned'
    | 'concurrent'
    | 'wholesale_soft'
    | 'active_hours'
    | 'channels'
    | 'automations'
    | 'automation_runs'
    | 'api_requests'

export type AgentStopStatus = 'pending' | 'noop'

export interface AgentKeepAliveRelease {
    state: 'not_applicable' | 'requested' | 'verified' | 'degraded'
    maxStaleSec: number
    message?: string
}

export interface AgentStopResponse {
    status: AgentStopStatus
    estimatedReadyInSec: number
    closedSessions: number
    keepAliveRelease?: AgentKeepAliveRelease
}

export interface SandboxQuotasOverview {
    wholesaleCap: number
    softThresholdPct: number
    orgActive: number
    orgWarm: number
    orgCold: number
    orgProvisioned: number
    orgStorageBytes: number
    softCap: number
}

export interface SandboxQuotaUserRow {
    userId: string
    email: string
    planId: string
    planName: string
    provisioned: number
    concurrentActive: number
    storageBytes: number
    lastActiveAt: string | null
    activeHoursThisPeriod: number
}

export interface SandboxQuotaUsersPage {
    users: SandboxQuotaUserRow[]
    nextCursor: string | null
}

export type SandboxQuotaTimeseriesRange = '24h' | '7d' | '30d'

export interface SandboxQuotaTimeseriesPoint {
    at: string
    orgActive: number
    orgWarm: number
    orgCold: number
    orgProvisioned: number
    orgStorageBytes: number
}

export interface SandboxQuotaTimeseriesResponse {
    range: SandboxQuotaTimeseriesRange
    points: SandboxQuotaTimeseriesPoint[]
}

export interface QuotaWarningEvent {
    type: 'quota-warning'
    code: QuotaWarningCode
    usage: number
    limit: number
    planName: string
    at: string
}

export type SpriteStatusEvent =
    | {
          type: 'snapshot'
          agents: SpriteStatusUpdate[]
          at: string
      }
    | ({ type: 'update' } & SpriteStatusUpdate)
    | ({ type: 'host-update' } & SpriteHostStatusUpdate)
    | QuotaWarningEvent

export interface AgentSummary {
    id: string
    userId: string
    runtimeId: string | null
    daemonId: string | null
    daemonNeedsUpgrade: boolean
    name: string
    framework: AgentFramework
    // Installed agent-framework CLI version, null until probed. latest +
    // upgradeAvailable are derived from the platform version catalog; populated
    // on the agent-detail path (list responses leave them null/false).
    frameworkVersion: string | null
    frameworkLatestVersion: string | null
    frameworkUpgradeAvailable: boolean
    // set when the installed CLI sits inside a blocked release window; carries
    // the operator-facing reason so the UI can say what to do about it
    frameworkVersionBlockedReason: string | null
    // mf CLI on the machine this agent runs on — the chat runner and the
    // manyfold-cli-usage skill both ride on it, so "which version, and is it
    // current" is a fact about the agent, not just about the host. Same
    // detail-only contract as the framework triple above; null reads as "not
    // detected" (never probed and not installed are indistinguishable here).
    cliVersion: string | null
    cliLatestVersion: string | null
    cliUpdateAvailable: boolean
    runtime: AgentRuntime
    status: AgentStatus
    spriteStatus: SpriteStatus | null
    k8sPodPhase: string | null
    accountSlug: string | null
    clusterId: string | null
    clusterName: string | null
    spriteName: string | null
    spriteId: string | null
    mountPath: string
    namespace: string | null
    ingressHost: string | null
    endpointUrl: string | null
    controlUiEnabled: boolean
    dashboardEnabled: boolean
    // Dashboard toggle progress: 'enabling@<ISO>' | 'disabling@<ISO>' |
    // 'error:<reason>' | null (steady). Sprite hermes toggles run async;
    // clients poll until this clears.
    dashboardState: string | null
    keepAliveEnabled: boolean
    currentPhase: string | null
    failureReason: string | null
    internalId: string
    model: string | null
    extras: Record<string, unknown>
    workspacePath: string | null
    storageBytes: number | null
    storageMeasuredAt: string | null
    startedAt: string | null
    lastActiveAt: string | null
    lastMessageAt: string | null
    lastBootstrappedAt: string | null
    lastReconciledAt: string | null
    createdAt: string
    updatedAt: string
}

export type FrameworkUpgradeStep =
    | 'validating'
    | 'stopping_service'
    | 'rebuilding'
    | 'starting_service'
    | 'verifying'

// NDJSON events streamed by the heavy (rebuild) framework-upgrade endpoint.
export type FrameworkUpgradeEvent =
    | { type: 'step'; step: FrameworkUpgradeStep }
    | { type: 'complete'; agent: AgentSummary }
    | { type: 'error'; step: FrameworkUpgradeStep | null; message: string }

export type AgentProbeStatus = 'ok' | 'warning' | 'failed' | 'skipped'

export type AgentStorageUsageKind = 'workspace' | 'config'

export interface AgentStorageUsageItem {
    kind: AgentStorageUsageKind
    label: string
    path: string | null
    exists: boolean
    bytes: number
    status: AgentProbeStatus
    message: string
}

export interface AgentStorageUsageResponse {
    agentId: string
    checkedAt: string
    items: AgentStorageUsageItem[]
    totalBytes: number
}

// Per-scope outcome of importing runtime MCP config files back into
// extras.mcp: `skipped` = file missing (stored value kept), `error` = file
// unreadable as MCP config (stored value kept, message says why).
export type AgentMcpScopeRefreshStatus =
    | 'imported'
    | 'unchanged'
    | 'skipped'
    | 'error'

export interface AgentMcpScopeRefreshResult {
    scopeId: string
    status: AgentMcpScopeRefreshStatus
    message?: string
}

export interface RefreshAgentMcpResponse {
    agent: AgentSummary
    scopes: AgentMcpScopeRefreshResult[]
}

// Outcome of one materialize (push) attempt per scope. `unchanged` means the
// file already matched; it is not persisted — only the last delivered /
// skipped / failed state matters across time.
export type AgentMcpDeliveryStatus =
    | 'delivered'
    | 'unchanged'
    | 'skipped'
    | 'failed'

export interface AgentMcpDeliveryScopeResult {
    scopeId: string
    status: AgentMcpDeliveryStatus
    message?: string
}

export interface MaterializeAgentMcpResponse {
    agent: AgentSummary
    scopes: AgentMcpDeliveryScopeResult[]
}

export interface SetControlUiBody {
    enabled: boolean
}

export interface AgentControlUiUrlResponse {
    url: string
}

export interface SetDashboardBody {
    enabled: boolean
}

export interface SetKeepAliveBody {
    enabled: boolean
}

export interface RenameBody {
    name: string
}

export type RuntimeServiceStatus = 'unknown' | 'starting' | 'ready' | 'stopped'

export interface AgentRuntimeSummary {
    id: string
    userId: string
    name: string
    framework: AgentFramework
    frameworkVersion: string | null
    kind: AgentRuntime
    status: AgentRuntimeStatus
    accountSlug: string | null
    clusterId: string | null
    clusterName: string | null
    spriteName: string | null
    spriteId: string | null
    hostId: string | null
    mountPath: string
    namespace: string | null
    ingressHost: string | null
    endpointUrl: string | null
    controlUiEnabled: boolean
    dashboardEnabled: boolean
    dashboardState: string | null
    keepAliveEnabled: boolean
    dashboardUrl: string | null
    currentPhase: string | null
    failureReason: string | null
    primaryAgentId: string | null
    startedAt: string | null
    lastBootstrappedAt: string | null
    createdAt: string
    updatedAt: string
    agentsCount: number
    daemonId: string | null
    daemonName: string | null
    daemonOnline: boolean | null
    daemonCliVersion: string | null
    homeDir: string | null
    workspaceBaseDir: string | null
    lastSeenAt: string | null
    serviceStatus: RuntimeServiceStatus
    serviceStatusAt: string | null
}

export interface SandboxSummary {
    id: string
    userId: string
    name: string
    accountSlug: string | null
    spriteName: string | null
    spriteStatus: SpriteStatus | null
    terminalEnabled: boolean
    agentsCount: number
    detectedFrameworks: DetectedFramework[]
    cliVersion: string | null
    latestCliVersion: string | null
    cliUpdateAvailable: boolean
    // Accrued `running` seconds for this sandbox in the OWNER's current usage
    // period (subscription billing period, or UTC calendar month for free
    // users). 0 when never active this period. Format for display via the
    // millisecond-based formatDuration(seconds * 1000).
    activeSecondsThisPeriod: number
    emptiedAt: string | null
    createdAt: string
    updatedAt: string
}

export type SandboxServiceStatus =
    | 'stopped'
    | 'starting'
    | 'running'
    | 'stopping'
    | 'failed'

// A sprites.dev managed service registered on a sandbox's sprite. `managed`
// flags Manyfold's own framework services (hermes/openclaw/narranexus), which
// are surfaced read-only and cannot be deleted from the host detail surface.
export interface SandboxServiceSummary {
    name: string
    command: string
    httpPort: number | null
    status: SandboxServiceStatus
    pid: number | null
    startedAt: string | null
    error: string | null
    managed: boolean
}

// A sprites.dev activity task (/v1/tasks) — a TTL lease that holds the sprite in
// the running state. The keep-alive toggle installs one of these (NOT a
// service). Platform keep-alive leases are managed via the keep-alive toggle;
// agent-registered tasks are deletable.
export interface SandboxTaskSummary {
    name: string
    startedAt: string | null
    expiresAt: string | null
    // True when this is a platform keep-alive lease (see isPlatformTaskName).
    keepAlive: boolean
}

// Result of the sandbox-wide stop: every wake cause removed in one action —
// per-agent stop (sessions, keep-alive, framework services), then non-managed
// services stopped, then agent-registered activity tasks deleted. Partial
// soft-failures (a service that refused to stop, a task that was
// re-registered) surface in `warnings`; transport failures throw instead.
// status 'noop' = the sandbox was not running, nothing to do.
export interface SandboxStopResponse {
    status: AgentStopStatus
    stoppedAgents: number
    stoppedServices: string[]
    deletedTasks: string[]
    estimatedReadyInSec: number
    warnings: string[]
}

// Installable mf CLI versions for the update pickers. `dev` is only
// populated in non-prod deploy envs (local/staging); prod returns it empty.
export interface CliVersionCatalog {
    stable: string[]
    dev: string[]
}

export interface CliUpgradeBody {
    targetVersion?: string
}

export interface CreateSandboxBody {
    name?: string
    accountId?: string
}

export interface SetSandboxTerminalBody {
    enabled: boolean
}

export interface FrameworkAgentSummary {
    id: string
    name: string
    workspace: string | null
    model: string | null
    extras: Record<string, unknown>
}

export interface AddRuntimeAgentBody {
    name: string
    workspace?: string
    model?: string
    cloneFrom?: string
}

export type NotificationProvider = 'slack' | 'discord' | 'lark' | 'telegram'

export type NotificationEventKey =
    | 'user.registered'
    | 'subscription.activated'
    | 'payment.credited'

export interface SdkNotificationWebhookSummary {
    id: string
    provider: NotificationProvider
    label: string
    enabled: boolean
    events: NotificationEventKey[]
    configMasked: Record<string, string>
    lastDeliveryAt: string | null
    lastErrorAt: string | null
    lastErrorMessage: string | null
    createdAt: string
    updatedAt: string
}

export interface CreateNotificationWebhookBody {
    provider: NotificationProvider
    label: string
    enabled?: boolean
    events: NotificationEventKey[]
    webhookUrl?: string
    larkSecret?: string
    botToken?: string
    chatId?: string
}

export interface UpdateNotificationWebhookBody {
    label?: string
    enabled?: boolean
    events?: NotificationEventKey[]
    webhookUrl?: string
    larkSecret?: string | null
    botToken?: string
    chatId?: string
}

export interface SendTestNotificationResult {
    ok: boolean
    provider: NotificationProvider
    message: string
}
