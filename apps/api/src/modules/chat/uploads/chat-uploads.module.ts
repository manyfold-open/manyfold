import { Module } from '@nestjs/common'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { ChatUploadStorageService } from '@/modules/chat/uploads/chat-upload-storage.service'
import { ChatUploadsController } from '@/modules/chat/uploads/chat-uploads.controller'

@Module({
    imports: [AgentsModule, AuthModule],
    controllers: [ChatUploadsController],
    providers: [ChatUploadStorageService],
    exports: [ChatUploadStorageService]
})
export class ChatUploadsModule {}
