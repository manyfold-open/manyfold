import type {
    SdkNotificationWebhookSummary,
    SendTestNotificationResult
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { NotificationsService } from './notifications.service'
import {
    CreateNotificationWebhookDto,
    UpdateNotificationWebhookDto
} from './dto/notification-webhook.dto'

@Controller('admin/notification-webhooks')
@UseGuards(AuthGuard, AdminGuard)
export class AdminNotificationWebhooksController {
    constructor(private readonly service: NotificationsService) {}

    @Get()
    list(): Promise<SdkNotificationWebhookSummary[]> {
        return this.service.list()
    }

    @Get(':id')
    get(@Param('id') id: string): Promise<SdkNotificationWebhookSummary> {
        return this.service.getSummary(id)
    }

    @Post()
    @HttpCode(201)
    create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateNotificationWebhookDto
    ): Promise<SdkNotificationWebhookSummary> {
        return this.service.create(user.userId, dto)
    }

    @Patch(':id')
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateNotificationWebhookDto
    ): Promise<SdkNotificationWebhookSummary> {
        return this.service.update(user.userId, id, dto)
    }

    @Delete(':id')
    @HttpCode(204)
    remove(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        return this.service.remove(user.userId, id)
    }

    @Post(':id/test')
    test(@Param('id') id: string): Promise<SendTestNotificationResult> {
        return this.service.testDelivery(id)
    }
}