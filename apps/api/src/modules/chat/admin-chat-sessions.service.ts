import { isObjectId } from '@manyfold/shared'
import type {
    AdminChatSessionDetail,
    AdminChatSessionError,
    AdminChatSessionStatus,
    AdminChatSessionSummary,
    AdminChatSessionTurn,
    AdminChatSessionTurnDetail,
    AdminChatSessionTurnsPage,
    AdminChatSessionsPage,
    AdminChatStreamEvent,
    AdminChatStreamEventsPage,
    AdminChatTurnMessage,
    ChatContentBlock,
    ChatRole,
    ChatSessionChannelSummary
} from '@manyfold/shared'
import {
    BadRequestException,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import type {
    AgentUsageEventRow,
    ChatMessage as DbChatMessage,
    TurnExecutionRow
} from '@manyfold/db'
import {
    ChatRepository,
    type AdminSessionCursor,
    type AdminSessionRow,
    type MessageCursor
} from './chat.repository'
import { decodeMessageCursor, encodeMessageCursor } from './message-page'

const TURNS_LIMIT = 100

const encodeSessionCursor = (updatedAt: Date, id: string): string =>
    Buffer.from(`${updatedAt.toISOString()}|${id}`).toString('base64url')

const decodeSessionCursor = (cursor: string): AdminSessionCursor => {
    try {
        const raw = Buffer.from(cursor, 'base64url').toString('utf8')
        const split = raw.indexOf('|')
        const iso = split < 0 ? '' : raw.slice(0, split)
        const id = split < 0 ? '' : raw.slice(split + 1)
        const updatedAt = new Date(iso)
        if (!iso || !id || Number.isNaN(updatedAt.getTime()))
            throw new Error('malformed')
        return { updatedAt, id }
    } catch {
        throw new BadRequestException('Invalid cursor')
    }
}

const errorFromPayload = (
    payload: Record<string, unknown> | undefined
): AdminChatSessionError | null => {
    if (!payload) return null
    const error = payload.error
    if (!error || typeof error !== 'object') return null
    const fields = error as Record<string, unknown>
    return {
        code: typeof fields.code === 'string' ? fields.code : null,
        message: typeof fields.message === 'string' ? fields.message : null,
        retryable:
            typeof fields.retryable === 'boolean' ? fields.retryable : null
    }
}

const messageCursor = (row: DbChatMessage): MessageCursor => ({
    createdAt: row.createdAt,
    id: row.id
})

const isBefore = (a: MessageCursor, b: MessageCursor): boolean => {
    const left = a.createdAt.getTime()
    const right = b.createdAt.getTime()
    return left === right ? a.id < b.id : left < right
}

const toTurnMessage = (row: DbChatMessage): AdminChatTurnMessage => ({
    id: row.id,
    role: row.role as ChatRole,
    contentBlocks: (row.contentBlocksJson as ChatContentBlock[]) ?? [],
    createdAt: row.createdAt.toISOString()
})

const toExecution = (
    row: TurnExecutionRow
): AdminChatSessionTurn['execution'] => ({
    runtime: row.runtime,
    state: row.state,
    spriteName: row.spriteName,
    ownerId: row.ownerId,
    adoptCount: row.adoptCount,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class AdminChatSessionsService {
    constructor(private readonly repo: ChatRepository) {}

    async list(opts: {
        limit: number
        cursor: string | null
        agentId: string | null
        userId: string | null
        running: boolean
        hasError: boolean
        q: string | null
    }): Promise<AdminChatSessionsPage> {
        const after = opts.cursor ? decodeSessionCursor(opts.cursor) : null
        const exactId = opts.q && isObjectId(opts.q, 'chatSession')
        const rows = await this.repo.listAdminSessionsPage({
            limit: opts.limit + 1,
            after,
            agentId: opts.agentId,
            userId: opts.userId,
            running: opts.running,
            hasError: opts.hasError,
            idEquals: exactId ? opts.q : null,
            titleQuery: exactId ? null : opts.q
        })
        const page = rows.slice(0, opts.limit)
        const last = page[page.length - 1]
        const nextCursor =
            rows.length > opts.limit && last
                ? encodeSessionCursor(last.session.updatedAt, last.session.id)
                : null
        return { items: await this.enrich(page), nextCursor }
    }

    async get(sessionId: string): Promise<AdminChatSessionDetail> {
        const [summary] = await this.enrich(
            await this.requireSessionRow(sessionId)
        )
        if (!summary) throw new NotFoundException('Session not found')

        const turnRows = await this.repo.listAssistantTurnsWithUsage(
            sessionId,
            { limit: TURNS_LIMIT }
        )
        const [turns, eventCounts] = await Promise.all([
            this.buildTurns(turnRows),
            this.repo.countSessionEventsByType(sessionId)
        ])

        return { session: summary, turns, eventCounts }
    }

    // The transcript half of the same turns `get` reports on: each assistant
    // message paired with what was sent to produce it. Kept off `get` because
    // that response carries up to TURNS_LIMIT turns and a coding turn's
    // content blocks run to tens of kilobytes.
    async listTurns(
        sessionId: string,
        opts: { limit: number; before: string | null }
    ): Promise<AdminChatSessionTurnsPage> {
        const session = await this.repo.getSessionById(sessionId)
        if (!session) throw new NotFoundException('Session not found')
        const before = opts.before ? decodeMessageCursor(opts.before) : null
        const rows = await this.repo.listAssistantTurnsWithUsage(sessionId, {
            limit: opts.limit + 1,
            before
        })
        const hasMore = rows.length > opts.limit
        const page = hasMore ? rows.slice(0, opts.limit) : rows
        const newest = page[0]
        const oldest = page[page.length - 1]
        if (!newest || !oldest) return { items: [], nextBefore: null }

        // Row [limit] of the over-fetch IS the assistant message before the
        // oldest turn on this page, so the inputs query needs no extra
        // lookup for its lower bound. Its absence means this page reaches the
        // session's first turn, whose interval opens at the session start.
        const inputRows = await this.repo.listTurnInputMessages(sessionId, {
            after: hasMore ? messageCursor(rows[opts.limit].message) : null,
            before: messageCursor(newest.message)
        })

        // Both sides ascending, so one pointer assigns every input to the
        // oldest turn that is still newer than it.
        const ascending = [...page].reverse()
        const turns = await this.buildTurns(ascending)
        const items: AdminChatSessionTurnDetail[] = []
        let cursor = 0
        for (const [index, turn] of turns.entries()) {
            const boundary = messageCursor(ascending[index].message)
            const input: AdminChatTurnMessage[] = []
            while (
                cursor < inputRows.length &&
                isBefore(messageCursor(inputRows[cursor]), boundary)
            ) {
                input.push(toTurnMessage(inputRows[cursor]))
                cursor += 1
            }
            items.push({
                turn,
                input,
                result: toTurnMessage(ascending[index].message)
            })
        }

        return {
            items: items.reverse(),
            nextBefore: hasMore
                ? encodeMessageCursor(messageCursor(oldest.message))
                : null
        }
    }

    private async buildTurns(
        rows: Array<{
            message: DbChatMessage
            usage: AgentUsageEventRow | null
        }>
    ): Promise<AdminChatSessionTurn[]> {
        const messageIds = rows.map((r) => r.message.id)
        const [executions, errors] = await Promise.all([
            this.repo.listTurnExecutionsByMessageIds(messageIds),
            this.repo.terminalErrorsForMessages(messageIds)
        ])
        const executionByMessage = new Map(
            executions.map((row) => [row.messageId, row])
        )

        return rows.map(({ message, usage }) => {
            const execution = executionByMessage.get(message.id)
            const capabilities = message.capabilityEventsJson as Record<
                string,
                unknown
            > | null
            const capabilityModel = capabilities?.model
            return {
                messageId: message.id,
                createdAt: message.createdAt.toISOString(),
                model:
                    usage?.model ??
                    (typeof capabilityModel === 'string'
                        ? capabilityModel
                        : null),
                inputTokens: usage?.inputTokens ?? null,
                outputTokens: usage?.outputTokens ?? null,
                costUsd: usage?.costUsd == null ? null : Number(usage.costUsd),
                firstTokenMs: usage?.firstTokenMs ?? null,
                totalMs: usage?.totalMs ?? null,
                execution: execution ? toExecution(execution) : null,
                error: errorFromPayload(errors.get(message.id)),
                compactedStreamRows: message.compactedStreamRows,
                streamCompactedAt:
                    message.streamCompactedAt?.toISOString() ?? null
            }
        })
    }

    async listEvents(
        sessionId: string,
        opts: {
            limit: number
            afterId: bigint | null
            order: 'asc' | 'desc'
            types: string[] | null
            messageId: string | null
        }
    ): Promise<AdminChatStreamEventsPage> {
        const session = await this.repo.getSessionById(sessionId)
        if (!session) throw new NotFoundException('Session not found')
        const rows = await this.repo.listAdminSessionStreamEvents(sessionId, {
            ...opts,
            limit: opts.limit + 1
        })
        const page = rows.slice(0, opts.limit)
        const last = page[page.length - 1]
        const nextCursor =
            rows.length > opts.limit && last ? String(last.id) : null
        const items: AdminChatStreamEvent[] = page.map((row) => ({
            id: String(row.id),
            messageId: row.messageId,
            seq: row.seq,
            eventType: row.eventType,
            payloadJson: row.payloadJson,
            runnerSeq: row.runnerSeq,
            createdAt: row.createdAt.toISOString()
        }))
        return { items, nextCursor }
    }

    private async requireSessionRow(
        sessionId: string
    ): Promise<AdminSessionRow[]> {
        const rows = await this.repo.listAdminSessionsPage({
            limit: 1,
            after: null,
            agentId: null,
            userId: null,
            running: false,
            hasError: false,
            idEquals: sessionId,
            titleQuery: null
        })
        if (rows.length === 0) throw new NotFoundException('Session not found')
        return rows
    }

    private async enrich(
        rows: AdminSessionRow[]
    ): Promise<AdminChatSessionSummary[]> {
        if (rows.length === 0) return []
        const sessionIds = rows.map((r) => r.session.id)
        const [
            messageStats,
            usageSums,
            executions,
            latestAssistants,
            channels
        ] = await Promise.all([
            this.repo.sessionMessageStats(sessionIds),
            this.repo.adminSessionUsageSums(sessionIds),
            this.repo.latestTurnExecutionsBySession(sessionIds),
            this.repo.latestAssistantMessagesBySession(sessionIds),
            this.repo.listSessionChannels(sessionIds)
        ])

        // Only look up errors for turns that can actually be failed: the latest
        // execution when it failed, plus the latest assistant message of
        // sessions whose runtime does not use durable execution rows.
        const errorCandidates = new Map<string, string>()
        for (const sessionId of sessionIds) {
            const execution = executions.get(sessionId)
            if (execution) {
                if (execution.state === 'failed')
                    errorCandidates.set(sessionId, execution.messageId)
                continue
            }
            const assistant = latestAssistants.get(sessionId)
            if (assistant) errorCandidates.set(sessionId, assistant.id)
        }
        const errors = await this.repo.terminalErrorsForMessages([
            ...errorCandidates.values()
        ])

        const channelBySession = new Map<string, ChatSessionChannelSummary>()
        for (const row of channels) {
            if (channelBySession.has(row.chatSessionId)) continue
            channelBySession.set(row.chatSessionId, {
                id: row.channelId,
                channelSessionId: row.channelSessionId,
                provider: row.provider,
                label: row.label,
                displayName: row.displayName
            })
        }

        return rows.map((row) => {
            const session = row.session
            const stats = messageStats.get(session.id)
            const usage = usageSums.get(session.id)
            const execution = executions.get(session.id)
            const candidateMessageId = errorCandidates.get(session.id)
            const lastError = candidateMessageId
                ? errorFromPayload(errors.get(candidateMessageId))
                : null
            const status: AdminChatSessionStatus =
                session.inflightMessageId !== null
                    ? 'running'
                    : execution?.state === 'failed' || lastError !== null
                      ? 'failed'
                      : 'idle'
            return {
                id: session.id,
                title: session.title,
                userId: session.userId,
                userEmail: row.userEmail,
                userDisplayName: row.userDisplayName,
                agentId: session.agentId,
                agentName: row.agentName,
                agentFramework: row.agentFramework,
                agentRuntime: row.agentRuntime,
                channel: channelBySession.get(session.id) ?? null,
                status,
                inflightMessageId: session.inflightMessageId,
                lastTurnState: execution?.state ?? null,
                lastError,
                messageCount: stats?.messageCount ?? 0,
                lastMessageAt: stats?.lastMessageAt?.toISOString() ?? null,
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                costUsd: usage?.costUsd ?? null,
                frameworkSessionRef: session.frameworkSessionRef,
                createdAt: session.createdAt.toISOString(),
                updatedAt: session.updatedAt.toISOString()
            }
        })
    }
}
