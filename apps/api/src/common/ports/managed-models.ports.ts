import type {
    AgentFramework,
    AgentRuntime,
    InferenceProtocol,
    ModelPriceSource,
    ProviderTestModel,
    UserModelProvider
} from '@manyfold/shared'
import type { Database } from '@manyfold/db'
import type { ChatFailureCause } from '@/common/telemetry/chat-failure-taxonomy'

// Ports for the managed-models business (platform-provisioned sub2api /
// NetMind providers, their catalog, pricing and channel breaker). The
// implementations live in @/modules/managed-models — assembled only by the
// cloud composition root; the OSS defaults below are the "no managed
// business" behaviors: nothing to bootstrap, no price overrides, every
// channel admitted.

// ── managed model lifecycle + provider-surface seams ─────────────────────────

export const MANAGED_MODELS_PORT = Symbol('MANAGED_MODELS_PORT')

export interface ManagedModelsPort {
    // Signup/login side effects: provider bootstrap + signup credit. Fire and
    // forget from auth; failures are the adapter's to log, never to throw.
    onUserAuthenticated(input: {
        userId: string
        email: string
        newUser: boolean
    }): Promise<void>
    // NetMind-identity login/bind: background API-key provisioning.
    onNetmindLogin(input: {
        userId: string
        loginToken: string
        identity: { subject: string; email: string }
        trigger: 'login' | 'bind'
    }): Promise<void>
    // Managed default providers, ensured lazily when the provider list is
    // read.
    ensureDefaultProviders(input: {
        userId: string
        email: string
    }): Promise<void>
    // Whether the value names a managed channel brand (false on the open
    // default: no managed supply exists).
    isManagedBrand(value: string): boolean
    // Channels an admin has toggled off for NEW bindings (empty on the open
    // default). Existing keys keep working either way.
    disabledManagedChannels(): Promise<Set<UserModelProvider>>
    // Returns true when the id names a managed provider it deleted; false
    // lets the caller fall through to the BYO delete path.
    deleteManagedProvider(userId: string, id: string): Promise<boolean>
    // Group-scoped model list for a managed provider's connectivity test;
    // empty means "nothing to serve" and the caller falls back to probing.
    enabledModelsForTest(
        brand: UserModelProvider,
        context: { providerId: string }
    ): Promise<ProviderTestModel[]>
    // Flags the public auth config surfaces on the netmind block beyond the
    // login endpoints themselves (which stay admin-configured in core). The
    // open default has no managed supply, so every flag is off.
    netmindPublicFlags(): Promise<{ keyProvision: boolean }>
}

export const noManagedModelsPort: ManagedModelsPort = {
    isManagedBrand: () => false,
    disabledManagedChannels: async () => new Set<UserModelProvider>(),
    onUserAuthenticated: async () => undefined,
    onNetmindLogin: async () => undefined,
    ensureDefaultProviders: async () => undefined,
    deleteManagedProvider: async () => false,
    enabledModelsForTest: async () => [],
    netmindPublicFlags: async () => ({ keyProvision: false })
}

// ── managed pricing (chat metering hot path) ─────────────────────────────────

export const MANAGED_PRICING_PORT = Symbol('MANAGED_PRICING_PORT')

export interface ManagedPriceRow {
    modelId: string
    inputCostPerToken: string | null
    outputCostPerToken: string | null
    cacheReadCostPerToken: string | null
    cacheCreationCostPerToken: string | null
    priceRefSource: ModelPriceSource | null
    priceRefKey: string | null
}

export interface ManagedPricingPort {
    // Platform-wide price rows for managed models; merged with the core
    // scoped-model prices when the pricing engine (re)loads its config.
    loadManagedPriceRows(db: Database): Promise<ManagedPriceRow[]>
}

export const noManagedPricingPort: ManagedPricingPort = {
    loadManagedPriceRows: async () => []
}

// ── managed channel breaker (turn admission guard) ───────────────────────────

// The admission contract lives here, core-side, because chat and the
// credentials resolver consume it; the breaker in @/modules/managed-models
// implements it. Semantics:
// `pass` — the scope is closed; run the turn and let its outcome speak.
// `probe` — this turn WON the single half-open admission; its classified
//           outcome is what decides the scope, so it must report one.
// `fail_fast` — the scope is open (or its probe is taken); terminalize without
//           touching the upstream, and teach the breaker nothing.
export type ManagedChannelBreakerState = 'closed' | 'open' | 'half_open'

export type ManagedChannelBreakerDecision = 'pass' | 'probe' | 'fail_fast'

export type ManagedChannelInconclusiveReason =
    | Exclude<ChatFailureCause, 'account_pool_empty'>
    | 'cancelled'
    | 'unclassified'
    | 'unstructured_pool_empty'

export interface ManagedChannelAdmission {
    scope: string
    brand: UserModelProvider
    decision: ManagedChannelBreakerDecision
    // State the scope is in once this decision has been applied.
    state: ManagedChannelBreakerState
    retryAt: Date | null
    turnId: string
    protocol?: InferenceProtocol | null
    model?: string | null
    framework?: AgentFramework | null
    runtimeKind?: AgentRuntime | null
}

export interface ManagedChannelTurnFacts {
    brand: UserModelProvider | null
    protocol?: InferenceProtocol | null
    model?: string | null
    framework?: AgentFramework | null
    runtimeKind?: AgentRuntime | null
}

// Failure-code vocabulary shared with core chat/credential error paths; the
// channel definitions themselves (brands, supply) live cloud-side.
export const MANAGED_CHANNEL_UNAVAILABLE_CODE = 'managed_channel_unavailable'

export const MANAGED_CHANNEL_GUARD_PORT = Symbol('MANAGED_CHANNEL_GUARD_PORT')

export interface ManagedChannelGuardPort {
    // User-facing display name for a managed channel brand; null when the
    // brand is unknown (always, on the open default).
    channelLabel(brand: UserModelProvider | null | undefined): string | null
    admitTurn(
        facts: ManagedChannelTurnFacts,
        turnId: string
    ): Promise<ManagedChannelAdmission | null>
    ownedProbeAdmission(
        facts: ManagedChannelTurnFacts,
        turnId: string
    ): Promise<ManagedChannelAdmission | null>
    blockedScope(brand: UserModelProvider | null | undefined): Promise<{
        scope: string
        state: ManagedChannelBreakerState
        retryAt: Date | null
    } | null>
    recordSuccess(admission: ManagedChannelAdmission): Promise<void>
    recordPoolExhaustion(admission: ManagedChannelAdmission): Promise<void>
    recordInconclusive(
        admission: ManagedChannelAdmission,
        reason: ManagedChannelInconclusiveReason
    ): Promise<void>
}

export const openManagedChannelGuard: ManagedChannelGuardPort = {
    channelLabel: () => null,
    admitTurn: async () => null,
    ownedProbeAdmission: async () => null,
    blockedScope: async () => null,
    recordSuccess: async () => undefined,
    recordPoolExhaustion: async () => undefined,
    recordInconclusive: async () => undefined
}
