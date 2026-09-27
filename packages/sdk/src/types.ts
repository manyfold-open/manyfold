import type {
    AgentSummary,
    ExperimentAssignments,
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

// The agent as every surface reads it (ADR-0037): placement, host and
// availability are derived server-side and shipped on the summary.
export type SdkAgent = AgentSummary

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
