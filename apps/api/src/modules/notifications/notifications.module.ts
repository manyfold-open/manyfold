import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { NotificationsService } from './notifications.service'
import { AdminNotificationWebhooksController } from './notifications.controller'

@Module({
    imports: [AuthModule],
    controllers: [AdminNotificationWebhooksController],
    providers: [AdminGuard, NotificationsService],
    exports: [NotificationsService]
})
export class NotificationsModule {}