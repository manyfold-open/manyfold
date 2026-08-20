import type {
    AddAgentGrantBody,
    AgentGrantMintResponse,
    TokenCreatedVia
} from '@manyfold/shared'
import {
    Body,
    Controller,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import {
    ApiTokenService,
    normalizeGrantableScopes
} from './api-token.service'

@Controller()
@UseGuards(AuthGuard)
export class GrantsController {
    constructor(private readonly tokens: ApiTokenService) {}

    @Post('agents/:id/grants')
    @HttpCode(201)
    @RequireAuthSession()
    async addPermission(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: AddAgentGrantBody
    ): Promise<AgentGrantMintResponse> {
        const scopes = normalizeGrantableScopes(body?.approvedScopes)
        const enforceAgentBinding = body?.enforceAgentBinding ?? true
        const name = body?.name?.trim() || undefined
        const minted = await this.tokens.mintGrant({
            userId: user.userId,
            agentId,
            scopes,
            name,
            createdVia: 'user-grant',
            enforceAgentBinding,
            replaceExisting: false
        })
        return mintToResponse(minted, 'user-grant')
    }
}

const mintToResponse = (
    minted: Awaited<ReturnType<ApiTokenService['mintGrant']>>,
    expectedCreatedVia: TokenCreatedVia
): AgentGrantMintResponse => {
    if (!minted.agentId)
        throw new Error('mintGrant returned a token without agentId')
    return {
        token: minted.plaintext,
        tokenId: minted.tokenId,
        agentId: minted.agentId,
        scopes: minted.scopes.filter(
            (s): s is import('@manyfold/shared').GrantableScope =>
                s !== 'api.full' && s !== 'chat.completions'
        ),
        expiresAt: minted.expiresAt?.toISOString() ?? null,
        enforceAgentBinding: minted.enforceAgentBinding,
        createdVia: minted.createdVia ?? expectedCreatedVia
    }
}
