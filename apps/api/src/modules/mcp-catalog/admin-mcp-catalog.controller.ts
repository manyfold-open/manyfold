import type {
    AdminMcpCatalogEntry,
    AdminMcpCatalogPage
} from '@manyfold/shared'
import {
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
import { parseCatalogLimit } from '@/common/catalog-query'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import {
    CreateMcpCatalogEntryDto,
    UpdateMcpCatalogEntryDto
} from '@/modules/mcp-catalog/dto/mcp-catalog.dto'
import { McpCatalogService } from '@/modules/mcp-catalog/mcp-catalog.service'

@Controller('admin/mcp-catalog')
@UseGuards(AuthGuard, AdminGuard)
export class AdminMcpCatalogController {
    constructor(private readonly catalog: McpCatalogService) {}

    @Get()
    list(
        @Query('q') q?: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string
    ): Promise<AdminMcpCatalogPage> {
        return this.catalog.adminList({
            q,
            cursor,
            limit: parseCatalogLimit(limit)
        })
    }

    @Get(':id')
    get(@Param('id') id: string): Promise<AdminMcpCatalogEntry> {
        return this.catalog.adminGet(id)
    }

    @Post()
    create(
        @Body() body: CreateMcpCatalogEntryDto
    ): Promise<AdminMcpCatalogEntry> {
        return this.catalog.adminCreate(body)
    }

    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() body: UpdateMcpCatalogEntryDto
    ): Promise<AdminMcpCatalogEntry> {
        return this.catalog.adminUpdate(id, body)
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(@Param('id') id: string): Promise<void> {
        await this.catalog.adminDelete(id)
    }
}
