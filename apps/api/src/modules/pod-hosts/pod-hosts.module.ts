import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { HostBringUpModule } from '@/modules/hosts/bring-up/host-bring-up.module'
import { PodHostsController } from './pod-hosts.controller'
import { PodHostsService } from './pod-hosts.service'

@Module({
    imports: [
        AuthModule,
        AgentRuntimesModule,
        AgentsModule,
        AdminSettingsModule,
        HostsModule,
        DaemonModule,
        HostBringUpModule
    ],
    controllers: [PodHostsController],
    providers: [PodHostsService]
})
export class PodHostsModule {}
