import type {
    ChatContentBlock,
    ChatRole,
    ChatSessionChannelSummary
} from './chat'

export type AdminChatSessionStatus = 'running' | 'failed' | 'idle'

export interface AdminChatSessionError {
    code: string | null
    message: string | null
    retryable: boolean | null
}

export interface AdminChatSessionSummary {
    id: string
    title: string | null
    userId: string
    userEmail: string | null
    userDisplayName: string | null
    agentId: string
    agentName: string | null
    agentFramework: string | null
    agentRuntime: string | null
    channel: ChatSessionChannelSummary | null
    status: AdminChatSessionStatus
    inflightMessageId: string | null
    lastTurnState: string | null
    lastError: AdminChatSessionError | null
    messageCount: number
    lastMessageAt: string | null
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    frameworkSessionRef: string | null
    createdAt: string
    updatedAt: string
}

export interface AdminChatSessionsPage {
    items: AdminChatSessionSummary[]
    nextCursor: string | null
}

export interface AdminChatSessionTurnExecution {
    runtime: string
    state: string
    spriteName: string | null
    ownerId: string
    adoptCount: number
    leaseExpiresAt: string
    updatedAt: string
}

export interface AdminChatSessionTurn {
    messageId: string
    createdAt: string
    model: string | null
    inputTokens: number | null
    outputTokens: number | null
    costUsd: number | null
    firstTokenMs: number | null
    totalMs: number | null
    execution: AdminChatSessionTurnExecution | null
    error: AdminChatSessionError | null
    // Stream-log compaction evidence for this turn. Admin reads the live
    // stream rows, so without this a compacted turn and a turn that never
    // streamed much look identical. 0 / null is "never compacted", which is
    // what every turn written before the evidence columns existed truly is.
    compactedStreamRows: number
    streamCompactedAt: string | null
}

export interface AdminChatSessionDetail {
    session: AdminChatSessionSummary
    turns: AdminChatSessionTurn[]
    eventCounts: Record<string, number>
}

export interface AdminChatStreamEvent {
    id: string
    messageId: string
    seq: number
    eventType: string
    payloadJson: unknown
    runnerSeq: number | null
    createdAt: string
}

export interface AdminChatStreamEventsPage {
    items: AdminChatStreamEvent[]
    nextCursor: string | null
}

export interface AdminChatTurnMessage {
    id: string
    role: ChatRole
    contentBlocks: ChatContentBlock[]
    createdAt: string
}

export interface AdminChatSessionTurnDetail {
    turn: AdminChatSessionTurn
    // Everything sent to the agent for this turn: the messages between the
    // previous assistant turn and this one. Normally exactly one user
    // message; a recovered transcript can carry a system preamble or a short
    // user run. Empty is a real state and not a bug — retention deletes old
    // chat_messages rows, and it deletes them in batches, so a turn can
    // briefly outlive its own prompt.
    input: AdminChatTurnMessage[]
    // The assistant message's own blocks: what the user finally saw, after
    // any `replace`. Still empty while the turn streams, because the blocks
    // are written at the terminal event.
    result: AdminChatTurnMessage
}

export interface AdminChatSessionTurnsPage {
    items: AdminChatSessionTurnDetail[]
    nextBefore: string | null
}
