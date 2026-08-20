import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { UsageController } from './usage.controller'
import { AdminUsageController } from './admin-usage.controller'
import { UsageRepository } from './usage.repository'
import { ModelPriceSnapshotRepository } from './model-price-snapshot.repository'
import { UsagePricingService } from './usage-pricing.service'
import { UsageService } from './usage.service'

@Module({
    imports: [AuthModule],
    controllers: [UsageController, AdminUsageController],
    providers: [
        AdminGuard,
        UsageRepository,
        ModelPriceSnapshotRepository,
        UsagePricingService,
        UsageService
    ],
    exports: [UsagePricingService, UsageService, UsageRepository]
})
export class UsageModule {}
