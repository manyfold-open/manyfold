import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { RunnerModule } from '@/modules/chat/runner/runner.module'
import { FrameworkVersionsModule } from '@/modules/framework-versions/framework-versions.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { SandboxesController } from './sandboxes.controller'
import { AdminSandboxesController } from './admin-sandboxes.controller'
import { SandboxesService } from './sandboxes.service'
import { ActiveHoursEnforcementService } from './active-hours-enforcement.service'

@Module({
    imports: [
        AuthModule,
        AgentRuntimesModule,
        AgentsModule,
        HostsModule,
        DaemonModule,
        SandboxActiveDurationModule,
        AdminSettingsModule,
        RuntimeAccessModule,
        RunnerModule,
        FrameworkVersionsModule,
        SecretsModule
    ],
    controllers: [SandboxesController, AdminSandboxesController],
    providers: [
        SandboxesService,
        AdminGuard,
        ActiveHoursEnforcementService,
        ServiceLeaseService
    ]
})
export class SandboxesModule {}
