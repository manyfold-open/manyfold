import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { RuntimeAccessController } from './runtime-access.controller'
import { RuntimeAccessService } from './runtime-access.service'

@Module({
    imports: [AuthModule, AdminSettingsModule, SandboxActiveDurationModule],
    controllers: [RuntimeAccessController],
    providers: [RuntimeAccessService],
    exports: [RuntimeAccessService]
})
export class RuntimeAccessModule {}
