import { Module } from '@nestjs/common'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { RunnerManagerService } from './runner-manager.service'

// The sprite runner has two callers with nothing else in common: the turn path
// (ChatModule) that brings it up, and the sandbox CLI upgrade (SandboxesModule)
// that has to restart it. Neither wants the other's module.
@Module({
    imports: [DaemonModule],
    providers: [RunnerManagerService],
    exports: [RunnerManagerService]
})
export class RunnerModule {}
