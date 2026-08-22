import { Module } from '@nestjs/common'
import { EmailModule } from '@/modules/email/email.module'
import { UserDeletionService } from './user-deletion.service'
import { UserDeletionController } from './user-deletion.controller'

@Module({
    imports: [EmailModule],
    providers: [UserDeletionService],
    controllers: [UserDeletionController],
    exports: [UserDeletionService]
})
export class UserDeletionModule {}
