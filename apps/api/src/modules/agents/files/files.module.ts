import { Module, forwardRef } from '@nestjs/common'
import { ResourceEventsModule } from '@/modules/resource-events/resource-events.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { FilesController } from '@/modules/agents/files/files.controller'
import { AdminFilesController } from '@/modules/agents/files/admin-files.controller'
import { FilesContextBuilder } from '@/modules/agents/files/files-context'
import { DaemonModule } from '@/modules/daemon/daemon.module'

@Module({
    imports: [
        ResourceEventsModule,
        AuthModule,
        HostsModule,
        AgentRuntimesModule,
        forwardRef(() => AgentsModule),
        DaemonModule
    ],
    controllers: [FilesController, AdminFilesController],
    providers: [AdminGuard, FilesContextBuilder],
    exports: [FilesContextBuilder]
})
export class FilesModule {}
