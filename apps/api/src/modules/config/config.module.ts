import { Module } from '@nestjs/common'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { AppConfigController } from '@/modules/config/config.controller'
import { CapabilitiesController } from '@/modules/config/capabilities.controller'

@Module({
    imports: [AuthModule, AdminSettingsModule],
    controllers: [AppConfigController, CapabilitiesController]
})
export class AppConfigModule {}
