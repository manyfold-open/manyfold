import {
    Body,
    Controller,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import {
    UserDeletionService,
    type UserDeletionStatus
} from './user-deletion.service'

// Admin-only in v1 (ADR-0023): deletion is a support/operator action; the
// self-serve flow arrives in v2 on the same state machine.
@Controller('admin/users/:id/deletion')
@UseGuards(AuthGuard, AdminGuard)
export class UserDeletionController {
    constructor(private readonly deletions: UserDeletionService) {}

    @Post()
    @HttpCode(201)
    async request(
        @CurrentUser() actor: AuthPrincipal,
        @Param('id') userId: string,
        @Body() body: { reason?: string }
    ): Promise<UserDeletionStatus> {
        return this.deletions.request({
            userId,
            requestedBy: actor.userId,
            reason: body?.reason
        })
    }

    @Post('restore')
    async restore(
        @CurrentUser() actor: AuthPrincipal,
        @Param('id') userId: string
    ): Promise<UserDeletionStatus> {
        return this.deletions.restore({
            userId,
            requestedBy: actor.userId
        })
    }

    @Post('execute')
    async execute(
        @CurrentUser() actor: AuthPrincipal,
        @Param('id') userId: string
    ): Promise<UserDeletionStatus | null> {
        return this.deletions.executeNow({
            userId,
            requestedBy: actor.userId
        })
    }
}
