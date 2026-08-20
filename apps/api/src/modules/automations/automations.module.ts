import { Module } from '@nestjs/common'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { ChannelsModule } from '@/modules/channels/channels.module'
import { ChatModule } from '@/modules/chat/chat.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { AutomationsController } from './automations.controller'
import { AutomationRetentionService } from './automation-retention.service'
import { AutomationsService } from './automations.service'

@Module({
    imports: [
        AuthModule,
        AdminSettingsModule,
        ChatModule,
        AgentsModule,
        ChannelsModule,
        RuntimeAccessModule
    ],
    controllers: [AutomationsController],
    providers: [
        AutomationsService,
        AutomationRetentionService,
        ServiceLeaseService
    ],
    exports: [AutomationsService]
})
export class AutomationsModule {}
