import type { AdminUserModelProviderSummary } from '@manyfold/shared'
import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import { ModelProvidersService } from '@/modules/model-providers/model-providers.service'

@Controller('admin/model-providers')
@UseGuards(AuthGuard, AdminGuard)
export class AdminModelProvidersController {
    constructor(private readonly service: ModelProvidersService) {}

    @Get()
    list(
        @Query() q: { from?: string; to?: string }
    ): Promise<AdminUserModelProviderSummary[]> {
        return this.service.adminListWithUsage({ from: q.from, to: q.to })
    }
}
