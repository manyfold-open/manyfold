import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { RunnerModule } from '@/modules/chat/runner/runner.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
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
        RunnerModule,
        RuntimeAccessModule,
        SpritesAccountsModule
    ],
    controllers: [RuntimeAuthProfilesController],
    providers: [RuntimeAuthProfilesService],
    exports: [RuntimeAuthProfilesService]
})
export class RuntimeAuthModule {}
