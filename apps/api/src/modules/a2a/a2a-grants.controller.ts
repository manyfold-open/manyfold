import type {
    A2aGrantBatchResponse,
    A2aGrantMintResponse,
    A2aGrantSummary,
    A2aOutboundGrantSummary,
    MintA2aGrantBody,
    MintA2aGrantsBody
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { ApiTokenService } from '@/modules/auth/api-token.service'

// Bespoke A2A grant API — NOT the user-grant POST agents/:id/grants path, whose
// one-active-grant-per-agent rule would collide with per-caller A2A grants.
// Session-only (no API tokens), like GrantsController.
@Controller('a2a')
@UseGuards(AuthGuard)
export class A2aGrantsController {
    constructor(private readonly tokens: ApiTokenService) {}

    @Get('agents/:agentId/grants')
    @RequireAuthSession()
    async list(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string
    ): Promise<A2aGrantSummary[]> {
        return this.tokens.listA2aGrants(user.userId, agentId)
    }

    // Outbound view: the targets this agent (as caller) may delegate to.
    @Get('agents/:agentId/outbound-grants')
    @RequireAuthSession()
    async listOutbound(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string
    ): Promise<A2aOutboundGrantSummary[]> {
        return this.tokens.listA2aGrantsForCaller(user.userId, agentId)
    }

    @Post('agents/:agentId/grants')
    @HttpCode(201)
    @RequireAuthSession()
    async mint(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: MintA2aGrantBody
    ): Promise<A2aGrantMintResponse> {
        const callerAgentId = body?.callerAgentId?.trim() || null
        const minted = await this.tokens.mintA2aGrant({
            userId: user.userId,
            targetAgentId: agentId,
            callerAgentId,
            name: body?.name?.trim() || undefined,
            expiresInDays: body?.expiresInDays,
            replaceExisting: body?.replaceExisting ?? false
        })
        return {
            token: minted.plaintext,
            tokenId: minted.tokenId,
            scopes: minted.scopes,
            callerAgentId,
            expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null
        }
    }

    // Multi-select: authorize several callers for this target in one request.
    @Post('agents/:agentId/grants/batch')
    @HttpCode(201)
    @RequireAuthSession()
    async mintBatch(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: MintA2aGrantsBody
    ): Promise<A2aGrantBatchResponse> {
        const minted = await this.tokens.mintA2aGrants({
            userId: user.userId,
            targetAgentId: agentId,
            callerAgentIds: body?.callerAgentIds ?? [],
            expiresInDays: body?.expiresInDays,
            replaceExisting: body?.replaceExisting ?? false
        })
        return {
            grants: minted.map((m) => ({
                callerAgentId: m.callerAgentId,
                tokenId: m.tokenId,
                expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null
            }))
        }
    }

    @Delete('agents/:agentId/grants/:tokenId')
    @HttpCode(204)
    @RequireAuthSession()
    async revoke(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('tokenId') tokenId: string
    ): Promise<void> {
        await this.tokens.revokeA2aGrant({
            tokenId,
            userId: user.userId,
            targetAgentId: agentId
        })
    }
}
