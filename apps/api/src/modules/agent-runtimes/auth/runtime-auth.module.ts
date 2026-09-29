import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { HostBringUpModule } from '@/modules/hosts/bring-up/host-bring-up.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { HostDaemonAccessModule } from '@/modules/agents/adapters/host-daemon-access.module'
import { AgentRuntimesModule } from '../agent-runtimes.module'
import { RuntimeAuthProfilesController } from './runtime-auth-profiles.controller'
import { RuntimeAuthProfilesService } from './runtime-auth-profiles.service'

// Runtime auth profiles sit beside the runtimes module rather than inside it
// because a sprite's profiles live on its runner, and waking that runner is
// the runner manager's job — whose module already imports the runtimes
// module for the provisioner. Keeping the auth service here is what lets it
// depend on both without a forward reference.
@Module({
    imports: [
        AuthModule,
        AgentRuntimesModule,
        DaemonModule,
        HostBringUpModule,
        RuntimeAccessModule,
        HostsModule,
        HostDaemonAccessModule
    ],
    controllers: [RuntimeAuthProfilesController],
    providers: [RuntimeAuthProfilesService],
    exports: [RuntimeAuthProfilesService]
})
export class RuntimeAuthModule {}
