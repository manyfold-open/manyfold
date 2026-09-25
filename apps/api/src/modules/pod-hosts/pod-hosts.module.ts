import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { PodHostsController } from './pod-hosts.controller'
import { PodHostsService } from './pod-hosts.service'

@Module({
    imports: [
        AuthModule,
        AgentRuntimesModule,
        AgentsModule,
        AdminSettingsModule,
        DaemonModule
    ],
    controllers: [PodHostsController],
    providers: [PodHostsService]
})
export class PodHostsModule {}
