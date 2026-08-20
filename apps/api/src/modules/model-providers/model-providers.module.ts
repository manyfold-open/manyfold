import { Module } from '@nestjs/common'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { UsageModule } from '@/modules/usage/usage.module'
import { AdminBuiltInModelPricesController } from '@/modules/model-providers/admin-built-in-model-prices.controller'
import { AdminModelProvidersController } from '@/modules/model-providers/admin-model-providers.controller'
import { ModelProvidersController } from '@/modules/model-providers/model-providers.controller'
import { ModelProvidersService } from '@/modules/model-providers/model-providers.service'
import { ProviderTestService } from '@/modules/model-providers/provider-test.service'
import { ScopedModelPricesService } from '@/modules/model-providers/scoped-model-prices.service'

// BYO model providers only. The managed (platform-provisioned) family lives
// in @/modules/managed-models — a commercial module the cloud root assembles;
// this module reaches it through MANAGED_MODELS_PORT where the two surfaces
// interleave (provider list defaults, delete fall-through, managed test).
@Module({
    imports: [AuthModule, AdminSettingsModule, UsageModule],
    controllers: [
        ModelProvidersController,
        AdminModelProvidersController,
        AdminBuiltInModelPricesController
    ],
    providers: [
        ModelProvidersService,
        ProviderTestService,
        ScopedModelPricesService
    ],
    exports: [ModelProvidersService, ProviderTestService]
})
export class ModelProvidersModule {}
