import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { K8sModule } from '@/modules/k8s/k8s.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { AgentRuntimesService } from './agent-runtimes.service'
import { AgentRuntimesController } from './agent-runtimes.controller'
import { AdminAgentRuntimesController } from './admin-agent-runtimes.controller'
import { AgentRuntimesDashboardAuthController } from './dashboard-auth.controller'
import { K8sRuntimeSidecarService } from './orchestration/k8s-runtime-sidecar.service'
import { RuntimeDashboardService } from './orchestration/runtime-dashboard.service'
import { SpritesProvisioner } from './provisioning/sprites-provisioner'
import { K8sProvisioner } from './provisioning/k8s-provisioner'
import { ExternalAgentProvisioner } from './provisioning/external-provisioner'
import { UserExternalAgentProvidersModule } from '@/modules/user-external-agent-providers/user-external-agent-providers.module'
import { ClaudeCodeBootstrap } from '@/modules/agents/bootstrap/claude-code'
import { CodexBootstrap } from '@/modules/agents/bootstrap/codex'
import { GeminiCliBootstrap } from '@/modules/agents/bootstrap/gemini'
import { HermesSpriteBootstrap } from '@/modules/agents/bootstrap/hermes-sprite'
import { OpenClawSpriteBootstrap } from '@/modules/agents/bootstrap/openclaw-sprite'
import { NarraNexusSpriteBootstrap } from '@/modules/agents/bootstrap/narranexus-sprite'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AgentSelfModule } from '@/modules/agent-self/agent-self.module'
import { SkillsModule } from '@/modules/skills/skills.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { McpConfigMaterializer } from './mcp/mcp-config-materializer.service'

@Module({
    imports: [
        AuthModule,
        SpritesAccountsModule,
        K8sModule,
        SecretsModule,
        SkillsModule,
        AgentSelfModule,
        RuntimeAccessModule,
        SandboxActiveDurationModule,
        UserExternalAgentProvidersModule,
        DaemonModule
    ],
    controllers: [
        AgentRuntimesController,
        AdminAgentRuntimesController,
        AgentRuntimesDashboardAuthController
    ],
    providers: [
        AdminGuard,
        AgentRuntimesService,
        K8sRuntimeSidecarService,
        RuntimeDashboardService,
        SpritesProvisioner,
        K8sProvisioner,
        ExternalAgentProvisioner,
        ClaudeCodeBootstrap,
        CodexBootstrap,
        GeminiCliBootstrap,
        HermesSpriteBootstrap,
        OpenClawSpriteBootstrap,
        NarraNexusSpriteBootstrap,
        SpriteKeepAliveLeaseService,
        McpConfigMaterializer
    ],
    exports: [
        AgentRuntimesService,
        K8sRuntimeSidecarService,
        RuntimeDashboardService,
        SpritesProvisioner,
        SpriteKeepAliveLeaseService,
        K8sProvisioner,
        ExternalAgentProvisioner,
        HermesSpriteBootstrap,
        OpenClawSpriteBootstrap,
        NarraNexusSpriteBootstrap,
        McpConfigMaterializer
    ]
})
export class AgentRuntimesModule {}
