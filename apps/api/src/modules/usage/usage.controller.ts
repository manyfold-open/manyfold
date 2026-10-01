import type {
    UsageEventsPage,
    UsageSessionSummary,
    UsageSummary,
    UsageTimeSeriesPoint,
    UsageTopAgent
} from '@manyfold/shared'
import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    DenyBoundToken,
    SubjectAgentFromQuery
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import {
    buildUserQuery,
    parseBucket,
    parseCursor,
    parseInstant,
    parseLimit,
    type UsageQueryDto
} from './usage-query'
import { UsageService } from './usage.service'

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
        const limit = parseLimit(q.limit, 50, 200)
        return this.usage.events(buildUserQuery(user.userId, withBoundAgent(q, user)), {
            limit,
            cursor: parseCursor(q.cursor)
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
        const limit = parseLimit(q.limit, 10, 100)
        return this.usage.topAgents(
            parseInstant('from', q.from),
            parseInstant('to', q.to),
            limit,
            user.userId
        )
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
