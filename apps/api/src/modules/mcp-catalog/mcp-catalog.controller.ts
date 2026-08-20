import type {
    McpCatalogEntry,
    McpCatalogPage
} from '@manyfold/shared'
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import {
    parseCatalogLimit,
    parseCatalogSort
} from '@/common/catalog-query'
import { AuthGuard } from '@/common/guards/auth.guard'
import { McpCatalogService } from '@/modules/mcp-catalog/mcp-catalog.service'

@Controller('mcp')
@UseGuards(AuthGuard)
export class McpCatalogController {
    constructor(private readonly catalog: McpCatalogService) {}

    @Get('catalog')
    list(
        @Query('q') q?: string,
        @Query('category') category?: string,
        @Query('tag') tag?: string,
        @Query('sort') sort?: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string
    ): Promise<McpCatalogPage> {
        return this.catalog.listPublic({
            q,
            categoryId: category,
            tag,
            sort: parseCatalogSort(sort),
            cursor,
            limit: parseCatalogLimit(limit)
        })
    }

    @Get('catalog/:slug')
    get(@Param('slug') slug: string): Promise<McpCatalogEntry> {
        return this.catalog.getBySlug(slug)
    }
}
