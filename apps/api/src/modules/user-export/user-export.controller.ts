import {
    Controller,
    Get,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import {
    UserExportService,
    type UserExportStatus
} from './user-export.service'

// Admin-triggered takeout (ADR-0023 §9.2): the support fallback, and the only
// export path for grace-period users — post-T0 they cannot sign in, but their
// mailbox still works, so the ready email delivers the signed link (V-7). The
// status GET exists for the same support flow: "the email never arrived" is
// answered by reading the state here, not by guessing.
@Controller('admin/users/:id/export')
@UseGuards(AuthGuard, AdminGuard)
export class UserExportController {
    constructor(private readonly exports: UserExportService) {}

    @Get()
    async status(
        @Param('id') userId: string
    ): Promise<UserExportStatus | null> {
        return this.exports.status(userId)
    }

    @Post()
    @HttpCode(201)
    async request(
        @CurrentUser() actor: AuthPrincipal,
        @Param('id') userId: string
    ): Promise<UserExportStatus> {
        const status = await this.exports.request({
            userId,
            requestedBy: actor.userId
        })
        void this.exports.sweep()
        return status
    }
}
