import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { CatalogCategoriesModule } from '@/modules/catalog-categories/catalog-categories.module'
import { AdminMcpCatalogController } from '@/modules/mcp-catalog/admin-mcp-catalog.controller'
import { McpCatalogController } from '@/modules/mcp-catalog/mcp-catalog.controller'
import { McpCatalogService } from '@/modules/mcp-catalog/mcp-catalog.service'
import { UserMcpServersController } from '@/modules/mcp-catalog/user-mcp-servers.controller'
import { UserMcpServersService } from '@/modules/mcp-catalog/user-mcp-servers.service'

@Module({
    imports: [AuthModule, CatalogCategoriesModule],
    controllers: [
        McpCatalogController,
        UserMcpServersController,
        AdminMcpCatalogController
    ],
    providers: [AdminGuard, McpCatalogService, UserMcpServersService]
})
export class McpCatalogModule {}
