import type {
    SandboxQuotaTimeseriesRange,
    SandboxQuotaTimeseriesResponse,
    SandboxQuotaUsersPage,
    SandboxQuotasOverview
} from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    Get,
    Query,
    UseGuards
} from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminSandboxQuotasService } from '@/modules/admin-sandbox-quotas/admin-sandbox-quotas.service'

const RANGES: ReadonlySet<SandboxQuotaTimeseriesRange> = new Set([
    '24h',
    '7d',
    '30d'
])

@Controller('admin/sandbox-quotas')
@UseGuards(AuthGuard, AdminGuard)
export class AdminSandboxQuotasController {
    constructor(private readonly service: AdminSandboxQuotasService) {}

    @Get('overview')
    overview(): Promise<SandboxQuotasOverview> {
        return this.service.overview()
    }

    @Get('users')
    listUsers(
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string
    ): Promise<SandboxQuotaUsersPage> {
        const parsedLimit =
            typeof limit === 'string' && limit.length > 0
                ? Number.parseInt(limit, 10)
                : undefined
        if (parsedLimit !== undefined && !Number.isFinite(parsedLimit))
            throw new BadRequestException('invalid limit')
        return this.service.listUsers({ cursor, limit: parsedLimit })
    }

    @Get('timeseries')
    timeseries(
        @Query('range') range?: string
    ): Promise<SandboxQuotaTimeseriesResponse> {
        const value = (range ?? '24h') as SandboxQuotaTimeseriesRange
        if (!RANGES.has(value))
            throw new BadRequestException(
                `invalid range "${range}", expected 24h|7d|30d`
            )
        return this.service.timeseries(value)
    }
}
