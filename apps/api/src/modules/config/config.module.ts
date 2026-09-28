import { Module } from '@nestjs/common'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { AgentSetupController } from '@/modules/config/agent-setup.controller'
import { AppConfigController } from '@/modules/config/config.controller'
import { CapabilitiesController } from '@/modules/config/capabilities.controller'

@Module({
    imports: [AuthModule, AdminSettingsModule],
    controllers: [
        AppConfigController,
        CapabilitiesController,
        AgentSetupController
    ]
})
export class AppConfigModule {}
