import { ConfigModule } from '@nestjs/config'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { ScheduleModule } from '@nestjs/schedule'
import { DbModule } from '@/db/module'
import { RequestContextInterceptor } from '@/common/telemetry/request-context.interceptor'
import { TelemetryModule } from '@/common/telemetry/telemetry.module'
import { HealthModule } from '@/modules/health/health.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AdminSandboxQuotasModule } from '@/modules/admin-sandbox-quotas/admin-sandbox-quotas.module'
import { UsersModule } from '@/modules/users/users.module'
import { SelfHostPlanBackfillModule } from '@/modules/self-host-plan-backfill/self-host-plan-backfill.module'
import { UserDeletionModule } from '@/modules/user-deletion/user-deletion.module'
import { UserExportModule } from '@/modules/user-export/user-export.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { SandboxesModule } from '@/modules/sandboxes/sandboxes.module'
import { ChatModule } from '@/modules/chat/chat.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { K8sModule } from '@/modules/k8s/k8s.module'
import { ClustersModule } from '@/modules/clusters/clusters.module'
import { TerminalModule } from '@/modules/terminal/terminal.module'
import { FilesModule } from '@/modules/agents/files/files.module'
import { UsageModule } from '@/modules/usage/usage.module'
import { ModelProvidersModule } from '@/modules/model-providers/model-providers.module'
import { ConnectionsModule } from '@/modules/connections/connections.module'
import { UserExternalAgentProvidersModule } from '@/modules/user-external-agent-providers/user-external-agent-providers.module'
import { SkillsModule } from '@/modules/skills/skills.module'
import { AutomationsModule } from '@/modules/automations/automations.module'
import { NarraNexusSyncModule } from '@/modules/narranexus-sync/narranexus-sync.module'
import { AppEventsModule } from '@/common/events/app-events.module'
import { CapabilitiesModule } from '@/common/capabilities/capabilities.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { BackupsModule } from '@/modules/backups/backups.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { RuntimeReportsModule } from '@/modules/runtime-reports/runtime-reports.module'
import { ChannelsModule } from '@/modules/channels/channels.module'
import { ChatRetentionModule } from '@/modules/chat-retention/chat-retention.module'
import { FrameworkCatalogModule } from '@/modules/framework-catalog/framework-catalog.module'
import { FrameworkVersionsModule } from '@/modules/framework-versions/framework-versions.module'
import { OpenAiCompatModule } from '@/modules/openai-compat/openai-compat.module'
import { A2aModule } from '@/modules/a2a/a2a.module'
import { ConnectA2aModule } from '@/modules/connect-a2a/connect-a2a.module'
import { AppConfigModule } from '@/modules/config/config.module'
import { CatalogCategoriesModule } from '@/modules/catalog-categories/catalog-categories.module'
import { McpCatalogModule } from '@/modules/mcp-catalog/mcp-catalog.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'

// Shared between composition roots: this list is core-only, so it never needs
// an editions-boundary exemption. Each root adds the commercial modules and a
// ports binding itself — today both AppModule and CloudAppModule add all of
// them (expand phase); after the deploy switch, AppModule drops them and binds
// DefaultPortsModule instead (contract phase).
export const CORE_MODULES = [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ScheduleModule.forRoot(),
    TelemetryModule,
    AppEventsModule,
    CapabilitiesModule,
    DbModule,
    SecretsModule,
    K8sModule,
    HealthModule,
    AuthModule,
    AdminSettingsModule,
    AdminSandboxQuotasModule,
    UsersModule,
    SelfHostPlanBackfillModule,
    UserDeletionModule,
    UserExportModule,
    SpritesAccountsModule,
    ClustersModule,
    AgentsModule,
    AgentRuntimesModule,
    SandboxesModule,
    ChatModule,
    TerminalModule,
    FilesModule,
    UsageModule,
    ModelProvidersModule,
    ConnectionsModule,
    UserExternalAgentProvidersModule,
    RuntimeAccessModule,
    SkillsModule,
    AutomationsModule,
    NarraNexusSyncModule,
    BackupsModule,
    DaemonModule,
    RuntimeReportsModule,
    ChannelsModule,
    ChatRetentionModule,
    FrameworkCatalogModule,
    FrameworkVersionsModule,
    OpenAiCompatModule,
    A2aModule,
    ConnectA2aModule,
    AppConfigModule,
    CatalogCategoriesModule,
    McpCatalogModule,
    NotificationsModule
]

export const CORE_PROVIDERS = [
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor }
]
