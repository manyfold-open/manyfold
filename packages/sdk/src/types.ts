import type {
    AgentFramework,
    AgentRuntime,
    AgentStatus,
    ExperimentAssignments,
    SpriteStatus,
    UserRole
} from '@manyfold/shared'

export interface SdkUser {
    id: string
    email: string
    role: UserRole
    displayName?: string | null
    // Cache-buster for the avatar fetch; null/absent = no custom avatar.
    avatarUpdatedAt?: string | null
    experiments: ExperimentAssignments
}

export interface SdkAgent {
    id: string
    userId: string
    runtimeId: string | null
    daemonId: string | null
    daemonNeedsUpgrade: boolean
    name: string
    framework: AgentFramework
    frameworkVersion: string | null
    frameworkLatestVersion: string | null
    frameworkUpgradeAvailable: boolean
    frameworkVersionBlockedReason: string | null
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

export interface ClientOptions {
    baseUrl: string
    token?: string | (() => string | Promise<string>)
    fetch?: typeof fetch
    // When true, the client sends the account-scope header on every REST
    // request, opting a managed-agent runtime identity into account scope
    // (cross-agent / account-level reach, ADR-0010). The API still verifies the
    // granted scope + intra-user ownership — this is intent, not authorization.
    accountScope?: boolean
}
