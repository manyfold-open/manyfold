import { Module } from '@nestjs/common'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { PodHostCliService } from './pod-host-cli.service'
import { RunnerManagerService } from './runner-manager.service'

// The platform's runners have callers with nothing else in common: the turn
// path (ChatModule) that brings one up, the sandbox CLI upgrade
// (SandboxesModule) that has to restart it, and the cloud computer's services
// and CLI update (AgentRuntimesModule, PodHostsModule) that need its CLI
// current. None wants the others' modules.
@Module({
    imports: [DaemonModule],
    providers: [RunnerManagerService, PodHostCliService],
    exports: [RunnerManagerService, PodHostCliService]
})
export class RunnerModule {}
