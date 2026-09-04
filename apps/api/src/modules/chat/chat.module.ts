import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { UsageModule } from '@/modules/usage/usage.module'
import { FilesModule } from '@/modules/agents/files/files.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { ChatController } from '@/modules/chat/chat.controller'
import { ChatService } from '@/modules/chat/chat.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { AdminChatSessionsController } from '@/modules/chat/admin-chat-sessions.controller'
import { AdminChatSessionsService } from '@/modules/chat/admin-chat-sessions.service'
import { ChatSessionSharesController } from '@/modules/chat/chat-session-shares.controller'
import { ChatSessionSharesService } from '@/modules/chat/chat-session-shares.service'
import { SharedChatSessionsController } from '@/modules/chat/shared-chat-sessions.controller'
import { ShareRateLimitService } from '@/common/share-rate-limit.service'
import { ChatSseBroadcaster } from '@/modules/chat/sse-broadcaster'
import { ChatStreamBus } from '@/modules/chat/chat-stream-bus'
import { ChatCancelBus } from '@/modules/chat/chat-cancel-bus'
import { ChatPermissionBus } from '@/modules/chat/chat-permission-bus'
import { HermesPermissionCoordinator } from '@/modules/chat/hermes-permission-coordinator'
import { ChatAdapterRegistry } from '@/modules/chat/adapters/adapter-registry.service'
import { FakeEchoAdapter } from '@/modules/chat/adapters/fake-echo.adapter'
import { ClaudeCodeAdapter } from '@/modules/chat/adapters/claude-code.adapter'
import { OpenclawAdapter } from '@/modules/chat/adapters/openclaw.adapter'
import { CodexAdapter } from '@/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '@/modules/chat/adapters/gemini-cli.adapter'
import { HermesAdapter } from '@/modules/chat/adapters/hermes.adapter'
import { NarraNexusChatAdapter } from '@/modules/narranexus/narranexus-chat.adapter'
import {
    A2aChatAdapter,
    DifyChatAdapter,
    LangflowChatAdapter
} from '@/modules/chat/adapters/external-api.adapter'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { DaemonFencedDispatchService } from '@/modules/chat/adapters/daemon-fenced-dispatch.service'
import { ConnectionsModule } from '@/modules/connections/connections.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { ModelProvidersModule } from '@/modules/model-providers/model-providers.module'
import { RunnerManagerService } from './runner/runner-manager.service'
import { UserExternalAgentProvidersModule } from '@/modules/user-external-agent-providers/user-external-agent-providers.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { SpriteStorageModule } from '@/modules/agents/sprite-storage/sprite-storage.module'
import { SpriteExecHealthModule } from '@/modules/agents/sprite-exec-health/sprite-exec-health.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import {
    RuntimeSessionController
} from '@/modules/chat/recovery/session-recovery.controller'
import { SessionRecoveryService } from '@/modules/chat/recovery/session-recovery.service'
import { TurnAdoptionService } from '@/modules/chat/turn-adoption.service'
import {
    CandidateScanCache,
    SessionReaderRegistry
} from '@/modules/chat/recovery/readers'
import { ChatUploadsModule } from '@/modules/chat/uploads/chat-uploads.module'
import { ChatApiFileService } from '@/modules/chat/api-files/chat-api-file.service'

@Module({
    imports: [
        AuthModule,
        SecretsModule,
        SpritesAccountsModule,
        UsageModule,
        FilesModule,
        AgentsModule,
        AgentRuntimesModule,
        DaemonModule,
        ModelProvidersModule,
        UserExternalAgentProvidersModule,
        RuntimeAccessModule,
        SpriteStorageModule,
        SpriteExecHealthModule,
        AdminSettingsModule,
        ChatUploadsModule,
        ConnectionsModule
    ],
    controllers: [
        ChatController,
        AdminChatSessionsController,
        ChatSessionSharesController,
        SharedChatSessionsController,
        RuntimeSessionController
    ],
    providers: [
        ChatService,
        ChatRepository,
        AdminChatSessionsService,
        ChatSessionSharesService,
        ShareRateLimitService,
        ChatSseBroadcaster,
        ChatStreamBus,
        ChatCancelBus,
        ChatPermissionBus,
        HermesPermissionCoordinator,
        TurnAdoptionService,
        RunnerManagerService,
        ChatAdapterRegistry,
        ExecDriverFactory,
        DaemonFencedDispatchService,
        FakeEchoAdapter,
        ClaudeCodeAdapter,
        OpenclawAdapter,
        CodexAdapter,
        GeminiCliAdapter,
        HermesAdapter,
        NarraNexusChatAdapter,
        DifyChatAdapter,
        LangflowChatAdapter,
        A2aChatAdapter,
        SessionRecoveryService,
        SessionReaderRegistry,
        CandidateScanCache,
        ChatApiFileService
    ],
    exports: [
        ChatAdapterRegistry,
        ChatService,
        ChatSseBroadcaster,
        ChatApiFileService
    ]
})
export class ChatModule {}
