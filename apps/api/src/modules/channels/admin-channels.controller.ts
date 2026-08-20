import type {
    ChannelDetail,
    ChannelSummary,
    ChannelTestResult
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Patch,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { ChannelsService } from './channels.service'
import { ChannelManagerService } from './channel-manager.service'
import { UpdateChannelDto } from './dto/channels.dto'

@Controller('admin/channels')
@UseGuards(AuthGuard, AdminGuard)
export class AdminChannelsController {
    constructor(
        private readonly channels: ChannelsService,
        private readonly manager: ChannelManagerService
    ) {}

    @Get()
    list(): Promise<ChannelSummary[]> {
        this.assertEnabled()
        return this.channels.listAll()
    }

    @Get(':id')
    get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelDetail> {
        this.assertEnabled()
        return this.channels.get(user.userId, id, true)
    }

    @Patch(':id')
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateChannelDto
    ): Promise<ChannelDetail> {
        this.assertEnabled()
        return this.channels.update(user.userId, id, dto, true)
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        this.assertEnabled()
        await this.channels.delete(user.userId, id, true)
    }

    @Post(':id/test')
    @HttpCode(200)
    test(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelTestResult> {
        this.assertEnabled()
        return this.channels.test(user.userId, id, true)
    }

    @Post(':id/register')
    @HttpCode(200)
    register(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelTestResult> {
        this.assertEnabled()
        return this.channels.register(user.userId, id, true)
    }

    private assertEnabled(): void {
        if (!this.manager.isEnabled())
            throw new NotFoundException('channels feature is disabled')
    }
}
