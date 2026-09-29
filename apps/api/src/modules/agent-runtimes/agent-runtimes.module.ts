import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { HostDaemonAccessModule } from '@/modules/agents/adapters/host-daemon-access.module'
import { K8sModule } from '@/modules/k8s/k8s.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { AgentRuntimesService } from './agent-runtimes.service'
import { AgentRuntimesController } from './agent-runtimes.controller'
import { AdminAgentRuntimesController } from './admin-agent-runtimes.controller'
import { HostedHostLifecycleService } from './hosted-host-lifecycle.service'
import { RuntimeDashboardService } from './orchestration/runtime-dashboard.service'
import { SpritesProvisioner } from './provisioning/sprites-provisioner'
import { K8sProvisioner } from './provisioning/k8s-provisioner'
import { PodRunnerProvisioner } from './provisioning/pod-runner-provisioner'
import { K8sCreateCleanupService } from './provisioning/k8s-create-cleanup.service'
import { PodHostServices } from './provisioning/pod-host-services'
import { ExternalAgentProvisioner } from './provisioning/external-provisioner'
import { UserExternalAgentProvidersModule } from '@/modules/user-external-agent-providers/user-external-agent-providers.module'
import { HermesSpriteBootstrap } from '@/modules/agents/bootstrap/hermes-sprite'
import { OpenClawSpriteBootstrap } from '@/modules/agents/bootstrap/openclaw-sprite'
import { SpriteServiceBootstraps } from '@/modules/agents/bootstrap/sprite-service-bootstraps'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AgentSelfModule } from '@/modules/agent-self/agent-self.module'
import { SkillsModule } from '@/modules/skills/skills.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { McpConfigMaterializer } from './mcp/mcp-config-materializer.service'
import { RuntimeAccountService } from './account/runtime-account.service'
import { RunnerModule } from '@/modules/chat/runner/runner.module'

@Module({
    imports: [
        RunnerModule,
        AuthModule,
        HostsModule,
        HostDaemonAccessModule,
        K8sModule,
        SecretsModule,
        SkillsModule,
        AgentSelfModule,
        RuntimeAccessModule,
        SandboxActiveDurationModule,
        UserExternalAgentProvidersModule,
        DaemonModule
    ],
    controllers: [AgentRuntimesController, AdminAgentRuntimesController],
    providers: [
        AdminGuard,
        AgentRuntimesService,
        HostedHostLifecycleService,
        RuntimeDashboardService,
        SpritesProvisioner,
        K8sProvisioner,
        K8sCreateCleanupService,
        PodHostServices,
        PodRunnerProvisioner,
        ExternalAgentProvisioner,
        HermesSpriteBootstrap,
        OpenClawSpriteBootstrap,
        SpriteServiceBootstraps,
        SpriteKeepAliveLeaseService,
        McpConfigMaterializer,
        RuntimeAccountService
    ],
    exports: [
        AgentRuntimesService,
        HostedHostLifecycleService,
        RuntimeAccountService,
        RuntimeDashboardService,
        SpritesProvisioner,
        SpriteKeepAliveLeaseService,
        K8sProvisioner,
        K8sCreateCleanupService,
        PodHostServices,
        PodRunnerProvisioner,
        ExternalAgentProvisioner,
        HermesSpriteBootstrap,
        OpenClawSpriteBootstrap,
        SpriteServiceBootstraps,
        McpConfigMaterializer
    ]
})
export class AgentRuntimesModule {}
