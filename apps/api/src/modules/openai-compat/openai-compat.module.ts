import { Module } from '@nestjs/common'
import { ApiQuotaModule } from '@/common/api-quota/api-quota.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { ChatModule } from '@/modules/chat/chat.module'
import { OpenAiChatCompletionsController } from './openai-chat-completions.controller'
import { OpenAiChatCompletionsService } from './openai-chat-completions.service'
import { OpenAiConversationsController } from './openai-conversations.controller'
import { OpenAiConversationsService } from './openai-conversations.service'

@Module({
    imports: [ApiQuotaModule, AuthModule, ChatModule],
    controllers: [
        OpenAiChatCompletionsController,
        OpenAiConversationsController
    ],
    providers: [OpenAiChatCompletionsService, OpenAiConversationsService],
    exports: [OpenAiChatCompletionsService]
})
export class OpenAiCompatModule {}
