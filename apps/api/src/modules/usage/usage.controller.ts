import type {
    AgentFramework,
    UsageBucket,
    UsageEventsPage,
    UsageQuery,
    UsageSessionSummary,
    UsageSummary,
    UsageTimeSeriesPoint,
    UsageTopAgent
} from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    Get,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    DenyBoundToken,
    SubjectAgentFromQuery
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import { UsageService } from './usage.service'

const FRAMEWORKS: AgentFramework[] = [
    'openclaw',
    'hermes',
    'narranexus',
    'claude-code',
    'codex',
    'gemini-cli'
]

export const parseFramework = (value?: string): AgentFramework | undefined => {
    if (!value) return undefined
    if ((FRAMEWORKS as string[]).includes(value)) return value as AgentFramework
    throw new BadRequestException(`unknown framework: ${value}`)
}

export const parseBucket = (value?: string): UsageBucket => {
    if (value === 'hour' || value === 'day') return value
    if (!value) return 'day'
    throw new BadRequestException(`bucket must be 'hour' or 'day'`)
}

export interface UsageQueryDto {
    from?: string
    to?: string
    framework?: string
    runtimeId?: string
    agentId?: string
    sessionId?: string
}

export const buildUserQuery = (
    userId: string,
    q: UsageQueryDto
): UsageQuery => ({
    userId,
    from: q.from,
    to: q.to,
    framework: parseFramework(q.framework),
    runtimeId: q.runtimeId,
    agentId: q.agentId,
    sessionId: q.sessionId
})

@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
    constructor(private readonly usage: UsageService) {}

    @Get('summary')
    @RequireApiTokenScope('usage:read')
    @SubjectAgentFromQuery('agentId')
    summary(
        @CurrentUser() user: AuthPrincipal,
        @Query() q: UsageQueryDto
    ): Promise<UsageSummary> {
        return this.usage.summary(buildUserQuery(user.userId, withBoundAgent(q, user)))
    }

    @Get('timeseries')
    @RequireApiTokenScope('usage:read')
    @SubjectAgentFromQuery('agentId')
    timeseries(
        @CurrentUser() user: AuthPrincipal,
        @Query() q: UsageQueryDto & { bucket?: string }
    ): Promise<UsageTimeSeriesPoint[]> {
        return this.usage.timeseries(
            buildUserQuery(user.userId, withBoundAgent(q, user)),
            parseBucket(q.bucket)
        )
    }

    @Get('events')
    @RequireApiTokenScope('usage:read')
    @SubjectAgentFromQuery('agentId')
    events(
        @CurrentUser() user: AuthPrincipal,
        @Query() q: UsageQueryDto & { cursor?: string; limit?: string }
    ): Promise<UsageEventsPage> {
        const limit = q.limit ? Math.max(1, Math.min(200, Number(q.limit))) : 50
        return this.usage.events(buildUserQuery(user.userId, withBoundAgent(q, user)), {
            limit,
            cursor: q.cursor ?? null
        })
    }

    @Get('sessions')
    @RequireApiTokenScope('usage:read')
    @SubjectAgentFromQuery('agentId')
    sessions(
        @CurrentUser() user: AuthPrincipal,
        @Query() q: UsageQueryDto
    ): Promise<UsageSessionSummary[]> {
        return this.usage.sessions(buildUserQuery(user.userId, withBoundAgent(q, user)))
    }

    @Get('top-agents')
    @RequireApiTokenScope('usage:read')
    @DenyBoundToken()
    topAgents(
        @CurrentUser() user: AuthPrincipal,
        @Query() q: { from?: string; to?: string; limit?: string }
    ): Promise<UsageTopAgent[]> {
        const limit = q.limit ? Number(q.limit) : 10
        return this.usage.topAgents(q.from, q.to, limit, user.userId)
    }
}

const withBoundAgent = <T extends UsageQueryDto>(
    q: T,
    user: AuthPrincipal
): T => {
    if (q.agentId) return q
    const bound = boundAgentIdFromUser(user)
    if (!bound) return q
    return { ...q, agentId: bound }
}
