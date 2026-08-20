import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminFrameworkVersionsController } from '@/modules/framework-versions/admin-framework-versions.controller'
import { FrameworkVersionsController } from '@/modules/framework-versions/framework-versions.controller'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'

@Module({
    imports: [AuthModule, AdminSettingsModule],
    controllers: [
        FrameworkVersionsController,
        AdminFrameworkVersionsController
    ],
    providers: [AdminGuard, FrameworkVersionsService],
    exports: [FrameworkVersionsService]
})
export class FrameworkVersionsModule {}
