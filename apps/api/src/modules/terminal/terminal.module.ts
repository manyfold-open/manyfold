import { Module } from '@nestjs/common'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { RuntimeAuthModule } from '@/modules/agent-runtimes/auth/runtime-auth.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { TerminalGateway } from '@/modules/terminal/terminal.gateway'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { HostDaemonAccessModule } from '@/modules/agents/adapters/host-daemon-access.module'
import { FilesModule } from '@/modules/agents/files/files.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { HostStorageModule } from '@/modules/agents/host-storage/host-storage.module'
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
import { TerminalInventoryService } from '@/modules/terminal/terminal-inventory.service'
import { TerminalHerdrService } from '@/modules/terminal/terminal-herdr.service'
import { TerminalHerdrController } from '@/modules/terminal/terminal-herdr.controller'

@Module({
    imports: [
        HostDaemonAccessModule,
        AuthModule,
        AgentsModule,
        AgentRuntimesModule,
        RuntimeAuthModule,
        HostsModule,
        DaemonModule,
        FilesModule,
        RuntimeAccessModule,
        HostStorageModule,
        ConnectionsModule,
        SecretsModule,
        ChatModule
    ],
    controllers: [
        TerminalHolderController,
        TerminalHookController,
        TerminalHerdrController
    ],
    providers: [
        TerminalGateway,
        DaemonTerminal,
        TerminalResumeService,
        TerminalSessionsRepository,
        TerminalSessionRefsRepository,
        TerminalHolderService,
        TerminalHookService,
        TerminalLeaseReaper,
        TerminalInventoryService,
        TerminalHerdrService,
        // Module-local buckets for the hook endpoint's per-terminal limit.
        ShareRateLimitService
    ]
})
export class TerminalModule {}
