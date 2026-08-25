import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { ChatModule } from '@/modules/chat/chat.module'
import { SecretsModule } from '@/modules/secrets/secrets.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { AgentsModule } from '@/modules/agents/agents.module'
import { UsageModule } from '@/modules/usage/usage.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CliAuthRateLimitService } from '@/modules/auth/cli-auth-rate-limit.service'
import { ChannelsController } from './channels.controller'
import { AdminChannelsController } from './admin-channels.controller'
import { AgentSelfChannelsController } from './agent-self-channels.controller'
import { ChannelWebhooksController } from './channel-webhooks.controller'
import { GithubManifestCallbackController } from './github-manifest.controller'
import { ChannelSendRateLimitService } from './channel-send-rate-limit.service'
import { ChannelsService } from './channels.service'
import { LarkRegistrationService } from './lark-registration.service'
import { WeixinRegistrationService } from './weixin-registration.service'
import { WhatsappRegistrationService } from './whatsapp-registration.service'
import { ChannelsRepository } from './channels.repository'
import { ChannelBridgeService } from './channel-bridge.service'
import { ChannelManagerService } from './channel-manager.service'
import { ChannelSessionRouter } from './channel-session-router.service'
import { ChannelSlashDispatcher } from './slash/slash-dispatcher.service'
import { ChannelProviderRegistry } from './channel-provider-registry.service'
import { FakeChannelProvider } from './providers/fake.provider'
import { LarkChannelProvider } from './providers/lark.provider'
import { TelegramChannelProvider } from './providers/telegram.provider'
import { SlackChannelProvider } from './providers/slack.provider'
import { DiscordChannelProvider } from './providers/discord.provider'
import { MatrixChannelProvider } from './providers/matrix.provider'
import { WeixinChannelProvider } from './providers/weixin.provider'
import { WhatsappChannelProvider } from './providers/whatsapp.provider'
import { LinearChannelProvider } from './providers/linear.provider'
import { GithubChannelProvider } from './providers/github.provider'
import { LineChannelProvider } from './providers/line.provider'

@Module({
    imports: [
        AuthModule,
        ChatModule,
        SecretsModule,
        RuntimeAccessModule,
        AgentsModule,
        UsageModule
    ],
    controllers: [
        ChannelsController,
        AdminChannelsController,
        AgentSelfChannelsController,
        ChannelWebhooksController,
        GithubManifestCallbackController
    ],
    providers: [
        AdminGuard,
        ChannelsRepository,
        ChannelsService,
        LarkRegistrationService,
        WeixinRegistrationService,
        WhatsappRegistrationService,
        CliAuthRateLimitService,
        ChannelBridgeService,
        ChannelSendRateLimitService,
        ChannelManagerService,
        ChannelSessionRouter,
        ChannelSlashDispatcher,
        ChannelProviderRegistry,
        FakeChannelProvider,
        LarkChannelProvider,
        TelegramChannelProvider,
        SlackChannelProvider,
        DiscordChannelProvider,
        MatrixChannelProvider,
        WeixinChannelProvider,
        WhatsappChannelProvider,
        LinearChannelProvider,
        GithubChannelProvider,
        LineChannelProvider
    ],
    exports: [
        ChannelsService,
        ChannelManagerService,
        ChannelBridgeService,
        ChannelsRepository,
        FakeChannelProvider
    ]
})
export class ChannelsModule {}
