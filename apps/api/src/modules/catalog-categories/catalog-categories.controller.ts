import type {
    CatalogCategorySummary,
    CatalogDomain
} from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    Get,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { CatalogCategoriesService } from '@/modules/catalog-categories/catalog-categories.service'

@Controller('catalog')
@UseGuards(AuthGuard)
export class CatalogCategoriesController {
    constructor(private readonly categories: CatalogCategoriesService) {}

    @Get('categories')
    list(@Query('domain') domain?: string): Promise<CatalogCategorySummary[]> {
        if (domain !== 'skill' && domain !== 'mcp')
            throw new BadRequestException('domain must be skill or mcp')
        return this.categories.list(domain as CatalogDomain)
    }
}
