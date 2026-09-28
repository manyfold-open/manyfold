import { Module } from '@nestjs/common'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { HostCliService } from './host-cli.service'
import { RunnerManagerService } from './runner-manager.service'

// The host daemon bring-up has callers with nothing else in common: the turn
// path (ChatModule), the sandbox CLI upgrade (SandboxesModule) that has to
// restart it, the provisioners (AgentRuntimesModule, AgentsModule) and the
// cloud computer's services and CLI update (PodHostsModule). None wants the
// others' modules.
@Module({
    imports: [DaemonModule, HostsModule],
    providers: [RunnerManagerService, HostCliService],
    exports: [RunnerManagerService, HostCliService]
})
export class RunnerModule {}
