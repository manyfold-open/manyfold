import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminFrameworkCatalogController } from '@/modules/framework-catalog/admin-framework-catalog.controller'
import { FrameworkCatalogController } from '@/modules/framework-catalog/framework-catalog.controller'
import { FrameworkCatalogService } from '@/modules/framework-catalog/framework-catalog.service'

@Module({
    imports: [AuthModule],
    controllers: [FrameworkCatalogController, AdminFrameworkCatalogController],
    providers: [AdminGuard, FrameworkCatalogService],
    exports: [FrameworkCatalogService]
})
export class FrameworkCatalogModule {}
