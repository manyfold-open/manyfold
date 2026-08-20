import type {
    AdminSkillCatalogItem,
    AdminSkillsCatalogPage
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Get,
    Param,
    Patch,
    Query,
    UseGuards
} from '@nestjs/common'
import { parseCatalogLimit } from '@/common/catalog-query'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UpdateSkillCurationDto } from './dto/skills.dto'
import { SkillsService } from './skills.service'

@Controller('admin/skills-catalog')
@UseGuards(AuthGuard, AdminGuard)
export class AdminSkillsCatalogController {
    constructor(private readonly service: SkillsService) {}

    @Get()
    list(
        @Query('q') q?: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string
    ): Promise<AdminSkillsCatalogPage> {
        return this.service.adminListCatalog({
            q,
            cursor,
            limit: parseCatalogLimit(limit)
        })
    }

    @Patch(':skillId')
    update(
        @Param('skillId') skillId: string,
        @Body() body: UpdateSkillCurationDto
    ): Promise<AdminSkillCatalogItem> {
        return this.service.adminUpdateCuration(skillId, body)
    }
}
