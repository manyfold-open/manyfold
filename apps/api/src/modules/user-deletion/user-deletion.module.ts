import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { EmailModule } from '@/modules/email/email.module'
import { DeletionTokenService } from './deletion-token.service'
import { UserDeletionService } from './user-deletion.service'
import { UserDeletionController } from './user-deletion.controller'
import { MeDeletionController } from './me-deletion.controller'

@Module({
    imports: [AuthModule, EmailModule],
    providers: [UserDeletionService, DeletionTokenService],
    controllers: [UserDeletionController, MeDeletionController],
    exports: [UserDeletionService]
})
export class UserDeletionModule {}
