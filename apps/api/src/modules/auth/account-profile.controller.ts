import type {
    AccountProfileSummary,
    UpdateAccountProfileBody
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
    Patch,
    PayloadTooLargeException,
    Put,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import {
    AccountProfileService,
    AVATAR_MAX_BYTES
} from './account-profile.service'

@Controller('me')
@UseGuards(AuthGuard)
export class AccountProfileController {
    constructor(private readonly profile: AccountProfileService) {}

    @Patch('profile')
    @RequireAuthSession()
    updateProfile(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: UpdateAccountProfileBody
    ): Promise<AccountProfileSummary> {
        return this.profile.updateDisplayName(user.userId, body.displayName)
    }

    @Put('avatar')
    @RequireAuthSession()
    async setAvatar(
        @CurrentUser() user: AuthPrincipal,
        @Req() req: FastifyRequest
    ): Promise<AccountProfileSummary> {
        const file = await req.file({
            limits: { fileSize: AVATAR_MAX_BYTES }
        })
        if (!file)
            throw new BadRequestException({
                code: 'profile.avatar_required',
                message: 'an image file is required'
            })
        const bytes = await file.toBuffer().catch(() => null)
        if (!bytes || file.file.truncated)
            throw new PayloadTooLargeException({
                code: 'profile.avatar_too_large',
                message: 'the image must be at most 512KB'
            })
        return this.profile.setAvatar(user.userId, bytes)
    }

    @Delete('avatar')
    @HttpCode(204)
    @RequireAuthSession()
    async removeAvatar(@CurrentUser() user: AuthPrincipal): Promise<void> {
        await this.profile.removeAvatar(user.userId)
    }

    // Served through an authenticated fetch (the web app carries bearer
    // tokens, so a plain <img src> cannot reach this); the ETag still lets a
    // same-session refetch revalidate cheaply.
    @Get('avatar')
    @RequireAuthSession()
    async getAvatar(
        @CurrentUser() user: AuthPrincipal,
        @Req() req: FastifyRequest,
        @Res() reply: FastifyReply
    ): Promise<void> {
        const avatar = await this.profile.getAvatar(user.userId)
        if (!avatar)
            throw new NotFoundException({
                code: 'profile.avatar_not_found',
                message: 'no avatar set'
            })
        const etag = `"${avatar.updatedAt.getTime()}"`
        if (req.headers['if-none-match'] === etag) {
            await reply.status(304).send()
            return
        }
        await reply
            .header('Content-Type', avatar.contentType)
            .header('Cache-Control', 'private, max-age=0, must-revalidate')
            .header('ETag', etag)
            .send(avatar.bytes)
    }
}
