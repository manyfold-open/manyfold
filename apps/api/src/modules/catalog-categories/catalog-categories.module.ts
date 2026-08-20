import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminCatalogCategoriesController } from '@/modules/catalog-categories/admin-catalog-categories.controller'
import { CatalogCategoriesController } from '@/modules/catalog-categories/catalog-categories.controller'
import { CatalogCategoriesService } from '@/modules/catalog-categories/catalog-categories.service'

@Module({
    imports: [AuthModule],
    controllers: [
        CatalogCategoriesController,
        AdminCatalogCategoriesController
    ],
    providers: [AdminGuard, CatalogCategoriesService],
    exports: [CatalogCategoriesService]
})
export class CatalogCategoriesModule {}
