import { Module } from '@nestjs/common'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { RunnerModule } from '@/modules/chat/runner/runner.module'
import { HostDaemonAccess } from './host-daemon-access'

// The one way to a machine's daemon (ADR-0036), shared by the modules that
// sit below AgentsModule in the import graph (runtime auth, chat, terminal).
@Module({
    imports: [DaemonModule, HostsModule, RunnerModule],
    providers: [HostDaemonAccess],
    exports: [HostDaemonAccess]
})
export class HostDaemonAccessModule {}
