import type {
    AgentFramework,
    ChatContentBlock,
    ChatRole
} from '@manyfold/shared'
import type { RawMessageSourcePayload } from '../../chat-adapter'
import type { RecoveryFs } from '../recovery-fs'
import type { CandidateIndexEntry } from './candidate-scan'
import type { CandidateScanCache } from './candidate-scan-cache'
import type { OpenclawRpcClient } from '@/modules/chat/adapters/openclaw-rpc-client'

export type RecoveredRawSource = RawMessageSourcePayload

export interface RecoveredMessage {
    externalId: string
    parentExternalId: string | null
    role: ChatRole
    contentBlocks: ChatContentBlock[]
    timestamp: string
    model?: string | null
    sources: RecoveredRawSource[]
}

export interface ReaderContext {
    fs: RecoveryFs
    agentId: string
    frameworkSessionRef: string
    openclawRpc?: OpenclawRpcClient | null
}

export interface RecoveryParentLink {
    sessionId: string
    endedAt: string | null
    endReason: string | null
}

export interface RecoverySummary {
    messageCount: number
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number | null
    parentChain: RecoveryParentLink[]
}

export interface ReaderResult {
    sourceFile: string | null
    messages: RecoveredMessage[]
    warnings: string[]
    summary?: RecoverySummary
}

export interface CandidateSession {
    sessionRef: string
    sourceFile: string
    firstUserMessage: string | null
    lastAssistantMessage: string | null
    timestamp: string | null
    lastActiveAt: string | null
    messageCount: number
    model: string | null
}

export interface CandidateListing {
    candidates: CandidateSession[]
    // Transcripts on the runtime before any limit, and how many of the newest
    // ones `candidates` accounts for (a file read but carrying no session id
    // still counts as listed).
    total: number
    listed: number
    // Every transcript whose session id is known without reading it, for
    // marking presence on the runtime beyond the listed page.
    filesByRef: Map<string, CandidateIndexEntry>
}

export interface CandidateContext {
    fs: RecoveryFs
    agentId: string
    openclawRpc?: OpenclawRpcClient | null
    limit?: number
    cache?: CandidateScanCache
}

export interface SessionReader {
    readonly framework: AgentFramework
    readMessages(ctx: ReaderContext): Promise<ReaderResult>
    listCandidates(ctx: CandidateContext): Promise<CandidateListing>
}
