import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { RuntimeAuthModule } from '@/modules/agent-runtimes/auth/runtime-auth.module'
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
import { PodRunnerProvisioner } from '@/modules/agent-runtimes/provisioning/pod-runner-provisioner'
import { RuntimeAgentAttachService } from '@/modules/agents/orchestration/runtime-agent-attach.service'
import { DaemonAgentAttacher } from '@/modules/agents/adapters/daemon-agent-attacher'
import { HostDaemonAccessModule } from '@/modules/agents/adapters/host-daemon-access.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { ClaudeCodeAgentAdapter } from '@/modules/agents/adapters/claude-code-agent.adapter'
import { CodexAgentAdapter } from '@/modules/agents/adapters/codex-agent.adapter'
import { GeminiCliAgentAdapter } from '@/modules/agents/adapters/gemini-cli-agent.adapter'
import { PiAgentAdapter } from '@/modules/agents/adapters/pi-agent.adapter'
import { AntigravityCliAgentAdapter } from '@/modules/agents/adapters/antigravity-cli-agent.adapter'
import { OpenclawAgentAdapter } from '@/modules/agents/adapters/openclaw-agent.adapter'
import { HermesAgentAdapter } from '@/modules/agents/adapters/hermes-agent.adapter'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { FrameworkExecResolver } from '@/modules/agents/adapters/framework-exec'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { AgentReconcileSweepService } from '@/modules/agents/reconcile/agent-reconcile-sweep.service'
import { AgentDiagnosticsService } from '@/modules/agents/agent-diagnostics.service'
import { ResourceEventsModule } from '@/modules/resource-events/resource-events.module'
import { HostPowerSyncService } from '@/modules/agents/sprite-status/host-power-sync.service'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { SpriteStatusController } from '@/modules/agents/sprite-status/sprite-status.controller'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import { AgentCredentialsService } from '@/modules/agents/credentials/agent-credentials.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { ModelProvidersModule } from '@/modules/model-providers/model-providers.module'
import { ConnectionsModule } from '@/modules/connections/connections.module'
import { AgentSelfModule } from '@/modules/agent-self/agent-self.module'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { DaemonConfigReconciler } from './daemon-config-reconciler.service'
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
import { HostStorageModule } from '@/modules/agents/host-storage/host-storage.module'
import { SandboxActiveDurationModule } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.module'
import { BackupsModule } from '@/modules/backups/backups.module'
import { K8sModule } from '@/modules/k8s/k8s.module'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { HostBringUpModule } from '@/modules/hosts/bring-up/host-bring-up.module'
import { HostSessionRegistry } from '@/modules/agents/host-sessions/host-sessions.registry'
import {
    A2aAgentAdapter,
    DifyAgentAdapter,
    LangflowAgentAdapter
} from '@/modules/agents/adapters/external-api-agent.adapter'

@Module({
    imports: [
        HostDaemonAccessModule,
        ResourceEventsModule,
        AuthModule,
        HostBringUpModule,
        HostsModule,
        AgentRuntimesModule,
        RuntimeAuthModule,
        ModelProvidersModule,
        FrameworkCatalogModule,
        FrameworkVersionsModule,
        SkillsModule,
        RuntimeAccessModule,
        AdminSettingsModule,
        UsersModule,
        HostStorageModule,
        SandboxActiveDurationModule,
        BackupsModule,
        K8sModule,
        DaemonModule,
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
        PodRunnerProvisioner,
        RuntimeAgentAttachService,
        DaemonAgentAttacher,
        ClaudeCodeAgentAdapter,
        CodexAgentAdapter,
        GeminiCliAgentAdapter,
        PiAgentAdapter,
        AntigravityCliAgentAdapter,
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
        HostPowerSyncService,
        ServiceLeaseService,
        HostSessionRegistry,
        FrameworkVersionProbeService,
        McpImportService,
        FrameworkUpgradeService,
        AgentServiceRestartService,
        AgentContextDocManageService,
        DaemonConfigReconciler
    ],
    exports: [
        HostDaemonAccessModule,
        AgentsService,
        AgentAdapterRegistry,
        AgentModelConfigService,
        AgentReconcileService,
        K8sContainerProvisioner,
        PodRunnerProvisioner,
        RuntimeAgentAttachService,
        ResourceEventsModule,
        HostPowerSyncService,
        HostSessionRegistry
    ]
})
export class AgentsModule {}
