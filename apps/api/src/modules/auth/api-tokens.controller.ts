import type {
    ApiTokenSummary,
    CreateApiTokenBody,
    CreateApiTokenResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Query,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import {
    ApiTokenService,
    apiTokenSummaryFromRow,
    normalizeApiTokenScopes,
    normalizeExpiresInDays
} from './api-token.service'

@Controller('me/api-tokens')
@UseGuards(AuthGuard)
export class ApiTokensController {
    constructor(private readonly tokens: ApiTokenService) {}

    @Get()
    list(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string,
        @Query('includeGrants') includeGrants?: string
    ): Promise<ApiTokenSummary[]> {
        const agentFilter = agentId?.trim() || undefined
        const opts: { agentId?: string; includeGrants?: boolean } = {}
        if (agentFilter) opts.agentId = agentFilter
        else if (includeGrants === 'true' || includeGrants === '1')
            opts.includeGrants = true
        return this.tokens.listForUser(user.userId, opts)
    }

    @Post()
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: CreateApiTokenBody
    ): Promise<CreateApiTokenResponse> {
        const name = body.name?.trim()
        if (!name) throw new BadRequestException('name is required')
        const scopes = normalizeApiTokenScopes(body.scopes)
        const expiresInDays = normalizeExpiresInDays(body.expiresInDays)
        const minted = await this.tokens.mint({
            userId: user.userId,
            name,
            scopes,
            expiresInDays
        })

        return {
            token: minted.plaintext,
            summary: apiTokenSummaryFromRow({
                id: minted.tokenId,
                name,
                scopes: minted.scopes,
                lastUsedAt: null,
                expiresAt: minted.expiresAt,
                revokedAt: null,
                createdAt: new Date()
            })
        }
    }

    @Delete(':id')
    @HttpCode(204)
    async revoke(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.tokens.revoke({ tokenId: id, userId: user.userId })
    }
}
