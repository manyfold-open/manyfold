import { Module } from '@nestjs/common'
import { ApiQuotaModule } from '@/common/api-quota/api-quota.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { ChatModule } from '@/modules/chat/chat.module'
import { A2aService } from './a2a.service'
import { A2aSelfService } from './a2a-self.service'
import { A2aTicketService } from './a2a-ticket.service'
import { A2aTaskRepository } from './a2a-task.repository'
import { A2aRateLimitService } from './a2a-rate-limit.service'
import { A2aCardController } from './a2a-card.controller'
import { A2aRpcController } from './a2a-rpc.controller'
import { A2aGrantsController } from './a2a-grants.controller'
import { A2aExposureController } from './a2a-exposure.controller'
import { A2aSelfController } from './a2a-self.controller'

@Module({
    imports: [AdminSettingsModule, AuthModule, ChatModule, ApiQuotaModule],
    controllers: [
        A2aCardController,
        A2aRpcController,
        A2aGrantsController,
        A2aExposureController,
        A2aSelfController
    ],
    providers: [
        A2aService,
        A2aSelfService,
        A2aTicketService,
        A2aTaskRepository,
        A2aRateLimitService
    ],
    exports: [A2aService]
})
export class A2aModule {}
