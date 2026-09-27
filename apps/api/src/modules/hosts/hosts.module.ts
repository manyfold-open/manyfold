import { Module } from '@nestjs/common'
import { HostsService } from './hosts.service'
import { HostDaemonsService } from './host-daemons.service'
import { RuntimeContextService } from './runtime-context.service'
import { RuntimeProvidersService } from './runtime-providers.service'
import { SandboxProviderRegistry } from './providers/sandbox-provider'
import { HostProviderClients } from './providers/host-provider-clients.service'
import { HostPlacementService } from './providers/host-placement.service'
import { SpritesProvider } from './providers/sprites.provider'
import { K8sProvider } from './providers/k8s.provider'
import { HostAwakeService } from './host-awake.service'

// Dependency-free on purpose: every module that needs a host, its daemon or
// the runtime context imports this one, so it must import none of them.
// SecretsModule and K8sModule are global, which is what lets the provider
// adapters live here. Each adapter registers itself with the registry from
// its constructor.
@Module({
    providers: [
        HostsService,
        HostDaemonsService,
        RuntimeContextService,
        RuntimeProvidersService,
        SandboxProviderRegistry,
        HostProviderClients,
        HostPlacementService,
        SpritesProvider,
        K8sProvider,
        HostAwakeService
    ],
    exports: [
        HostsService,
        HostDaemonsService,
        RuntimeContextService,
        RuntimeProvidersService,
        SandboxProviderRegistry,
        HostProviderClients,
        HostPlacementService,
        HostAwakeService
    ]
})
export class HostsModule {}
