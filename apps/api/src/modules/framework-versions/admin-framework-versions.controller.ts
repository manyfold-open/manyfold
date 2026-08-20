import type { FrameworkVersionCatalogEntry } from '@manyfold/shared'
import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'

@Controller('admin/framework-versions')
@UseGuards(AuthGuard, AdminGuard)
export class AdminFrameworkVersionsController {
    constructor(private readonly versions: FrameworkVersionsService) {}

    @Post('refresh')
    @HttpCode(200)
    async refresh(): Promise<FrameworkVersionCatalogEntry[]> {
        return this.versions.refresh()
    }
}
