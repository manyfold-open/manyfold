import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { EmailModule } from '@/modules/email/email.module'
import { AdminSettingsController } from '@/modules/admin-settings/admin-settings.controller'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'

@Module({
    imports: [AuthModule, EmailModule],
    controllers: [AdminSettingsController],
    providers: [AdminGuard, AdminSettingsService],
    exports: [AdminSettingsService]
})
export class AdminSettingsModule {}
