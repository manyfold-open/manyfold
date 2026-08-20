import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AgentsController } from '@/modules/agents/agents.controller'
import { AdminAgentsController } from '@/modules/agents/admin-agents.controller'
import {
    AdminRuntimeAgentsController,
    RuntimeAgentsController
} from '@/modules/agents/runtime-agents.controller'
import { AgentsService } from '@/modules/agents/agents.service'
import { AgentOrchestratorService } from '@/modules/agents/orchestration/agent-orchestrator.service'
import { K8sAgentOrchestrator } from '@/modules/agents/orchestration/k8s-agent-orchestrator'
import { K8sContainerProvisioner } from '@/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { RuntimeAgentAttachService } from '@/modules/agents/orchestration/runtime-agent-attach.service'
import { ClaudeCodeK8sBootstrap } from '@/modules/agents/bootstrap/claude-code-k8s'
import { CodexK8sBootstrap } from '@/modules/agents/bootstrap/codex-k8s'
import { GeminiCliK8sBootstrap } from '@/modules/agents/bootstrap/gemini-k8s'
import { OpenClawBootstrap } from '@/modules/agents/bootstrap/openclaw'
import { HermesBootstrap } from '@/modules/agents/bootstrap/hermes'
import { NarraNexusK8sBootstrap } from '@/modules/agents/bootstrap/narranexus-k8s'
import { createClient, spriteMkdir, spriteRm } from '@manyfold/sprites'
import { SpritesAgentAttacher } from '@/modules/agents/adapters/sprites-agent-attacher'
import { K8sAgentAttacher } from '@/modules/agents/adapters/k8s-agent-attacher'
import { DaemonAgentAttacher } from '@/modules/agents/adapters/daemon-agent-attacher'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { ClaudeCodeAgentAdapter } from '@/modules/agents/adapters/claude-code-agent.adapter'
import { CodexAgentAdapter } from '@/modules/agents/adapters/codex-agent.adapter'
import { GeminiCliAgentAdapter } from '@/modules/agents/adapters/gemini-cli-agent.adapter'
import { OpenclawAgentAdapter } from '@/modules/agents/adapters/openclaw-agent.adapter'
import { HermesAgentAdapter } from '@/modules/agents/adapters/hermes-agent.adapter'
import { NarraNexusModule } from '@/modules/narranexus/narranexus.module'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { FrameworkExecResolver } from '@/modules/agents/adapters/framework-exec'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { AgentReconcileSweepService } from '@/modules/agents/reconcile/agent-reconcile-sweep.service'
import { AgentDiagnosticsService } from '@/modules/agents/agent-diagnostics.service'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import { SpriteStatusBus } from '@/modules/agents/sprite-status/sprite-status-bus'
import { SpriteStatusSyncService } from '@/modules/agents/sprite-status/sprite-status-sync.service'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { SpriteStatusController } from '@/modules/agents/sprite-status/sprite-status.controller'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import { AgentCredentialsService } from '@/modules/agents/credentials/agent-credentials.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { ModelProvidersModule } from '@/modules/model-providers/model-providers.module'
import { ConnectionsModule } from '@/modules/connections/connections.module'
import { AgentSelfModule } from '@/modules/agent-self/agent-self.module'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { FrameworkCatalogModule } from '@/modules/framework-catalog/framework-catalog.module'
import { FrameworkVersionsModule } from '@/modules/framework-versions/framework-versions.module'
import { FrameworkVersionProbeService } from '@/modules/agents/framework-versions/framework-version-probe.service'
import { McpImportService } from '@/modules/agents/mcp-import.service'
import { FrameworkUpgradeService } from '@/modules/agents/framework-versions/framework-upgrade.service'
import { AgentServiceRestartService } from '@/modules/agents/agent-service-restart.service'
import { SkillsModule } from '@/modules/skills/skills.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { UsersModule } from '@/modules/users/users.module'
import { SpriteStorageModule } from '@/modules/agents/sprite-storage/sprite-storage.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { BackupsModule } from '@/modules/backups/backups.module'
import { K8sModule } from '@/modules/k8s/k8s.module'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { SpritesSessionRegistry } from '@/modules/agents/sprite-sessions/sprite-sessions.registry'
import {
    A2aAgentAdapter,
    DifyAgentAdapter,
    LangflowAgentAdapter
} from '@/modules/agents/adapters/external-api-agent.adapter'

@Module({
    imports: [
        AuthModule,
        SpritesAccountsModule,
        AgentRuntimesModule,
        ModelProvidersModule,
        FrameworkCatalogModule,
        FrameworkVersionsModule,
        SkillsModule,
        RuntimeAccessModule,
        AdminSettingsModule,
        UsersModule,
        SpriteStorageModule,
        SandboxActiveDurationModule,
        BackupsModule,
        K8sModule,
        DaemonModule,
        NarraNexusModule,
        ConnectionsModule,
        AgentSelfModule
    ],
    controllers: [
        AgentsController,
        AdminAgentsController,
        RuntimeAgentsController,
        AdminRuntimeAgentsController,
        SpriteStatusController
    ],
    providers: [
        AdminGuard,
        AgentsService,
        AgentOrchestratorService,
        K8sAgentOrchestrator,
        K8sContainerProvisioner,
        RuntimeAgentAttachService,
        ClaudeCodeK8sBootstrap,
        CodexK8sBootstrap,
        GeminiCliK8sBootstrap,
        OpenClawBootstrap,
        HermesBootstrap,
        NarraNexusK8sBootstrap,
        {
            provide: SpritesAgentAttacher,
            useFactory: (accounts: SpritesAccountsService) =>
                new SpritesAgentAttacher(
                    accounts,
                    spriteMkdir,
                    spriteRm,
                    createClient
                ),
            inject: [SpritesAccountsService]
        },
        K8sAgentAttacher,
        DaemonAgentAttacher,
        ClaudeCodeAgentAdapter,
        CodexAgentAdapter,
        GeminiCliAgentAdapter,
        OpenclawAgentAdapter,
        HermesAgentAdapter,
        DifyAgentAdapter,
        LangflowAgentAdapter,
        A2aAgentAdapter,
        AgentAdapterRegistry,
        FrameworkExecResolver,
        AgentReconcileService,
        AgentReconcileSweepService,
        AgentDiagnosticsService,
        CredentialsResolverService,
        AgentCredentialsService,
        ExecDriverFactory,
        AgentModelConfigService,
        SpriteStatusBus,
        SpriteStatusBroadcaster,
        SpriteStatusSyncService,
        ServiceLeaseService,
        SpritesSessionRegistry,
        FrameworkVersionProbeService,
        McpImportService,
        FrameworkUpgradeService,
        AgentServiceRestartService,
        AgentContextDocManageService
    ],
    exports: [
        AgentsService,
        AgentAdapterRegistry,
        AgentModelConfigService,
        AgentReconcileService,
        K8sContainerProvisioner,
        RuntimeAgentAttachService,
        SpriteStatusBroadcaster,
        SpriteStatusSyncService,
        SpritesSessionRegistry
    ]
})
export class AgentsModule {}
