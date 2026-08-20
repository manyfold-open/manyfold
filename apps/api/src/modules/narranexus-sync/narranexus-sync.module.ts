import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AutomationsModule } from '@/modules/automations/automations.module'
import { ChannelsModule } from '@/modules/channels/channels.module'
import { DaemonRateLimitService } from '@/modules/daemon/daemon-rate-limit.service'
import { NarraNexusSyncController } from './narranexus-sync.controller'
import { NarraNexusSyncAdminController } from './narranexus-sync-admin.controller'
import { NarraNexusSyncService } from './narranexus-sync.service'

// Registered directly in AppModule (NOT inside NarraNexusModule): AgentsModule
// imports NarraNexusModule, so pulling Automations/Channels in there would
// close a cycle. Dependency direction here is sync -> {automations, channels}
// -> agents -> narranexus.
@Module({
    imports: [
        AuthModule,
        AgentsModule,
        AgentRuntimesModule,
        AutomationsModule,
        ChannelsModule
    ],
    controllers: [NarraNexusSyncController, NarraNexusSyncAdminController],
    // DaemonRateLimitService is a generic fixed-window limiter — providing a
    // local instance reuses the class without importing DaemonModule.
    providers: [NarraNexusSyncService, DaemonRateLimitService]
})
export class NarraNexusSyncModule {}
