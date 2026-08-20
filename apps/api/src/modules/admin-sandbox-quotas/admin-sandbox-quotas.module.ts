import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { AdminSandboxQuotasController } from '@/modules/admin-sandbox-quotas/admin-sandbox-quotas.controller'
import { AdminSandboxQuotasService } from '@/modules/admin-sandbox-quotas/admin-sandbox-quotas.service'

@Module({
    imports: [AuthModule, AdminSettingsModule, SandboxActiveDurationModule],
    controllers: [AdminSandboxQuotasController],
    providers: [AdminGuard, AdminSandboxQuotasService],
    exports: [AdminSandboxQuotasService]
})
export class AdminSandboxQuotasModule {}
