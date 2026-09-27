import { Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { RuntimeProvidersService } from '@/modules/hosts/runtime-providers.service'
import { RuntimeProvidersController } from './runtime-providers.controller'
import { RuntimeProvidersAdminService } from './runtime-providers-admin.service'

@Module({
    imports: [AuthModule, HostsModule],
    controllers: [RuntimeProvidersController],
    providers: [AdminGuard, RuntimeProvidersAdminService],
    exports: [RuntimeProvidersAdminService]
})
export class RuntimeProvidersModule {
    // The capability the web reads as "stateful sandboxes can be created":
    // any enabled sprites organisation.
    constructor(registry: CapabilitiesRegistry, providers: RuntimeProvidersService) {
        registry.register(
            'spritesAccounts',
            async () => (await providers.listEnabled('sprites')).length > 0
        )
    }
}
