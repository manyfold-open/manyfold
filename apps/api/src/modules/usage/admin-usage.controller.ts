import type {
    UsageEventsPage,
    UsageQuery,
    UsageSessionSummary,
    UsageSummary,
    UsageTimeSeriesPoint,
    UsageTopAgent,
    UsageTopUser
} from '@manyfold/shared'
import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import {
    buildUserQuery,
    parseBucket,
    parseCursor,
    parseFramework,
    parseInstant,
    parseLimit,
    type UsageQueryDto
} from './usage-query'
import { UsageService } from './usage.service'

type AdminQueryDto = UsageQueryDto & { userId?: string }

const buildAdminQuery = (q: AdminQueryDto): UsageQuery =>
    q.userId
        ? buildUserQuery(q.userId, q)
        : {
              from: parseInstant('from', q.from),
              to: parseInstant('to', q.to),
              framework: parseFramework(q.framework),
              runtimeId: q.runtimeId,
              agentId: q.agentId,
              sessionId: q.sessionId
          }

@Controller('admin/usage')
@UseGuards(AuthGuard, AdminGuard)
export class AdminUsageController {
    constructor(private readonly usage: UsageService) {}

    @Get('summary')
    summary(@Query() q: AdminQueryDto): Promise<UsageSummary> {
        return this.usage.summary(buildAdminQuery(q))
    }

    @Get('timeseries')
    timeseries(
        @Query() q: AdminQueryDto & { bucket?: string }
    ): Promise<UsageTimeSeriesPoint[]> {
        return this.usage.timeseries(buildAdminQuery(q), parseBucket(q.bucket))
    }

    @Get('events')
    events(
        @Query() q: AdminQueryDto & { cursor?: string; limit?: string }
    ): Promise<UsageEventsPage> {
        const limit = parseLimit(q.limit, 50, 200)
        return this.usage.events(buildAdminQuery(q), {
            limit,
            cursor: parseCursor(q.cursor)
        })
    }

    @Get('sessions')
    sessions(@Query() q: AdminQueryDto): Promise<UsageSessionSummary[]> {
        return this.usage.sessions(buildAdminQuery(q))
    }

    @Get('top-users')
    topUsers(
        @Query() q: { from?: string; to?: string; limit?: string }
    ): Promise<UsageTopUser[]> {
        const limit = parseLimit(q.limit, 10, 100)
        return this.usage.topUsers(
            parseInstant('from', q.from),
            parseInstant('to', q.to),
            limit
        )
    }

    @Get('top-agents')
    topAgents(
        @Query() q: { from?: string; to?: string; limit?: string }
    ): Promise<UsageTopAgent[]> {
        const limit = parseLimit(q.limit, 10, 100)
        return this.usage.topAgents(
            parseInstant('from', q.from),
            parseInstant('to', q.to),
            limit
        )
    }
}
