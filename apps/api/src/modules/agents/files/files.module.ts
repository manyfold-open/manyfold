import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { FilesController } from '@/modules/agents/files/files.controller'
import { AdminFilesController } from '@/modules/agents/files/admin-files.controller'
import { FilesContextBuilder } from '@/modules/agents/files/files-context'
import { DaemonModule } from '@/modules/daemon/daemon.module'

@Module({
    imports: [
        AuthModule,
        SpritesAccountsModule,
        AgentRuntimesModule,
        forwardRef(() => AgentsModule),
        DaemonModule
    ],
    controllers: [FilesController, AdminFilesController],
    providers: [AdminGuard, FilesContextBuilder],
    exports: [FilesContextBuilder]
})
export class FilesModule {}
