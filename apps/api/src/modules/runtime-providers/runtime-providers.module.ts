import { Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { RuntimeProvidersService } from '@/modules/hosts/runtime-providers.service'
import { RuntimeProviderMachinesController } from './runtime-provider-machines.controller'
import { RuntimeProviderMachinesService } from './runtime-provider-machines.service'
import { RuntimeProvidersController } from './runtime-providers.controller'
import { RuntimeProvidersAdminService } from './runtime-providers-admin.service'

@Module({
    imports: [AuthModule, HostsModule, AgentRuntimesModule],
    controllers: [
        RuntimeProvidersController,
        RuntimeProviderMachinesController
    ],
    providers: [
        AdminGuard,
        RuntimeProvidersAdminService,
        RuntimeProviderMachinesService
    ],
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
