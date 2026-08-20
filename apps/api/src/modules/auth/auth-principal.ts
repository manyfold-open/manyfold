import type {
    ApiTokenScope,
    AuthIdentityProvider,
    TokenCreatedVia
} from '@manyfold/shared'

export type AuthProvider = AuthIdentityProvider

// Discriminates how the principal authenticated. `kind` is REQUIRED — each arm
// of the union below carries only the fields that kind actually has, so an
// agent-runtime principal can never be read for token scopes or enforcement.
interface AuthPrincipalBase {
    userId: string
    email?: string
    matchedScopes?: ApiTokenScope[]
    // Set by the guard when an agent-runtime request opts into account scope
    // (ADR-0010) and clears the scope + intra-user checks. Transient, per
    // request — never persisted. Read by boundAgentIdFromUser to widen list
    // endpoints from own-agent to account-wide.
    accountScope?: boolean
}

export type AuthPrincipal = AuthPrincipalBase &
    (
        | {
              kind: 'human-session'
              provider: AuthProvider | 'api-token'
              subject: string
              // The session row behind this request. Password set/change
              // revokes every OTHER session, so the caller must be
              // identifiable to survive its own revocation sweep.
              sessionId?: string
              // When the session row was minted. Change-email uses it to
              // reject a password created mid-session as re-auth proof.
              sessionCreatedAt?: Date
          }
        | { kind: 'human-api-token'; tokenId: string; scopes: ApiTokenScope[] }
        | { kind: 'agent-runtime'; agentId: string; runtimeTokenId: string }
        | {
              kind: 'legacy-runtime'
              agentId: string
              tokenId: string
              scopes: ApiTokenScope[]
              callerAgentId: string | null
              enforceAgentBinding: boolean
              createdVia: TokenCreatedVia | null
              // Present on principals resolved by current ApiTokenService.
              // Optional keeps older in-process adapters/tests structurally
              // compatible while authorization can distinguish caller grants
              // from real runtime/user-grant credentials.
              tokenKind?:
                  | 'user-grant'
                  | 'a2a-grant'
                  | 'a2a-ephemeral'
                  | 'terminal'
          }
    )

// The caller agent's identity, derived from the token alone — set whenever the
// token belongs to an agent runtime, regardless of enforce_agent_binding. This
// is identity, not boundary: use it to resolve "which agent is calling".
export const runtimeAgentId = (auth: AuthPrincipal): string | undefined =>
    principalAgentId(auth)

// The agent a token belongs to (agent-runtime + legacy-runtime), else undefined.
// Centralizes the narrowing so call sites never re-derive it from raw fields.
export const principalAgentId = (auth: AuthPrincipal): string | undefined =>
    auth.kind === 'agent-runtime' || auth.kind === 'legacy-runtime'
        ? auth.agentId
        : undefined

// The token scopes carried by the principal (human-api-token + legacy-runtime),
// else []. agent-runtime authorizes from agent_permissions, never token scopes.
export const principalScopes = (auth: AuthPrincipal): ApiTokenScope[] =>
    auth.kind === 'human-api-token' || auth.kind === 'legacy-runtime'
        ? auth.scopes
        : []

export interface LinkedAuthIdentity {
    provider: AuthIdentityProvider
    subject: string
    email?: string
    sourceEmail?: string | null
}

export interface ExternalAuthIdentity {
    provider: AuthProvider
    subject: string
    email: string
    // Provider-asserted human name. Seed-only: written once when the account
    // is created, never synced on later sign-ins.
    displayName?: string
    linkedIdentities?: LinkedAuthIdentity[]
}
