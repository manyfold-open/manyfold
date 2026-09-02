import { Module } from '@nestjs/common'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { TerminalGateway } from '@/modules/terminal/terminal.gateway'
import { SpritesTerminal } from '@/modules/terminal/sprites-terminal'
import { K8sTerminal } from '@/modules/terminal/k8s-terminal'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { FilesModule } from '@/modules/agents/files/files.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { SpriteStorageModule } from '@/modules/agents/sprite-storage/sprite-storage.module'
import { ConnectionsModule } from '@/modules/connections/connections.module'

@Module({
    imports: [
        AuthModule,
        AgentsModule,
        AgentRuntimesModule,
        SpritesAccountsModule,
        DaemonModule,
        FilesModule,
        RuntimeAccessModule,
        SpriteStorageModule,
        ConnectionsModule,
        SecretsModule
    ],
    providers: [
        TerminalGateway,
        SpritesTerminal,
        K8sTerminal,
        DaemonTerminal,
        TerminalResumeService
    ]
})
export class TerminalModule {}
