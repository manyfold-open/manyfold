import type { SdkSpritesAccountSummary } from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import {
    CreateSpritesAccountDto,
    RotateSpritesAccountDto,
    UpdateSpritesAccountDto
} from '@/modules/sprites-accounts/dto/create-sprites-account.dto'

const toSummary = (
    row: Awaited<ReturnType<SpritesAccountsService['add']>>,
    activeSprites = 0
): SdkSpritesAccountSummary => ({
    id: row.id,
    slug: row.slug,
    orgSlug: row.orgSlug,
    status: row.status,
    priority: row.priority,
    notes: row.notes,
    activeSprites,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Controller('admin/sprites-accounts')
@UseGuards(AuthGuard, AdminGuard)
export class SpritesAccountsController {
    constructor(private readonly service: SpritesAccountsService) {}

    @Get()
    async list(): Promise<SdkSpritesAccountSummary[]> {
        return this.service.list()
    }

    @Get(':slug')
    async get(@Param('slug') slug: string): Promise<SdkSpritesAccountSummary> {
        return this.service.getSummary(slug)
    }

    @Post()
    @HttpCode(201)
    async create(
        @Body() dto: CreateSpritesAccountDto
    ): Promise<SdkSpritesAccountSummary> {
        const row = await this.service.add({
            slug: dto.slug,
            token: dto.token,
            notes: dto.notes,
            priority: dto.priority
        })
        return toSummary(row)
    }

    @Patch(':slug')
    async update(
        @Param('slug') slug: string,
        @Body() dto: UpdateSpritesAccountDto
    ): Promise<SdkSpritesAccountSummary> {
        const row = await this.service.patch(slug, {
            notes: dto.notes,
            priority: dto.priority
        })
        return toSummary(row)
    }

    @Post(':slug/rotate')
    async rotate(
        @Param('slug') slug: string,
        @Body() dto: RotateSpritesAccountDto
    ): Promise<SdkSpritesAccountSummary> {
        const row = await this.service.rotate(slug, dto.token)
        return toSummary(row)
    }

    @Post(':slug/disable')
    async disable(
        @Param('slug') slug: string
    ): Promise<SdkSpritesAccountSummary> {
        const row = await this.service.setStatus(slug, 'disabled')
        return toSummary(row)
    }

    @Post(':slug/enable')
    async enable(
        @Param('slug') slug: string
    ): Promise<SdkSpritesAccountSummary> {
        const row = await this.service.setStatus(slug, 'enabled')
        return toSummary(row)
    }

    @Delete(':slug')
    @HttpCode(200)
    async softDelete(
        @Param('slug') slug: string
    ): Promise<SdkSpritesAccountSummary> {
        const row = await this.service.setStatus(slug, 'disabled')
        return toSummary(row)
    }
}
