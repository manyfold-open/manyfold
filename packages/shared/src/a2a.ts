import type { ChatUsage } from './usage'

export interface A2aExposure {
    enabled: boolean
    enabledAt?: string
    updatedAt?: string
    skillId?: string
    acceptedOutputModes?: string[]
}

export interface SetExposureBody {
    enabled: boolean
    skillId?: string
}

export interface SetA2aSelfExposureBody {
    enabled: boolean
}

export interface A2aSelfExposure extends A2aExposure {
    agentId: string
    cardUrl: string
    rpcUrl: string
}

export interface MintA2aGrantBody {
    callerAgentId?: string
    name?: string
    expiresInDays?: number
    replaceExisting?: boolean
}

export interface A2aGrantMintResponse {
    token: string
    tokenId: string
    scopes: string[]
    callerAgentId: string | null
    expiresAt: string | null
}

// Authorize several of your agents to call this target in one atomic request.
// Always caller-bound (no external token), so the response carries no plaintext
// — the bearers are minted per turn and injected, never handled by hand.
export interface MintA2aGrantsBody {
    callerAgentIds: string[]
    expiresInDays?: number
    replaceExisting?: boolean
}

export interface A2aGrantBatchResult {
    callerAgentId: string
    tokenId: string
    expiresAt: string | null
}

export interface A2aGrantBatchResponse {
    grants: A2aGrantBatchResult[]
}

export type AddA2aSelfCallerBody =
    | {
          kind: 'external'
          name?: string
          expiresInDays?: number
      }
    | {
          kind: 'peer'
          callerAgentId: string
          expiresInDays?: number
          replaceExisting?: boolean
      }

export type A2aSelfCallerAddResponse =
    | {
          kind: 'external'
          agentId: string
          token: string
          tokenId: string
          scopes: string[]
          callerAgentId: null
          expiresAt: string | null
          cardUrl: string
          rpcUrl: string
      }
    | {
          kind: 'peer'
          agentId: string
          callerAgentId: string
          tokenId: string
          expiresAt: string | null
      }

// Owner-facing summary of an outbound A2A grant: this agent (the caller) is
// authorized to delegate to `targetAgentId`. The mirror of A2aGrantSummary,
// resolved from the caller's side for the agent's own A2A tab.
export interface A2aOutboundGrantSummary {
    tokenId: string
    targetAgentId: string
    targetAgentName: string | null
    // The grant alone is not enough: the caller only sees this peer via
    // `mf a2a peers` once the target also exposes A2A. Surfaced so the owner
    // can tell a granted-but-unreachable target from a working one.
    targetExposed: boolean
    scopes: string[]
    createdAt: string
    expiresAt: string | null
    lastUsedAt: string | null
}

// Owner-facing summary of an active A2A grant on a target agent. The grant is
// the authorization policy ("callerAgentId may call this target"); the bearer
// the caller runtime actually uses is a short-lived per-turn token, never this.
export interface A2aGrantSummary {
    tokenId: string
    callerAgentId: string | null
    callerAgentName: string | null
    // Owner-supplied label, only meaningful for external clients (caller-bound
    // grants carry an auto-generated name). Lets the owner tell two external
    // tokens apart in the callers list before revoking one.
    name: string | null
    scopes: string[]
    createdAt: string
    expiresAt: string | null
    lastUsedAt: string | null
}

// A peer the bound agent may call, returned live by GET /agent-self/a2a/peers.
// No bearer here — the caller mints a short-lived one per call via the token
// endpoint, so the list itself stays safe to print.
export interface A2aSelfPeer {
    agentId: string
    name: string
    cardUrl: string
    rpcUrl: string
}

// A freshly minted short-lived bearer for one granted peer, returned by
// POST /agent-self/a2a/peers/:targetAgentId/token. Never print the token.
export interface A2aSelfPeerToken {
    token: string
    rpcUrl: string
    expiresAt: string
}

// Owner-facing task-trace row. `direction` is relative to the agent being
// viewed: `inbound` = it was the target, `outbound` = it was the caller.
export interface A2aTaskTraceItem {
    id: string
    direction: 'inbound' | 'outbound'
    state: string
    targetAgentId: string
    targetAgentName: string | null
    callerAgentId: string | null
    callerAgentName: string | null
    externalSubject: string | null
    contextId: string
    chatSessionId: string
    userMessageId: string | null
    assistantMessageId: string | null
    usage: ChatUsage | null
    errorMessage: string | null
    createdAt: string
    updatedAt: string
    completedAt: string | null
}

export interface A2aTaskTracePage {
    tasks: A2aTaskTraceItem[]
    nextCursor: string | null
}
