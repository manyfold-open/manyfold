import { Module } from '@nestjs/common'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { RuntimeAuthModule } from '@/modules/agent-runtimes/auth/runtime-auth.module'
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
import { ChatModule } from '@/modules/chat/chat.module'
import { TerminalSessionsRepository } from '@/modules/terminal/terminal-sessions.repository'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'
import { TerminalHolderController } from '@/modules/terminal/terminal-holder.controller'
import { TerminalLeaseReaper } from '@/modules/terminal/terminal-lease.reaper'
import { TerminalSessionRefsRepository } from '@/modules/terminal/terminal-session-refs.repository'
import { TerminalHookService } from '@/modules/terminal/terminal-hook.service'
import { TerminalHookController } from '@/modules/terminal/terminal-hook.controller'
import { ShareRateLimitService } from '@/common/share-rate-limit.service'

@Module({
    imports: [
        AuthModule,
        AgentsModule,
        AgentRuntimesModule,
        RuntimeAuthModule,
        SpritesAccountsModule,
        DaemonModule,
        FilesModule,
        RuntimeAccessModule,
        SpriteStorageModule,
        ConnectionsModule,
        SecretsModule,
        ChatModule
    ],
    controllers: [TerminalHolderController, TerminalHookController],
    providers: [
        TerminalGateway,
        SpritesTerminal,
        K8sTerminal,
        DaemonTerminal,
        TerminalResumeService,
        TerminalSessionsRepository,
        TerminalSessionRefsRepository,
        TerminalHolderService,
        TerminalHookService,
        TerminalLeaseReaper,
        // Module-local buckets for the hook endpoint's per-terminal limit.
        ShareRateLimitService
    ]
})
export class TerminalModule {}
