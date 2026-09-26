import { Module } from '@nestjs/common'
import { HostsService } from './hosts.service'
import { HostDaemonsService } from './host-daemons.service'
import { RuntimeContextService } from './runtime-context.service'
import { RuntimeProvidersService } from './runtime-providers.service'
import {
    SANDBOX_PROVIDERS,
    SandboxProviderRegistry
} from './providers/sandbox-provider'

// Dependency-free on purpose: every module that needs a host, its daemon or
// the runtime context imports this one, so it must import none of them.
// Provider adapters are registered under SANDBOX_PROVIDERS here.
@Module({
    providers: [
        HostsService,
        HostDaemonsService,
        RuntimeContextService,
        RuntimeProvidersService,
        { provide: SANDBOX_PROVIDERS, useValue: [] },
        SandboxProviderRegistry
    ],
    exports: [
        HostsService,
        HostDaemonsService,
        RuntimeContextService,
        RuntimeProvidersService,
        SandboxProviderRegistry
    ]
})
export class HostsModule {}
