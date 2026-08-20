import type {
    BuiltInModelPriceEntryView,
    BuiltInModelPricesView,
    ModelPriceSourcesView
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Put,
    Query,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { UpsertBuiltInModelPriceDto } from '@/modules/model-providers/dto/scoped-model-prices.dto'
import { ScopedModelPricesService } from '@/modules/model-providers/scoped-model-prices.service'

// Platform-wide default prices for built-in providers' models. Model ids carry
// '/' (anthropic/claude-…), so they always travel as query params or body
// fields, never as path segments.
@Controller('admin/built-in-model-prices')
@UseGuards(AuthGuard, AdminGuard)
export class AdminBuiltInModelPricesController {
    constructor(private readonly prices: ScopedModelPricesService) {}

    @Get()
    list(): Promise<BuiltInModelPricesView> {
        return this.prices.adminList()
    }

    @Get('candidates')
    candidates(
        @Query('builtInId') builtInId: string,
        @Query('model') model: string,
        @Query('q') query?: string
    ): Promise<ModelPriceSourcesView> {
        return this.prices.adminCandidates(
            builtInId ?? '',
            model ?? '',
            query?.trim() || undefined
        )
    }

    @Put()
    upsert(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpsertBuiltInModelPriceDto
    ): Promise<BuiltInModelPriceEntryView> {
        return this.prices.adminUpsert(dto, user.userId)
    }

    @Delete()
    @HttpCode(204)
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Query('builtInId') builtInId: string,
        @Query('model') model: string
    ): Promise<void> {
        await this.prices.adminDelete(builtInId ?? '', model ?? '', user.userId)
    }
}
