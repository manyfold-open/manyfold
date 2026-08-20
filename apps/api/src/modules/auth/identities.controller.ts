import type {
    AuthIdentitySummary,
    BindNetmindIdentityBody
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
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
import { AuthService } from './auth.service'
import {
    NetmindTokenVerifierService,
    netmindHttpError
} from './netmind-token-verifier.service'
import { OauthFlowService } from './oauth-flow.service'

@Controller('me/identities')
@UseGuards(AuthGuard)
export class IdentitiesController {
    constructor(
        private readonly auth: AuthService,
        private readonly netmind: NetmindTokenVerifierService,
        private readonly oauthFlow: OauthFlowService
    ) {}

    @Get()
    @RequireAuthSession()
    list(@CurrentUser() user: AuthPrincipal): Promise<AuthIdentitySummary[]> {
        return this.auth.listIdentities(user.userId)
    }

    // Signed-in Google binding: returns the consent URL; the callback links
    // the identity to this user (link mode) instead of minting a session, then
    // redirects back to /settings/account with the outcome in the query.
    @Post('google/start')
    @RequireAuthSession()
    async googleLinkStart(
        @CurrentUser() user: AuthPrincipal
    ): Promise<{ url: string }> {
        const { authorizeUrl } = await this.oauthFlow.start({
            provider: 'google',
            redirectAfter: null,
            linkUserId: user.userId,
            linkSessionAt:
                user.kind === 'human-session'
                    ? (user.sessionCreatedAt ?? null)
                    : null
        })
        return { url: authorizeUrl }
    }

    @Post('netmind')
    @RequireAuthSession()
    async bindNetmind(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: BindNetmindIdentityBody
    ): Promise<AuthIdentitySummary[]> {
        const loginToken = body?.loginToken?.trim()
        if (!loginToken)
            throw new BadRequestException({
                code: 'auth.netmind_token_required',
                message: 'loginToken is required'
            })

        const identity = await this.netmind
            .verify(loginToken)
            .catch(netmindHttpError)
        // A Manyfold account binds at most one NetMind account (identity/login
        // is 1:1). Re-binding the same account is idempotent; a different one
        // must disconnect first. (Using the same NetMind account for model API
        // on several accounts goes through the separate model-provider connect,
        // which does not bind an identity.)
        const current = await this.auth.listIdentities(user.userId)
        const boundNetmind = current.find((i) => i.provider === 'netmind')
        if (boundNetmind && boundNetmind.subject !== identity.subject)
            throw new ConflictException({
                code: 'auth.netmind_already_bound',
                message:
                    'This account is already linked to a NetMind account; disconnect it first.'
            })
        // Link ONLY the netmind identity — never a derived email identity, which
        // would silently grant email login for the NetMind address.
        const result = await this.auth.linkIdentities(
            user.userId,
            [
                {
                    provider: 'netmind',
                    subject: identity.subject,
                    email: identity.email
                }
            ],
            identity.email
        )
        if (result.conflicts > 0)
            throw new ConflictException({
                code: 'auth.identity_in_use',
                message:
                    'this NetMind account is already linked to a different user'
            })
        void this.auth.notifyNetmindLogin({
            userId: user.userId,
            loginToken,
            identity: { subject: identity.subject, email: identity.email },
            trigger: 'bind'
        })
        return this.auth.listIdentities(user.userId)
    }

    @Delete(':provider/:subject')
    @HttpCode(204)
    @RequireAuthSession()
    async unlink(
        @CurrentUser() user: AuthPrincipal,
        @Param('provider') provider: string,
        @Param('subject') subject: string
    ): Promise<void> {
        await this.auth.unlinkIdentity(user.userId, provider, subject)
    }
}
