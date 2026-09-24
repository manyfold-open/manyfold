import {
    NARRANEXUS_SPRITE_BASE_WORKING_PATH,
    SPRITE_HOME_BASE,
    narraNexusFrameworkDefinition,
    registerFramework
} from '@manyfold/shared'
import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { AutomationsModule } from '@/modules/automations/automations.module'
import { ChannelsModule } from '@/modules/channels/channels.module'
import { ChatModule } from '@/modules/chat/chat.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { DaemonRateLimitService } from '@/modules/daemon/daemon-rate-limit.service'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { UsageModule } from '@/modules/usage/usage.module'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import { NarraNexusAgentAdapter } from './agent/narranexus-agent.adapter'
import { NarraNexusChatAdapter } from './chat/narranexus-chat.adapter'
import { NarraNexusSpriteBootstrap } from './bootstrap/narranexus-sprite'
import {
    NarraNexusK8sBootstrap,
    NARRANEXUS_PORT
} from './bootstrap/narranexus-k8s'
import { NarraNexusFilesProvider } from './files/narranexus-files.provider'
import { narraNexusControlUi } from './dashboard/narranexus-deep-link'
import { narraNexusChannels } from './channels/narranexus-channels'
import { narraNexusVersion } from './version/narranexus-version'
import { narraNexusSeedWorkspacePath } from './narranexus-paths'
import { NarraNexusSyncController } from './sync/narranexus-sync.controller'
import { NarraNexusSyncAdminController } from './sync/narranexus-sync-admin.controller'
import { NarraNexusSyncService } from './sync/narranexus-sync.service'

const NARRANEXUS_HOME = `${SPRITE_HOME_BASE}/.narranexus`

// At module load, ahead of every request: the definition has to be in the
// registry before anything lists it (ADR-0034).
registerFramework(narraNexusFrameworkDefinition)

// Everything NarraNexus-specific the API runs, registered into the core's
// framework seams (ADR-0034). A leaf: no core module imports this one.
@Module({
    imports: [
        AuthModule,
        SecretsModule,
        UsageModule,
        DaemonModule,
        AdminSettingsModule,
        AgentsModule,
        AgentRuntimesModule,
        ChatModule,
        AutomationsModule,
        ChannelsModule
    ],
    controllers: [NarraNexusSyncController, NarraNexusSyncAdminController],
    providers: [
        NarraNexusAgentAdapter,
        NarraNexusChatAdapter,
        NarraNexusSpriteBootstrap,
        NarraNexusK8sBootstrap,
        NarraNexusFilesProvider,
        NarraNexusSyncService,
        // A generic fixed-window limiter: a local instance for the sync
        // webhooks.
        DaemonRateLimitService
    ]
})
export class NarraNexusModule {
    constructor(
        registry: FrameworkExtensionsRegistry,
        agentAdapter: NarraNexusAgentAdapter,
        chatAdapter: NarraNexusChatAdapter,
        spriteBootstrap: NarraNexusSpriteBootstrap,
        k8sBootstrap: NarraNexusK8sBootstrap,
        files: NarraNexusFilesProvider
    ) {
        registry.register({
            framework: 'narranexus',
            agentAdapter,
            chatAdapter,
            // The container starts with an empty agents table.
            pushPrimaryAgent: true,
            spriteService: {
                bootstrap: spriteBootstrap,
                mountPath: NARRANEXUS_SPRITE_BASE_WORKING_PATH,
                // A seed only: the NarraNexus agent does not exist yet, so its
                // gateway cannot be asked where the workspace will be.
                workspaceSeed: (agentId, userId) =>
                    narraNexusSeedWorkspacePath('sprites', agentId, userId),
                supervision: {
                    homeDir: NARRANEXUS_HOME,
                    healthUrl: `http://127.0.0.1:${NARRANEXUS_PORT}/healthz`,
                    fallbackExec: (homeDir) => ['bash', `${homeDir}/app/run.sh`]
                }
            },
            k8sBootstrap,
            version: narraNexusVersion(),
            files,
            controlUi: narraNexusControlUi,
            channels: narraNexusChannels
        })
    }
}
