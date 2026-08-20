import type {
    CatalogCategorySummary,
    CatalogDomain
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    UseGuards
} from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import {
    CreateCatalogCategoryDto,
    UpdateCatalogCategoryDto
} from '@/modules/catalog-categories/dto/catalog-categories.dto'
import { CatalogCategoriesService } from '@/modules/catalog-categories/catalog-categories.service'

@Controller('admin/catalog-categories')
@UseGuards(AuthGuard, AdminGuard)
export class AdminCatalogCategoriesController {
    constructor(private readonly categories: CatalogCategoriesService) {}

    @Get()
    list(@Query('domain') domain?: string): Promise<CatalogCategorySummary[]> {
        if (domain !== undefined && domain !== 'skill' && domain !== 'mcp')
            throw new BadRequestException('domain must be skill or mcp')
        return this.categories.list(domain as CatalogDomain | undefined)
    }

    @Post()
    create(
        @Body() body: CreateCatalogCategoryDto
    ): Promise<CatalogCategorySummary> {
        return this.categories.create(body)
    }

    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() body: UpdateCatalogCategoryDto
    ): Promise<CatalogCategorySummary> {
        return this.categories.update(id, body)
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(@Param('id') id: string): Promise<void> {
        await this.categories.delete(id)
    }
}
