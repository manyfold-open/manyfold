import type {
    AgentFramework,
    AgentRuntime,
    ChatUsage,
    UsageBucket,
    UsageEventsPage,
    UsageQuery,
    UsageSessionSummary,
    UsageSummary,
    UsageTimeSeriesPoint,
    UsageTopAgent,
    UsageTopUser
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { TurnExecutionFence } from '@/modules/chat/turn-fence'
import { UsageRepository } from './usage.repository'

export interface RecordUsageInput {
    userId: string
    agentId: string | null
    runtimeId: string | null
    sessionId: string | null
    messageId: string | null
    framework: AgentFramework
    runtimeKind: AgentRuntime
    modelProviderId: string | null
    usage: ChatUsage
    fence?: TurnExecutionFence
}

@Injectable()
export class UsageService {
    private readonly logger = new Logger(UsageService.name)

    constructor(private readonly repo: UsageRepository) {}

    async record(input: RecordUsageInput): Promise<void> {
        const { usage } = input
        try {
            await this.repo.insert(
                {
                    id: randomUUID(),
                    userId: input.userId,
                    agentId: input.agentId,
                    runtimeId: input.runtimeId,
                    sessionId: input.sessionId,
                    messageId: input.messageId,
                    framework: input.framework,
                    runtimeKind: input.runtimeKind,
                    model: usage.model,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheCreationTokens: usage.cacheCreationTokens,
                    costUsd:
                        usage.costUsd === null ? null : String(usage.costUsd),
                    costSource: usage.costSource,
                    isFallbackModel: usage.isFallbackModel ?? false,
                    firstTokenMs: usage.firstTokenMs,
                    totalMs: usage.totalMs,
                    modelProviderId: input.modelProviderId,
                    createdAt: new Date()
                },
                input.fence
            )
        } catch (err) {
            this.logger.warn(
                `usage insert failed agentId=${input.agentId ?? '-'} msg=${(err as Error).message}`
            )
        }
    }

    summary(query: UsageQuery): Promise<UsageSummary> {
        return this.repo.summary(query)
    }

    timeseries(
        query: UsageQuery,
        bucket: UsageBucket
    ): Promise<UsageTimeSeriesPoint[]> {
        return this.repo.timeseries(query, bucket)
    }

    sessions(query: UsageQuery): Promise<UsageSessionSummary[]> {
        return this.repo.sessions(query)
    }

    async events(
        query: UsageQuery,
        opts: { limit: number; cursor: string | null }
    ): Promise<UsageEventsPage> {
        return this.repo.listEvents(query, opts)
    }

    topUsers(
        from: string | undefined,
        to: string | undefined,
        limit: number
    ): Promise<UsageTopUser[]> {
        return this.repo.topUsers(
            parseBound(from),
            parseBound(to),
            Math.max(1, Math.min(100, limit))
        )
    }

    topAgents(
        from: string | undefined,
        to: string | undefined,
        limit: number,
        userId?: string
    ): Promise<UsageTopAgent[]> {
        return this.repo.topAgents(
            parseBound(from),
            parseBound(to),
            Math.max(1, Math.min(100, limit)),
            userId
        )
    }
}

const parseBound = (v: string | undefined): Date | null => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
}
